// PLAN.md §8.4 P0 #8: questions answered, time to answer and the helpful rate on one small fixture, which includes a
// deferred question and an unrated pair.
import { afterAll, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('computes the headline metrics from a small fixture', async () => {
  const amishToken = await server.addUser('amish');
  await server.addUser('sam');
  const { db } = server;
  const t0 = Date.now() - 60 * 60_000;
  const person = async (name: string) =>
    (await db.selectFrom('participants').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id;
  const [amish, sam] = [await person('amish'), await person('sam')];
  const session = async (participant: number, agent: string) =>
    (
      await db
        .insertInto('sessions')
        .values({
          participant_id: participant,
          project: 'todo-app',
          agent_kind: agent,
          agent_session_id: null,
          cwd: null,
          state: 'idle',
          started_at: t0,
          last_seen_at: t0,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const [claude, codex] = [await session(amish, 'claude-code'), await session(sam, 'codex')];
  const pair = async () =>
    (
      await db
        .insertInto('pairs')
        .values({
          code: `fixture-${Math.random().toString(36).slice(2)}`,
          project: 'todo-app',
          feature: 'Due dates',
          requester_id: amish,
          partner_id: sam,
          session_a_id: claude,
          session_b_id: codex,
          status: 'ended',
          created_at: t0,
          accepted_at: t0,
          ended_at: t0 + 30 * 60_000,
          summary: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const [rated, unrated, notHelpful] = [await pair(), await pair(), await pair()];
  const message = async (
    pairId: number,
    from: number,
    to: number,
    kind: 'question' | 'answer' | 'chat',
    at: number,
    extra: { state?: 'open' | 'answered' | 'deferred'; reply_to?: number; answered_at?: number } = {},
  ) =>
    (
      await db
        .insertInto('messages')
        .values({
          pair_id: pairId,
          sender_kind: 'agent',
          sender_session_id: from,
          sender_participant_id: from === claude ? amish : sam,
          recipient_session_id: to,
          kind,
          topic: null,
          body: 'fixture',
          reply_to: extra.reply_to ?? null,
          state: extra.state ?? null,
          created_at: at,
          answered_at: extra.answered_at ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  // Codex asks, Claude answers after 60 s. Claude asks, Codex answers after 180 s. One deferred, one still open.
  const q1 = await message(rated, codex, claude, 'question', t0, {
    state: 'answered',
    answered_at: t0 + 60_000,
  });
  await message(rated, claude, codex, 'answer', t0 + 60_000, { reply_to: q1 });
  const q2 = await message(rated, claude, codex, 'question', t0, {
    state: 'answered',
    answered_at: t0 + 180_000,
  });
  await message(rated, codex, claude, 'answer', t0 + 180_000, { reply_to: q2 });
  await message(unrated, codex, claude, 'question', t0, { state: 'deferred' });
  await message(notHelpful, claude, codex, 'question', t0, { state: 'open' });
  await message(notHelpful, claude, codex, 'chat', t0);

  const feedback = (pairId: number, participant: number, helpful: number, note: string | null) =>
    db
      .insertInto('pair_feedback')
      .values({ pair_id: pairId, participant_id: participant, helpful, note, created_at: t0 })
      .execute();
  await feedback(rated, amish, 1, 'Caught the cents question early');
  await feedback(rated, sam, 0, null);
  await feedback(notHelpful, amish, 0, 'Too chatty');
  await feedback(notHelpful, sam, 0, null);

  const res = await fetch(`${server.url}/api/analytics?window=all`, {
    headers: { Authorization: `Bearer ${amishToken}` },
  });
  expect(res.status).toBe(200);
  const metrics = await res.json();

  expect(metrics.questions).toMatchObject({
    asked: 4,
    answered: 2,
    deferred: 1,
    open: 1,
    answered_rate: 0.5,
  });
  expect(metrics.time_to_answer.median_seconds).toBe(120);
  expect(metrics.time_to_answer.by_agent).toEqual({ 'claude-code': 60, codex: 180 });
  expect(metrics.helpful).toMatchObject({ rated: 2, helpful: 1, rate: 0.5 });
  expect(metrics.helpful.notes.map((n: { note: string }) => n.note).sort()).toEqual([
    'Caught the cents question early',
    'Too chatty',
  ]);
});

it('computes the impact metrics from a small fixture', async () => {
  const token = await server.addUser('ivy');
  await server.addUser('raj');
  await server.addUser('lee');
  const { db } = server;
  const t0 = Date.now() - 2 * 60 * 60_000;
  const person = async (name: string) =>
    (await db.selectFrom('participants').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id;
  const [ivy, raj, lee] = [await person('ivy'), await person('raj'), await person('lee')];
  const session = async (participant: number, agent: string) =>
    (
      await db
        .insertInto('sessions')
        .values({
          participant_id: participant,
          project: 'impact-app',
          agent_kind: agent,
          agent_session_id: null,
          cwd: null,
          state: 'idle',
          started_at: t0,
          last_seen_at: t0,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const [ivyS, rajS, leeS] = [
    await session(ivy, 'claude-code'),
    await session(raj, 'codex'),
    await session(lee, 'codex'),
  ];
  const pair = async (a: number, b: number, sa: number, sb: number) =>
    (
      await db
        .insertInto('pairs')
        .values({
          code: `fixture-${Math.random().toString(36).slice(2)}`,
          project: 'impact-app',
          feature: 'Impact',
          requester_id: a,
          partner_id: b,
          session_a_id: sa,
          session_b_id: sb,
          status: 'ended',
          created_at: t0,
          accepted_at: t0,
          ended_at: t0 + 60 * 60_000,
          summary: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  // Three accepted pairs: ivy+raj twice, ivy+lee once. ivy and raj paired again, lee did not.
  const p = await pair(ivy, raj, ivyS, rajS);
  await pair(ivy, raj, ivyS, rajS);
  await pair(ivy, lee, ivyS, leeS);

  const msg = async (
    kind: 'question' | 'answer' | 'chat',
    from: number,
    at: number,
    extra: {
      state?: 'open' | 'answered' | 'deferred';
      reply_to?: number;
      answered_at?: number;
      approval?: 'none' | 'approved' | 'rejected';
    } = {},
  ) =>
    (
      await db
        .insertInto('messages')
        .values({
          pair_id: p,
          sender_kind: 'agent',
          sender_session_id: from,
          sender_participant_id: from === ivyS ? ivy : raj,
          recipient_session_id: from === ivyS ? rajS : ivyS,
          kind,
          topic: null,
          body: 'fixture',
          reply_to: extra.reply_to ?? null,
          state: extra.state ?? null,
          approval: extra.approval ?? 'none',
          created_at: at,
          answered_at: extra.answered_at ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const answeredQuestion = async (seconds: number, approval: 'none' | 'approved' = 'none') => {
    const q = await msg('question', rajS, t0, { state: 'answered', answered_at: t0 + seconds * 1000 });
    await msg('answer', ivyS, t0 + seconds * 1000, { reply_to: q, approval });
    return q;
  };
  const action = (messageId: number, kind: 'acknowledge' | 'defer') =>
    db
      .insertInto('message_actions')
      .values({
        message_id: messageId,
        session_id: ivyS,
        action: kind,
        eta_minutes: kind === 'acknowledge' ? 5 : null,
        note: null,
        created_at: t0,
      })
      .execute();
  const attempt = (
    messageId: number,
    route: 'hook' | 'socket',
    result: 'shown' | 'written',
    detail: string | null,
  ) =>
    db
      .insertInto('delivery_attempts')
      .values({ message_id: messageId, session_id: ivyS, route, result, detail, created_at: t0 })
      .execute();

  // Agents alone: 60 s (pushed by the bridge, raised by the Stop hook), 120 s, 180 s. Median 120 s.
  const fast = await answeredQuestion(60);
  await attempt(fast, 'socket', 'written', null);
  await attempt(fast, 'hook', 'shown', 'stop hook');
  await answeredQuestion(120);
  await answeredQuestion(180);
  // Needed a person: five deferred then answered after 1200 s, one answered after 600 s with an approved answer.
  for (let i = 0; i < 5; i++) await action(await answeredQuestion(1200), 'defer');
  await answeredQuestion(600, 'approved');
  // Still open: one raised by the Stop hook with no response, one acknowledged.
  await attempt(await msg('question', rajS, t0, { state: 'open' }), 'hook', 'shown', 'stop hook');
  await action(await msg('question', rajS, t0, { state: 'open' }), 'acknowledge');
  // Approve before send: one chat approved, one rejected (the approved answer above counts too).
  await msg('chat', ivyS, t0, { approval: 'approved' });
  await msg('chat', ivyS, t0, { approval: 'rejected' });

  for (const path of ['src/a.ts', 'src/b.ts']) {
    await db.insertInto('file_warnings').values({ pair_id: p, path, created_at: t0 }).execute();
  }
  for (const [kind, detail] of [
    ['commit', 'abc'],
    ['commit', 'def'],
    ['file', 'src/a.ts'],
    ['file', 'src/a.ts'],
    ['file', 'src/b.ts'],
  ] as const) {
    await db
      .insertInto('activity')
      .values({ pair_id: p, session_id: ivyS, kind, detail, created_at: t0 })
      .execute();
  }
  await db
    .insertInto('board_items')
    .values({
      pair_id: p,
      author_session_id: ivyS,
      kind: 'contract',
      key: 'api',
      title: 'API',
      body: 'fixture',
      files: null,
      version: 3,
      created_at: t0,
      updated_at: t0,
    })
    .execute();

  const res = await fetch(`${server.url}/api/analytics?window=all&project=impact-app`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const m = await res.json();

  expect(m.impact.interruptions_avoided).toBe(3);
  expect(m.impact.time_saved).toMatchObject({
    seconds: 3240,
    per_question_seconds: 1080,
    agent_median_seconds: 120,
    person_median_seconds: 1200,
    person_sample: 6,
  });
  expect(m.impact.edit_clashes).toBe(2);
  expect(m.questions.responded_rate).toBeCloseTo(10 / 11, 3);
  expect(m.time_to_answer.bridge_speedup).toBe(20);
  expect(m.stop_hook).toEqual({ raised: 2, answered: 1 });
  expect(m.approvals).toMatchObject({ approved: 2, rejected: 1, pending: 0, rate: 0.667 });
  expect(m.work).toEqual({ commits: 2, files: 2 });
  expect(m.adoption).toEqual({ people: 3, repeat: 2, repeat_rate: 0.667 });
  expect(m.shared_context.changes).toBe(2);
});

it('holds back time saved until enough questions needed a person', async () => {
  const token = await server.addUser('zoe');
  const res = await fetch(`${server.url}/api/analytics?window=all&project=todo-app`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const m = await res.json();
  expect(m.impact.time_saved).toMatchObject({ seconds: null, person_sample: 0, needed: 5 });
});
