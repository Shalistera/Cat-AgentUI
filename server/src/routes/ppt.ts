import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { recordUsage } from '../usage.js';
import { accessibleOnly, canUseModel } from '../model-access.js';
import { checkModelLimit, checkQuota, modelLimitBlockMessage, quotaBlockMessage } from '../quota.js';
import { buildDeckPrompt, parseDeckSpec, renderDeckPptx, type DeckSpec } from '../deck.js';
import { allConfiguredSecretValues, redactSensitiveText } from '../secrets.js';

const generateSchema = z.object({
  modelId: z.string(),
  topic: z.string().min(1).max(4000),
  slideCount: z.number().int().min(2).max(30).optional(),
});

// Same job/poll shape as image generation: a deck takes one long LLM call
// (often past any proxy's patience), so the client submits and polls.
const GENERATE_TIMEOUT_MS = 300_000;
const JOB_TTL_MS = 30 * 60 * 1000;

export interface DeckSummary {
  id: string; title: string; topic: string; model: string | null;
  slideCount: number; totalTokens: number | null; durationMs: number | null; createdAt: number;
}

interface PptJob {
  id: string;
  userId: string;
  createdAt: number;
  status: 'running' | 'done' | 'error';
  deck?: DeckSummary & { spec: DeckSpec };
  error?: string;
}

const jobs = new Map<string, PptJob>();

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.createdAt < cutoff) jobs.delete(id);
  }
}

function deckSummary(row: typeof schema.decks.$inferSelect): DeckSummary {
  return {
    id: row.id, title: row.title, topic: row.topic, model: row.model,
    slideCount: row.slideCount, totalTokens: row.totalTokens,
    durationMs: row.durationMs, createdAt: row.createdAt,
  };
}

export async function pptRoutes(app: FastifyInstance) {
  // Any enabled text model can write a deck spec — image models can't.
  app.get('/api/ppt/models', async (req, reply) => {
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
        eq(schema.models.imageGen, 0),
        eq(schema.models.enabled, 1),
        eq(schema.providers.enabled, 1),
      ))
      .orderBy(schema.models.sortOrder)
      .all();
    return accessibleOnly(rows, req.user!).map(({ accessMode: _, ...m }) => m);
  });

  app.post('/api/ppt/generate', async (req, reply) => {
    requireAuth(req, reply);
    const body = generateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const { modelId, topic, slideCount } = body.data;

    const model = db.select().from(schema.models)
      .where(and(
        eq(schema.models.id, modelId),
        eq(schema.models.enabled, 1),
        eq(schema.models.imageGen, 0),
      )).get();
    if (!model) return reply.code(400).send({ error: '模型不可用' });

    const provider = db.select().from(schema.providers)
      .where(and(eq(schema.providers.id, model.providerId), eq(schema.providers.enabled, 1))).get();
    if (!provider) return reply.code(400).send({ error: '模型不可用' });
    if (!canUseModel(req.user!, model.id)) {
      return reply.code(403).send({ error: '该模型未对你开放' });
    }
    // PPT jobs have no notice channel to explain a silent downgrade, so
    // over-quota always refuses here regardless of the configured action.
    const quota = checkQuota(req.user!.id);
    if (!quota.ok) return reply.code(429).send({ error: quotaBlockMessage(quota) });
    const modelLimit = checkModelLimit(req.user!, model);
    if (!modelLimit.ok) return reply.code(429).send({ error: modelLimitBlockMessage(model, modelLimit) });

    const userId = req.user!.id;
    const job: PptJob = { id: newId(), userId, createdAt: Date.now(), status: 'running' };
    jobs.set(job.id, job);
    cleanupJobs();
    console.log(`[ppt] job ${job.id} start model=${model.modelId}`);

    void (async () => {
      const t0 = Date.now();
      const secretValues = allConfiguredSecretValues();
      try {
        const adapter = getAdapter(provider.type);
        let text = '';
        const usage = { prompt: 0, completion: 0, total: 0 };
        for await (const ev of adapter.streamChat(toRuntimeConfig(provider), {
          model: model.modelId,
          messages: [{
            role: 'user',
            parts: [{ type: 'text', text: buildDeckPrompt(topic, slideCount ?? 10) }],
          }],
          maxTokens: 8000,
          signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        })) {
          if (ev.type === 'text') text += ev.text;
          else if (ev.type === 'usage') {
            usage.prompt += ev.usage.promptTokens ?? 0;
            usage.completion += ev.usage.completionTokens ?? 0;
            usage.total += ev.usage.totalTokens ?? 0;
          }
        }

        text = redactSensitiveText(text, secretValues);
        const spec = parseDeckSpec(text);
        const durationMs = Date.now() - t0;
        const id = newId();
        const row = {
          id,
          userId,
          providerId: provider.id,
          model: model.modelId,
          topic,
          title: spec.title,
          spec: JSON.stringify(spec),
          slideCount: spec.slides.length,
          totalTokens: usage.total || null,
          durationMs,
          createdAt: now(),
        };
        db.insert(schema.decks).values(row).run();

        recordUsage({
          userId,
          providerId: provider.id,
          providerType: provider.type,
          model: model.modelId,
          kind: 'ppt',
          promptTokens: usage.prompt,
          completionTokens: usage.completion,
          totalTokens: usage.total,
          durationMs,
        });

        job.deck = { ...deckSummary(row), spec };
        job.status = 'done';
        console.log(`[ppt] job ${job.id} done in ${(durationMs / 1000).toFixed(1)}s, ${spec.slides.length} slides`);
      } catch (err) {
        job.error = redactSensitiveText(
          err instanceof Error ? err.message : String(err),
          secretValues,
        );
        job.status = 'error';
        console.log(`[ppt] job ${job.id} error after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${job.error}`);
      }
    })();

    return { jobId: job.id };
  });

  app.get('/api/ppt/jobs/active', async (req, reply) => {
    requireAuth(req, reply);
    let latest: PptJob | null = null;
    for (const j of jobs.values()) {
      if (j.userId !== req.user!.id || j.status !== 'running') continue;
      if (!latest || j.createdAt > latest.createdAt) latest = j;
    }
    return latest ? { jobId: latest.id, createdAt: latest.createdAt } : {};
  });

  app.get('/api/ppt/jobs/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job || job.userId !== req.user!.id) {
      return reply.code(404).send({ error: '任务不存在(服务可能已重启)' });
    }
    return { status: job.status, deck: job.deck, error: job.error };
  });

  app.get('/api/ppt', async (req, reply) => {
    requireAuth(req, reply);
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const rows = db.select().from(schema.decks)
      .where(eq(schema.decks.userId, req.user!.id))
      .orderBy(desc(schema.decks.createdAt))
      .limit(limit).offset(offset).all();
    const total = db.select({ c: sql<number>`count(*)` }).from(schema.decks)
      .where(eq(schema.decks.userId, req.user!.id)).get()?.c ?? 0;
    return { decks: rows.map(deckSummary), total };
  });

  app.get('/api/ppt/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select().from(schema.decks).where(eq(schema.decks.id, id)).get();
    if (!row || row.userId !== req.user!.id) return reply.code(404).send({ error: '演示文稿不存在' });
    let spec: DeckSpec;
    try { spec = JSON.parse(row.spec) as DeckSpec; } catch {
      return reply.code(500).send({ error: '规格数据损坏' });
    }
    return { ...deckSummary(row), spec };
  });

  app.get('/api/ppt/:id/pptx', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select({ ...getTableColumns(schema.decks), rowid: sql<number>`rowid` })
      .from(schema.decks).where(eq(schema.decks.id, id)).get();
    if (!row || row.userId !== req.user!.id) return reply.code(404).send({ error: '演示文稿不存在' });
    const spec = parseDeckSpec(row.spec);
    const buf = await renderDeckPptx(spec);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    // ASCII fallback + RFC 5987 UTF-8 name so中文标题在各浏览器都能落个好文件名。
    const utf8Name = encodeURIComponent(`${spec.title}.pptx`);
    reply.header('content-disposition', `attachment; filename="cat-deck-${row.rowid}.pptx"; filename*=UTF-8''${utf8Name}`);
    return reply.send(buf);
  });

  app.delete('/api/ppt/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select().from(schema.decks).where(eq(schema.decks.id, id)).get();
    if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) {
      return reply.code(404).send({ error: '演示文稿不存在' });
    }
    db.delete(schema.decks).where(eq(schema.decks.id, id)).run();
    return { ok: true };
  });
}
