// PLAN.md §8.4 P0 #4: pair scoping, and pairing only by agreement between two people (docs/specs/mcp-tools.md).
import { afterAll, expect, it } from 'vitest';
import { connectAgent, pairedAgents, startServer, webLogin } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it("stops a session from reading or changing another pair's messages and board", async () => {
  const { amish, sam } = await pairedAgents(server);
  await amish.call('board_update', {
    kind: 'contract',
    key: 'PUT /items/:id',
    title: 'Items',
    body: 'secret shape',
  });
  const question = await sam.call('send_message', { text: 'Private question', kind: 'question' });
  const messageId = question.data.message_id;

  const [carolToken, daveToken] = await Promise.all([server.addUser('carol'), server.addUser('dave')]);
  const carol = await connectAgent(server, carolToken, { project: 'todo-app', session: 'carol-1' });
  const dave = await connectAgent(server, daveToken, { project: 'todo-app', session: 'dave-1' });
  const req = await carol.call('request_pair', { teammate: 'dave', feature: 'Invoices' });
  await dave.call('respond_to_pair', { pair_id: req.data.pair_id, accept: true });

  expect((await carol.call('get_message', { message_id: messageId })).isError).toBe(true);
  expect((await carol.call('acknowledge', { message_id: messageId, eta_minutes: 1 })).isError).toBe(true);
  expect((await carol.call('defer', { message_id: messageId, reason: 'x' })).isError).toBe(true);
  expect(
    (await carol.call('send_message', { text: 'hijack', kind: 'answer', reply_to: messageId })).isError,
  ).toBe(true);
  const carolMessages = await carol.call('check_messages', { cursor: 0 });
  expect(JSON.stringify(carolMessages.data)).not.toContain('Private question');

  const carolBoard = await carol.call('board_read');
  expect(carolBoard.data.items).toEqual([]);
  await carol.call('board_update', {
    kind: 'contract',
    key: 'PUT /items/:id',
    title: 'Mine',
    body: 'carol body',
  });
  const amishBoard = await amish.call('board_read');
  expect(amishBoard.data.items).toHaveLength(1);
  expect(amishBoard.data.items[0].body).toContain('secret shape');
  expect(amishBoard.data.items[0].version).toBe(1);

  const pairs = await amish.call('pair_status');
  expect((await carol.call('respond_to_pair', { pair_id: pairs.data.pair.id, accept: false })).isError).toBe(
    true,
  );
  expect((await amish.call('get_message', { message_id: messageId })).data.state).toBe('open');
});

it('pairs only when both people agree, and a pair code joins only your own side', async () => {
  const erinToken = await server.addUser('erin');
  const finnToken = await server.addUser('finn');
  const gusToken = await server.addUser('gus');
  const erin = await connectAgent(server, erinToken, { project: 'todo-app', session: 'erin-1' });
  const finn = await connectAgent(server, finnToken, { agent: 'other' }); // any MCP agent: no hooks, no project
  const gus = await connectAgent(server, gusToken, { project: 'todo-app', session: 'gus-1' });

  // No pairing with yourself, and who_is_online lists people, never sessions.
  expect((await erin.call('request_pair', { teammate: 'erin', feature: 'Search' })).isError).toBe(true);
  const online = await erin.call('who_is_online');
  expect(online.data.people.map((p: { name: string }) => p.name)).toContain('finn');
  expect(JSON.stringify(online.data)).not.toMatch(/"session"|s_\d/);

  // Asked but not accepted: finn cannot join with the code, and the agents cannot talk.
  const asked = await erin.call('request_pair', { teammate: 'finn', feature: 'Search' });
  const code = asked.data.code as string;
  expect(code).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  expect((await finn.call('join_pair', { code })).isError).toBe(true);
  expect((await erin.call('send_message', { text: 'hello?', kind: 'chat' })).isError).toBe(true);

  // Someone who is not in the pair cannot join it with the code, even after it is agreed.
  await finn.call('respond_to_pair', { pair_id: asked.data.pair_id, accept: false });
  const again = await erin.call('request_pair', { teammate: 'finn', feature: 'Search, again' });
  const web = await webLogin(server, 'finn');
  expect((await web.post(`/pairs/${again.data.pair_id.slice(2)}/respond`, { accept: 'yes' })).status).toBe(
    303,
  );
  expect((await gus.call('join_pair', { code: again.data.code })).isError).toBe(true);

  // Agreed, then finn's agent joins with the code: connected.
  const joined = await finn.call('join_pair', { code: again.data.code });
  expect(joined.data.status).toBe('connected');
  expect((await erin.call('send_message', { text: 'hello', kind: 'chat' })).isError).toBe(false);
  const news = await finn.call('check_messages');
  expect(news.data.messages.map((m: { text: string }) => m.text)).toContain('hello');
});
