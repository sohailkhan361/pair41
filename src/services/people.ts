// People, and whether each is online. Online is about the person, never a session: seen on the Pair41 page in the
// last 2 minutes, or their agent heard from in the last 5 minutes. Sessions are never listed.
import type { Db } from '../store/db.ts';

const MINUTE = 60_000;
export const WEB_ONLINE_MS = 2 * MINUTE;
export const AGENT_ONLINE_MS = 5 * MINUTE;

export interface Person {
  id: number;
  name: string;
  me: boolean;
  online: boolean;
  /** Epoch ms of the last time we saw them (page or agent), or null if never. */
  lastSeen: number | null;
  /** Their agent was heard from recently (shown as "agent running", never which session). */
  agentRunning: boolean;
}

/** Everyone, online first, then by name. */
export async function people(db: Db, viewerId: number, now = Date.now()): Promise<Person[]> {
  const rows = await db.selectFrom('participants').select(['id', 'name', 'last_web_at']).execute();
  const agents = await db
    .selectFrom('sessions')
    .select((eb) => ['participant_id', eb.fn.max<number>('last_seen_at').as('seen')])
    .groupBy('participant_id')
    .execute();
  const agentSeen = new Map(agents.map((a) => [a.participant_id, Number(a.seen)]));
  const list = rows.map((r) => {
    const agent = agentSeen.get(r.id) ?? null;
    const web = r.last_web_at;
    const agentRunning = agent !== null && now - agent < AGENT_ONLINE_MS;
    return {
      id: r.id,
      name: r.name,
      me: r.id === viewerId,
      online: (web !== null && now - web < WEB_ONLINE_MS) || agentRunning,
      lastSeen: Math.max(web ?? 0, agent ?? 0) || null,
      agentRunning,
    };
  });
  return list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** "just now", "4 min ago", "3 h ago", "2 days ago" or "never". */
export function ago(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
