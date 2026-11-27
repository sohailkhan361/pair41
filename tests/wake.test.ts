// PLAN.md §8.4 P1, wake: `pair41 wait` exits 2 once for a partner question or deferral (not for chat), never twice for the same
// message, is stopped by the next prompt, and gets no more wakes after 10 without a prompt from its human; with no
// pair it exits 0. The waiter is the real CLI; nothing here touches a real agent.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { BIN, cleanEnv, pairedAgents, runHook, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts `pair41 wait` as Claude Code's Stop hook would: hook JSON on stdin, from the project folder. */
function startWaiter(token: string, folder: string, session: string) {
  const child = spawn(BIN, ['wait', '--agent', 'claude-code'], {
    cwd: folder,
    env: cleanEnv(server.cliEnv(token)),
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  child.stdin.end(JSON.stringify({ session_id: session, cwd: folder, hook_event_name: 'Stop' }));
  return { child, exited, stderr: () => stderr };
}

async function stillRunning(waiter: { exited: Promise<unknown> }, ms = 1500): Promise<boolean> {
  const first = await Promise.race([
    waiter.exited.then(() => 'exited'),
    new Promise((resolve) => setTimeout(() => resolve('running'), ms)),
  ]);
  return first === 'running';
}

/** One short /api/wait call, as the waiter makes them. */
async function waitOnce(token: string, session: string): Promise<{ wake?: string; stop?: string }> {
  const res = await fetch(`${server.url}/api/wait?session=${session}&timeout=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Pair-Agent': 'claude-code',
      'X-Pair-Project': 'todo-app',
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { wake?: string; stop?: string };
}

it('wakes an idle agent once per message that needs it, and stops after 10 wakes without its human', async () => {
  const { amish, sam, amishToken } = await pairedAgents(server);
  const folder = await server.projectDir('todo-app');
  const prompt = () =>
    runHook(server, amishToken, folder, 'user-prompt-submit', 'claude-code', {
      session_id: 'amish-1',
      prompt: 'carry on',
    });

  // Chat does not wake; a question does, once, and the wake-up line never quotes the partner.
  const first = startWaiter(amishToken, folder, 'amish-1');
  try {
    await until(
      async () => (await sam.call('pair_status')).data.pair.partner.wake === 'listening',
      'the waiter to listen',
    );
    await sam.call('send_message', { kind: 'chat', text: 'Starting on the page now' });
    expect(await stillRunning(first)).toBe(true);
    const question = await sam.call('send_message', { kind: 'question', text: 'Is total in cents?' });
    expect(await first.exited).toBe(2);
    expect(first.stderr()).toMatch(/^\[Pair41\] New from your pair partner sam \(Codex\): 1 question\./);
    expect(first.stderr()).toContain('check_messages');
    expect(first.stderr()).not.toContain('cents');
    const detail = await amish.call('get_message', { message_id: question.data.message_id });
    expect(
      detail.data.attempts.some(
        (a: { route: string; result: string }) => a.route === 'wake' && a.result === 'returned',
      ),
    ).toBe(true);
  } finally {
    first.child.kill();
  }

  // The same question never wakes it again, and the human's next prompt stops the waiter.
  const second = startWaiter(amishToken, folder, 'amish-1');
  try {
    // The prompt hook stops the waiter named in its pid file, so wait until it has written it.
    const pidFile = join(server.dir, 'wait-amish-1.pid');
    await until(
      async () => (await readFile(pidFile, 'utf8').catch(() => '')) === String(second.child.pid),
      'the second waiter to start',
    );
    expect(await stillRunning(second)).toBe(true);
    await prompt();
    expect(await second.exited).not.toBe(2);
  } finally {
    second.child.kill();
  }

  // Loop guard: 10 wakes without a prompt from amish, then none until the next prompt.
  for (let i = 1; i <= 10; i++) {
    await sam.call('send_message', { kind: 'question', text: `Question ${i}?` });
    const res = await waitOnce(amishToken, 'amish-1');
    expect(res.wake).toMatch(/1 question/);
    if (i === 10) expect(res.wake).toMatch(/last/);
  }
  await sam.call('send_message', { kind: 'question', text: 'One more?' });
  expect((await waitOnce(amishToken, 'amish-1')).stop).toMatch(/prompt/);
  const seenBySam = (await sam.call('check_messages')).data.messages as { kind: string; text: string }[];
  expect(seenBySam.some((m) => m.kind === 'system' && /stops waking/.test(m.text))).toBe(true);
  await prompt();
  expect((await waitOnce(amishToken, 'amish-1')).wake).toMatch(/1 question/);

  // A deferral of its own question wakes it too: that is the partner's reply.
  const asked = await amish.call('send_message', {
    kind: 'question',
    text: 'Is the page using the v2 contract?',
  });
  await sam.call('defer', { message_id: asked.data.message_id, reason: 'waiting for sam' });
  expect((await waitOnce(amishToken, 'amish-1')).wake).toMatch(/1 deferred question/);

  // A session in no pair has nothing to wait for.
  const kimToken = await server.addUser('kim');
  await runHook(server, kimToken, folder, 'session-start', 'claude-code', { session_id: 'kim-1' });
  const lonely = startWaiter(kimToken, folder, 'kim-1');
  expect(await lonely.exited).toBe(0);
});
