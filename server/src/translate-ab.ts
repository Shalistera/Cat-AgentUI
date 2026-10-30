// 翻译工坊 A/B 对比 — the parts that outlive one request.
//
// A comparison row is written as soon as both models finish, so the admin can
// see how often comparisons are shown versus voted on. The texts themselves
// (原文, both 译文, the 场景 sentence) are held here in memory and only reach
// the database when the person votes: someone who ignores the comparison
// leaves nothing of what they translated behind. A restart drops the held
// texts; a later vote still counts, just without them.
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const HOLD_TTL_MS = 12 * 3600_000;
const HOLD_MAX = 200;
// The page only ever offers a vote on its latest comparison; a few per person
// covers several open tabs.
const HOLD_PER_USER = 3;

export interface HeldTexts {
  userId: string;
  sourceText: string;
  outputA: string;
  outputB: string;
  scene: string;
}

const held = new Map<string, HeldTexts & { expiresAt: number }>();

export function holdTexts(id: string, texts: HeldTexts) {
  const t = Date.now();
  const mine: string[] = [];
  for (const [key, v] of held) {
    if (v.expiresAt <= t) held.delete(key);
    else if (v.userId === texts.userId) mine.push(key);
  }
  for (const key of mine.slice(0, Math.max(0, mine.length - HOLD_PER_USER + 1))) held.delete(key);
  held.set(id, { ...texts, expiresAt: t + HOLD_TTL_MS });
  // Map iteration is insertion order: the first key is the oldest.
  while (held.size > HOLD_MAX) held.delete(held.keys().next().value!);
}

/** The texts of one comparison, once, and only for the person it belongs to. */
export function takeTexts(id: string, userId: string): HeldTexts | null {
  const v = held.get(id);
  if (!v || v.userId !== userId) return null;
  held.delete(id);
  return v.expiresAt > Date.now() ? v : null;
}

/** What the admin reads for a model: its name plus the provider it runs on. */
export function modelLabel(m: { displayName: string | null; modelId: string }, providerName: string): string {
  return `${m.displayName || m.modelId} · ${providerName}`;
}

function currentLabels(ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = db.select({ id: schema.models.id, displayName: schema.models.displayName, modelId: schema.models.modelId, provider: schema.providers.name })
    .from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(inArray(schema.models.id, ids)).all();
  return new Map(rows.map((r) => [r.id, modelLabel(r, r.provider)]));
}

const t = schema.translateAbTrials;

/** One line per model pair, newest activity first. */
export function abSummary() {
  const rows = db.select({
    modelA: t.modelA,
    modelB: t.modelB,
    labelA: sql<string>`max(${t.labelA})`,
    labelB: sql<string>`max(${t.labelB})`,
    shown: sql<number>`count(*)`,
    voted: sql<number>`coalesce(sum(case when ${t.vote} is not null then 1 else 0 end), 0)`,
    winsA: sql<number>`coalesce(sum(case when ${t.vote} = 'a' then 1 else 0 end), 0)`,
    winsB: sql<number>`coalesce(sum(case when ${t.vote} = 'b' then 1 else 0 end), 0)`,
    ties: sql<number>`coalesce(sum(case when ${t.vote} = 'tie' then 1 else 0 end), 0)`,
    // Picks of whichever translation was shown first — far from half means
    // position, not quality, is steering the votes.
    firstPicked: sql<number>`coalesce(sum(case when (${t.vote} = 'a' and ${t.swapped} = 0) or (${t.vote} = 'b' and ${t.swapped} = 1) then 1 else 0 end), 0)`,
    avgDurationA: sql<number>`coalesce(avg(${t.durationA}), 0)`,
    avgDurationB: sql<number>`coalesce(avg(${t.durationB}), 0)`,
    avgTokensA: sql<number>`coalesce(avg(${t.tokensA}), 0)`,
    avgTokensB: sql<number>`coalesce(avg(${t.tokensB}), 0)`,
    firstAt: sql<number>`min(${t.createdAt})`,
    lastAt: sql<number>`max(${t.createdAt})`,
  }).from(t).groupBy(t.modelA, t.modelB).orderBy(desc(sql`max(${t.createdAt})`)).all();
  const labels = currentLabels([...new Set(rows.flatMap((r) => [r.modelA, r.modelB]))]);
  return rows.map((r) => ({
    ...r,
    labelA: labels.get(r.modelA) ?? r.labelA,
    labelB: labels.get(r.modelB) ?? r.labelB,
    removedA: !labels.has(r.modelA),
    removedB: !labels.has(r.modelB),
    avgDurationA: Math.round(r.avgDurationA),
    avgDurationB: Math.round(r.avgDurationB),
    avgTokensA: Math.round(r.avgTokensA),
    avgTokensB: Math.round(r.avgTokensB),
  }));
}

export const AB_PAGE_SIZE = 20;

export function abTrials(opts: { modelA?: string; modelB?: string; votedOnly: boolean; page: number }) {
  const where = and(
    opts.modelA ? eq(t.modelA, opts.modelA) : undefined,
    opts.modelB ? eq(t.modelB, opts.modelB) : undefined,
    opts.votedOnly ? isNotNull(t.vote) : undefined,
  );
  const total = db.select({ n: sql<number>`count(*)` }).from(t).where(where).get()?.n ?? 0;
  const rows = db.select({
    id: t.id, userId: t.userId, modelA: t.modelA, modelB: t.modelB, labelA: t.labelA, labelB: t.labelB,
    reasoningA: t.reasoningA, reasoningB: t.reasoningB, swapped: t.swapped, mode: t.mode,
    sourceLang: t.sourceLang, targetLang: t.targetLang, sourceChars: t.sourceChars, vote: t.vote,
    preview: sql<string | null>`substr(${t.sourceText}, 1, 120)`,
    createdAt: t.createdAt, votedAt: t.votedAt,
    username: schema.users.username, displayName: schema.users.displayName,
  }).from(t)
    .leftJoin(schema.users, eq(t.userId, schema.users.id))
    .where(where)
    .orderBy(desc(t.createdAt))
    .limit(AB_PAGE_SIZE).offset(opts.page * AB_PAGE_SIZE)
    .all();
  return {
    total,
    pageSize: AB_PAGE_SIZE,
    items: rows.map(({ username, displayName, swapped, ...r }) => ({
      ...r,
      swapped: !!swapped,
      user: { id: r.userId, username: username ?? '(已删除)', displayName: displayName ?? null },
    })),
  };
}

export function abTrial(id: string) {
  const row = db.select().from(t).leftJoin(schema.users, eq(t.userId, schema.users.id)).where(eq(t.id, id)).get();
  if (!row) return null;
  const r = row.translate_ab_trials;
  return {
    ...r,
    swapped: !!r.swapped,
    user: { id: r.userId, username: row.users?.username ?? '(已删除)', displayName: row.users?.displayName ?? null },
  };
}

export function clearAbTrials(modelA?: string, modelB?: string): number {
  const where = modelA && modelB ? and(eq(t.modelA, modelA), eq(t.modelB, modelB)) : undefined;
  const ids = db.select({ id: t.id }).from(t).where(where).all().map((r) => r.id);
  for (const id of ids) held.delete(id);
  return db.delete(t).where(where).run().changes;
}
