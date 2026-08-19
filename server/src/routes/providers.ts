import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { encryptSecret, newId } from '../crypto.js';
import { requireAuth, requireAdmin } from '../auth.js';
import {
  allConfiguredSecretValues, encryptSecretRecord, providerExtraHeaders, redactSensitiveText,
} from '../secrets.js';
import { accessUserIds, accessibleOnly, replaceModelAccess } from '../model-access.js';
import { broadcast } from './events.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { supportsVertexGoogleSearch } from '../providers/gemini.js';
import {
  MAX_LEVELS, defaultLevels, effectiveLevels, normalizeLevels, parseLevels, parseMode,
} from '../reasoning.js';
import type { ProviderType } from '../types.js';

type ProviderRow = typeof schema.providers.$inferSelect;
type ModelRow = typeof schema.models.$inferSelect;

// Regex to auto-detect image generation models when flags are not explicitly set.
const IMAGE_MODEL_RE = /gpt-image|dall-e|-image|imagen/i;

// The console shows all three ladders at once: what the model offers today,
// what the admin typed, and what the defaults would give — so switching modes
// in the editor never lands on an empty list.
function publicModel(m: ModelRow, type: ProviderType, allowedUserIds?: string[]) {
  return {
    id: m.id,
    providerId: m.providerId,
    modelId: m.modelId,
    displayName: m.displayName,
    vision: !!m.vision,
    tools: !!m.tools,
    imageGen: !!m.imageGen,
    accessMode: m.accessMode === 'restricted' ? 'restricted' : 'shared',
    allowedUserIds: allowedUserIds ?? accessUserIds(m.id),
    reasoning: {
      mode: parseMode(m.reasoningMode),
      levels: effectiveLevels(m.reasoningMode, m.reasoningLevels, type, m.modelId),
      custom: parseLevels(m.reasoningLevels),
      defaults: defaultLevels(type, m.modelId),
    },
    enabled: !!m.enabled,
    isDefault: !!m.isDefault,
    sortOrder: m.sortOrder,
    defaultWebSearch: !!m.defaultWebSearch,
  };
}

// SECURITY: API keys, Vertex SA JSON, and custom header values are write-only.
function publicProvider(p: ProviderRow, modelRows?: ModelRow[]) {
  let extraHeaderKeys: string[] = [];
  try { extraHeaderKeys = Object.keys(providerExtraHeaders(p)); } catch { /* keep editor usable */ }
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
    hasExtraHeaders: !!p.extraHeadersEnc || extraHeaderKeys.length > 0,
    extraHeaderKeys,
    // The payload itself is never inlined here — a provider list with several
    // 128 KB data URIs in it would dwarf the rest of the response.
    avatarUrl: p.avatar ? avatarUrl(p.id, p.avatar) : null,
    enabled: !!p.enabled,
    sortOrder: p.sortOrder,
    ...(modelRows ? { models: modelRows.map((m) => publicModel(m, p.type as ProviderType)) } : {}),
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
  // The admin API never returns saved values. The editor sends unchanged key
  // names here so they can be retained while additions/replacements are merged.
  preserveExtraHeaderKeys: z.array(z.string().max(200)).max(200).optional(),
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
  reasoningMode: z.enum(['auto', 'custom', 'off']).optional(),
  // Blank rows and duplicates are tolerated and stripped below — rejecting them
  // would 400 a whole ladder because of one half-typed line.
  reasoningLevels: z.array(z.object({
    value: z.string().max(32),
    label: z.string().max(32).optional(),
  })).max(MAX_LEVELS * 2).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  defaultWebSearch: z.boolean().optional(),
  accessMode: z.enum(['shared', 'restricted']).optional(),
  allowedUserIds: z.array(z.string().max(64)).max(500).optional(),
});

// Full desired ordering, first item on top. Ids that no longer exist are
// skipped; rows not mentioned keep their old sortOrder.
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(500) });

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
      extraHeaders: '{}',
      extraHeadersEnc: encryptSecretRecord(d.extraHeaders ?? {}),
      createdAt: now(),
    }).run();
    broadcast('models-updated');
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
    if (d.extraHeaders !== undefined || d.preserveExtraHeaderKeys !== undefined) {
      let current: Record<string, string> = Object.create(null) as Record<string, string>;
      try { current = providerExtraHeaders(row); } catch { /* explicit replacement can repair it */ }
      const next: Record<string, string> = Object.create(null) as Record<string, string>;
      // A page loaded before this rollout sends `{ extraHeaders: {} }` on every
      // edit because it cannot understand write-only header metadata. Treat
      // that one legacy shape as "keep"; the new editor sends an explicit
      // preserve list (including [] when the user intentionally clears all).
      const preserve = d.preserveExtraHeaderKeys
        ?? (d.extraHeaders && Object.keys(d.extraHeaders).length === 0 ? Object.keys(current) : []);
      for (const key of preserve) {
        if (Object.hasOwn(current, key)) next[key] = current[key];
      }
      for (const [key, value] of Object.entries(d.extraHeaders ?? {})) {
        // Empty-valued custom headers were supported before values became
        // write-only, so keep that behavior for API clients and newly-added
        // rows in the panel. Unchanged saved rows are carried by `preserve`.
        if (key) next[key] = value;
      }
      patch.extraHeaders = '{}';
      patch.extraHeadersEnc = encryptSecretRecord(next);
    }
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    if (d.sortOrder !== undefined) patch.sortOrder = d.sortOrder;

    if (Object.keys(patch).length) {
      db.update(schema.providers).set(patch).where(eq(schema.providers.id, id)).run();
      broadcast('models-updated');
    }
    return publicProvider(getProvider(id)!);
  });

  // One request per drag/click: renumber in list order instead of a PATCH
  // per row, so a reorder can't be half-applied.
  app.put('/api/admin/providers/order', async (req, reply) => {
    requireAdmin(req, reply);
    const body = orderSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const existing = new Set(
      db.select({ id: schema.providers.id }).from(schema.providers).all().map((r) => r.id),
    );
    db.transaction(() => {
      let i = 0;
      for (const pid of body.data.ids) {
        if (!existing.has(pid)) continue;
        db.update(schema.providers).set({ sortOrder: i++ }).where(eq(schema.providers.id, pid)).run();
      }
    });
    broadcast('models-updated');
    return { ok: true };
  });

  // Model order is one global sequence across providers — the picker shows a
  // flat list, so gpt/gemini/claude rows can interleave freely.
  app.get('/api/admin/models', async (req, reply) => {
    requireAdmin(req, reply);
    const rows = db.select({
      id: schema.models.id,
      modelId: schema.models.modelId,
      displayName: schema.models.displayName,
      enabled: schema.models.enabled,
      imageGen: schema.models.imageGen,
      providerId: schema.providers.id,
      providerName: schema.providers.name,
      providerType: schema.providers.type,
      providerBaseUrl: schema.providers.baseUrl,
      providerEnabled: schema.providers.enabled,
      providerAvatar: schema.providers.avatar,
    }).from(schema.models)
      .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
      .orderBy(asc(schema.models.sortOrder), asc(schema.models.modelId))
      .all();
    return rows.map((r) => ({
      id: r.id,
      modelId: r.modelId,
      displayName: r.displayName || r.modelId,
      enabled: !!r.enabled,
      imageGen: !!r.imageGen,
      providerId: r.providerId,
      providerName: r.providerName,
      providerType: r.providerType,
      providerBaseUrl: r.providerBaseUrl,
      providerEnabled: !!r.providerEnabled,
      providerAvatarUrl: r.providerAvatar ? avatarUrl(r.providerId, r.providerAvatar) : null,
    }));
  });

  app.put('/api/admin/models/order', async (req, reply) => {
    requireAdmin(req, reply);
    const body = orderSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const existing = new Set(
      db.select({ id: schema.models.id }).from(schema.models).all().map((r) => r.id),
    );
    db.transaction(() => {
      let i = 0;
      for (const mid of body.data.ids) {
        if (!existing.has(mid)) continue;
        db.update(schema.models).set({ sortOrder: i++ }).where(eq(schema.models.id, mid)).run();
      }
    });
    broadcast('models-updated');
    return { ok: true };
  });

  app.delete('/api/admin/providers/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });
    db.delete(schema.providers).where(eq(schema.providers.id, id)).run(); // models cascade via FK
    broadcast('models-updated');
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
    broadcast('models-updated');
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
      const secretValues = allConfiguredSecretValues();
      return {
        ok: true,
        models: list.map((m) => ({
          id: redactSensitiveText(m.id, secretValues),
          name: redactSensitiveText(m.name ?? m.id, secretValues),
        })),
      };
    } catch (err) {
      return { ok: false, error: redactSensitiveText(errMessage(err), allConfiguredSecretValues()) };
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
      return { ok: false, error: redactSensitiveText(errMessage(err), allConfiguredSecretValues()) };
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
    if (added > 0) broadcast('models-updated');
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
      patch.reasoningLevels = JSON.stringify(normalizeLevels(d.reasoningLevels));
    }
    if (d.reasoningMode !== undefined) patch.reasoningMode = d.reasoningMode;
    // A custom ladder with nothing in it would silently behave as 'off' while
    // the console claimed otherwise, so say so instead of saving it.
    const nextMode = d.reasoningMode ?? parseMode(row.reasoningMode);
    const nextLevels = patch.reasoningLevels ?? row.reasoningLevels;
    if (nextMode === 'custom' && !parseLevels(nextLevels).length) {
      return reply.code(400).send({ error: '自定义档位至少需要一个,或改用「默认」/「关闭」' });
    }
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    if (d.isDefault !== undefined) patch.isDefault = d.isDefault ? 1 : 0;
    if (d.sortOrder !== undefined) patch.sortOrder = d.sortOrder;
    if (d.defaultWebSearch !== undefined) patch.defaultWebSearch = d.defaultWebSearch ? 1 : 0;
    if (d.accessMode !== undefined) patch.accessMode = d.accessMode;

    if (Object.keys(patch).length) {
      db.update(schema.models).set(patch).where(eq(schema.models.id, id)).run();
    }
    if (d.allowedUserIds !== undefined) replaceModelAccess(id, d.allowedUserIds);
    broadcast('models-updated');
    const updated = db.select().from(schema.models).where(eq(schema.models.id, id)).get()!;
    return publicModel(updated, getProvider(updated.providerId)!.type as ProviderType);
  });

  app.delete('/api/admin/models/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select({ id: schema.models.id }).from(schema.models)
      .where(eq(schema.models.id, id)).get();
    if (!row) return reply.code(404).send({ error: '模型不存在' });
    db.delete(schema.models).where(eq(schema.models.id, id)).run();
    broadcast('models-updated');
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
      reasoningMode: schema.models.reasoningMode,
      reasoningLevels: schema.models.reasoningLevels,
      isDefault: schema.models.isDefault,
      defaultWebSearch: schema.models.defaultWebSearch,
      accessMode: schema.models.accessMode,
      providerId: schema.providers.id,
      providerName: schema.providers.name,
      providerType: schema.providers.type,
      providerUseVertex: schema.providers.useVertex,
      providerAvatar: schema.providers.avatar,
    }).from(schema.models)
      .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
      .where(and(eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1)))
      // Global admin order, no provider grouping — providers can interleave.
      .orderBy(asc(schema.models.sortOrder), asc(schema.models.modelId))
      .all();
    const list = accessibleOnly(rows, req.user!).map((r) => ({
      id: r.id,
      modelId: r.modelId,
      displayName: r.displayName || r.modelId,
      vision: !!r.vision,
      tools: !!r.tools,
      imageGen: !!r.imageGen,
      nativeSearch: !!r.tools && !r.imageGen && r.providerType === 'gemini'
        && !!r.providerUseVertex && supportsVertexGoogleSearch(r.modelId),
      defaultWebSearch: !!r.defaultWebSearch,
      // Only the resolved ladder — the chat UI has no use for how it was decided.
      reasoningLevels: effectiveLevels(
        r.reasoningMode, r.reasoningLevels, r.providerType as ProviderType, r.modelId,
      ),
      isDefault: !!r.isDefault,
      providerId: r.providerId,
      providerName: r.providerName,
      providerType: r.providerType,
      providerAvatarUrl: r.providerAvatar ? avatarUrl(r.providerId, r.providerAvatar) : null,
    }));
    // A user's own drag order (settings.modelOrder, model row ids) wins over
    // the admin order. The sort is stable, so models the user never ranked —
    // e.g. added after they last dragged — stay in admin order at the end.
    let userOrder: unknown;
    try {
      userOrder = (JSON.parse(req.user!.settings || '{}') as Record<string, unknown>).modelOrder;
    } catch { /* malformed settings — admin order */ }
    if (Array.isArray(userOrder) && userOrder.length) {
      const pos = new Map<string, number>();
      userOrder.forEach((id, i) => { if (typeof id === 'string' && !pos.has(id)) pos.set(id, i); });
      list.sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    }
    return list;
  });
}
