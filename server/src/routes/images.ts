import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { recordUsage } from '../usage.js';
import { accessibleOnly, canUseModel } from '../model-access.js';
import { checkQuota, quotaBlockMessage } from '../quota.js';
import type { GeneratedImage } from '../types.js';
import { tryAcquireImageJob } from '../admission.js';
import {
  decodeGeneratedImage, extForMime, getOwnedUploadMedia,
  MIME_BY_EXT, quotaErrorMessage, readMediaBase64, tryReserveStorage,
} from '../storage.js';

const generateSchema = z.object({
  modelId: z.string(),
  prompt: z.string().min(1).max(4000),
  size: z.string().max(20).optional(),
  quality: z.string().max(20).optional(),
  n: z.number().int().min(1).max(4).optional(),
  inputUploadIds: z.array(z.string().min(1).max(64)).max(config.maxAttachmentsPerMessage).optional(),
});

// Generation runs as a background job and the client polls for the result.
// A synchronous response can't work in production: Cloudflare cuts any
// request the origin hasn't answered within ~100s, and slow image models
// (multi-reference gpt-image especially) routinely take minutes.
const GENERATE_TIMEOUT_MS = 600_000;
const JOB_TTL_MS = 30 * 60 * 1000;

interface ImageJob {
  id: string;
  userId: string;
  createdAt: number;
  status: 'running' | 'done' | 'error';
  images?: SavedImage[];
  error?: string;
}

const jobs = new Map<string, ImageJob>();

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.createdAt < cutoff) jobs.delete(id);
  }
}
export interface SavedImage {
  id: string; model: string; prompt: string; size: string | null;
  durationMs: number; createdAt: number; tokens: number | null;
}

// Write a generated image to disk + the gallery. Shared by the images page and
// by image-model turns inside a chat, so both end up in the same gallery.
export async function saveGeneratedImage(opts: {
  userId: string; providerId: string; model: string; prompt: string;
  size: string | null; durationMs: number; img: GeneratedImage;
  /** Birthplace decides which retention policy applies — see schema note. */
  source: 'workshop' | 'chat';
}): Promise<SavedImage> {
  const decoded = decodeGeneratedImage(opts.img.dataBase64, opts.img.mime);
  const id = newId();
  const filename = `${id}.${extForMime(decoded.mime)}`;
  const filePath = path.join(config.dataDir, 'images', filename);
  await fs.promises.writeFile(filePath, decoded.buffer, { flag: 'wx' });
  const createdAt = now();
  try {
    db.insert(schema.images).values({
      id,
      userId: opts.userId,
      providerId: opts.providerId,
      model: opts.model,
      source: opts.source,
      prompt: opts.prompt,
      size: opts.size,
      filename,
      byteSize: decoded.buffer.length,
      durationMs: opts.durationMs,
      createdAt,
    }).run();
  } catch (err) {
    try { await fs.promises.unlink(filePath); } catch { /* best effort */ }
    throw err;
  }
  return {
    id, model: opts.model, prompt: opts.prompt, size: opts.size,
    durationMs: opts.durationMs, createdAt, tokens: opts.img.usage?.totalTokens ?? null,
  };
}

async function rollbackSavedImages(saved: SavedImage[]): Promise<void> {
  for (const item of saved) {
    const row = db.select().from(schema.images).where(eq(schema.images.id, item.id)).get();
    if (!row) continue;
    db.delete(schema.images).where(eq(schema.images.id, item.id)).run();
    try { await fs.promises.unlink(path.join(config.dataDir, 'images', row.filename)); }
    catch { /* best effort: leaves an unreferenced file, never a broken DB row */ }
  }
}

export async function imageRoutes(app: FastifyInstance) {
  app.get('/api/images/models', async (req, reply) => {
    requireAuth(req, reply);
    const rows = db.select({
      id: schema.models.id,
      modelId: schema.models.modelId,
      displayName: schema.models.displayName,
      accessMode: schema.models.accessMode,
      providerName: schema.providers.name,
      providerType: schema.providers.type,
    }).from(schema.models)
      .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
      .where(and(
        eq(schema.models.imageGen, 1),
        eq(schema.models.enabled, 1),
        eq(schema.providers.enabled, 1),
      ))
      .orderBy(schema.models.sortOrder)
      .all();
    return accessibleOnly(rows, req.user!).map(({ accessMode: _, ...m }) => m);
  });

  app.post('/api/images/generate', async (req, reply) => {
    requireAuth(req, reply);
    const body = generateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const { modelId, prompt, size, quality, n, inputUploadIds } = body.data;

    const model = db.select().from(schema.models)
      .where(and(
        eq(schema.models.id, modelId),
        eq(schema.models.enabled, 1),
        eq(schema.models.imageGen, 1),
      )).get();
    if (!model) return reply.code(400).send({ error: '模型不可用' });

    const provider = db.select().from(schema.providers)
      .where(and(eq(schema.providers.id, model.providerId), eq(schema.providers.enabled, 1))).get();
    if (!provider) return reply.code(400).send({ error: '模型不可用' });
    if (!canUseModel(req.user!, model.id)) {
      return reply.code(403).send({ error: '该模型未对你开放' });
    }
    // Image generation has no cheaper fallback, so over-quota always refuses.
    const quota = checkQuota(req.user!.id);
    if (!quota.ok) return reply.code(429).send({ error: quotaBlockMessage(quota) });

    const adapter = getAdapter(provider.type);
    if (!adapter.generateImages) {
      return reply.code(400).send({ error: '该 Provider 不支持图像生成' });
    }

    const imageLease = tryAcquireImageJob(req.user!.id);
    if (!imageLease) {
      return reply.code(429).send({ error: '图片生成并发数已达上限,请等待当前任务完成' });
    }
    const requestedN = n ?? 1;
    const reserved = tryReserveStorage(
      req.user!.id, 'image', requestedN * config.maxGeneratedImageBytes,
    );
    if (!reserved.ok) {
      imageLease.release();
      return reply.code(413).send({ error: quotaErrorMessage('image', reserved.reason) });
    }

    const reservation = reserved.reservation;
    let handedOff = false;
    try {
      let inputImages: { mime: string; dataBase64: string }[] | undefined;
      const uniqueUploadIds = [...new Set(inputUploadIds ?? [])];
      if (uniqueUploadIds.length > 0) {
        inputImages = [];
        let inputBytes = 0;
        for (const uploadId of uniqueUploadIds) {
          const media = await getOwnedUploadMedia(uploadId, req.user!.id);
          if (!media) return reply.code(400).send({ error: '输入图片不存在' });
          inputBytes += media.size;
          if (inputBytes > config.maxMessageAttachmentBytes) {
            return reply.code(413).send({ error: '输入图片总大小超过限制' });
          }
          inputImages.push(await readMediaBase64(media, config.maxMessageAttachmentBytes));
        }
      }

      const userId = req.user!.id;
      const job: ImageJob = { id: newId(), userId, createdAt: Date.now(), status: 'running' };
      jobs.set(job.id, job);
      cleanupJobs();
      handedOff = true;
      console.log(`[img] job ${job.id} start model=${model.modelId} n=${requestedN} refs=${inputImages?.length ?? 0}`);

      void (async () => {
        const t0 = Date.now();
        const saved: SavedImage[] = [];
        try {
          const generated = await adapter.generateImages!(toRuntimeConfig(provider), {
            model: model.modelId, prompt, size, quality, n: requestedN,
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS), inputImages,
          });
          const durationMs = Date.now() - t0;
          if (!generated.length || generated.length > requestedN) {
            throw new Error('Provider 返回的图片数量异常');
          }
          for (const img of generated) {
            saved.push(await saveGeneratedImage({
              userId,
              providerId: provider.id,
              model: model.modelId,
              prompt,
              size: size ?? null,
              durationMs,
              img,
              source: 'workshop',
            }));
          }

          const usage = generated[0]?.usage;
          recordUsage({
            userId,
            providerId: provider.id,
            providerType: provider.type,
            model: model.modelId,
            kind: 'image',
            images: saved.length,
            promptTokens: usage?.promptTokens,
            completionTokens: usage?.completionTokens,
            totalTokens: usage?.totalTokens,
            durationMs,
          });

          job.images = saved;
          job.status = 'done';
          console.log(`[img] job ${job.id} done in ${(durationMs / 1000).toFixed(1)}s, ${saved.length} image(s)`);
        } catch (err) {
          if (saved.length) await rollbackSavedImages(saved);
          job.error = err instanceof Error && err.name === 'TimeoutError'
            ? '图片生成超时(超过 10 分钟)'
            : err instanceof Error ? err.message : String(err);
          job.status = 'error';
          console.log(`[img] job ${job.id} error after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${job.error}`);
        } finally {
          reservation.release();
          imageLease.release();
        }
      })();

      return { jobId: job.id };
    } finally {
      if (!handedOff) {
        reservation.release();
        imageLease.release();
      }
    }
  });

  // The client's submit response can get lost in transit (proxy hiccup, page
  // reload) while the job keeps running here — this lets it re-attach.
  app.get('/api/images/jobs/active', async (req, reply) => {
    requireAuth(req, reply);
    let latest: ImageJob | null = null;
    for (const j of jobs.values()) {
      if (j.userId !== req.user!.id || j.status !== 'running') continue;
      if (!latest || j.createdAt > latest.createdAt) latest = j;
    }
    return latest ? { jobId: latest.id, createdAt: latest.createdAt } : {};
  });

  app.get('/api/images/jobs/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job || job.userId !== req.user!.id) {
      return reply.code(404).send({ error: '任务不存在(服务可能已重启)' });
    }
    return { status: job.status, images: job.images, error: job.error };
  });

  app.get('/api/images', async (req, reply) => {
    requireAuth(req, reply);
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 40, 1), 100);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const rows = db.select().from(schema.images)
      .where(eq(schema.images.userId, req.user!.id))
      .orderBy(desc(schema.images.createdAt))
      .limit(limit).offset(offset).all();
    const total = db.select({ c: sql<number>`count(*)` }).from(schema.images)
      .where(eq(schema.images.userId, req.user!.id)).get()?.c ?? 0;
    return { images: rows, total };
  });

  app.get('/api/images/:id/file', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select({ ...getTableColumns(schema.images), rowid: sql<number>`rowid` })
      .from(schema.images).where(eq(schema.images.id, id)).get();
    if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) {
      return reply.code(404).send({ error: '图片不存在' });
    }
    // Filename comes from the DB row, never from user path input.
    const filePath = path.join(config.dataDir, 'images', row.filename);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: '图片不存在' });
    const ext = path.extname(row.filename).slice(1).toLowerCase();
    reply.header('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
    // A numbered download name — without this, `<a download>` saves as "file".
    // The rowid is a stable, monotonically assigned sequence number, and a
    // Content-Disposition filename outranks the anchor's download attribute.
    reply.header('content-disposition', `inline; filename="cat-image-${row.rowid}.${ext}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete('/api/images/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
    if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) {
      return reply.code(404).send({ error: '图片不存在' });
    }
    try {
      fs.unlinkSync(path.join(config.dataDir, 'images', row.filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    db.delete(schema.images).where(eq(schema.images.id, id)).run();
    return { ok: true };
  });

  // Batch delete for the gallery's manage mode. Silently skips ids that don't
  // exist or belong to someone else — the caller learns the real count.
  app.post('/api/images/batch-delete', async (req, reply) => {
    requireAuth(req, reply);
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ error: '参数错误' });
    }
    let deleted = 0;
    for (const id of (ids as string[]).slice(0, 500)) {
      const row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
      if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) continue;
      try {
        fs.unlinkSync(path.join(config.dataDir, 'images', row.filename));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      db.delete(schema.images).where(eq(schema.images.id, id)).run();
      deleted++;
    }
    return { ok: true, deleted };
  });
}
