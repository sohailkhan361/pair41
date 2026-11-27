// The schema, as Kysely migrations. Run by `pair41 migrate`, never at server start.
// Until the first deploy, migration 001 is edited in place. After that, add 002, 003, ...
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import type { Db } from './db.ts';

type Dialect = 'sqlite' | 'postgres';

function migrations(dialect: Dialect): Record<string, Migration> {
  // Ids: autoincrement integers. Times: epoch ms, which need 64 bits on Postgres.
  const time = dialect === 'postgres' ? 'bigint' : 'integer';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations work on a schema that is still being built
  const table = (db: Kysely<any>, name: string) => {
    const builder = db.schema.createTable(name);
    return dialect === 'postgres'
      ? builder.addColumn('id', 'serial', (c) => c.primaryKey())
      : builder.addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement());
  };

  return {
    '001_initial': {
      async up(db) {
        await table(db, 'participants')
          .addColumn('name', 'text', (c) => c.notNull().unique())
          .addColumn('password_hash', 'text', (c) => c.notNull())
          .addColumn('token_hash', 'text', (c) => c.notNull().unique())
          .addColumn('share_conversation', 'integer', (c) => c.notNull().defaultTo(1))
          .addColumn('approve_before_send', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('last_web_at', time)
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await table(db, 'web_sessions')
          .addColumn('participant_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('token_hash', 'text', (c) => c.notNull().unique())
          .addColumn('expires_at', time, (c) => c.notNull())
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await table(db, 'projects')
          .addColumn('name', 'text', (c) => c.notNull().unique())
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await table(db, 'sessions')
          .addColumn('participant_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('project', 'text', (c) => c.notNull())
          .addColumn('agent_kind', 'text', (c) => c.notNull())
          .addColumn('agent_session_id', 'text')
          .addColumn('model', 'text')
          .addColumn('cwd', 'text')
          .addColumn('state', 'text', (c) => c.notNull())
          .addColumn('bridge_connected', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('activity', 'text')
          .addColumn('started_at', time, (c) => c.notNull())
          .addColumn('ended_at', time)
          .addColumn('last_seen_at', time, (c) => c.notNull())
          .addColumn('turn_ended_at', time)
          .addColumn('msg_cursor', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('notified_upto', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('request_notified_upto', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('feed_seen_upto', 'integer', (c) => c.notNull().defaultTo(0))
          .addColumn('edits_since_progress', 'integer', (c) => c.notNull().defaultTo(0))
          .execute();
        await db.schema
          .createIndex('sessions_by_agent_session')
          .on('sessions')
          .columns(['participant_id', 'agent_session_id'])
          .execute();
        await table(db, 'pairs')
          .addColumn('code', 'text', (c) => c.notNull().unique())
          .addColumn('feature', 'text', (c) => c.notNull())
          .addColumn('requester_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('partner_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('session_a_id', 'integer', (c) => c.references('sessions.id'))
          .addColumn('session_b_id', 'integer', (c) => c.references('sessions.id'))
          .addColumn('project', 'text')
          .addColumn('status', 'text', (c) => c.notNull())
          .addColumn('created_at', time, (c) => c.notNull())
          .addColumn('accepted_at', time)
          .addColumn('ended_at', time)
          .addColumn('summary', 'text')
          .execute();
        await table(db, 'messages')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('sender_kind', 'text', (c) => c.notNull())
          .addColumn('sender_session_id', 'integer', (c) => c.references('sessions.id'))
          .addColumn('sender_participant_id', 'integer', (c) => c.references('participants.id'))
          .addColumn('recipient_session_id', 'integer', (c) => c.references('sessions.id'))
          .addColumn('kind', 'text', (c) => c.notNull())
          .addColumn('topic', 'text')
          .addColumn('body', 'text', (c) => c.notNull())
          .addColumn('reply_to', 'integer')
          .addColumn('state', 'text')
          .addColumn('state_reason', 'text')
          .addColumn('stop_raised_at', time)
          .addColumn('approval', 'text', (c) => c.notNull().defaultTo('none'))
          .addColumn('created_at', time, (c) => c.notNull())
          .addColumn('answered_at', time)
          .execute();
        await db.schema.createIndex('messages_by_pair').on('messages').columns(['pair_id', 'id']).execute();
        await table(db, 'delivery_attempts')
          .addColumn('message_id', 'integer', (c) => c.notNull().references('messages.id'))
          .addColumn('session_id', 'integer', (c) => c.notNull().references('sessions.id'))
          .addColumn('route', 'text', (c) => c.notNull())
          .addColumn('result', 'text', (c) => c.notNull())
          .addColumn('detail', 'text')
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await table(db, 'message_actions')
          .addColumn('message_id', 'integer', (c) => c.notNull().references('messages.id'))
          .addColumn('session_id', 'integer', (c) => c.notNull().references('sessions.id'))
          .addColumn('action', 'text', (c) => c.notNull())
          .addColumn('eta_minutes', 'integer')
          .addColumn('note', 'text')
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await table(db, 'board_items')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('author_session_id', 'integer', (c) => c.notNull().references('sessions.id'))
          .addColumn('kind', 'text', (c) => c.notNull())
          .addColumn('key', 'text', (c) => c.notNull())
          .addColumn('title', 'text', (c) => c.notNull())
          .addColumn('body', 'text', (c) => c.notNull())
          .addColumn('files', 'text')
          .addColumn('version', 'integer', (c) => c.notNull())
          .addColumn('created_at', time, (c) => c.notNull())
          .addColumn('updated_at', time, (c) => c.notNull())
          .addUniqueConstraint('board_items_pair_key', ['pair_id', 'key'])
          .execute();
        await table(db, 'activity')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('session_id', 'integer', (c) => c.notNull().references('sessions.id'))
          .addColumn('kind', 'text', (c) => c.notNull())
          .addColumn('detail', 'text', (c) => c.notNull())
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await table(db, 'pair_feedback')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('participant_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('helpful', 'integer', (c) => c.notNull())
          .addColumn('note', 'text')
          .addColumn('created_at', time, (c) => c.notNull())
          .addUniqueConstraint('pair_feedback_once', ['pair_id', 'participant_id'])
          .execute();
        await table(db, 'file_warnings')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('path', 'text', (c) => c.notNull())
          .addColumn('created_at', time, (c) => c.notNull())
          .addUniqueConstraint('file_warnings_once', ['pair_id', 'path'])
          .execute();
      },
    },
    // Needs you: who ended a pair, when each person last opened a pair's room, and nudges (docs/specs/web.md).
    '002_attention': {
      async up(db) {
        await db.schema
          .alterTable('pairs')
          .addColumn('ended_by', 'integer', (c) => c.references('participants.id'))
          .execute();
        await table(db, 'pair_views')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('participant_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('seen_at', time, (c) => c.notNull())
          .addUniqueConstraint('pair_views_once', ['pair_id', 'participant_id'])
          .execute();
        await table(db, 'nudges')
          .addColumn('pair_id', 'integer', (c) => c.notNull().references('pairs.id'))
          .addColumn('from_participant_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('to_participant_id', 'integer', (c) => c.notNull().references('participants.id'))
          .addColumn('created_at', time, (c) => c.notNull())
          .execute();
        await db.schema
          .createIndex('nudges_by_pair')
          .on('nudges')
          .columns(['pair_id', 'created_at'])
          .execute();
      },
    },
    // Wake (docs/specs/protocol.md, "Wake"): the newest message a session was woken for, and wakes since its human's
    // last prompt (the loop guard).
    '003_wake': {
      async up(db) {
        await db.schema
          .alterTable('sessions')
          .addColumn('woken_upto', 'integer', (c) => c.notNull().defaultTo(0))
          .execute();
        await db.schema
          .alterTable('sessions')
          .addColumn('wakes_since_prompt', 'integer', (c) => c.notNull().defaultTo(0))
          .execute();
      },
    },
  };
}

/** Applies every pending migration. `schema` (Postgres only) is created first if it does not exist. */
export async function migrateToLatest(db: Db, dialect: Dialect, schema?: string): Promise<string[]> {
  if (dialect === 'postgres' && schema) {
    await sql`create schema if not exists ${sql.id(schema)}`.execute(db);
  }
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations(dialect) },
    // Kysely looks for its own tables in every schema; name ours so it does not find another schema's.
    ...(schema ? { migrationTableSchema: schema } : {}),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
