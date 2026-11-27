// What is waiting on you (docs/specs/web.md, "Needs you"): across your pairs, the things that are your turn
// (accept a request, approve a message, answer a deferred question, join or resume your agent, nudge it to read,
// news you have not seen: accepted, declined, ended, nudged), the things that are your agent's turn (an open question
// from your partner's agent, a file both agents edited) and the things waiting on your partner (an overdue question).
import type { Db } from '../store/db.ts';
import type { Pair, Participant } from '../store/schema.ts';
import { visibleTo } from './messages.ts';
import { pairState, sides, type PairState } from './room.ts';
import { nudgeOffer, overdueQuestions } from './nudges.ts';
import { presence } from './sessions.ts';

export type AttentionKind =
  | 'request'
  | 'approval'
  | 'deferred'
  | 'join'
  | 'resume'
  | 'unread'
  | 'question'
  | 'accepted'
  | 'declined'
  | 'ended'
  | 'nudge'
  | 'same-file'
  | 'overdue';

/** Accepted, declined and ended news is kept this long. */
const NEWS_MS = 7 * 24 * 60 * 60_000;

export interface Attention {
  key: string;
  kind: AttentionKind;
  /** you: a person must act. agent: your agent's turn. partner: waiting on your partner's side. */
  turn: 'you' | 'agent' | 'partner';
  pairId: number;
  feature: string;
  partner: string;
  title: string;
  detail?: string;
  /** Something to paste: a line for your agent, or a shell command. */
  command?: string;
  /** Offer the Nudge button on this item. */
  nudge?: boolean;
  /** Offer the Close button for this question (a message id). */
  closeQuestion?: number;
  href: string;
}

const snippet = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** When this person last opened the pair's room (0 if never). */
async function seenAt(db: Db, pairId: number, participantId: number): Promise<number> {
  const row = await db
    .selectFrom('pair_views')
    .select('seen_at')
    .where('pair_id', '=', pairId)
    .where('participant_id', '=', participantId)
    .executeTakeFirst();
  return row?.seen_at ?? 0;
}

/**
 * Everything waiting on this person in one pair. Requested and active pairs: what to do. Declined and ended pairs:
 * the news, until they open the room (or after a week).
 */
export async function pairAttention(
  db: Db,
  pair: Pair,
  viewer: Participant,
  now = Date.now(),
): Promise<Attention[]> {
  const { iAsked, mine, partnerName } = await sides(db, pair, viewer.id);
  const base = { pairId: pair.id, feature: pair.feature, partner: partnerName };
  const room = `/pairs/${pair.id}`;
  const items: Attention[] = [];
  const seen = await seenAt(db, pair.id, viewer.id);

  if (pair.status === 'declined' || pair.status === 'ended') {
    const at = pair.ended_at ?? 0;
    if (pair.ended_by === null || pair.ended_by === viewer.id || at <= seen || now - at > NEWS_MS)
      return items;
    if (pair.status === 'declined') {
      items.push({
        ...base,
        key: `declined-${pair.id}`,
        kind: 'declined',
        turn: 'you',
        title: `${partnerName} declined your pair request`,
        detail: 'You can ask again from their page.',
        href: room,
      });
    } else {
      // Ended before it was accepted: the requester withdrew it, or the person asked turned it down.
      const request = pair.accepted_at === null;
      items.push({
        ...base,
        key: `ended-${pair.id}`,
        kind: 'ended',
        turn: 'you',
        title: !request
          ? `${partnerName} ended the pair`
          : iAsked
            ? `${partnerName} turned down your pair request`
            : `${partnerName} withdrew their pair request`,
        ...(pair.summary && !request ? { detail: snippet(pair.summary) } : {}),
        href: room,
      });
    }
    return items;
  }

  if (pair.status === 'requested') {
    if (!iAsked) {
      items.push({
        ...base,
        key: `request-${pair.id}`,
        kind: 'request',
        turn: 'you',
        title: `${partnerName} asks you to pair`,
        href: room,
      });
    }
    return items;
  }

  const mySessions = db.selectFrom('sessions').select('id').where('participant_id', '=', viewer.id);
  const acceptedUnseen = iAsked && pair.accepted_at !== null && pair.accepted_at > seen;

  const nudged = await db
    .selectFrom('nudges')
    .select('created_at')
    .where('pair_id', '=', pair.id)
    .where('to_participant_id', '=', viewer.id)
    .where('created_at', '>', seen)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (nudged) {
    items.push({
      ...base,
      key: `nudge-${pair.id}-${nudged.created_at}`,
      kind: 'nudge',
      turn: 'you',
      title: `${partnerName} nudged you`,
      detail: mine
        ? 'They are waiting on your side. Check on your agent.'
        : 'They are waiting for your agent to join.',
      href: room,
    });
  }
  if (acceptedUnseen && mine) {
    items.push({
      ...base,
      key: `accepted-${pair.id}`,
      kind: 'accepted',
      turn: 'you',
      title: `${partnerName} accepted your pair request`,
      detail: 'Your agent is in. It starts talking once theirs joins.',
      href: room,
    });
  }

  const pending = await db
    .selectFrom('messages')
    .select(['id', 'body'])
    .where('pair_id', '=', pair.id)
    .where('approval', '=', 'pending')
    .where('sender_session_id', 'in', mySessions)
    .orderBy('id')
    .execute();
  if (pending.length) {
    items.push({
      ...base,
      key: `approval-${pair.id}`,
      kind: 'approval',
      turn: 'you',
      title:
        pending.length === 1
          ? 'A message from your agent waits for your approval'
          : `${pending.length} messages from your agent wait for your approval`,
      detail: snippet(pending[0]!.body),
      href: `${room}#thread`,
    });
  }

  const questions = await db
    .selectFrom('messages')
    .select(['id', 'body', 'state', 'state_reason'])
    .where('pair_id', '=', pair.id)
    .where('kind', '=', 'question')
    .where('state', 'in', ['open', 'deferred'])
    .where('recipient_session_id', 'in', mySessions)
    .orderBy('id')
    .execute();
  for (const q of questions.filter((q) => q.state === 'deferred')) {
    items.push({
      ...base,
      key: `deferred-${q.id}`,
      kind: 'deferred',
      turn: 'you',
      title: 'Your agent needs you to answer a question',
      detail: q.state_reason ? `${snippet(q.body, 100)} (${q.state_reason})` : snippet(q.body),
      closeQuestion: q.id,
      href: `${room}#questions`,
    });
  }

  if (!mine) {
    items.push({
      ...base,
      key: `join-${pair.id}`,
      kind: 'join',
      turn: 'you',
      title: acceptedUnseen
        ? `${partnerName} accepted: tell your agent to join`
        : 'Tell your agent to join the pair',
      detail: 'Claude Code, Codex, or any agent with Pair41 connected.',
      command: `join Pair41 pair ${pair.code}`,
      href: room,
    });
  } else {
    const running = presence(mine.session) !== 'offline';
    const id = mine.session.agent_session_id;
    if (!running) {
      const resume = id
        ? mine.agent === 'codex'
          ? `codex resume ${id}`
          : mine.agent === 'claude-code'
            ? `claude --resume ${id}`
            : undefined
        : undefined;
      items.push({
        ...base,
        key: `resume-${pair.id}`,
        kind: 'resume',
        turn: 'you',
        title: 'Your agent is not running',
        detail: resume
          ? 'Resume that same session to keep it in this pair. Partner messages wait for it.'
          : 'Start it again and tell it to join with the pair code. Partner messages wait for it.',
        command: resume ?? `join Pair41 pair ${pair.code}`,
        href: room,
      });
    } else if (pair.session_a_id !== null && pair.session_b_id !== null) {
      const counted = await db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('pair_id', '=', pair.id)
        .where('id', '>', mine.session.msg_cursor)
        .where(visibleTo(mine.session.id))
        .executeTakeFirstOrThrow();
      const unread = Number(counted.n);
      // With the bridge connected, partner messages are pushed into the session; nothing for you to do.
      if (unread > 0 && mine.session.bridge_connected !== 1) {
        items.push({
          ...base,
          key: `unread-${pair.id}`,
          kind: 'unread',
          turn: 'you',
          title: `Your agent has ${unread} unread message${unread === 1 ? '' : 's'}`,
          detail: 'Tell it to check the pair.',
          command: 'check pair',
          href: room,
        });
      }
    }
  }

  for (const q of questions.filter((q) => q.state === 'open')) {
    items.push({
      ...base,
      key: `question-${q.id}`,
      kind: 'question',
      turn: 'agent',
      title: `${partnerName}'s agent asked yours`,
      detail: snippet(q.body),
      href: `${room}#questions`,
    });
  }

  const files = await db
    .selectFrom('file_warnings')
    .select('path')
    .where('pair_id', '=', pair.id)
    .orderBy('id')
    .execute();
  if (files.length) {
    items.push({
      ...base,
      key: `same-file-${pair.id}-${files.length}`,
      kind: 'same-file',
      turn: 'agent',
      title:
        files.length === 1
          ? `Both agents edited ${files[0]!.path}`
          : `Both agents edited ${files.length} of the same files`,
      detail:
        files.length === 1
          ? 'Agree on the board who owns it, so one does not overwrite the other.'
          : `${snippet(files.map((f) => f.path).join(', '), 120)}. Agree on the board who owns each.`,
      href: `${room}#board`,
    });
  }

  if (pair.session_a_id !== null && pair.session_b_id !== null) {
    const overdue = await overdueQuestions(db, pair, viewer.id, now);
    if (overdue.length) {
      const q = overdue[0]!;
      const waited = Math.round(q.waited / 60_000);
      const offer = await nudgeOffer(db, pair, viewer, now);
      items.push({
        ...base,
        key: `overdue-${q.id}`,
        kind: 'overdue',
        turn: 'partner',
        title:
          q.eta !== undefined
            ? `${partnerName}'s agent said about ${q.eta} min, ${waited} min ago`
            : `${partnerName}'s agent has not answered for ${waited} min`,
        detail:
          overdue.length > 1 ? `${snippet(q.body, 100)} (and ${overdue.length - 1} more)` : snippet(q.body),
        nudge: offer.allowed,
        href: `${room}#questions`,
      });
    }
  }
  return items;
}

/**
 * Everything waiting on this person, across their open pairs and the pairs that ended or were declined this week:
 * their turn first, then their agent's, then their partner's.
 */
export async function needsYou(db: Db, viewer: Participant, now = Date.now()): Promise<Attention[]> {
  const pairs = await db
    .selectFrom('pairs')
    .selectAll()
    .where((eb) => eb.or([eb('requester_id', '=', viewer.id), eb('partner_id', '=', viewer.id)]))
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['requested', 'active']),
        eb.and([eb('status', 'in', ['declined', 'ended']), eb('ended_at', '>', now - NEWS_MS)]),
      ]),
    )
    .orderBy('id', 'desc')
    .execute();
  const all = (await Promise.all(pairs.map((p) => pairAttention(db, p, viewer, now)))).flat();
  return (['you', 'agent', 'partner'] as const).flatMap((turn) => all.filter((a) => a.turn === turn));
}

export type Tone = 'action' | 'live' | 'wait' | 'done';

/** The pair room's status strip: the state in words and whose turn it is. */
export function roomStatus(
  pair: Pair,
  partner: string,
  items: Attention[],
  them: { running?: boolean },
): { tone: Tone; label: string; title: string; detail: string } {
  const state: PairState = pairState(pair);
  const yours = items.filter((i) => i.turn === 'you');
  const agentTurn = items.filter((i) => i.kind === 'question');
  if (state === 'ended')
    return {
      tone: 'done',
      label: 'Ended',
      title: 'This pair has ended',
      detail: 'The thread, board and log stay here.',
    };
  if (state === 'declined')
    return {
      tone: 'done',
      label: 'Declined',
      title: 'This pair was declined',
      detail: 'Ask again from their page whenever you like.',
    };
  if (yours.length) {
    return {
      tone: 'action',
      label: state === 'connected' ? 'Live' : state === 'agreed' ? 'Agreed' : 'Asked',
      title: yours.length === 1 ? yours[0]!.title : `${yours.length} things need you`,
      detail: yours.length === 1 ? (yours[0]!.detail ?? '') : yours.map((i) => i.title).join(' · '),
    };
  }
  if (state === 'asked') {
    return {
      tone: 'wait',
      label: 'Asked',
      title: `Waiting for ${partner} to accept`,
      detail: 'You can join your agent now; it starts talking once theirs joins.',
    };
  }
  if (state === 'agreed') {
    return {
      tone: 'wait',
      label: 'Agreed',
      title: `Waiting for ${partner}'s agent to join`,
      detail: `Your agent is in. ${partner} tells theirs the pair code.`,
    };
  }
  if (!them.running) {
    return {
      tone: 'wait',
      label: 'Pair open',
      title: `${partner}'s agent is not running`,
      detail: 'Messages wait for it. Nothing needs you.',
    };
  }
  if (agentTurn.length) {
    return {
      tone: 'live',
      label: 'Live',
      title: 'Your agent has a question to answer',
      detail: 'Nothing needs you. It answers on its next turn.',
    };
  }
  return {
    tone: 'live',
    label: 'Live',
    title: 'All clear: the agents are pairing',
    detail: 'Nothing needs you right now.',
  };
}
