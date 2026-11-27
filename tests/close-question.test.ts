// PLAN.md §8.4 P1, closing a question: a person closes a deferred question from the page; it leaves Needs you and the
// open questions, the agent that asked it is told, and nobody outside the pair can close it.
import { afterAll, expect, it } from 'vitest';
import { pairedAgents, startServer, webLogin } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('lets a person in the pair close a deferred question the pair has moved past', async () => {
  const { amish, sam, pairId } = await pairedAgents(server);
  const asked = await amish.call('send_message', { kind: 'question', text: 'What are we building?' });
  await sam.call('defer', { message_id: asked.data.message_id, reason: 'sam has not said yet' });
  const close = `/pairs/${pairId.replace(/^p_/, '')}/questions/${String(asked.data.message_id).replace(/^m_/, '')}/close`;

  await server.addUser('kim');
  const kimWeb = await webLogin(server, 'kim');
  expect((await kimWeb.post(close, {})).status).toBe(404);

  const samWeb = await webLogin(server, 'sam');
  expect((await samWeb.get('/needs')).text).toContain('What are we building?');
  expect((await samWeb.post(close, {})).status).toBe(303);
  expect((await samWeb.get('/needs')).text).not.toContain('What are we building?');
  expect((await amish.call('pair_status')).data.open_questions_from_you).toEqual([]);
  const told = (await amish.call('check_messages')).data.messages as { kind: string; text: string }[];
  expect(told.some((m) => m.kind === 'system' && /sam closed your question/.test(m.text))).toBe(true);
});
