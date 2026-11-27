// Same-file warning (P1): when both people edit the same file during a pair, both are told once, through a system
// message to both sides (shown in full by the next hook, and in the pair room).
import type { Db } from '../store/db.ts';
import type { Pair, Session } from '../store/schema.ts';
import { feedText } from './sanitize.ts';
import { systemMessage } from './messages.ts';
import { partnerSessionId } from './pairs.ts';
import { viewSession } from './sessions.ts';

export async function sameFileWarnings(db: Db, session: Session, pair: Pair, files: string[]): Promise<void> {
  const partnerId = partnerSessionId(pair, session.id);
  for (const file of files) {
    const path = feedText(file);
    const partnerTouched = await db
      .selectFrom('activity')
      .select('id')
      .where('pair_id', '=', pair.id)
      .where('session_id', '=', partnerId)
      .where('kind', '=', 'file')
      .where('detail', '=', path)
      .executeTakeFirst();
    if (!partnerTouched) continue;
    const inserted = await db
      .insertInto('file_warnings')
      .values({ pair_id: pair.id, path, created_at: Date.now() })
      .onConflict((oc) => oc.columns(['pair_id', 'path']).doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) continue; // already warned for this file
    const [me, partner] = await Promise.all([viewSession(db, session.id), viewSession(db, partnerId)]);
    await systemMessage(
      db,
      pair.id,
      null,
      'same-file',
      `${partner.name} and ${me.name} both edited ${path} in this pair. Check with each other before going further, so one of you does not overwrite the other.`,
    );
  }
}
