// PLAN.md §8.4 P0 #2: questions cannot get lost.
import { afterAll, expect, it } from 'vitest';
import { pairedAgents, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('keeps a question open until it is answered or deferred, and the same cursor returns the same messages', async () => {
  const { amish, sam } = await pairedAgents(server);
  const asked = await sam.call('send_message', { text: 'Is total in cents?', kind: 'question' });
  const questionId = asked.data.message_id;

  const first = await amish.call('check_messages', { cursor: 0 });
  const again = await amish.call('check_messages', { cursor: 0 });
  const ids = (r: typeof first) => r.data.messages.map((m: { id: string }) => m.id);
  expect(ids(first)).toContain(questionId);
  expect(ids(again)).toEqual(ids(first));

  const openIds = async () => {
    const check = await amish.call('check_messages', { cursor: first.data.cursor });
    const status = await amish.call('pair_status');
    return {
      check: check.data.open_questions_for_you.map((q: { id: string }) => q.id),
      status: status.data.open_questions_for_you.map((q: { id: string }) => q.id),
    };
  };
  expect(await openIds()).toEqual({ check: [questionId], status: [questionId] });

  await amish.call('acknowledge', { message_id: questionId, eta_minutes: 3, note: 'finishing a test run' });
  expect(await openIds()).toEqual({ check: [questionId], status: [questionId] });

  await amish.call('send_message', { text: 'Yes, cents.', kind: 'answer', reply_to: questionId });
  expect(await openIds()).toEqual({ check: [], status: [] });

  const second = await sam.call('send_message', { text: 'Cursor or page numbers?', kind: 'question' });
  expect((await openIds()).check).toEqual([second.data.message_id]);
  await amish.call('defer', { message_id: second.data.message_id, reason: 'needs my human' });
  expect(await openIds()).toEqual({ check: [], status: [] });
  expect((await sam.call('get_message', { message_id: second.data.message_id })).data.state).toBe('deferred');
});
