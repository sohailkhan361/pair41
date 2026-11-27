// The /bridge WebSocket (PLAN.md §6.6). A local `pair41 bridge` connects here for one Claude Code session. The server
// sends it questions, answers, contract changes and pair requests for that session (chat at most every 30 s); the
// bridge writes each one to the session's inbox socket and reports the attempt back. Off unless a bridge connects.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Db } from '../store/db.ts';
import type { Message } from '../store/schema.ts';
import { participantByToken } from '../services/auth.ts';
import { PairError, ref } from '../services/errors.ts';
import { events } from '../services/events.ts';
import { recordAttempt, senderLabel } from '../services/messages.ts';
import { SHARED_NOTE, sanitize } from '../services/sanitize.ts';
import { resolveSession, setState, viewSession } from '../services/sessions.ts';

const CHAT_INTERVAL_MS = 30_000;

const Hello = z.object({
  type: z.literal('hello'),
  token: z.string(),
  project: z.string().optional(),
  agent: z.string().default('claude-code'),
  agent_session_id: z.string().min(1),
});

const Attempt = z.object({
  type: z.literal('attempt'),
  message_id: z.string(),
  result: z.enum(['written', 'error']),
  detail: z.string().max(500).optional(),
});

interface Bridge {
  socket: WebSocket;
  lastChatPush: number;
  pendingChat: Message[];
  timer: NodeJS.Timeout | undefined;
}

export function registerBridge(app: FastifyInstance, db: Db, hostAllowed: (hostname: string) => boolean) {
  const bridges = new Map<number, Bridge>();

  function send(bridge: Bridge, payload: Record<string, unknown>) {
    if (bridge.socket.readyState === bridge.socket.OPEN) bridge.socket.send(JSON.stringify(payload));
  }

  async function pushText(message: Message): Promise<string> {
    const from = await senderLabel(db, message);
    const what = message.kind === 'system' ? 'update' : message.kind;
    return `[Pair41] from ${from}: ${sanitize(message.body)}\n(${what} ${ref('m', message.id)}. ${SHARED_NOTE} Reply with the Pair41 tools.)`;
  }

  async function push(sessionId: number, message: Message) {
    const bridge = bridges.get(sessionId);
    if (!bridge) return;
    send(bridge, { type: 'push', message_id: ref('m', message.id), text: await pushText(message) });
  }

  /** Chat is batched: at most one push every 30 seconds per session. */
  function pushChat(sessionId: number, message: Message) {
    const bridge = bridges.get(sessionId);
    if (!bridge) return;
    bridge.pendingChat.push(message);
    if (bridge.timer) return;
    const wait = Math.max(0, bridge.lastChatPush + CHAT_INTERVAL_MS - Date.now());
    bridge.timer = setTimeout(() => {
      bridge.timer = undefined;
      bridge.lastChatPush = Date.now();
      const batch = bridge.pendingChat.splice(0);
      for (const m of batch) void push(sessionId, m);
    }, wait);
  }

  const stopMessages = events.onMessageVisible((message) => {
    if (message.recipient_session_id === null || !bridges.has(message.recipient_session_id)) return;
    const important =
      message.kind === 'question' || message.kind === 'answer' || message.topic === 'contract';
    if (important) void push(message.recipient_session_id, message);
    else if (message.kind === 'chat') pushChat(message.recipient_session_id, message);
  });

  const stopRequests = events.onPairRequested((pairId) => {
    void (async () => {
      const pair = await db.selectFrom('pairs').selectAll().where('id', '=', pairId).executeTakeFirst();
      if (!pair) return;
      const requester = await db
        .selectFrom('participants')
        .select('name')
        .where('id', '=', pair.requester_id)
        .executeTakeFirstOrThrow();
      for (const [sessionId, bridge] of bridges) {
        const view = await viewSession(db, sessionId);
        if (view.session.participant_id !== pair.partner_id) continue;
        send(bridge, {
          type: 'push',
          text: `[Pair41] ${requester.name} asks your human to pair on "${sanitize(pair.feature, 120)}" (${ref('p', pair.id)}). Tell your human; they accept on the Pair41 page. Do not accept it yourself.`,
        });
      }
    })();
  });

  app.addHook('preClose', async () => {
    stopMessages();
    stopRequests();
    const open = [...bridges.values()];
    bridges.clear(); // so the close handlers below do not touch a database that is shutting down
    for (const bridge of open) bridge.socket.close();
  });

  app.get('/bridge', { websocket: true }, (socket, req) => {
    if (!hostAllowed(req.hostname)) {
      socket.close(1008, 'host not allowed');
      return;
    }
    let sessionId: number | undefined;
    const fail = (reason: string) => {
      send({ socket, lastChatPush: 0, pendingChat: [], timer: undefined }, { type: 'error', error: reason });
      socket.close(1008, reason.slice(0, 120));
    };

    socket.on('message', (raw) => {
      void (async () => {
        let data: unknown;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          return fail('not JSON');
        }
        if (sessionId === undefined) {
          const hello = Hello.safeParse(data);
          if (!hello.success) return fail('send hello first');
          const participant = await participantByToken(db, hello.data.token);
          if (!participant) return fail('invalid agent token');
          try {
            const session = await resolveSession(db, participant, {
              agentKind: hello.data.agent,
              project: hello.data.project,
              agentSessionId: hello.data.agent_session_id,
            });
            sessionId = session.id;
          } catch (error) {
            return fail(error instanceof PairError ? error.message : 'could not register the session');
          }
          bridges.get(sessionId)?.socket.close(1000, 'replaced by a new bridge');
          bridges.set(sessionId, { socket, lastChatPush: 0, pendingChat: [], timer: undefined });
          await db.updateTable('sessions').set({ bridge_connected: 1 }).where('id', '=', sessionId).execute();
          socket.send(JSON.stringify({ type: 'ready', session: ref('s', sessionId) }));
          return;
        }
        const attempt = Attempt.safeParse(data);
        if (attempt.success) {
          const messageId = Number(attempt.data.message_id.replace('m_', ''));
          const message = await db
            .selectFrom('messages')
            .select(['id', 'pair_id'])
            .where('id', '=', messageId)
            .where('recipient_session_id', '=', sessionId)
            .executeTakeFirst();
          if (message) {
            await recordAttempt(
              db,
              message.id,
              sessionId,
              'socket',
              attempt.data.result,
              attempt.data.detail,
            );
            events.pairChanged(message.pair_id);
          }
        }
      })();
    });

    socket.on('close', () => {
      if (sessionId === undefined) return;
      const bridge = bridges.get(sessionId);
      if (!bridge || bridge.socket !== socket) return; // replaced by a newer bridge
      if (bridge.timer) clearTimeout(bridge.timer);
      bridges.delete(sessionId);
      void setState(db, sessionId, 'closed');
    });
  });
}
