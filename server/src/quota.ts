import { and, eq, gte, sql } from 'drizzle-orm';
import { db, schema, getSetting, today } from './db/index.js';

// App-wide quota settings (app_settings keys). The per-user column overrides
// the default; admins are exempt from all of it.
export const QUOTA_DEFAULT_KEY = 'quota_monthly_tokens'; // number, 0 = unlimited
export const QUOTA_ACTION_KEY = 'quota_action'; // 'block' | 'downgrade'
export const QUOTA_FALLBACK_KEY = 'quota_fallback_model'; // models.id, '' = unset

export type QuotaAction = 'block' | 'downgrade';

export function quotaSettings(): { defaultQuota: number; action: QuotaAction; fallbackModelId: string } {
  const action = getSetting<string>(QUOTA_ACTION_KEY, 'block');
  return {
    defaultQuota: Math.max(0, Math.floor(getSetting<number>(QUOTA_DEFAULT_KEY, 0)) || 0),
    action: action === 'downgrade' ? 'downgrade' : 'block',
    fallbackModelId: getSetting<string>(QUOTA_FALLBACK_KEY, ''),
  };
}

/** First day of the current month, in usage_log's YYYY-MM-DD day format. */
export function monthStartDay(): string {
  return `${today().slice(0, 7)}-01`;
}

/** Tokens this user has consumed since the 1st of the current month. */
export function monthTokens(userId: string): number {
  const row = db.select({ total: sql<number>`coalesce(sum(${schema.usageLog.totalTokens}), 0)` })
    .from(schema.usageLog)
    .where(and(eq(schema.usageLog.userId, userId), gte(schema.usageLog.day, monthStartDay())))
    .get();
  return row?.total ?? 0;
}

/** The cap that applies to this user, or null when unlimited. */
export function effectiveQuota(user: { role: string; monthlyTokenQuota: number | null }): number | null {
  if (user.role === 'admin') return null;
  const limit = user.monthlyTokenQuota ?? quotaSettings().defaultQuota;
  return limit > 0 ? limit : null;
}

export interface QuotaVerdict {
  ok: boolean;
  used: number;
  limit: number | null;
  action: QuotaAction;
  fallbackModelId: string;
}

/**
 * The single checkpoint for every token-consuming endpoint. Reads the user row
 * fresh so a just-changed quota takes effect on the next request.
 */
export function checkQuota(userId: string): QuotaVerdict {
  const settings = quotaSettings();
  const user = db.select({
    role: schema.users.role,
    monthlyTokenQuota: schema.users.monthlyTokenQuota,
  }).from(schema.users).where(eq(schema.users.id, userId)).get();
  const base = { action: settings.action, fallbackModelId: settings.fallbackModelId };
  if (!user) return { ok: false, used: 0, limit: 0, ...base };
  const limit = effectiveQuota(user);
  if (limit === null) return { ok: true, used: 0, limit: null, ...base };
  const used = monthTokens(userId);
  return { ok: used < limit, used, limit, ...base };
}

export function quotaBlockMessage(v: QuotaVerdict): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  return `本月 token 配额已用完(已用 ${fmt(v.used)} / 上限 ${fmt(v.limit ?? 0)}),下月 1 日自动恢复,如有需要请联系管理员调整`;
}
