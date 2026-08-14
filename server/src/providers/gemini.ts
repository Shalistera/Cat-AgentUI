import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import type {
  AdapterMessage, ChatAdapter, ChatRequest, GeneratedImage, GroundingInfo,
  ImageGenRequest, ProviderRuntimeConfig, UsageInfo,
} from '../types.js';
import { sseMessages, readErrorBody, readJsonLimited } from './sse.js';
import { config } from '../config.js';

const DEFAULT_STUDIO_BASE = 'https://generativelanguage.googleapis.com';

// AI Studio origin: strip trailing slash and an already-present /v1beta suffix.
function studioOrigin(cfg: ProviderRuntimeConfig): string {
  let o = (cfg.baseUrl || DEFAULT_STUDIO_BASE).replace(/\/+$/, '');
  if (o.endsWith('/v1beta')) o = o.slice(0, -'/v1beta'.length);
  return o;
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
async function endpoint(cfg: ProviderRuntimeConfig, model: string, verb: string): Promise<{ url: string; headers: Record<string, string> }> {
  const h: Record<string, string> = { ...cfg.extraHeaders, 'content-type': 'application/json' };
  if (cfg.useVertex) {
    const project = vertexProjectOf(cfg);
    const location = cfg.vertexLocation || 'global';
    const origin = (cfg.baseUrl || (location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${location}-aiplatform.googleapis.com`)).replace(/\/+$/, '');
    const token = await getVertexAuth(cfg).getAccessToken();
    h['authorization'] = `Bearer ${token}`;
    return {
      url: `${origin}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${verb}`,
      headers: h,
    };
  }
  if (cfg.apiKey) h['x-goog-api-key'] = cfg.apiKey;
  return { url: `${studioOrigin(cfg)}/v1beta/models/${model}:${verb}`, headers: h };
}

// ---- Request body ----

function toContents(messages: AdapterMessage[]): any[] {
  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: any[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) parts.push({ text: p.text });
        else if (p.type === 'image' && p.dataBase64) {
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
          // thought_signature — echo it exactly as it arrived.
          modelParts.push({
            functionCall: { name: p.name, args },
            ...(p.sig ? { thoughtSignature: p.sig } : {}),
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
  return out;
}

/** Gemini 1.5 used the deprecated googleSearchRetrieval shape. Cat-AgentUI's
 * native integration intentionally targets the current googleSearch tool used
 * by currently supported Gemini 2.5 and newer Vertex models. */
export function supportsVertexGoogleSearch(model: string): boolean {
  const match = /^gemini-(\d+)(?:\.(\d+))?/i.exec(model.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 5);
}

function buildChatBody(req: ChatRequest): any {
  const body: any = { contents: toContents(req.messages) };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const generationConfig: any = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.reasoning) {
    // 0 is the only way to actually switch thinking off — omitting the config
    // leaves the model deciding for itself.
    const budget = req.reasoning.level !== 'off'
      ? Math.round(2048 + req.reasoning.ratio * (32768 - 2048))
      : 0;
    generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: budget > 0 };
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (req.webSearch) {
    body.tools = [{ googleSearch: {} }];
  } else if (req.tools?.length) {
    body.tools = [{
      functionDeclarations: req.tools.map((t) => ({
        name: t.name, description: t.description, parameters: cleanSchema(t.parameters),
      })),
    }];
  }
  return body;
}

function groundingOf(metadata: any): GroundingInfo | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const queries = Array.isArray(metadata.webSearchQueries)
    ? metadata.webSearchQueries.filter((q: unknown): q is string => typeof q === 'string' && !!q.trim())
    : [];
  const sources = Array.isArray(metadata.groundingChunks)
    ? metadata.groundingChunks.flatMap((chunk: any) => {
      const web = chunk?.web;
      return typeof web?.uri === 'string' && web.uri
        ? [{ uri: web.uri, title: typeof web.title === 'string' && web.title ? web.title : web.uri }]
        : [];
    })
    : [];
  const renderedContent = typeof metadata.searchEntryPoint?.renderedContent === 'string'
    ? metadata.searchEntryPoint.renderedContent
    : undefined;
  return queries.length || sources.length || renderedContent
    ? { queries, sources, ...(renderedContent ? { renderedContent } : {}) }
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
    const { url, headers } = await endpoint(cfg, req.model, 'streamGenerateContent?alt=sse');
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(buildChatBody(req)), signal: req.signal,
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await readErrorBody(res)}`);

    let usage: any = null;
    let finishReason: string | null = null;
    let sawToolCall = false;
    let callCounter = 0;
    let grounding: GroundingInfo | null = null;

    for await (const msg of sseMessages(res)) {
      let chunk: any;
      try { chunk = JSON.parse(msg.data); } catch { continue; }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      grounding = groundingOf(cand.groundingMetadata) ?? grounding;
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
      if (cand.finishReason) finishReason = cand.finishReason;
    }

    if (grounding) yield { type: 'grounding', grounding };
    if (usage) yield { type: 'usage', usage: toUsage(usage) };
    const reason = sawToolCall ? 'tool_calls'
      : finishReason === 'MAX_TOKENS' ? 'length'
      : finishReason === 'STOP' ? 'stop' : 'other';
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
          if (!res.ok) throw new Error(`Gemini ${res.status}: ${await readErrorBody(res)}`);
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
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await readErrorBody(res)}`);
    const j: any = await res.json();
    const list = Array.isArray(j?.models) ? j.models : [];
    return list
      .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName }));
  },

  async generateImages(cfg, req: ImageGenRequest): Promise<GeneratedImage[]> {
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
    const { url, headers } = await endpoint(cfg, req.model, 'generateContent');

    const out: GeneratedImage[] = [];
    let text = '';
    const n = Math.min(req.n || 1, 4);
    for (let i = 0; i < n; i++) {
      const res = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: req.signal,
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await readErrorBody(res)}`);
      const maxJsonBytes = Math.ceil(config.maxGeneratedImageBytes * 4 / 3) + 1024 * 1024;
      const j: any = await readJsonLimited(res, maxJsonBytes);
      const usage = j?.usageMetadata ? toUsage(j.usageMetadata) : undefined;
      for (const part of j?.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          out.push({ mime: part.inlineData.mimeType || 'image/png', dataBase64: part.inlineData.data, usage });
        } else if (typeof part.text === 'string' && part.text && part.thought !== true) {
          text += part.text;
        }
      }
    }
    if (!out.length) {
      // A refusal/clarification comes back as text only — surface it instead of a generic error.
      throw new Error(text.trim() ? `Gemini: ${text.trim().slice(0, 500)}` : 'Gemini 未返回图片数据');
    }
    if (text.trim()) out[0].text = text.trim();
    return out;
  },
};
