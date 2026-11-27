// The partner feed: what each side asks, commits, changes and concludes, as short lines for the other side.
import type { Db } from '../store/db.ts';
import type { Activity, ActivityKind, Pair, Session } from '../store/schema.ts';
import { events } from './events.ts';
import { activePair, partnerSessionId } from './pairs.ts';
import { feedText } from './sanitize.ts';
import { agentLabel } from './sessions.ts';

/**
 * Adds a feed line for this session's active pair. Prompts and replies are only recorded when the person shares
 * their conversation. Text is secret-redacted, sanitised and trimmed before it is stored.
 */
export async function recordActivity(
  db: Db,
  session: Session,
  kind: ActivityKind,
  detail: string,
): Promise<void> {
  const pair = await activePair(db, session.id);
  if (!pair || !detail.trim()) return;
  if (kind === 'prompt' || kind === 'reply') {
    const person = await db
      .selectFrom('participants')
      .select('share_conversation')
      .where('id', '=', session.participant_id)
      .executeTakeFirstOrThrow();
    if (person.share_conversation !== 1) return;
  }
  await db
    .insertInto('activity')
    .values({
      pair_id: pair.id,
      session_id: session.id,
      kind,
      detail: feedText(detail),
      created_at: Date.now(),
    })
    .execute();
  events.pairChanged(pair.id);
}

export function feedLine(row: Activity, name: string, agentKind: string): string {
  const agent = agentLabel(agentKind);
  switch (row.kind) {
    case 'prompt':
      return `${name} asked ${agent}: "${row.detail}"`;
    case 'reply':
      return `${name}'s ${agent} concluded: "${row.detail}"`;
    case 'commit':
      return `${name}'s ${agent} committed ${row.detail}`;
    case 'file':
      return `${name}'s ${agent} changed ${row.detail}`;
    case 'board':
      return `${name}: ${row.detail}`;
    case 'activity':
      return `${name} is: ${row.detail}`;
  }
}

/** Feed rows for a pair, with names, leaving out prompts and replies of anyone not sharing right now. */
export async function pairFeed(
  db: Db,
  pairId: number,
  opts: { fromSession?: number; afterId?: number } = {},
) {
  let query = db
    .selectFrom('activity')
    .innerJoin('sessions', 'sessions.id', 'activity.session_id')
    .innerJoin('participants', 'participants.id', 'sessions.participant_id')
    .selectAll('activity')
    .select(['participants.name', 'participants.share_conversation', 'sessions.agent_kind'])
    .where('activity.pair_id', '=', pairId)
    .where((eb) =>
      eb.or([
        eb('activity.kind', 'not in', ['prompt', 'reply']),
        eb('participants.share_conversation', '=', 1),
      ]),
    );
  if (opts.fromSession !== undefined) query = query.where('activity.session_id', '=', opts.fromSession);
  if (opts.afterId !== undefined) query = query.where('activity.id', '>', opts.afterId);
  return query.orderBy('activity.id').execute();
}

/**
 * The partner's feed lines this session has not seen yet (at most `limit`, newest last), and marks them seen.
 */
export async function partnerDigest(db: Db, session: Session, pair: Pair, limit = 20): Promise<string[]> {
  const rows = await pairFeed(db, pair.id, {
    fromSession: partnerSessionId(pair, session.id),
    afterId: session.feed_seen_upto,
  });
  if (!rows.length) return [];
  await db
    .updateTable('sessions')
    .set({ feed_seen_upto: rows[rows.length - 1]!.id })
    .where('id', '=', session.id)
    .execute();
  const lines = rows.map((r) => feedLine(r, r.name, r.agent_kind));
  if (lines.length <= limit) return lines;
  return [`(${lines.length - limit} earlier lines not shown)`, ...lines.slice(-limit)];
}
