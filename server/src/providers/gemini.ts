import { GoogleAuth } from 'google-auth-library';
import type {
  AdapterMessage, ChatAdapter, ChatRequest, GeneratedImage,
  ImageGenRequest, ProviderRuntimeConfig, UsageInfo,
} from '../types.js';
import { sseMessages, readErrorBody } from './sse.js';

const DEFAULT_STUDIO_BASE = 'https://generativelanguage.googleapis.com';

// AI Studio origin: strip trailing slash and an already-present /v1beta suffix.
function studioOrigin(cfg: ProviderRuntimeConfig): string {
  let o = (cfg.baseUrl || DEFAULT_STUDIO_BASE).replace(/\/+$/, '');
  if (o.endsWith('/v1beta')) o = o.slice(0, -'/v1beta'.length);
  return o;
}

// Vertex auth clients cached per provider config; the lib refreshes tokens internally.
const vertexAuth = new Map<string, GoogleAuth>();

function getVertexAuth(cfg: ProviderRuntimeConfig): GoogleAuth {
  let auth = vertexAuth.get(cfg.id);
  if (!auth) {
    if (!cfg.vertexSaJson) throw new Error('Gemini: Vertex AI 需要服务账号 JSON');
    auth = new GoogleAuth({
      credentials: JSON.parse(cfg.vertexSaJson),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    vertexAuth.set(cfg.id, auth);
  }
  return auth;
}

// Resolve URL + auth headers for a model verb ('streamGenerateContent?alt=sse' | 'generateContent').
async function endpoint(cfg: ProviderRuntimeConfig, model: string, verb: string): Promise<{ url: string; headers: Record<string, string> }> {
  const h: Record<string, string> = { ...cfg.extraHeaders, 'content-type': 'application/json' };
  if (cfg.useVertex) {
    if (!cfg.vertexProject) throw new Error('Gemini: Vertex AI 需要项目 ID');
    const location = cfg.vertexLocation || 'global';
    const origin = (cfg.baseUrl || (location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${location}-aiplatform.googleapis.com`)).replace(/\/+$/, '');
    const token = await getVertexAuth(cfg).getAccessToken();
    h['authorization'] = `Bearer ${token}`;
    return {
      url: `${origin}/v1/projects/${cfg.vertexProject}/locations/${location}/publishers/google/models/${model}:${verb}`,
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
          modelParts.push({ functionCall: { name: p.name, args } });
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

function buildChatBody(req: ChatRequest): any {
  const body: any = { contents: toContents(req.messages) };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  const generationConfig: any = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.reasoningEffort) {
    // 0 disables thinking outright; -1 hands the budget back to the model.
    const budget = { off: 0, low: 2048, medium: 8192, high: 24576 }[req.reasoningEffort];
    generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: budget !== 0 };
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (req.tools?.length) {
    body.tools = [{
      functionDeclarations: req.tools.map((t) => ({
        name: t.name, description: t.description, parameters: cleanSchema(t.parameters),
      })),
    }];
  }
  return body;
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

    for await (const msg of sseMessages(res)) {
      let chunk: any;
      try { chunk = JSON.parse(msg.data); } catch { continue; }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
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
          };
        }
      }
      if (cand.finishReason) finishReason = cand.finishReason;
    }

    if (usage) yield { type: 'usage', usage: toUsage(usage) };
    const reason = sawToolCall ? 'tool_calls'
      : finishReason === 'MAX_TOKENS' ? 'length'
      : finishReason === 'STOP' ? 'stop' : 'other';
    yield { type: 'stop', reason };
  },

  async listModels(cfg) {
    if (cfg.useVertex) {
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
      const j: any = await res.json();
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
