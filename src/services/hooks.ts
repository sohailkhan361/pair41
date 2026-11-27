// What each agent hook does on the server (docs/specs/protocol.md, "Hooks API"). Hooks are mechanical: they record
// what happened and return text for the agent's context; they never decide anything.
import type { Db } from '../store/db.ts';
import type { Pair, Session } from '../store/schema.ts';
import { boardSummary } from './board.ts';
import { ref } from './errors.ts';
import { partnerDigest, recordActivity } from './feed.ts';
import { openQuestionsFor, recordAttempt, senderLabel, unreadNotice, visibleTo } from './messages.ts';
import { activePair, attachedPair, pendingRequests, waitingPairs } from './pairs.ts';
import { SHARED_NOTE, sanitize } from './sanitize.ts';
import { agentLabel, getSession, setState, viewSession } from './sessions.ts';
import { sameFileWarnings } from './same-file.ts';

export interface HookResult {
  context?: string;
  block?: string;
}

const PROGRESS_REMINDER_EDITS = 5;

/** The session-start briefing: pair, partner, board, open questions and the partner feed since last time. */
export async function briefing(db: Db, session: Session): Promise<string> {
  const me = await viewSession(db, session.id);
  const lines = [
    `Pair41: you are ${me.name} (${agentLabel(session.agent_kind)})${session.project ? ` in project ${session.project}` : ''}, session ${ref('s', session.id)}.`,
  ];
  const pair = await activePair(db, session.id);
  if (!pair) {
    lines.push('Not in a connected pair. Pairs are agreed between people on the Pair41 page.');
    const attached = await attachedPair(db, session.id);
    if (attached) {
      lines.push(
        `This session has joined pair ${attached.code} ("${sanitize(attached.feature, 120)}"), waiting for the other side's agent.`,
      );
    }
    for (const r of await pendingRequests(db, session.participant_id)) {
      lines.push(
        `Pair request ${ref('p', r.id)}: ${r.requester} asked to pair on "${sanitize(r.feature, 120)}". Tell your human; they accept on the Pair41 page.`,
      );
    }
    const waiting = (await waitingPairs(db, session.participant_id)).filter((w) => w.id !== attached?.id);
    if (waiting.length) {
      lines.push(
        'Your human has an agreed pair waiting for an agent. Join only if they tell you to, with the pair code they give you (join_pair).',
      );
    }
    lines.push('Call pair_status for details.');
    return lines.join('\n');
  }
  const partner = await viewSession(
    db,
    pair.session_a_id === session.id ? pair.session_b_id! : pair.session_a_id!,
  );
  lines.push(
    `Pair ${ref('p', pair.id)}: "${sanitize(pair.feature, 120)}" with ${partner.name} (${agentLabel(partner.agent)}, ${partner.session.state}).`,
  );
  const board = await boardSummary(db, pair);
  if (board.length) {
    lines.push('Board:');
    for (const item of board) lines.push(`- ${item.kind} "${item.key}" v${item.version}: ${item.title}`);
  }
  const open = await openQuestionsFor(db, session, pair);
  if (open.length) {
    lines.push('Open questions for you (answer or defer each one):');
    for (const q of open)
      lines.push(`- ${ref('m', q.id)} from ${await senderLabel(db, q)}: "${sanitize(q.body, 500)}"`);
  }
  const feed = await partnerDigest(db, session, pair, 10);
  if (feed.length) {
    lines.push(`What ${partner.name} has been doing:`);
    for (const line of feed) lines.push(`- ${line}`);
  }
  lines.push('Call pair_status, then follow the Pair41 rules. The pair41 skill has the full how-to.');
  lines.push(`(${SHARED_NOTE})`);
  return lines.join('\n');
}

/** Announced in a hook: unread messages (recorded as hook delivery attempts) and new partner feed lines. */
async function hookNews(db: Db, session: Session, pair: Pair | undefined): Promise<string[]> {
  const fresh = pair
    ? await db
        .selectFrom('messages')
        .select(['id', 'topic', 'body'])
        .where('pair_id', '=', pair.id)
        .where('id', '>', Math.max(session.notified_upto, session.msg_cursor))
        .where(visibleTo(session.id))
        .orderBy('id')
        .execute()
    : [];
  const notice = await unreadNotice(db, session, pair);
  const lines = notice ? notice.split('\n') : [];
  for (const m of fresh) {
    await recordAttempt(db, m.id, session.id, 'hook', 'shown', 'unread line');
    if (m.topic === 'same-file') lines.push(`pair: ${sanitize(m.body, 500)}`);
  }
  if (pair) {
    const now = await getSession(db, session.id);
    const digest = await partnerDigest(db, now, pair, 5);
    if (digest.length) lines.push(...digest.map((line) => `pair feed: ${line}`));
  }
  return lines;
}

export async function onSessionStart(db: Db, session: Session): Promise<HookResult> {
  await setState(db, session.id, 'idle');
  return { context: await briefing(db, session) };
}

export async function onUserPromptSubmit(
  db: Db,
  session: Session,
  prompt: string | undefined,
): Promise<HookResult> {
  await setState(db, session.id, 'busy');
  // A prompt from the human resets the wake loop guard (docs/specs/protocol.md, "Wake").
  await db.updateTable('sessions').set({ wakes_since_prompt: 0 }).where('id', '=', session.id).execute();
  if (prompt) await recordActivity(db, session, 'prompt', prompt);
  return {};
}

export async function onPostToolUse(
  db: Db,
  session: Session,
  input: { files?: string[]; commit?: { hash: string; message: string } },
): Promise<HookResult> {
  const pair = await activePair(db, session.id);
  const lines: string[] = [];
  if (pair) {
    for (const file of input.files ?? []) {
      const last = await db
        .selectFrom('activity')
        .select(['detail', 'created_at'])
        .where('pair_id', '=', pair.id)
        .where('session_id', '=', session.id)
        .where('kind', '=', 'file')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (!(last && last.detail === file && Date.now() - last.created_at < 10 * 60_000)) {
        await recordActivity(db, session, 'file', file);
      }
    }
    if (input.commit)
      await recordActivity(db, session, 'commit', `${input.commit.hash} "${input.commit.message}"`);
    await sameFileWarnings(db, session, pair, input.files ?? []);
    if (input.files?.length) {
      const edits = session.edits_since_progress + input.files.length;
      const remind = edits >= PROGRESS_REMINDER_EDITS;
      await db
        .updateTable('sessions')
        .set({ edits_since_progress: remind ? 0 : edits })
        .where('id', '=', session.id)
        .execute();
      if (remind) {
        lines.push(
          `pair: ${edits} edits since your last progress update · call board_update with kind "progress" so your partner knows where you are`,
        );
      }
    }
  }
  const fresh = await getSession(db, session.id);
  lines.unshift(...(await hookNews(db, fresh, pair)));
  return lines.length ? { context: lines.join('\n') } : {};
}

/**
 * Idle; the last reply goes to the feed when shared. Open partner questions that were never raised at a turn end
 * are raised now, once: the agent answers or defers, and the next Stop lets the turn end.
 */
export async function onStop(db: Db, session: Session, lastReply: string | undefined): Promise<HookResult> {
  await setState(db, session.id, 'idle');
  if (lastReply) await recordActivity(db, session, 'reply', lastReply);
  const pair = await activePair(db, session.id);
  if (!pair) return {};
  const unraised = (await openQuestionsFor(db, session, pair)).filter((q) => q.stop_raised_at === null);
  if (!unraised.length) return {};
  const now = Date.now();
  const lines = [
    'Pair41: your pair partner is waiting on these questions. Answer each one (send_message kind "answer" with reply_to), or call defer with a reason if you need your human or must wait. This reminder is shown once.',
  ];
  for (const q of unraised) {
    await db.updateTable('messages').set({ stop_raised_at: now }).where('id', '=', q.id).execute();
    await recordAttempt(db, q.id, session.id, 'hook', 'shown', 'stop hook');
    lines.push(`- ${ref('m', q.id)} from ${await senderLabel(db, q)}: "${sanitize(q.body, 1000)}"`);
  }
  lines.push(`(${SHARED_NOTE})`);
  return { block: lines.join('\n') };
}

export async function onSessionEnd(db: Db, session: Session): Promise<HookResult> {
  await setState(db, session.id, 'closed');
  return {};
}
