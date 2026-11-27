// PLAN.md §8.4 P1, Codex wrapper: `pair41 run -- <agent>` types "check pair" into a fake CLI only when it is idle.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { BIN, ROOT, cleanEnv, connectAgent, runHook, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('types "check pair" once a message arrives, and only when the agent is idle', async () => {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  const folder = await server.projectDir('todo-app');
  await runHook(server, samToken, folder, 'session-start', 'codex', { session_id: 'codex-1' });
  const amish = await connectAgent(server, amishToken, { project: 'todo-app', session: 'claude-1' });
  const sam = await connectAgent(server, samToken, {
    project: 'todo-app',
    agent: 'codex',
    session: 'codex-1',
  });
  const req = await amish.call('request_pair', { teammate: 'sam', feature: 'Due dates' });
  await sam.call('respond_to_pair', { pair_id: req.data.pair_id, accept: true });

  const fakeLog = join(server.dir, 'fake-codex.log');
  const lines = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n') : []);
  const wrapper = spawn(BIN, ['run', '--', 'node', join(ROOT, 'tests', 'fixtures', 'fake-codex.ts')], {
    cwd: folder,
    env: cleanEnv({
      ...server.cliEnv(samToken),
      FAKE_LOG: fakeLog,
      PAIR41_WRAPPER_POLL_MS: '300',
      PAIR41_WRAPPER_QUIET_MS: '800',
    }),
  });
  let screen = '';
  wrapper.stdout.on('data', (d: Buffer) => (screen += d.toString()));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 150 && !done(); i++) await sleep(100);
  };
  try {
    await until(() => screen.includes('codex>')); // the agent is up
    wrapper.stdin.write('build the due date input\n'); // the human's prompt: the fake is busy for 2 s from now
    await until(() => lines().length === 1);
    await amish.call('send_message', { kind: 'question', text: 'Cents or decimals?' });
    await sleep(500);
    expect(lines()).toEqual(['build the due date input']); // busy: nothing typed

    await until(() => lines().length >= 2);
    expect(lines()).toEqual(['build the due date input', 'check pair']);
    await sleep(2500);
    expect(lines()).toEqual(['build the due date input', 'check pair']); // once per new message, not again
  } finally {
    wrapper.kill('SIGTERM');
  }
});
