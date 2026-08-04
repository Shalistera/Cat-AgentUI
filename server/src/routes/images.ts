import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { recordUsage } from '../usage.js';
import { readUploadBase64 } from './uploads.js';
import type { GeneratedImage } from '../types.js';

const generateSchema = z.object({
  modelId: z.string(),
  prompt: z.string().min(1).max(4000),
  size: z.string().max(20).optional(),
  quality: z.string().max(20).optional(),
  n: z.number().int().min(1).max(4).optional(),
  inputUploadIds: z.array(z.string()).max(4).optional(),
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

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

export interface SavedImage {
  id: string; model: string; prompt: string; size: string | null;
  durationMs: number; createdAt: number; tokens: number | null;
}

// Write a generated image to disk + the gallery. Shared by the images page and
// by image-model turns inside a chat, so both end up in the same gallery.
export function saveGeneratedImage(opts: {
  userId: string; providerId: string; model: string; prompt: string;
  size: string | null; durationMs: number; img: GeneratedImage;
}): SavedImage {
  const id = newId();
  const filename = `${id}.${extForMime(opts.img.mime)}`;
  fs.writeFileSync(path.join(config.dataDir, 'images', filename), Buffer.from(opts.img.dataBase64, 'base64'));
  const createdAt = now();
  db.insert(schema.images).values({
    id,
    userId: opts.userId,
    providerId: opts.providerId,
    model: opts.model,
    prompt: opts.prompt,
    size: opts.size,
    filename,
    durationMs: opts.durationMs,
    createdAt,
  }).run();
  return {
    id, model: opts.model, prompt: opts.prompt, size: opts.size,
    durationMs: opts.durationMs, createdAt, tokens: opts.img.usage?.totalTokens ?? null,
  };
}

// Read a generated image back as base64 so it can be replayed as conversation
// context. Ownership is enforced; filename comes from the DB row, never input.
export function readImageBase64(imageId: string, userId: string): { mime: string; dataBase64: string } | null {
  const row = db.select().from(schema.images).where(eq(schema.images.id, imageId)).get();
  if (!row || row.userId !== userId) return null;
  try {
    const buf = fs.readFileSync(path.join(config.dataDir, 'images', row.filename));
    const ext = path.extname(row.filename).slice(1).toLowerCase();
    return { mime: MIME_BY_EXT[ext] ?? 'image/png', dataBase64: buf.toString('base64') };
  } catch {
    return null;
  }
}

export async function imageRoutes(app: FastifyInstance) {
  app.get('/api/images/models', async (req, reply) => {
    requireAuth(req, reply);
    return db.select({
      id: schema.models.id,
      modelId: schema.models.modelId,
      displayName: schema.models.displayName,
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

    const adapter = getAdapter(provider.type);
    if (!adapter.generateImages) {
      return reply.code(400).send({ error: '该 Provider 不支持图像生成' });
    }

    let inputImages: { mime: string; dataBase64: string }[] | undefined;
    if (inputUploadIds && inputUploadIds.length > 0) {
      inputImages = [];
      for (const uploadId of inputUploadIds) {
        const img = readUploadBase64(uploadId, req.user!.id);
        if (!img) return reply.code(400).send({ error: '输入图片不存在' });
        inputImages.push(img);
      }
    }

    const userId = req.user!.id;
    const job: ImageJob = { id: newId(), userId, createdAt: Date.now(), status: 'running' };
    jobs.set(job.id, job);
    cleanupJobs();

    void (async () => {
      const t0 = Date.now();
      const signal = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
      try {
        const generated = await adapter.generateImages!(toRuntimeConfig(provider), {
          model: model.modelId, prompt, size, quality, n, signal, inputImages,
        });
        const durationMs = Date.now() - t0;

        const saved = generated.map((img) => saveGeneratedImage({
          userId,
          providerId: provider.id,
          model: model.modelId,
          prompt,
          size: size ?? null,
          durationMs,
          img,
        }));

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
      } catch (err) {
        // Adapter errors are already human-readable — pass through as-is.
        job.error = err instanceof Error ? err.message : String(err);
        job.status = 'error';
      }
    })();

    return { jobId: job.id };
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
    const row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
    if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) {
      return reply.code(404).send({ error: '图片不存在' });
    }
    // Filename comes from the DB row, never from user path input.
    const filePath = path.join(config.dataDir, 'images', row.filename);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: '图片不存在' });
    const ext = path.extname(row.filename).slice(1).toLowerCase();
    reply.header('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
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
}
