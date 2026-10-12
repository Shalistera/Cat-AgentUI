// 系统更新 admin surface: check the upstream branch, update to it and restart,
// or just restart. The work happens in ../system-update.ts.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import {
  UpdateError, activity, bootId, controlWait, currentJob, fetchUpstream, startRestart, startUpdate, updateStatus,
} from '../system-update.js';

function conflict(reply: FastifyReply, err: unknown) {
  if (err instanceof UpdateError) return reply.code(409).send({ error: err.message });
  throw err;
}

export async function systemUpdateRoutes(app: FastifyInstance) {
  app.get('/api/admin/update', async (req, reply) => {
    requireAdmin(req, reply);
    return updateStatus();
  });

  // git fetch, then the same status document.
  app.post('/api/admin/update/check', async (req, reply) => {
    requireAdmin(req, reply);
    try { await fetchUpstream(); } catch (err) { return conflict(reply, err); }
    return updateStatus();
  });

  // `target` is the upstream commit the admin was shown, so a push landing in
  // between can't slip into the update unseen.
  app.post('/api/admin/update/apply', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({ target: z.string().regex(/^[0-9a-f]{40}$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try { return { job: await startUpdate(body.data.target, req.user.username) }; } catch (err) { return conflict(reply, err); }
  });

  app.post('/api/admin/update/restart', async (req, reply) => {
    requireAdmin(req, reply);
    try { return { job: await startRestart(req.user.username) }; } catch (err) { return conflict(reply, err); }
  });

  // What the page polls while a job runs; a new bootId means the restart landed.
  app.get('/api/admin/update/job', async (req, reply) => {
    requireAdmin(req, reply);
    return { bootId, job: currentJob(), activity: activity() };
  });

  // While a job waits for running work: restart now, or call the restart off.
  app.post('/api/admin/update/job/:action', async (req, reply) => {
    requireAdmin(req, reply);
    const { action } = req.params as { action: string };
    if (action !== 'now' && action !== 'cancel') return reply.code(404).send({ error: 'Not Found' });
    try { return { job: controlWait(action) }; } catch (err) { return conflict(reply, err); }
  });
}
