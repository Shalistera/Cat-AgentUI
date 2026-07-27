import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { encryptSecret, newId } from '../crypto.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';

type ProviderRow = typeof schema.providers.$inferSelect;
type ModelRow = typeof schema.models.$inferSelect;

// Regex to auto-detect image generation models when flags are not explicitly set.
const IMAGE_MODEL_RE = /gpt-image|dall-e|-image|imagen/i;

/** Levels are stored as JSON; a corrupt value must not take the route down. */
function parseLevels(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function publicModel(m: ModelRow) {
  return {
    id: m.id,
    providerId: m.providerId,
    modelId: m.modelId,
    displayName: m.displayName,
    vision: !!m.vision,
    tools: !!m.tools,
    imageGen: !!m.imageGen,
    reasoningLevels: parseLevels(m.reasoningLevels),
    enabled: !!m.enabled,
    isDefault: !!m.isDefault,
    sortOrder: m.sortOrder,
  };
}

// SECURITY: api keys / vertex SA JSON are write-only — never returned,
// only hasKey / hasVertexSa booleans.
function publicProvider(p: ProviderRow, modelRows?: ModelRow[]) {
  let extraHeaders: Record<string, string> = {};
  try { extraHeaders = JSON.parse(p.extraHeaders || '{}'); } catch { /* ignore */ }
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    hasKey: !!p.apiKeyEnc,
    useResponses: !!p.useResponses,
    useVertex: !!p.useVertex,
    vertexProject: p.vertexProject,
    vertexLocation: p.vertexLocation,
    hasVertexSa: !!p.vertexSaJsonEnc,
    extraHeaders,
    // The payload itself is never inlined here — a provider list with several
    // 128 KB data URIs in it would dwarf the rest of the response.
    avatarUrl: p.avatar ? avatarUrl(p.id, p.avatar) : null,
    enabled: !!p.enabled,
    sortOrder: p.sortOrder,
    ...(modelRows ? { models: modelRows.map(publicModel) } : {}),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- provider avatars ---

const AVATAR_MIMES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_MAX_BYTES = 128 * 1024;

/** Parse and validate a `data:<mime>;base64,<payload>` avatar. */
function parseAvatarDataUri(uri: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!AVATAR_MIMES.has(mime)) return null;
  let buf: Buffer;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return null;
  return { mime, buf };
}

/** Content-addressed URL, so replacing an avatar busts every cached copy. */
function avatarUrl(id: string, dataUri: string): string {
  const tag = createHash('sha256').update(dataUri).digest('hex').slice(0, 12);
  return `/api/providers/${id}/avatar?v=${tag}`;
}

// Optional text fields accept null as well as '' — both mean "not set / clear it".
// (.optional() alone rejects null, which 400s every form that blanks a field.)
const providerCreateSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(['openai', 'anthropic', 'gemini']),
  baseUrl: z.string().max(300).nullish(),
  apiKey: z.string().max(500).nullish(),
  useResponses: z.boolean().nullish(),
  useVertex: z.boolean().nullish(),
  vertexProject: z.string().max(100).nullish(),
  vertexLocation: z.string().max(50).nullish(),
  vertexSaJson: z.string().max(20000).nullish(),
  extraHeaders: z.record(z.string(), z.string()).nullish(),
});

const providerPatchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  type: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  baseUrl: z.string().max(300).nullish(),
  apiKey: z.string().max(500).nullish(),
  useResponses: z.boolean().nullish(),
  useVertex: z.boolean().nullish(),
  vertexProject: z.string().max(100).nullish(),
  vertexLocation: z.string().max(50).nullish(),
  vertexSaJson: z.string().max(20000).nullish(),
  extraHeaders: z.record(z.string(), z.string()).nullish(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const modelsAddSchema = z.object({
  providerId: z.string().min(1),
  models: z.array(z.object({
    modelId: z.string().min(1).max(200),
    displayName: z.string().max(200).optional(),
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    imageGen: z.boolean().optional(),
  })).max(500),
});

const modelPatchSchema = z.object({
  displayName: z.string().max(200).nullish(),
  vision: z.boolean().optional(),
  tools: z.boolean().optional(),
  imageGen: z.boolean().optional(),
  // Blanks are tolerated and stripped below — rejecting them would 400 a whole
  // list because of one stray comma.
  reasoningLevels: z.array(z.string().max(32)).max(12).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

function getProvider(id: string): ProviderRow | undefined {
  return db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
}

export async function providerRoutes(app: FastifyInstance) {
  // --- admin: providers ---

  app.get('/api/admin/providers', async (req, reply) => {
    requireAdmin(req, reply);
    const provRows = db.select().from(schema.providers)
      .orderBy(asc(schema.providers.sortOrder), asc(schema.providers.createdAt)).all();
    const modelRows = db.select().from(schema.models)
      .orderBy(asc(schema.models.sortOrder), asc(schema.models.modelId)).all();
    const byProvider = new Map<string, ModelRow[]>();
    for (const m of modelRows) {
      const list = byProvider.get(m.providerId);
      if (list) list.push(m); else byProvider.set(m.providerId, [m]);
    }
    return provRows.map((p) => publicProvider(p, byProvider.get(p.id) ?? []));
  });

  app.post('/api/admin/providers', async (req, reply) => {
    requireAdmin(req, reply);
    const body = providerCreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const d = body.data;
    if (d.vertexSaJson) {
      try { JSON.parse(d.vertexSaJson); } catch {
        return reply.code(400).send({ error: 'Service Account JSON 无效' });
      }
    }
    const id = newId();
    db.insert(schema.providers).values({
      id,
      name: d.name,
      type: d.type,
      baseUrl: d.baseUrl ? d.baseUrl : null,
      apiKeyEnc: d.apiKey ? encryptSecret(d.apiKey) : null,
      useResponses: d.useResponses ? 1 : 0,
      useVertex: d.useVertex ? 1 : 0,
      vertexProject: d.vertexProject ? d.vertexProject : null,
      vertexLocation: d.vertexLocation ? d.vertexLocation : null,
      vertexSaJsonEnc: d.vertexSaJson ? encryptSecret(d.vertexSaJson) : null,
      extraHeaders: JSON.stringify(d.extraHeaders ?? {}),
      createdAt: now(),
    }).run();
    return publicProvider(getProvider(id)!);
  });

  app.patch('/api/admin/providers/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = providerPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });
    const d = body.data;

    const patch: Partial<typeof schema.providers.$inferInsert> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.type !== undefined) patch.type = d.type;
    if (d.baseUrl !== undefined) patch.baseUrl = d.baseUrl || null;
    // Secrets: undefined = keep, '' or null = clear, otherwise encrypt and replace.
    if (d.apiKey !== undefined) patch.apiKeyEnc = d.apiKey ? encryptSecret(d.apiKey) : null;
    if (d.vertexSaJson !== undefined) {
      if (!d.vertexSaJson) {
        patch.vertexSaJsonEnc = null;
      } else {
        try { JSON.parse(d.vertexSaJson); } catch {
          return reply.code(400).send({ error: 'Service Account JSON 无效' });
        }
        patch.vertexSaJsonEnc = encryptSecret(d.vertexSaJson);
      }
    }
    if (d.useResponses !== undefined) patch.useResponses = d.useResponses ? 1 : 0;
    if (d.useVertex !== undefined) patch.useVertex = d.useVertex ? 1 : 0;
    if (d.vertexProject !== undefined) patch.vertexProject = d.vertexProject || null;
    if (d.vertexLocation !== undefined) patch.vertexLocation = d.vertexLocation || null;
    if (d.extraHeaders !== undefined) patch.extraHeaders = JSON.stringify(d.extraHeaders ?? {});
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    if (d.sortOrder !== undefined) patch.sortOrder = d.sortOrder;

    if (Object.keys(patch).length) {
      db.update(schema.providers).set(patch).where(eq(schema.providers.id, id)).run();
    }
    return publicProvider(getProvider(id)!);
  });

  app.delete('/api/admin/providers/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });
    db.delete(schema.providers).where(eq(schema.providers.id, id)).run(); // models cascade via FK
    return { ok: true };
  });

  // Custom avatar: `{ avatar: <data URI> }` replaces it, `{ avatar: null }`
  // clears it and returns the provider to its built-in brand mark.
  app.put('/api/admin/providers/:id/avatar', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({ avatar: z.string().max(200_000).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });

    let avatar: string | null = null;
    if (body.data.avatar) {
      const parsed = parseAvatarDataUri(body.data.avatar);
      if (!parsed) {
        return reply.code(400).send({ error: '头像无效:仅支持 SVG / PNG / JPEG / WebP / GIF,且不超过 128 KB' });
      }
      avatar = body.data.avatar;
    }
    db.update(schema.providers).set({ avatar }).where(eq(schema.providers.id, id)).run();
    return publicProvider(getProvider(id)!);
  });

  // --- any signed-in user: avatar bytes ---

  app.get('/api/providers/:id/avatar', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = getProvider(id);
    if (!row?.avatar) return reply.code(404).send({ error: '未设置头像' });
    const parsed = parseAvatarDataUri(row.avatar);
    if (!parsed) return reply.code(404).send({ error: '未设置头像' });

    reply.header('content-type', parsed.mime);
    // Uploaded SVG can carry scripts, which would run in our origin if the URL
    // is opened directly. Lock the document down and forbid sniffing so the
    // response can only ever behave as an image.
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', 'inline');
    // The URL is content-addressed (?v=<hash>), so this can be immutable.
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(parsed.buf);
  });

  app.post('/api/admin/providers/:id/fetch-models', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });
    try {
      const list = await getAdapter(row.type).listModels(toRuntimeConfig(row));
      return { ok: true, models: list.map((m) => ({ id: m.id, name: m.name ?? m.id })) };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  });

  app.post('/api/admin/providers/:id/test', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });
    try {
      const list = await getAdapter(row.type).listModels(toRuntimeConfig(row));
      return { ok: true, modelCount: list.length };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  });

  // --- admin: models ---

  app.post('/api/admin/models', async (req, reply) => {
    requireAdmin(req, reply);
    const body = modelsAddSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const { providerId, models } = body.data;
    const provider = getProvider(providerId);
    if (!provider) return reply.code(404).send({ error: 'Provider 不存在' });

    const existing = new Set(
      db.select({ modelId: schema.models.modelId }).from(schema.models)
        .where(eq(schema.models.providerId, providerId)).all()
        .map((r) => r.modelId),
    );
    let added = 0;
    let skipped = 0;
    for (const m of models) {
      if (existing.has(m.modelId)) { skipped++; continue; }
      existing.add(m.modelId); // also dedupe within the request batch
      const looksImageGen = IMAGE_MODEL_RE.test(m.modelId);
      db.insert(schema.models).values({
        id: newId(),
        providerId,
        modelId: m.modelId,
        displayName: m.displayName ?? null,
        vision: (m.vision ?? !looksImageGen) ? 1 : 0,
        tools: (m.tools ?? !looksImageGen) ? 1 : 0,
        imageGen: (m.imageGen ?? looksImageGen) ? 1 : 0,
        createdAt: now(),
      }).run();
      added++;
    }
    return { added, skipped };
  });

  app.patch('/api/admin/models/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = modelPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const row = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
    if (!row) return reply.code(404).send({ error: '模型不存在' });
    const d = body.data;

    if (d.isDefault === true) {
      // Only one default model across the whole app.
      db.update(schema.models).set({ isDefault: 0 }).run();
    }
    const patch: Partial<typeof schema.models.$inferInsert> = {};
    if (d.displayName !== undefined) patch.displayName = d.displayName || null;
    if (d.vision !== undefined) patch.vision = d.vision ? 1 : 0;
    if (d.tools !== undefined) patch.tools = d.tools ? 1 : 0;
    if (d.imageGen !== undefined) patch.imageGen = d.imageGen ? 1 : 0;
    if (d.reasoningLevels !== undefined) {
      // Trim, drop blanks, de-duplicate — the admin types this as free text.
      const seen = new Set<string>();
      const levels = d.reasoningLevels
        .map((x) => x.trim())
        .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
      patch.reasoningLevels = JSON.stringify(levels);
    }
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    if (d.isDefault !== undefined) patch.isDefault = d.isDefault ? 1 : 0;
    if (d.sortOrder !== undefined) patch.sortOrder = d.sortOrder;

    if (Object.keys(patch).length) {
      db.update(schema.models).set(patch).where(eq(schema.models.id, id)).run();
    }
    const updated = db.select().from(schema.models).where(eq(schema.models.id, id)).get()!;
    return publicModel(updated);
  });

  app.delete('/api/admin/models/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select({ id: schema.models.id }).from(schema.models)
      .where(eq(schema.models.id, id)).get();
    if (!row) return reply.code(404).send({ error: '模型不存在' });
    db.delete(schema.models).where(eq(schema.models.id, id)).run();
    return { ok: true };
  });

  // --- user: enabled models ---

  app.get('/api/models', async (req, reply) => {
    requireAuth(req, reply);
    const rows = db.select({
      id: schema.models.id,
      modelId: schema.models.modelId,
      displayName: schema.models.displayName,
      vision: schema.models.vision,
      tools: schema.models.tools,
      imageGen: schema.models.imageGen,
      reasoningLevels: schema.models.reasoningLevels,
      isDefault: schema.models.isDefault,
      providerId: schema.providers.id,
      providerName: schema.providers.name,
      providerType: schema.providers.type,
      providerAvatar: schema.providers.avatar,
    }).from(schema.models)
      .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
      .where(and(eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1)))
      .orderBy(asc(schema.providers.sortOrder), asc(schema.models.sortOrder), asc(schema.models.modelId))
      .all();
    return rows.map((r) => ({
      id: r.id,
      modelId: r.modelId,
      displayName: r.displayName || r.modelId,
      vision: !!r.vision,
      tools: !!r.tools,
      imageGen: !!r.imageGen,
      reasoningLevels: parseLevels(r.reasoningLevels),
      isDefault: !!r.isDefault,
      providerId: r.providerId,
      providerName: r.providerName,
      providerType: r.providerType,
      providerAvatarUrl: r.providerAvatar ? avatarUrl(r.providerId, r.providerAvatar) : null,
    }));
  });
}
