// PLAN.md §8.4 P0 #5: identity.
import { afterAll, expect, it } from 'vitest';
import { connectAgent, runCli, startServer, webLogin } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};

async function mcpStatus(token: string) {
  const res = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(initialize),
  });
  return res.status;
}

it('rejects a wrong password, a wrong agent token and an old agent token', async () => {
  const token = await server.addUser('amish', 'correct-horse');

  expect((await webLogin(server, 'amish', 'wrong-password')).status).toBe(401);
  expect((await webLogin(server, 'nobody', 'correct-horse')).status).toBe(401);
  const web = await webLogin(server, 'amish', 'correct-horse');
  expect(web.status).toBe(303);
  expect((await web.get('/lobby')).status).toBe(200);

  expect(await mcpStatus('p41_not-a-real-token')).toBe(401);
  expect(await mcpStatus(token)).toBe(200);
  const agent = await connectAgent(server, token, { project: 'todo-app' });
  expect((await agent.call('pair_status')).data.you.name).toBe('amish');

  const regenerated = await runCli(['admin', 'new-token', 'amish'], {
    env: { PAIR41_DATABASE_URL: server.databaseUrl, PAIR41_HOME: server.dir },
  });
  const newToken = regenerated.stdout.match(/p41_[A-Za-z0-9_-]+/)?.[0];
  expect(newToken).toBeDefined();
  expect(await mcpStatus(token)).toBe(401);
  expect(await mcpStatus(newToken!)).toBe(200);
});
