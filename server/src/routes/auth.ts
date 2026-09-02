import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema, now, getSetting } from '../db/index.js';
import { hashPassword, verifyPassword, needsRehash, newId, sha256hex } from '../crypto.js';
import {
  COOKIE_NAME, createSession, destroySession, setSessionCookie,
  clearSessionCookie, requireAuth, rateLimit, sessionPublicId, sessionsForUser,
} from '../auth.js';

const credentialsSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[\w一-鿿.-]+$/u),
  password: z.string().min(8).max(128),
});

function publicUser(u: {
  id: string; username: string; role: string; displayName: string | null;
  allowImages: number; allowImageModels: number; settings: string;
}) {
  let settings: unknown = {};
  try { settings = JSON.parse(u.settings); } catch { /* ignore */ }
  return {
    id: u.id, username: u.username, role: u.role, displayName: u.displayName,
    // Resolved for the UI: admins always pass both gates.
    allowImages: u.role === 'admin' || !!u.allowImages,
    allowImageModels: u.role === 'admin' || !!u.allowImageModels,
    settings,
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/bootstrap', async () => {
    const anyUser = db.select({ id: schema.users.id }).from(schema.users).limit(1).get();
    return {
      needsSetup: !anyUser,
      signupEnabled: getSetting('signup_enabled', false),
      brand: getSetting('brand', 'Cat-AgentUI'),
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    if (!rateLimit(`reg:${req.ip}`, 10, 600_000)) {
      return reply.code(429).send({ error: '尝试过于频繁,请稍后再试' });
    }
    const body = credentialsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '用户名(2-32位)或密码(至少8位)不符合要求' });
    const { username, password } = body.data;

    const anyUser = db.select({ id: schema.users.id }).from(schema.users).limit(1).get();
    if (anyUser && !getSetting('signup_enabled', false)) {
      return reply.code(403).send({ error: '注册已关闭,请联系管理员' });
    }
    const existing = db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.username, username)).get();
    if (existing) return reply.code(409).send({ error: '用户名已被使用' });

    const id = newId();
    db.insert(schema.users).values({
      id, username,
      passwordHash: await hashPassword(password),
      role: anyUser ? 'user' : 'admin', // first user becomes admin
      createdAt: now(),
    }).run();

    const token = createSession(id, req);
    setSessionCookie(reply, token);
    const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
    return { user: publicUser(u), isFirstUser: !anyUser };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().max(64), password: z.string().max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const { username, password } = body.data;
    if (!rateLimit(`login:${req.ip}`, 20, 600_000) || !rateLimit(`login:u:${username}`, 10, 600_000)) {
      return reply.code(429).send({ error: '尝试过于频繁,请稍后再试' });
    }
    let u = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    // Migrated Open WebUI accounts use their (lowercased) email as username, and
    // Open WebUI treated login email as case-insensitive — honor that here.
    if (!u && username.includes('@')) {
      u = db.select().from(schema.users).where(eq(schema.users.username, username.toLowerCase())).get();
    }
    if (!u || !(await verifyPassword(password, u.passwordHash))) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (u.disabled) return reply.code(403).send({ error: '账号已被停用' });
    // Migrated accounts (Open WebUI bcrypt/argon2) upgrade to native scrypt on
    // first login — the only moment we hold the plaintext.
    if (needsRehash(u.passwordHash)) {
      db.update(schema.users).set({ passwordHash: await hashPassword(password) })
        .where(eq(schema.users.id, u.id)).run();
    }
    const token = createSession(u.id, req);
    setSessionCookie(reply, token);
    return { user: publicUser(u) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // Full cookie reset for browsers migrated from a previous panel on the same
  // domain: Open WebUI's `token` cookie is httpOnly, so the /error page cannot
  // remove it client-side — expire every cookie the request carried instead.
  app.post('/api/auth/reset', async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) destroySession(token);
    for (const name of Object.keys(req.cookies ?? {})) {
      reply.clearCookie(name, { path: '/' });
    }
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    requireAuth(req, reply);
    return { user: publicUser({ ...req.user!, settings: req.user!.settings }) };
  });

  // --- 登录设备 ---
  // Every live session of the caller, newest activity first. The row for the
  // cookie making the request is flagged so the UI can label "this device".
  app.get('/api/auth/sessions', async (req, reply) => {
    requireAuth(req, reply);
    const current = req.cookies?.[COOKIE_NAME];
    const currentHash = current ? sha256hex(current) : null;
    const rows = sessionsForUser(req.user!.id)
      .map((s) => ({
        id: sessionPublicId(s.tokenHash),
        current: s.tokenHash === currentHash,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        lastSeenAt: s.lastSeenAt ?? s.createdAt,
        ip: s.ip,
        userAgent: s.userAgent,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
    return { sessions: rows };
  });

  // Sign out one other device. The current session is refused here — that is
  // what /logout is for, and it keeps this endpoint from ever needing to
  // clear the caller's own cookie.
  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const current = req.cookies?.[COOKIE_NAME];
    const currentHash = current ? sha256hex(current) : null;
    const target = sessionsForUser(req.user!.id).find((s) => sessionPublicId(s.tokenHash) === id);
    if (!target) return reply.code(404).send({ error: '该设备已不在登录状态' });
    if (target.tokenHash === currentHash) return reply.code(400).send({ error: '要退出当前设备请使用「退出登录」' });
    db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, target.tokenHash)).run();
    return { ok: true };
  });

  // Sign out everywhere else — the "I left myself logged in somewhere" button.
  app.post('/api/auth/sessions/revoke-others', async (req, reply) => {
    requireAuth(req, reply);
    const current = req.cookies?.[COOKIE_NAME];
    const where = current
      ? and(eq(schema.sessions.userId, req.user!.id), ne(schema.sessions.tokenHash, sha256hex(current)))
      : eq(schema.sessions.userId, req.user!.id);
    const removed = db.delete(schema.sessions).where(where).returning({ h: schema.sessions.tokenHash }).all().length;
    return { ok: true, removed };
  });

  app.post('/api/auth/password', async (req, reply) => {
    requireAuth(req, reply);
    if (!rateLimit(`password:u:${req.user!.id}`, 5, 600_000)
      || !rateLimit(`password:ip:${req.ip}`, 20, 600_000)) {
      return reply.code(429).send({ error: '尝试过于频繁,请稍后再试' });
    }
    const body = z.object({
      oldPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '新密码至少8位' });
    const u = db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)).get()!;
    if (!(await verifyPassword(body.data.oldPassword, u.passwordHash))) {
      return reply.code(401).send({ error: '原密码错误' });
    }
    db.update(schema.users).set({ passwordHash: await hashPassword(body.data.newPassword) })
      .where(eq(schema.users.id, u.id)).run();
    // Changing the password must invalidate every other session — that is the
    // whole point of changing it after a device is lost or a cookie leaks.
    const current = req.cookies?.[COOKIE_NAME];
    db.delete(schema.sessions).where(current
      ? and(eq(schema.sessions.userId, u.id), ne(schema.sessions.tokenHash, sha256hex(current)))
      : eq(schema.sessions.userId, u.id)).run();
    return { ok: true };
  });

  app.patch('/api/auth/profile', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({
      displayName: z.string().max(64).nullish(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    // settings is a free-form merge, but modelOrder / favoriteModels feed a
    // sort on every /api/models call — keep them bounded string lists (or
    // null to reset).
    for (const key of ['modelOrder', 'favoriteModels'] as const) {
      const v = body.data.settings?.[key];
      if (v !== undefined && v !== null
        && !(Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length <= 64))) {
        return reply.code(400).send({ error: '参数错误' });
      }
    }
    // quickPrompts renders as clickable cards on the new-chat page — keep it a
    // short bounded list (or null to fall back to the built-in default).
    {
      const v = body.data.settings?.quickPrompts;
      if (v !== undefined && v !== null
        && !(Array.isArray(v) && v.length <= 6 && v.every((x) => typeof x === 'string' && x.length <= 300))) {
        return reply.code(400).send({ error: '参数错误' });
      }
    }
    // workshopPins is the sidebar's icon row (workshop ids, ordered); null =
    // show everything in the built-in order.
    {
      const v = body.data.settings?.workshopPins;
      if (v !== undefined && v !== null
        && !(Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === 'string' && x.length <= 32))) {
        return reply.code(400).send({ error: '参数错误' });
      }
    }
    // translateScenes are the user's own style presets on the 翻译工坊 page —
    // a short name plus the sentence that lands in the prompt's style slot.
    {
      const v = body.data.settings?.translateScenes;
      const okScene = (x: unknown) => !!x && typeof x === 'object'
        && typeof (x as { name?: unknown }).name === 'string' && (x as { name: string }).name.trim().length > 0
        && (x as { name: string }).name.length <= 20
        && typeof (x as { text?: unknown }).text === 'string' && (x as { text: string }).text.length <= 300;
      if (v !== undefined && v !== null && !(Array.isArray(v) && v.length <= 4 && v.every(okScene))) {
        return reply.code(400).send({ error: '参数错误' });
      }
    }
    // customInstructions rides ahead of every chat's system prompt (see
    // chats.ts) — bounded so one person cannot bloat their own context.
    {
      const v = body.data.settings?.customInstructions;
      if (v !== undefined && v !== null && !(typeof v === 'string' && v.length <= 1500)) {
        return reply.code(400).send({ error: '参数错误' });
      }
    }
    const patch: Record<string, unknown> = {};
    if (body.data.displayName !== undefined) patch.displayName = body.data.displayName;
    if (body.data.settings !== undefined) {
      let cur: Record<string, unknown> = {};
      try { cur = JSON.parse(req.user!.settings); } catch { /* ignore */ }
      patch.settings = JSON.stringify({ ...cur, ...body.data.settings });
    }
    if (Object.keys(patch).length) {
      db.update(schema.users).set(patch).where(eq(schema.users.id, req.user!.id)).run();
    }
    const u = db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)).get()!;
    return { user: publicUser(u) };
  });
}
