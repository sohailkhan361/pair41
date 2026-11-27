// Analytics (docs/specs/analytics.md): counts and times only, never pair content. The rows are read with Kysely and
// the numbers computed here, which keeps the SQL the same on SQLite and Postgres.
import type { Db } from '../store/db.ts';

const DAY = 24 * 60 * 60_000;
/** Time saved is shown only once this many answered questions needed a person (docs/metrics.md). */
export const TIME_SAVED_MIN_SAMPLE = 5;

export type Window = '7d' | 'all';

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);
const seconds = (ms: number) => Math.round(ms / 1000);

function senderKind(
  m: { sender_kind: string; sender_session_id: number | null },
  agentOf: Map<number, string>,
) {
  if (m.sender_kind !== 'agent') return m.sender_kind; // human or system
  return agentOf.get(m.sender_session_id!) ?? 'other';
}

export async function analytics(db: Db, window: Window, project?: string) {
  const since = window === '7d' ? Date.now() - 7 * DAY : 0;

  let pairQuery = db.selectFrom('pairs').selectAll().where('created_at', '>=', since);
  if (project) pairQuery = pairQuery.where('project', '=', project);
  const pairs = await pairQuery.execute();
  const pairIds = pairs.map((p) => p.id);
  const inPairs = <T extends { pair_id: number }>(rows: T[]) =>
    rows.filter((r) => pairIds.includes(r.pair_id));

  const sessions = await db
    .selectFrom('sessions')
    .innerJoin('participants', 'participants.id', 'sessions.participant_id')
    .select(['sessions.id', 'sessions.agent_kind', 'participants.name'])
    .execute();
  const agentOf = new Map(sessions.map((s) => [s.id, s.agent_kind]));
  const personName = new Map(
    (await db.selectFrom('participants').select(['id', 'name']).execute()).map((r) => [r.id, r.name]),
  );

  const messages = inPairs(
    await db
      .selectFrom('messages')
      .select([
        'id',
        'pair_id',
        'kind',
        'sender_kind',
        'sender_session_id',
        'recipient_session_id',
        'reply_to',
        'state',
        'created_at',
        'answered_at',
        'approval',
      ])
      .where('created_at', '>=', since)
      .where('approval', 'in', ['none', 'approved'])
      .execute(),
  );
  const questions = messages.filter((m) => m.kind === 'question');
  const answers = messages.filter((m) => m.kind === 'answer');
  const pushed = new Set(
    (
      await db
        .selectFrom('delivery_attempts')
        .select('message_id')
        .where('route', '=', 'socket')
        .where('result', '=', 'written')
        .execute()
    ).map((a) => a.message_id),
  );

  const questionIds = new Set(questions.map((q) => q.id));
  const actions = (await db.selectFrom('message_actions').select(['message_id', 'action']).execute()).filter(
    (a) => questionIds.has(a.message_id),
  );
  const deferredOnce = new Set(actions.filter((a) => a.action === 'defer').map((a) => a.message_id));
  const actedOn = new Set(actions.map((a) => a.message_id));
  const stopHooked = new Set(
    (
      await db
        .selectFrom('delivery_attempts')
        .select('message_id')
        .where('route', '=', 'hook')
        .where('detail', '=', 'stop hook')
        .execute()
    )
      .map((a) => a.message_id)
      .filter((id) => questionIds.has(id)),
  );

  /** Answered questions with who answered, how long it took and whether a person had to step in. */
  const answered = questions
    .filter((q) => q.state === 'answered' && q.answered_at !== null)
    .map((q) => {
      const answer = answers.find((a) => a.reply_to === q.id);
      const answerer = answer?.sender_session_id ?? q.recipient_session_id;
      return {
        id: q.id,
        pair_id: q.pair_id,
        agent: answerer !== null ? (agentOf.get(answerer) ?? 'other') : 'other',
        ms: q.answered_at! - q.created_at,
        pushed: pushed.has(q.id),
        neededPerson: deferredOnce.has(q.id) || answer?.approval === 'approved',
      };
    });
  const alone = answered.filter((a) => !a.neededPerson);
  const withPerson = answered.filter((a) => a.neededPerson);
  const byAgent = (rows: typeof answered) => {
    const out: Record<string, number | null> = {};
    for (const agent of [...new Set(rows.map((r) => r.agent))].sort()) {
      out[agent] = seconds(median(rows.filter((r) => r.agent === agent).map((r) => r.ms))!);
    }
    return out;
  };
  const medianSeconds = (rows: typeof answered) => {
    const m = median(rows.map((r) => r.ms));
    return m === null ? null : seconds(m);
  };
  const open = questions.filter((q) => q.state === 'open');

  const ended = pairs.filter((p) => p.status === 'ended');
  const feedback = (
    await db
      .selectFrom('pair_feedback')
      .innerJoin('participants', 'participants.id', 'pair_feedback.participant_id')
      .select(['pair_feedback.pair_id', 'pair_feedback.helpful', 'pair_feedback.note', 'participants.name'])
      .execute()
  ).filter((f) => ended.some((p) => p.id === f.pair_id));
  const ratedPairs = ended.filter((p) => feedback.some((f) => f.pair_id === p.id));
  const helpfulPairs = ratedPairs.filter((p) => feedback.some((f) => f.pair_id === p.id && f.helpful === 1));

  const board = inPairs(await db.selectFrom('board_items').select(['pair_id', 'kind', 'version']).execute());
  const shared = board.filter((b) => b.kind === 'contract' || b.kind === 'decision');

  const clashes = inPairs(
    await db.selectFrom('file_warnings').select(['pair_id']).where('created_at', '>=', since).execute(),
  );
  const work = inPairs(
    await db
      .selectFrom('activity')
      .select(['pair_id', 'kind', 'detail'])
      .where('kind', 'in', ['commit', 'file'])
      .where('created_at', '>=', since)
      .execute(),
  );
  const approvalRows = inPairs(
    await db
      .selectFrom('messages')
      .select(['pair_id', 'approval'])
      .where('sender_kind', '=', 'agent')
      .where('approval', 'in', ['approved', 'rejected', 'pending'])
      .where('created_at', '>=', since)
      .execute(),
  );
  const approvalCount = (state: string) => approvalRows.filter((r) => r.approval === state).length;

  const accepted = pairs.filter((p) => p.accepted_at !== null);
  const pairsPerPerson = new Map<number, number>();
  for (const p of accepted) {
    for (const id of [p.requester_id, p.partner_id])
      pairsPerPerson.set(id, (pairsPerPerson.get(id) ?? 0) + 1);
  }
  const repeatPeople = [...pairsPerPerson.values()].filter((n) => n >= 2).length;

  const aloneMedian = median(alone.map((a) => a.ms));
  const personMedian = median(withPerson.map((a) => a.ms));
  const enough = withPerson.length >= TIME_SAVED_MIN_SAMPLE && aloneMedian !== null && personMedian !== null;
  const perQuestion = enough ? Math.max(0, personMedian - aloneMedian) : null;

  const count = (keys: string[]) => {
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = (out[key] ?? 0) + 1;
    return out;
  };
  const days = new Map<string, Record<string, number>>();
  for (const m of messages) {
    const day = new Date(m.created_at).toISOString().slice(0, 10);
    const kind = senderKind(m, agentOf);
    const row = days.get(day) ?? {};
    row[kind] = (row[kind] ?? 0) + 1;
    days.set(day, row);
  }

  const agentKinds = [...new Set(sessions.map((s) => s.agent_kind))].sort();
  const agents = agentKinds
    .map((agent) => {
      const sent = messages.filter(
        (m) => m.sender_kind === 'agent' && agentOf.get(m.sender_session_id!) === agent,
      );
      const received = questions.filter(
        (q) => q.recipient_session_id !== null && agentOf.get(q.recipient_session_id) === agent,
      );
      const mine = answered.filter((a) => a.agent === agent);
      return {
        agent,
        messages_sent: sent.length,
        questions_asked: sent.filter((m) => m.kind === 'question').length,
        answered: mine.length,
        deferred: received.filter((q) => q.state === 'deferred').length,
        median_seconds: medianSeconds(mine),
      };
    })
    .filter((a) => a.messages_sent || a.answered || a.deferred);

  const pushedRows = answered.filter((a) => a.pushed);
  const pushedMedian = medianSeconds(pushedRows);
  const notPushedMedian = medianSeconds(answered.filter((a) => !a.pushed));
  return {
    window,
    project: project ?? null,
    impact: {
      interruptions_avoided: alone.length,
      time_saved: {
        seconds: perQuestion === null ? null : seconds(perQuestion * alone.length),
        per_question_seconds: perQuestion === null ? null : seconds(perQuestion),
        agent_median_seconds: aloneMedian === null ? null : seconds(aloneMedian),
        person_median_seconds: personMedian === null ? null : seconds(personMedian),
        person_sample: withPerson.length,
        needed: TIME_SAVED_MIN_SAMPLE,
      },
      edit_clashes: clashes.length,
    },
    questions: {
      asked: questions.length,
      answered: answered.length,
      deferred: questions.filter((q) => q.state === 'deferred').length,
      open: open.length,
      answered_rate: ratio(answered.length, questions.length),
      responded: questions.filter((q) => q.state !== 'open' || actedOn.has(q.id)).length,
      responded_rate: ratio(
        questions.filter((q) => q.state !== 'open' || actedOn.has(q.id)).length,
        questions.length,
      ),
      oldest_open_seconds: open.length
        ? seconds(Date.now() - Math.min(...open.map((q) => q.created_at)))
        : null,
    },
    time_to_answer: {
      median_seconds: medianSeconds(answered),
      by_agent: byAgent(answered),
      ...(pushedRows.length
        ? {
            pushed: pushedMedian,
            not_pushed: notPushedMedian,
            bridge_speedup:
              pushedMedian && notPushedMedian !== null
                ? Math.round((notPushedMedian / pushedMedian) * 10) / 10
                : null,
          }
        : {}),
    },
    stop_hook: {
      raised: questions.filter((q) => stopHooked.has(q.id)).length,
      answered: answered.filter((a) => stopHooked.has(a.id)).length,
    },
    approvals: {
      approved: approvalCount('approved'),
      rejected: approvalCount('rejected'),
      pending: approvalCount('pending'),
      rate: ratio(approvalCount('approved'), approvalCount('approved') + approvalCount('rejected')),
    },
    work: {
      commits: work.filter((w) => w.kind === 'commit').length,
      files: new Set(work.filter((w) => w.kind === 'file').map((w) => `${w.pair_id}\0${w.detail}`)).size,
    },
    adoption: {
      people: pairsPerPerson.size,
      repeat: repeatPeople,
      repeat_rate: ratio(repeatPeople, pairsPerPerson.size),
    },
    helpful: {
      ended: ended.length,
      rated: ratedPairs.length,
      helpful: helpfulPairs.length,
      rate: ratio(helpfulPairs.length, ratedPairs.length),
      notes: feedback
        .filter((f) => f.note)
        .map((f) => ({ pair: f.pair_id, person: f.name, helpful: f.helpful === 1, note: f.note! })),
    },
    messages: {
      total: messages.length,
      by_agent: count(messages.map((m) => senderKind(m, agentOf))),
      by_kind: count(messages.map((m) => m.kind)),
      per_day: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, byAgent]) => ({ day, by_agent: byAgent })),
    },
    shared_context: {
      contracts: shared.filter((b) => b.kind === 'contract').length,
      decisions: shared.filter((b) => b.kind === 'decision').length,
      revisions: shared.reduce((sum, b) => sum + b.version, 0),
      changes: shared.reduce((sum, b) => sum + b.version - 1, 0),
    },
    agents,
    pairs: pairs.map((p) => {
      const pairQuestions = questions.filter((q) => q.pair_id === p.id);
      const pairAnswered = answered.filter((a) => a.pair_id === p.id);
      const rating = feedback.filter((f) => f.pair_id === p.id);
      const sides = [p.session_a_id, p.session_b_id].filter((id): id is number => id !== null);
      return {
        id: p.id,
        project: p.project,
        feature: p.feature,
        status: p.status,
        people: [personName.get(p.requester_id) ?? '?', personName.get(p.partner_id) ?? '?'],
        agents: sides.map((id) => agentOf.get(id) ?? '?'),
        minutes: p.accepted_at ? Math.round(((p.ended_at ?? Date.now()) - p.accepted_at) / 60_000) : null,
        messages: messages.filter((m) => m.pair_id === p.id).length,
        questions: pairQuestions.length,
        answered: pairAnswered.length,
        median_seconds: medianSeconds(pairAnswered),
        interruptions_avoided: pairAnswered.filter((a) => !a.neededPerson).length,
        edit_clashes: clashes.filter((c) => c.pair_id === p.id).length,
        contracts: board.filter((b) => b.pair_id === p.id && b.kind === 'contract').length,
        decisions: board.filter((b) => b.pair_id === p.id && b.kind === 'decision').length,
        ratings: rating.map((f) => ({ person: f.name, helpful: f.helpful === 1, note: f.note })),
      };
    }),
  };
}

/** One row per project, for the global page. */
export async function projectTable(db: Db, window: Window) {
  const names = (await db.selectFrom('pairs').select('project').distinct().execute())
    .map((r) => r.project)
    .filter((name): name is string => name !== null)
    .sort();
  const rows = [];
  for (const name of names) {
    const a = await analytics(db, window, name);
    if (!a.pairs.length) continue;
    rows.push({
      name,
      pairs: a.pairs.length,
      messages: a.messages.total,
      answered_rate: a.questions.answered_rate,
      interruptions_avoided: a.impact.interruptions_avoided,
      median_seconds: a.time_to_answer.median_seconds,
      helpful_rate: a.helpful.rate,
    });
  }
  return rows;
}
