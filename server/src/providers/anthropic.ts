import type {
  AdapterEvent, AdapterMessage, ChatAdapter, ChatRequest, ProviderRuntimeConfig, ToolDef,
} from '../types.js';
import { sseMessages, providerError, fetchRetry } from './sse.js';
import { stripEndpointSuffix, trimUrl } from './base-url.js';

const DEFAULT_BASE = 'https://api.anthropic.com';

// This adapter builds `/v1/...` itself, so a base that already carries the
// endpoint — or just the `/v1` prefix — has to be cut back to the origin.
const ENDPOINTS = ['/v1/messages', '/v1/models', '/messages', '/models'];

function base(cfg: ProviderRuntimeConfig): string {
  const u = stripEndpointSuffix(cfg.baseUrl || DEFAULT_BASE, ENDPOINTS);
  return /\/v1$/i.test(u) ? trimUrl(u.slice(0, -'/v1'.length)) : u;
}

function headers(cfg: ProviderRuntimeConfig, json = true): Record<string, string> {
  const h: Record<string, string> = { ...cfg.extraHeaders, 'anthropic-version': '2023-06-01' };
  if (json) h['content-type'] = 'application/json';
  if (cfg.apiKey) h['x-api-key'] = cfg.apiKey;
  return h;
}

function parseArgs(args?: string): unknown {
  try { return JSON.parse(args || '{}'); } catch { return {}; }
}

// One AdapterMessage may expand to several Anthropic messages (tool results go back as user turns).
function toMessages(messages: AdapterMessage[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];

  for (const m of messages) {
    if (m.role === 'user') {
      const content: any[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        else if (p.type === 'image' && p.dataBase64) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: p.mime || 'image/png', data: p.dataBase64 },
          });
        } else if (p.type === 'file' && p.dataBase64) {
          // PDF attachment → native document block (text docs never reach
          // adapters; they were flattened to text upstream).
          content.push({
            type: 'document',
            source: { type: 'base64', media_type: p.mime || 'application/pdf', data: p.dataBase64 },
            ...(p.name ? { title: p.name } : {}),
          });
        }
      }
      if (content.length) out.push({ role: 'user', content });
    } else {
      // assistant: walk parts in order; tool results flush as a user message
      let blocks: any[] = [];
      let results: any[] = [];
      const flushBlocks = () => {
        if (blocks.length) { out.push({ role: 'assistant', content: blocks }); blocks = []; }
      };
      const flushResults = () => {
        if (results.length) { out.push({ role: 'user', content: results }); results = []; }
      };
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) {
          flushResults();
          blocks.push({ type: 'text', text: p.text });
        } else if (p.type === 'tool_call') {
          flushResults();
          blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: parseArgs(p.args) });
        } else if (p.type === 'tool_result') {
          flushBlocks();
          results.push({
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            // the API rejects empty text blocks, and tools legitimately return nothing
            content: [{ type: 'text', text: p.result || '(no output)' }],
            ...(p.isError ? { is_error: true } : {}),
          });
        }
      }
      flushBlocks();
      flushResults();
    }
  }

  // Anthropic requires strict user/assistant alternation: merge consecutive same-role messages.
  const merged: { role: 'user' | 'assistant'; content: any[] }[] = [];
  for (const msg of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) last.content = last.content.concat(msg.content);
    else merged.push(msg);
  }
  return merged;
}

function toTools(tools?: ToolDef[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

// Anthropic budgets thinking in tokens rather than naming effort levels, so the
// position on the model's ladder is what carries over — that keeps working
// whatever the admin calls the levels.
const MIN_THINKING = 2048;
const MAX_THINKING = 32768;

async function* streamMessages(cfg: ProviderRuntimeConfig, req: ChatRequest): AsyncGenerator<AdapterEvent> {
  const desiredThinking = req.reasoning && req.reasoning.level !== 'off'
    ? Math.round(MIN_THINKING + req.reasoning.ratio * (MAX_THINKING - MIN_THINKING))
    : null;
  const maxThinkingWithinHardCap = (req.hardMaxTokens ?? Number.POSITIVE_INFINITY) - 4096;
  const thinking = desiredThinking && maxThinkingWithinHardCap >= MIN_THINKING
    ? Math.min(desiredThinking, maxThinkingWithinHardCap)
    : null;
  // The reply budget has to leave room for the thinking budget on top of the
  // visible answer, or the request is rejected outright.
  const requestedMaxTokens = thinking
    ? Math.max(req.maxTokens ?? 8192, thinking + 4096)
    : req.maxTokens ?? 8192;
  const maxTokens = Math.min(requestedMaxTokens, req.hardMaxTokens ?? requestedMaxTokens);

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    messages: toMessages(req.messages),
    stream: true,
  };
  // Long system prompts (project knowledge riding along) get an explicit cache
  // breakpoint — Anthropic only caches on request, and the docs block is the
  // stable prefix that repeats every turn of a project chat.
  if (req.system) {
    body.system = req.system.length >= 4096
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;
  }
  // Extended thinking pins temperature to 1; sending both is a 400.
  if (thinking) body.thinking = { type: 'enabled', budget_tokens: thinking };
  else if (req.temperature !== undefined) body.temperature = req.temperature;
  const tools = toTools(req.tools);
  if (tools) body.tools = tools;

  const res = await fetchRetry(`${base(cfg)}/v1/messages`, {
    method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal,
  }, req.onRetry, { budgetMs: cfg.retryBudgetMs, stopOnBusy: cfg.stopOnBusy });
  if (!res.ok) throw await providerError('Anthropic', res);

  // track tool_use blocks by content index
  const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: string | null = null;

  for await (const msg of sseMessages(res, req.onActivity)) {
    let ev: any;
    try { ev = JSON.parse(msg.data); } catch { continue; }
    if (ev.type === 'message_start') {
      inputTokens = ev.message?.usage?.input_tokens;
    } else if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'tool_use') {
        toolBlocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, argsJson: '' });
      }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta ?? {};
      if (d.type === 'text_delta' && d.text) {
        yield { type: 'text', text: d.text };
      } else if (d.type === 'thinking_delta' && d.thinking) {
        yield { type: 'reasoning', text: d.thinking };
      } else if (d.type === 'input_json_delta') {
        const b = toolBlocks.get(ev.index);
        if (b) b.argsJson += d.partial_json ?? '';
      }
    } else if (ev.type === 'content_block_stop') {
      const b = toolBlocks.get(ev.index);
      if (b) {
        toolBlocks.delete(ev.index);
        yield { type: 'tool_call', id: b.id, name: b.name, args: b.argsJson || '{}' };
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage?.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
    } else if (ev.type === 'error') {
      throw new Error(`Anthropic: ${ev.error?.message || 'stream error'}`);
    }
  }

  if (inputTokens !== undefined || outputTokens !== undefined) {
    yield {
      type: 'usage',
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
    };
  }
  const reason = stopReason === 'tool_use' ? 'tool_calls'
    : stopReason === 'end_turn' || stopReason === 'stop_sequence' ? 'stop'
    : stopReason === 'max_tokens' ? 'length'
    : stopReason === 'refusal' ? 'content_filter' : 'other';
  yield { type: 'stop', reason };
}

export const anthropicAdapter: ChatAdapter = {
  async *streamChat(cfg, req) {
    yield* streamMessages(cfg, req);
  },

  async listModels(cfg) {
    const res = await fetch(`${base(cfg)}/v1/models?limit=200`, { headers: headers(cfg, false) });
    if (!res.ok) throw await providerError('Anthropic', res);
    const j: any = await res.json();
    const list = Array.isArray(j?.data) ? j.data : [];
    return list.map((m: any) => ({ id: String(m.id), name: m.display_name }));
  },
};
