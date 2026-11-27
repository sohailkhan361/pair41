// Server-sent events for the pair room: "changed" whenever something in that pair changes. Pair members only.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../store/db.ts';
import type { Participant } from '../store/schema.ts';
import { events } from '../services/events.ts';
import { pairForViewer } from '../services/room.ts';

export function registerEvents(
  app: FastifyInstance,
  db: Db,
  currentUser: (req: FastifyRequest) => Promise<Participant | undefined>,
) {
  // Live streams never end on their own; end them first on shutdown, so in-flight requests can drain.
  const open = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });

  app.get<{ Querystring: { pair?: string } }>('/events', async (req, reply) => {
    const user = await currentUser(req);
    const pair = user ? await pairForViewer(db, Number(req.query.pair), user.id) : undefined;
    if (!user || !pair) return reply.code(404).type('text/plain').send('Not found');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    open.add(res);
    const stop = events.onPairChanged((pairId) => {
      if (pairId === pair.id) res.write('event: changed\ndata: {}\n\n');
    });
    // The open page counts as "human online" for the receipt; a comment line keeps proxies from closing it.
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      void db
        .updateTable('participants')
        .set({ last_web_at: Date.now() })
        .where('id', '=', user.id)
        .execute();
    }, 25_000);
    res.on('close', () => {
      open.delete(res);
      stop();
      clearInterval(heartbeat);
    });
  });
}
