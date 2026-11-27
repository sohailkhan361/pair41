// Opens the configured Postgres or SQLite database.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import SqliteDatabase from 'better-sqlite3';
import pg from 'pg';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;

// Postgres returns bigint (int8) as a string; our numbers (times, counts) all fit in a JS number.
pg.types.setTypeParser(20, (value) => Number(value));

export function readDatabaseUrl(env: NodeJS.ProcessEnv, forMigrations = false): string {
  const url = (forMigrations ? env.PAIR41_MIGRATION_DATABASE_URL : undefined) ?? env.PAIR41_DATABASE_URL;
  if (url) return url;
  throw new Error(
    forMigrations
      ? 'Set PAIR41_MIGRATION_DATABASE_URL or PAIR41_DATABASE_URL before running migrations.'
      : 'Set PAIR41_DATABASE_URL to your Postgres connection URL.',
  );
}

export function dialectOf(url: string): 'sqlite' | 'postgres' {
  if (url.startsWith('sqlite:')) return 'sqlite';
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres';
  throw new Error(`PAIR41_DATABASE_URL must start with sqlite: or postgres://, got "${url.split(':')[0]}:"`);
}

/**
 * PAIR41_DATABASE_SSL=true: Postgres over TLS that checks the server's certificate and host name (libpq's
 * verify-full). Node trusts the RDS certificate authorities through NODE_EXTRA_CA_CERTS, which the image sets to the
 * bundle it ships (infra/rds-ca-bundle.pem). false or unset: the URL decides, so local Postgres needs nothing.
 */
export function readDatabaseSsl(env: NodeJS.ProcessEnv): boolean {
  const value = (env.PAIR41_DATABASE_SSL ?? '').trim().toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`PAIR41_DATABASE_SSL must be true or false, got "${env.PAIR41_DATABASE_SSL}"`);
}

/** A `schema=<name>` query parameter puts every table in that Postgres schema (tests use one per file). */
export function postgresSchema(url: string): string | undefined {
  return new URL(url).searchParams.get('schema') ?? undefined;
}

export function createDb(url: string, ssl = false): Db {
  if (dialectOf(url) === 'sqlite') {
    const path = url.slice('sqlite:'.length);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const sqlite = new SqliteDatabase(path);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('foreign_keys = ON');
    return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  }
  const parsed = new URL(url);
  const schema = parsed.searchParams.get('schema');
  if (schema && !/^[a-z0-9_]+$/.test(schema))
    throw new Error('schema must be lowercase letters, digits and _');
  parsed.searchParams.delete('schema');
  // pg lets the URL's ssl* parameters replace the ssl option, so with TLS on they go: sslmode=no-verify cannot turn
  // the certificate check off.
  if (ssl)
    for (const key of [...parsed.searchParams.keys()])
      if (key.startsWith('ssl')) parsed.searchParams.delete(key);
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    max: 10,
    ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
