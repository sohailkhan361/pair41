// Accounts: scrypt passwords, agent tokens (only their hash is stored) and web sessions.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from '../store/db.ts';
import type { Participant } from '../store/schema.ts';
import { PairError } from './errors.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const WEB_SESSION_MS = 7 * 24 * 60 * 60_000;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

function newAgentToken() {
  const token = `p41_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function normaliseName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(clean)) {
    throw new PairError('Usernames are 2–32 characters: letters, digits, - and _, starting with a letter');
  }
  return clean;
}

export async function createUser(db: Db, name: string, password: string) {
  const clean = normaliseName(name);
  if (password.length < 8) throw new PairError('Passwords need at least 8 characters');
  const existing = await db
    .selectFrom('participants')
    .select('id')
    .where('name', '=', clean)
    .executeTakeFirst();
  if (existing) throw new PairError(`The username "${clean}" is taken`);
  const { token, hash } = newAgentToken();
  const participant = await db
    .insertInto('participants')
    .values({
      name: clean,
      password_hash: await hashPassword(password),
      token_hash: hash,
      created_at: Date.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { participant, token };
}

export async function participantByToken(db: Db, token: string): Promise<Participant | undefined> {
  if (!token.startsWith('p41_')) return undefined;
  return db.selectFrom('participants').selectAll().where('token_hash', '=', sha256(token)).executeTakeFirst();
}

export async function participantByName(db: Db, name: string): Promise<Participant | undefined> {
  return db
    .selectFrom('participants')
    .selectAll()
    .where('name', '=', name.trim().toLowerCase())
    .executeTakeFirst();
}

/** A new agent token; the old one stops working at once. */
export async function regenerateToken(db: Db, participantId: number): Promise<string> {
  const { token, hash } = newAgentToken();
  await db.updateTable('participants').set({ token_hash: hash }).where('id', '=', participantId).execute();
  return token;
}

export async function checkLogin(db: Db, name: string, password: string): Promise<Participant | undefined> {
  const participant = await participantByName(db, name);
  if (!participant) {
    await hashPassword(password); // spend the same time whether or not the user exists
    return undefined;
  }
  return (await verifyPassword(password, participant.password_hash)) ? participant : undefined;
}

export async function createWebSession(db: Db, participantId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db
    .insertInto('web_sessions')
    .values({
      participant_id: participantId,
      token_hash: sha256(token),
      expires_at: now + WEB_SESSION_MS,
      created_at: now,
    })
    .execute();
  return token;
}

export async function participantByWebSession(db: Db, token: string): Promise<Participant | undefined> {
  const row = await db
    .selectFrom('web_sessions')
    .innerJoin('participants', 'participants.id', 'web_sessions.participant_id')
    .selectAll('participants')
    .where('web_sessions.token_hash', '=', sha256(token))
    .where('web_sessions.expires_at', '>', Date.now())
    .executeTakeFirst();
  if (row)
    await db.updateTable('participants').set({ last_web_at: Date.now() }).where('id', '=', row.id).execute();
  return row;
}

export async function endWebSession(db: Db, token: string): Promise<void> {
  await db.deleteFrom('web_sessions').where('token_hash', '=', sha256(token)).execute();
}
