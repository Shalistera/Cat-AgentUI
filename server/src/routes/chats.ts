import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm';
import { db, schema, now, getSetting } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { supportsVertexGoogleSearch } from '../providers/gemini.js';
import { getToolsForServers, callTool, type McpCapabilities } from '../mcp/manager.js';
import { validateMcpSelection } from '../mcp/access.js';
import { getSearchServerId } from './mcp.js';
import { saveGeneratedImage } from './images.js';
import { recordUsage } from '../usage.js';
import { canUseModel, grantedModelIds } from '../model-access.js';
import { checkQuota, quotaBlockMessage } from '../quota.js';
import { OFF, effectiveLevels } from '../reasoning.js';
import { buildProjectPrompt } from './projects.js';
import { callProjectTool, isProjectTool } from '../knowledge.js';
import type {
  AdapterMessage, AdapterMessagePart, GroundingInfo, MessagePart, ProviderType, ReasoningRequest, ToolDef,
} from '../types.js';
import {
  tryAcquireChatTurn, tryAcquireImageJob, tryReserveContextImageBytes, type AdmissionLease,
} from '../admission.js';
import {
  getOwnedImageMedia, getOwnedUploadMedia, quotaErrorMessage, readMediaBase64,
  cleanupUnreferencedUploads, tryReserveStorage, uploadIdsFromPartsJson,
  type OwnedMedia, type StorageReservation,
} from '../storage.js';
import {
  allConfiguredSecretValues, redactSensitiveText, StreamingSecretRedactor,
} from '../secrets.js';

// ---- helpers ----

function createSse(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
  return {
    send(event: string, data: unknown) {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    },
    end() { clearInterval(ping); try { res.end(); } catch { /* closed */ } },
  };
}

function parseParts(json: string): MessagePart[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Next ordering key for a chat. Safe because better-sqlite3 is synchronous and
// the server runs as a single writer process.
function nextSeq(chatId: string): number {
  const row = db.select({ max: sql<number | null>`max(${schema.messages.seq})` })
    .from(schema.messages).where(eq(schema.messages.chatId, chatId)).get();
  return (row?.max ?? 0) + 1;
}

const EMPTY_TOOL_RESULT = '(工具没有返回内容)';

// Every tool_call must be answered by a tool_result or the provider APIs reject
// the whole history on replay. Interrupted turns (stop button, iteration cap)
// leave dangling calls behind, so close them out before persisting/replaying.
function closeDanglingToolCalls(parts: MessagePart[], reason: string): MessagePart[] {
  const answered = new Set(parts.filter((p) => p.type === 'tool_result').map((p) => p.toolCallId));
  const unanswered = parts.filter((p) => p.type === 'tool_call' && !answered.has(p.id));
  if (!unanswered.length) return parts;
  return [
    ...parts,
    ...unanswered.map((p) => ({
      type: 'tool_result' as const,
      toolCallId: (p as Extract<MessagePart, { type: 'tool_call' }>).id,
      name: (p as Extract<MessagePart, { type: 'tool_call' }>).name,
      result: reason,
      isError: true,
    })),
  ];
}

function appendText(parts: MessagePart[], type: 'text' | 'reasoning', text: string) {
  const last = parts[parts.length - 1];
  if (last && last.type === type) (last as { text: string }).text += text;
  else parts.push({ type, text } as MessagePart);
}

// Convert non-image parts. Images are resolved only by buildBoundedHistory,
// after their aggregate raw-byte budget has been checked.
function toAdapterPartNoImage(p: MessagePart): AdapterMessagePart | null {
  if (p.type === 'text' && p.text) return { type: 'text', text: p.text };
  if (p.type === 'tool_call') return {
    type: 'tool_call', id: p.id, name: p.name, args: p.args, sig: p.sig,
  };
  if (p.type === 'tool_result') {
    return {
      type: 'tool_result', toolCallId: p.toolCallId, name: p.name,
      result: p.result && p.result.length ? p.result : EMPTY_TOOL_RESULT,
      isError: p.isError,
    };
  }
  return null;
}

function toAdapterPartsNoImages(parts: MessagePart[]): AdapterMessagePart[] {
  const out: AdapterMessagePart[] = [];
  // repair history written before this guard existed
  for (const p of closeDanglingToolCalls(parts, '(调用未完成)')) {
    const converted = toAdapterPartNoImage(p);
    if (converted) out.push(converted);
    // reasoning parts are never replayed to providers
  }
  return out;
}

const MAX_GROUNDING_QUERIES = 20;
const MAX_GROUNDING_SOURCES = 30;

function safeGroundingPart(
  grounding: GroundingInfo, secretValues: string[],
): Extract<MessagePart, { type: 'grounding' }> | null {
  const queries = [...new Set(grounding.queries)]
    .map((q) => redactSensitiveText(q.trim(), secretValues).slice(0, 500))
    .filter(Boolean).slice(0, MAX_GROUNDING_QUERIES);
  const seenUris = new Set<string>();
  const sources = grounding.sources.flatMap((source) => {
    if (seenUris.size >= MAX_GROUNDING_SOURCES) return [];
    let uri: URL;
    try { uri = new URL(source.uri); } catch { return []; }
    if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password) return [];
    const href = redactSensitiveText(uri.toString(), secretValues).slice(0, 4000);
    if (seenUris.has(href)) return [];
    seenUris.add(href);
    const title = redactSensitiveText(source.title.trim(), secretValues).slice(0, 500) || href;
    return [{ uri: href, title }];
  });
  return queries.length || sources.length
    ? { type: 'grounding', queries, sources }
    : null;
}

class InputBudgetError extends Error {
  constructor(message: string, readonly statusCode = 413) { super(message); }
}

async function normalizeIncomingParts(parts: MessagePart[], ownerId: string): Promise<MessagePart[]> {
  const out: MessagePart[] = [];
  const seenUploads = new Set<string>();
  let textChars = 0;
  let imageBytes = 0;

  for (const part of parts) {
    if (part.type === 'text') {
      textChars += part.text.length;
      if (textChars > config.maxMessageTextChars) {
        throw new InputBudgetError(`消息文字超过 ${config.maxMessageTextChars.toLocaleString()} 字符限制`);
      }
      out.push(part);
      continue;
    }
    if (part.type !== 'image' || !part.uploadId || seenUploads.has(part.uploadId)) continue;
    seenUploads.add(part.uploadId);
    if (seenUploads.size > config.maxAttachmentsPerMessage) {
      throw new InputBudgetError(`每条消息最多添加 ${config.maxAttachmentsPerMessage} 张图片`);
    }
    const media = await getOwnedUploadMedia(part.uploadId, ownerId);
    if (!media) throw new InputBudgetError('附件不存在或不属于当前账号', 400);
    imageBytes += media.size;
    if (imageBytes > config.maxMessageAttachmentBytes) {
      throw new InputBudgetError('本条消息的附件总大小超过限制');
    }
    out.push({ type: 'image', uploadId: part.uploadId });
  }
  if (!out.length) throw new InputBudgetError('消息内容不能为空', 400);
  return out;
}

type PlannedPart = AdapterMessagePart | { type: 'pending_image'; media: OwnedMedia };

function adapterTextCost(part: MessagePart): number {
  if (part.type === 'text') return part.text.length;
  if (part.type === 'tool_call') return part.id.length + part.name.length + part.args.length;
  if (part.type === 'tool_result') return part.toolCallId.length + part.name.length + part.result.length;
  return 0;
}

/**
 * Build a newest-first bounded replay window, then resolve only the images that
 * fit. Duplicate media references are omitted across the whole context.
 */
async function buildBoundedHistory(
  rows: { role: string; parts: string }[], ownerId: string, includeImages: boolean,
): Promise<{ messages: AdapterMessage[]; mediaLease: AdmissionLease }> {
  const chosen: { role: 'user' | 'assistant'; parts: PlannedPart[] }[] = [];
  const seenMedia = new Set<string>();
  const mediaCache = new Map<string, Promise<OwnedMedia | null>>();
  let textChars = 0;
  let imageBytes = 0;
  let imageCount = 0;

  const getMedia = (part: Extract<MessagePart, { type: 'image' }>) => {
    const key = part.uploadId ? `u:${part.uploadId}` : part.imageId ? `i:${part.imageId}` : '';
    if (!key) return { key, media: Promise.resolve(null) };
    let media = mediaCache.get(key);
    if (!media) {
      media = part.uploadId
        ? getOwnedUploadMedia(part.uploadId, ownerId)
        : getOwnedImageMedia(part.imageId!, ownerId);
      mediaCache.set(key, media);
    }
    return { key, media };
  };

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const stored = closeDanglingToolCalls(parseParts(row.parts), '(调用未完成)');
    const planned: PlannedPart[] = [];
    const localMediaKeys: string[] = [];
    let rowText = 0;
    let rowImageBytes = 0;
    let rowImageCount = 0;

    for (const part of stored) {
      if (part.type === 'reasoning') continue;
      if (part.type === 'image') {
        if (!includeImages) continue;
        const ref = getMedia(part);
        if (!ref.key || seenMedia.has(ref.key) || localMediaKeys.includes(ref.key)) continue;
        const media = await ref.media;
        if (!media) continue;
        planned.push({ type: 'pending_image', media });
        localMediaKeys.push(ref.key);
        rowImageBytes += media.size;
        rowImageCount++;
        continue;
      }
      rowText += adapterTextCost(part);
      const converted = toAdapterPartNoImage(part);
      if (converted) planned.push(converted);
    }

    if (!planned.length) continue;
    const over = textChars + rowText > config.maxContextTextChars
      || imageBytes + rowImageBytes > config.maxContextImageBytes
      || imageCount + rowImageCount > config.maxContextImages;
    if (over) {
      if (!chosen.length) throw new InputBudgetError('当前消息超过模型上下文预算,请缩短文字或减少图片');
      break;
    }
    chosen.unshift({ role: row.role as 'user' | 'assistant', parts: planned });
    textChars += rowText;
    imageBytes += rowImageBytes;
    imageCount += rowImageCount;
    for (const key of localMediaKeys) seenMedia.add(key);
  }

  while (chosen.length && chosen[0].role !== 'user') chosen.shift();
  const mediaLease = tryReserveContextImageBytes(ownerId, imageBytes);
  if (!mediaLease) {
    throw new InputBudgetError('当前图片上下文总量繁忙,请等待其他图片对话完成后重试', 429);
  }
  const out: AdapterMessage[] = [];
  try {
    for (const message of chosen) {
      const parts: AdapterMessagePart[] = [];
      for (const part of message.parts) {
        if (part.type === 'pending_image') {
          parts.push({ type: 'image', ...(await readMediaBase64(part.media, config.maxContextImageBytes)) });
        } else {
          parts.push(part);
        }
      }
      if (parts.length) out.push({ role: message.role, parts });
    }
    return { messages: out, mediaLease };
  } catch (err) {
    mediaLease.release();
    throw err;
  }
}

function chatSummary(c: typeof schema.chats.$inferSelect) {
  return {
    id: c.id, title: c.title, pinned: !!c.pinned, modelId: c.modelId,
    projectId: c.projectId, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

function ownsProject(projectId: string, userId: string): boolean {
  return !!db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId))).get();
}

function messageDto(m: typeof schema.messages.$inferSelect) {
  return {
    id: m.id, role: m.role, parts: parseParts(m.parts), model: m.model,
    status: m.status, error: m.error,
    promptTokens: m.promptTokens, completionTokens: m.completionTokens, totalTokens: m.totalTokens,
    durationMs: m.durationMs, ttftMs: m.ttftMs, createdAt: m.createdAt,
  };
}

/**
 * Turn the chat's saved level name into something every vendor can consume.
 * The name is only honoured while it is still on the model's ladder, so editing
 * a model's levels — or a default ladder changing under it — can never leave a
 * chat sending a level the provider will reject.
 */
function resolveReasoning(
  saved: string | null,
  model: typeof schema.models.$inferSelect,
  type: ProviderType,
): ReasoningRequest | undefined {
  if (!saved) return undefined;
  const levels = effectiveLevels(model.reasoningMode, model.reasoningLevels, type, model.modelId);
  if (!levels.length) return undefined;
  if (saved === OFF) return { level: OFF, ratio: 0 };
  const idx = levels.findIndex((l) => l.value === saved);
  if (idx < 0) return undefined;
  // Spread across the whole ladder so the weakest level is genuinely cheap.
  // `off` is identified by name, never by a zero ratio.
  return { level: saved, ratio: levels.length > 1 ? idx / (levels.length - 1) : 1 };
}

function getModelWithProvider(modelDbId: string | null) {
  if (!modelDbId) return null;
  const row = db.select().from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(and(eq(schema.models.id, modelDbId), eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1)))
    .get();
  return row ? { model: row.models, provider: row.providers } : null;
}

function enabledModelRows() {
  return db.select().from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(and(eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1)))
    .orderBy(asc(schema.models.sortOrder)).all();
}

function pickModel(rows: ReturnType<typeof enabledModelRows>) {
  const def = rows.find((r) => r.models.isDefault) ?? rows[0];
  return def ? { model: def.models, provider: def.providers } : null;
}

// Fallback when neither the request nor the chat names a model. Prefers a text
// model — silently defaulting to an image model would surprise every new chat.
// Only considers models this user is allowed to see.
function getDefaultModel(user: { id: string; role: string }) {
  let rows = enabledModelRows();
  if (user.role !== 'admin') {
    const granted = grantedModelIds(user.id);
    rows = rows.filter((r) => r.models.accessMode === 'shared' || granted.has(r.models.id));
  }
  const text = rows.filter((r) => !r.models.imageGen);
  return pickModel(text.length ? text : rows);
}

// Admin-designated cheap model for auto-titling ('' = unset). Keeps the big
// conversation model out of a job any small model does fine.
export const TITLE_MODEL_KEY = 'title_model_id';

// Titles need a text model: an image model can't answer the title prompt.
// Preference order: the admin-designated title model → the model that just
// answered (text turns only) → any enabled text model.
function getTitleModel(current?: { model: typeof schema.models.$inferSelect; provider: typeof schema.providers.$inferSelect }) {
  const configured = getSetting<string>(TITLE_MODEL_KEY, '');
  if (configured) {
    const picked = getModelWithProvider(configured);
    if (picked && !picked.model.imageGen) return picked;
  }
  if (current && !current.model.imageGen) return current;
  return pickModel(enabledModelRows().filter((r) => !r.models.imageGen));
}

const IMAGE_TIMEOUT_MS = 300_000;
const IMAGE_CONTEXT_CHARS = 3000;
const IMAGE_MAX_REFS = 4;

// Image APIs take one prompt, not a conversation, so flatten what was said before
// into it. (Gemini additionally gets the real history — see ImageGenRequest.context.)
function buildImageTurn(history: AdapterMessage[]) {
  const textOf = (m: AdapterMessage) => m.parts
    .filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n').trim();

  const request = textOf(history[history.length - 1]) || '继续上面的对话,生成一张图片。';
  const lines: string[] = [];
  for (const m of history.slice(0, -1)) {
    const label = m.role === 'user' ? '用户' : '助手';
    const t = textOf(m).replace(/\s+/g, ' ');
    if (t) lines.push(`${label}: ${t.slice(0, 600)}`);
    else if (m.parts.some((p) => p.type === 'image')) lines.push(`${label}: (图片)`);
  }
  let prompt = request;
  if (lines.length) {
    let ctx = lines.join('\n');
    if (ctx.length > IMAGE_CONTEXT_CHARS) ctx = `…${ctx.slice(-IMAGE_CONTEXT_CHARS)}`;
    prompt = `[之前的对话]\n${ctx}\n\n[本次绘图要求]\n${request}`;
  }

  // Reference images = the most recent pictures in the conversation (attachments and
  // earlier generations), so "把它改成蓝色" edits the image actually being discussed.
  const refImages: { mime: string; dataBase64: string }[] = [];
  for (const m of history) {
    for (const p of m.parts) {
      if (p.type === 'image' && p.dataBase64) {
        refImages.push({ mime: p.mime || 'image/png', dataBase64: p.dataBase64 });
      }
    }
  }
  return { prompt, request, refImages: refImages.slice(-IMAGE_MAX_REFS) };
}

const partSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().min(1).max(config.maxMessageTextChars) }),
  z.object({ type: z.literal('image'), uploadId: z.string().min(1).max(64) }),
]);

const streamBodySchema = z.object({
  content: z.array(partSchema).min(1).max(20).optional(),
  modelId: z.string().max(64).optional(),
  regenerateMessageId: z.string().max(64).optional(),
  editMessageId: z.string().max(64).optional(),
});

const TITLE_PROMPT = '请为上面这段对话生成一个简短的标题(不超过16个字),直接输出标题文本,不要任何引号、句号或解释。';

// Injected when the admin-designated search MCP rides on the request. There is
// deliberately no "search now" button: like the first-party ChatGPT/Claude/
// Gemini panels, the tools are simply present and the model decides per
// question whether calling them is worth it.
const SEARCH_HINT = '你可以使用联网搜索工具。当问题涉及时效性信息、近期事件、具体数据或你不确定的事实时,先搜索再回答;闲聊、常识或纯创作类请求无需搜索。基于搜索结果回答时,请在文末列出所引用的来源链接。';

export async function chatRoutes(app: FastifyInstance) {
  app.get('/api/chats', async (req, reply) => {
    requireAuth(req, reply);
    const rows = db.select().from(schema.chats).where(eq(schema.chats.userId, req.user!.id)).all();
    rows.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    return { chats: rows.map(chatSummary) };
  });

  app.post('/api/chats', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({
      modelId: z.string().max(64).nullish(),
      projectId: z.string().max(64).nullish(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    if (body.data.projectId && !ownsProject(body.data.projectId, req.user!.id)) {
      return reply.code(404).send({ error: '项目不存在' });
    }
    const id = newId();
    const t = now();
    db.insert(schema.chats).values({
      id, userId: req.user!.id, title: '', modelId: body.data.modelId ?? null,
      projectId: body.data.projectId ?? null,
      createdAt: t, updatedAt: t,
    }).run();
    const c = db.select().from(schema.chats).where(eq(schema.chats.id, id)).get()!;
    return { chat: { ...chatSummary(c), systemPrompt: c.systemPrompt, temperature: c.temperature, maxTokens: c.maxTokens, reasoningEffort: c.reasoningEffort, webSearch: false, mcpServerIds: [] } };
  });

  app.get('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    // seq is the ordering key (createdAt collides at ms/s granularity — see
    // schema); createdAt only breaks ties for pre-seq rows that are all 0.
    const msgs = db.select().from(schema.messages).where(eq(schema.messages.chatId, id))
      .orderBy(asc(schema.messages.seq), asc(schema.messages.createdAt)).all();
    let savedMcpServerIds: string[] = [];
    try { savedMcpServerIds = JSON.parse(c.mcpServerIds); } catch { /* ignore */ }
    const searchServerId = getSearchServerId();
    const legacySearch = !!searchServerId && savedMcpServerIds.includes(searchServerId);
    const mcpServerIds = validateMcpSelection(
      req.user!, savedMcpServerIds.filter((serverId) => serverId !== searchServerId),
    ).allowed;
    return {
      chat: {
        ...chatSummary(c),
        systemPrompt: c.systemPrompt, temperature: c.temperature,
        maxTokens: c.maxTokens, reasoningEffort: c.reasoningEffort,
        webSearch: !!c.webSearch || legacySearch, mcpServerIds,
      },
      messages: msgs.map(messageDto),
    };
  });

  app.patch('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      title: z.string().max(120).optional(),
      systemPrompt: z.string().max(20_000).nullish(),
      temperature: z.number().min(0).max(2).nullish(),
      maxTokens: z.number().int().min(1).max(config.maxModelOutputTokens).nullish(),
      reasoningEffort: z.string().max(32).nullish(),
      webSearch: z.boolean().optional(),
      mcpServerIds: z.array(z.string().max(64)).max(20).optional(),
      pinned: z.boolean().optional(),
      modelId: z.string().max(64).nullish(),
      projectId: z.string().max(64).nullish(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const d = body.data;
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (d.title !== undefined) patch.title = d.title;
    if (d.systemPrompt !== undefined) patch.systemPrompt = d.systemPrompt;
    if (d.temperature !== undefined) patch.temperature = d.temperature;
    if (d.maxTokens !== undefined) patch.maxTokens = d.maxTokens;
    if (d.reasoningEffort !== undefined) patch.reasoningEffort = d.reasoningEffort;
    const searchServerId = getSearchServerId();
    if (d.webSearch !== undefined) patch.webSearch = d.webSearch ? 1 : 0;
    if (d.mcpServerIds !== undefined) {
      // Search intent is now provider-neutral and stored separately. Never let
      // the designated fallback leak back into the generic tool selection.
      const requested = d.mcpServerIds.filter((serverId) => serverId !== searchServerId);
      const access = validateMcpSelection(req.user!, requested);
      if (access.denied.length) {
        return reply.code(403).send({ error: '所选 MCP 服务器不存在、已禁用或未授权' });
      }
      patch.mcpServerIds = JSON.stringify(access.allowed);
    } else if (d.webSearch !== undefined && searchServerId) {
      // Best-effort legacy cleanup only. Do not make changing the search toggle
      // fail because an unrelated, previously saved MCP grant was revoked.
      let saved: string[] = [];
      try { saved = JSON.parse(c.mcpServerIds); } catch { /* ignore */ }
      patch.mcpServerIds = JSON.stringify(saved.filter((serverId) => serverId !== searchServerId));
    }
    if (d.pinned !== undefined) patch.pinned = d.pinned ? 1 : 0;
    if (d.modelId !== undefined) patch.modelId = d.modelId;
    if (d.projectId !== undefined) {
      if (d.projectId && !ownsProject(d.projectId, req.user!.id)) {
        return reply.code(404).send({ error: '项目不存在' });
      }
      patch.projectId = d.projectId;
    }
    db.update(schema.chats).set(patch).where(eq(schema.chats.id, id)).run();
    const updated = db.select().from(schema.chats).where(eq(schema.chats.id, id)).get()!;
    let savedMcpServerIds: string[] = [];
    try { savedMcpServerIds = JSON.parse(updated.mcpServerIds); } catch { /* ignore */ }
    const mcpServerIds = validateMcpSelection(req.user!, savedMcpServerIds).allowed;
    return { chat: {
      ...chatSummary(updated), systemPrompt: updated.systemPrompt, temperature: updated.temperature,
      maxTokens: updated.maxTokens, reasoningEffort: updated.reasoningEffort,
      webSearch: !!updated.webSearch, mcpServerIds,
    } };
  });

  // Remove one message from the conversation. History is always re-read from
  // this table when building provider context, so a deleted row is gone from
  // every later turn — which is the whole point of the feature.
  app.delete('/api/chats/:id/messages/:messageId', async (req, reply) => {
    requireAuth(req, reply);
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const c = db.select({ id: schema.chats.id }).from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msg = db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.chatId, chatId))).get();
    if (!msg) return reply.code(404).send({ error: '消息不存在' });
    if (msg.status === 'streaming') {
      return reply.code(409).send({ error: '正在生成中的消息不能删除' });
    }
    db.delete(schema.messages).where(eq(schema.messages.id, messageId)).run();
    db.update(schema.chats).set({ updatedAt: now() }).where(eq(schema.chats.id, chatId)).run();
    await cleanupUnreferencedUploads(req.user!.id, uploadIdsFromPartsJson(msg.parts));
    return { ok: true };
  });

  // Fork the conversation: a brand-new chat carrying the full message history
  // and every per-chat setting, titled 「原标题·分支」.
  app.post('/api/chats/:id/branch', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msgs = db.select().from(schema.messages).where(eq(schema.messages.chatId, id))
      .orderBy(asc(schema.messages.seq), asc(schema.messages.createdAt)).all();
    const branchId = newId();
    const t = now();
    db.insert(schema.chats).values({
      id: branchId, userId: c.userId,
      title: `${c.title || '对话'}·分支`.slice(0, 120),
      modelId: c.modelId, projectId: c.projectId,
      systemPrompt: c.systemPrompt, temperature: c.temperature, maxTokens: c.maxTokens,
      reasoningEffort: c.reasoningEffort, webSearch: c.webSearch, mcpServerIds: c.mcpServerIds,
      createdAt: t, updatedAt: t,
    }).run();
    for (const m of msgs) {
      db.insert(schema.messages).values({
        ...m, id: newId(), chatId: branchId,
        // A lingering 'streaming' row (crashed turn) must not fork as one — the
        // client would wait forever for output that is never coming.
        status: m.status === 'streaming' ? 'stopped' : m.status,
      }).run();
    }
    const created = db.select().from(schema.chats).where(eq(schema.chats.id, branchId)).get()!;
    return { chat: chatSummary(created) };
  });

  app.delete('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const uploadIds = db.select({ parts: schema.messages.parts }).from(schema.messages)
      .where(eq(schema.messages.chatId, id)).all()
      .flatMap((m) => uploadIdsFromPartsJson(m.parts));
    db.delete(schema.chats).where(eq(schema.chats.id, id)).run();
    await cleanupUnreferencedUploads(req.user!.id, uploadIds);
    return { ok: true };
  });

  // ---- the main streaming endpoint ----
  app.post('/api/chats/:id/stream', async (req, reply) => {
    requireAuth(req, reply);
    const user = req.user!;
    const { id: chatId } = req.params as { id: string };
    const parsed = streamBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const body = parsed.data;

    const chat = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, user.id))).get();
    if (!chat) return reply.code(404).send({ error: '对话不存在' });

    // resolve model
    const picked = getModelWithProvider(body.modelId ?? chat.modelId) ?? getDefaultModel(user);
    if (!picked) return reply.code(400).send({ error: '没有可用的模型,请联系管理员配置' });
    let { model, provider } = picked;
    if (!canUseModel(user, model.id)) {
      return reply.code(403).send({ error: '该模型未对你开放,请选择其他模型' });
    }

    // Monthly token quota. Over-quota text turns can be downgraded to the
    // admin-designated fallback model; image turns are always refused (there
    // is no cheaper model to fall back to).
    let downgradeNotice: string | null = null;
    const quota = checkQuota(user.id);
    if (!quota.ok) {
      let downgraded = false;
      if (quota.action === 'downgrade' && !model.imageGen && quota.fallbackModelId) {
        const fallback = getModelWithProvider(quota.fallbackModelId);
        if (fallback && !fallback.model.imageGen) {
          if (fallback.model.id !== model.id) {
            ({ model, provider } = fallback);
            downgradeNotice = `本月 token 配额已用完,已自动切换到基础模型「${model.displayName || model.modelId}」`;
          }
          downgraded = true;
        }
      }
      if (!downgraded) return reply.code(429).send({ error: quotaBlockMessage(quota) });
    }

    const chatLease = tryAcquireChatTurn(user.id, chatId);
    if (!chatLease) {
      return reply.code(429).send({ error: '对话并发数已达上限,请等待其他回复完成' });
    }
    let imageLease: AdmissionLease | null = null;
    let imageReservation: StorageReservation | null = null;
    let contextMediaLease: AdmissionLease | null = null;

    // From admission through MCP discovery and provider I/O, every exit path
    // releases all process-local leases/reservations.
    try {
    if (model.imageGen) {
      imageLease = tryAcquireImageJob(user.id);
      if (!imageLease) {
        return reply.code(429).send({ error: '图片生成并发数已达上限,请等待当前任务完成' });
      }
      const reserved = tryReserveStorage(user.id, 'image', config.maxGeneratedImageBytes);
      if (!reserved.ok) {
        return reply.code(413).send({ error: quotaErrorMessage('image', reserved.reason) });
      }
      imageReservation = reserved.reservation;
    }

    let normalizedContent: MessagePart[] | undefined;
    if (body.content && !body.regenerateMessageId) {
      try {
        normalizedContent = await normalizeIncomingParts(body.content as MessagePart[], user.id);
      } catch (err) {
        if (err instanceof InputBudgetError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    }

    // --- plan the mutation and context before touching saved history ---
    let userMessageId: string | null = null;
    let removedUploadIds: string[] = [];
    let history: { role: string; parts: string }[];
    let applyHistoryMutation: () => void;
    if (body.regenerateMessageId) {
      const target = db.select().from(schema.messages)
        .where(and(eq(schema.messages.id, body.regenerateMessageId), eq(schema.messages.chatId, chatId))).get();
      if (!target) return reply.code(404).send({ error: '消息不存在' });
      removedUploadIds = db.select({ parts: schema.messages.parts }).from(schema.messages)
        .where(and(eq(schema.messages.chatId, chatId), gte(schema.messages.seq, target.seq))).all()
        .flatMap((m) => uploadIdsFromPartsJson(m.parts));
      history = db.select().from(schema.messages)
        .where(and(eq(schema.messages.chatId, chatId), lt(schema.messages.seq, target.seq)))
        .orderBy(desc(schema.messages.seq)).limit(config.maxContextMessages).all().reverse()
        .filter((m) => !(m.role === 'assistant' && m.status === 'error' && parseParts(m.parts).length === 0));
      applyHistoryMutation = () => {
        db.delete(schema.messages)
          .where(and(eq(schema.messages.chatId, chatId), gte(schema.messages.seq, target.seq))).run();
      };
    } else if (body.editMessageId) {
      if (!normalizedContent) return reply.code(400).send({ error: '缺少消息内容' });
      const target = db.select().from(schema.messages)
        .where(and(eq(schema.messages.id, body.editMessageId), eq(schema.messages.chatId, chatId))).get();
      if (!target || target.role !== 'user') return reply.code(404).send({ error: '消息不存在' });
      const normalizedJson = JSON.stringify(normalizedContent);
      removedUploadIds = db.select({ parts: schema.messages.parts }).from(schema.messages)
        .where(and(eq(schema.messages.chatId, chatId), gte(schema.messages.seq, target.seq))).all()
        .flatMap((m) => uploadIdsFromPartsJson(m.parts));
      history = db.select().from(schema.messages)
        .where(and(eq(schema.messages.chatId, chatId), lte(schema.messages.seq, target.seq)))
        .orderBy(desc(schema.messages.seq)).limit(config.maxContextMessages).all().reverse()
        .filter((m) => !(m.role === 'assistant' && m.status === 'error' && parseParts(m.parts).length === 0))
        .map((m) => m.id === target.id ? { ...m, parts: normalizedJson } : m);
      applyHistoryMutation = () => {
        db.update(schema.messages).set({ parts: normalizedJson })
          .where(eq(schema.messages.id, target.id)).run();
        db.delete(schema.messages)
          .where(and(eq(schema.messages.chatId, chatId), gt(schema.messages.seq, target.seq))).run();
      };
      userMessageId = target.id;
    } else {
      if (!normalizedContent) return reply.code(400).send({ error: '缺少消息内容' });
      userMessageId = newId();
      const seq = nextSeq(chatId);
      const createdAt = now();
      const normalizedJson = JSON.stringify(normalizedContent);
      history = db.select().from(schema.messages).where(eq(schema.messages.chatId, chatId))
        .orderBy(desc(schema.messages.seq)).limit(config.maxContextMessages - 1).all().reverse()
        .filter((m) => !(m.role === 'assistant' && m.status === 'error' && parseParts(m.parts).length === 0));
      history.push({ role: 'user', parts: normalizedJson });
      applyHistoryMutation = () => {
        db.insert(schema.messages).values({
          id: userMessageId!, chatId, role: 'user', seq, parts: normalizedJson, createdAt,
        }).run();
      };
    }
    if (!history.length || history[history.length - 1].role !== 'user') {
      return reply.code(400).send({ error: '当前对话状态无法生成回复' });
    }

    // Image models are fed pictures too — that's the whole point of "edit this one".
    const withImages = !!model.vision || !!model.imageGen;
    let baseHistory: AdapterMessage[];
    try {
      const bounded = await buildBoundedHistory(history, user.id, withImages);
      baseHistory = bounded.messages;
      contextMediaLease = bounded.mediaLease;
    } catch (err) {
      if (err instanceof InputBudgetError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
    applyHistoryMutation();
    if (removedUploadIds.length) await cleanupUnreferencedUploads(user.id, removedUploadIds);

    // Search is a provider-neutral chat preference. Vertex Gemini 2.5+ uses
    // googleSearch directly; other models can still fall back to the one
    // admin-designated search MCP. Legacy chats may carry that MCP id instead
    // of the new web_search bit, so treat it as the same intent.
    let savedMcpServerIds: string[] = [];
    try { savedMcpServerIds = JSON.parse(chat.mcpServerIds); } catch { /* ignore */ }
    const searchServerId = getSearchServerId();
    const webSearchRequested = !!chat.webSearch
      || (!!searchServerId && savedMcpServerIds.includes(searchServerId));
    const nativeSearchCapable = webSearchRequested && !!model.tools && !model.imageGen
      && provider.type === 'gemini' && !!provider.useVertex
      && supportsVertexGoogleSearch(model.modelId);
    const requestedMcpServerIds = savedMcpServerIds.filter((id) => id !== searchServerId);
    if (webSearchRequested && !nativeSearchCapable && searchServerId) {
      requestedMcpServerIds.push(searchServerId);
    }

    const mcpAccess = validateMcpSelection(user, requestedMcpServerIds);
    const mcpServerIds = mcpAccess.allowed;
    let toolDefs: ToolDef[] | undefined;
    let toolErrors: { serverId: string; name: string; error: string }[] = [];
    let toolCapabilities: McpCapabilities = { routes: new Map() };
    if (model.tools && !model.imageGen && mcpServerIds.length) {
      const r = await getToolsForServers(mcpServerIds, user);
      toolDefs = r.tools.length ? r.tools : undefined;
      toolErrors = r.errors;
      toolCapabilities = r.capabilities;
    }
    const mcpSearchActive = webSearchRequested && !nativeSearchCapable && !!searchServerId
      && [...toolCapabilities.routes.values()].some((route) => route.serverId === searchServerId);

    // Project knowledge leads the prompt: it is the stable, cacheable prefix
    // (per-chat systemPrompt varies more often than the project block does).
    // Small corpora ride along whole; big ones become a manifest plus the
    // project_search / project_read_doc tools. Image turns skip all of it.
    const project = chat.projectId && !model.imageGen
      ? buildProjectPrompt(chat.projectId, user.id, !!model.tools)
      : { block: null, tools: null };
    if (project.tools?.length) toolDefs = [...(toolDefs ?? []), ...project.tools];
    // Vertex currently rejects googleSearch + functionDeclarations in one
    // generateContent request. Preserve explicit MCP/project tools and disable
    // native search for this turn rather than silently dropping those tools.
    const nativeSearchBlockedByTools = nativeSearchCapable && !!toolDefs?.length;
    const nativeSearchActive = nativeSearchCapable && !nativeSearchBlockedByTools;
    const searchActive = nativeSearchActive || mcpSearchActive;
    const systemPrompt = [project.block, chat.systemPrompt, searchActive ? SEARCH_HINT : null]
      .filter(Boolean).join('\n\n') || undefined;
    // Take one snapshot for the whole turn. It covers Provider credentials,
    // custom headers, MCP env/headers, and SECRET_KEY without querying per token.
    const secretValues = allConfiguredSecretValues();

    // --- start streaming ---
    const sse = createSse(reply);
    const controller = new AbortController();
    let clientGone = false;
    // response 'close' with writableEnded=false → client disconnected mid-stream
    // (request 'close' fires as soon as the body is consumed on Node 16+, so it's unusable here)
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) { clientGone = true; controller.abort(); }
    });

    const assistantId = newId();
    db.insert(schema.messages).values({
      id: assistantId, chatId, role: 'assistant', parts: '[]', seq: nextSeq(chatId),
      model: model.modelId, providerId: provider.id, status: 'streaming', createdAt: now(),
    }).run();
    if (body.modelId && body.modelId !== chat.modelId) {
      db.update(schema.chats).set({ modelId: body.modelId }).where(eq(schema.chats.id, chatId)).run();
    }

    sse.send('meta', { messageId: assistantId, userMessageId, model: model.modelId });
    if (downgradeNotice) sse.send('notice', { message: downgradeNotice });
    if (mcpAccess.denied.length) {
      sse.send('notice', { message: '部分 MCP 服务器已被禁用或撤销授权,本次不会调用' });
    }
    if (nativeSearchBlockedByTools) {
      sse.send('notice', { message: 'Vertex Google 搜索暂不能与 MCP/项目检索工具在同一次请求中组合,本轮保留其他工具并跳过联网搜索' });
    }
    for (const te of toolErrors) sse.send('notice', { message: `MCP 服务器「${te.name}」连接失败: ${te.error}` });

    const cfg = toRuntimeConfig(provider);
    const adapter = getAdapter(provider.type);
    const parts: MessagePart[] = [];
    const usage = { prompt: 0, completion: 0, total: 0 };
    let ttft: number | null = null;
    const t0 = Date.now();
    let status: 'done' | 'error' | 'stopped' = 'done';
    let errMsg: string | null = null;
    let imageCount = 0;
    let outputChars = 0;
    let textTimeoutError: string | null = null;
    let textTurnTimer: ReturnType<typeof setTimeout> | null = null;
    let providerIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const consumeOutput = (chars: number) => {
      outputChars += Math.max(0, chars);
      if (outputChars > config.maxTurnOutputChars) {
        throw new Error(`单次回复超过 ${config.maxTurnOutputChars} 字符限制`);
      }
    };
    const abortTextForTimeout = (message: string) => {
      if (controller.signal.aborted) return;
      textTimeoutError = message;
      controller.abort(new DOMException(message, 'TimeoutError'));
    };
    const clearProviderIdleTimer = () => {
      if (providerIdleTimer) clearTimeout(providerIdleTimer);
      providerIdleTimer = null;
    };
    const resetProviderIdleTimer = () => {
      clearProviderIdleTimer();
      providerIdleTimer = setTimeout(() => abortTextForTimeout(
        `Provider 连续 ${Math.ceil(config.chatProviderIdleTimeoutMs / 1000)} 秒没有返回数据`,
      ), config.chatProviderIdleTimeoutMs);
    };
    const clearTextTimers = () => {
      if (textTurnTimer) clearTimeout(textTurnTimer);
      textTurnTimer = null;
      clearProviderIdleTimer();
    };

    try {
      if (model.imageGen) {
        // ---- image-generation turn ----
        if (!adapter.generateImages) throw new Error(`Provider「${provider.name}」不支持图像生成`);
        const { prompt, request, refImages } = buildImageTurn(baseHistory);
        let generated;
        try {
          generated = await adapter.generateImages(cfg, {
            model: model.modelId,
            prompt,
            n: 1,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
            inputImages: refImages.length ? refImages : undefined,
            system: chat.systemPrompt || undefined,
            context: baseHistory,
          });
        } catch (e) {
          if (!controller.signal.aborted && (e as Error)?.name === 'TimeoutError') {
            throw new Error('图像生成超时(超过 5 分钟)');
          }
          throw e;
        }
        const elapsed = Date.now() - t0;
        if (generated.length !== 1) throw new Error('Provider 返回的图片数量异常');
        for (const g of generated) {
          const saved = await saveGeneratedImage({
            userId: user.id, providerId: provider.id, model: model.modelId,
            prompt: request, size: null, durationMs: elapsed, img: g, source: 'chat',
          });
          const part: MessagePart = {
            type: 'image', imageId: saved.id,
            mime: redactSensitiveText(g.mime, secretValues),
          };
          parts.push(part);
          sse.send('image', part);
          if (g.text) {
            consumeOutput(g.text.length);
            const safeText = redactSensitiveText(g.text, secretValues);
            appendText(parts, 'text', safeText);
            sse.send('delta', { text: safeText });
          }
        }
        // one response can carry several images with the same usage object — count it once
        const u = generated[0]?.usage;
        usage.prompt += u?.promptTokens ?? 0;
        usage.completion += u?.completionTokens ?? 0;
        usage.total += u?.totalTokens ?? ((u?.promptTokens ?? 0) + (u?.completionTokens ?? 0));
        imageCount = generated.length;
      } else {
        // ---- normal text turn ----
        textTurnTimer = setTimeout(() => abortTextForTimeout(
          `对话生成超过 ${Math.ceil(config.chatTurnTimeoutMs / 1000)} 秒总时限`,
        ), config.chatTurnTimeoutMs);
        let iterations = 0;
        for (;;) {
          iterations++;
          const messages = [...baseHistory];
          if (parts.length) messages.push({ role: 'assistant', parts: toAdapterPartsNoImages(parts) });
          const pendingCalls: { id: string; name: string; args: string }[] = [];
          let stopReason = 'stop';
          const textRedactor = new StreamingSecretRedactor(secretValues);
          const reasoningRedactor = new StreamingSecretRedactor(secretValues);

          resetProviderIdleTimer();
          try {
            for await (const ev of adapter.streamChat(cfg, {
              model: model.modelId,
              system: systemPrompt,
              messages,
              tools: toolDefs,
              webSearch: nativeSearchActive,
              temperature: chat.temperature ?? undefined,
              maxTokens: Math.min(chat.maxTokens ?? config.defaultModelOutputTokens, config.maxModelOutputTokens),
              hardMaxTokens: config.maxModelOutputTokens,
              reasoning: resolveReasoning(chat.reasoningEffort, model, provider.type as ProviderType),
              signal: controller.signal,
            })) {
              resetProviderIdleTimer();
              if (ev.type === 'text') {
                if (ttft === null) ttft = Date.now() - t0;
                consumeOutput(ev.text.length);
                const safeText = textRedactor.push(ev.text);
                if (safeText) {
                  appendText(parts, 'text', safeText);
                  sse.send('delta', { text: safeText });
                }
              } else if (ev.type === 'reasoning') {
                if (ttft === null) ttft = Date.now() - t0;
                consumeOutput(ev.text.length);
                const safeText = reasoningRedactor.push(ev.text);
                if (safeText) {
                  appendText(parts, 'reasoning', safeText);
                  sse.send('reasoning', { text: safeText });
                }
              } else if (ev.type === 'tool_call') {
                consumeOutput(ev.id.length + ev.name.length + ev.args.length);
                const safeCall = {
                  ...ev,
                  id: redactSensitiveText(ev.id, secretValues),
                  name: redactSensitiveText(ev.name, secretValues),
                  args: redactSensitiveText(ev.args, secretValues),
                  sig: ev.sig ? redactSensitiveText(ev.sig, secretValues) : undefined,
                };
                parts.push({
                  type: 'tool_call', id: safeCall.id, name: safeCall.name,
                  args: safeCall.args, sig: safeCall.sig,
                });
                pendingCalls.push(safeCall);
                sse.send('tool_call', { id: safeCall.id, name: safeCall.name, args: safeCall.args });
              } else if (ev.type === 'grounding') {
                const grounding = safeGroundingPart(ev.grounding, secretValues);
                if (grounding) {
                  parts.push(grounding);
                  sse.send('grounding', grounding);
                }
              } else if (ev.type === 'usage') {
                usage.prompt += ev.usage.promptTokens ?? 0;
                usage.completion += ev.usage.completionTokens ?? 0;
                usage.total += ev.usage.totalTokens ?? ((ev.usage.promptTokens ?? 0) + (ev.usage.completionTokens ?? 0));
              } else if (ev.type === 'stop') {
                stopReason = ev.reason;
              }
            }
          } finally {
            clearProviderIdleTimer();
            const textTail = textRedactor.flush();
            if (textTail) {
              appendText(parts, 'text', textTail);
              sse.send('delta', { text: textTail });
            }
            const reasoningTail = reasoningRedactor.flush();
            if (reasoningTail) {
              appendText(parts, 'reasoning', reasoningTail);
              sse.send('reasoning', { text: reasoningTail });
            }
          }

          if (stopReason === 'tool_calls' && pendingCalls.length && iterations < config.maxToolIterations) {
            for (const call of pendingCalls) {
              const remainingTurnMs = config.chatTurnTimeoutMs - (Date.now() - t0);
              if (remainingTurnMs <= 0) {
                abortTextForTimeout(`对话生成超过 ${Math.ceil(config.chatTurnTimeoutMs / 1000)} 秒总时限`);
                throw new Error(textTimeoutError ?? '对话生成超时');
              }
              // Project knowledge tools are served in-process; everything else
              // goes out to its MCP server.
              const { result, isError } = isProjectTool(call.name) && chat.projectId
                ? callProjectTool(chat.projectId, call.name, call.args)
                : await callTool(
                  call.name, call.args, toolCapabilities, user,
                  { timeoutMs: Math.max(1, Math.min(120_000, remainingTurnMs)) },
                );
              const safeResult = redactSensitiveText(result, secretValues);
              const resultLimit = Math.min(100_000, Math.floor(config.maxContextTextChars / 4));
              const trimmed = safeResult.length > resultLimit
                ? `${safeResult.slice(0, resultLimit)}\n…(结果已截断)`
                : safeResult;
              consumeOutput(call.name.length + trimmed.length);
              const part: MessagePart = { type: 'tool_result', toolCallId: call.id, name: call.name, result: trimmed, isError };
              parts.push(part);
              sse.send('tool_result', part);
            }
            continue;
          }
          break;
        }
      }
    } catch (e) {
      if (clientGone) {
        status = 'stopped';
      } else if (textTimeoutError) {
        status = 'error';
        errMsg = textTimeoutError;
        sse.send('error', { message: errMsg });
      } else if (controller.signal.aborted) {
        status = 'stopped';
      } else {
        status = 'error';
        errMsg = redactSensitiveText(e instanceof Error ? e.message : String(e), secretValues);
        sse.send('error', { message: errMsg });
      }
    }
    clearTextTimers();

    const finalParts = closeDanglingToolCalls(
      parts,
      status === 'stopped' ? '(用户已停止,调用未执行)' : '(调用未完成)',
    );
    const durationMs = Date.now() - t0;
    db.update(schema.messages).set({
      parts: JSON.stringify(finalParts),
      status, error: errMsg,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
      durationMs, ttftMs: ttft,
    }).where(eq(schema.messages.id, assistantId)).run();
    db.update(schema.chats).set({ updatedAt: now() }).where(eq(schema.chats.id, chatId)).run();
    recordUsage({
      userId: user.id, chatId, messageId: assistantId,
      providerId: provider.id, providerType: provider.type, model: model.modelId,
      kind: model.imageGen ? 'image' : 'chat',
      images: imageCount,
      promptTokens: usage.prompt, completionTokens: usage.completion, totalTokens: usage.total,
      durationMs,
    });

    sse.send('usage', {
      promptTokens: usage.prompt || null, completionTokens: usage.completion || null,
      totalTokens: usage.total || null, durationMs, ttftMs: ttft,
    });

    // auto-title on first successful exchange
    const titlePick = getTitleModel({ model, provider });
    if (!chat.title && status === 'done' && !clientGone && titlePick) {
      try {
        // text-only replay: the title never needs the pictures, and non-vision
        // title models would choke on them
        const titleMessages: AdapterMessage[] = baseHistory.map((m) => ({
          role: m.role,
          parts: m.parts.filter((p) => p.type !== 'image'),
        })).filter((m) => m.parts.length > 0);
        while (titleMessages.length && titleMessages[0].role !== 'user') titleMessages.shift();
        titleMessages.push(
          { role: 'assistant', parts: toAdapterPartsNoImages(finalParts) },
          { role: 'user', parts: [{ type: 'text', text: TITLE_PROMPT }] },
        );
        let title = '';
        const tUsage = { prompt: 0, completion: 0, total: 0 };
        const tAdapter = getAdapter(titlePick.provider.type);
        for await (const ev of tAdapter.streamChat(toRuntimeConfig(titlePick.provider), {
          model: titlePick.model.modelId, messages: titleMessages, maxTokens: 500,
          signal: AbortSignal.timeout(20_000),
        })) {
          if (ev.type === 'text') title += ev.text;
          else if (ev.type === 'usage') {
            tUsage.prompt += ev.usage.promptTokens ?? 0;
            tUsage.completion += ev.usage.completionTokens ?? 0;
            tUsage.total += ev.usage.totalTokens ?? 0;
          }
        }
        title = redactSensitiveText(title, secretValues)
          .trim().replace(/^["'「『]|["'」』]$/g, '').split('\n')[0].slice(0, 60);
        if (title) {
          db.update(schema.chats).set({ title }).where(eq(schema.chats.id, chatId)).run();
          sse.send('title', { title });
        }
        recordUsage({
          userId: user.id, chatId, providerId: titlePick.provider.id, providerType: titlePick.provider.type,
          model: titlePick.model.modelId, kind: 'title',
          promptTokens: tUsage.prompt, completionTokens: tUsage.completion, totalTokens: tUsage.total,
        });
      } catch { /* title generation is best-effort */ }
    }

    sse.send('done', { status });
    sse.end();
    } finally {
      contextMediaLease?.release();
      imageReservation?.release();
      imageLease?.release();
      chatLease.release();
    }
  });
}
