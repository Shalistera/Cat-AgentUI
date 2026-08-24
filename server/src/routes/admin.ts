import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { db, schema, now, getSetting, setSetting } from '../db/index.js';
import { hashPassword, newId } from '../crypto.js';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  QUOTA_ACTION_KEY, QUOTA_DEFAULT_KEY, QUOTA_FALLBACK_KEY,
  effectiveQuota, monthStartDay, monthTokens, quotaSettings,
} from '../quota.js';
import { CHAT_IMAGE_RETENTION_KEY, IMAGE_RETENTION_KEY, sweepExpiredImages } from '../retention.js';
import { FOLLOWUP_ENABLED_KEY, FOLLOWUP_MODEL_KEY, TITLE_MODEL_KEY } from './chats.js';
import { unlinkStoredFiles } from '../storage.js';

const DAY_MS = 86_400_000;

// Shared aggregate expressions over usage_log
const sums = {
  promptTokens: sql<number>`coalesce(sum(${schema.usageLog.promptTokens}), 0)`,
  completionTokens: sql<number>`coalesce(sum(${schema.usageLog.completionTokens}), 0)`,
  totalTokens: sql<number>`coalesce(sum(${schema.usageLog.totalTokens}), 0)`,
  images: sql<number>`coalesce(sum(${schema.usageLog.images}), 0)`,
  requests: sql<number>`count(*)`,
};

function parseDays(query: unknown): number {
  const raw = Number((query as Record<string, unknown> | undefined)?.days);
  const days = Number.isFinite(raw) ? Math.floor(raw) : 30;
  return Math.min(365, Math.max(1, days));
}

function usageAggregates(where: SQL | undefined, modelLimit: number) {
  const byDay = db.select({ day: schema.usageLog.day, ...sums })
    .from(schema.usageLog).where(where)
    .groupBy(schema.usageLog.day)
    .orderBy(asc(schema.usageLog.day)).all();

  const byModel = db.select({
    model: sql<string>`coalesce(${schema.usageLog.model}, '未知')`,
    totalTokens: sums.totalTokens,
    requests: sums.requests,
  }).from(schema.usageLog).where(where)
    .groupBy(schema.usageLog.model)
    .orderBy(desc(sums.totalTokens)).limit(modelLimit).all();

  const totals = db.select({
    ...sums,
    activeUsers: sql<number>`count(distinct ${schema.usageLog.userId})`,
  }).from(schema.usageLog).where(where).get()
    ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0, requests: 0, activeUsers: 0 };

  return { byDay, byModel, totals };
}

function adminUser(u: typeof schema.users.$inferSelect) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    disabled: !!u.disabled,
    monthlyTokenQuota: u.monthlyTokenQuota,
    createdAt: u.createdAt,
    lastActiveAt: u.lastActiveAt,
  };
}

function countEnabledAdmins(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(schema.users)
    .where(and(eq(schema.users.role, 'admin'), eq(schema.users.disabled, 0))).get();
  return row?.n ?? 0;
}

const createUserSchema = z.object({
  username: z.string().min(2).max(32).regex(/^[\w一-鿿.-]+$/u),
  password: z.string().min(8).max(128),
  role: z.enum(['user', 'admin']).optional(),
});

const patchUserSchema = z.object({
  role: z.enum(['user', 'admin']).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
  displayName: z.string().max(64).optional(),
  // null = follow the app default, 0 = unlimited, >0 = monthly cap
  monthlyTokenQuota: z.number().int().min(0).max(1e15).nullish(),
});

const settingsSchema = z.object({
  signupEnabled: z.boolean().optional(),
  brand: z.string().min(1).max(64).optional(),
  imageRetentionDays: z.number().int().min(0).max(3650).optional(), // 工坊图,0 = keep forever
  chatImageRetentionDays: z.number().int().min(0).max(3650).optional(), // 对话图,0 = keep forever
  quotaMonthlyTokens: z.number().int().min(0).max(1e15).optional(), // 默认月度配额,0 = 不限
  quotaAction: z.enum(['block', 'downgrade']).optional(),
  quotaFallbackModelId: z.string().max(64).nullish(), // models.id,空 = 未设置
  titleModelId: z.string().max(64).nullish(), // 对话标题生成模型,空 = 跟随对话模型
  followupEnabled: z.boolean().optional(), // 回答后自动生成快速追问
  followupModelId: z.string().max(64).nullish(), // 快速追问生成模型,空 = 跟随对话模型
});

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/users', async (req, reply) => {
    requireAdmin(req, reply);
    const users = db.select().from(schema.users).orderBy(asc(schema.users.createdAt)).all();
    const usageRows = db.select({ userId: schema.usageLog.userId, ...sums })
      .from(schema.usageLog).groupBy(schema.usageLog.userId).all();
    const usageMap = new Map(usageRows.map((r) => [r.userId, r]));
    const monthRows = db.select({ userId: schema.usageLog.userId, totalTokens: sums.totalTokens })
      .from(schema.usageLog)
      .where(gte(schema.usageLog.day, monthStartDay()))
      .groupBy(schema.usageLog.userId).all();
    const monthMap = new Map(monthRows.map((r) => [r.userId, r.totalTokens]));
    return users.map((u) => {
      const usage = usageMap.get(u.id);
      return {
        ...adminUser(u),
        usage: {
          totalTokens: usage?.totalTokens ?? 0,
          requests: usage?.requests ?? 0,
          images: usage?.images ?? 0,
          monthTokens: monthMap.get(u.id) ?? 0,
        },
      };
    });
  });

  app.post('/api/admin/users', async (req, reply) => {
    requireAdmin(req, reply);
    const body = createUserSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '用户名(2-32位)或密码(8-128位)不符合要求' });
    const { username, password, role } = body.data;

    const existing = db.select({ id: schema.users.id }).from(schema.users)
      .where(eq(schema.users.username, username)).get();
    if (existing) return reply.code(409).send({ error: '用户名已被使用' });

    const id = newId();
    db.insert(schema.users).values({
      id, username,
      passwordHash: await hashPassword(password),
      role: role ?? 'user',
      createdAt: now(),
    }).run();
    const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
    return { user: adminUser(u) };
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = patchUserSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const data = body.data;

    const target = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!target) return reply.code(404).send({ error: '用户不存在' });

    const demoting = data.role !== undefined && data.role !== 'admin';
    const disabling = data.disabled === true;

    if (id === req.user!.id && (demoting || disabling)) {
      return reply.code(400).send({ error: '不能对自己执行该操作' });
    }
    if (target.role === 'admin' && !target.disabled && (demoting || disabling)) {
      if (countEnabledAdmins() <= 1) {
        return reply.code(400).send({ error: '不能移除最后一位管理员' });
      }
    }

    const patch: Record<string, unknown> = {};
    if (data.role !== undefined) patch.role = data.role;
    if (data.disabled !== undefined) patch.disabled = data.disabled ? 1 : 0;
    if (data.password !== undefined) patch.passwordHash = await hashPassword(data.password);
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.monthlyTokenQuota !== undefined) patch.monthlyTokenQuota = data.monthlyTokenQuota;

    if (Object.keys(patch).length) {
      db.update(schema.users).set(patch).where(eq(schema.users.id, id)).run();
    }
    if (disabling || data.password !== undefined) {
      db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();
    }
    const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
    return { user: adminUser(u) };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    if (id === req.user!.id) return reply.code(400).send({ error: '不能对自己执行该操作' });

    const target = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!target) return reply.code(404).send({ error: '用户不存在' });
    if (target.role === 'admin' && !target.disabled && countEnabledAdmins() <= 1) {
      return reply.code(400).send({ error: '不能移除最后一位管理员' });
    }
    const uploadFiles = db.select({ filename: schema.uploads.filename }).from(schema.uploads)
      .where(eq(schema.uploads.userId, id)).all();
    const imageFiles = db.select({ filename: schema.images.filename }).from(schema.images)
      .where(eq(schema.images.userId, id)).all();
    // FK cascades clean sessions/chats/images/uploads; usageLog is kept for
    // historical stats. Physical media is removed after the committed delete.
    db.delete(schema.users).where(eq(schema.users.id, id)).run();
    try {
      await Promise.all([
        unlinkStoredFiles(uploadFiles, 'uploads'),
        unlinkStoredFiles(imageFiles, 'images'),
      ]);
    } catch (err) {
      req.log.warn({ err }, 'failed to remove some deleted-user media files');
    }
    return { ok: true };
  });

  app.get('/api/admin/usage', async (req, reply) => {
    requireAdmin(req, reply);
    const days = parseDays(req.query);
    const cutoff = now() - days * DAY_MS;
    const where = gte(schema.usageLog.createdAt, cutoff);

    const { byDay, byModel, totals } = usageAggregates(where, 20);

    const byUser = db.select({
      userId: schema.usageLog.userId,
      username: sql<string>`coalesce(${schema.users.username}, '已删除用户')`,
      promptTokens: sums.promptTokens,
      completionTokens: sums.completionTokens,
      totalTokens: sums.totalTokens,
      images: sums.images,
      requests: sums.requests,
    }).from(schema.usageLog)
      .leftJoin(schema.users, eq(schema.usageLog.userId, schema.users.id))
      .where(where)
      .groupBy(schema.usageLog.userId)
      .orderBy(desc(sums.totalTokens)).all();

    const byKind = db.select({
      kind: schema.usageLog.kind,
      totalTokens: sums.totalTokens,
      requests: sums.requests,
      images: sums.images,
    }).from(schema.usageLog).where(where)
      .groupBy(schema.usageLog.kind).all();

    return { days, byDay, byUser, byModel, byKind, totals };
  });

  app.get('/api/admin/usage/user/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const days = parseDays(req.query);
    const cutoff = now() - days * DAY_MS;
    const where = and(eq(schema.usageLog.userId, id), gte(schema.usageLog.createdAt, cutoff));
    const { byDay, byModel, totals } = usageAggregates(where, 20);
    const byKind = db.select({
      kind: schema.usageLog.kind,
      totalTokens: sums.totalTokens,
      requests: sums.requests,
      images: sums.images,
    }).from(schema.usageLog).where(where)
      .groupBy(schema.usageLog.kind)
      .orderBy(desc(sums.totalTokens)).all();
    return { days, byDay, byModel, byKind, totals };
  });

  const settingsView = () => {
    const quota = quotaSettings();
    return {
      signupEnabled: getSetting('signup_enabled', false),
      brand: getSetting('brand', 'Cat-AgentUI'),
      imageRetentionDays: getSetting(IMAGE_RETENTION_KEY, 0),
      chatImageRetentionDays: getSetting(CHAT_IMAGE_RETENTION_KEY, 0),
      quotaMonthlyTokens: quota.defaultQuota,
      quotaAction: quota.action,
      quotaFallbackModelId: quota.fallbackModelId || null,
      titleModelId: getSetting(TITLE_MODEL_KEY, '') || null,
      followupEnabled: getSetting(FOLLOWUP_ENABLED_KEY, true),
      followupModelId: getSetting(FOLLOWUP_MODEL_KEY, '') || null,
    };
  };

  app.get('/api/admin/settings', async (req, reply) => {
    requireAdmin(req, reply);
    return settingsView();
  });

  app.put('/api/admin/settings', async (req, reply) => {
    requireAdmin(req, reply);
    const body = settingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    if (body.data.signupEnabled !== undefined) setSetting('signup_enabled', body.data.signupEnabled);
    if (body.data.brand !== undefined) setSetting('brand', body.data.brand);
    if (body.data.imageRetentionDays !== undefined) setSetting(IMAGE_RETENTION_KEY, body.data.imageRetentionDays);
    if (body.data.chatImageRetentionDays !== undefined) setSetting(CHAT_IMAGE_RETENTION_KEY, body.data.chatImageRetentionDays);
    if (body.data.quotaMonthlyTokens !== undefined) setSetting(QUOTA_DEFAULT_KEY, body.data.quotaMonthlyTokens);
    if (body.data.quotaAction !== undefined) setSetting(QUOTA_ACTION_KEY, body.data.quotaAction);
    if (body.data.quotaFallbackModelId !== undefined) {
      const id = body.data.quotaFallbackModelId;
      if (id) {
        const m = db.select({ id: schema.models.id, imageGen: schema.models.imageGen })
          .from(schema.models).where(eq(schema.models.id, id)).get();
        if (!m || m.imageGen) return reply.code(400).send({ error: '降级模型无效,请选择一个文本模型' });
      }
      setSetting(QUOTA_FALLBACK_KEY, id ?? '');
    }
    if (body.data.titleModelId !== undefined) {
      const id = body.data.titleModelId;
      if (id) {
        const m = db.select({ id: schema.models.id, imageGen: schema.models.imageGen })
          .from(schema.models).where(eq(schema.models.id, id)).get();
        if (!m || m.imageGen) return reply.code(400).send({ error: '标题模型无效,请选择一个文本模型' });
      }
      setSetting(TITLE_MODEL_KEY, id ?? '');
    }
    if (body.data.followupEnabled !== undefined) setSetting(FOLLOWUP_ENABLED_KEY, body.data.followupEnabled);
    if (body.data.followupModelId !== undefined) {
      const id = body.data.followupModelId;
      if (id) {
        const m = db.select({ id: schema.models.id, imageGen: schema.models.imageGen })
          .from(schema.models).where(eq(schema.models.id, id)).get();
        if (!m || m.imageGen) return reply.code(400).send({ error: '追问模型无效,请选择一个文本模型' });
      }
      setSetting(FOLLOWUP_MODEL_KEY, id ?? '');
    }
    if (body.data.imageRetentionDays !== undefined || body.data.chatImageRetentionDays !== undefined) {
      // A shortened window should take effect now, not at the next hourly tick.
      sweepExpiredImages();
    }
    return settingsView();
  });

  app.get('/api/usage/me', async (req, reply) => {
    requireAuth(req, reply);
    const cutoff = now() - 30 * DAY_MS;
    const where = and(eq(schema.usageLog.userId, req.user!.id), gte(schema.usageLog.createdAt, cutoff));
    const { byDay, byModel, totals } = usageAggregates(where, 10);
    const me = db.select({ role: schema.users.role, monthlyTokenQuota: schema.users.monthlyTokenQuota })
      .from(schema.users).where(eq(schema.users.id, req.user!.id)).get();
    const limit = me ? effectiveQuota(me) : null;
    return {
      days: 30, byDay, byModel, totals,
      quota: { limit, used: limit !== null ? monthTokens(req.user!.id) : 0 },
    };
  });
}
