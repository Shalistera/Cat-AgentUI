import { ANTHROPIC_SIG_PREFIX } from './anthropic.js';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import type {
  AdapterMessage, ChatAdapter, ChatRequest, GeneratedImage, GroundingInfo, ImageGenRequest, ImageGenResult,
  ProviderRuntimeConfig, ProviderStreamEnd, UsageInfo,
} from '../types.js';
import { sseMessages, providerError, readJsonLimited, fetchRetry, isNetworkError } from './sse.js';
import { stripEndpointSuffix, trimUrl } from './base-url.js';
import { PRIORITY_HEADER, vertexTarget } from './vertex.js';
import { config } from '../config.js';

const DEFAULT_STUDIO_BASE = 'https://generativelanguage.googleapis.com';

// AI Studio origin: the adapter appends `/v1beta/...`, so cut back anything the
// user pasted from the docs (the version prefix, or a whole endpoint).
function studioOrigin(cfg: ProviderRuntimeConfig): string {
  const o = stripEndpointSuffix(cfg.baseUrl || DEFAULT_STUDIO_BASE, ['/v1beta/models', '/models']);
  return /\/v1beta$/i.test(o) ? trimUrl(o.slice(0, -'/v1beta'.length)) : o;
}

// Vertex auth clients cached per provider config; the lib refreshes tokens
// internally. Keyed by credential content, not just provider id, so uploading
// a new service account JSON takes effect without a restart.
const vertexAuth = new Map<string, GoogleAuth>();

function getVertexAuth(cfg: ProviderRuntimeConfig): GoogleAuth {
  if (!cfg.vertexSaJson) throw new Error('Gemini: Vertex AI 需要服务账号 JSON');
  const key = `${cfg.id}:${createHash('sha256').update(cfg.vertexSaJson).digest('hex').slice(0, 16)}`;
  let auth = vertexAuth.get(key);
  if (!auth) {
    auth = new GoogleAuth({
      credentials: JSON.parse(cfg.vertexSaJson),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    vertexAuth.set(key, auth);
  }
  return auth;
}

// The GCP project: explicit setting wins, otherwise read project_id straight
// from the service account JSON — that's where it lives anyway, so most
// setups never need to type it.
function vertexProjectOf(cfg: ProviderRuntimeConfig): string {
  const explicit = cfg.vertexProject?.trim();
  if (explicit) return explicit;
  if (cfg.vertexSaJson) {
    try {
      const pid = JSON.parse(cfg.vertexSaJson).project_id;
      if (pid) return String(pid);
    } catch { /* fall through */ }
  }
  throw new Error('Gemini: Vertex AI 需要项目 ID(通常包含在服务账号 JSON 的 project_id 字段中)');
}

// Resolve URL + auth headers for a model verb ('streamGenerateContent?alt=sse' | 'generateContent').
// `gate` separates the busy-backoff queue of Priority PayGo requests from the
// standard ones on the same URL: they draw on different capacity.
async function endpoint(cfg: ProviderRuntimeConfig, model: string, verb: string): Promise<{ url: string; headers: Record<string, string>; gate?: string }> {
  const h: Record<string, string> = { ...cfg.extraHeaders, 'content-type': 'application/json' };
  if (cfg.useVertex) {
    const { url, priority } = vertexTarget(cfg, vertexProjectOf(cfg), model, verb);
    const token = await getVertexAuth(cfg).getAccessToken();
    h['authorization'] = `Bearer ${token}`;
    if (priority) h[PRIORITY_HEADER] = 'priority';
    return { url, headers: h, gate: priority ? 'priority' : undefined };
  }
  if (cfg.apiKey) h['x-goog-api-key'] = cfg.apiKey;
  return { url: `${studioOrigin(cfg)}/v1beta/models/${model}:${verb}`, headers: h };
}

/** Tag retry progress on Priority PayGo requests, so the user can tell the
 * premium lane is busy too. */
function retryReporter(onRetry: ChatRequest['onRetry'], gate: string | undefined): ChatRequest['onRetry'] {
  if (gate !== 'priority' || !onRetry) return onRetry;
  return (state) => onRetry(state && { ...state, priority: true });
}

// ---- Request body ----

function toContents(messages: AdapterMessage[]): any[] {
  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: any[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) parts.push({ text: p.text });
        else if ((p.type === 'image' || p.type === 'file') && p.dataBase64) {
          // Gemini takes PDFs through the same inlineData door as images.
          parts.push({ inlineData: { mimeType: p.mime || 'image/png', data: p.dataBase64 } });
        }
      }
      if (parts.length) contents.push({ role: 'user', parts });
    } else {
      // assistant → 'model'; tool results become functionResponse parts in a 'user' content.
      let modelParts: any[] = [];
      let fnResponses: any[] = [];
      const flushModel = () => {
        if (modelParts.length) { contents.push({ role: 'model', parts: modelParts }); modelParts = []; }
      };
      const flushFn = () => {
        if (fnResponses.length) { contents.push({ role: 'user', parts: fnResponses }); fnResponses = []; }
      };
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          flushModel();
          fnResponses.push({ functionResponse: { name: p.name, response: { result: p.result ?? '' } } });
          continue;
        }
        flushFn();
        if (p.type === 'text' && p.text) modelParts.push({ text: p.text });
        else if (p.type === 'image' && p.dataBase64) {
          modelParts.push({ inlineData: { mimeType: p.mime || 'image/png', data: p.dataBase64 } });
        } else if (p.type === 'tool_call') {
          let args: any = {};
          try { args = JSON.parse(p.args || '{}'); } catch { /* keep {} */ }
          // Gemini 3 refuses replayed functionCalls without their original
          // thought_signature — echo it exactly as it arrived. A Claude turn's
          // thinking (same slot, after a model switch) is not Gemini's to read.
          const sig = p.sig && !p.sig.startsWith(ANTHROPIC_SIG_PREFIX) ? p.sig : undefined;
          modelParts.push({
            functionCall: { name: p.name, args },
            ...(sig ? { thoughtSignature: sig } : {}),
          });
        }
        // reasoning parts are skipped
      }
      flushModel();
      flushFn();
    }
  }
  return contents;
}

// Gemini rejects unknown JSON Schema keys — keep only the supported subset.
const SCHEMA_KEYS = ['type', 'format', 'description', 'enum', 'items', 'properties', 'required', 'nullable'] as const;

function cleanSchema(schema: any): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: any = {};
  for (const k of SCHEMA_KEYS) {
    if (schema[k] === undefined) continue;
    if (k === 'properties' && typeof schema.properties === 'object' && schema.properties) {
      const props: any = {};
      for (const [name, v] of Object.entries(schema.properties)) props[name] = cleanSchema(v);
      out.properties = props;
    } else if (k === 'items') {
      out.items = cleanSchema(schema.items);
    } else {
      out[k] = schema[k];
    }
  }
  // Our common JSON Schema uses nullable type unions. Gemini's parameters
  // schema represents the same contract as one type plus nullable: true.
  if (Array.isArray(out.type) && out.type.includes('null')) {
    const concrete = out.type.filter((type: unknown) => type !== 'null');
    if (concrete.length === 1) { out.type = concrete[0]; out.nullable = true; }
  }
  return out;
}

/** Gemini 1.5 used the deprecated googleSearchRetrieval shape. Cat-AgentUI's
 * native integration intentionally targets the current googleSearch tool used
 * by currently supported Gemini 2.5 and newer Vertex models. */
export function supportsVertexGoogleSearch(model: string): boolean {
  const match = /^gemini-(\d+)(?:\.(\d+))?/i.exec((model.split('/').pop() ?? model).trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 5);
}

/** Vertex 2.5 rejects googleSearch next to functionDeclarations ("Multiple
 * tools are supported only when they are all search tools"); Gemini 3.x
 * accepts both in one request and grounds while calling functions. Verified
 * against gemini-2.5-pro (400) / gemini-3.1-pro-preview, gemini-3.6-flash (200)
 * on 2026-09-15. */
export function supportsVertexSearchWithFunctions(model: string): boolean {
  const match = /^gemini-(\d+)/i.exec((model.split('/').pop() ?? model).trim());
  return !!match && Number(match[1]) >= 3;
}

function buildChatBody(req: ChatRequest): any {
  const body: any = { contents: toContents(req.messages) };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const generationConfig: any = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.reasoning) {
    const modelId = req.model.split('/').pop() ?? req.model;
    // These Flash models use native levels; minimal/off are not supported.
    // Keep older models on their existing budget protocol.
    if (/^gemini-3\.[78]-flash(?:-|$)/i.test(modelId)) {
      const level = req.reasoning.level.toLowerCase();
      const thinkingLevel = level === 'off' || level === 'minimal' ? 'low'
        : ['low', 'medium', 'high'].includes(level) ? level
        : req.reasoning.ratio < 0.25 ? 'low' : req.reasoning.ratio < 0.75 ? 'medium' : 'high';
      generationConfig.thinkingConfig = { thinkingLevel, includeThoughts: level !== 'off' };
    } else {
      // 0 is the only way to actually switch thinking off — omitting the config
      // leaves the model deciding for itself.
      const budget = req.reasoning.level !== 'off'
        ? Math.round(2048 + req.reasoning.ratio * (32768 - 2048))
        : 0;
      generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: budget > 0 };
    }
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  // Both may ride together on Gemini 3.x; the caller keeps them apart for
  // 2.5 (see supportsVertexSearchWithFunctions).
  const tools: any[] = [];
  if (req.webSearch) tools.push({ googleSearch: {} });
  if (req.urlContext) tools.push({ urlContext: {} });
  if (req.tools?.length) {
    tools.push({
      functionDeclarations: req.tools.map((t) => ({
        name: t.name, description: t.description, parameters: cleanSchema(t.parameters),
      })),
    });
  }
  if (tools.length) body.tools = tools;
  return body;
}

function groundingOf(metadata: any): GroundingInfo | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const queries = Array.isArray(metadata.webSearchQueries)
    ? metadata.webSearchQueries.filter((q: unknown): q is string => typeof q === 'string' && !!q.trim())
    : [];
  // Keep chunk index → source index so groundingSupports can be resolved
  // (chunks without a web uri are dropped, which shifts positions).
  const sources: GroundingInfo['sources'] = [];
  const chunkToSource = new Map<number, number>();
  if (Array.isArray(metadata.groundingChunks)) {
    metadata.groundingChunks.forEach((chunk: any, i: number) => {
      const web = chunk?.web;
      if (typeof web?.uri !== 'string' || !web.uri) return;
      chunkToSource.set(i, sources.length);
      sources.push({
        uri: web.uri,
        title: typeof web.title === 'string' && web.title ? web.title
          : typeof web.domain === 'string' && web.domain ? web.domain
          : web.uri,
      });
    });
  }
  const supports: GroundingInfo['supports'] = [];
  if (Array.isArray(metadata.groundingSupports)) {
    for (const sup of metadata.groundingSupports) {
      const text = typeof sup?.segment?.text === 'string' ? sup.segment.text : '';
      const idx = Array.isArray(sup?.groundingChunkIndices) ? sup.groundingChunkIndices : [];
      const mapped: number[] = [];
      for (const i of idx) { const m = chunkToSource.get(Number(i)); if (typeof m === 'number' && !mapped.includes(m)) mapped.push(m); }
      if (!text.trim() || !mapped.length) continue;
      supports.push({ text, start: Number(sup.segment?.startIndex) || 0, sources: mapped });
    }
  }
  return queries.length || sources.length
    ? { queries, sources, ...(supports.length ? { supports } : {}) }
    : null;
}

function toUsage(u: any): UsageInfo {
  return {
    promptTokens: u.promptTokenCount,
    completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    totalTokens: u.totalTokenCount,
  };
}

export const geminiAdapter: ChatAdapter = {
  async *streamChat(cfg, req) {
    const { url, headers, gate } = await endpoint(cfg, req.model, 'streamGenerateContent?alt=sse');
    req.onServiceTier?.(gate === 'priority' ? 'priority' : 'standard');
    const res = await fetchRetry(url, {
      method: 'POST', headers, body: JSON.stringify(buildChatBody(req)), signal: req.signal,
    }, retryReporter(req.onRetry, gate), { budgetMs: cfg.retryBudgetMs, gate, counter: cfg.busyCounter, singleAttempt: cfg.singleAttempt, stopOnBusy: cfg.stopOnBusy });
    if (!res.ok) throw await providerError('Gemini', res);

    let usage: any = null;
    let finishReason: string | null = null;
    let sawToolCall = false;
    let callCounter = 0;
    let grounding: GroundingInfo | null = null;
    const startedAt = Date.now();
    let lastByteAt = startedAt;
    let receivedBytes = 0;
    let events = 0;
    let invalidEvents = 0;
    let transport: ProviderStreamEnd['transport'] = 'consumer_closed';
    let promptBlockReason: string | null = null;
    let errorCode: string | null = null;

    try {
      for await (const msg of sseMessages(res, (bytes) => {
        receivedBytes += bytes;
        lastByteAt = Date.now();
        req.onActivity?.();
      })) {
        events++;
        let chunk: any;
        try { chunk = JSON.parse(msg.data); } catch { invalidEvents++; continue; }
        if (!chunk || typeof chunk !== 'object') { invalidEvents++; continue; }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        if (typeof chunk.promptFeedback?.blockReason === 'string') promptBlockReason = chunk.promptFeedback.blockReason.slice(0, 80);
        const cand = chunk.candidates?.[0];
        if (!cand) continue;
        if (typeof cand.finishReason === 'string' && cand.finishReason) finishReason = cand.finishReason.slice(0, 80);
        // Metadata may arrive over several chunks; a later one that only
        // repeats the queries must not wipe sources an earlier one carried.
        const next = groundingOf(cand.groundingMetadata);
        const prev = grounding as GroundingInfo | null;
        if (next) {
          grounding = prev?.sources.length && !next.sources.length
            ? { ...prev, queries: [...new Set([...prev.queries, ...next.queries])] }
            : next;
        }
        for (const part of cand.content?.parts ?? []) {
          if (part.thought === true && part.text) {
            yield { type: 'reasoning', text: part.text };
          } else if (typeof part.text === 'string' && part.text) {
            yield { type: 'text', text: part.text };
          } else if (part.functionCall) {
            sawToolCall = true;
            yield {
              type: 'tool_call',
              id: `fc_${callCounter++}`,
              name: part.functionCall.name,
              args: JSON.stringify(part.functionCall.args ?? {}),
              sig: typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined,
            };
          }
        }
      }
      transport = 'eof';
    } catch (err) {
      transport = req.signal.aborted ? 'aborted' : 'error';
      const e = err as { name?: string; cause?: { code?: string } };
      errorCode = String(e?.cause?.code ?? e?.name ?? 'Error').slice(0, 80);
      // A complete final frame remains authoritative if the socket resets
      // afterwards. Do not turn a confirmed answer into a continuation.
      const confirmed = finishReason && ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finishReason);
      if (req.signal.aborted || !confirmed || !isNetworkError(err)) throw err;
    } finally {
      req.onStreamEnd?.({
        requestedMaxOutputTokens: req.maxTokens,
        thoughtTokens: usage?.thoughtsTokenCount,
        answerTokens: usage?.candidatesTokenCount,
        endpointId: cfg.endpointId ?? `${cfg.id}:primary`,
        location: cfg.useVertex ? cfg.vertexLocation ?? 'global' : null,
        priority: gate === 'priority', transport, finishReason, promptBlockReason, errorCode,
        receivedBytes, events, invalidEvents,
        durationMs: Date.now() - startedAt, sinceLastByteMs: Date.now() - lastByteAt,
      });
    }

    if (grounding) yield { type: 'grounding', grounding };
    if (usage) yield { type: 'usage', usage: toUsage(usage) };
    const reason = promptBlockReason ? 'content_filter' : sawToolCall ? 'tool_calls'
      : finishReason === 'MAX_TOKENS' ? 'length'
      : finishReason === 'STOP' ? 'stop'
      : finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finishReason) ? 'content_filter'
      : 'other';
    yield { type: 'stop', reason };
  },

  async listModels(cfg) {
    if (cfg.useVertex) {
      // Credentials are validated either way: a bad service account fails at
      // the token fetch, before any list can "succeed".
      vertexProjectOf(cfg);
      const token = await getVertexAuth(cfg).getAccessToken();
      if (!token) throw new Error('Gemini: 获取 Vertex 访问令牌失败,请检查服务账号 JSON');

      // The publisher catalog only exists under v1beta1 (v1 404s) and caps
      // pageSize at 100 — larger values silently return an empty page.
      const origin = (cfg.baseUrl || 'https://aiplatform.googleapis.com').replace(/\/+$/, '');
      const names: string[] = [];
      try {
        let pageToken = '';
        do {
          const url = `${origin}/v1beta1/publishers/google/models?pageSize=100${
            pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const res = await fetch(url, { headers: { ...cfg.extraHeaders, authorization: `Bearer ${token}` } });
          if (!res.ok) throw await providerError('Gemini', res);
          const j: any = await res.json();
          for (const m of j.publisherModels ?? []) {
            names.push(String(m.name).replace(/^publishers\/google\/models\//, ''));
          }
          pageToken = j.nextPageToken || '';
        } while (pageToken && names.length < 1000);
      } catch {
        // Catalog access can be restricted per project — the credentials are
        // already proven good, so fall back to a starter list rather than
        // failing the whole fetch.
      }
      const usable = names.filter((id) => !/embedding|tts|live/.test(id));
      if (usable.length) return usable.map((id) => ({ id }));
      return ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image']
        .map((id) => ({ id }));
    }
    const h: Record<string, string> = { ...cfg.extraHeaders };
    if (cfg.apiKey) h['x-goog-api-key'] = cfg.apiKey;
    const res = await fetch(`${studioOrigin(cfg)}/v1beta/models?pageSize=1000`, { headers: h });
    if (!res.ok) throw await providerError('Gemini', res);
    const j: any = await res.json();
    const list = Array.isArray(j?.models) ? j.models : [];
    return list
      .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName }));
  },

  async generateImages(cfg, req: ImageGenRequest): Promise<ImageGenResult> {
    // Gemini image models are ordinary generateContent models, so a chat turn can
    // hand over the whole conversation and get context-aware edits ("make it blue").
    let contents: any[];
    if (req.context?.length) {
      contents = toContents(req.context);
    } else {
      const parts: any[] = [{ text: req.prompt }];
      for (const img of req.inputImages ?? []) {
        parts.push({ inlineData: { mimeType: img.mime, data: img.dataBase64 } });
      }
      contents = [{ role: 'user', parts }];
    }
    const body: any = {
      contents,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(req.size && /^\d+:\d+$/.test(req.size) ? { imageConfig: { aspectRatio: req.size } } : {}),
      },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    const { url, headers, gate } = await endpoint(cfg, req.model, 'generateContent');

    const images: GeneratedImage[] = [];
    // n calls with the same prompt tend to repeat the same commentary — keep distinct ones.
    const texts: string[] = [];
    let lastUsage: UsageInfo | undefined;
    const n = Math.min(req.n || 1, 4);
    for (let i = 0; i < n; i++) {
      const res = await fetchRetry(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: req.signal,
      }, retryReporter(req.onRetry, gate), { budgetMs: cfg.retryBudgetMs, gate, counter: cfg.busyCounter, singleAttempt: cfg.singleAttempt });
      if (!res.ok) throw await providerError('Gemini', res);
      const maxJsonBytes = Math.ceil(config.maxGeneratedImageBytes * 4 / 3) + 1024 * 1024;
      const j: any = await readJsonLimited(res, maxJsonBytes);
      const usage = j?.usageMetadata ? toUsage(j.usageMetadata) : undefined;
      lastUsage = usage ?? lastUsage;
      let gotImage = false;
      let text = '';
      for (const part of j?.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          gotImage = true;
          images.push({ mime: part.inlineData.mimeType || 'image/png', dataBase64: part.inlineData.data, usage });
        } else if (typeof part.text === 'string' && part.text && part.thought !== true) {
          text += part.text;
        }
      }
      text = text.trim();
      if (text && !texts.includes(text)) texts.push(text);
      // The model chose to talk instead of draw (a question, options to pick
      // from, a refusal). Asking again with the same prompt would only get the
      // same answer n times over — hand the text back and let the user reply.
      if (!gotImage) break;
    }
    const text = texts.join('\n\n');
    if (!images.length && !text) throw new Error('Gemini 未返回图片数据');
    return { images, text: text || undefined, usage: lastUsage };
  },
};
