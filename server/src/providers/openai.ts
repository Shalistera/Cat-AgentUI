import type {
  AdapterEvent, AdapterMessage, ChatAdapter, ChatRequest, GeneratedImage, ImageGenResult,
  ImageGenRequest, ProviderRuntimeConfig, ToolDef,
} from '../types.js';
import { sseMessages, readBodyLimited, providerError, readJsonLimited, fetchRetry } from './sse.js';
import { isBareOrigin, stripEndpointSuffix, trimUrl } from './base-url.js';
import { config } from '../config.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

// Endpoints this adapter appends to the base — pasting any of them as the
// base URL is a common mistake, since that is the URL most gateways document.
const ENDPOINTS = [
  '/chat/completions', '/completions', '/responses', '/models', '/embeddings',
  '/images/generations', '/images/edits',
];

function base(cfg: ProviderRuntimeConfig): string {
  const raw = trimUrl(cfg.baseUrl || DEFAULT_BASE);
  const u = stripEndpointSuffix(raw, ENDPOINTS);
  // A pasted endpoint names its own root — `https://host/chat/completions`
  // stays at `https://host`, no /v1 guessing.
  if (u !== raw) return u;
  // A bare origin, though, is the OpenAI-compatible root, which lives under
  // /v1 on essentially every gateway. Without this, `https://host` fetches
  // `https://host/models` and the model list comes back 404.
  return isBareOrigin(u) ? `${u}/v1` : u;
}

function headers(cfg: ProviderRuntimeConfig, json = true): Record<string, string> {
  const h: Record<string, string> = { ...cfg.extraHeaders };
  if (json) h['content-type'] = 'application/json';
  if (cfg.apiKey) h['authorization'] = `Bearer ${cfg.apiKey}`;
  return h;
}

function isOfficialApi(cfg: ProviderRuntimeConfig): boolean {
  return !cfg.baseUrl || cfg.baseUrl.includes('api.openai.com');
}

// ---- Chat Completions message conversion ----
// One AdapterMessage may expand to several OpenAI messages (assistant w/ tool_calls, then tool results).
function toChatMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });

  for (const m of req.messages) {
    if (m.role === 'user') {
      const content: unknown[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        else if (p.type === 'image' && p.dataBase64) {
          content.push({ type: 'image_url', image_url: { url: `data:${p.mime || 'image/png'};base64,${p.dataBase64}` } });
        } else if (p.type === 'file' && p.dataBase64) {
          content.push({
            type: 'file',
            file: { filename: p.name || 'document.pdf', file_data: `data:${p.mime || 'application/pdf'};base64,${p.dataBase64}` },
          });
        }
      }
      if (content.length === 1 && (content[0] as { type: string }).type === 'text') {
        out.push({ role: 'user', content: (content[0] as { text: string }).text });
      } else if (content.length) {
        out.push({ role: 'user', content });
      }
    } else {
      // assistant: split parts into (text+tool_calls) → tool results → text ...
      let text = '';
      let toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
      const flush = () => {
        if (text || toolCalls.length) {
          out.push({
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          });
          text = ''; toolCalls = [];
        }
      };
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) text += p.text;
        else if (p.type === 'tool_call') {
          toolCalls.push({ id: p.id!, type: 'function', function: { name: p.name!, arguments: p.args || '{}' } });
        } else if (p.type === 'tool_result') {
          flush();
          out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.result ?? '' });
        }
      }
      flush();
    }
  }
  return out;
}

function toChatTools(tools?: ToolDef[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function* streamChatCompletions(cfg: ProviderRuntimeConfig, req: ChatRequest): AsyncGenerator<AdapterEvent> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toChatMessages(req),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) {
    if (isOfficialApi(cfg)) body.max_completion_tokens = req.maxTokens;
    else body.max_tokens = req.maxTokens;
  }
  // Passed through verbatim: the admin configures these using OpenAI's own
  // vocabulary, so a new tier works without a code change. `off` is our own
  // sentinel, not a vendor level — it means "omit the field".
  if (req.reasoning && req.reasoning.level !== 'off') body.reasoning_effort = req.reasoning.level;
  const tools = toChatTools(req.tools);
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

  const res = await fetchRetry(`${base(cfg)}/chat/completions`, {
    method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal,
  }, req.onRetry, { budgetMs: cfg.retryBudgetMs });
  if (!res.ok) throw await providerError('OpenAI', res);

  // accumulate tool calls by index
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish: string | null = null;

  for await (const msg of sseMessages(res, req.onActivity)) {
    if (msg.data === '[DONE]') break;
    let chunk: any;
    try { chunk = JSON.parse(msg.data); } catch { continue; }
    if (chunk.usage) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        },
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'reasoning', text: delta.reasoning_content };
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning) {
      yield { type: 'reasoning', text: delta.reasoning };
    }
    if (typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', text: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: 'tool_call', id: c.id || `call_${i}`, name: c.name, args: c.args || '{}' };
  }
  const reason = finish === 'tool_calls' || calls.size ? 'tool_calls'
    : finish === 'length' ? 'length'
    : finish === 'content_filter' ? 'content_filter'
    : finish === 'stop' ? 'stop' : 'other';
  yield { type: 'stop', reason };
}

// ---- Responses API ----
function toResponsesInput(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      const content: unknown[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'input_text', text: p.text });
        else if (p.type === 'image' && p.dataBase64) {
          content.push({ type: 'input_image', image_url: `data:${p.mime || 'image/png'};base64,${p.dataBase64}` });
        } else if (p.type === 'file' && p.dataBase64) {
          content.push({
            type: 'input_file',
            filename: p.name || 'document.pdf',
            file_data: `data:${p.mime || 'application/pdf'};base64,${p.dataBase64}`,
          });
        }
      }
      if (content.length) out.push({ role: 'user', content });
    } else {
      let text = '';
      const flushText = () => {
        if (text) { out.push({ role: 'assistant', content: [{ type: 'output_text', text }] }); text = ''; }
      };
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) text += p.text;
        else if (p.type === 'tool_call') {
          flushText();
          out.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: p.args || '{}' });
        } else if (p.type === 'tool_result') {
          flushText();
          out.push({ type: 'function_call_output', call_id: p.toolCallId, output: p.result ?? '' });
        }
      }
      flushText();
    }
  }
  return out;
}

async function* streamResponses(cfg: ProviderRuntimeConfig, req: ChatRequest): AsyncGenerator<AdapterEvent> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: toResponsesInput(req),
    stream: true,
    store: false,
  };
  if (req.system) body.instructions = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (req.reasoning && req.reasoning.level !== 'off') {
    body.reasoning = { effort: req.reasoning.level, summary: 'auto' };
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function', name: t.name, description: t.description, parameters: t.parameters,
    }));
    body.tool_choice = 'auto';
  }

  const res = await fetchRetry(`${base(cfg)}/responses`, {
    method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal,
  }, req.onRetry, { budgetMs: cfg.retryBudgetMs });
  if (!res.ok) throw await providerError('OpenAI(Responses)', res);

  let sawToolCall = false;
  let incomplete: 'length' | 'content_filter' | null = null;

  for await (const msg of sseMessages(res, req.onActivity)) {
    let ev: any;
    try { ev = JSON.parse(msg.data); } catch { continue; }
    const t = ev.type as string | undefined;
    if (!t) continue;
    if (t === 'response.output_text.delta' && ev.delta) {
      yield { type: 'text', text: ev.delta };
    } else if (t === 'response.reasoning_summary_text.delta' && ev.delta) {
      yield { type: 'reasoning', text: ev.delta };
    } else if (t === 'response.output_item.done' && ev.item?.type === 'function_call') {
      sawToolCall = true;
      yield {
        type: 'tool_call',
        id: ev.item.call_id || ev.item.id,
        name: ev.item.name,
        args: ev.item.arguments || '{}',
      };
    } else if (t === 'response.completed' || t === 'response.incomplete') {
      const u = ev.response?.usage;
      if (u) {
        yield {
          type: 'usage',
          usage: { promptTokens: u.input_tokens, completionTokens: u.output_tokens, totalTokens: u.total_tokens },
        };
      }
      if (t === 'response.incomplete') {
        incomplete = ev.response?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
      }
    } else if (t === 'response.failed') {
      throw new Error(`OpenAI(Responses): ${ev.response?.error?.message || 'response failed'}`);
    } else if (t === 'error') {
      throw new Error(`OpenAI(Responses): ${ev.message || 'stream error'}`);
    }
  }
  yield { type: 'stop', reason: sawToolCall ? 'tool_calls' : incomplete ?? 'stop' };
}

export const openaiAdapter: ChatAdapter = {
  async *streamChat(cfg, req) {
    if (cfg.useResponses) yield* streamResponses(cfg, req);
    else yield* streamChatCompletions(cfg, req);
  },

  async listModels(cfg) {
    const res = await fetch(`${base(cfg)}/models`, { headers: headers(cfg, false) });
    if (!res.ok) throw await providerError('OpenAI', res);
    const j: any = await readJsonLimited(res, 5 * 1024 * 1024);
    const list = Array.isArray(j?.data) ? j.data : [];
    return list.map((m: any) => ({ id: String(m.id) })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  },

  async generateImages(cfg, req: ImageGenRequest): Promise<ImageGenResult> {
    const isDallE = req.model.startsWith('dall-e');
    // The images API takes a single prompt — a chat turn folds its context into it.
    const prompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
    // dall-e-3 has no /images/edits endpoint; ignore reference images rather than 400.
    const inputImages = req.model.startsWith('dall-e-3') ? undefined : req.inputImages;
    let res: Response;
    if (inputImages?.length) {
      // image editing via multipart
      const form = new FormData();
      form.set('model', req.model);
      form.set('prompt', prompt);
      if (req.n) form.set('n', String(req.n));
      if (req.size && req.size !== 'auto') form.set('size', req.size);
      if (req.quality && req.quality !== 'auto' && !isDallE) form.set('quality', req.quality);
      inputImages.forEach((img, i) => {
        const bytes = Buffer.from(img.dataBase64, 'base64');
        const ext = img.mime.includes('jpeg') ? 'jpg' : img.mime.includes('webp') ? 'webp' : 'png';
        form.append('image[]', new Blob([new Uint8Array(bytes)], { type: img.mime }), `input${i}.${ext}`);
      });
      res = await fetchRetry(`${base(cfg)}/images/edits`, {
        method: 'POST', headers: headers(cfg, false), body: form, signal: req.signal,
      }, req.onRetry, { budgetMs: cfg.retryBudgetMs });
    } else {
      const body: Record<string, unknown> = { model: req.model, prompt, n: req.n || 1 };
      if (req.size && req.size !== 'auto') body.size = req.size;
      if (req.quality && req.quality !== 'auto') body.quality = req.quality;
      if (isDallE) body.response_format = 'b64_json'; // gpt-image-* returns b64 by default and rejects this param
      res = await fetchRetry(`${base(cfg)}/images/generations`, {
        method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal,
      }, req.onRetry, { budgetMs: cfg.retryBudgetMs });
    }
    if (!res.ok) throw await providerError('OpenAI', res);
    const maxJsonBytes = Math.ceil(config.maxGeneratedImageBytes * (req.n || 1) * 4 / 3) + 1024 * 1024;
    const j: any = await readJsonLimited(res, maxJsonBytes);
    const usage = j?.usage
      ? { promptTokens: j.usage.input_tokens, completionTokens: j.usage.output_tokens, totalTokens: j.usage.total_tokens }
      : undefined;
    const out: GeneratedImage[] = [];
    for (const d of j?.data ?? []) {
      if (d.b64_json) out.push({ mime: 'image/png', dataBase64: d.b64_json, usage });
      else if (d.url) {
        const imgRes = await fetch(d.url, { signal: req.signal });
        if (!imgRes.ok) throw new Error(`图片下载失败 (${imgRes.status})`);
        const buf = await readBodyLimited(imgRes, config.maxGeneratedImageBytes);
        out.push({ mime: imgRes.headers.get('content-type') || 'image/png', dataBase64: buf.toString('base64'), usage });
      }
    }
    if (!out.length) throw new Error('图像生成接口未返回图片数据');
    return { images: out };
  },
};
