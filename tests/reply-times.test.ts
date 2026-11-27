// PLAN.md §8.4 P1, learned reply times: hidden below five answered questions, shown after.
import { afterAll, expect, it } from 'vitest';
import { pairedAgents, startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it("shows the partner's typical reply times in the receipt only after five answered questions", async () => {
  const { amish, sam } = await pairedAgents(server);
  const askAndAnswer = async () => {
    const asked = await sam.call('send_message', { kind: 'question', text: 'A question' });
    await amish.call('acknowledge', { message_id: asked.data.message_id, eta_minutes: 1 });
    await amish.call('send_message', { kind: 'answer', text: 'An answer', reply_to: asked.data.message_id });
    return asked;
  };

  for (let i = 0; i < 4; i++) await askAndAnswer();
  const fifth = await askAndAnswer();
  // The receipt for the fifth question was made when amish had answered four.
  expect(fifth.data.partner.typical_reply).toBeUndefined();
  expect(fifth.data.delivery).not.toMatch(/usually/);

  const sixth = await sam.call('send_message', { kind: 'question', text: 'Another question' });
  expect(sixth.data.partner.typical_reply).toMatchObject({ answered_questions: 5 });
  expect(sixth.data.partner.typical_reply.answer_seconds).toEqual(expect.any(Number));
  expect(sixth.data.partner.typical_reply.acknowledge_seconds).toEqual(expect.any(Number));
  expect(sixth.data.delivery).toMatch(
    /usually acknowledges in about .+ and answers in about .+ \(from 5 answered questions\)/,
  );
});
