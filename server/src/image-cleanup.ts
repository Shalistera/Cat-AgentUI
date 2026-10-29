// Housekeeping for the per-user generated-image quota: the "used / limit"
// summary the gallery shows, the bulk 清理空间 action, and the opt-in 自动清理
// that makes room for new pictures by deleting the user's oldest workshop
// images. Chat-born images are never removed automatically — losing one
// punches a hole in a conversation (same reasoning as retention.ts) — and the
// bulk action only touches them when the user ticks the box.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { and, asc, eq, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema } from './db/index.js';
import { quotaErrorMessage, sumImages, tryReserveStorage, type ReserveResult } from './storage.js';

/** users.settings flag: delete the oldest workshop images when a new one would not fit. */
export const IMAGE_AUTO_CLEAN_KEY = 'imageAutoClean';

export function imageAutoCleanEnabled(userId: string): boolean {
  const row = db.select({ settings: schema.users.settings }).from(schema.users)
    .where(eq(schema.users.id, userId)).get();
  if (!row) return false;
  try { return (JSON.parse(row.settings) as Record<string, unknown>)[IMAGE_AUTO_CLEAN_KEY] === true; }
  catch { return false; }
}

function workshopBytes(userId: string): number {
  return db.select({ n: sql<number>`coalesce(sum(${schema.images.byteSize}), 0)` })
    .from(schema.images)
    .where(and(eq(schema.images.userId, userId), eq(schema.images.source, 'workshop')))
    .get()?.n ?? 0;
}

/**
 * Reserve worst-case room for generated images. With 自动清理 on, the user's
 * workshop images count as headroom: the job is admitted on the promise that
 * trimImagesToQuota() deletes just enough of the oldest ones once the real
 * (usually far smaller than worst-case) pictures are saved. A job that fails
 * deletes nothing.
 */
export function tryReserveImageStorage(userId: string, bytes: number): ReserveResult {
  const allowance = imageAutoCleanEnabled(userId) ? workshopBytes(userId) : 0;
  return tryReserveStorage(userId, 'image', bytes, allowance);
}

/** Body for a refused image reservation; `code` lets the client offer 清理空间. */
export function imageQuotaError(userId: string, reason: 'user' | 'global'): { error: string; code: string } {
  if (reason === 'global') return { error: quotaErrorMessage('image', 'global'), code: 'storage_full' };
  return {
    error: imageAutoCleanEnabled(userId)
      ? '图片存储空间不足,自动清理也腾不出足够空间(对话里生成的图片不会被自动删除),请到作品集手动清理'
      : quotaErrorMessage('image', 'user'),
    code: 'image_quota',
  };
}

/** False means the file is still on disk: keep its row so nothing is orphaned. */
function unlinkImageFile(filename: string): boolean {
  try {
    fs.unlinkSync(path.join(config.dataDir, 'images', filename));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    console.log(`[images] keep ${filename}: unlink failed (${(err as Error).message})`);
    return false;
  }
}

/**
 * 自动清理, run after new pictures are saved: delete the user's oldest workshop
 * images until they are back within the quota. Only images older than
 * `before` (the job's reservation time) qualify, so another job's fresh output
 * is never what goes. Synchronous on purpose — two jobs finishing together
 * cannot interleave over the same rows. Returns the deleted ids so the caller
 * can drop them from what it shows.
 */
export function trimImagesToQuota(userId: string, before: number): string[] {
  if (!imageAutoCleanEnabled(userId)) return [];
  let excess = sumImages(userId) - config.maxUserImageBytes;
  if (excess <= 0) return [];
  const removed: string[] = [];
  const stuck: string[] = [];
  let freed = 0;
  while (excess > 0) {
    const batch = db.select({ id: schema.images.id, filename: schema.images.filename, byteSize: schema.images.byteSize })
      .from(schema.images)
      .where(and(
        eq(schema.images.userId, userId),
        eq(schema.images.source, 'workshop'),
        lt(schema.images.createdAt, before),
        stuck.length ? notInArray(schema.images.id, stuck) : undefined,
      ))
      .orderBy(asc(schema.images.createdAt), asc(schema.images.id))
      .limit(100).all();
    if (!batch.length) break;
    for (const row of batch) {
      if (excess <= 0) break;
      if (!unlinkImageFile(row.filename)) { stuck.push(row.id); continue; }
      db.delete(schema.images).where(eq(schema.images.id, row.id)).run();
      removed.push(row.id);
      excess -= row.byteSize;
      freed += row.byteSize;
    }
  }
  if (removed.length) console.log(`[images] auto-clean removed ${removed.length} image(s) for user ${userId}, freed ${freed} bytes`);
  return removed;
}

export interface ImageStorageSummary {
  used: number;
  limit: number;
  count: number;
  /** Chat-born share of the above — the part 自动清理 leaves alone. */
  chat: { count: number; bytes: number };
  oldestAt: number | null;
  /** Free space a single new image needs before generation may start. */
  reservePerImage: number;
  autoClean: boolean;
}

export function imageStorageSummary(userId: string): ImageStorageSummary {
  const rows = db.select({
    source: schema.images.source,
    n: sql<number>`count(*)`,
    bytes: sql<number>`coalesce(sum(${schema.images.byteSize}), 0)`,
    oldest: sql<number | null>`min(${schema.images.createdAt})`,
  }).from(schema.images).where(eq(schema.images.userId, userId)).groupBy(schema.images.source).all();
  const chat = rows.find((r) => r.source === 'chat');
  const oldest = rows.map((r) => r.oldest).filter((v): v is number => v != null);
  return {
    used: rows.reduce((n, r) => n + r.bytes, 0),
    limit: config.maxUserImageBytes,
    count: rows.reduce((n, r) => n + r.n, 0),
    chat: { count: chat?.n ?? 0, bytes: chat?.bytes ?? 0 },
    oldestAt: oldest.length ? Math.min(...oldest) : null,
    reservePerImage: config.maxGeneratedImageBytes,
    autoClean: imageAutoCleanEnabled(userId),
  };
}

/**
 * The cleanup dialog's default "delete the oldest N": enough that afterwards a
 * tenth of the quota is free and at least two new images fit, counted on the
 * real sizes oldest first — capped at half the gallery so a default never
 * proposes wiping it.
 */
export function suggestedCleanupCount(userId: string, s: ImageStorageSummary): number {
  const sizes = db.select({ bytes: schema.images.byteSize }).from(schema.images)
    .where(and(eq(schema.images.userId, userId), eq(schema.images.source, 'workshop')))
    .orderBy(asc(schema.images.createdAt), asc(schema.images.id)).all();
  if (!sizes.length) return 0;
  const target = Math.max(s.limit * 0.1, s.reservePerImage * 2);
  const toFree = Math.max(target - (s.limit - s.used), s.limit * 0.1);
  let n = 0;
  for (let freed = 0; n < sizes.length && freed < toFree; n++) freed += sizes[n].bytes;
  return Math.max(1, Math.min(Math.ceil(n / 10) * 10, Math.ceil(sizes.length / 2)));
}

// ---- 清理空间: bulk delete by age ----

const criteriaCommon = {
  /** Also delete chat-born images (they vanish from their conversations). */
  includeChat: z.boolean().optional(),
  /** Newest createdAt the preview showed — new images never sneak into the delete. */
  upTo: z.number().int().nonnegative().optional(),
  dryRun: z.boolean().optional(),
};
export const cleanupSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('oldest'), count: z.number().int().min(1).max(100_000), ...criteriaCommon }),
  z.object({ mode: z.literal('before'), before: z.number().int().nonnegative(), ...criteriaCommon }),
]);
export type CleanupCriteria = z.infer<typeof cleanupSchema>;

/** Oldest first — the same rows for the preview and for the delete. */
function cleanupRows(userId: string, c: CleanupCriteria) {
  const q = db.select({
    id: schema.images.id, filename: schema.images.filename, byteSize: schema.images.byteSize,
    createdAt: schema.images.createdAt, source: schema.images.source,
  }).from(schema.images)
    .where(and(
      eq(schema.images.userId, userId),
      c.includeChat ? undefined : eq(schema.images.source, 'workshop'),
      c.mode === 'before' ? lt(schema.images.createdAt, c.before) : undefined,
      c.upTo !== undefined ? lte(schema.images.createdAt, c.upTo) : undefined,
    ))
    .orderBy(asc(schema.images.createdAt), asc(schema.images.id));
  return c.mode === 'oldest' ? q.limit(c.count).all() : q.all();
}

const SAMPLE_EACH_END = 3;

export interface CleanupPreview {
  count: number;
  bytes: number;
  /** How many of them were generated inside conversations. */
  chat: number;
  from: number | null;
  to: number | null;
  /** A few thumbnails from both ends of the range, oldest first. */
  samples: { id: string; prompt: string; createdAt: number }[];
}

export function previewCleanup(userId: string, c: CleanupCriteria): CleanupPreview {
  const rows = cleanupRows(userId, c);
  const ends = rows.length <= SAMPLE_EACH_END * 2
    ? rows
    : [...rows.slice(0, SAMPLE_EACH_END), ...rows.slice(-SAMPLE_EACH_END)];
  const prompts = ends.length
    ? new Map(db.select({ id: schema.images.id, prompt: schema.images.prompt }).from(schema.images)
      .where(inArray(schema.images.id, ends.map((r) => r.id))).all().map((r) => [r.id, r.prompt]))
    : new Map<string, string>();
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + r.byteSize, 0),
    chat: rows.filter((r) => r.source === 'chat').length,
    from: rows[0]?.createdAt ?? null,
    to: rows.at(-1)?.createdAt ?? null,
    samples: ends.map((r) => ({ id: r.id, prompt: prompts.get(r.id) ?? '', createdAt: r.createdAt })),
  };
}

export async function runCleanup(userId: string, c: CleanupCriteria): Promise<{ deleted: number; bytes: number }> {
  const rows = cleanupRows(userId, c);
  let deleted = 0;
  let bytes = 0;
  // Chunked so a cleanup of thousands of files lets other requests in between.
  for (let i = 0; i < rows.length; i += 200) {
    const gone: string[] = [];
    for (const row of rows.slice(i, i + 200)) {
      if (!unlinkImageFile(row.filename)) continue;
      gone.push(row.id);
      bytes += row.byteSize;
    }
    if (gone.length) {
      deleted += db.delete(schema.images)
        .where(and(eq(schema.images.userId, userId), inArray(schema.images.id, gone))).run().changes;
    }
    if (i + 200 < rows.length) await new Promise((resolve) => setImmediate(resolve));
  }
  if (deleted) console.log(`[images] cleanup removed ${deleted} image(s) for user ${userId}, freed ${bytes} bytes`);
  return { deleted, bytes };
}
