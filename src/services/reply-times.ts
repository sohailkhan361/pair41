// Learned reply times (P1): an agent's typical time to acknowledge and to answer, from its own history. Shown only once
// that agent (this person with this agent kind) has answered at least five questions.
import type { Db } from '../store/db.ts';
import { median } from './analytics.ts';

export const MIN_ANSWERED = 5;

export interface ReplyTimes {
  answered_questions: number;
  acknowledge_seconds?: number;
  answer_seconds: number;
}

export async function replyTimes(
  db: Db,
  participantId: number,
  agentKind: string,
): Promise<ReplyTimes | undefined> {
  const answers = await db
    .selectFrom('messages as answer')
    .innerJoin('sessions', 'sessions.id', 'answer.sender_session_id')
    .innerJoin('messages as question', 'question.id', 'answer.reply_to')
    .select(['question.id as question_id', 'question.created_at as asked_at', 'question.answered_at'])
    .where('answer.kind', '=', 'answer')
    .where('sessions.participant_id', '=', participantId)
    .where('sessions.agent_kind', '=', agentKind)
    .where('question.state', '=', 'answered')
    .orderBy('answer.id', 'desc')
    .limit(50)
    .execute();
  if (answers.length < MIN_ANSWERED) return undefined;

  const acks = await db
    .selectFrom('message_actions')
    .select(['message_id', 'created_at'])
    .where('action', '=', 'acknowledge')
    .where(
      'message_id',
      'in',
      answers.map((a) => a.question_id),
    )
    .execute();
  const ackTimes = answers
    .map((a) => {
      const ack = acks
        .filter((x) => x.message_id === a.question_id)
        .sort((x, y) => x.created_at - y.created_at)[0];
      return ack ? ack.created_at - a.asked_at : undefined;
    })
    .filter((ms): ms is number => ms !== undefined);
  const answerMs = median(
    answers.filter((a) => a.answered_at !== null).map((a) => a.answered_at! - a.asked_at),
  )!;
  const ackMs = median(ackTimes);
  return {
    answered_questions: answers.length,
    ...(ackMs !== null ? { acknowledge_seconds: Math.round(ackMs / 1000) } : {}),
    answer_seconds: Math.round(answerMs / 1000),
  };
}

export function describeReplyTimes(times: ReplyTimes): string {
  const ago = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);
  const ack =
    times.acknowledge_seconds !== undefined
      ? `acknowledges in about ${ago(times.acknowledge_seconds)} and `
      : '';
  return `usually ${ack}answers in about ${ago(times.answer_seconds)} (from ${times.answered_questions} answered questions)`;
}
