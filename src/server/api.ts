// The small JSON API the pair41 CLI calls: hooks, the waiter (`pair41 wait`) and the doctor's identity check.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../store/db.ts';
import { PairError, ref } from '../services/errors.ts';
import { visibleTo } from '../services/messages.ts';
import { activePair } from '../services/pairs.ts';
import {
  onPostToolUse,
  onSessionEnd,
  onSessionStart,
  onStop,
  onUserPromptSubmit,
  type HookResult,
} from '../services/hooks.ts';
import { OPEN_WINDOW_MS, resolveSession } from '../services/sessions.ts';
import { waiterSession, waitForWake } from '../services/wake.ts';
import type { AgentIdentity } from './app.ts';

const HookBody = z.object({
  agent_session_id: z.string().max(200).optional(),
  cwd: z.string().max(1000).optional(),
  model: z.string().max(100).optional(),
  prompt: z.string().max(20_000).optional(),
  files: z.array(z.string().max(500)).max(100).optional(),
  commit: z.object({ hash: z.string().max(64), message: z.string().max(500) }).optional(),
  last_reply: z.string().max(20_000).optional(),
});

export function registerApi(
  app: FastifyInstance,
  db: Db,
  agentIdentity: (req: FastifyRequest, reply: FastifyReply) => Promise<AgentIdentity | undefined>,
) {
  app.get('/api/me', async (req, reply) => {
    const identity = await agentIdentity(req, reply);
    if (!identity) return;
    return { name: identity.participant.name, agent: identity.agentKind, project: identity.project ?? null };
  });

  // For the `pair41 run` wrapper: the newest open session of this person, project and agent kind, and its unread messages.
  app.get('/api/unread', async (req, reply) => {
    const identity = await agentIdentity(req, reply);
    if (!identity) return;
    const session = await db
      .selectFrom('sessions')
      .selectAll()
      .where('participant_id', '=', identity.participant.id)
      .where('project', '=', identity.project ?? '')
      .where('agent_kind', '=', identity.agentKind)
      .where('state', '!=', 'closed')
      .where('last_seen_at', '>', Date.now() - OPEN_WINDOW_MS)
      .orderBy('last_seen_at', 'desc')
      .executeTakeFirst();
    if (!session) return { session: null, unread: 0, latest: 0 };
    const pair = await activePair(db, session.id);
    const unread = pair
      ? await db
          .selectFrom('messages')
          .select('id')
          .where('pair_id', '=', pair.id)
          .where('id', '>', session.msg_cursor)
          .where(visibleTo(session.id))
          .orderBy('id')
          .execute()
      : [];
    return {
      session: ref('s', session.id),
      state: session.state,
      unread: unread.length,
      latest: unread.length ? unread[unread.length - 1]!.id : 0,
    };
  });

  // For `pair41 wait` (docs/specs/protocol.md, "Wake"): held until this session has something worth a turn, or for
  // `timeout` seconds. Ended early when the client goes away or the server shuts down.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());
  app.get<{ Querystring: { session?: string; timeout?: string } }>('/api/wait', async (req, reply) => {
    const identity = await agentIdentity(req, reply);
    if (!identity) return;
    const agentSessionId = req.query.session;
    if (!agentSessionId) return reply.code(400).send({ error: 'session (the agent session id) is required' });
    const session = await waiterSession(db, identity.participant.id, agentSessionId);
    if (!session) return { stop: 'no such session' };
    const seconds = Math.min(Math.max(Number(req.query.timeout) || 25, 1), 45);
    const gone = new AbortController();
    reply.raw.on('close', () => gone.abort());
    return waitForWake(db, session.id, seconds * 1000, AbortSignal.any([gone.signal, closing.signal]));
  });

  app.post<{ Params: { event: string } }>('/api/hooks/:event', async (req, reply) => {
    const identity = await agentIdentity(req, reply);
    if (!identity) return;
    const body = HookBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    const input = body.data;
    try {
      const session = await resolveSession(db, identity.participant, {
        agentKind: identity.agentKind,
        project: identity.project,
        agentSessionId: input.agent_session_id,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
      });
      let result: HookResult;
      switch (req.params.event) {
        case 'session-start':
          result = await onSessionStart(db, session);
          break;
        case 'user-prompt-submit':
          result = await onUserPromptSubmit(db, session, input.prompt);
          break;
        case 'post-tool-use':
          result = await onPostToolUse(db, session, {
            ...(input.files ? { files: input.files } : {}),
            ...(input.commit ? { commit: input.commit } : {}),
          });
          break;
        case 'stop':
          result = await onStop(db, session, input.last_reply);
          break;
        case 'session-end':
          result = await onSessionEnd(db, session);
          break;
        default:
          return reply.code(404).send({ error: `Unknown hook event "${req.params.event}"` });
      }
      return result;
    } catch (error) {
      if (error instanceof PairError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
