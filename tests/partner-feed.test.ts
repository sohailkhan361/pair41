// PLAN.md §8.4 P0 #9: a prompt from one side shows up in the other side's next digest, with a secret redacted.
import { afterAll, expect, it } from 'vitest';
import { connectAgent, runHook, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it("shows Amish's prompt in Sam's next digest, with the secret redacted", async () => {
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
  await runHook(server, samToken, frontend, 'post-tool-use', 'codex', {
    session_id: 'codex-1',
    tool_name: 'shell',
    tool_input: { command: ['ls'] },
  });

  const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx';
  await runHook(server, amishToken, backend, 'user-prompt-submit', 'claude-code', {
    session_id: 'claude-1',
    prompt: `Add a due_date field to items. The staging key is ${secret} if you need it.`,
  });

  const next = await runHook(server, samToken, frontend, 'post-tool-use', 'codex', {
    session_id: 'codex-1',
    tool_name: 'shell',
    tool_input: { command: ['ls'] },
  });
  const context: string = next.hookSpecificOutput.additionalContext;
  expect(context).toContain('amish asked Claude: "Add a due_date field to items.');
  expect(context).toContain('[redacted]');
  expect(context).not.toContain(secret);
});
