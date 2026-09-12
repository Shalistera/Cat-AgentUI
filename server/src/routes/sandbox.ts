// 沙盒 admin surface: host self-check, runtime settings, the Python venv and
// its packages, and the audit log of executed commands.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { probeSandboxEnv } from '../sandbox/env.js';
import { getSandboxSettings, saveSandboxSettings } from '../sandbox/settings.js';
import { sandboxLoad } from '../sandbox/exec.js';
import {
  PACKAGE_PRESETS, createVenv, currentJob, installPackages, installedPackages, uninstallPackages, venvExists,
} from '../sandbox/venv.js';

export async function sandboxRoutes(app: FastifyInstance) {
  app.get('/api/admin/sandbox', async (req, reply) => {
    requireAdmin(req, reply);
    const force = (req.query as { refresh?: string }).refresh === '1';
    const [env, packages] = await Promise.all([probeSandboxEnv(force), installedPackages()]);
    return {
      env,
      settings: getSandboxSettings(),
      limits: { maxTimeoutSec: config.maxSandboxTimeoutSec, maxConcurrency: config.maxSandboxConcurrency },
      load: sandboxLoad(),
      venv: { exists: venvExists(), packages, presets: PACKAGE_PRESETS },
      job: currentJob(),
    };
  });

  app.put('/api/admin/sandbox/settings', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({
      enabled: z.boolean().optional(),
      confirm: z.boolean().optional(),
      accessMode: z.enum(['shared', 'restricted']).optional(),
      allowedUserIds: z.array(z.string().max(64)).max(500).optional(),
      timeoutSec: z.number().int().optional(),
      memoryMb: z.number().int().optional(),
      cpuPercent: z.number().int().optional(),
      maxPids: z.number().int().optional(),
      maxOutputChars: z.number().int().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    return { settings: saveSandboxSettings(body.data) };
  });

  app.get('/api/admin/sandbox/job', async (req, reply) => {
    requireAdmin(req, reply);
    return { job: currentJob() };
  });

  app.post('/api/admin/sandbox/venv', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({ rebuild: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const env = await probeSandboxEnv();
    if (!env.python3Path) return reply.code(400).send({ error: '未找到 python3' });
    try { return { job: createVenv(env.python3Path, !!body.data.rebuild) }; }
    catch (err) { return reply.code(409).send({ error: (err as Error).message }); }
  });

  app.post('/api/admin/sandbox/packages/install', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({ specs: z.array(z.string().min(1).max(200)).min(1).max(50) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try { return { job: installPackages(body.data.specs.map((s) => s.trim())) }; }
    catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  app.post('/api/admin/sandbox/packages/uninstall', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({ names: z.array(z.string().min(1).max(100)).min(1).max(50) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try { return { job: uninstallPackages(body.data.names.map((s) => s.trim())) }; }
    catch (err) { return reply.code(400).send({ error: (err as Error).message }); }
  });

  app.get('/api/admin/sandbox/runs', async (req, reply) => {
    requireAdmin(req, reply);
    const rows = db.select().from(schema.sandboxRuns).orderBy(desc(schema.sandboxRuns.createdAt)).limit(100).all();
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = userIds.length
      ? db.select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
        .from(schema.users).where(inArray(schema.users.id, userIds)).all()
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const chatIds = [...new Set(rows.map((r) => r.chatId).filter((x): x is string => !!x))];
    const chats = chatIds.length
      ? db.select({ id: schema.chats.id, title: schema.chats.title }).from(schema.chats).where(inArray(schema.chats.id, chatIds)).all()
      : [];
    const chatById = new Map(chats.map((c) => [c.id, c.title]));
    return {
      runs: rows.map((r) => ({
        id: r.id, createdAt: r.createdAt, command: r.command,
        exitCode: r.exitCode, timedOut: !!r.timedOut, durationMs: r.durationMs, outputChars: r.outputChars,
        chatId: r.chatId, chatTitle: r.chatId ? (chatById.get(r.chatId) ?? null) : null,
        user: byId.get(r.userId) ?? { id: r.userId, username: '(已删除)', displayName: null },
      })),
    };
  });

  app.delete('/api/admin/sandbox/runs', async (req, reply) => {
    requireAdmin(req, reply);
    db.delete(schema.sandboxRuns).run();
    return { ok: true };
  });
}
