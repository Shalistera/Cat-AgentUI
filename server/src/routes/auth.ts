import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema, now, getSetting } from '../db/index.js';
import { hashPassword, verifyPassword, newId } from '../crypto.js';
import {
  COOKIE_NAME, createSession, destroySession, setSessionCookie,
  clearSessionCookie, requireAuth, rateLimit,
} from '../auth.js';

const credentialsSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[\w一-鿿.-]+$/u),
  password: z.string().min(8).max(128),
});

function publicUser(u: { id: string; username: string; role: string; displayName: string | null; settings: string }) {
  let settings: unknown = {};
  try { settings = JSON.parse(u.settings); } catch { /* ignore */ }
  return { id: u.id, username: u.username, role: u.role, displayName: u.displayName, settings };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/bootstrap', async () => {
    const anyUser = db.select({ id: schema.users.id }).from(schema.users).limit(1).get();
    return {
      needsSetup: !anyUser,
      signupEnabled: getSetting('signup_enabled', true),
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
    if (anyUser && !getSetting('signup_enabled', true)) {
      return reply.code(403).send({ error: '注册已关闭,请联系管理员' });
    }
    const existing = db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.username, username)).get();
    if (existing) return reply.code(409).send({ error: '用户名已被使用' });

    const id = newId();
    db.insert(schema.users).values({
      id, username,
      passwordHash: hashPassword(password),
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
    const u = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (!u || !verifyPassword(password, u.passwordHash)) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (u.disabled) return reply.code(403).send({ error: '账号已被停用' });
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

  app.get('/api/auth/me', async (req, reply) => {
    requireAuth(req, reply);
    return { user: publicUser({ ...req.user!, settings: req.user!.settings }) };
  });

  app.post('/api/auth/password', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({ oldPassword: z.string(), newPassword: z.string().min(8).max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '新密码至少8位' });
    const u = db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)).get()!;
    if (!verifyPassword(body.data.oldPassword, u.passwordHash)) {
      return reply.code(401).send({ error: '原密码错误' });
    }
    db.update(schema.users).set({ passwordHash: hashPassword(body.data.newPassword) })
      .where(eq(schema.users.id, u.id)).run();
    return { ok: true };
  });

  app.patch('/api/auth/profile', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({
      displayName: z.string().max(64).nullish(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
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
