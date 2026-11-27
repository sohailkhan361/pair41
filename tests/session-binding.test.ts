// PLAN.md §8.4 P0 #10: session binding.
import { afterAll, expect, it } from 'vitest';
import { connectAgent, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it("lets only the paired session read or change the pair's board, and refuses an ambiguous call", async () => {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  const project = 'todo-app';
  const paired = await connectAgent(server, amishToken, { project, session: 'claude-session-1' });
  const second = await connectAgent(server, amishToken, { project, session: 'claude-session-2' });
  const noSessionId = await connectAgent(server, amishToken, { project });
  const sam = await connectAgent(server, samToken, { project, agent: 'codex', session: 'codex-session-1' });

  await second.call('set_activity', { text: 'second window' });
  const req = await paired.call('request_pair', { teammate: 'sam', feature: 'Due dates' });
  await sam.call('respond_to_pair', { pair_id: req.data.pair_id, accept: true });
  await paired.call('board_update', { kind: 'contract', key: 'PUT /items/:id', title: 'Items', body: 'v1' });

  expect((await second.call('pair_status')).data.pair).toBeNull();
  expect((await second.call('board_read')).isError).toBe(true);
  const write = await second.call('board_update', {
    kind: 'contract',
    key: 'PUT /items/:id',
    title: 'Items',
    body: 'overwritten',
    expected_version: 1,
  });
  expect(write.isError).toBe(true);
  const board = await paired.call('board_read');
  expect(board.data.items[0]).toMatchObject({ version: 1, body: expect.stringContaining('v1') });

  const ambiguous = await noSessionId.call('board_read');
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toMatch(/two sessions are open for todo-app/);
});
