// Messages: stored, delivery attempts, agent actions. Open questions stay visible until answered or deferred.
import type { ExpressionBuilder } from 'kysely';
import type { Db } from '../store/db.ts';
import type {
  ActionKind,
  AttemptResult,
  Database,
  Message,
  MessageKind,
  Pair,
  Route,
  Session,
} from '../store/schema.ts';
import { PairError, ref } from './errors.ts';
import { events } from './events.ts';
import { partnerSessionId } from './pairs.ts';
import { sanitize, storable } from './sanitize.ts';
import { agentLabel, viewSession } from './sessions.ts';

/** Messages a session may see: addressed to it, or to both sides (and not its own); never unapproved ones. */
export function visibleTo(sessionId: number) {
  return (eb: ExpressionBuilder<Database, 'messages'>) =>
    eb.and([
      eb.or([
        eb('messages.recipient_session_id', '=', sessionId),
        eb.and([
          eb('messages.recipient_session_id', 'is', null),
          eb.or([
            eb('messages.sender_session_id', 'is', null),
            eb('messages.sender_session_id', '!=', sessionId),
          ]),
        ]),
      ]),
      eb('messages.approval', 'in', ['none', 'approved']),
    ]);
}

export async function insertMessage(
  db: Db,
  values: Omit<
    Message,
    'id' | 'approval' | 'created_at' | 'answered_at' | 'state_reason' | 'stop_raised_at'
  > & {
    approval?: Message['approval'];
  },
): Promise<Message> {
  const message = await db
    .insertInto('messages')
    .values({ ...values, created_at: Date.now() })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (message.approval !== 'pending') events.messageVisible(message);
  events.pairChanged(message.pair_id);
  return message;
}

/** A system message from Pair41 to one session (or to both, with recipient null). */
export async function systemMessage(
  db: Db,
  pairId: number,
  recipientSessionId: number | null,
  topic: string,
  body: string,
): Promise<Message> {
  return insertMessage(db, {
    pair_id: pairId,
    sender_kind: 'system',
    sender_session_id: null,
    sender_participant_id: null,
    recipient_session_id: recipientSessionId,
    kind: 'system',
    topic,
    body,
    reply_to: null,
    state: null,
  });
}

export async function recordAttempt(
  db: Db,
  messageId: number,
  sessionId: number,
  route: Route,
  result: AttemptResult,
  detail?: string,
): Promise<void> {
  await db
    .insertInto('delivery_attempts')
    .values({
      message_id: messageId,
      session_id: sessionId,
      route,
      result,
      detail: detail ?? null,
      created_at: Date.now(),
    })
    .execute();
}

async function recordAction(
  db: Db,
  messageId: number,
  sessionId: number,
  action: ActionKind,
  etaMinutes: number | null,
  note: string | null,
) {
  await db
    .insertInto('message_actions')
    .values({
      message_id: messageId,
      session_id: sessionId,
      action,
      eta_minutes: etaMinutes,
      note,
      created_at: Date.now(),
    })
    .execute();
}

/** A message in the caller's pair, sent by the caller or visible to it. Anything else is "not found". */
export async function findMessage(db: Db, session: Session, pair: Pair, messageId: number): Promise<Message> {
  const message = await db
    .selectFrom('messages')
    .selectAll()
    .where('id', '=', messageId)
    .where('pair_id', '=', pair.id)
    .where((eb) => eb.or([eb('sender_session_id', '=', session.id), visibleTo(session.id)(eb)]))
    .executeTakeFirst();
  if (!message) throw new PairError(`There is no message ${ref('m', messageId)} in your pair.`);
  return message;
}

/** A question the partner asked this session that is still waiting (open or deferred). */
async function questionForMe(db: Db, session: Session, pair: Pair, messageId: number): Promise<Message> {
  const message = await findMessage(db, session, pair, messageId);
  if (
    message.kind !== 'question' ||
    message.recipient_session_id !== session.id ||
    message.state === 'answered'
  ) {
    throw new PairError(`${ref('m', messageId)} is not an unanswered question from your partner.`);
  }
  return message;
}

export async function sendMessage(
  db: Db,
  session: Session,
  pair: Pair,
  input: { text: string; kind: Exclude<MessageKind, 'system'>; replyTo?: number },
): Promise<Message> {
  const text = storable(input.text).trim();
  if (!text) throw new PairError('The message is empty.');
  if (text.length > 4000)
    throw new PairError('Messages are at most 4000 characters. Share interfaces, not files.');
  let question: Message | undefined;
  if (input.kind === 'answer') {
    if (input.replyTo === undefined)
      throw new PairError('An answer needs reply_to: the id of the question it answers.');
    question = await questionForMe(db, session, pair, input.replyTo);
  }

  const sender = await db
    .selectFrom('participants')
    .select('approve_before_send')
    .where('id', '=', session.participant_id)
    .executeTakeFirstOrThrow();
  const message = await insertMessage(db, {
    pair_id: pair.id,
    sender_kind: 'agent',
    sender_session_id: session.id,
    sender_participant_id: session.participant_id,
    recipient_session_id: partnerSessionId(pair, session.id),
    kind: input.kind,
    topic: null,
    body: text,
    reply_to: question?.id ?? input.replyTo ?? null,
    state: input.kind === 'question' ? 'open' : null,
    approval: sender.approve_before_send === 1 ? 'pending' : 'none',
  });
  // An answer waiting for its human's approval closes the question only once it is approved.
  if (question && message.approval !== 'pending') await closeQuestion(db, question.id, session.id);
  return message;
}

async function closeQuestion(db: Db, questionId: number, answeringSessionId: number) {
  await db
    .updateTable('messages')
    .set({ state: 'answered', answered_at: Date.now() })
    .where('id', '=', questionId)
    .execute();
  await recordAction(db, questionId, answeringSessionId, 'answer', null, null);
}

/**
 * Approve before send (P1): the sender's human approves or rejects a message waiting on the web page. An approved
 * message is sent then, as a new message with a new id, so it lands after the partner's cursor; the sender's agent
 * is told the new id. A rejected one is never sent.
 */
export async function decideApproval(db: Db, participantId: number, messageId: number, approve: boolean) {
  const pending = await db
    .selectFrom('messages')
    .selectAll()
    .where('id', '=', messageId)
    .where('sender_participant_id', '=', participantId)
    .where('approval', '=', 'pending')
    .executeTakeFirst();
  if (!pending)
    throw new PairError(`There is no message ${ref('m', messageId)} waiting for your approval.`, 404);
  if (!approve) {
    await db.updateTable('messages').set({ approval: 'rejected' }).where('id', '=', messageId).execute();
    if (pending.sender_session_id !== null) {
      await systemMessage(
        db,
        pending.pair_id,
        pending.sender_session_id,
        'approval',
        `Your human did not approve ${ref('m', messageId)}, so it was not sent.`,
      );
    }
    events.pairChanged(pending.pair_id);
    return pending;
  }
  const {
    id: _old,
    created_at: _created,
    answered_at: _answered,
    stop_raised_at: _raised,
    state_reason: _reason,
    ...copy
  } = pending;
  await db.deleteFrom('messages').where('id', '=', messageId).execute();
  const sent = await insertMessage(db, { ...copy, approval: 'approved' });
  if (sent.kind === 'answer' && sent.reply_to !== null && sent.sender_session_id !== null) {
    await closeQuestion(db, sent.reply_to, sent.sender_session_id);
  }
  if (sent.sender_session_id !== null) {
    await systemMessage(
      db,
      sent.pair_id,
      sent.sender_session_id,
      'approval',
      `Your human approved ${ref('m', messageId)}; it was sent as ${ref('m', sent.id)}.`,
    );
  }
  return sent;
}

export async function acknowledge(
  db: Db,
  session: Session,
  pair: Pair,
  messageId: number,
  etaMinutes: number,
  note?: string,
): Promise<void> {
  const question = await questionForMe(db, session, pair, messageId);
  await recordAction(db, question.id, session.id, 'acknowledge', etaMinutes, note ?? null);
  const me = await viewSession(db, session.id);
  await systemMessage(
    db,
    pair.id,
    question.sender_session_id,
    'ack',
    `${me.name} acknowledged your question ${ref('m', question.id)}: answer in about ${etaMinutes} min${note ? ` (${note})` : ''}.`,
  );
}

/**
 * A person in the pair closes an open or deferred question on the Pair41 page, for when the pair has moved past it
 * (docs/specs/web.md, "Close a question"). The agent that asked it is told; that message does not wake it.
 */
export async function closeQuestionOnPage(
  db: Db,
  pair: Pair,
  person: { id: number; name: string },
  messageId: number,
): Promise<void> {
  const question = await db
    .selectFrom('messages')
    .selectAll()
    .where('id', '=', messageId)
    .where('pair_id', '=', pair.id)
    .where('kind', '=', 'question')
    .executeTakeFirst();
  if (!question) throw new PairError(`${ref('m', messageId)} is not a question in this pair.`, 404);
  if (question.state !== 'open' && question.state !== 'deferred') return; // already answered or closed
  await db
    .updateTable('messages')
    .set({ state: 'closed', state_reason: `closed by ${person.name} on the Pair41 page` })
    .where('id', '=', question.id)
    .execute();
  if (question.sender_session_id !== null) {
    await systemMessage(
      db,
      pair.id,
      question.sender_session_id,
      'closed',
      `${person.name} closed your question ${ref('m', question.id)} on the Pair41 page, so no answer is coming.`,
    );
  } else {
    events.pairChanged(pair.id);
  }
}

export async function deferQuestion(
  db: Db,
  session: Session,
  pair: Pair,
  messageId: number,
  reason: string,
): Promise<void> {
  const question = await questionForMe(db, session, pair, messageId);
  await db
    .updateTable('messages')
    .set({ state: 'deferred', state_reason: reason })
    .where('id', '=', question.id)
    .execute();
  await recordAction(db, question.id, session.id, 'defer', null, reason);
  const me = await viewSession(db, session.id);
  await systemMessage(
    db,
    pair.id,
    question.sender_session_id,
    'defer',
    `${me.name} deferred your question ${ref('m', question.id)}: ${reason}. It stays open on the Pair41 page.`,
  );
}

/** Open questions the partner asked this session. */
export async function openQuestionsFor(db: Db, session: Session, pair: Pair): Promise<Message[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where('kind', '=', 'question')
    .where('state', '=', 'open')
    .where(visibleTo(session.id))
    .orderBy('id')
    .execute();
}

/** Questions this session asked that are not answered yet (open or deferred). */
export async function openQuestionsFrom(db: Db, session: Session, pair: Pair): Promise<Message[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where('kind', '=', 'question')
    .where('sender_session_id', '=', session.id)
    .where('state', 'in', ['open', 'deferred'])
    .orderBy('id')
    .execute();
}

/** Who sent a message, as an agent should read it: "sam (Codex)", "sam (human, on the Pair41 page)", "Pair41". */
export async function senderLabel(db: Db, message: Message): Promise<string> {
  if (message.sender_kind === 'system') return 'Pair41';
  if (message.sender_kind === 'human') {
    const person = await db
      .selectFrom('participants')
      .select('name')
      .where('id', '=', message.sender_participant_id!)
      .executeTakeFirstOrThrow();
    return `${person.name} (human, on the Pair41 page)`;
  }
  const view = await viewSession(db, message.sender_session_id!);
  return `${view.name} (${agentLabel(view.agent)})`;
}

/** A message as an agent sees it. Partner text is sanitised. */
export async function formatMessage(db: Db, message: Message) {
  return {
    id: ref('m', message.id),
    from: await senderLabel(db, message),
    kind: message.kind,
    text: sanitize(message.body),
    ...(message.reply_to ? { reply_to: ref('m', message.reply_to) } : {}),
    ...(message.state ? { state: message.state } : {}),
    at: new Date(message.created_at).toISOString(),
  };
}

/**
 * Messages after the cursor that this session may see. Without a cursor, the last one handed to this session
 * is used. Each returned message is recorded as a delivery attempt (route tool).
 */
export async function checkMessages(db: Db, session: Session, pair: Pair, cursor?: number) {
  const after = cursor ?? session.msg_cursor;
  const messages = await db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where('id', '>', after)
    .where(visibleTo(session.id))
    .orderBy('id')
    .limit(50)
    .execute();
  for (const message of messages) await recordAttempt(db, message.id, session.id, 'tool', 'returned');
  const newCursor = messages.length ? messages[messages.length - 1]!.id : after;
  await db
    .updateTable('sessions')
    .set({ msg_cursor: newCursor, notified_upto: Math.max(session.notified_upto, newCursor) })
    .where('id', '=', session.id)
    .execute();
  return { messages, cursor: newCursor };
}

export async function messageDetail(db: Db, message: Message) {
  const attempts = await db
    .selectFrom('delivery_attempts')
    .selectAll()
    .where('message_id', '=', message.id)
    .orderBy('id')
    .execute();
  const actions = await db
    .selectFrom('message_actions')
    .selectAll()
    .where('message_id', '=', message.id)
    .orderBy('id')
    .execute();
  return {
    ...(await formatMessage(db, message)),
    state: message.state,
    ...(message.state_reason ? { reason: message.state_reason } : {}),
    attempts: attempts.map((a) => ({
      route: a.route,
      result: a.result,
      at: new Date(a.created_at).toISOString(),
      ...(a.detail ? { detail: a.detail } : {}),
    })),
    actions: actions.map((a) => ({
      action: a.action,
      at: new Date(a.created_at).toISOString(),
      ...(a.eta_minutes !== null ? { eta_minutes: a.eta_minutes } : {}),
      ...(a.note ? { note: a.note } : {}),
    })),
  };
}

/** Waits for an answer to the caller's own question: up to 45 s, and stops when the client goes away. */
export async function waitForReply(
  db: Db,
  session: Session,
  pair: Pair,
  messageId: number,
  timeoutSeconds: number,
  signal: AbortSignal,
) {
  const question = await findMessage(db, session, pair, messageId);
  if (question.kind !== 'question' || question.sender_session_id !== session.id) {
    throw new PairError(`${ref('m', messageId)} is not a question you asked.`);
  }
  const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 1), 45) * 1000;
  while (!signal.aborted) {
    const answer = await db
      .selectFrom('messages')
      .selectAll()
      .where('reply_to', '=', question.id)
      .where('kind', '=', 'answer')
      .where('approval', 'in', ['none', 'approved'])
      .orderBy('id')
      .executeTakeFirst();
    if (answer) return { status: 'answered' as const, answer: await formatMessage(db, answer) };
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const ack = await db
    .selectFrom('message_actions')
    .selectAll()
    .where('message_id', '=', question.id)
    .where('action', 'in', ['acknowledge', 'defer'])
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return {
    status: 'waiting' as const,
    ...(ack
      ? {
          [ack.action === 'defer' ? 'deferred' : 'acknowledged']: {
            at: new Date(ack.created_at).toISOString(),
            ...(ack.eta_minutes !== null ? { eta_minutes: ack.eta_minutes } : {}),
            ...(ack.note ? { note: ack.note } : {}),
          },
        }
      : {}),
    next: 'Carry on with other work. The answer will show up in check_messages.',
  };
}

/**
 * The unread line: only when something arrived since the last notice to this session, so agents are not nagged.
 * Marks those messages as noticed.
 */
export async function unreadNotice(
  db: Db,
  session: Session,
  pair: Pair | undefined,
): Promise<string | undefined> {
  const lines: string[] = [];
  if (pair) {
    const seen = Math.max(session.notified_upto, session.msg_cursor);
    const fresh = await db
      .selectFrom('messages')
      .select(['id', 'kind'])
      .where('pair_id', '=', pair.id)
      .where('id', '>', seen)
      .where(visibleTo(session.id))
      .orderBy('id')
      .execute();
    if (fresh.length) {
      const unread = await db
        .selectFrom('messages')
        .select(['id', 'kind'])
        .where('pair_id', '=', pair.id)
        .where('id', '>', session.msg_cursor)
        .where(visibleTo(session.id))
        .execute();
      const partner = await viewSession(db, partnerSessionId(pair, session.id));
      const questions = unread.filter((m) => m.kind === 'question').length;
      const kinds = questions ? ` (${questions} question${questions > 1 ? 's' : ''})` : '';
      lines.push(`pair: ${unread.length} unread from ${partner.name}${kinds} · call check_messages`);
      await db
        .updateTable('sessions')
        .set({ notified_upto: fresh[fresh.length - 1]!.id })
        .where('id', '=', session.id)
        .execute();
    }
  }
  const requests = await db
    .selectFrom('pairs')
    .innerJoin('participants', 'participants.id', 'pairs.requester_id')
    .select(['pairs.id', 'pairs.feature', 'participants.name'])
    .where('pairs.status', '=', 'requested')
    .where('pairs.partner_id', '=', session.participant_id)
    .where('pairs.id', '>', session.request_notified_upto)
    .orderBy('pairs.id')
    .execute();
  if (requests.length) {
    for (const r of requests) {
      lines.push(
        `pair: ${r.name} asked to pair on "${r.feature}" (${ref('p', r.id)}) · tell your human; they accept on the Pair41 page`,
      );
    }
    await db
      .updateTable('sessions')
      .set({ request_notified_upto: requests[requests.length - 1]!.id })
      .where('id', '=', session.id)
      .execute();
  }
  return lines.length ? lines.join('\n') : undefined;
}
