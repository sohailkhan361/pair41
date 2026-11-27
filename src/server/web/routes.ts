// The web pages (docs/specs/web.md): login, connect your agent, home, a teammate's page, pair room, settings.
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Eta } from 'eta';
import type { Db } from '../../store/db.ts';
import type { Pair, Participant } from '../../store/schema.ts';
import {
  checkLogin,
  participantByToken,
  createUser,
  createWebSession,
  endWebSession,
  participantByWebSession,
  regenerateToken,
} from '../../services/auth.ts';
import { analytics, projectTable, type Window } from '../../services/analytics.ts';
import { needsYou, pairAttention, roomStatus } from '../../services/attention.ts';
import { PairError } from '../../services/errors.ts';
import { closeQuestionOnPage, decideApproval, insertMessage } from '../../services/messages.ts';
import { markSeen, nudge, nudgeOffer } from '../../services/nudges.ts';
import { endPair, requestPair, respondToPair } from '../../services/pairs.ts';
import { homeData, pairForViewer, personData, roomData, sides } from '../../services/room.ts';
import { storable } from '../../services/sanitize.ts';
import { pairSummaryMarkdown } from '../../services/summary.ts';
import type { Config } from '../config.ts';
import { importMap, spaceBase, staticFiles, styleVersion, vendor } from './assets.ts';
import { icon } from './icons.ts';

const COOKIE = 'pair41_session';
const VIEWS = join(import.meta.dirname, 'views');

export const eta = new Eta({ views: VIEWS, cache: true, autoEscape: true });

type Form = Record<string, string | undefined>;

export function registerWeb(app: FastifyInstance, db: Db, config: Config) {
  const secureCookie = config.publicUrl?.startsWith('https://') ?? false;

  // HTMX partials: swapped into a page that already has the top bar, so they skip the "Needs you" lookup.
  const PARTIALS = new Set(['room-live', 'log-live', 'needs']);

  async function page(reply: FastifyReply, view: string, data: Record<string, unknown>, status = 200) {
    const user = data.user as Participant | undefined;
    const needs = user && !PARTIALS.has(view) ? await needsYou(db, user) : [];
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(
        eta.render(view, {
          inviteRequired: Boolean(config.inviteCode),
          styleVersion,
          importMap,
          spaceBase,
          vendor,
          icon,
          needs,
          ...data,
        }),
      );
  }

  /**
   * The room's data, plus what is waiting on the viewer in it, the status strip and whether they can nudge. Opening
   * the room marks everything in it as seen, so it is done first.
   */
  async function roomPage(pair: Pair, user: Participant) {
    await markSeen(db, pair.id, user.id);
    const room = await roomData(db, pair, user);
    const attention = await pairAttention(db, pair, user);
    const nudgeState = await nudgeOffer(db, pair, user);
    return {
      ...room,
      attention,
      nudge: nudgeState,
      status: roomStatus(pair, room.partner.name, attention, room.partner),
    };
  }

  function serverUrl(req: FastifyRequest): string {
    return config.publicUrl ?? `${req.protocol}://${req.host}`;
  }

  async function currentUser(req: FastifyRequest): Promise<Participant | undefined> {
    const token = req.cookies[COOKIE];
    return token ? participantByWebSession(db, token) : undefined;
  }

  /** The logged-in person, or a redirect to /login (undefined). */
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<Participant | undefined> {
    const user = await currentUser(req);
    if (!user) {
      const next = req.method === 'GET' && req.url !== '/' ? `?next=${encodeURIComponent(req.url)}` : '';
      await reply.redirect(`/login${next}`, 303);
      return undefined;
    }
    return user;
  }

  async function startWebSession(reply: FastifyReply, participantId: number) {
    const token = await createWebSession(db, participantId);
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      maxAge: 7 * 24 * 60 * 60,
    });
  }

  const notFound = (reply: FastifyReply) => reply.code(404).type('text/plain').send('Not found');
  /** A page you cannot see, or that does not exist: the branded 404 with a way back. */
  const missing = (reply: FastifyReply, user?: Participant) => page(reply, 'not-found', { user }, 404);

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html'))
      return missing(reply, await currentUser(req));
    return reply
      .code(404)
      .send({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 });
  });
  const back = (value: string | undefined, fallback: string) =>
    value && value.startsWith('/') && !value.startsWith('//') ? value : fallback;

  // Forms are posted from our own pages only: refuse a POST whose Origin is another site.
  app.addHook('preHandler', async (req, reply) => {
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && !req.url.startsWith('/mcp') && !req.url.startsWith('/api')) {
      if (new URL(origin).host !== req.host)
        return reply.code(403).send('Cross-site form posts are not allowed');
    }
  });

  // One route per file, so the URL never chooses what is read; any other /static path falls through to the 404.
  for (const [path, file] of staticFiles) {
    app.get(`/static/${path}`, async (req, reply) => {
      reply
        .type(file.type)
        .header('cache-control', `public, max-age=${file.maxAge}`)
        .header('vary', 'accept-encoding');
      if (file.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] ?? ''))
        return reply.header('content-encoding', 'gzip').send(file.gzip);
      return reply.send(file.body);
    });
  }

  app.get('/', async (req, reply) => reply.redirect((await currentUser(req)) ? '/lobby' : '/login', 303));

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) =>
    page(reply, 'login', { next: back(req.query.next, '') }),
  );

  // At most 10 failed logins per address and username in 10 minutes (work-1 sits behind a public ALB).
  const failures = new Map<string, number[]>();
  const LIMIT = 10;
  const LIMIT_WINDOW_MS = 10 * 60_000;

  app.post('/login', async (req, reply) => {
    const form = req.body as Form;
    const key = `${req.ip}|${(form.name ?? '').toLowerCase()}`;
    const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < LIMIT_WINDOW_MS);
    if (recent.length >= LIMIT) {
      return page(reply, 'login', { error: 'Too many failed logins. Wait 10 minutes and try again.' }, 429);
    }
    const user = await checkLogin(db, form.name ?? '', form.password ?? '');
    if (!user) {
      failures.set(key, [...recent, Date.now()]);
      if (failures.size > 10_000) failures.clear();
      return page(
        reply,
        'login',
        { error: 'Wrong username or password.', name: form.name, next: back(form.next, '') },
        401,
      );
    }
    failures.delete(key);
    await startWebSession(reply, user.id);
    return reply.redirect(back(form.next, '/lobby'), 303);
  });

  app.post('/signup', async (req, reply) => {
    const form = req.body as Form;
    if (config.inviteCode && form.invite !== config.inviteCode) {
      return page(
        reply,
        'login',
        { signupError: 'That invite code is not right.', signupName: form.name },
        403,
      );
    }
    try {
      const { participant, token } = await createUser(db, form.name ?? '', form.password ?? '');
      await startWebSession(reply, participant.id);
      return page(reply, 'connect', { user: participant, token, server: serverUrl(req), welcome: true });
    } catch (error) {
      if (!(error instanceof PairError)) throw error;
      return page(reply, 'login', { signupError: error.message, signupName: form.name }, 400);
    }
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await endWebSession(db, token);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect('/login', 303);
  });

  app.get('/connect', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return page(reply, 'connect', { user, server: serverUrl(req) });
  });

  app.post('/connect/regenerate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const token = await regenerateToken(db, user.id);
    return page(reply, 'connect', { user, token, server: serverUrl(req), regenerated: true });
  });

  app.post('/settings/sharing', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const form = req.body as Form;
    await db
      .updateTable('participants')
      .set({ share_conversation: form.share === 'on' ? 1 : 0 })
      .where('id', '=', user.id)
      .execute();
    return reply.redirect(back(form.back, '/connect'), 303);
  });

  app.post('/settings/approval', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const form = req.body as Form;
    await db
      .updateTable('participants')
      .set({ approve_before_send: form.approve === 'on' ? 1 : 0 })
      .where('id', '=', user.id)
      .execute();
    return reply.redirect(back(form.back, '/connect'), 303);
  });

  app.post<{ Params: { id: string } }>('/messages/:id/approve', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return notFound(reply);
    try {
      const message = await decideApproval(
        db,
        user.id,
        Number(req.params.id),
        (req.body as Form).decision === 'approve',
      );
      return reply.redirect(`/pairs/${message.pair_id}`, 303);
    } catch (error) {
      if (error instanceof PairError) return notFound(reply);
      throw error;
    }
  });

  app.get('/lobby', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return page(reply, 'home', { user, ...(await homeData(db, user)), server: serverUrl(req) });
  });

  // "Needs you": the top bar's list, polled by every page.
  app.get('/needs', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return notFound(reply);
    return page(reply, 'needs', { user, needs: await needsYou(db, user) });
  });

  /** Re-renders a page with an error instead of redirecting. */
  async function withError(
    reply: FastifyReply,
    user: Participant,
    view: 'home' | 'person',
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    return page(reply, view, { user, error: message, ...extra }, 400);
  }

  app.get<{ Params: { name: string } }>('/people/:name', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (req.params.name === user.name) return reply.redirect('/lobby', 303);
    const data = await personData(db, user, req.params.name);
    if (!data) return missing(reply, user);
    return page(reply, 'person', { user, ...data });
  });

  app.post<{ Params: { name: string } }>('/people/:name/pair', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const form = req.body as Form;
    try {
      const pair = await requestPair(db, user.id, req.params.name, form.feature ?? '');
      return reply.redirect(`/pairs/${pair.id}`, 303);
    } catch (error) {
      if (!(error instanceof PairError)) throw error;
      const data = await personData(db, user, req.params.name);
      if (!data) return notFound(reply);
      return withError(reply, user, 'person', error.message, { ...data, feature: form.feature });
    }
  });

  app.post<{ Params: { id: string } }>('/pairs/:id/respond', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    try {
      const pair = await respondToPair(
        db,
        user.id,
        Number(req.params.id),
        (req.body as Form).accept === 'yes',
      );
      return reply.redirect(pair.status === 'active' ? `/pairs/${pair.id}` : '/lobby', 303);
    } catch (error) {
      if (!(error instanceof PairError)) throw error;
      return withError(reply, user, 'home', error.message, {
        ...(await homeData(db, user)),
        server: serverUrl(req),
      });
    }
  });

  app.get<{ Params: { id: string } }>('/pairs/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const pair = await pairForViewer(db, Number(req.params.id), user.id);
    if (!pair) return missing(reply, user);
    return page(reply, 'room', { user, ...(await roomPage(pair, user)) });
  });

  app.get<{ Params: { id: string } }>('/pairs/:id/live', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    return page(reply, 'room-live', { user, ...(await roomPage(pair, user)) });
  });

  app.post<{ Params: { id: string } }>('/pairs/:id/messages', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    const text = storable((req.body as Form).text ?? '').trim();
    const { partner } = await sides(db, pair, user.id);
    if (
      text &&
      partner &&
      pair.status === 'active' &&
      pair.session_a_id !== null &&
      pair.session_b_id !== null
    ) {
      await insertMessage(db, {
        pair_id: pair.id,
        sender_kind: 'human',
        sender_session_id: null,
        sender_participant_id: user.id,
        recipient_session_id: partner.session.id,
        kind: 'chat',
        topic: null,
        body: text.slice(0, 4000),
        reply_to: null,
        state: null,
      });
    }
    return reply.redirect(`/pairs/${pair.id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/pairs/:id/end', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    if (pair.status === 'active' || pair.status === 'requested')
      await endPair(db, pair, (req.body as Form).summary || `Ended by ${user.name}.`, user.id);
    return reply.redirect(`/pairs/${pair.id}`, 303);
  });

  app.post<{ Params: { id: string; message: string } }>(
    '/pairs/:id/questions/:message/close',
    async (req, reply) => {
      const user = await currentUser(req);
      const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
      if (!user || !pair) return notFound(reply);
      try {
        await closeQuestionOnPage(db, pair, user, Number(req.params.message));
      } catch (error) {
        if (error instanceof PairError && error.status === 404) return notFound(reply);
        throw error;
      }
      return reply.redirect(back((req.body as Form | undefined)?.back, `/pairs/${pair.id}#questions`), 303);
    },
  );

  app.post<{ Params: { id: string } }>('/pairs/:id/nudge', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    const to = back((req.body as Form).back, `/pairs/${pair.id}`);
    try {
      await nudge(db, pair, user);
      return reply.redirect(to, 303);
    } catch (error) {
      if (!(error instanceof PairError)) throw error;
      return page(reply, 'room', { user, ...(await roomPage(pair, user)), error: error.message }, 400);
    }
  });

  app.post<{ Params: { id: string } }>('/pairs/:id/feedback', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    const form = req.body as Form;
    if (pair.status === 'ended' && (form.helpful === 'yes' || form.helpful === 'no')) {
      const values = {
        helpful: form.helpful === 'yes' ? 1 : 0,
        note:
          storable(form.note ?? '')
            .trim()
            .slice(0, 500) || null,
        created_at: Date.now(),
      };
      await db
        .insertInto('pair_feedback')
        .values({ pair_id: pair.id, participant_id: user.id, ...values })
        .onConflict((oc) => oc.columns(['pair_id', 'participant_id']).doUpdateSet(values))
        .execute();
    }
    return reply.redirect(`/pairs/${pair.id}`, 303);
  });

  // The conversation log: the whole pair as one timeline, both sides.
  app.get<{ Params: { id: string } }>('/pairs/:id/log', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const pair = await pairForViewer(db, Number(req.params.id), user.id);
    if (!pair) return missing(reply, user);
    return page(reply, 'log', { user, ...(await roomPage(pair, user)) });
  });

  app.get<{ Params: { id: string } }>('/pairs/:id/log/live', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    return page(reply, 'log-live', { user, ...(await roomPage(pair, user)) });
  });

  app.get<{ Params: { id: string } }>('/pairs/:id/log.md', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    const room = await roomData(db, pair, user);
    const label: Record<string, string> = {
      prompt: 'asked their agent',
      reply: 'concluded',
      commit: 'committed',
      file: 'changed',
      activity: 'is doing',
    };
    const lines = [
      `# ${room.pair.feature} (${room.pair.ref}${room.pair.project ? `, ${room.pair.project}` : ''})`,
      '',
    ];
    for (const item of room.timeline) {
      const what = item.message
        ? `${item.message.kind}${item.message.replyTo ? ` to ${item.message.replyTo}` : ''} ${item.message.id}`
        : label[item.type];
      lines.push(
        `- **${item.at.slice(11, 19)} UTC · ${item.who}** (${what}): ${item.body.replace(/\n/g, ' ')}`,
      );
    }
    return reply.type('text/markdown; charset=utf-8').send(lines.join('\n') + '\n');
  });

  app.get<{ Params: { id: string } }>('/pairs/:id/summary.md', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.params.id), user.id) : undefined;
    if (!user || !pair) return notFound(reply);
    return reply.type('text/markdown; charset=utf-8').send(await pairSummaryMarkdown(db, pair.id));
  });

  // Analytics: any logged-in person sees counts (and end-of-pair notes), never pair content.
  const windowOf = (value: string | undefined): Window => (value === 'all' ? 'all' : '7d');

  app.get<{ Querystring: { window?: string } }>('/analytics', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const window = windowOf(req.query.window);
    const data = await analytics(db, window);
    return page(reply, 'analytics', {
      user,
      title: 'Analytics',
      data,
      projects: await projectTable(db, window),
      chart: chartData(data.messages.per_day),
      fmt,
    });
  });

  app.get<{ Params: { name: string }; Querystring: { window?: string } }>(
    '/analytics/projects/:name',
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const window = windowOf(req.query.window);
      const data = await analytics(db, window, req.params.name);
      return page(reply, 'analytics', {
        user,
        title: `Analytics: ${req.params.name}`,
        data,
        chart: chartData(data.messages.per_day),
        fmt,
      });
    },
  );

  app.get<{ Querystring: { window?: string; project?: string } }>('/api/analytics', async (req, reply) => {
    const auth = req.headers.authorization;
    const user =
      (await currentUser(req)) ??
      (auth?.toLowerCase().startsWith('bearer ')
        ? await participantByToken(db, auth.slice(7).trim())
        : undefined);
    if (!user) return reply.code(401).send({ error: 'Log in, or send your agent token as a Bearer token.' });
    return analytics(db, windowOf(req.query.window), req.query.project || undefined);
  });

  return { currentUser, requireUser, page };
}

/** Series for the messages-per-day chart: fixed order; colours per theme in style.css (--s1..--s4, validated). */
const SERIES = [
  { key: 'claude-code', label: 'Claude Code', color: 'var(--s1)' },
  { key: 'codex', label: 'Codex', color: 'var(--s2)' },
  { key: 'other', label: 'Other agents', color: 'var(--s3)' },
  { key: 'human', label: 'People (Pair41 page)', color: 'var(--s4)' },
];

function chartData(perDay: { day: string; by_agent: Record<string, number> }[]) {
  const days = perDay.slice(-14).map(({ day, by_agent }) => {
    const counts: Record<string, number> = { 'claude-code': 0, codex: 0, other: 0, human: 0 };
    for (const [kind, n] of Object.entries(by_agent)) {
      if (kind === 'system') continue;
      const key = kind in counts ? kind : 'other';
      counts[key] = (counts[key] ?? 0) + n;
    }
    return { day, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  });
  const max = Math.max(1, ...days.map((d) => d.total));
  return { series: SERIES, days, max };
}

const fmt = {
  pct: (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)}%`),
  duration: (secondsValue: number | null) => {
    if (secondsValue === null) return '–';
    if (secondsValue < 90) return `${secondsValue} s`;
    if (secondsValue < 90 * 60) return `${Math.round(secondsValue / 60)} min`;
    const hours = secondsValue / 3600;
    return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
  },
};
