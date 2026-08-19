import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { requireAuth } from '../auth.js';

// One long-lived SSE connection per signed-in tab. Events carry no payload —
// they only tell the client which cache to refetch, so nothing sensitive ever
// travels on this channel and no per-user filtering is needed.
const clients = new Set<ServerResponse>();

/** Notify every connected tab that a shared cache went stale. */
export function broadcast(event: string): void {
  for (const res of clients) {
    try { res.write(`event: ${event}\ndata: {}\n\n`); } catch { clients.delete(res); }
  }
}

export async function eventRoutes(app: FastifyInstance) {
  app.get('/api/events', async (req, reply) => {
    requireAuth(req, reply);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
    req.raw.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // Open streams would otherwise hold the server up during graceful shutdown.
  app.addHook('onClose', async () => {
    for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
    clients.clear();
  });
}
