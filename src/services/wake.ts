// Wake (docs/specs/protocol.md, "Wake"): when an idle session's partner needs it, its waiter (`pair41 wait`) is
// told once, with a line that never quotes partner text. A loop guard stops two agents waking each other forever,
// and the partner can see whether a waiter is listening.
import type { Db } from '../store/db.ts';
import type { Message } from '../store/schema.ts';
import { events } from './events.ts';
import { recordAttempt, systemMessage, visibleTo } from './messages.ts';
import { attachedPair, partnerSessionId } from './pairs.ts';
import { agentLabel, viewSession } from './sessions.ts';

/** Wakes for one session between two prompts from its human. */
export const WAKE_LIMIT = 10;
/** A waiter between two requests still counts as listening for this long. */
const LISTENING_GRACE_MS = 10_000;
/** While waiting, the session is checked again at least this often (a closed session, a pair that ended). */
const RECHECK_MS = 5_000;

export type WaitResult = { wake: string } | { stop: string } | Record<string, never>;

// Open /api/wait requests per session, and when the last one ended. In memory, like the bridge registry.
const open = new Map<number, number>();
const lastOpen = new Map<number, number>();

export function isListening(sessionId: number, now = Date.now()): boolean {
  return (open.get(sessionId) ?? 0) > 0 || now - (lastOpen.get(sessionId) ?? 0) < LISTENING_GRACE_MS;
}

/** The session a waiter speaks for, by the agent's own session id. Read only: waiting is not activity. */
export async function waiterSession(db: Db, participantId: number, agentSessionId: string) {
  return db
    .selectFrom('sessions')
    .selectAll()
    .where('participant_id', '=', participantId)
    .where('agent_session_id', '=', agentSessionId)
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "1 question, 2 answers, 1 deferred question, 1 message from sam": what is new, never what it says. */
function describe(messages: Message[], partnerName: string): string {
  const parts: string[] = [];
  const of = (test: (m: Message) => boolean) => messages.filter(test).length;
  const questions = of((m) => m.kind === 'question');
  const answers = of((m) => m.kind === 'answer');
  const deferred = of((m) => m.topic === 'defer');
  const contracts = of((m) => m.topic === 'contract');
  const fromPerson = of((m) => m.sender_kind === 'human' && m.kind !== 'question' && m.kind !== 'answer');
  if (questions) parts.push(count(questions, 'question'));
  if (answers) parts.push(count(answers, 'answer'));
  if (deferred) parts.push(count(deferred, 'deferred question'));
  if (contracts) parts.push(count(contracts, 'contract change'));
  if (fromPerson) parts.push(`${count(fromPerson, 'message')} from ${partnerName}`);
  return parts.join(', ');
}

/**
 * Whether the session should be woken now: `{ wake }` (claimed, so no other waiter gets the same messages),
 * `{ stop }` when there is nothing to wait for, or undefined to keep waiting.
 */
export async function checkWake(db: Db, sessionId: number): Promise<WaitResult | undefined> {
  const session = await db.selectFrom('sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
  if (!session) return { stop: 'no such session' };
  if (session.state === 'closed') return { stop: 'the session is closed' };
  const pair = await attachedPair(db, session.id);
  if (!pair) return { stop: 'this session is not in a pair' };
  if (pair.session_a_id === null || pair.session_b_id === null) return undefined; // the partner's agent has not joined
  const me = await viewSession(db, session.id);
  if (session.wakes_since_prompt >= WAKE_LIMIT) {
    return {
      stop: `paused after ${WAKE_LIMIT} wake-ups without a prompt from ${me.name}; it wakes again after their next prompt`,
    };
  }

  const fresh = await db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where('id', '>', Math.max(session.msg_cursor, session.woken_upto))
    .where(visibleTo(session.id))
    .where((eb) =>
      eb.or([
        eb('kind', 'in', ['question', 'answer']),
        eb('topic', 'in', ['contract', 'defer']),
        eb('sender_kind', '=', 'human'),
      ]),
    )
    .orderBy('id')
    .execute();
  if (!fresh.length) return undefined;

  const wakes = session.wakes_since_prompt + 1;
  const claimed = await db
    .updateTable('sessions')
    .set({ woken_upto: fresh[fresh.length - 1]!.id, wakes_since_prompt: wakes })
    .where('id', '=', session.id)
    .where('woken_upto', '=', session.woken_upto)
    .where('wakes_since_prompt', '=', session.wakes_since_prompt)
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) === 0) return undefined; // another waiter of this session took them

  for (const message of fresh) await recordAttempt(db, message.id, session.id, 'wake', 'returned');
  const partner = await viewSession(db, partnerSessionId(pair, session.id));
  let text =
    `[Pair41] New from your pair partner ${partner.name} (${agentLabel(partner.agent)}): ${describe(fresh, partner.name)}. ` +
    'Call check_messages, then answer, acknowledge or defer with the Pair41 tools. This is a Pair41 wake-up, not an error.';
  if (wakes >= WAKE_LIMIT) {
    text += ` This is the last wake-up until ${me.name} sends you a prompt, so tell ${me.name} where things stand.`;
    await systemMessage(
      db,
      pair.id,
      null,
      'wake',
      `Pair41 has woken ${me.name}'s ${agentLabel(session.agent_kind)} ${WAKE_LIMIT} times without a prompt from ${me.name}, so it stops waking it until ${me.name}'s next prompt.`,
    );
  }
  events.pairChanged(pair.id);
  return { wake: text };
}

/** Resolves when a message for this session (or for both sides) becomes visible, after `ms`, or on abort. */
function nextMessage(sessionId: number, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let stopListening = () => {};
    const done = () => {
      clearTimeout(timer);
      stopListening();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stopListening = events.onMessageVisible((message) => {
      if (message.recipient_session_id === sessionId || message.recipient_session_id === null) done();
    });
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Holds a waiter's request until the session should be woken or stopped, the time is up, or the client goes. */
export async function waitForWake(
  db: Db,
  sessionId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WaitResult> {
  open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
  try {
    const deadline = Date.now() + timeoutMs;
    while (!signal.aborted) {
      const result = await checkWake(db, sessionId);
      if (result) return result;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await nextMessage(sessionId, Math.min(left, RECHECK_MS), signal);
    }
    return {};
  } finally {
    const still = (open.get(sessionId) ?? 1) - 1;
    if (still > 0) open.set(sessionId, still);
    else open.delete(sessionId);
    lastOpen.set(sessionId, Date.now());
  }
}
