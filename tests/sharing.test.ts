// PLAN.md §8.4 P0 #11: sharing, from the reader's side.
import { afterAll, expect, it } from 'vitest';
import { connectAgent, runHook, startServer, webLogin } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('keeps prompts and replies out when sharing is off, and keeps a third user out of the pair', async () => {
  const [amishToken, samToken] = await Promise.all([server.addUser('amish'), server.addUser('sam')]);
  await server.addUser('carol');
  const backend = await server.projectDir('todo-app');
  const frontend = await server.projectDir('todo-app');
  const claude = (event: string, input: Record<string, unknown> = {}) =>
    runHook(server, amishToken, backend, event, 'claude-code', { session_id: 'claude-1', ...input });
  const codex = (event: string, input: Record<string, unknown> = {}) =>
    runHook(server, samToken, frontend, event, 'codex', { session_id: 'codex-1', ...input });
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
  const pairPath = `/pairs/${req.data.pair_id.replace('p_', '')}`;

  await claude('user-prompt-submit', { prompt: 'EARLY-PROMPT-TEXT before sharing was turned off' });
  const amishWeb = await webLogin(server, 'amish');
  expect((await amishWeb.post('/settings/sharing', { share: 'off' })).status).toBe(303);
  await claude('user-prompt-submit', { prompt: 'LATE-PROMPT-TEXT after sharing was turned off' });
  await claude('stop', { last_assistant_message: 'REPLY-TEXT from Claude' });
  await amish.call('board_update', {
    kind: 'contract',
    key: 'PUT /items/:id',
    title: 'Items',
    body: 'BOARD-BODY-TEXT',
  });
  await amish.call('send_message', { kind: 'chat', text: 'MESSAGE-TEXT for sam' });

  const hidden = ['EARLY-PROMPT-TEXT', 'LATE-PROMPT-TEXT', 'REPLY-TEXT'];
  const digest = JSON.stringify(await codex('post-tool-use', { tool_name: 'shell', tool_input: {} }));
  const checked = JSON.stringify((await sam.call('check_messages', { cursor: 0 })).data);
  const samWeb = await webLogin(server, 'sam');
  const room = await samWeb.get(pairPath);
  const live = await samWeb.get(`${pairPath}/live`);
  expect(room.status).toBe(200);
  expect(live.text).toContain('MESSAGE-TEXT for sam');
  for (const text of hidden) {
    expect(digest).not.toContain(text);
    expect(checked).not.toContain(text);
    expect(room.text).not.toContain(text);
    expect(live.text).not.toContain(text);
  }

  await samWeb.post(`${pairPath}/end`, { summary: 'SUMMARY-TEXT of the pair' });
  await samWeb.post(`${pairPath}/feedback`, { helpful: 'yes', note: 'NOTE-TEXT shown on analytics' });

  const carolWeb = await webLogin(server, 'carol');
  const pairContent = [...hidden, 'BOARD-BODY-TEXT', 'MESSAGE-TEXT', 'SUMMARY-TEXT'];
  for (const path of [
    '/analytics?window=all',
    '/analytics/projects/todo-app?window=all',
    '/api/analytics?window=all',
  ]) {
    const analytics = await carolWeb.get(path);
    expect(analytics.status, path).toBe(200);
    for (const text of pairContent) expect(analytics.text, `${path} shows ${text}`).not.toContain(text);
  }
  expect((await carolWeb.get('/analytics/projects/todo-app?window=all')).text).toContain('NOTE-TEXT');
  expect((await carolWeb.get(pairPath)).status).toBe(404);
  expect((await carolWeb.get(`${pairPath}/live`)).status).toBe(404);
  expect((await carolWeb.get(`/events?pair=${req.data.pair_id.replace('p_', '')}`)).status).toBe(404);
  expect((await carolWeb.post(`${pairPath}/messages`, { text: 'intruder' })).status).toBe(404);
});
