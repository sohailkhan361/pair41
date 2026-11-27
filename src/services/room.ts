// Data for the web pages: home, a teammate's page, the pair room and its log. Pairs are between people; only a
// pair's two people can see it. Agent sessions are never listed: a pair shows only the agent each person attached.
import type { Db } from '../store/db.ts';
import type { Pair, Participant } from '../store/schema.ts';
import { ref } from './errors.ts';
import { feedLine, pairFeed } from './feed.ts';
import { senderLabel, visibleTo } from './messages.ts';
import { pendingRequests } from './pairs.ts';
import { ago, people } from './people.ts';
import { agentLabel, presence, viewSession, type SessionView } from './sessions.ts';

const CHANGED_MS = 10 * 60_000;
const FLOW_MS = 10 * 60_000;

/** The pair, if this person is one of its two people; otherwise undefined (shown as 404). */
export async function pairForViewer(
  db: Db,
  pairId: number,
  participantId: number,
): Promise<Pair | undefined> {
  const pair = await db.selectFrom('pairs').selectAll().where('id', '=', pairId).executeTakeFirst();
  return pair && (pair.requester_id === participantId || pair.partner_id === participantId)
    ? pair
    : undefined;
}

/** asked → agreed (both people said yes) → connected (both agents attached); or ended, declined. */
export type PairState = 'asked' | 'agreed' | 'connected' | 'ended' | 'declined';

export function pairState(pair: Pair): PairState {
  if (pair.status === 'requested') return 'asked';
  if (pair.status === 'active') {
    return pair.session_a_id !== null && pair.session_b_id !== null ? 'connected' : 'agreed';
  }
  return pair.status;
}

/** The viewer's side and the other side: each person's name and the agent they attached, if any. */
export async function sides(db: Db, pair: Pair, participantId: number) {
  const iAsked = pair.requester_id === participantId;
  const view = async (id: number | null) => (id === null ? undefined : viewSession(db, id));
  const [a, b] = [await view(pair.session_a_id), await view(pair.session_b_id)];
  const names = await db
    .selectFrom('participants')
    .select(['id', 'name'])
    .where('id', 'in', [pair.requester_id, pair.partner_id])
    .execute();
  const nameOf = (id: number) => names.find((n) => n.id === id)?.name ?? '?';
  return {
    iAsked,
    mine: iAsked ? a : b,
    partner: iAsked ? b : a,
    myName: nameOf(participantId),
    partnerName: nameOf(iAsked ? pair.partner_id : pair.requester_id),
  };
}

/** How a person tells their sessions apart: the agent's own session id (first 8 characters) and its start time. */
function sessionTag(s: { id: number; agent_session_id: string | null; started_at: number }): string {
  const started = new Date(s.started_at).toISOString().slice(11, 16);
  return `${s.agent_session_id ? s.agent_session_id.slice(0, 8) : ref('s', s.id)}, started ${started} UTC`;
}

/** "42 s", "3 min" or "2 h 5 min". */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 120 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** An ISO time; the page shows it in the viewer's own time zone. */
function time(ms: number): string {
  return new Date(ms).toISOString();
}

export async function roomData(db: Db, pair: Pair, viewer: Participant) {
  const { mine, partner, myName, partnerName, iAsked } = await sides(db, pair, viewer.id);
  const now = Date.now();
  // Every agent of the viewer's, so messages from an agent they later replaced still count as theirs.
  const mySessions = new Set(
    (await db.selectFrom('sessions').select('id').where('participant_id', '=', viewer.id).execute()).map(
      (r) => r.id,
    ),
  );

  const rows = await db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where((eb) =>
      eb.or([eb('approval', 'in', ['none', 'approved']), eb('sender_participant_id', '=', viewer.id)]),
    )
    .orderBy('id')
    .execute();
  const attempts = rows.length
    ? await db
        .selectFrom('delivery_attempts')
        .selectAll()
        .where(
          'message_id',
          'in',
          rows.map((r) => r.id),
        )
        .orderBy('id')
        .execute()
    : [];
  const actions = rows.length
    ? await db
        .selectFrom('message_actions')
        .selectAll()
        .where(
          'message_id',
          'in',
          rows.map((r) => r.id),
        )
        .orderBy('id')
        .execute()
    : [];
  const routeLabel = {
    tool: 'returned by a Pair41 tool',
    hook: 'shown by a hook',
    socket: 'pushed by the bridge',
    wake: 'woke the idle agent',
  };
  // Who did what, from the viewer's side: "Your Codex", "sam's Claude", "You", "sam".
  const views = new Map<number, SessionView>();
  const agentWho = async (sessionId: number, mine: boolean) => {
    const v = views.get(sessionId) ?? (await viewSession(db, sessionId));
    views.set(sessionId, v);
    return `${mine ? 'Your' : `${v.name}'s`} ${agentLabel(v.agent)}`;
  };
  const bodyOf = new Map(rows.map((r) => [r.id, r.body]));
  const snippet = (text: string | undefined) =>
    text === undefined ? undefined : text.length > 110 ? `${text.slice(0, 107).trimEnd()}...` : text;
  const messages = [];
  for (const m of rows) {
    const answeredAt = actions.find((x) => x.message_id === m.id && x.action === 'answer')?.created_at;
    const trail: { text: string; at: string; after?: string }[] = [
      { text: 'stored', at: time(m.created_at) },
    ];
    for (const a of attempts.filter((x) => x.message_id === m.id)) {
      trail.push({
        text: a.result === 'error' ? 'push failed' : routeLabel[a.route],
        at: time(a.created_at),
      });
    }
    for (const a of actions.filter((x) => x.message_id === m.id)) {
      if (a.action === 'acknowledge') {
        trail.push({ text: 'acknowledged', at: time(a.created_at), after: `, about ${a.eta_minutes} min` });
      }
      if (a.action === 'answer') trail.push({ text: 'answered', at: time(a.created_at) });
      if (a.action === 'defer')
        trail.push({ text: 'deferred', at: time(a.created_at), after: `: ${a.note ?? ''}` });
    }
    const fromMe =
      m.sender_session_id !== null
        ? mySessions.has(m.sender_session_id)
        : m.sender_participant_id === viewer.id;
    messages.push({
      id: ref('m', m.id),
      rawId: m.id,
      from: await senderLabel(db, m),
      who:
        m.sender_kind === 'system'
          ? 'Pair41'
          : m.sender_kind === 'human'
            ? fromMe
              ? 'You'
              : partnerName
            : await agentWho(m.sender_session_id!, fromMe),
      fromMe,
      human: m.sender_kind === 'human',
      system: m.sender_kind === 'system',
      at: time(m.created_at),
      answeredIn: m.kind === 'question' && answeredAt ? duration(answeredAt - m.created_at) : undefined,
      kind: m.kind,
      body: m.body,
      state: m.state,
      reason: m.state_reason,
      replyTo: m.reply_to ? ref('m', m.reply_to) : undefined,
      replyToText: m.reply_to ? snippet(bodyOf.get(m.reply_to)) : undefined,
      openFor: duration(now - m.created_at),
      pending: m.approval === 'pending',
      trail,
    });
  }
  const openQuestions = messages.filter(
    (m) => m.kind === 'question' && (m.state === 'open' || m.state === 'deferred'),
  );

  const items = await db
    .selectFrom('board_items')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .orderBy('kind')
    .execute();
  const board = [];
  for (const item of items) {
    board.push({
      kind: item.kind,
      key: item.key,
      title: item.title,
      body: item.body,
      version: item.version,
      author: (await viewSession(db, item.author_session_id)).name,
      changed: now - item.updated_at < CHANGED_MS,
      updated: time(item.updated_at),
    });
  }

  const feedRows = await pairFeed(db, pair.id);
  const feed = feedRows.map((r) => ({
    line: feedLine(r, r.name, r.agent_kind),
    at: time(r.created_at),
  }));

  // The conversation log: messages and feed rows in one timeline. Board changes already arrive as system
  // messages, so the feed's own board rows are left out.
  type RallyItem = {
    key: string;
    side: 'mine' | 'partner' | 'net';
    type: string;
    who: string;
    body: string;
    at: string;
    ms: number;
    agent?: string;
    message?: (typeof messages)[number];
    /** "9 min later" (or "earlier", newest first) when this came a while from the item above it. */
    gapBefore?: string;
    /** Set on the first item of each day (UTC), for a day divider. */
    dayBefore?: string;
  };
  const sideOf = (sessionId: number | null, fromMe: boolean): RallyItem['side'] =>
    fromMe || (sessionId !== null && mySessions.has(sessionId)) ? 'mine' : 'partner';
  const timeline: RallyItem[] = [
    ...messages.map((m, i) => ({
      key: m.id,
      side: m.system ? ('net' as const) : sideOf(null, m.fromMe),
      type: 'message',
      who: m.from,
      // Board changes read "amish changed the board: ..."; from your own side that is "You changed the board: ...".
      body: m.system && m.body.startsWith(`${myName} `) ? `You ${m.body.slice(myName.length + 1)}` : m.body,
      at: m.at,
      ms: rows[i]!.created_at,
      message: m,
    })),
    ...feedRows
      .filter((r) => r.kind !== 'board')
      .map((r) => ({
        key: `a_${r.id}`,
        side: sideOf(r.session_id, false),
        type: r.kind,
        who: mySessions.has(r.session_id)
          ? r.kind === 'prompt'
            ? 'You'
            : `Your ${agentLabel(r.agent_kind)}`
          : r.kind === 'prompt'
            ? r.name
            : `${r.name}'s ${agentLabel(r.agent_kind)}`,
        agent: agentLabel(r.agent_kind),
        body: r.detail,
        at: time(r.created_at),
        ms: r.created_at,
      })),
  ].sort((a, b) => a.ms - b.ms);
  // A day divider before the first item of each day, and "9 min later" before an item that came a while after the
  // one above it. Newest first, the gap reads "9 min earlier" instead.
  const marked = (list: RallyItem[]): RallyItem[] =>
    list.map((item, i) => {
      const prev = list[i - 1];
      if (!prev || prev.at.slice(0, 10) !== item.at.slice(0, 10)) return { ...item, dayBefore: item.at };
      const gap = Math.abs(item.ms - prev.ms);
      return gap >= 2 * 60_000
        ? { ...item, gapBefore: `${duration(gap)} ${item.ms >= prev.ms ? 'later' : 'earlier'}` }
        : item;
    });
  // The room's thread, like the log page, shows the newest first.
  const thread = marked(timeline.filter((t) => t.type === 'message').reverse());
  const activity = timeline.filter((t) => t.type !== 'message' && t.side !== 'net');

  const questions = messages.filter((m) => m.kind === 'question');
  const contract = items.filter((i) => i.kind === 'contract').sort((a, b) => b.updated_at - a.updated_at)[0];
  const stats = {
    passes: messages.filter((m) => !m.system).length,
    asked: questions.length,
    answered: questions.filter((q) => q.state === 'answered').length,
    contract: contract ? { key: contract.key, version: contract.version } : undefined,
  };

  let unread = 0;
  if (mine && pair.status === 'active') {
    const counted = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('pair_id', '=', pair.id)
      .where('id', '>', mine.session.msg_cursor)
      .where(visibleTo(mine.session.id))
      .executeTakeFirstOrThrow();
    unread = Number(counted.n);
  }
  const feedback = await db
    .selectFrom('pair_feedback')
    .selectAll()
    .where('pair_id', '=', pair.id)
    .where('participant_id', '=', viewer.id)
    .executeTakeFirst();

  const describe = (side: SessionView | undefined, name: string, isMine: boolean) => {
    if (!side) return { name, attached: false as const };
    const agent = side.agent;
    return {
      name,
      attached: true as const,
      agent: agentLabel(agent),
      state: side.session.state,
      status: presence(side.session),
      activity: side.session.activity,
      model: side.session.model,
      tag: sessionTag(side.session),
      sharing: side.shareConversation,
      // Whether the agent is running, as far as Pair41 can tell, and when it was last heard from.
      running: presence(side.session) !== 'offline',
      working: side.session.state === 'busy',
      seenAgo: duration(now - side.session.last_seen_at),
      // Only for the viewer's own side: how to resume that session and stay in this pair.
      resume:
        isMine && side.session.agent_session_id
          ? agent === 'codex'
            ? `codex resume ${side.session.agent_session_id}`
            : agent === 'claude-code'
              ? `claude --resume ${side.session.agent_session_id}`
              : undefined
          : undefined,
    };
  };
  const state = pairState(pair);
  const me = describe(mine, myName, true);
  const them = describe(partner, partnerName, false);
  // For the live view: the two agents and the last messages as events travelling between them.
  const sim = {
    state,
    me: {
      name: myName,
      agent: me.attached ? me.agent : null,
      working: me.attached && me.working,
      running: me.attached && me.running,
    },
    partner: {
      name: partnerName,
      agent: them.attached ? them.agent : null,
      working: them.attached && them.working,
      running: them.attached && them.running,
    },
    events: messages.slice(-30).map((m) => ({
      id: m.id,
      from: m.system ? 'net' : m.fromMe ? 'me' : 'partner',
      kind: m.system ? 'board' : m.kind,
    })),
  };

  return {
    pair: {
      id: pair.id,
      ref: ref('p', pair.id),
      code: pair.code,
      feature: pair.feature,
      project: pair.project,
      status: pair.status,
      state,
      iAsked,
      // You can join your agent once the pair is yours to join: at once if you asked, after accepting otherwise.
      canJoin: pair.status === 'active' || (pair.status === 'requested' && iAsked),
      created: time(pair.created_at),
    },
    me,
    partner: them,
    sim,
    sharing: viewer.share_conversation === 1,
    messages,
    openQuestions,
    board,
    feed,
    timeline: marked(timeline),
    // The log page shows the newest first; the markdown download keeps `timeline` in order.
    log: marked([...timeline].reverse()),
    thread,
    activity,
    stats,
    unread,
    feedback,
  };
}

/** Messages per pair (all time, and in the last 10 minutes for the live views' flow). */
async function messageCounts(db: Db, pairIds: number[], now: number) {
  if (!pairIds.length) return new Map<number, { total: number; recent: number; last: number }>();
  const rows = await db
    .selectFrom('messages')
    .select(['pair_id', 'created_at', 'sender_kind'])
    .where('pair_id', 'in', pairIds)
    .where('approval', 'in', ['none', 'approved'])
    .execute();
  const counts = new Map<number, { total: number; recent: number; last: number }>();
  for (const r of rows) {
    if (r.sender_kind === 'system') continue;
    const c = counts.get(r.pair_id) ?? { total: 0, recent: 0, last: 0 };
    c.total += 1;
    if (now - r.created_at < FLOW_MS) c.recent += 1;
    c.last = Math.max(c.last, r.created_at);
    counts.set(r.pair_id, c);
  }
  return counts;
}

/** A pair as a line on home or a teammate's page, from the viewer's point of view. */
async function pairLine(
  db: Db,
  pair: Pair,
  viewerId: number,
  names: Map<number, string>,
  counts: Awaited<ReturnType<typeof messageCounts>>,
) {
  const iAsked = pair.requester_id === viewerId;
  const myAgent = iAsked ? pair.session_a_id : pair.session_b_id;
  const theirAgent = iAsked ? pair.session_b_id : pair.session_a_id;
  const agentName = async (id: number | null) =>
    id === null ? null : agentLabel((await viewSession(db, id)).agent);
  const c = counts.get(pair.id) ?? { total: 0, recent: 0, last: 0 };
  return {
    id: pair.id,
    ref: ref('p', pair.id),
    code: pair.code,
    feature: pair.feature,
    project: pair.project,
    state: pairState(pair),
    iAsked,
    with: names.get(iAsked ? pair.partner_id : pair.requester_id) ?? '?',
    myAgent: await agentName(myAgent),
    theirAgent: await agentName(theirAgent),
    messages: c.total,
    recent: c.recent,
    date: time(pair.created_at),
    length:
      pair.accepted_at !== null ? duration((pair.ended_at ?? Date.now()) - pair.accepted_at) : undefined,
  };
}

/**
 * Home: your current pairs first, requests made to you, then your teammates (people, online first). The live view
 * draws you in the middle, teammates around you, and a bond to each person you have an open pair with.
 */
export async function homeData(db: Db, viewer: Participant) {
  const now = Date.now();
  const everyone = await people(db, viewer.id, now);
  const names = new Map(everyone.map((p) => [p.id, p.name]));
  const mine = await db
    .selectFrom('pairs')
    .selectAll()
    .where((eb) => eb.or([eb('requester_id', '=', viewer.id), eb('partner_id', '=', viewer.id)]))
    .orderBy('id', 'desc')
    .execute();
  const open = mine.filter((p) => p.status === 'active' || p.status === 'requested');
  const counts = await messageCounts(
    db,
    open.map((p) => p.id),
    now,
  );
  const lines = await Promise.all(open.map((p) => pairLine(db, p, viewer.id, names, counts)));
  const incoming = (await pendingRequests(db, viewer.id)).map((r) => ({
    id: r.id,
    ref: ref('p', r.id),
    from: r.requester,
    feature: r.feature,
  }));
  const current = lines.filter((l) => !(l.state === 'asked' && !l.iAsked));
  const history = new Map<string, number>();
  for (const p of mine) {
    const other = names.get(p.requester_id === viewer.id ? p.partner_id : p.requester_id) ?? '?';
    history.set(other, (history.get(other) ?? 0) + 1);
  }
  const teammates = everyone
    .filter((p) => !p.me)
    .map((p) => {
      const pair = lines.find((l) => l.with === p.name);
      return {
        name: p.name,
        online: p.online,
        agentRunning: p.agentRunning,
        seen: ago(p.lastSeen, now),
        pair,
        pairs: history.get(p.name) ?? 0,
      };
    });
  const hasAgent = Boolean(
    await db.selectFrom('sessions').select('id').where('participant_id', '=', viewer.id).executeTakeFirst(),
  );
  return {
    current,
    incoming,
    teammates,
    hasAgent,
    sim: {
      me: viewer.name,
      people: teammates.map((t) => ({
        name: t.name,
        online: t.online,
        bond: t.pair ? t.pair.state : null,
        flow: t.pair ? t.pair.recent : 0,
      })),
    },
  };
}

/** A teammate's page: who they are, any open pair with them, and every pair you two had, newest first. */
export async function personData(db: Db, viewer: Participant, name: string) {
  const now = Date.now();
  const everyone = await people(db, viewer.id, now);
  const person = everyone.find((p) => p.name === name && !p.me);
  if (!person) return undefined;
  const names = new Map(everyone.map((p) => [p.id, p.name]));
  const together = await db
    .selectFrom('pairs')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb.and([eb('requester_id', '=', viewer.id), eb('partner_id', '=', person.id)]),
        eb.and([eb('requester_id', '=', person.id), eb('partner_id', '=', viewer.id)]),
      ]),
    )
    .orderBy('id', 'desc')
    .execute();
  const counts = await messageCounts(
    db,
    together.map((p) => p.id),
    now,
  );
  const lines = await Promise.all(together.map((p) => pairLine(db, p, viewer.id, names, counts)));
  const open = lines.find((l) => l.state === 'asked' || l.state === 'agreed' || l.state === 'connected');
  return {
    person: {
      name: person.name,
      online: person.online,
      agentRunning: person.agentRunning,
      seen: ago(person.lastSeen, now),
    },
    open,
    history: lines.filter((l) => l !== open),
    // The two of you as two particles: bonded while a pair is connected, a dashed line while one is asked or agreed.
    sim: {
      state: open ? open.state : 'none',
      me: { agent: 'you', caption: 'you', running: true, working: false },
      partner: {
        agent: person.name,
        caption: person.name,
        running: person.online,
        working: person.agentRunning,
      },
      events: [],
    },
  };
}
