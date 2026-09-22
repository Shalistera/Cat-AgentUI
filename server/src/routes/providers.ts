import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { encryptSecret, newId } from '../crypto.js';
import { requireAuth, requireAdmin } from '../auth.js';
import {
  allConfiguredSecretValues, decryptSecretRecord, encryptSecretRecord, providerExtraHeaders, redactSensitiveText,
} from '../secrets.js';
import { accessUserIds, accessibleOnly, imageModelsAllowed, replaceModelAccess } from '../model-access.js';
import { checkModelLimit, hasModelLimit, parseLimitPeriod } from '../quota.js';
import { broadcast } from './events.js';
import {
  endpointRuntimeConfig, getRawAdapter, primaryLineKey, toPrimaryRuntimeConfig, type EndpointRow,
} from '../providers/index.js';
import { lineStatus, resetLineHealth } from '../providers/failover.js';
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
    description: m.description,
    vision: !!m.vision,
    tools: !!m.tools,
    imageGen: !!m.imageGen,
    // Like the provider avatar, only the content-addressed URL is inlined.
    avatarUrl: m.avatar ? modelAvatarUrl(m.id, m.avatar) : null,
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
    inputPrice: m.inputPrice,
    outputPrice: m.outputPrice,
    limitPeriod: parseLimitPeriod(m.limitPeriod),
    limitRequests: m.limitRequests,
    limitTokens: m.limitTokens,
  };
}

function publicHealth(key: string) {
  const h = lineStatus(key);
  return {
    state: h.state,
    failures: h.failures,
    openUntil: h.openUntil > Date.now() ? h.openUntil : null,
    lastError: h.lastError,
    lastFailureAt: h.lastFailureAt,
    served: h.served,
    tookOver: h.tookOver,
  };
}

// SECURITY: like providers, a line's key and header values are write-only.
function publicEndpoint(e: EndpointRow) {
  let extraHeaderKeys: string[] = [];
  try { extraHeaderKeys = Object.keys(decryptSecretRecord(e.extraHeadersEnc)); } catch { /* keep editor usable */ }
  return {
    id: e.id,
    providerId: e.providerId,
    name: e.name,
    baseUrl: e.baseUrl,
    hasKey: !!e.apiKeyEnc,
    extraHeaderKeys,
    useResponses: e.useResponses === null ? null : !!e.useResponses,
    stripModelPrefix: e.stripModelPrefix,
    addModelPrefix: e.addModelPrefix,
    priority: e.priority,
    enabled: !!e.enabled,
    health: publicHealth(e.id),
  };
}

function endpointsOf(providerId: string): EndpointRow[] {
  return db.select().from(schema.providerEndpoints)
    .where(eq(schema.providerEndpoints.providerId, providerId))
    .orderBy(asc(schema.providerEndpoints.priority), asc(schema.providerEndpoints.createdAt))
    .all();
}

// SECURITY: API keys, Vertex SA JSON, and custom header values are write-only.
function publicProvider(p: ProviderRow, modelRows?: ModelRow[], endpointRows?: EndpointRow[]) {
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
    failoverThreshold: p.failoverThreshold,
    failoverCooldownSeconds: p.failoverCooldownSeconds,
    primaryName: p.primaryName,
    stripModelPrefix: p.stripModelPrefix,
    addModelPrefix: p.addModelPrefix,
    health: publicHealth(primaryLineKey(p.id)),
    endpoints: (endpointRows ?? endpointsOf(p.id)).map(publicEndpoint),
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

/** Same content-addressing for per-model icons. */
function modelAvatarUrl(id: string, dataUri: string): string {
  const tag = createHash('sha256').update(dataUri).digest('hex').slice(0, 12);
  return `/api/models/${id}/avatar?v=${tag}`;
}

/** Shared response shape for serving avatar bytes (provider or model). */
function sendAvatar(reply: FastifyReply, parsed: { mime: string; buf: Buffer }) {
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
  failoverThreshold: z.number().int().min(1).max(100).optional(),
  failoverCooldownSeconds: z.number().int().min(5).max(86400).optional(),
  primaryName: z.string().max(64).nullish(),
  stripModelPrefix: z.string().max(100).nullish(),
  addModelPrefix: z.string().max(100).nullish(),
});

const endpointCreateSchema = z.object({
  name: z.string().min(1).max(64),
  baseUrl: z.string().max(300).nullish(),
  apiKey: z.string().max(500).nullish(),
  extraHeaders: z.record(z.string(), z.string()).nullish(),
  useResponses: z.boolean().nullish(),
  stripModelPrefix: z.string().max(100).nullish(),
  addModelPrefix: z.string().max(100).nullish(),
  enabled: z.boolean().optional(),
});

const endpointPatchSchema = endpointCreateSchema.partial().extend({
  preserveExtraHeaderKeys: z.array(z.string().max(200)).max(200).optional(),
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
  description: z.string().max(500).nullish(),
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
  // Per-1M-token prices in the site currency; null = unknown (no cost shown)
  inputPrice: z.number().min(0).max(1e6).nullish(),
  outputPrice: z.number().min(0).max(1e6).nullish(),
  // Per-account allowance on this model per window; null/0 = no limit on that axis
  limitPeriod: z.enum(['day', 'week']).optional(),
  limitRequests: z.number().int().min(0).max(1e9).nullish(),
  limitTokens: z.number().int().min(0).max(1e15).nullish(),
});

// Full desired ordering, first item on top. Ids that no longer exist are
// skipped; rows not mentioned keep their old sortOrder.
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(500) });

/** The user-facing slice of a model-limit verdict; null when nothing applies. */
function usageLimitFor(
  user: { id: string; role: string },
  m: { providerId: string; modelId: string; limitPeriod: string; limitRequests: number | null; limitTokens: number | null },
) {
  if (user.role === 'admin' || !hasModelLimit(m)) return null;
  const v = checkModelLimit(user, m);
  return { period: v.period, requests: v.requests, tokens: v.tokens };
}

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
    const endpointRows = db.select().from(schema.providerEndpoints)
      .orderBy(asc(schema.providerEndpoints.priority), asc(schema.providerEndpoints.createdAt)).all();
    const endpointsBy = new Map<string, EndpointRow[]>();
    for (const e of endpointRows) {
      const list = endpointsBy.get(e.providerId);
      if (list) list.push(e); else endpointsBy.set(e.providerId, [e]);
    }
    return provRows.map((p) => publicProvider(p, byProvider.get(p.id) ?? [], endpointsBy.get(p.id) ?? []));
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
    if (d.failoverThreshold !== undefined) patch.failoverThreshold = d.failoverThreshold;
    if (d.failoverCooldownSeconds !== undefined) patch.failoverCooldownSeconds = d.failoverCooldownSeconds;
    if (d.primaryName !== undefined) patch.primaryName = d.primaryName?.trim() || null;
    if (d.stripModelPrefix !== undefined) patch.stripModelPrefix = d.stripModelPrefix?.trim() ?? '';
    if (d.addModelPrefix !== undefined) patch.addModelPrefix = d.addModelPrefix?.trim() ?? '';

    if (Object.keys(patch).length) {
      db.update(schema.providers).set(patch).where(eq(schema.providers.id, id)).run();
      broadcast('models-updated');
    }
    return publicProvider(getProvider(id)!);
  });

  // --- admin: backup lines (provider endpoints) ---

  /** Merge write-only header values the same way the provider editor does. */
  function mergeHeaders(
    current: Record<string, string>, incoming: Record<string, string> | null | undefined, preserve: string[] | undefined,
  ): Record<string, string> {
    const next: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const key of preserve ?? []) {
      if (Object.hasOwn(current, key)) next[key] = current[key];
    }
    for (const [key, value] of Object.entries(incoming ?? {})) {
      if (key) next[key] = value;
    }
    return next;
  }

  function getEndpoint(id: string): EndpointRow | undefined {
    return db.select().from(schema.providerEndpoints).where(eq(schema.providerEndpoints.id, id)).get();
  }

  app.post('/api/admin/providers/:id/endpoints', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const provider = getProvider(id);
    if (!provider) return reply.code(404).send({ error: 'Provider 不存在' });
    const body = endpointCreateSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const d = body.data;
    const existing = endpointsOf(id);
    if (existing.length >= 10) return reply.code(400).send({ error: '备用线路最多 10 条' });
    const eid = newId();
    db.insert(schema.providerEndpoints).values({
      id: eid,
      providerId: id,
      name: d.name,
      baseUrl: d.baseUrl ? d.baseUrl : null,
      apiKeyEnc: d.apiKey ? encryptSecret(d.apiKey) : null,
      extraHeadersEnc: encryptSecretRecord(d.extraHeaders ?? {}),
      useResponses: d.useResponses == null ? null : d.useResponses ? 1 : 0,
      stripModelPrefix: d.stripModelPrefix?.trim() ?? '',
      addModelPrefix: d.addModelPrefix?.trim() ?? '',
      priority: existing.length ? Math.max(...existing.map((e) => e.priority)) + 1 : 0,
      enabled: d.enabled === false ? 0 : 1,
      createdAt: now(),
    }).run();
    return publicEndpoint(getEndpoint(eid)!);
  });

  app.patch('/api/admin/provider-endpoints/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getEndpoint(id);
    if (!row) return reply.code(404).send({ error: '备用线路不存在' });
    const body = endpointPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const d = body.data;
    const patch: Partial<typeof schema.providerEndpoints.$inferInsert> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.baseUrl !== undefined) patch.baseUrl = d.baseUrl || null;
    if (d.apiKey !== undefined) patch.apiKeyEnc = d.apiKey ? encryptSecret(d.apiKey) : null;
    if (d.useResponses !== undefined) patch.useResponses = d.useResponses == null ? null : d.useResponses ? 1 : 0;
    if (d.stripModelPrefix !== undefined) patch.stripModelPrefix = d.stripModelPrefix?.trim() ?? '';
    if (d.addModelPrefix !== undefined) patch.addModelPrefix = d.addModelPrefix?.trim() ?? '';
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    if (d.extraHeaders !== undefined || d.preserveExtraHeaderKeys !== undefined) {
      let current: Record<string, string> = Object.create(null) as Record<string, string>;
      try { current = decryptSecretRecord(row.extraHeadersEnc); } catch { /* explicit replacement can repair it */ }
      patch.extraHeadersEnc = encryptSecretRecord(mergeHeaders(current, d.extraHeaders, d.preserveExtraHeaderKeys));
    }
    if (Object.keys(patch).length) {
      db.update(schema.providerEndpoints).set(patch).where(eq(schema.providerEndpoints.id, id)).run();
      // Address or credentials changed: the old failure streak says nothing
      // about the new line.
      if (patch.baseUrl !== undefined || patch.apiKeyEnc !== undefined || patch.extraHeadersEnc !== undefined) {
        resetLineHealth(id);
      }
    }
    return publicEndpoint(getEndpoint(id)!);
  });

  app.delete('/api/admin/provider-endpoints/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getEndpoint(id);
    if (!row) return reply.code(404).send({ error: '备用线路不存在' });
    db.delete(schema.providerEndpoints).where(eq(schema.providerEndpoints.id, id)).run();
    resetLineHealth(id);
    return { ok: true };
  });

  // Priority order for one provider's lines, first item tried first.
  app.put('/api/admin/providers/:id/endpoints/order', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    if (!getProvider(id)) return reply.code(404).send({ error: 'Provider 不存在' });
    const body = orderSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const mine = new Set(endpointsOf(id).map((e) => e.id));
    db.transaction(() => {
      let i = 0;
      for (const eid of body.data.ids) {
        if (!mine.has(eid)) continue;
        db.update(schema.providerEndpoints).set({ priority: i++ }).where(eq(schema.providerEndpoints.id, eid)).run();
      }
    });
    return { ok: true };
  });

  // Swap a backup with the provider's own line: the backup's address, key,
  // headers, Responses setting, label and model rewrite move onto the
  // provider; the old primary lands in the backup's slot. The model roster,
  // permissions and usage stay where they are.
  app.post('/api/admin/provider-endpoints/:id/promote', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const ep = getEndpoint(id);
    if (!ep) return reply.code(404).send({ error: '备用线路不存在' });
    const provider = getProvider(ep.providerId);
    if (!provider) return reply.code(404).send({ error: 'Provider 不存在' });
    if (provider.type === 'gemini' && provider.useVertex) {
      return reply.code(400).send({ error: 'Vertex AI 鉴权的主线路不能与 API Key 线路互换,请先关闭 Vertex 模式' });
    }
    db.transaction(() => {
      db.update(schema.providers).set({
        baseUrl: ep.baseUrl,
        apiKeyEnc: ep.apiKeyEnc,
        extraHeaders: '{}',
        extraHeadersEnc: ep.extraHeadersEnc,
        useResponses: ep.useResponses === null ? provider.useResponses : ep.useResponses,
        primaryName: ep.name,
        stripModelPrefix: ep.stripModelPrefix,
        addModelPrefix: ep.addModelPrefix,
      }).where(eq(schema.providers.id, provider.id)).run();
      let legacyHeaders: string | null = provider.extraHeadersEnc;
      // Pre-0012 plaintext headers, if any survived, move over encrypted.
      if (!legacyHeaders) {
        try { legacyHeaders = encryptSecretRecord(providerExtraHeaders(provider)); } catch { legacyHeaders = null; }
      }
      db.update(schema.providerEndpoints).set({
        name: provider.primaryName || '原主线路',
        baseUrl: provider.baseUrl,
        apiKeyEnc: provider.apiKeyEnc,
        extraHeadersEnc: legacyHeaders,
        useResponses: provider.useResponses,
        stripModelPrefix: provider.stripModelPrefix,
        addModelPrefix: provider.addModelPrefix,
      }).where(eq(schema.providerEndpoints.id, ep.id)).run();
    });
    resetLineHealth(primaryLineKey(provider.id));
    resetLineHealth(ep.id);
    broadcast('models-updated');
    return publicProvider(getProvider(provider.id)!);
  });

  app.post('/api/admin/provider-endpoints/:id/test', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getEndpoint(id);
    if (!row) return reply.code(404).send({ error: '备用线路不存在' });
    const provider = getProvider(row.providerId);
    if (!provider) return reply.code(404).send({ error: 'Provider 不存在' });
    try {
      const cfg = endpointRuntimeConfig(toPrimaryRuntimeConfig(provider), row);
      const list = await getRawAdapter(provider.type).listModels(cfg);
      return { ok: true, modelCount: list.length };
    } catch (err) {
      return { ok: false, error: redactSensitiveText(errMessage(err), allConfiguredSecretValues()) };
    }
  });

  // Close a breaker by hand (the provider's own line or a backup), e.g. after
  // the operator fixed the gateway and does not want to wait out the cooldown.
  app.post('/api/admin/providers/:id/health/reset', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const provider = getProvider(id);
    if (!provider) return reply.code(404).send({ error: 'Provider 不存在' });
    resetLineHealth(primaryLineKey(id));
    for (const e of endpointsOf(id)) resetLineHealth(e.id);
    return publicProvider(provider);
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
      avatar: schema.models.avatar,
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
      avatarUrl: r.avatar ? modelAvatarUrl(r.id, r.avatar) : null,
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
    return sendAvatar(reply, parsed);
  });

  // Custom model icon: same contract as the provider avatar — `{ avatar:
  // <data URI> }` replaces it, `{ avatar: null }` falls back to the provider
  // avatar / built-in brand mark.
  app.put('/api/admin/models/:id/avatar', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({ avatar: z.string().max(200_000).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const row = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
    if (!row) return reply.code(404).send({ error: '模型不存在' });

    let avatar: string | null = null;
    if (body.data.avatar) {
      const parsed = parseAvatarDataUri(body.data.avatar);
      if (!parsed) {
        return reply.code(400).send({ error: '图标无效:仅支持 SVG / PNG / JPEG / WebP / GIF,且不超过 128 KB' });
      }
      avatar = body.data.avatar;
    }
    db.update(schema.models).set({ avatar }).where(eq(schema.models.id, id)).run();
    broadcast('models-updated');
    return { ok: true, avatarUrl: avatar ? modelAvatarUrl(id, avatar) : null };
  });

  app.get('/api/models/:id/avatar', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select({ avatar: schema.models.avatar })
      .from(schema.models).where(eq(schema.models.id, id)).get();
    const parsed = row?.avatar ? parseAvatarDataUri(row.avatar) : null;
    if (!parsed) return reply.code(404).send({ error: '未设置图标' });
    return sendAvatar(reply, parsed);
  });

  app.post('/api/admin/providers/:id/fetch-models', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getProvider(id);
    if (!row) return reply.code(404).send({ error: 'Provider 不存在' });
    try {
      const list = await getRawAdapter(row.type).listModels(toPrimaryRuntimeConfig(row));
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
      const list = await getRawAdapter(row.type).listModels(toPrimaryRuntimeConfig(row));
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
    if (d.description !== undefined) patch.description = d.description?.trim() || null;
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
    if (d.inputPrice !== undefined) patch.inputPrice = d.inputPrice;
    if (d.outputPrice !== undefined) patch.outputPrice = d.outputPrice;
    if (d.limitPeriod !== undefined) patch.limitPeriod = d.limitPeriod;
    if (d.limitRequests !== undefined) patch.limitRequests = d.limitRequests || null;
    if (d.limitTokens !== undefined) patch.limitTokens = d.limitTokens || null;

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
      description: schema.models.description,
      avatar: schema.models.avatar,
      vision: schema.models.vision,
      tools: schema.models.tools,
      imageGen: schema.models.imageGen,
      reasoningMode: schema.models.reasoningMode,
      reasoningLevels: schema.models.reasoningLevels,
      isDefault: schema.models.isDefault,
      defaultWebSearch: schema.models.defaultWebSearch,
      accessMode: schema.models.accessMode,
      limitPeriod: schema.models.limitPeriod,
      limitRequests: schema.models.limitRequests,
      limitTokens: schema.models.limitTokens,
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
    const list = accessibleOnly(rows, req.user!)
      .filter((r) => !r.imageGen || imageModelsAllowed(req.user!))
      .map((r) => ({
      id: r.id,
      modelId: r.modelId,
      displayName: r.displayName || r.modelId,
      description: r.description,
      avatarUrl: r.avatar ? modelAvatarUrl(r.id, r.avatar) : null,
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
      // This person's allowance on the model and how much of it is spent, so
      // the picker can say "今日 3 / 10 次" before a request bounces. null =
      // unlimited for them (no limit set, or they are an admin).
      usageLimit: usageLimitFor(req.user!, r),
    }));
    // A user's own drag order (settings.modelOrder, model row ids) wins over
    // the admin order. The sort is stable, so models the user never ranked —
    // e.g. added after they last dragged — stay in admin order at the end.
    // Starred models (settings.favoriteModels) are then hoisted above
    // everything, keeping their relative order within the starred group.
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(req.user!.settings || '{}') as Record<string, unknown>;
    } catch { /* malformed settings — admin order */ }
    const userOrder = settings.modelOrder;
    if (Array.isArray(userOrder) && userOrder.length) {
      const pos = new Map<string, number>();
      userOrder.forEach((id, i) => { if (typeof id === 'string' && !pos.has(id)) pos.set(id, i); });
      list.sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    }
    const favorites = settings.favoriteModels;
    if (Array.isArray(favorites) && favorites.length) {
      const fav = new Set(favorites.filter((x) => typeof x === 'string'));
      list.sort((a, b) => (fav.has(a.id) ? 0 : 1) - (fav.has(b.id) ? 0 : 1));
    }
    return list;
  });
}
