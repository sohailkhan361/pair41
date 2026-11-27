// PLAN.md §8.4 P0 #6: the Stop hook raises an open question once, and lets the turn end the next time.
import { afterAll, expect, it } from 'vitest';
import { connectAgent, runHook, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('raises an open partner question once at the end of a turn, then lets the turn end', async () => {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  const backend = await server.projectDir('todo-app');
  const frontend = await server.projectDir('todo-app');
  await runHook(server, amishToken, backend, 'session-start', 'claude-code', { session_id: 'claude-1' });
  await runHook(server, samToken, frontend, 'session-start', 'codex', { session_id: 'codex-1' });

  const amish = await connectAgent(server, amishToken, { project: 'todo-app', session: 'claude-1' });
  const sam = await connectAgent(server, samToken, {
    project: 'todo-app',
    agent: 'codex',
    session: 'codex-1',
  });
  const req = await amish.call('request_pair', { teammate: 'sam', feature: 'Due dates' });
  await sam.call('respond_to_pair', { pair_id: req.data.pair_id, accept: true });
  const question = await sam.call('send_message', { text: 'Is total in cents?', kind: 'question' });

  await runHook(server, amishToken, backend, 'user-prompt-submit', 'claude-code', {
    session_id: 'claude-1',
    prompt: 'write the endpoint',
  });
  const first = await runHook(server, amishToken, backend, 'stop', 'claude-code', {
    session_id: 'claude-1',
    stop_hook_active: false,
  });
  expect(first.decision).toBe('block');
  expect(first.reason).toContain(question.data.message_id);
  expect(first.reason).toContain('Is total in cents?');

  const second = await runHook(server, amishToken, backend, 'stop', 'claude-code', {
    session_id: 'claude-1',
    stop_hook_active: true,
  });
  expect(second?.decision).toBeUndefined();
  expect((await amish.call('get_message', { message_id: question.data.message_id })).data.state).toBe('open');
});
