// Pairs are between people (docs/specs/mcp-tools.md, "Pairing is between people"): one person asks, the other
// agrees, then each tells their own agent to join with the pair's code. The agents can talk once both have joined.
// There are no solo pairs: one person splitting work between their own agents is better served by subagents.
import { randomInt } from 'node:crypto';
import type { Db } from '../store/db.ts';
import type { Pair, Session } from '../store/schema.ts';
import { participantByName } from './auth.ts';
import { PairError, ref } from './errors.ts';
import { events } from './events.ts';
import { storable } from './sanitize.ts';

const OPEN = ['requested', 'active'] as const;

/** The agreed pair this session is attached to, whether or not the other side has an agent yet. */
export async function attachedPair(db: Db, sessionId: number): Promise<Pair | undefined> {
  return db
    .selectFrom('pairs')
    .selectAll()
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('session_a_id', '=', sessionId), eb('session_b_id', '=', sessionId)]))
    .executeTakeFirst();
}

/** The connected pair this session is in: agreed, with an agent on both sides. */
export async function activePair(db: Db, sessionId: number): Promise<Pair | undefined> {
  const pair = await attachedPair(db, sessionId);
  return pair && pair.session_a_id !== null && pair.session_b_id !== null ? pair : undefined;
}

async function nameOf(db: Db, participantId: number): Promise<string> {
  const row = await db
    .selectFrom('participants')
    .select('name')
    .where('id', '=', participantId)
    .executeTakeFirstOrThrow();
  return row.name;
}

export async function requirePair(db: Db, session: Session): Promise<Pair> {
  const pair = await attachedPair(db, session.id);
  if (pair && pair.session_a_id !== null && pair.session_b_id !== null) return pair;
  if (pair) {
    const otherId = pair.session_a_id === session.id ? pair.partner_id : pair.requester_id;
    throw new PairError(
      `Pair ${ref('p', pair.id)} is agreed, but ${await nameOf(db, otherId)}'s agent has not joined yet. They tell their agent: join Pair41 pair ${pair.code}.`,
    );
  }
  throw new PairError(
    'This session is not in a pair. Pairs are agreed between people on the Pair41 page; then each person tells their agent to join with the pair code. Call pair_status.',
  );
}

export function partnerSessionId(pair: Pair, sessionId: number): number {
  const other = pair.session_a_id === sessionId ? pair.session_b_id : pair.session_a_id;
  if (other === null) throw new PairError("Your partner's agent has not joined yet.");
  return other;
}

/** The open (asked or agreed) pair this session is attached to, other than `except`. */
async function sessionBusy(db: Db, sessionId: number, except?: number): Promise<Pair | undefined> {
  let query = db
    .selectFrom('pairs')
    .selectAll()
    .where('status', 'in', OPEN)
    .where((eb) => eb.or([eb('session_a_id', '=', sessionId), eb('session_b_id', '=', sessionId)]));
  if (except !== undefined) query = query.where('id', '!=', except);
  return query.executeTakeFirst();
}

async function refuseIfBusy(db: Db, session: Session, except?: number) {
  const busy = await sessionBusy(db, session.id, except);
  if (busy) {
    throw new PairError(
      `This agent is already in pair ${ref('p', busy.id)} ("${busy.feature}"). End that pair first, or use another agent session.`,
    );
  }
}

/** The open pair between these two people, if any. */
export async function openPairBetween(db: Db, a: number, b: number): Promise<Pair | undefined> {
  return db
    .selectFrom('pairs')
    .selectAll()
    .where('status', 'in', OPEN)
    .where((eb) =>
      eb.or([
        eb.and([eb('requester_id', '=', a), eb('partner_id', '=', b)]),
        eb.and([eb('requester_id', '=', b), eb('partner_id', '=', a)]),
      ]),
    )
    .executeTakeFirst();
}

const WORDS_A = [
  'amber',
  'azure',
  'bold',
  'brisk',
  'calm',
  'clever',
  'cobalt',
  'coral',
  'crisp',
  'dapper',
  'eager',
  'fair',
  'fleet',
  'gentle',
  'golden',
  'hardy',
  'humble',
  'indigo',
  'jolly',
  'keen',
  'lively',
  'lucid',
  'mellow',
  'merry',
  'misty',
  'nimble',
  'noble',
  'olive',
  'plucky',
  'polar',
  'quick',
  'quiet',
  'rapid',
  'ruby',
  'rustic',
  'scarlet',
  'silver',
  'smooth',
  'snowy',
  'solar',
  'steady',
  'sunny',
  'swift',
  'teal',
  'tidy',
  'vivid',
  'warm',
  'witty',
];
const WORDS_B = [
  'otter',
  'falcon',
  'badger',
  'heron',
  'lynx',
  'marten',
  'osprey',
  'panda',
  'puffin',
  'raven',
  'robin',
  'seal',
  'tiger',
  'walrus',
  'wren',
  'yak',
  'beacon',
  'canyon',
  'comet',
  'delta',
  'ember',
  'fjord',
  'glacier',
  'harbor',
  'island',
  'lagoon',
  'meadow',
  'nebula',
  'orbit',
  'pebble',
  'prism',
  'quasar',
  'reef',
  'ridge',
  'river',
  'summit',
  'tundra',
  'valley',
  'vertex',
  'willow',
  'zephyr',
  'atlas',
  'cedar',
  'dune',
  'grove',
  'maple',
  'quartz',
  'spruce',
];

/** A new pair code no other pair has, such as amber-otter-42. */
async function newCode(db: Db): Promise<string> {
  for (;;) {
    const code = `${WORDS_A[randomInt(WORDS_A.length)]}-${WORDS_B[randomInt(WORDS_B.length)]}-${randomInt(10, 100)}`;
    const taken = await db.selectFrom('pairs').select('id').where('code', '=', code).executeTakeFirst();
    if (!taken) return code;
  }
}

/** Ask a teammate to pair. `session`, when the ask comes from an agent, joins on the asker's side at once. */
export async function requestPair(
  db: Db,
  requesterId: number,
  teammate: string,
  feature: string,
  session?: Session,
): Promise<Pair> {
  const target = await participantByName(db, teammate.trim());
  if (!target)
    throw new PairError(`There is no Pair41 user called "${teammate}". Call who_is_online to see names.`);
  if (target.id === requesterId) {
    throw new PairError(
      'Pair with a teammate: Pair41 connects two developers. To split work between your own agents, use one agent with subagents.',
    );
  }
  const cleanFeature = storable(feature).trim().slice(0, 120);
  if (!cleanFeature) throw new PairError('Say which feature you are pairing on.');
  const existing = await openPairBetween(db, requesterId, target.id);
  if (existing) {
    throw new PairError(
      `You and ${target.name} already have an open pair: ${ref('p', existing.id)} ("${existing.feature}"). Open it on the Pair41 page.`,
    );
  }
  if (session) await refuseIfBusy(db, session);
  const pair = await db
    .insertInto('pairs')
    .values({
      code: await newCode(db),
      feature: cleanFeature,
      requester_id: requesterId,
      partner_id: target.id,
      session_a_id: session?.id ?? null,
      session_b_id: null,
      project: session?.project || null,
      status: 'requested',
      created_at: Date.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  events.pairRequested(pair.id);
  events.pairChanged(pair.id);
  return pair;
}

/** Accept or decline a request made to this person. On accept, `session` (from an agent) joins on their side. */
export async function respondToPair(
  db: Db,
  participantId: number,
  pairId: number,
  accept: boolean,
  session?: Session,
): Promise<Pair> {
  const pair = await db.selectFrom('pairs').selectAll().where('id', '=', pairId).executeTakeFirst();
  if (!pair || pair.partner_id !== participantId || pair.status !== 'requested') {
    throw new PairError(`There is no open pair request ${ref('p', pairId)} for you.`);
  }
  if (accept && session) await refuseIfBusy(db, session, pair.id);
  const updated = await db
    .updateTable('pairs')
    .set(
      accept
        ? {
            status: 'active',
            accepted_at: Date.now(),
            ...(session
              ? { session_b_id: session.id, project: pair.project ?? (session.project || null) }
              : {}),
          }
        : { status: 'declined', ended_at: Date.now(), ended_by: participantId },
    )
    .where('id', '=', pairId)
    .returningAll()
    .executeTakeFirstOrThrow();
  events.pairChanged(pairId);
  return updated;
}

/** The pair with this code (or a pair id such as p_3). */
async function pairByCode(db: Db, code: string): Promise<Pair | undefined> {
  const clean = code.trim().toLowerCase();
  const byRef = /^p_\d+$/.test(clean) ? Number(clean.slice(2)) : undefined;
  return db
    .selectFrom('pairs')
    .selectAll()
    .where((eb) => (byRef !== undefined ? eb('id', '=', byRef) : eb('code', '=', clean)))
    .executeTakeFirst();
}

/**
 * Join one of this person's agent sessions to their side of a pair, by the pair's code, replacing the agent there
 * (messages still waiting for the old one go to the new one). The person who asked can join at once; the person
 * asked, once they have accepted.
 */
export async function joinPair(db: Db, participantId: number, code: string, session: Session): Promise<Pair> {
  const pair = await pairByCode(db, code);
  const member = pair && (pair.requester_id === participantId || pair.partner_id === participantId);
  if (!pair || !member) {
    throw new PairError(`There is no pair "${code.trim()}" of yours. Check the code on the Pair41 page.`);
  }
  const mine = pair.requester_id === participantId;
  if (pair.status === 'requested' && !mine) {
    throw new PairError(`Accept the pair first, on the Pair41 page; then join with ${pair.code}.`);
  }
  if (pair.status !== 'active' && pair.status !== 'requested') {
    throw new PairError(`Pair ${pair.code} is ${pair.status}.`);
  }
  if (session.participant_id !== participantId)
    throw new PairError('Only your own agent can join your side.');
  const column = mine ? 'session_a_id' : 'session_b_id';
  if (pair[column] === session.id) return pair;
  await refuseIfBusy(db, session, pair.id);

  const previous = pair[column];
  const updated = await db
    .updateTable('pairs')
    .set({ [column]: session.id, project: pair.project ?? (session.project || null) })
    .where('id', '=', pair.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (previous !== null) {
    await db
      .updateTable('messages')
      .set({ recipient_session_id: session.id })
      .where('pair_id', '=', pair.id)
      .where('recipient_session_id', '=', previous)
      .execute();
  }
  events.pairChanged(pair.id);
  return updated;
}

/** Ends (or withdraws) the pair; `endedBy` is the person who did it, so the other one is told. */
export async function endPair(db: Db, pair: Pair, summary: string, endedBy: number): Promise<Pair> {
  const ended = await db
    .updateTable('pairs')
    .set({
      status: 'ended',
      ended_at: Date.now(),
      ended_by: endedBy,
      summary: summary.trim().slice(0, 4000) || null,
    })
    .where('id', '=', pair.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  events.pairChanged(pair.id);
  return ended;
}

/** Pair requests waiting for this person to accept. */
export async function pendingRequests(db: Db, participantId: number) {
  return db
    .selectFrom('pairs')
    .innerJoin('participants', 'participants.id', 'pairs.requester_id')
    .selectAll('pairs')
    .select('participants.name as requester')
    .where('pairs.status', '=', 'requested')
    .where('pairs.partner_id', '=', participantId)
    .orderBy('pairs.id')
    .execute();
}

/** Agreed pairs of this person in which a side still has no agent. */
export async function waitingPairs(db: Db, participantId: number) {
  return db
    .selectFrom('pairs')
    .selectAll()
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('requester_id', '=', participantId), eb('partner_id', '=', participantId)]))
    .where((eb) => eb.or([eb('session_a_id', 'is', null), eb('session_b_id', 'is', null)]))
    .orderBy('id')
    .execute();
}
