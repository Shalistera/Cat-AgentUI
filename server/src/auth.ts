import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, lt } from 'drizzle-orm';
import { db, schema, now } from './db/index.js';
import { newToken, sha256hex } from './crypto.js';
import { config } from './config.js';

export interface SessionUser {
  id: string;
  username: string;
  role: string;
  displayName: string | null;
  allowImages: number;
  allowImageModels: number;
  settings: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const COOKIE_NAME = 'cat_session';

export function createSession(userId: string, req: FastifyRequest): string {
  const token = newToken();
  db.insert(schema.sessions).values({
    tokenHash: sha256hex(token),
    userId,
    createdAt: now(),
    expiresAt: now() + config.sessionTtlMs,
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
  }).run();
  return token;
}

export function destroySession(token: string) {
  db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256hex(token))).run();
}

/**
 * Opaque per-session id for the 登录设备 UI. Derived from the token hash by
 * one more hash round, so the value shown in the browser is neither the cookie
 * nor the column the cookie is looked up by.
 */
export function sessionPublicId(tokenHash: string): string {
  return sha256hex(`session-id:${tokenHash}`).slice(0, 24);
}

export function sessionsForUser(userId: string) {
  return db.select().from(schema.sessions)
    .where(eq(schema.sessions.userId, userId)).all()
    .filter((s) => s.expiresAt >= now());
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  const forwardedProto = String(reply.request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0].trim().toLowerCase();
  const browserUrl = String(
    reply.request.headers.origin ?? reply.request.headers.referer ?? '',
  );
  let browserUsedHttps = false;
  try { browserUsedHttps = new URL(browserUrl).protocol === 'https:'; } catch { /* absent/malformed */ }
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Automatically retain Secure behind a normal HTTPS reverse proxy even if
    // COOKIE_SECURE was omitted. Trusting a spoofed header can only make the
    // attacker's own cookie stricter; it cannot weaken another session.
    secure: config.cookieSecure || reply.request.protocol === 'https'
      || forwardedProto === 'https' || browserUsedHttps,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

let lastPurge = 0;
const LAST_SEEN_INTERVAL_MS = 5 * 60_000;

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    // CSRF: state-changing calls must carry our custom header (set by the SPA client).
    // Combined with SameSite=Lax cookies this blocks cross-site request forgery.
    // Enforced on every non-safe method — gating on the raw URL would let a
    // percent-encoded path (/%61pi/…) slip past while still routing to the handler.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-csrf'] !== '1') {
        return reply.code(403).send({ error: 'CSRF check failed' });
      }
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        try {
          if (new URL(origin).host !== host) {
            return reply.code(403).send({ error: 'Origin mismatch' });
          }
        } catch {
          return reply.code(403).send({ error: 'Bad origin' });
        }
      }
    }

    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return;
    const tokenHash = sha256hex(token);
    const row = db.select({
      userId: schema.sessions.userId,
      expiresAt: schema.sessions.expiresAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      id: schema.users.id,
      username: schema.users.username,
      role: schema.users.role,
      displayName: schema.users.displayName,
      allowImages: schema.users.allowImages,
      allowImageModels: schema.users.allowImageModels,
      settings: schema.users.settings,
      disabled: schema.users.disabled,
    }).from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(eq(schema.sessions.tokenHash, tokenHash)).get();

    if (!row || row.disabled) return;
    if (row.expiresAt < now()) {
      db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash)).run();
      return;
    }
    // Activity stamp for the 登录设备 list — a write at most every 5 minutes
    // per session, so busy streaming chats don't turn into a write per request.
    if (!row.lastSeenAt || now() - row.lastSeenAt > LAST_SEEN_INTERVAL_MS) {
      db.update(schema.sessions).set({ lastSeenAt: now() })
        .where(eq(schema.sessions.tokenHash, tokenHash)).run();
    }
    // Sliding renewal once past half-life
    if (row.expiresAt - now() < config.sessionTtlMs / 2) {
      db.update(schema.sessions).set({ expiresAt: now() + config.sessionTtlMs })
        .where(eq(schema.sessions.tokenHash, tokenHash)).run();
      setSessionCookie(reply, token);
    }
    req.user = {
      id: row.id, username: row.username, role: row.role,
      displayName: row.displayName, settings: row.settings,
      allowImages: row.allowImages, allowImageModels: row.allowImageModels,
    };
    // Opportunistic cleanup of expired sessions (at most hourly)
    if (now() - lastPurge > 3600_000) {
      lastPurge = now();
      db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now())).run();
      db.update(schema.users).set({ lastActiveAt: now() }).where(eq(schema.users.id, row.id)).run();
    }
  });
}

// These throw; the root error handler maps them to 401/403 JSON responses.
export function requireAuth(req: FastifyRequest, _reply?: FastifyReply): asserts req is FastifyRequest & { user: SessionUser } {
  if (!req.user) throw new Error('unauthorized');
}

export function requireAdmin(req: FastifyRequest, reply?: FastifyReply): asserts req is FastifyRequest & { user: SessionUser } {
  requireAuth(req, reply);
  if (req.user!.role !== 'admin') throw new Error('forbidden');
}

// --- simple in-memory rate limiter (login etc.) ---
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const b = buckets.get(key);
  if (!b || b.resetAt < Date.now()) {
    buckets.set(key, { count: 1, resetAt: Date.now() + windowMs });
    return true;
  }
  b.count++;
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) if (v.resetAt < Date.now()) buckets.delete(k);
  }
  return b.count <= max;
}
