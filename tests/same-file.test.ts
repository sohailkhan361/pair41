// PLAN.md §8.4 P1, same-file warning: both people are warned when both touch the same file.
import { afterAll, expect, it } from 'vitest';
import { connectAgent, runHook, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('warns both sides when both edit the same file during a pair', async () => {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  const amishDir = await server.projectDir('todo-app');
  const samDir = await server.projectDir('todo-app');
  const claude = (event: string, input: Record<string, unknown> = {}) =>
    runHook(server, amishToken, amishDir, event, 'claude-code', { session_id: 'claude-1', ...input });
  const codex = (event: string, input: Record<string, unknown> = {}) =>
    runHook(server, samToken, samDir, event, 'codex', { session_id: 'codex-1', ...input });
  await claude('session-start');
  await codex('session-start');
  const amish = await connectAgent(server, amishToken, { project: 'todo-app', session: 'claude-1' });
  const sam = await connectAgent(server, samToken, {
    project: 'todo-app',
    agent: 'codex',
    session: 'codex-1',
  });
  const req = await amish.call('request_pair', { teammate: 'sam', feature: 'Due dates' });
  await sam.call('respond_to_pair', { pair_id: req.data.pair_id, accept: true });

  const first = await claude('post-tool-use', {
    tool_name: 'Edit',
    tool_input: { file_path: `${amishDir}/src/shared/order.ts` },
  });
  expect(JSON.stringify(first ?? {})).not.toContain('both edited');

  const second = await codex('post-tool-use', {
    tool_name: 'Write',
    tool_input: { file_path: `${samDir}/src/shared/order.ts` },
  });
  expect(second.hookSpecificOutput.additionalContext).toMatch(
    /amish and sam both edited src\/shared\/order\.ts/,
  );

  const back = await claude('post-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  expect(back.hookSpecificOutput.additionalContext).toMatch(
    /amish and sam both edited src\/shared\/order\.ts/,
  );
});
