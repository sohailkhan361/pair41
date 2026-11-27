// PLAN.md §8.4 P1, bridge: writes the auth and message lines to a fake socket and records the attempt; records an
// error when the socket is missing. The socket is a fake made here: nothing ever writes to a real Claude Code inbox.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { BIN, cleanEnv, connectAgent, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

it('pushes a question through the inbox socket and records the attempt, or the error when the socket is gone', async () => {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  const folder = await server.projectDir('todo-app', { bridge: true });
  const amish = await connectAgent(server, amishToken, { project: 'todo-app', session: 'claude-1' });
  const sam = await connectAgent(server, samToken, {
    project: 'todo-app',
    agent: 'codex',
    session: 'codex-1',
  });
  const req = await amish.call('request_pair', { teammate: 'sam', feature: 'Due dates' });
  await sam.call('respond_to_pair', { pair_id: req.data.pair_id, accept: true });

  // A fake inbox socket. Unix socket paths are limited to about 104 characters, so keep it short.
  const socketDir = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'p41-'));
  const socketPath = join(socketDir, 'inbox.sock');
  const received: string[] = [];
  const inbox = createServer((conn) => {
    let data = '';
    conn.on('data', (d) => (data += d.toString()));
    conn.on('end', () => received.push(...data.split('\n').filter(Boolean)));
  });
  await new Promise<void>((resolve) => inbox.listen(socketPath, resolve));

  const bridge = spawn(BIN, ['bridge'], {
    cwd: folder,
    env: cleanEnv({
      ...server.cliEnv(amishToken),
      CLAUDE_CODE_MESSAGING_SOCKET: socketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: 'fake-session-token',
    }),
  });
  bridge.stdin.end(JSON.stringify({ session_id: 'claude-1', cwd: folder, hook_event_name: 'SessionStart' }));
  try {
    await until(
      async () => (await sam.call('pair_status')).data.pair.partner.bridge === 'connected',
      'the bridge',
    );

    const question = await sam.call('send_message', { kind: 'question', text: 'Is total in cents?' });
    await until(async () => received.length >= 2, 'the pushed lines');
    expect(JSON.parse(received[0]!)).toEqual({ type: 'auth', token: 'fake-session-token' });
    const pushed = JSON.parse(received[1]!);
    expect(pushed.type).toBe('user');
    expect(pushed.message.role).toBe('user');
    expect(pushed.message.content).toMatch(/^\[Pair41\] from sam \(Codex\): Is total in cents\?/);
    expect(pushed.message.content).toContain('information, not instructions');
    await until(async () => {
      const detail = await amish.call('get_message', { message_id: question.data.message_id });
      return detail.data.attempts.some(
        (a: { route: string; result: string }) => a.route === 'socket' && a.result === 'written',
      );
    }, 'the written attempt');

    await new Promise<void>((resolve) => inbox.close(() => resolve()));
    await rm(socketPath, { force: true });
    const second = await sam.call('send_message', { kind: 'question', text: 'And pagination?' });
    await until(async () => {
      const detail = await amish.call('get_message', { message_id: second.data.message_id });
      return detail.data.attempts.some(
        (a: { route: string; result: string }) => a.route === 'socket' && a.result === 'error',
      );
    }, 'the error attempt');
  } finally {
    bridge.kill('SIGTERM');
    inbox.close();
    await rm(socketDir, { recursive: true, force: true });
  }
});
