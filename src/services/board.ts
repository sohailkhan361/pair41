// The feature board: versioned items per pair. No silent overwrites.
import type { Db } from '../store/db.ts';
import type { BoardItem, BoardKind, Pair, Session } from '../store/schema.ts';
import { events } from './events.ts';
import { recordActivity } from './feed.ts';
import { systemMessage } from './messages.ts';
import { partnerSessionId } from './pairs.ts';
import { sanitize, storable } from './sanitize.ts';
import { viewSession } from './sessions.ts';

export interface BoardInput {
  kind: BoardKind;
  key: string;
  title: string;
  body: string;
  files?: string[];
  expectedVersion?: number;
}

export type BoardResult =
  | { status: 'saved'; key: string; version: number }
  | { status: 'conflict'; message: string; current: ReturnType<typeof formatItem> };

export function formatItem(item: BoardItem, authorName: string, mine: boolean) {
  return {
    kind: item.kind,
    key: item.key,
    title: mine ? item.title : sanitize(item.title, 200),
    body: mine ? item.body : sanitize(item.body, 8000),
    files: item.files ? (JSON.parse(item.files) as string[]) : [],
    version: item.version,
    author: authorName,
    updated_at: new Date(item.updated_at).toISOString(),
  };
}

export async function boardUpdate(
  db: Db,
  session: Session,
  pair: Pair,
  input: BoardInput,
): Promise<BoardResult> {
  const key = storable(input.key).trim().slice(0, 200);
  const now = Date.now();
  const existing = await db
    .selectFrom('board_items')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where('key', '=', key)
    .executeTakeFirst();
  const files = input.files?.length ? JSON.stringify(input.files.slice(0, 50)) : null;
  let version = 1;

  if (existing) {
    if (input.expectedVersion !== existing.version) {
      const author = await viewSession(db, existing.author_session_id);
      return {
        status: 'conflict',
        message: `"${key}" is at version ${existing.version}${input.expectedVersion === undefined ? '' : `, not ${input.expectedVersion}`}. Read the current text below, merge your change into it, and call board_update again with expected_version ${existing.version}.`,
        current: formatItem(existing, author.name, existing.author_session_id === session.id),
      };
    }
    version = existing.version + 1;
    const updated = await db
      .updateTable('board_items')
      .set({
        kind: input.kind,
        title: storable(input.title),
        body: storable(input.body),
        files,
        version,
        author_session_id: session.id,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .where('version', '=', existing.version)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) return boardUpdate(db, session, pair, input); // lost a race: report the conflict
  } else {
    await db
      .insertInto('board_items')
      .values({
        pair_id: pair.id,
        author_session_id: session.id,
        kind: input.kind,
        key,
        title: storable(input.title),
        body: storable(input.body),
        files,
        version,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  if (input.kind === 'progress') {
    await db.updateTable('sessions').set({ edits_since_progress: 0 }).where('id', '=', session.id).execute();
  }
  const me = await viewSession(db, session.id);
  const line = `${input.kind} "${key}" is now version ${version}: ${input.title}`;
  await systemMessage(
    db,
    pair.id,
    partnerSessionId(pair, session.id),
    input.kind === 'contract' ? 'contract' : 'board',
    `${me.name} changed the board: ${line}. Call board_read to see it.`,
  );
  await recordActivity(db, session, 'board', line);
  events.pairChanged(pair.id);
  return { status: 'saved', key, version };
}

export async function boardRead(
  db: Db,
  session: Session,
  pair: Pair,
  filter: { kind?: BoardKind; author?: 'me' | 'partner' },
) {
  let query = db.selectFrom('board_items').selectAll().where('pair_id', '=', pair.id);
  if (filter.kind) query = query.where('kind', '=', filter.kind);
  if (filter.author === 'me') query = query.where('author_session_id', '=', session.id);
  if (filter.author === 'partner') query = query.where('author_session_id', '!=', session.id);
  const items = await query.orderBy('kind').orderBy('key').execute();
  const names = new Map<number, string>();
  const out = [];
  for (const item of items) {
    if (!names.has(item.author_session_id)) {
      names.set(item.author_session_id, (await viewSession(db, item.author_session_id)).name);
    }
    out.push(formatItem(item, names.get(item.author_session_id)!, item.author_session_id === session.id));
  }
  return out;
}

/** Kind, key, title and version only, for briefings and pair_status. */
export async function boardSummary(db: Db, pair: Pair) {
  const items = await db
    .selectFrom('board_items')
    .select(['kind', 'key', 'title', 'version'])
    .where('pair_id', '=', pair.id)
    .orderBy('kind')
    .orderBy('key')
    .execute();
  return items.map((i) => ({ ...i, title: sanitize(i.title, 200) }));
}
