// Nudges (docs/specs/web.md, "Nudge"): one person pokes the other when their side has gone quiet. The nudged person
// gets a Needs you item (and so a browser notification); their agent, when it has joined, gets a short message.
import type { Db } from '../store/db.ts';
import type { Pair, Participant } from '../store/schema.ts';
import { PairError } from './errors.ts';
import { events } from './events.ts';
import { insertMessage } from './messages.ts';
import { sides } from './room.ts';

const MINUTE = 60_000;
/** Quiet this long before a nudge is offered. */
export const QUIET_MS = 5 * MINUTE;
/** One nudge per person per pair in this window. */
export const NUDGE_EVERY_MS = 5 * MINUTE;

const mins = (ms: number) => `${Math.max(1, Math.round(ms / MINUTE))} min`;

export interface NudgeOffer {
  /** Whether the viewer can nudge now. */
  allowed: boolean;
  /** Why it is offered ("their agent has not been heard from for 14 min"), or why not. */
  reason: string;
  /** When it is offered but too soon after the last one: minutes until the next. */
  waitMinutes?: number;
}

/** The oldest question from the viewer's agents to the partner that is overdue, if any (shared with Needs you). */
export async function overdueQuestions(db: Db, pair: Pair, viewerId: number, now = Date.now()) {
  const mySessions = db.selectFrom('sessions').select('id').where('participant_id', '=', viewerId);
  const open = await db
    .selectFrom('messages')
    .select(['id', 'body', 'created_at'])
    .where('pair_id', '=', pair.id)
    .where('kind', '=', 'question')
    .where('state', '=', 'open')
    .where('sender_session_id', 'in', mySessions)
    .where('approval', 'in', ['none', 'approved'])
    .orderBy('id')
    .execute();
  if (!open.length) return [];
  const acks = await db
    .selectFrom('message_actions')
    .select(['message_id', 'eta_minutes', 'created_at'])
    .where(
      'message_id',
      'in',
      open.map((q) => q.id),
    )
    .where('action', '=', 'acknowledge')
    .orderBy('id')
    .execute();
  const overdue = [];
  for (const q of open) {
    const ack = acks.filter((a) => a.message_id === q.id).at(-1);
    if (ack && ack.eta_minutes !== null) {
      const due = ack.created_at + ack.eta_minutes * MINUTE;
      if (now > due)
        overdue.push({ ...q, waited: now - q.created_at, eta: ack.eta_minutes, late: now - due });
    } else if (now - q.created_at >= QUIET_MS) {
      overdue.push({ ...q, waited: now - q.created_at, eta: undefined, late: undefined });
    }
  }
  return overdue;
}

/** Whether the viewer may nudge their partner in this pair now, and why. */
export async function nudgeOffer(
  db: Db,
  pair: Pair,
  viewer: Participant,
  now = Date.now(),
): Promise<NudgeOffer> {
  if (pair.status !== 'active') return { allowed: false, reason: 'The pair is not open.' };
  const { partner, partnerName } = await sides(db, pair, viewer.id);

  let reason: string | undefined;
  const overdue = await overdueQuestions(db, pair, viewer.id, now);
  if (!partner) {
    const since = now - (pair.accepted_at ?? pair.created_at);
    if (since >= QUIET_MS) reason = `${partnerName}'s agent has not joined for ${mins(since)}`;
  } else {
    const quiet = now - partner.session.last_seen_at;
    if (partner.session.state === 'closed') reason = `${partnerName}'s agent is not running`;
    else if (quiet >= QUIET_MS) reason = `${partnerName}'s agent has not been heard from for ${mins(quiet)}`;
  }
  if (!reason && overdue.length) {
    reason = `Your agent's question has waited ${mins(overdue[0]!.waited)} for an answer`;
  }
  if (!reason) return { allowed: false, reason: `${partnerName}'s side is active.` };

  const last = await db
    .selectFrom('nudges')
    .select('created_at')
    .where('pair_id', '=', pair.id)
    .where('from_participant_id', '=', viewer.id)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (last && now - last.created_at < NUDGE_EVERY_MS) {
    return {
      allowed: false,
      reason,
      waitMinutes: Math.max(1, Math.ceil((last.created_at + NUDGE_EVERY_MS - now) / MINUTE)),
    };
  }
  return { allowed: true, reason };
}

/** Nudges the partner: a Needs you item for them and, when their agent has joined, a message to it. */
export async function nudge(db: Db, pair: Pair, viewer: Participant): Promise<void> {
  const offer = await nudgeOffer(db, pair, viewer);
  if (!offer.allowed)
    throw new PairError(
      offer.waitMinutes ? `You can nudge again in ${offer.waitMinutes} min.` : offer.reason,
    );
  const { partner } = await sides(db, pair, viewer.id);
  const overdue = await overdueQuestions(db, pair, viewer.id);
  const to = pair.requester_id === viewer.id ? pair.partner_id : pair.requester_id;
  await db
    .insertInto('nudges')
    .values({
      pair_id: pair.id,
      from_participant_id: viewer.id,
      to_participant_id: to,
      created_at: Date.now(),
    })
    .execute();
  if (partner && pair.session_a_id !== null && pair.session_b_id !== null) {
    await insertMessage(db, {
      pair_id: pair.id,
      sender_kind: 'human',
      sender_session_id: null,
      sender_participant_id: viewer.id,
      recipient_session_id: partner.session.id,
      kind: 'chat',
      topic: 'nudge',
      body: overdue.length
        ? `${viewer.name} nudged you: their agent's question has waited ${mins(overdue[0]!.waited)} for an answer. Answer it, or acknowledge it with an ETA.`
        : `${viewer.name} nudged you: they are waiting on your side of the pair. Check the pair for anything waiting on you and reply.`,
      reply_to: null,
      state: null,
    });
  } else {
    events.pairChanged(pair.id);
  }
}

/** The viewer opened the pair's room: everything in it up to now counts as seen. */
export async function markSeen(
  db: Db,
  pairId: number,
  participantId: number,
  now = Date.now(),
): Promise<void> {
  await db
    .insertInto('pair_views')
    .values({ pair_id: pairId, participant_id: participantId, seen_at: now })
    .onConflict((oc) => oc.columns(['pair_id', 'participant_id']).doUpdateSet({ seen_at: now }))
    .execute();
}
