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

// ---------------------------------------------------------------------------
// Per-model usage limits (models.limit_*). Independent of the monthly quota:
// each ordinary account gets its own daily/weekly allowance of requests
// and/or tokens on a given model. Admins are exempt, like everywhere else.
// ---------------------------------------------------------------------------

export type LimitPeriod = 'day' | 'week';

export function parseLimitPeriod(v: string | null | undefined): LimitPeriod {
  return v === 'week' ? 'week' : 'day';
}

/** Monday of the current week (local server time), in usage_log day format. */
export function weekStartDay(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function limitWindowStart(period: LimitPeriod): string {
  return period === 'week' ? weekStartDay() : today();
}

export interface ModelLimitSpec {
  providerId: string;
  modelId: string; // API model name — what usage_log.model stores
  displayName?: string | null;
  limitPeriod: string;
  limitRequests: number | null;
  limitTokens: number | null;
}

export function hasModelLimit(m: Pick<ModelLimitSpec, 'limitRequests' | 'limitTokens'>): boolean {
  return (m.limitRequests ?? 0) > 0 || (m.limitTokens ?? 0) > 0;
}

/**
 * Consumption of one (provider, model) by one user since `since`. Requests
 * only count what the person initiated — auto titles and follow-up
 * suggestions ride along a chat turn and must not eat a 10-a-day allowance
 * three at a time. Tokens count everything, they are the actual cost.
 */
export function modelWindowUsage(userId: string, providerId: string, modelId: string, since: string): {
  requests: number; tokens: number;
} {
  const row = db.select({
    requests: sql<number>`coalesce(sum(case when ${schema.usageLog.kind} in ('title', 'followup') then 0 else 1 end), 0)`,
    tokens: sql<number>`coalesce(sum(${schema.usageLog.totalTokens}), 0)`,
  }).from(schema.usageLog)
    .where(and(
      eq(schema.usageLog.userId, userId),
      gte(schema.usageLog.day, since),
      eq(schema.usageLog.providerId, providerId),
      eq(schema.usageLog.model, modelId),
    )).get();
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
}

export interface ModelLimitVerdict {
  ok: boolean;
  period: LimitPeriod;
  requests: { used: number; limit: number } | null;
  tokens: { used: number; limit: number } | null;
  /** The axis that tripped (requests are checked first); null while ok. */
  exceeded: 'requests' | 'tokens' | null;
}

/**
 * Checkpoint for every request that names a model. Cheap when the model has
 * no limit (no query), so it is safe to call unconditionally.
 */
export function checkModelLimit(user: { id: string; role: string }, model: ModelLimitSpec): ModelLimitVerdict {
  const period = parseLimitPeriod(model.limitPeriod);
  const base: ModelLimitVerdict = { ok: true, period, requests: null, tokens: null, exceeded: null };
  if (user.role === 'admin' || !hasModelLimit(model)) return base;
  const used = modelWindowUsage(user.id, model.providerId, model.modelId, limitWindowStart(period));
  const reqLimit = model.limitRequests ?? 0;
  const tokLimit = model.limitTokens ?? 0;
  const v: ModelLimitVerdict = {
    ...base,
    requests: reqLimit > 0 ? { used: used.requests, limit: reqLimit } : null,
    tokens: tokLimit > 0 ? { used: used.tokens, limit: tokLimit } : null,
  };
  if (v.requests && v.requests.used >= v.requests.limit) v.exceeded = 'requests';
  else if (v.tokens && v.tokens.used >= v.tokens.limit) v.exceeded = 'tokens';
  v.ok = v.exceeded === null;
  return v;
}

/** "「GPT-5」今日使用次数已达上限(10 / 10 次),明天 0 点后恢复" — no advice attached. */
export function modelLimitReason(model: Pick<ModelLimitSpec, 'modelId' | 'displayName'>, v: ModelLimitVerdict): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const name = model.displayName || model.modelId;
  const span = v.period === 'week' ? '本周' : '今日';
  const reset = v.period === 'week' ? '下周一 0 点后恢复' : '明天 0 点后恢复';
  if (v.exceeded === 'tokens' && v.tokens) {
    return `「${name}」${span} token 用量已达上限(已用 ${fmt(v.tokens.used)} / 上限 ${fmt(v.tokens.limit)}),${reset}`;
  }
  const r = v.requests ?? { used: 0, limit: 0 };
  return `「${name}」${span}使用次数已达上限(${fmt(r.used)} / ${fmt(r.limit)} 次),${reset}`;
}

export function modelLimitBlockMessage(
  model: Pick<ModelLimitSpec, 'modelId' | 'displayName'>, v: ModelLimitVerdict, advice = '请换用其他模型',
): string {
  const reason = modelLimitReason(model, v);
  return advice ? `${reason},${advice}` : reason;
}
