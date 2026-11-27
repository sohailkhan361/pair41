// Builds the Fastify app: /mcp, /api, /bridge, web pages, /events, /live and /ready.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { sql } from 'kysely';
import { trace } from '@opentelemetry/api';
import type { Db } from '../store/db.ts';
import type { Participant } from '../store/schema.ts';
import { participantByToken } from '../services/auth.ts';
import type { Config } from './config.ts';
import { registerApi } from './api.ts';
import { registerBridge } from './bridge.ts';
import { registerEvents } from './events.ts';
import { registerWeb } from './web/routes.ts';
import { buildMcpServer } from './mcp.ts';

export interface AgentIdentity {
  participant: Participant;
  agentKind: string;
  project: string | undefined;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// OpenTelemetry severity numbers for the log levels (infrastructure checklist §2).
const SEVERITY: Record<string, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

/** JSON logs on stdout: RFC 3339 time, OpenTelemetry severity, service name, and the trace id when tracing is on. */
function loggerOptions(level: string) {
  return {
    level,
    base: { service: process.env.OTEL_SERVICE_NAME ?? 'pair41' },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({
        severity_text: label.toUpperCase(),
        severity_number: SEVERITY[label] ?? 9,
      }),
    },
    mixin() {
      const context = trace.getActiveSpan()?.spanContext();
      return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
    },
  };
}

export function buildApp(config: Config, db: Db) {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : loggerOptions(config.logLevel),
    // Behind the ALB (a public URL is set), the client address and protocol come from X-Forwarded-*.
    trustProxy: Boolean(config.publicUrl),
  });
  let ready = true;
  const allowedHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));

  /** DNS-rebinding protection for agent endpoints: only known Host headers. */
  function hostAllowed(req: FastifyRequest): boolean {
    return allowedHosts.has(req.hostname.toLowerCase()) || allowedHosts.has(req.host.toLowerCase());
  }

  /** The agent token and headers on /mcp, /api and /bridge. Sends 401/403 and returns undefined on failure. */
  async function agentIdentity(req: FastifyRequest, reply: FastifyReply): Promise<AgentIdentity | undefined> {
    if (!hostAllowed(req)) {
      await reply.code(403).send({ error: `Host ${req.host} is not allowed. Set PAIR41_ALLOWED_HOSTS.` });
      return undefined;
    }
    const auth = header(req, 'authorization');
    const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
    const participant = token ? await participantByToken(db, token) : undefined;
    if (!participant) {
      await reply.code(401).send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message: 'Missing or invalid Pair41 agent token. Get yours on the Pair41 page.',
        },
      });
      return undefined;
    }
    return {
      participant,
      agentKind: (header(req, 'x-pair-agent') ?? 'other').toLowerCase().slice(0, 32),
      project: header(req, 'x-pair-project'),
    };
  }

  app.get('/live', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    if (!ready) return reply.code(503).send({ status: 'shutting down' });
    try {
      await sql`select 1`.execute(db);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database unreachable' });
    }
  });

  app.post('/mcp', async (req, reply) => {
    const identity = await agentIdentity(req, reply);
    if (!identity) return;
    const controller = new AbortController();
    const server = buildMcpServer({ db, ...identity, signal: controller.signal });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      controller.abort();
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'Pair41 MCP is stateless: POST only.' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  registerApi(app, db, agentIdentity);
  void app.register(websocket);
  void app.register(async (scope) =>
    registerBridge(scope, db, (hostname) => allowedHosts.has(hostname.toLowerCase())),
  );
  void app.register(cookie);
  void app.register(formbody);
  void app.register(async (web) => {
    const { currentUser } = registerWeb(web, db, config);
    registerEvents(web, db, currentUser);
  });

  return {
    app,
    agentIdentity,
    markNotReady() {
      ready = false;
    },
  };
}
