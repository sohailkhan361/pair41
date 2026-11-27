// Agent sessions: registration, which session a call comes from (never guessed), state and presence.
import type { Db } from '../store/db.ts';
import type { Participant, Session, SessionState } from '../store/schema.ts';
import { PairError } from './errors.ts';

const MINUTE = 60_000;
/** A session with no hook or tool call for this long counts as closed. */
export const OPEN_WINDOW_MS = 60 * MINUTE;

export function isOpen(session: Session, now = Date.now()): boolean {
  return session.state !== 'closed' && now - session.last_seen_at < OPEN_WINDOW_MS;
}

export type Presence = 'active' | 'quiet' | 'away' | 'offline';

export function presence(session: Session, now = Date.now()): Presence {
  const idle = now - session.last_seen_at;
  if (session.state === 'closed' || idle >= OPEN_WINDOW_MS) return 'offline';
  if (idle < 2 * MINUTE) return 'active';
  if (idle < 15 * MINUTE) return 'quiet';
  return 'away';
}

export function agentLabel(kind: string): string {
  if (kind === 'claude-code') return 'Claude';
  if (kind === 'codex') return 'Codex';
  return kind;
}

export function cleanProject(project: string): string {
  const clean = project.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clean)) {
    throw new PairError('Project names are up to 64 characters: letters, digits, ., - and _');
  }
  return clean;
}

export interface Identity {
  agentKind: string;
  project?: string;
  agentSessionId?: string;
  cwd?: string;
  model?: string;
}

async function ensureProject(db: Db, name: string) {
  if (!name) return;
  const existing = await db.selectFrom('projects').select('id').where('name', '=', name).executeTakeFirst();
  if (!existing) {
    await db
      .insertInto('projects')
      .values({ name, created_at: Date.now() })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute();
  }
}

async function createSession(
  db: Db,
  participant: Participant,
  project: string,
  id: Identity,
): Promise<Session> {
  await ensureProject(db, project);
  const now = Date.now();
  return db
    .insertInto('sessions')
    .values({
      participant_id: participant.id,
      project,
      agent_kind: id.agentKind,
      agent_session_id: id.agentSessionId ?? null,
      model: id.model ?? null,
      cwd: id.cwd ?? null,
      state: 'idle',
      started_at: now,
      last_seen_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function byAgentSessionId(db: Db, participantId: number, agentSessionId: string) {
  return db
    .selectFrom('sessions')
    .selectAll()
    .where('participant_id', '=', participantId)
    .where('agent_session_id', '=', agentSessionId)
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

/** Marks the session as seen now; a closed session that is heard from again is reopened. */
async function touch(db: Db, session: Session, cwd?: string, model?: string): Promise<Session> {
  const reopen = session.state === 'closed';
  return db
    .updateTable('sessions')
    .set({
      last_seen_at: Date.now(),
      ...(reopen ? { state: 'idle' as const, ended_at: null } : {}),
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
    })
    .where('id', '=', session.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * The session a call comes from. With an agent session id it is that session (created if new). Without one it is
 * the only open session of this person, project and agent kind; if there are several, the call is refused.
 */
export async function resolveSession(db: Db, participant: Participant, id: Identity): Promise<Session> {
  const project = id.project ? cleanProject(id.project) : undefined;
  if (id.agentSessionId) {
    const existing = await byAgentSessionId(db, participant.id, id.agentSessionId);
    if (existing) {
      if (project && existing.project && existing.project !== project) {
        throw new PairError(
          `This session is registered for project ${existing.project}, but the call says ${project}. Check .pair41.json and the X-Pair-Project header.`,
        );
      }
      return touch(db, existing, id.cwd, id.model);
    }
    return createSession(db, participant, project ?? '', id);
  }

  // No session id: the only open session of this person and agent kind (in this project, when one is given).
  const now = Date.now();
  let query = db
    .selectFrom('sessions')
    .selectAll()
    .where('participant_id', '=', participant.id)
    .where('agent_kind', '=', id.agentKind)
    .where('state', '!=', 'closed')
    .where('last_seen_at', '>', now - OPEN_WINDOW_MS);
  if (project) query = query.where('project', '=', project);
  const open = await query.execute();
  if (open.length > 1) {
    throw new PairError(
      `two sessions are open for ${project ?? 'you'}; Pair41 cannot tell which one you are. Install the Pair41 hooks (the Pair41 plugin in Claude Code, or pair41 install), which tell Pair41 the session, or close the other session.`,
    );
  }
  if (open.length === 1) return touch(db, open[0]!, id.cwd, id.model);
  // An agent without the Pair41 hooks (any MCP client): a session of its own, with no project if none was given.
  return createSession(db, participant, project ?? '', id);
}

export async function setState(db: Db, sessionId: number, state: SessionState): Promise<void> {
  const now = Date.now();
  await db
    .updateTable('sessions')
    .set({
      state,
      last_seen_at: now,
      ...(state === 'idle' ? { turn_ended_at: now } : {}),
      ...(state === 'closed' ? { ended_at: now, bridge_connected: 0 } : {}),
    })
    .where('id', '=', sessionId)
    .execute();
}

export async function getSession(db: Db, sessionId: number): Promise<Session> {
  return db.selectFrom('sessions').selectAll().where('id', '=', sessionId).executeTakeFirstOrThrow();
}

export interface SessionView {
  session: Session;
  name: string;
  agent: string;
  humanOnline: boolean;
  shareConversation: boolean;
}

/** A session with its person's name, for labels and status. */
export async function viewSession(db: Db, sessionId: number): Promise<SessionView> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('participants', 'participants.id', 'sessions.participant_id')
    .selectAll('sessions')
    .select(['participants.name', 'participants.last_web_at', 'participants.share_conversation'])
    .where('sessions.id', '=', sessionId)
    .executeTakeFirstOrThrow();
  const { name, last_web_at, share_conversation, ...session } = row;
  return {
    session,
    name,
    agent: session.agent_kind,
    humanOnline: last_web_at !== null && Date.now() - last_web_at < 2 * MINUTE,
    shareConversation: share_conversation === 1,
  };
}
