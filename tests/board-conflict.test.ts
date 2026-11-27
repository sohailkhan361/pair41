// PLAN.md §8.4 P0 #3: board conflicts.
import { afterAll, expect, it } from 'vitest';
import { pairedAgents, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('refuses board_update with an old expected_version and returns the current text', async () => {
  const { amish, sam } = await pairedAgents(server);
  const item = { kind: 'contract', key: 'PUT /items/:id', title: 'Due dates' };

  const created = await amish.call('board_update', { ...item, body: 'version one' });
  expect(created.data.version).toBe(1);
  const updated = await sam.call('board_update', { ...item, body: 'sam changed it', expected_version: 1 });
  expect(updated.data.version).toBe(2);

  const stale = await amish.call('board_update', { ...item, body: 'stale edit', expected_version: 1 });
  expect(stale.isError).toBe(true);
  expect(stale.data.status).toBe('conflict');
  expect(stale.data.current.version).toBe(2);
  expect(stale.data.current.body).toContain('sam changed it');

  const read = await amish.call('board_read');
  expect(read.data.items[0].body).toContain('sam changed it');
});
