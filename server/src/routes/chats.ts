import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, now, today, getSetting } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { canUseProject } from '../project-access.js';
import { config } from '../config.js';
import { configuredModelFallback } from '../model-fallback.js';
import { ContinuationText } from '../continuation-text.js';
import { activeChatStream, beginChatStream, chatStreamReceipt, endChatStream, identifyChatStream } from '../chat-stream-state.js';
import { ProviderBusyError, isNetworkError } from '../providers/sse.js';
import { ProviderEmptyError, ProviderInterruptedError } from '../providers/stream-integrity.js';
import { ATTACHMENT_COUNT_MAX, maxAttachmentsPerMessage } from '../attachment-settings.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { supportsVertexGoogleSearch, supportsVertexSearchWithFunctions } from '../providers/gemini.js';
import { getToolsForServers, callTool, toolNeedsConfirm, type McpCapabilities } from '../mcp/manager.js';
import { isAutoAllowed, rememberAutoAllow, submitToolDecision, waitForToolDecision } from '../tool-confirm.js';
import { validateMcpSelection } from '../mcp/access.js';
import { getSearchServerId } from './mcp.js';
import { saveGeneratedImage } from './images.js';
import { recordUsage } from '../usage.js';
import { canUseModel, grantedModelIds, imageModelsAllowed, providerAllowed } from '../model-access.js';
import { checkModelLimit, checkQuota, modelLimitBlockMessage, modelLimitReason, quotaBlockMessage } from '../quota.js';
import { OFF, effectiveLevels } from '../reasoning.js';
import { buildProjectPrompt, projectFilesPrompt } from './projects.js';
import { callProjectTool, isProjectTool } from '../knowledge.js';
import { WORKSPACE_TOOL_DEFS, buildWorkspacePrompt, callWorkspaceTool, isWorkspaceTool, removeWorkspace } from '../workspace.js';
import { CONVERT_FILE_TOOL, CONVERT_TOOL_DEF, SANDBOX_TOOL_DEFS, buildConvertPrompt, buildSandboxPrompt, callSandboxTool, convertAvailableFor, isSandboxTool, isTrustedCommand, sandboxAvailableFor, sandboxNeedsConfirm } from '../sandbox/tool.js';
import { SKILL_TOOL_DEFS, buildSkillsPrompt, callSkillTool, isSkillTool, skillsFor } from '../skills.js';
import { getAgentSettings, policyAllows, userWantsAgentTools } from '../agent-settings.js';
import { GENERATE_IMAGE_TOOL, buildImageToolPrompt, callImageTool, imageToolDefinition, imageToolModelsFor } from '../image-tool.js';
import { COMPARE_DATA_TOOL, DATA_COMPARISON_PROMPT, callCompareData, comparisonPresentationIntent, comparisonToolDefinition } from '../data-comparison.js';
import { SUBAGENT_TOOL_DEFS, buildSubagentPrompt, formatSubagentResult, isSubagentTool, runSubagent, subagentAvailableFor } from '../subagent.js';
import { WEB_SEARCH_TOOL, WEB_SEARCH_TOOL_DEF, runWebSearch, webSearchToolAvailable } from '../web-search.js';
import { WEB_FETCH_TOOL, WEB_FETCH_TOOL_DEF, runWebFetch, webFetchAvailable } from '../web-fetch.js';
import { agentWebToolsAllowed, WebToolBudget, webResearchPrompt } from '../web-tool-policy.js';
import {
  branchSummary, clearSummaries, historyBudget, isSummaryLead, planHistory, saveSummary, summaryLead, summaryTargetChars, writeSummary,
  type HistoryPlan,
} from '../compaction.js';
import type {
  AdapterMessage, AdapterMessagePart, GroundingInfo, GroundingSource, MessagePart, ProviderType, FinishReason, ReasoningRequest, ToolDef, ProviderFailover, ProviderRetry, UsageInfo,
} from '../types.js';
import {
  tryAcquireChatTurn, tryAcquireImageJob, tryReserveContextImageBytes, type AdmissionLease,
} from '../admission.js';
import {
  getOwnedImageMedia, getOwnedUploadMedia, isTextDocMime, quotaErrorMessage, readMediaBase64,
  cleanupUnreferencedUploads, tryReserveStorage, uploadIdsFromPartsJson,
  type OwnedMedia, type StorageReservation, hasCompanionText } from '../storage.js';
import { extractDocText, wrapDocAttachment } from '../doc-text.js';
import {
  allConfiguredSecretValues, redactSensitiveText, redactSensitiveValue, StreamingSecretRedactor,
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
  res.once('close', () => clearInterval(ping));
  return {
    send(event: string, data: unknown) {
      if (res.destroyed || res.writableEnded) return;
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

type MessageRow = typeof schema.messages.$inferSelect;

// Every message of a chat in display order — (seq, createdAt) is also the
// sibling order inside the tree.
export function allChatMessages(chatId: string): MessageRow[] {
  return db.select().from(schema.messages).where(eq(schema.messages.chatId, chatId))
    .orderBy(asc(schema.messages.seq), asc(schema.messages.createdAt)).all();
}

/** Root→leaf chain for one branch of the message tree. [] if leafId is unknown. */
function ancestorChain(rows: MessageRow[], leafId: string | null | undefined): MessageRow[] {
  if (!leafId) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: MessageRow[] = [];
  const seen = new Set<string>();
  let cur = byId.get(leafId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

// The branch on screen: the saved leaf while it still exists, else the newest
// message (which is what pre-tree chats effectively showed).
export function resolveLeafId(rows: MessageRow[], savedLeafId: string | null): string | null {
  if (savedLeafId && rows.some((r) => r.id === savedLeafId)) return savedLeafId;
  return rows.length ? rows[rows.length - 1].id : null;
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
const MAX_GROUNDING_SUPPORTS = 200;

function safeGroundingPart(
  grounding: GroundingInfo, secretValues: string[],
): Extract<MessagePart, { type: 'grounding' }> | null {
  const queries = [...new Set(grounding.queries)]
    .map((q) => redactSensitiveText(q.trim(), secretValues).slice(0, 500))
    .filter(Boolean).slice(0, MAX_GROUNDING_QUERIES);
  // Dedupe/filter sources while remembering where each original index went,
  // so the supports (which cite original positions) can follow.
  const byHref = new Map<string, number>();
  const remap = new Map<number, number>();
  const sources: { uri: string; title: string }[] = [];
  grounding.sources.forEach((source, origIdx) => {
    let uri: URL;
    try { uri = new URL(source.uri); } catch { return; }
    if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password) return;
    const href = redactSensitiveText(uri.toString(), secretValues).slice(0, 4000);
    const existing = byHref.get(href);
    if (existing !== undefined) { remap.set(origIdx, existing); return; }
    if (sources.length >= MAX_GROUNDING_SOURCES) return;
    const title = redactSensitiveText(source.title.trim(), secretValues).slice(0, 500) || href;
    byHref.set(href, sources.length);
    remap.set(origIdx, sources.length);
    sources.push({ uri: href, title });
  });
  const supports = (grounding.supports ?? []).flatMap((sup) => {
    const text = redactSensitiveText(sup.text, secretValues).slice(0, 1000);
    const idx = [...new Set(sup.sources.map((i) => remap.get(i)).filter((v): v is number => typeof v === 'number'))];
    return text.trim() && idx.length ? [{ text, start: sup.start, sources: idx }] : [];
  }).slice(0, MAX_GROUNDING_SUPPORTS);
  return queries.length || sources.length
    ? { type: 'grounding', queries, sources, ...(supports.length ? { supports } : {}), ...(grounding.label ? { label: grounding.label.slice(0, 80) } : {}) }
    : null;
}

class InputBudgetError extends Error {
  constructor(message: string, readonly statusCode = 413) { super(message); }
}

async function normalizeIncomingParts(parts: MessagePart[], ownerId: string): Promise<MessagePart[]> {
  const attachmentLimit = maxAttachmentsPerMessage();
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
    if ((part.type !== 'image' && part.type !== 'file') || !part.uploadId || seenUploads.has(part.uploadId)) continue;
    seenUploads.add(part.uploadId);
    if (seenUploads.size > attachmentLimit) {
      throw new InputBudgetError(`每条消息最多添加 ${attachmentLimit} 个附件`);
    }
    const media = await getOwnedUploadMedia(part.uploadId, ownerId);
    if (!media) throw new InputBudgetError('附件不存在或不属于当前账号', 400);
    imageBytes += media.size;
    if (imageBytes > config.maxMessageAttachmentBytes) {
      throw new InputBudgetError('本条消息的附件总大小超过限制');
    }
    // The stored mime decides the part shape — the client's claimed type is
    // only a hint. name/mime ride along so history renders without a lookup.
    if (media.mime.startsWith('image/')) {
      out.push({ type: 'image', uploadId: part.uploadId });
    } else {
      out.push({ type: 'file', uploadId: part.uploadId, name: media.name, mime: media.mime });
    }
  }
  if (!out.length) throw new InputBudgetError('消息内容不能为空', 400);
  return out;
}

// pending media resolves to base64 only after the whole window is chosen —
// `as` keeps PDFs (native document blocks) apart from pictures.
type PlannedPart = AdapterMessagePart | { type: 'pending_media'; as: 'image' | 'file'; media: OwnedMedia };

function adapterTextCost(part: MessagePart): number {
  if (part.type === 'text') return part.text.length;
  if (part.type === 'tool_call') return part.id.length + part.name.length + part.args.length;
  if (part.type === 'tool_result') return part.toolCallId.length + part.name.length + part.result.length;
  return 0;
}

type FilePart = Extract<MessagePart, { type: 'file' }>;

/**
 * Documents attached earlier in the thread than the replay window reaches.
 * Without this a person who uploaded a contract in message 1 and is now on
 * message 50 would be answered by a model that has never seen the contract.
 * Documents only — an old picture is simply past, and pictures are dear.
 */
function carriedDocParts(rows: { parts: string }[]): FilePart[] {
  const out: FilePart[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const p of parseParts(row.parts)) {
      if (p.type !== 'file' || !p.uploadId || seen.has(p.uploadId)) continue;
      seen.add(p.uploadId);
      out.push(p);
    }
  }
  return out;
}

/** Image models only look at the last few turns; they never compact. */
const IMAGE_HISTORY_MESSAGES = 40;
/** A summary that takes longer than this is abandoned; the turn goes on without it. */
const COMPACT_TIMEOUT_MS = 180_000;

/** Parts that mark a reply without being part of its content. */
const isMetaPart = (p: MessagePart) => p.type === 'service_tier' || p.type === 'context_summary';

/** Approximate replay size of each message, in characters, for compaction
    planning: text and tool parts as replayed, text documents by their size
    (PDFs and images count against the media budgets instead). */
function replayCosts(rows: { parts: string }[]): number[] {
  const parsed = rows.map((r) => parseParts(r.parts));
  const ids = [...new Set(parsed.flatMap((ps) => ps.flatMap((p) => (p.type === 'file' && p.uploadId ? [p.uploadId] : []))))];
  const docChars = new Map<string, number>();
  if (ids.length) {
    for (const u of db.select({ id: schema.uploads.id, size: schema.uploads.size, mime: schema.uploads.mime })
      .from(schema.uploads).where(inArray(schema.uploads.id, ids)).all()) {
      docChars.set(u.id, isTextDocMime(u.mime) ? Math.min(u.size, config.maxMessageTextChars) : 0);
    }
  }
  return parsed.map((ps) => ps.reduce((n, p) => n + (p.type === 'file' ? docChars.get(p.uploadId) ?? 0 : adapterTextCost(p)), 0));
}

/**
 * Build a newest-first bounded replay window, then resolve only the images that
 * fit. Duplicate media references are omitted across the whole context.
 * `carried` documents are reserved first and re-attached to the oldest user
 * turn in the window, so a long conversation keeps its files in view.
 */
async function buildBoundedHistory(
  rows: { role: string; parts: string }[], ownerId: string, includeImages: boolean, carried: FilePart[],
  budget: { textChars: number; lead: string | null; reserve: number },
): Promise<{ messages: AdapterMessage[]; mediaLease: AdmissionLease }> {
  // The summary (or room for the one about to be written) comes off the top.
  const leadChars = (budget.lead?.length ?? 0) + budget.reserve;
  // The history count budget must fit one permitted batch of images/PDFs.
  // Byte and text budgets still bound the total provider payload.
  const contextMediaLimit = Math.max(config.maxContextImages, maxAttachmentsPerMessage());
  let chosen: { role: 'user' | 'assistant'; parts: PlannedPart[] }[] = [];
  const seenMedia = new Set<string>();
  const mediaCache = new Map<string, Promise<OwnedMedia | null>>();
  let textChars = 0;
  let imageBytes = 0;
  let imageCount = 0;

  const getMedia = (part: Extract<MessagePart, { type: 'image' | 'file' }>) => {
    const key = part.uploadId ? `u:${part.uploadId}` : 'imageId' in part && part.imageId ? `i:${part.imageId}` : '';
    if (!key) return { key, media: Promise.resolve(null) };
    let media = mediaCache.get(key);
    if (!media) {
      media = part.uploadId
        ? getOwnedUploadMedia(part.uploadId, ownerId)
        : getOwnedImageMedia((part as Extract<MessagePart, { type: 'image' }>).imageId!, ownerId);
      mediaCache.set(key, media);
    }
    return { key, media };
  };

  // A document referenced twice in the window is only parsed once.
  const docTextCache = new Map<string, Promise<string>>();
  const getDocText = (key: string, media: OwnedMedia) => {
    let text = docTextCache.get(key);
    if (!text) {
      text = extractDocText(media).then(
        (t) => wrapDocAttachment(media.name, t),
        () => wrapDocAttachment(media.name, '(文档内容读取失败)'),
      );
      docTextCache.set(key, text);
    }
    return text;
  };

  // One document, one way in: prompt text when it has any (txt/docx, or the
  // rendition an import brought along), a native block for a bare PDF on a
  // vision model, and an honest note otherwise — a silently vanishing
  // attachment confuses both model and user.
  const planFile = async (key: string, media: OwnedMedia): Promise<{
    part: PlannedPart; text: number; bytes: number; count: number;
  }> => {
    if (isTextDocMime(media.mime) || hasCompanionText(media)) {
      const text = await getDocText(key, media);
      return { part: { type: 'text', text }, text: text.length, bytes: 0, count: 0 };
    }
    if (media.mime === 'application/pdf' && includeImages) {
      return { part: { type: 'pending_media', as: 'file', media }, text: 0, bytes: media.size, count: 1 };
    }
    const label = media.name ?? '附件';
    const note = media.mime === 'application/pdf'
      ? `(附件「${label}」是 PDF,当前模型不支持读取,已略过)`
      : `(附件「${label}」无法读取其内容,已略过)`;
    return { part: { type: 'text', text: note }, text: note.length, bytes: 0, count: 0 };
  };

  // Media the window itself references — a carried copy of the same file
  // would only be a duplicate, and the in-window one keeps its place.
  const windowKeys = new Set<string>();
  for (const row of rows) {
    for (const p of parseParts(row.parts)) {
      if ((p.type === 'file' || p.type === 'image') && p.uploadId) windowKeys.add(`u:${p.uploadId}`);
    }
  }
  const carriedPlanned: PlannedPart[] = [];
  const carriedKeys: string[] = [];
  let carriedText = 0;
  let carriedBytes = 0;
  let carriedCount = 0;
  for (const part of carried) {
    const ref = getMedia(part);
    if (!ref.key || windowKeys.has(ref.key) || carriedKeys.includes(ref.key)) continue;
    const media = await ref.media;
    if (!media) continue;
    const planned = await planFile(ref.key, media);
    carriedPlanned.push(planned.part);
    carriedKeys.push(ref.key);
    carriedText += planned.text;
    carriedBytes += planned.bytes;
    carriedCount += planned.count;
  }

  const fill = async (reserveText: number, reserveBytes: number, reserveCount: number) => {
    chosen = [];
    seenMedia.clear();
    textChars = reserveText;
    imageBytes = reserveBytes;
    imageCount = reserveCount;
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
          planned.push({ type: 'pending_media', as: 'image', media });
          localMediaKeys.push(ref.key);
          rowImageBytes += media.size;
          rowImageCount++;
          continue;
        }
        if (part.type === 'file') {
          const ref = getMedia(part);
          if (!ref.key || seenMedia.has(ref.key) || localMediaKeys.includes(ref.key)) continue;
          const media = await ref.media;
          if (!media) continue;
          const filed = await planFile(ref.key, media);
          planned.push(filed.part);
          localMediaKeys.push(ref.key);
          rowText += filed.text;
          rowImageBytes += filed.bytes;
          rowImageCount += filed.count;
          continue;
        }
        rowText += adapterTextCost(part);
        const converted = toAdapterPartNoImage(part);
        if (converted) planned.push(converted);
      }
      if (!planned.length) continue;
      const over = textChars + rowText > budget.textChars
        || imageBytes + rowImageBytes > config.maxContextImageBytes
        || imageCount + rowImageCount > contextMediaLimit;
      if (over) {
        if (!chosen.length) return false;
        break;
      }
      chosen.unshift({ role: row.role as 'user' | 'assistant', parts: planned });
      textChars += rowText;
      imageBytes += rowImageBytes;
      imageCount += rowImageCount;
      for (const key of localMediaKeys) seenMedia.add(key);
    }
    return true;
  };

  // Carried documents come first, then as many recent turns as still fit. If
  // even the newest turn can't share the budget with them, the turn wins and
  // the documents are named instead of included.
  let carriedIn = carriedPlanned.length > 0;
  if (!(await fill(leadChars + carriedText, carriedBytes, carriedCount))) {
    if (!carriedIn || !(await fill(leadChars, 0, 0))) {
      throw new InputBudgetError('当前消息超过模型上下文预算,请缩短文字或减少图片');
    }
    carriedIn = false;
  }

  while (chosen.length && chosen[0].role !== 'user') chosen.shift();
  if (carriedPlanned.length && chosen.length) {
    const lead: PlannedPart = carriedIn
      ? { type: 'text', text: '(以下是本对话早前上传的附件,后续讨论可能会引用它们)' }
      : { type: 'text', text: `(本对话早前上传的附件因上下文预算未能包含:${carried.map((p) => p.name || '附件').join('、')})` };
    chosen[0].parts = [lead, ...(carriedIn ? carriedPlanned : []), ...chosen[0].parts];
  }
  if (budget.lead && chosen.length) chosen[0].parts = [{ type: 'text', text: budget.lead }, ...chosen[0].parts];
  const mediaLease = tryReserveContextImageBytes(ownerId, imageBytes);
  if (!mediaLease) {
    throw new InputBudgetError('当前图片上下文总量繁忙,请等待其他图片对话完成后重试', 429);
  }
  const out: AdapterMessage[] = [];
  try {
    for (const message of chosen) {
      const parts: AdapterMessagePart[] = [];
      for (const part of message.parts) {
        if (part.type === 'pending_media') {
          parts.push({
            type: part.as,
            name: part.as === 'file' ? part.media.name : undefined,
            ...(await readMediaBase64(part.media, config.maxContextImageBytes)),
          });
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

export function chatSummary(c: typeof schema.chats.$inferSelect) {
  return {
    id: c.id, title: c.title, pinned: !!c.pinned, archived: !!c.archived,
    temporary: !!c.temporary, workspace: !!c.workspace, modelId: c.modelId,
    projectId: c.projectId, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

export function messageDto(m: typeof schema.messages.$inferSelect, bookmarked?: ReadonlySet<string>) {
  return {
    id: m.id, parentId: m.parentId, role: m.role, parts: parseParts(m.parts), model: m.model,
    providerId: m.providerId, status: m.status, finishReason: m.finishReason ?? null, error: m.error,
    errorCode: m.errorCode === 'provider_busy' || m.errorCode === 'provider_empty' ? m.errorCode : undefined,
    promptTokens: m.promptTokens, completionTokens: m.completionTokens, totalTokens: m.totalTokens,
    durationMs: m.durationMs, ttftMs: m.ttftMs, createdAt: m.createdAt,
    bookmarked: bookmarked?.has(m.id) ?? false,
  };
}

function liveMessageDto(m: typeof schema.messages.$inferSelect, bookmarked?: ReadonlySet<string>) {
  const message = messageDto(m, bookmarked);
  const current = activeChatStream(m.chatId);
  return current?.messageId === m.id && m.status === 'streaming'
    ? { ...message, parts: current.parts, retry: current.retry, retrySince: current.retrySince, priority: current.priority }
    : message;
}

function activeTurnDto(chatId: string) {
  const turn = activeChatStream(chatId);
  return turn ? {
    requestId: turn.requestId, messageId: turn.messageId, userMessageId: turn.userMessageId,
    toolConfirm: turn.toolConfirm,
  } : null;
}

/** Ids of this user's 收藏 inside one chat. */
function bookmarkedIdsIn(chatId: string, userId: string): Set<string> {
  return new Set(db.select({ messageId: schema.bookmarks.messageId }).from(schema.bookmarks)
    .where(and(eq(schema.bookmarks.chatId, chatId), eq(schema.bookmarks.userId, userId))).all()
    .map((r) => r.messageId));
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
    rows = rows.filter((r) => providerAllowed(user, r.providers.type)
      && (r.models.accessMode === 'shared' || granted.has(r.models.id)));
  }
  const text = rows.filter((r) => !r.models.imageGen);
  return pickModel(text.length ? text : rows);
}

// Admin-designated cheap models for background tasks ('' = unset). Keeps the
// big conversation model out of jobs any small model does fine.
export const TITLE_MODEL_KEY = 'title_model_id';
export const FOLLOWUP_MODEL_KEY = 'followup_model_id';
// Global switch for post-answer follow-up suggestions (default on).
export const FOLLOWUP_ENABLED_KEY = 'followup_enabled';

type ModelPick = { model: typeof schema.models.$inferSelect; provider: typeof schema.providers.$inferSelect };

// Background tasks (title, follow-ups) need a text model: an image model can't
// answer their prompts. Ordered fallback chain — the admin-designated task
// model → the model that just answered (text turns only) → the default text
// model. Generation walks the list so one provider having a bad moment
// (429, timeout) doesn't kill the feature.
function getTaskModelCandidates(settingKey: string, user: { role: string }, current?: ModelPick): ModelPick[] {
  const out: ModelPick[] = [];
  const push = (p: ModelPick | null | undefined) => {
    if (p && !p.model.imageGen && providerAllowed(user, p.provider.type)
      && !out.some((x) => x.model.id === p.model.id)) out.push(p);
  };
  const configured = getSetting<string>(settingKey, '');
  if (configured) push(getModelWithProvider(configured));
  push(current);
  push(pickModel(enabledModelRows().filter((r) => !r.models.imageGen && providerAllowed(user, r.providers.type))));
  return out;
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
  // The client's image/file split is advisory — normalizeIncomingParts
  // re-derives the real kind from the stored mime.
  z.object({ type: z.literal('file'), uploadId: z.string().min(1).max(64) }),
]);

const streamBodySchema = z.object({
  requestId: z.string().uuid().optional(),
  fallbackModelId: z.string().max(64).optional(),
  automaticFallback: z.boolean().optional(),
  // Leave room for text alongside the largest permitted attachment batch.
  content: z.array(partSchema).min(1).max(ATTACHMENT_COUNT_MAX + 20).optional(),
  modelId: z.string().max(64).optional(),
  regenerateMessageId: z.string().max(64).optional(),
  editMessageId: z.string().max(64).optional(),
  // Parent for a NEW message: the leaf of the branch the client is looking at.
  // Omitted = the chat's saved currentLeafId (fallback: newest message).
  parentMessageId: z.string().max(64).optional(),
});

const TITLE_PROMPT = '请为上面这段对话生成一个简短的标题(不超过16个字),直接输出标题文本,不要任何引号、句号或解释。';
// Per-user opt-in (settings.titleEmoji): same prompt, but the title leads with
// one topic-matching emoji.
const TITLE_PROMPT_EMOJI = '请为上面这段对话生成一个简短的标题(不超过16个字),标题的第一个字符必须是一个最能代表对话主题的 emoji,其后紧跟标题文本。直接输出标题,不要任何引号、句号或解释。';

function wantsTitleEmoji(settingsJson: string): boolean {
  try { return !!(JSON.parse(settingsJson) as { titleEmoji?: unknown }).titleEmoji; }
  catch { return false; }
}

/** 全局自定义指令 (settings.customInstructions): about me / how to answer, trimmed. */
function customInstructionsOf(settingsJson: string): string | null {
  try {
    const v = (JSON.parse(settingsJson) as { customInstructions?: unknown }).customInstructions;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 1500) : null;
  } catch { return null; }
}

/** Personal "ask me before every MCP tool call" preference (settings.confirmTools). */
function wantsToolConfirm(settingsJson: string): boolean {
  try { return !!(JSON.parse(settingsJson) as { confirmTools?: unknown }).confirmTools; }
  catch { return false; }
}

const TOOL_DENIED_RESULT = '(用户拒绝执行此工具调用。不要重试同一调用;如无法继续,请直接告诉用户你需要这个工具做什么。)';

// Anchored to the QUESTION, not the answer: for tasks like translation the
// answer is (a) in another language and (b) much longer, and a small model
// left to itself will follow the answer — asking about the translated content,
// in the translated language. Both rules below exist to counter that pull.
const FOLLOWUP_PROMPT = '基于上面这轮问答,站在提问者的角度,提出 3 个对方接下来最可能继续问的简短追问。要求:追问必须延续提问者的意图和任务——如果对方是在让你执行任务(如翻译、改写、总结),追问应围绕任务本身(如调整风格、继续处理更多内容),而不是就产出内容提新问题;必须使用提问者提问时所用的语言,即使回答用了别的语言(比如翻译结果);每行输出一个问题,共 3 行;直接输出问题本身,不要编号、引号或任何解释;每个问题不超过 25 个字。';
// Follow-ups only need the latest exchange, truncated — resending the whole
// conversation would be wasted input tokens on a job this small.
const FOLLOWUP_QUESTION_CHARS = 2000;
const FOLLOWUP_ANSWER_CHARS = 4000;

// One question per line; strip list markers / quotes the model may add anyway.
function parseFollowups(raw: string): string[] {
  return raw.split('\n')
    .map((line) => line.trim()
      .replace(/^(?:[-*•>]|\d+\s*[.、).]|[([]\d+[)\]])\s*/, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim())
    .filter((line) => line.length >= 2 && line.length <= 100)
    .slice(0, 3);
}

export async function chatRoutes(app: FastifyInstance) {
  app.get('/api/chats', async (req, reply) => {
    requireAuth(req, reply);
    // 临时对话 never appear in the history list — that's their whole point.
    const rows = db.select().from(schema.chats)
      .where(and(eq(schema.chats.userId, req.user!.id), eq(schema.chats.temporary, 0))).all();
    rows.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    return { chats: rows.map(chatSummary) };
  });

  app.post('/api/chats', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({
      modelId: z.string().max(64).nullish(),
      projectId: z.string().max(64).nullish(),
      temporary: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    if (body.data.projectId && !canUseProject(body.data.projectId, req.user!.id)) {
      return reply.code(404).send({ error: '项目不存在' });
    }
    const id = newId();
    const t = now();
    db.insert(schema.chats).values({
      id, userId: req.user!.id, title: '', modelId: body.data.modelId ?? null,
      // 临时对话 never belong to a project — projects are for keeping things.
      projectId: body.data.temporary ? null : body.data.projectId ?? null,
      temporary: body.data.temporary ? 1 : 0,
      createdAt: t, updatedAt: t,
    }).run();
    const c = db.select().from(schema.chats).where(eq(schema.chats.id, id)).get()!;
    return { chat: { ...chatSummary(c), systemPrompt: c.systemPrompt, temperature: c.temperature, maxTokens: c.maxTokens, reasoningEffort: c.reasoningEffort, webSearch: false, mcpServerIds: [], currentLeafId: null } };
  });

  app.get('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    // seq is the ordering key (createdAt collides at ms/s granularity — see
    // schema); createdAt only breaks ties for pre-seq rows that are all 0.
    // ALL branches are returned — the client assembles the tree and shows the
    // chain ending at currentLeafId.
    const msgs = allChatMessages(id);
    let savedMcpServerIds: string[] = [];
    try { savedMcpServerIds = JSON.parse(c.mcpServerIds); } catch { /* ignore */ }
    const searchServerId = getSearchServerId();
    const legacySearch = !!searchServerId && savedMcpServerIds.includes(searchServerId);
    const mcpServerIds = validateMcpSelection(
      req.user!, savedMcpServerIds.filter((serverId) => serverId !== searchServerId),
    ).allowed;
    const marks = bookmarkedIdsIn(id, req.user!.id);
    return {
      chat: {
        ...chatSummary(c),
        systemPrompt: c.systemPrompt, temperature: c.temperature,
        maxTokens: c.maxTokens, reasoningEffort: c.reasoningEffort,
        webSearch: !!c.webSearch || legacySearch, mcpServerIds,
        currentLeafId: resolveLeafId(msgs, c.currentLeafId),
      },
      messages: msgs.map((m) => liveMessageDto(m, marks)),
      activeTurn: activeTurnDto(id),
    };
  });

  // Read-only recovery: never repeats the model request or tool execution.
  app.get('/api/chats/:id/stream-state', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const chat = db.select().from(schema.chats).where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!chat) return reply.code(404).send({ error: '对话不存在' });
    const query = z.object({ requestId: z.string().max(64).optional(), messageId: z.string().max(64).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: '参数错误' });
    const { requestId, messageId } = query.data;
    const current = activeChatStream(id);
    const matching = current && (!requestId || current.requestId === requestId)
      && (!messageId || current.messageId === messageId) ? current : undefined;
    const receipt = requestId ? chatStreamReceipt(id, requestId) : undefined;
    const targetId = matching?.messageId ?? receipt?.messageId ?? messageId
      ?? (!requestId && !matching ? chat.currentLeafId : undefined);
    const row = targetId ? db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, targetId), eq(schema.messages.chatId, id))).get() : undefined;
    const userId = matching?.userMessageId ?? receipt?.userMessageId ?? row?.parentId;
    const userRow = userId ? db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, userId), eq(schema.messages.chatId, id))).get() : undefined;
    const marks = bookmarkedIdsIn(id, req.user!.id);
    return {
      active: !!matching, activeTurn: matching ? activeTurnDto(id) : null,
      chatModelId: chat.modelId,
      fallbackModelId: matching?.fallbackModelId ?? receipt?.fallbackModelId ?? null,
      message: row?.role === 'assistant' ? liveMessageDto(row, marks) : null,
      userMessage: userRow ? messageDto(userRow, marks) : null,
    };
  });

  app.post('/api/chats/:id/stop', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const owned = db.select({ id: schema.chats.id }).from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!owned) return reply.code(404).send({ error: '对话不存在' });
    const body = z.object({ requestId: z.string().max(64).optional(), messageId: z.string().max(64).optional() })
      .refine((v) => !!v.requestId || !!v.messageId).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '缺少正在生成的请求标识' });
    const current = activeChatStream(id);
    if (!current || (body.data.requestId && body.data.requestId !== current.requestId)
      || (body.data.messageId && body.data.messageId !== current.messageId)) return { stopped: false };
    current.controller.abort();
    return { stopped: true };
  });

  // Download a conversation as a file. Markdown renders the branch currently
  // on screen (what the user thinks of as "the conversation"); JSON dumps the
  // whole tree so nothing is lost to branch switching.
  app.get('/api/chats/:id/export', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const format = (req.query as { format?: string }).format === 'json' ? 'json' : 'markdown';
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msgs = allChatMessages(id);

    const title = c.title.trim() || '未命名对话';
    const safeName = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 60) || 'chat';
    const stamp = new Date(c.updatedAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtTs = (t: number) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    if (format === 'json') {
      const payload = {
        exportedAt: now(),
        chat: {
          ...chatSummary(c),
          systemPrompt: c.systemPrompt,
          currentLeafId: resolveLeafId(msgs, c.currentLeafId),
        },
        messages: msgs.map((m) => messageDto(m)),
      };
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition',
        `attachment; filename="chat.json"; filename*=UTF-8''${encodeURIComponent(`${safeName}.json`)}`);
      return reply.send(JSON.stringify(payload, null, 2));
    }

    const chain = ancestorChain(msgs, resolveLeafId(msgs, c.currentLeafId));
    const lines: string[] = [`# ${title}`, ''];
    lines.push(`> 导出自 Cat-AgentUI · ${fmtTs(stamp.getTime())}`);
    if (c.systemPrompt?.trim()) {
      lines.push('', '## 系统提示', '', c.systemPrompt.trim());
    }
    for (const m of chain) {
      const who = m.role === 'user' ? '用户' : `助手${m.model ? ` · ${m.model}` : ''}`;
      lines.push('', '---', '', `## ${who}(${fmtTs(m.createdAt)})`, '');
      for (const p of parseParts(m.parts)) {
        switch (p.type) {
          case 'text':
            if (p.text.trim()) lines.push(p.text.trim(), '');
            break;
          case 'reasoning':
            if (p.text.trim()) {
              lines.push('<details><summary>思考过程</summary>', '', p.text.trim(), '', '</details>', '');
            }
            break;
          case 'data_comparison': {
            const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
            if (p.chart === 'line') {
              lines.push(`### ${cell(p.title)}`, '',
                `| ${cell(p.xLabel)} | ${p.series.map((s) => `${cell(s.label)} (${cell(p.unit)})`).join(' | ')} |`,
                `| --- | ${p.series.map(() => '---:').join(' | ')} |`,
                ...p.x.map((x, i) => `| ${cell(p.xLabels?.[i] ?? String(x))} | ${p.series.map((s) => s.values[i] ?? '—').join(' | ')} |`),
                '', `数据来源: ${cell(p.source)}`, '');
            } else {
              lines.push(`### ${cell(p.title)}`, '', `| 类别 | 数值 (${cell(p.unit)}) |`, '| --- | ---: |',
                ...p.items.map((i) => `| ${cell(i.label)} | ${i.value} |`), '', `数据来源: ${cell(p.source)}`, '');
            }
            break;
          }
          case 'image':
            lines.push(`*[图片${p.imageId ? '(模型生成)' : '(附件)'}]*`, '');
            break;
          case 'file':
            lines.push(`*[附件: ${p.name ?? p.uploadId}]*`, '');
            break;
          case 'tool_call':
            lines.push(`<details><summary>工具调用: ${p.name}</summary>`, '', '```json', p.args, '```', '', '</details>', '');
            break;
          case 'tool_result':
            lines.push(`<details><summary>工具结果: ${p.name}${p.isError ? '(出错)' : ''}</summary>`, '', '```', p.result, '```', '', '</details>', '');
            break;
          case 'grounding':
            if (p.sources.length) {
              lines.push('搜索来源:', ...p.sources.map((s) => `- [${s.title || s.uri}](${s.uri})`), '');
            }
            break;
          case 'context_summary':
            if (p.state === 'done') lines.push('*(较早的对话已压缩成摘要后继续)*', '');
            break;
          default:
            break; // followups are UI sugar, not conversation content
        }
      }
    }
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition',
      `attachment; filename="chat.md"; filename*=UTF-8''${encodeURIComponent(`${safeName}.md`)}`);
    return reply.send(lines.join('\n'));
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
      currentLeafId: z.string().max(64).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      // false = 保存为正式对话; re-marking a saved chat temporary is not allowed.
      temporary: z.literal(false).optional(),
      workspace: z.boolean().optional(),
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
    // Switching the workspace off keeps the files: the person may want them
    // back, and the panel still lists them. Deleting the chat removes them.
    if (d.workspace !== undefined) patch.workspace = d.workspace ? 1 : 0;
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
    if (d.currentLeafId !== undefined) {
      // Branch switch: persist which leaf the user is looking at.
      const leaf = db.select({ id: schema.messages.id }).from(schema.messages)
        .where(and(eq(schema.messages.id, d.currentLeafId), eq(schema.messages.chatId, id))).get();
      if (!leaf) return reply.code(404).send({ error: '消息不存在' });
      patch.currentLeafId = d.currentLeafId;
    }
    if (d.pinned !== undefined) patch.pinned = d.pinned ? 1 : 0;
    if (d.archived !== undefined) patch.archived = d.archived ? 1 : 0;
    if (d.temporary !== undefined) patch.temporary = 0;
    if (d.modelId !== undefined) patch.modelId = d.modelId;
    if (d.projectId !== undefined) {
      if (d.projectId && !canUseProject(d.projectId, req.user!.id)) {
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
      webSearch: !!updated.webSearch, mcpServerIds, currentLeafId: updated.currentLeafId,
    } };
  });

  // Remove one message from the conversation. History is always re-read from
  // this table when building provider context, so a deleted row is gone from
  // every later turn — which is the whole point of the feature.
  app.delete('/api/chats/:id/messages/:messageId', async (req, reply) => {
    requireAuth(req, reply);
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const c = db.select({ id: schema.chats.id, currentLeafId: schema.chats.currentLeafId }).from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msg = db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.chatId, chatId))).get();
    if (!msg) return reply.code(404).send({ error: '消息不存在' });
    if (msg.status === 'streaming') {
      return reply.code(409).send({ error: '正在生成中的消息不能删除' });
    }
    db.delete(schema.messages).where(eq(schema.messages.id, messageId)).run();
    // Splice the tree: children (across every branch) reattach to the deleted
    // message's parent, so no subtree is orphaned.
    db.update(schema.messages).set({ parentId: msg.parentId })
      .where(and(eq(schema.messages.chatId, chatId), eq(schema.messages.parentId, messageId))).run();
    // A summary may still quote it; the next long turn writes a fresh one.
    clearSummaries(chatId);
    db.update(schema.chats).set({
      updatedAt: now(),
      ...(c.currentLeafId === messageId ? { currentLeafId: msg.parentId } : {}),
    }).where(eq(schema.chats.id, chatId)).run();
    await cleanupUnreferencedUploads(req.user!.id, uploadIdsFromPartsJson(msg.parts));
    return { ok: true };
  });

  // Edit an assistant reply's text in place — no regeneration. The editor shows
  // the text parts merged into one document, so saving replaces them with a
  // single text part at the first text position; reasoning / tool / image /
  // grounding / followups parts are preserved as-is. The edited text replays
  // into later context, which is the point: correcting a reply steers the rest
  // of the conversation. (User messages keep their own edit+resend flow.)
  app.patch('/api/chats/:id/messages/:messageId', async (req, reply) => {
    requireAuth(req, reply);
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const body = z.object({
      text: z.string().min(1).max(config.maxTurnOutputChars),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const c = db.select({ id: schema.chats.id }).from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msg = db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.chatId, chatId))).get();
    if (!msg || msg.role !== 'assistant') return reply.code(404).send({ error: '消息不存在' });
    if (msg.status === 'streaming') {
      return reply.code(409).send({ error: '正在生成中的消息不能编辑' });
    }
    const out: MessagePart[] = [];
    let inserted = false;
    for (const p of parseParts(msg.parts)) {
      if (p.type === 'text') {
        if (!inserted) { out.push({ type: 'text', text: body.data.text }); inserted = true; }
        // later text parts were shown merged in the editor — drop them
      } else {
        out.push(p);
      }
    }
    if (!inserted) out.push({ type: 'text', text: body.data.text });
    db.update(schema.messages).set({ parts: JSON.stringify(out) })
      .where(eq(schema.messages.id, messageId)).run();
    db.update(schema.chats).set({ updatedAt: now() }).where(eq(schema.chats.id, chatId)).run();
    clearSummaries(chatId); // summaries were written from the old text
    const updated = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()!;
    return { message: messageDto(updated) };
  });

  // Fork the conversation: a brand-new chat carrying the message history and
  // every per-chat setting, titled 「原标题·分支」. The button lives on each
  // message, so `uptoMessageId` bounds the copy — everything up to and
  // including that message; omitted = the whole conversation.
  app.post('/api/chats/:id/branch', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({ uptoMessageId: z.string().max(64).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const rows = allChatMessages(id);
    // The copy follows ONE branch: the ancestor chain of the named message, or
    // of the currently displayed leaf — sibling versions stay behind.
    const leafId = body.data.uptoMessageId ?? resolveLeafId(rows, c.currentLeafId);
    if (body.data.uptoMessageId && !rows.some((m) => m.id === body.data.uptoMessageId)) {
      return reply.code(404).send({ error: '消息不存在' });
    }
    const msgs = ancestorChain(rows, leafId);
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
    const idMap = new Map<string, string>();
    for (const m of msgs) idMap.set(m.id, newId());
    for (const m of msgs) {
      db.insert(schema.messages).values({
        ...m, id: idMap.get(m.id)!, chatId: branchId,
        parentId: m.parentId ? idMap.get(m.parentId) ?? null : null,
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
    removeWorkspace(id);
    await cleanupUnreferencedUploads(req.user!.id, uploadIds);
    return { ok: true };
  });

  // ---- the main streaming endpoint ----
  // The tab's answer to a `tool_confirm` event. Only the chat's owner can
  // answer, and only while the turn is actually waiting.
  app.post('/api/chats/:id/tool-decision', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      messageId: z.string().max(64),
      decisions: z.record(z.string().max(256), z.enum(['allow', 'deny'])),
      /** 本对话内不再询问 — only honoured when every decision is 'allow'. */
      rememberChat: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const c = db.select({ id: schema.chats.id }).from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msg = db.select({ chatId: schema.messages.chatId }).from(schema.messages)
      .where(eq(schema.messages.id, body.data.messageId)).get();
    if (!msg || msg.chatId !== id) return reply.code(404).send({ error: '消息不存在' });
    if (!submitToolDecision(body.data.messageId, req.user!.id, body.data.decisions)) {
      return reply.code(409).send({ error: '这次调用已不再等待确认(可能已超时或对话已停止)' });
    }
    if (body.data.rememberChat && Object.values(body.data.decisions).every((d) => d === 'allow')) {
      rememberAutoAllow(id, req.user!.id);
    }
    return { ok: true };
  });

  // ---- 收藏 ----
  app.put('/api/chats/:id/messages/:messageId/bookmark', async (req, reply) => {
    requireAuth(req, reply);
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const c = db.select({ id: schema.chats.id }).from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msg = db.select({ id: schema.messages.id }).from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.chatId, chatId))).get();
    if (!msg) return reply.code(404).send({ error: '消息不存在' });
    db.insert(schema.bookmarks).values({ id: newId(), userId: req.user!.id, chatId, messageId, createdAt: now() })
      .onConflictDoNothing().run();
    return { ok: true, bookmarked: true };
  });

  app.delete('/api/chats/:id/messages/:messageId/bookmark', async (req, reply) => {
    requireAuth(req, reply);
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    db.delete(schema.bookmarks).where(and(
      eq(schema.bookmarks.userId, req.user!.id),
      eq(schema.bookmarks.chatId, chatId),
      eq(schema.bookmarks.messageId, messageId),
    )).run();
    return { ok: true, bookmarked: false };
  });

  // The 收藏 page: newest first, each with the chat it lives in and the
  // message itself (parts included — the page renders the real Markdown).
  app.get('/api/bookmarks', async (req, reply) => {
    requireAuth(req, reply);
    const q = ((req.query as { q?: string }).q ?? '').trim().toLowerCase();
    const rows = db.select({
      id: schema.bookmarks.id, createdAt: schema.bookmarks.createdAt,
      chatId: schema.chats.id, chatTitle: schema.chats.title, projectId: schema.chats.projectId,
      message: schema.messages,
    }).from(schema.bookmarks)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.bookmarks.chatId))
      .innerJoin(schema.messages, eq(schema.messages.id, schema.bookmarks.messageId))
      .where(eq(schema.bookmarks.userId, req.user!.id))
      .orderBy(sql`${schema.bookmarks.createdAt} desc`)
      .limit(500).all();
    const items = rows.map((r) => ({
      id: r.id, createdAt: r.createdAt,
      chatId: r.chatId, chatTitle: r.chatTitle, projectId: r.projectId,
      message: messageDto(r.message, new Set([r.message.id])),
    }));
    if (!q) return { bookmarks: items };
    return {
      bookmarks: items.filter((b) => b.chatTitle.toLowerCase().includes(q)
        || b.message.parts.some((p) => p.type === 'text' && p.text.toLowerCase().includes(q))),
    };
  });

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

    if (body.requestId && chatStreamReceipt(chatId, body.requestId)) {
      return reply.code(409).send({ error: '这个请求已接收,请恢复查看原回复', code: 'request_exists' });
    }

    // resolve model
    const picked = getModelWithProvider(body.modelId ?? chat.modelId) ?? getDefaultModel(user);
    if (!picked) return reply.code(400).send({ error: '没有可用的模型,请联系管理员配置' });
    let { model, provider } = picked;
    if (!canUseModel(user, model.id)) {
      return reply.code(403).send({ error: '该模型未对你开放,请选择其他模型' });
    }
    if (model.imageGen && !imageModelsAllowed(user)) {
      return reply.code(403).send({ error: '没有图像模型使用权限,请联系管理员开通' });
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

    // Per-model daily/weekly allowance, checked on whatever model survived
    // the step above. Same over-limit policy as the monthly quota: refuse, or
    // fall back to the designated model when that one still has room.
    const modelLimit = checkModelLimit(user, model);
    if (!modelLimit.ok) {
      let downgraded = false;
      if (quota.action === 'downgrade' && !model.imageGen && quota.fallbackModelId
        && quota.fallbackModelId !== model.id) {
        const fallback = getModelWithProvider(quota.fallbackModelId);
        if (fallback && !fallback.model.imageGen && checkModelLimit(user, fallback.model).ok) {
          downgradeNotice = `${modelLimitReason(model, modelLimit)},已自动切换到基础模型「${fallback.model.displayName || fallback.model.modelId}」`;
          ({ model, provider } = fallback);
          downgraded = true;
        }
      }
      if (!downgraded) return reply.code(429).send({ error: modelLimitBlockMessage(model, modelLimit) });
    }

    const chatLease = tryAcquireChatTurn(user.id, chatId);
    if (!chatLease) {
      return reply.code(429).send({ error: '对话并发数已达上限,请等待其他回复完成', code: 'chat_busy' });
    }
    const live = beginChatStream(chatId, body.requestId ?? newId());
    const controller = live.controller;
    let imageLease: AdmissionLease | null = null;
    let imageReservation: StorageReservation | null = null;
    let contextMediaLease: AdmissionLease | null = null;
    let endSse: (() => void) | undefined;
    const releaseTurn = () => {
      contextMediaLease?.release();
      imageReservation?.release();
      imageLease?.release();
      chatLease.release();
      endChatStream(chatId, live);
    };

    // From admission through MCP discovery and provider I/O, every exit path
    // releases all process-local leases/reservations.
    try {
    if (model.imageGen) {
      const admission = tryAcquireImageJob(user.id, model.id);
      if (!admission.ok) {
        return reply.code(429).send({
          error: admission.reason === 'model-busy'
            ? '该模型正在生成中,请等待完成或换一个模型'
            : '图片生成并发数已达上限,请等待当前任务完成',
        });
      }
      imageLease = admission.lease;
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
    // Nothing here deletes messages any more: regenerating a reply and editing
    // a user message both insert a SIBLING node (same parentId), so the old
    // branch stays reachable through the version arrows.
    const rows = allChatMessages(chatId);
    let fallbackMeta: Extract<MessagePart, { type: 'model_fallback' }> | undefined;
    if (body.automaticFallback) {
      const failed = rows.find((m) => m.id === body.regenerateMessageId && m.role === 'assistant');
      const existing = failed && rows.find((m) => m.role === 'assistant' && parseParts(m.parts)
        .some((p) => p.type === 'model_fallback' && p.sourceMessageId === failed.id));
      if (existing) {
        identifyChatStream(chatId, live, existing.id, null);
        return reply.code(409).send({ error: '这条回复已尝试过自动兜底', code: 'request_exists' });
      }
      const source = failed && db.select().from(schema.models).where(and(
        eq(schema.models.modelId, failed.model ?? ''), eq(schema.models.providerId, failed.providerId ?? ''),
      )).get();
      if (!failed || !source || (failed.errorCode !== 'provider_busy' && failed.errorCode !== 'provider_empty')
        || parseParts(failed.parts).some((p) => !isMetaPart(p))
        || configuredModelFallback(source.id) !== model.id || !canUseModel(user, source.id)) {
        return reply.code(400).send({ error: '这条回复不适合自动兜底,请手动选择模型重试' });
      }
      fallbackMeta = { type: 'model_fallback', sourceMessageId: failed.id, fromModelId: source.id, fromName: source.displayName || source.modelId,
        toModelId: model.id, toName: model.displayName || model.modelId, adopted: false,
        reason: failed.errorCode === 'provider_empty' ? 'empty' : 'busy' };
    }
    // Replies that were cut short (stopped, errored mid-way, or ended on a
    // length / content-filter stop) are replayed with an explicit marker, so
    // the model doesn't treat the half-answer as something it finished saying.
    const usableHistory = (list: MessageRow[]) => list
      .filter((m) => !(m.role === 'assistant' && m.status === 'error' && parseParts(m.parts).length === 0))
      .map((m) => {
        if (m.role !== 'assistant') return m;
        const cut = m.status === 'stopped' || m.status === 'error'
          || m.finishReason === 'length' || m.finishReason === 'content_filter' || m.finishReason === 'incomplete';
        if (!cut) return m;
        const parts = parseParts(m.parts);
        if (!parts.some((p) => p.type === 'text' && p.text.trim())) return m;
        appendText(parts, 'text', '\n\n[此回复在这里被中断,并未完成]');
        return { ...m, parts: JSON.stringify(parts) };
      });
    let userMessageId: string | null = null;
    let assistantParentId: string | null;
    // The whole branch, oldest first, ending on the message being answered.
    let chain: { id: string; role: string; parts: string }[];
    let applyHistoryMutation: () => void;
    if (body.regenerateMessageId) {
      const target = rows.find((m) => m.id === body.regenerateMessageId);
      if (!target || target.role !== 'assistant') return reply.code(404).send({ error: '消息不存在' });
      chain = usableHistory(ancestorChain(rows, target.parentId));
      assistantParentId = target.parentId;
      applyHistoryMutation = () => { /* new sibling only — nothing to rewrite */ };
    } else if (body.editMessageId) {
      if (!normalizedContent) return reply.code(400).send({ error: '缺少消息内容' });
      const target = rows.find((m) => m.id === body.editMessageId);
      if (!target || target.role !== 'user') return reply.code(404).send({ error: '消息不存在' });
      const normalizedJson = JSON.stringify(normalizedContent);
      userMessageId = newId();
      const seq = nextSeq(chatId);
      const createdAt = now();
      chain = [...usableHistory(ancestorChain(rows, target.parentId)), { id: userMessageId, role: 'user', parts: normalizedJson }];
      assistantParentId = userMessageId;
      applyHistoryMutation = () => {
        db.insert(schema.messages).values({
          id: userMessageId!, chatId, role: 'user', seq, parts: normalizedJson,
          parentId: target.parentId, createdAt,
        }).run();
      };
    } else {
      if (!normalizedContent) return reply.code(400).send({ error: '缺少消息内容' });
      if (body.parentMessageId && !rows.some((m) => m.id === body.parentMessageId)) {
        return reply.code(404).send({ error: '消息不存在' });
      }
      const parentId = body.parentMessageId ?? resolveLeafId(rows, chat.currentLeafId);
      userMessageId = newId();
      const seq = nextSeq(chatId);
      const createdAt = now();
      const normalizedJson = JSON.stringify(normalizedContent);
      chain = [...usableHistory(ancestorChain(rows, parentId)), { id: userMessageId, role: 'user', parts: normalizedJson }];
      assistantParentId = userMessageId;
      applyHistoryMutation = () => {
        db.insert(schema.messages).values({
          id: userMessageId!, chatId, role: 'user', seq, parts: normalizedJson,
          parentId, createdAt,
        }).run();
      };
    }
    if (!chain.length || chain[chain.length - 1].role !== 'user') {
      return reply.code(400).send({ error: '当前对话状态无法生成回复' });
    }

    // History budget follows the model's context window. What doesn't fit is
    // folded into a summary (written below, once the stream is open), not
    // dropped: the summary in force leads the replay, recent turns follow.
    const budget = historyBudget(model.modelId);
    const plan: HistoryPlan = model.imageGen
      ? { start: Math.max(0, chain.length - IMAGE_HISTORY_MESSAGES), summary: null, compact: null }
      : (() => {
        const costs = replayCosts(chain);
        return planHistory(chain.map((m, i) => ({ role: m.role, cost: costs[i] })), branchSummary(chatId, chain.map((m) => m.id)), budget);
      })();
    const history = chain.slice(plan.start);
    // Documents attached in turns that are no longer replayed ride along at the top.
    const carriedDocs = carriedDocParts(chain.slice(0, plan.start));
    const compactRows = plan.compact ? chain.slice(plan.compact.from, plan.compact.to + 1) : null;

    // Image models are fed pictures too — that's the whole point of "edit this one".
    const withImages = !!model.vision || !!model.imageGen;
    let baseHistory: AdapterMessage[];
    try {
      const bounded = await buildBoundedHistory(history, user.id, withImages, carriedDocs, {
        textChars: budget.textChars,
        lead: plan.summary ? summaryLead(plan.summary.summary) : null,
        reserve: compactRows ? summaryTargetChars(budget) : 0,
      });
      baseHistory = bounded.messages;
      contextMediaLease = bounded.mediaLease;
    } catch (err) {
      if (err instanceof InputBudgetError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
    applyHistoryMutation();

    // 联网搜索 is an Agent 能力 like the workspace: no per-chat switch; it is
    // on whenever the admin policy allows it and the person hasn't turned
    // 智能工具 off, and the model decides per question. Vertex Gemini searches
    // natively; every other tool-capable model gets the built-in web_search
    // (a Google-grounded request to the admin's search model, with a fallback
    // model and the designated search MCP behind it — see web-search.ts).
    const agentSettings = getAgentSettings();
    const agentTools = userWantsAgentTools(user.settings);
    const webToolsAllowed = agentWebToolsAllowed(provider, agentSettings.webSearch);
    const reasoning = resolveReasoning(chat.reasoningEffort, model, provider.type as ProviderType);
    const webToolBudget = new WebToolBudget(agentSettings.webSearch, !!reasoning && !['off', 'none'].includes(reasoning.level));
    const searchAllowed = agentTools && !!model.tools && !model.imageGen && policyAllows(agentSettings.webSearch, user);
    let savedMcpServerIds: string[] = [];
    try { savedMcpServerIds = JSON.parse(chat.mcpServerIds); } catch { /* ignore */ }
    const searchServerId = getSearchServerId();
    const nativeSearchCapable = searchAllowed
      && provider.type === 'gemini' && !!provider.useVertex
      && supportsVertexGoogleSearch(model.modelId);
    const webSearchReady = searchAllowed && webToolsAllowed && webSearchToolAvailable(user);
    // The search MCP is only ever reached through web_search now; chats saved
    // with it selected (the old 联网 toggle) must not get its raw tools.
    const requestedMcpServerIds = savedMcpServerIds.filter((id) => id !== searchServerId);

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

    // Project knowledge leads the prompt: it is the stable, cacheable prefix
    // (per-chat systemPrompt varies more often than the project block does).
    // As many whole documents as fit this model ride along; the rest become a
    // manifest plus the project_search / project_read_doc tools. Image turns
    // skip all of it.
    const project = chat.projectId && !model.imageGen
      ? buildProjectPrompt(chat.projectId, user.id, { canUseTools: !!model.tools, modelId: model.modelId })
      : { block: null, tools: null, docCount: 0 };
    // Access-checked above (docCount is 0 without access): the sandbox may mount the files.
    const sandboxProjectId = project.docCount ? chat.projectId : null;
    if (project.tools?.length) toolDefs = [...(toolDefs ?? []), ...project.tools];
    // 工作区 tools are in-process like project knowledge; the manifest block
    // rides in the prompt so the model knows what exists before calling.
    // 工作区 is no longer a per-chat switch: it is on whenever the admin
    // policy allows it and the person hasn't turned 智能工具 off in settings.
    // The model decides per turn whether a file is warranted; the directory
    // only comes into being on the first write.
    const comparisonActive = agentTools && !!model.tools && !model.imageGen && policyAllows(agentSettings.dataComparison, user);
    const workspaceActive = agentTools && !!model.tools && !model.imageGen && policyAllows(agentSettings.workspace, user);
    // Why the built-in tools are absent this turn — surfaced to the model (and
    // so to the person) when it still tries to call one from memory.
    const agentOffReason = !agentTools ? '你在「设置 → 对话偏好」里关闭了「智能工具」'
      : !model.tools ? '当前模型未开启「工具调用」,管理员可在模型设置里打开'
      : model.imageGen ? '当前是图像生成模型'
      : !policyAllows(agentSettings.workspace, user) ? '管理员未对你开放工作区(管理后台 → Agent 能力)'
      : null;
    if (workspaceActive) toolDefs = [...(toolDefs ?? []), ...WORKSPACE_TOOL_DEFS];
    // 沙盒 rides on the workspace: commands run in that directory, so there
    // is nothing to execute against without it.
    const sandboxActive = workspaceActive && sandboxAvailableFor(user);
    if (sandboxActive) toolDefs = [...(toolDefs ?? []), ...SANDBOX_TOOL_DEFS];
    // Built-in conversions ride on the sandbox host, not on the "model may run
    // commands" switch: PDF / Word export is a basic feature.
    const convertActive = workspaceActive && convertAvailableFor(user);
    if (convertActive) toolDefs = [...(toolDefs ?? []), CONVERT_TOOL_DEF];
    const workspaceBlock = workspaceActive
      ? [
        buildWorkspacePrompt(chatId),
        sandboxActive
          ? [buildSandboxPrompt(comparisonActive), ...(sandboxProjectId ? [projectFilesPrompt(project.docCount)] : [])].join('\n')
          : convertActive
          ? buildConvertPrompt()
          : '本对话没有命令执行能力(没有 run_command 之类的工具):不要为了"让人去跑"而主动写脚本或给出终端命令,除非用户明确要的就是脚本本身;不能声称已经执行脚本。当前提供的其他内置工具仍可完成其描述支持的操作,不要把缺少命令执行当作所有内置工具都不可用。',
      ].join('\n\n')
      : null;
    const sandboxConfirm = sandboxActive && sandboxNeedsConfirm();
    // 技能: name + description only; the model loads the full text on demand.
    const skillRows = agentTools && model.tools && !model.imageGen && policyAllows(agentSettings.skills, user) ? skillsFor(user) : [];
    const skillsActive = skillRows.length > 0;
    if (skillsActive) toolDefs = [...(toolDefs ?? []), ...SKILL_TOOL_DEFS];
    const skillsBlock = skillsActive ? buildSkillsPrompt(skillRows, sandboxActive, comparisonActive) : null;
    // 子代理: needs the workspace (that is where its output lands) and a
    // tool-capable model; the model it runs on may be an admin-designated one.
    const subagentActive = workspaceActive && subagentAvailableFor(user);
    if (subagentActive) toolDefs = [...(toolDefs ?? []), ...SUBAGENT_TOOL_DEFS];
    const subagentBlock = subagentActive ? buildSubagentPrompt() : null;
    let subagentSpawned = 0;
    const imageToolModels = agentTools && model.tools && !model.imageGen ? imageToolModelsFor(user) : [];
    const imageToolActive = imageToolModels.length > 0;
    if (imageToolActive) toolDefs = [...(toolDefs ?? []), imageToolDefinition(imageToolModels)];
    const imageToolBlock = imageToolActive ? buildImageToolPrompt(imageToolModels) : null;
    let imageToolAttempts = 0;
    const comparisonIntent = comparisonActive ? comparisonPresentationIntent(parseParts(history[history.length - 1].parts)
      .filter((p) => p.type === 'text').map((p) => p.text).join('\n')) : null;
    const comparisonHint = comparisonIntent?.hint;
    if (comparisonActive) toolDefs = [...(toolDefs ?? []), comparisonToolDefinition(comparisonIntent?.chart)];
    let comparisonAttempts = 0;
    let comparisonRendered = false;
    // Vertex defaults to native Google search only. Older models that cannot
    // combine search and functions no longer silently fall back to Agent search.
    const webFetchActive = searchAllowed && webToolsAllowed && webFetchAvailable(user);
    if (webFetchActive && webToolBudget.allows(WEB_FETCH_TOOL)) toolDefs = [...(toolDefs ?? []), WEB_FETCH_TOOL_DEF];
    const nativeSearchActive = nativeSearchCapable && (!toolDefs?.length || supportsVertexSearchWithFunctions(model.modelId));
    const webSearchActive = webSearchReady && !nativeSearchActive;
    if (webSearchActive && webToolBudget.allows(WEB_SEARCH_TOOL)) toolDefs = [...(toolDefs ?? []), WEB_SEARCH_TOOL_DEF];
    const webSearchSources: GroundingSource[] = [];
    const webSearchQueries: string[] = [];
    let webSearchLabel = '';
    // Native grounding arrives once per model round; a tool-using turn has
    // several. They fold into one part (the client numbers sources from the
    // first grounding part it finds), with supports re-based onto the
    // message-wide text so their order survives the merge.
    let nativeGrounding: GroundingInfo | null = null;
    const mergeGrounding = (next: GroundingInfo, textOffset: number) => {
      const acc = nativeGrounding ?? (nativeGrounding = { queries: [], sources: [], supports: [] });
      for (const q of next.queries) if (!acc.queries.includes(q)) acc.queries.push(q);
      const remap = next.sources.map((src) => {
        const at = acc.sources.findIndex((x) => x.uri === src.uri);
        if (at >= 0) return at;
        acc.sources.push(src);
        return acc.sources.length - 1;
      });
      for (const sup of next.supports ?? []) {
        const sources = [...new Set(sup.sources.map((i) => remap[i]).filter((v): v is number => typeof v === 'number'))];
        if (sources.length) acc.supports!.push({ text: sup.text, start: sup.start + textOffset, sources });
      }
    };
    // The person's global instructions sit between the project block and the
    // chat's own prompt: stable across chats (cache-friendly), but the chat's
    // prompt comes later and therefore wins on conflict.
    const userInstructions = customInstructionsOf(user.settings);
    const systemPrompt = [
      project.block,
      userInstructions ? `用户的全局偏好设置(适用于所有对话):\n${userInstructions}` : null,
      chat.systemPrompt,
      workspaceBlock,
      skillsBlock,
      subagentBlock,
      imageToolBlock,
      comparisonActive ? DATA_COMPARISON_PROMPT : null,
      (nativeSearchActive || webSearchActive || webFetchActive) ? `今天是 ${today()}。` : null,
      webResearchPrompt({ nativeSearch: nativeSearchActive,
        search: webSearchActive && webToolBudget.allows(WEB_SEARCH_TOOL),
        fetch: webFetchActive && webToolBudget.allows(WEB_FETCH_TOOL), fast: webToolBudget.fast }),
      webSearchActive || webFetchActive ? webToolBudget.hint() : null,
      comparisonHint,
    ].filter(Boolean).join('\n\n') || undefined;
    // Take one snapshot for the whole turn. It covers Provider credentials,
    // custom headers, MCP env/headers, and SECRET_KEY without querying per token.
    const secretValues = allConfiguredSecretValues();
    const confirmAllTools = wantsToolConfirm(user.settings);

    // --- start streaming ---
    const sse = createSse(reply);
    endSse = sse.end;
    let clientGone = false;
    // response 'close' with writableEnded=false → client disconnected mid-stream
    // (request 'close' fires as soon as the body is consumed on Node 16+, so it's unusable here)
    reply.raw.on('close', () => {
      // A browser transport loss is not a user cancellation. The bounded
      // turn continues and can be recovered through stream-state/GET chat.
      // Explicit Stop uses the authenticated /stop endpoint instead.
      if (!reply.raw.writableEnded) {
        clientGone = true;
        // Preserve cancellation semantics for older clients without recovery.
        if (!body.requestId) controller.abort();
      }
    });

    const assistantId = newId();
    // Keep completion metadata available even with the app's warn-level
    // request logger: healthy upstream STOPs are needed to diagnose a lost
    // downstream 'done' event. This logger never receives message contents.
    const streamLog = req.log.child({ chatId, messageId: assistantId }, { level: 'info' });
    db.insert(schema.messages).values({
      id: assistantId, chatId, role: 'assistant', parts: '[]', seq: nextSeq(chatId),
      parentId: assistantParentId,
      model: model.modelId, providerId: provider.id, status: 'streaming', createdAt: now(),
    }).run();
    identifyChatStream(chatId, live, assistantId, userMessageId);
    // The freshly generated reply becomes the visible branch. New activity in
    // an archived chat also un-archives it — a talking chat isn't shelved.
    db.update(schema.chats).set({
      currentLeafId: assistantId,
      archived: 0,
      ...(!body.automaticFallback && body.modelId && body.modelId !== chat.modelId ? { modelId: body.modelId } : {}),
    }).where(eq(schema.chats.id, chatId)).run();

    if (fallbackMeta) live.parts.push(fallbackMeta);
    sse.send('meta', { messageId: assistantId, userMessageId, model: model.modelId, providerId: provider.id, fallback: fallbackMeta });
    if (downgradeNotice) sse.send('notice', { message: downgradeNotice });
    if (mcpAccess.denied.length) {
      sse.send('notice', { message: '部分 MCP 服务器已被禁用或撤销授权,本次不会调用' });
    }
    for (const te of toolErrors) sse.send('notice', { message: `MCP 服务器「${te.name}」连接失败: ${te.error}` });

    const cfg = toRuntimeConfig(provider);
    const fallbackPick = body.fallbackModelId && !body.automaticFallback
      && configuredModelFallback(model.id) === body.fallbackModelId ? getModelWithProvider(body.fallbackModelId) : null;
    const clientFallback = !!fallbackPick && !model.imageGen && !fallbackPick.model.imageGen
      && canUseModel(user, fallbackPick.model.id) && checkModelLimit(user, fallbackPick.model).ok
      && (!model.vision || !!fallbackPick.model.vision) && (!model.tools || !!fallbackPick.model.tools);
    live.fallbackModelId = clientFallback ? body.fallbackModelId : null;
    const adapter = getAdapter(provider.type);
    const parts = live.parts;
    const usage = { prompt: 0, completion: 0, total: 0 };
    let ttft: number | null = null;
    const t0 = Date.now();
    let status: 'done' | 'error' | 'stopped' = 'done';
    let finishReason: FinishReason | null = null;
    let errMsg: string | null = null;
    let errCode: 'provider_busy' | 'provider_empty' | null = null;
    let imageCount = 0;
    let outputChars = 0;
    let textTimeoutError: string | null = null;
    let textTurnTimer: ReturnType<typeof setTimeout> | null = null;
    let providerIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let continuation: Extract<MessagePart, { type: 'response_recovery' }> | undefined;
    let continuationConfig = cfg;
    let continuationTextBefore = 0;

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
    // A backup line took over: say so once per switch so a slower or
    // differently-cached answer has an explanation, and reset the idle clock
    // since the new line starts from zero.
    const onFailover = (info: ProviderFailover) => {
      if (info.recovery) onRetry({ attempt: 1, maxAttempts: 1, delayMs: 0, recovery: 'empty', priority: info.priority });
      else sse.send('notice', {
        message: info.priority
          ? '正在使用优先通道请求 · Priority PayGo'
          : `线路「${info.from}」暂时不可用(${info.reason}),已切换到「${info.to}」`,
      });
      if (!model.imageGen && !controller.signal.aborted) resetProviderIdleTimer();
      req.log.warn({ providerId: provider.id, model: model.modelId, ...info }, 'Provider line failover');
    };
    const onRetry = (state: ProviderRetry | null) => {
      live.retry = state;
      if (state && live.retrySince === undefined) live.retrySince = Date.now();
      sse.send('retry', state);
      if (!model.imageGen && !controller.signal.aborted) {
        if (state?.delayMs) clearProviderIdleTimer();
        else resetProviderIdleTimer();
      }
      if (state?.delayMs) req.log.warn({
        providerId: provider.id, model: model.modelId,
        attempt: state.attempt, delayMs: state.delayMs, queued: !!state.queued,
      }, state.queued ? 'Provider busy; queued behind shared backoff' : 'Provider busy; retry scheduled');
    };

    // 上下文压缩: fold the turns that no longer fit into the branch's summary,
    // with the chat's own model, before answering. If it fails the turn still
    // goes ahead — with the previous summary, or with recent turns only.
    const compactHistory = async () => {
      const covered = (plan.summary?.covered ?? 0) + compactRows!.length;
      const part: Extract<MessagePart, { type: 'context_summary' }> = { type: 'context_summary', state: 'running', covered };
      parts.push(part);
      sse.send('context_summary', part);
      const startedAt = Date.now();
      let spent: UsageInfo = {};
      try {
        const text = await writeSummary({
          adapter, cfg, model: model.modelId,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(COMPACT_TIMEOUT_MS)]),
          onUsage: (u) => { spent = u; },
        }, plan.summary?.summary ?? null, compactRows!.map((m) => ({ role: m.role, parts: parseParts(m.parts) })), summaryTargetChars(budget));
        saveSummary(chatId, chain[plan.compact!.to].id, text, covered, model.modelId);
        const first = baseHistory[0];
        if (first) {
          const lead: AdapterMessagePart = { type: 'text', text: summaryLead(text) };
          if (first.parts[0]?.type === 'text' && isSummaryLead(first.parts[0].text ?? '')) first.parts[0] = lead;
          else first.parts.unshift(lead);
        }
        part.state = 'done';
        part.text = text;
      } catch (err) {
        if (controller.signal.aborted) throw err;
        part.state = 'failed';
        sse.send('notice', { message: '较早的对话没能压缩成摘要,这一轮只带上了最近的内容' });
        req.log.warn({ err: redactSensitiveText(err instanceof Error ? err.message : String(err), secretValues) }, 'History compaction failed');
      } finally {
        recordUsage({
          userId: user.id, chatId, messageId: assistantId, providerId: provider.id, providerType: provider.type,
          model: model.modelId, kind: 'compaction', images: 0, promptTokens: spent.promptTokens,
          completionTokens: spent.completionTokens, totalTokens: spent.totalTokens, durationMs: Date.now() - startedAt,
        });
      }
      sse.send('context_summary', part);
    };

    try {
      if (model.imageGen) {
        // ---- image-generation turn ----
        if (!adapter.generateImages) throw new Error(`Provider「${provider.name}」不支持图像生成`);
        const { prompt, request, refImages } = buildImageTurn(baseHistory);
        let result;
        try {
          result = await adapter.generateImages(cfg, {
            model: model.modelId,
            prompt,
            n: 1,
            onRetry,
            onFailover,
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
        // Zero pictures is fine when the model answered in words instead — a
        // question, options to choose from — the user just replies in the chat.
        const generated = result.images;
        if (generated.length > 1 || (!generated.length && !result.text)) {
          throw new Error('Provider 返回的图片数量异常');
        }
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
        }
        if (result.text) {
          consumeOutput(result.text.length);
          const safeText = redactSensitiveText(result.text, secretValues);
          appendText(parts, 'text', safeText);
          sse.send('delta', { text: safeText });
        }
        // one response can carry several images with the same usage object — count it once
        const u = generated[0]?.usage ?? result.usage;
        usage.prompt += u?.promptTokens ?? 0;
        usage.completion += u?.completionTokens ?? 0;
        usage.total += u?.totalTokens ?? ((u?.promptTokens ?? 0) + (u?.completionTokens ?? 0));
        imageCount = generated.length;
      } else {
        // ---- normal text turn ----
        if (compactRows) await compactHistory();
        textTurnTimer = setTimeout(() => abortTextForTimeout(
          `对话生成超过 ${Math.ceil(config.chatTurnTimeoutMs / 1000)} 秒总时限`,
        ), config.chatTurnTimeoutMs);
        let iterations = 0;
        for (;;) {
          iterations++;
          const messages = [...baseHistory];
          const sofar = toAdapterPartsNoImages(parts);
          if (sofar.length) messages.push({ role: 'assistant', parts: sofar });
          if (continuation) messages.push({ role: 'user', parts: [{ type: 'text', text:
            '上一条助手回复因传输中断尚未完成。请从中断位置直接续写剩余内容,不要重复已有文字,不要重新开头,不要解释中断。保留原有结构和代码块状态,不调用任何工具。',
          }] });
          const pendingCalls: { id: string; name: string; args: string }[] = [];
          const roundTools = continuation ? [] : toolDefs?.filter((t) => webToolBudget.allows(t.name)
            && (t.name !== COMPARE_DATA_TOOL || (!comparisonRendered && comparisonAttempts < 2)));
          const textBeforeRound = parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
          let stopReason = 'other';
          let roundError: unknown;
          const textRedactor = new StreamingSecretRedactor(secretValues);
          const reasoningRedactor = new StreamingSecretRedactor(secretValues);
          const continuationText = continuation ? new ContinuationText(parts.filter((p) => p.type === 'text').map((p) => p.text).join('')) : null;
          const emitText = (text: string) => {
            if (!text) return;
            const previous = continuation ? parts.filter((p) => p.type === 'text').at(-1) : undefined;
            if (previous) previous.text += text;
            else appendText(parts, 'text', text);
            sse.send('delta', { text });
          };

          resetProviderIdleTimer();
          try {
            for await (const ev of adapter.streamChat({ ...continuationConfig,
              recoverEmptyStreams: !continuation,
              stopOnBusy: clientFallback && !parts.some((p) => !isMetaPart(p)),
            }, {
              model: model.modelId,
              system: systemPrompt,
              messages,
              tools: roundTools,
              webSearch: continuation ? false : nativeSearchActive,
              temperature: chat.temperature ?? undefined,
              maxTokens: Math.min(chat.maxTokens ?? config.defaultModelOutputTokens, config.maxModelOutputTokens),
              hardMaxTokens: config.maxModelOutputTokens,
              reasoning,
              signal: controller.signal,
              onRetry,
              onFailover,
              onServiceTier: (tier) => {
                live.priority = tier === 'priority';
                if (live.priority && !parts.some((p) => p.type === 'service_tier')) {
                  parts.push({ type: 'service_tier', tier: 'priority' });
                }
                sse.send('service_tier', { tier });
              },
              onActivity: () => { if (!controller.signal.aborted) resetProviderIdleTimer(); },
              onStreamEnd: (info) => {
                const fields = redactSensitiveValue({
                  chatId, messageId: assistantId, providerId: provider.id, model: model.modelId,
                  ...info, comparisonAvailable: comparisonActive, toolCount: roundTools?.length ?? 0,
                  comparisonIntentMatched: !!comparisonHint,
                  comparisonTarget: comparisonIntent?.chart,
                  clientGone, timeout: textTimeoutError,
                }, secretValues);
                if (info.transport !== 'eof' || !info.finishReason || info.invalidEvents) {
                  streamLog.warn(fields, 'Provider stream ended');
                } else streamLog.info(fields, 'Provider stream ended');
              },
            })) {
              resetProviderIdleTimer();
              if (ev.type === 'text') {
                if (live.retry?.recovery) onRetry(null);
                if (ttft === null) ttft = Date.now() - t0;
                consumeOutput(ev.text.length);
                const safeText = textRedactor.push(continuationText ? continuationText.push(ev.text) : ev.text);
                emitText(safeText);
              } else if (ev.type === 'reasoning') {
                if (ttft === null) ttft = Date.now() - t0;
                consumeOutput(ev.text.length);
                const safeText = reasoningRedactor.push(ev.text);
                if (safeText) {
                  appendText(parts, 'reasoning', safeText);
                  sse.send('reasoning', { text: safeText });
                }
              } else if (ev.type === 'tool_call') {
                if (continuation) throw new Error('自动补全未能完成,已有内容已保留');
                consumeOutput(ev.id.length + ev.name.length + ev.args.length + (ev.sig?.length ?? 0));
                const safeCall = {
                  ...ev,
                  id: redactSensitiveText(ev.id, secretValues),
                  name: redactSensitiveText(ev.name, secretValues),
                  args: redactSensitiveText(ev.args, secretValues),
                  // Opaque protocol data must be replayed byte-for-byte.
                  sig: ev.sig,
                };
                parts.push({
                  type: 'tool_call', id: safeCall.id, name: safeCall.name,
                  args: safeCall.args, sig: safeCall.sig,
                });
                pendingCalls.push(safeCall);
                sse.send('tool_call', { id: safeCall.id, name: safeCall.name, args: safeCall.args, sig: safeCall.sig });
              } else if (ev.type === 'grounding') {
                mergeGrounding(ev.grounding, textBeforeRound);
              } else if (ev.type === 'usage') {
                usage.prompt += ev.usage.promptTokens ?? 0;
                usage.completion += ev.usage.completionTokens ?? 0;
                usage.total += ev.usage.totalTokens ?? ((ev.usage.promptTokens ?? 0) + (ev.usage.completionTokens ?? 0));
              } else if (ev.type === 'stop') {
                stopReason = ev.reason;
                finishReason = ev.reason;
              }
            }
          } catch (err) {
            roundError = err;
          } finally {
            clearProviderIdleTimer();
            const continuationTail = continuationText?.flush();
            if (continuationTail) {
              const text = textRedactor.push(continuationTail);
              emitText(text);
            }
            const textTail = textRedactor.flush();
            emitText(textTail);
            const reasoningTail = reasoningRedactor.flush();
            if (reasoningTail) {
              appendText(parts, 'reasoning', reasoningTail);
              sse.send('reasoning', { text: reasoningTail });
            }
          }

          const canContinue = !continuation && !controller.signal.aborted
            && parts.some((p) => p.type === 'text' && p.text.trim())
            && !parts.some((p) => p.type === 'tool_call' || p.type === 'tool_result' || p.type === 'image')
            && (roundError instanceof ProviderInterruptedError || isNetworkError(roundError)
              || (!roundError && stopReason === 'other'));
          if (canContinue) {
            // The old output is part of the next prompt, never discarded or
            // replayed. Prefer another configured endpoint for the continuation.
            if (roundError instanceof ProviderInterruptedError) {
              const candidates = [cfg, ...(cfg.fallbacks ?? [])].filter((line) => !line.servesModel || line.servesModel(model.modelId));
              const next = candidates.find((line) => (line.endpointId ?? `${line.id}:primary`) !== roundError.endpointId);
              if (next) continuationConfig = { ...next, fallbacks: [] };
            }
            continuation = { type: 'response_recovery', kind: 'continuation', state: 'running' };
            continuationTextBefore = parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
            parts.unshift(continuation);
            sse.send('response_recovery', continuation);
            onRetry({ attempt: 1, maxAttempts: 1, delayMs: 0, recovery: 'continuation' });
            continue;
          }
          if (roundError) throw roundError;
          if (continuation && stopReason === 'stop'
            && parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0) <= continuationTextBefore) {
            finishReason = 'incomplete';
          }

          if (stopReason === 'tool_calls' && pendingCalls.length && iterations < config.maxToolIterations) {
            // 执行前确认: calls to a server the admin flagged (or every MCP call,
            // when the person asked for that) wait for an allow/deny from the
            // tab. Project knowledge tools are in-process reads and never ask.
            // 本对话内不再询问 (set from a confirm card) silences every ask in
            // this chat; trusted commands (convert_file, plain skill-script
            // invocations) never ask.
            const chatAutoAllow = isAutoAllowed(chatId, user.id);
            const askFor = chatAutoAllow ? [] : pendingCalls.filter((call) => !isProjectTool(call.name) && !isWorkspaceTool(call.name) && !isSkillTool(call.name) && !isSubagentTool(call.name) && call.name !== WEB_SEARCH_TOOL && call.name !== WEB_FETCH_TOOL && call.name !== COMPARE_DATA_TOOL
              && !isTrustedCommand(call.name, call.args)
              && (confirmAllTools || toolNeedsConfirm(call.name, toolCapabilities)
                || (isSandboxTool(call.name) && sandboxConfirm)));
            const denied = new Set<string>();
            if (askFor.length) {
              clearProviderIdleTimer(); // a human is the slow party now, not the provider
              live.toolConfirm = { messageId: assistantId, calls: askFor.map((c) => ({ id: c.id, name: c.name, args: c.args })) };
              sse.send('tool_confirm', live.toolConfirm);
              const decisions = await waitForToolDecision(assistantId, user.id, askFor.map((c) => c.id), controller.signal);
              live.toolConfirm = null;
              if (controller.signal.aborted) throw new Error('对话已停止');
              for (const [id, d] of decisions) if (d !== 'allow') denied.add(id);
            }
            for (const call of pendingCalls) {
              if (denied.has(call.id)) {
                const part: MessagePart = { type: 'tool_result', toolCallId: call.id, name: call.name, result: TOOL_DENIED_RESULT, isError: true };
                parts.push(part);
                sse.send('tool_result', part);
                continue;
              }
              const remainingTurnMs = config.chatTurnTimeoutMs - (Date.now() - t0);
              if (remainingTurnMs <= 0) {
                abortTextForTimeout(`对话生成超过 ${Math.ceil(config.chatTurnTimeoutMs / 1000)} 秒总时限`);
                throw new Error(textTimeoutError ?? '对话生成超时');
              }
              // Project knowledge tools are served in-process; everything else
              // goes out to its MCP server.
              const toolImages: MessagePart[] = [];
              let toolComparison: Extract<MessagePart, { type: 'data_comparison' }> | undefined;
              const { result, isError } = isProjectTool(call.name) && chat.projectId
                ? callProjectTool(chat.projectId, call.name, call.args)
                : call.name === GENERATE_IMAGE_TOOL && imageToolActive
                ? await (async () => {
                  clearProviderIdleTimer();
                  try {
                    const outcome = await callImageTool({
                      userId: user.id, chatId, messageId: assistantId, attempt: ++imageToolAttempts, signal: controller.signal,
                      onRetry: (retry) => sse.send('retry', retry),
                      onFailover: (info) => sse.send('notice', { message: `图片生成线路「${info.from}」暂时不可用(${info.reason}),已切换到「${info.to}」` }),
                    }, call.args);
                    toolImages.push(...outcome.images);
                    return outcome;
                  } finally {
                    sse.send('retry', null);
                    if (!controller.signal.aborted) resetProviderIdleTimer();
                  }
                })()
                : call.name === COMPARE_DATA_TOOL && comparisonActive
                ? (() => {
                  const outcome = callCompareData({ userId: user.id, chatId, attempt: ++comparisonAttempts,
                    alreadyRendered: comparisonRendered, chartTarget: comparisonIntent?.chart }, call.args);
                  toolComparison = outcome.comparison;
                  if (toolComparison) comparisonRendered = true;
                  return outcome;
                })()
                : isWorkspaceTool(call.name) && workspaceActive
                ? await callWorkspaceTool(chatId, call.name, call.args)
                : call.name === WEB_SEARCH_TOOL && webSearchActive
                ? await (async () => {
                  clearProviderIdleTimer();
                  try {
                    const r = await runWebSearch({ user, chatId, messageId: assistantId, signal: controller.signal, budget: webToolBudget }, call.args);
                    if (!r.isError) {
                      webSearchLabel ||= r.label ?? '';
                      webSearchQueries.push(r.query);
                      for (const src of r.sources) if (!webSearchSources.some((x) => x.uri === src.uri)) webSearchSources.push(src);
                    }
                    return r;
                  } finally { if (!controller.signal.aborted) resetProviderIdleTimer(); }
                })()
                : call.name === WEB_FETCH_TOOL && webFetchActive
                ? await (async () => {
                  clearProviderIdleTimer();
                  try {
                    const r = await runWebFetch({ user, chatId, messageId: assistantId, signal: controller.signal, budget: webToolBudget }, call.args);
                    if (r.source && !webSearchSources.some((x) => x.uri === r.source!.uri)) webSearchSources.push(r.source);
                    return r;
                  } finally { if (!controller.signal.aborted) resetProviderIdleTimer(); }
                })()
                : isSkillTool(call.name) && skillsActive
                ? callSkillTool(user, call.name, call.args)
                : isSubagentTool(call.name) && subagentActive
                ? await (async () => {
                  let sargs: { task?: unknown; title?: unknown } = {};
                  try { sargs = JSON.parse(call.args || '{}'); } catch { /* empty */ }
                  const task = typeof sargs.task === 'string' ? sargs.task.trim() : '';
                  if (!task) return { result: '缺少 task 参数', isError: true };
                  if (++subagentSpawned > agentSettings.subagent.maxPerTurn) {
                    return { result: `本轮已达子代理上限(${agentSettings.subagent.maxPerTurn} 次),请自己完成剩余工作`, isError: true };
                  }
                  const override = agentSettings.subagent.modelId ? getModelWithProvider(agentSettings.subagent.modelId) : null;
                  const sm = override && override.model.tools && !override.model.imageGen ? override : { model, provider };
                  // A subagent is a full extra model run: it must clear the
                  // same gates a normal turn does, or one turn could fan out
                  // into maxPerTurn uncounted calls (and reach a limited model
                  // indirectly). Monthly quota and the effective model's
                  // per-model limit are checked here; no downgrade — over
                  // budget simply refuses the spawn.
                  const subQuota = checkQuota(user.id);
                  if (!subQuota.ok) return { result: `无法委派子代理:${quotaBlockMessage(subQuota)}`, isError: true };
                  const subLimit = checkModelLimit(user, sm.model);
                  if (!subLimit.ok) return { result: `无法委派子代理:${modelLimitReason(sm.model, subLimit)}`, isError: true };
                  if (!canUseModel(user, sm.model.id)) return { result: '无法委派子代理:所选模型未对你开放', isError: true };
                  clearProviderIdleTimer(); // the nested run has its own timeout
                  const r = await runSubagent({
                    user, chatId, projectId: chat.projectId, parentMessageId: assistantId,
                    adapter: getAdapter(sm.provider.type), cfg: toRuntimeConfig(sm.provider),
                    model: sm.model, provider: sm.provider,
                    webToolBudget, allowAgentWebTools: webToolsAllowed,
                    reasoning: sm.model.id === model.id ? resolveReasoning(chat.reasoningEffort, model, provider.type as ProviderType) : undefined,
                    secretValues, signal: controller.signal,
                    askConfirm: async (calls) => {
                      live.toolConfirm = { messageId: assistantId, calls };
                      sse.send('tool_confirm', live.toolConfirm);
                      const d = await waitForToolDecision(assistantId, user.id, calls.map((c) => c.id), controller.signal);
                      live.toolConfirm = null;
                      if (controller.signal.aborted) throw new Error('对话已停止');
                      return d;
                    },
                    onProgress: (line) => sse.send('subagent_progress', { toolCallId: call.id, text: line }),
                    consumeOutput,
                  }, task);
                  resetProviderIdleTimer();
                  return { result: formatSubagentResult(r), isError: r.stopped === 'error' || r.stopped === 'aborted' };
                })()
                : isSandboxTool(call.name) && (sandboxActive || (call.name === CONVERT_FILE_TOOL && convertActive))
                ? await callSandboxTool({ user: { id: user.id, role: user.role }, chatId, messageId: assistantId, signal: controller.signal, projectId: sandboxProjectId }, call.args, call.name)
                // A built-in tool name the model remembers from earlier turns
                // but that is switched off now (person's 智能工具 setting, or
                // admin policy): say so plainly instead of the MCP "not found".
                : call.name === COMPARE_DATA_TOOL
                ? { result: '图表对比当前不可用:请检查智能工具开关和管理员配置的图表对比访问范围。', isError: true }
                : call.name === WEB_FETCH_TOOL
                ? { result: webToolsAllowed ? '打开网页当前不可用(智能工具已关闭,或管理员未开放网页阅读)。请依据已有信息回答,并说明没能打开原文核实' : '管理员已关闭 Vertex 模型的 Agent 网页阅读。请使用已有资料或当前可用的 Google 原生搜索回答,不要重复调用或委派绕过。', isError: true }
                : call.name === WEB_SEARCH_TOOL
                ? { result: webToolsAllowed ? '联网搜索当前不可用(智能工具已关闭、管理员未开放,或本月搜索额度已用完)。请直接根据已有知识回答,并告诉用户这次没能联网核实' : '管理员已关闭 Vertex 模型的 Agent 搜索。请使用已有资料或当前可用的 Google 原生搜索回答,不要重复调用或委派绕过。', isError: true }
                : call.name === GENERATE_IMAGE_TOOL
                ? { result: '图片生成工具当前不可用:请检查智能工具开关,以及管理员配置的图片生成访问范围和模型列表', isError: true }
                : isWorkspaceTool(call.name) || isSandboxTool(call.name) || isSkillTool(call.name) || isSubagentTool(call.name)
                ? { result: `该工具当前不可用:${agentOffReason ?? '该能力未开启或未对你开放'}。请直接用文字回答,并如实告诉用户这个原因`, isError: true }
                : await callTool(
                  call.name, call.args, toolCapabilities, user,
                  { timeoutMs: Math.max(1, Math.min(120_000, remainingTurnMs)) },
                );
              const safeResult = redactSensitiveText(result, secretValues);
              const resultLimit = Math.min(100_000, Math.floor(budget.textChars / 4));
              const trimmed = safeResult.length > resultLimit
                ? `${safeResult.slice(0, resultLimit)}\n…(结果已截断)`
                : safeResult;
              consumeOutput(call.name.length + trimmed.length);
              const part: MessagePart = { type: 'tool_result', toolCallId: call.id, name: call.name, result: trimmed, isError };
              parts.push(part);
              sse.send('tool_result', part);
              if (toolComparison) {
                consumeOutput(JSON.stringify(toolComparison).length);
                parts.push(toolComparison);
                sse.send('data_comparison', toolComparison);
              }
              for (const image of toolImages) {
                parts.push(image);
                sse.send('image', image);
              }
            }
            continue;
          }
          break;
        }
      }
    } catch (e) {
      if (textTimeoutError) {
        status = 'error';
        errMsg = textTimeoutError;
        sse.send('error', { message: errMsg });
      } else if (controller.signal.aborted) {
        status = 'stopped';
      } else {
        status = 'error';
        errMsg = redactSensitiveText(e instanceof Error ? e.message : String(e), secretValues);
        if (e instanceof ProviderEmptyError) errCode = e.code;
        if (e instanceof ProviderBusyError) {
          errCode = e.code;
          req.log.warn({
            providerId: provider.id, model: model.modelId, status: e.status,
            detail: redactSensitiveText(e.detail, secretValues),
          }, 'Provider retry budget exhausted');
        }
        sse.send('error', { message: errMsg, code: errCode ?? undefined });
      }
    }
    clearTextTimers();

    // web_search turns get a grounding part built from the sources the
    // searches returned, so the UI can number them and turn the model's
    // inline links into citation chips — same look as Vertex grounding, just
    // without the sentence-level supports.
    if (nativeGrounding) {
      const grounding = safeGroundingPart(nativeGrounding, secretValues);
      if (grounding) { parts.push(grounding); sse.send('grounding', grounding); }
    }
    if ((webSearchActive || webFetchActive) && webSearchSources.length && !parts.some((p) => p.type === 'grounding')) {
      const grounding = safeGroundingPart({ queries: webSearchQueries, sources: webSearchSources, label: webSearchLabel || (webSearchQueries.length ? '联网搜索' : '阅读的网页') }, secretValues);
      if (grounding) { parts.push(grounding); sse.send('grounding', grounding); }
    }
    const finalParts = closeDanglingToolCalls(
      parts,
      status === 'stopped' ? '(用户已停止,调用未执行)' : '(调用未完成)',
    );
    // A "successful" turn that produced nothing the user can read — typically
    // Vertex closing the stream right after the thinking part, so the person
    // is left staring at a thought chain and no answer — or one that ended on
    // an unrecognised / missing finish signal, is flagged so the UI can say
    // so and offer 重新生成 instead of pretending the reply is complete.
    // Image turns legitimately end without a finish signal; they count as a
    // body via their image parts.
    if (status === 'done') {
      const hasBody = finalParts.some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'image' || p.type === 'tool_call');
      if (finishReason !== 'length' && finishReason !== 'content_filter'
        && (!hasBody || finishReason === 'other')) finishReason = 'incomplete';
    }
    if (continuation) {
      continuation.state = status === 'done' && finishReason === 'stop' ? 'done' : 'failed';
      sse.send('response_recovery', continuation);
    }
    const durationMs = Date.now() - t0;
    if (fallbackMeta && status === 'done' && finishReason === 'stop'
      && (chat.modelId === null || chat.modelId === fallbackMeta.fromModelId)) {
      const changed = db.update(schema.chats).set({ modelId: model.id })
        .where(and(eq(schema.chats.id, chatId), sql`${schema.chats.modelId} is ${chat.modelId}`)).run();
      fallbackMeta.adopted = changed.changes > 0;
    }
    db.update(schema.messages).set({
      parts: JSON.stringify(finalParts),
      status, finishReason, error: errMsg, errorCode: errCode,
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

    // The client can submit its next turn as soon as it receives 'done'.
    // Release admission BEFORE that event; title/follow-up work must never
    // keep a finished chat busy. The finally block remains the error fallback
    // (all leases are idempotent).
    releaseTurn();
    if (fallbackMeta?.adopted) sse.send('model_selected', { modelId: model.id });
    streamLog.info({ status, finishReason, clientGone, durationMs, comparisonAvailable: comparisonActive,
      comparisonIntentMatched: !!comparisonHint, comparisonTarget: comparisonIntent?.chart, comparisonAttempts,
      comparisonRendered: finalParts.some((p) => p.type === 'data_comparison') }, 'Chat turn finished');
    sse.send('done', { messageId: assistantId, status, finishReason });

    // An interrupted/filtered/length-limited answer needs no extra model
    // requests, especially when the provider is already struggling.
    const completeAnswer = status === 'done' && (model.imageGen || finishReason === 'stop');

    // auto-title on first successful exchange
    if (!chat.title && completeAnswer && !clientGone) {
      // text-only replay: the title never needs the pictures, and non-vision
      // title models would choke on them
      const titleMessages: AdapterMessage[] = baseHistory.map((m) => ({
        role: m.role,
        parts: m.parts.filter((p) => p.type !== 'image'),
      })).filter((m) => m.parts.length > 0);
      while (titleMessages.length && titleMessages[0].role !== 'user') titleMessages.shift();
      titleMessages.push(
        { role: 'assistant', parts: toAdapterPartsNoImages(finalParts) },
        { role: 'user', parts: [{ type: 'text', text: wantsTitleEmoji(user.settings) ? TITLE_PROMPT_EMOJI : TITLE_PROMPT }] },
      );
      for (const titlePick of getTaskModelCandidates(TITLE_MODEL_KEY, user, { model, provider })) {
        try {
          let title = '';
          const tUsage = { prompt: 0, completion: 0, total: 0 };
          const tAdapter = getAdapter(titlePick.provider.type);
          for await (const ev of tAdapter.streamChat(toRuntimeConfig(titlePick.provider), {
            model: titlePick.model.modelId, messages: titleMessages, maxTokens: 500,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          })) {
            if (ev.type === 'text') title += ev.text;
            else if (ev.type === 'usage') {
              tUsage.prompt += ev.usage.promptTokens ?? 0;
              tUsage.completion += ev.usage.completionTokens ?? 0;
              tUsage.total += ev.usage.totalTokens ?? 0;
            }
          }
          // Tokens were spent even when the attempt yields nothing usable.
          recordUsage({
            userId: user.id, chatId, providerId: titlePick.provider.id, providerType: titlePick.provider.type,
            model: titlePick.model.modelId, kind: 'title',
            promptTokens: tUsage.prompt, completionTokens: tUsage.completion, totalTokens: tUsage.total,
          });
          title = redactSensitiveText(title, secretValues)
            .trim().replace(/^["'「『]|["'」』]$/g, '').split('\n')[0].slice(0, 60);
          if (title) {
            const updated = db.update(schema.chats).set({ title })
              .where(and(eq(schema.chats.id, chatId), eq(schema.chats.title, ''))).run();
            if (updated.changes) sse.send('title', { title });
            break;
          }
          // an empty title is a failed attempt too — fall through to the next model
        } catch { if (controller.signal.aborted) break; /* best-effort */ }
      }
    }

    // 快速追问:answer done → a designated small model reads the latest
    // exchange and suggests 3 follow-up questions. Best-effort, never blocks
    // or fails the turn; the result is appended to the saved message so
    // reloads keep the chips.
    if (completeAnswer && !clientGone && !model.imageGen && getSetting(FOLLOWUP_ENABLED_KEY, true)) {
      const textOf = (ps: { type: string; text?: string }[]) => ps
        .filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n').trim();
      const question = textOf(baseHistory[baseHistory.length - 1]?.parts ?? []);
      const answer = textOf(finalParts);
      if (answer) {
        const followupMessages: AdapterMessage[] = [
          { role: 'user', parts: [{ type: 'text', text: question.slice(0, FOLLOWUP_QUESTION_CHARS) || '(无文字,见回答)' }] },
          { role: 'assistant', parts: [{ type: 'text', text: answer.slice(0, FOLLOWUP_ANSWER_CHARS) }] },
          { role: 'user', parts: [{ type: 'text', text: FOLLOWUP_PROMPT }] },
        ];
        for (const pick of getTaskModelCandidates(FOLLOWUP_MODEL_KEY, user, { model, provider })) {
          try {
            let raw = '';
            const fUsage = { prompt: 0, completion: 0, total: 0 };
            const fAdapter = getAdapter(pick.provider.type);
            for await (const ev of fAdapter.streamChat(toRuntimeConfig(pick.provider), {
              model: pick.model.modelId, messages: followupMessages, maxTokens: 500,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
            })) {
              if (ev.type === 'text') raw += ev.text;
              else if (ev.type === 'usage') {
                fUsage.prompt += ev.usage.promptTokens ?? 0;
                fUsage.completion += ev.usage.completionTokens ?? 0;
                fUsage.total += ev.usage.totalTokens ?? 0;
              }
            }
            // Tokens were spent even when the attempt yields nothing usable.
            recordUsage({
              userId: user.id, chatId, providerId: pick.provider.id, providerType: pick.provider.type,
              model: pick.model.modelId, kind: 'followup',
              promptTokens: fUsage.prompt, completionTokens: fUsage.completion, totalTokens: fUsage.total,
            });
            const questions = parseFollowups(redactSensitiveText(raw, secretValues));
            if (questions.length) {
              db.update(schema.messages)
                .set({ parts: JSON.stringify([...finalParts, { type: 'followups', questions }]) })
                .where(eq(schema.messages.id, assistantId)).run();
              // messageId because 'done' already fired — the client may have
              // moved on, so it must target this reply by id, not "the last".
              sse.send('followups', { messageId: assistantId, questions });
              break;
            }
            // nothing parseable — fall through to the next candidate
          } catch { if (controller.signal.aborted) break; /* best-effort */ }
        }
      }
    }

    } finally {
      try {
        // If setup/persistence failed outside the generation catch, recovery
        // must not poll a permanently 'streaming' row after admission ended.
        if (live.messageId) db.update(schema.messages).set({
          status: 'error', error: '生成意外结束,请重试', parts: JSON.stringify(live.parts),
        }).where(and(eq(schema.messages.id, live.messageId), eq(schema.messages.status, 'streaming'))).run();
      } finally {
        releaseTurn();
        endSse?.();
      }
    }
  });
}
