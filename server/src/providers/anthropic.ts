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

/** Claude 4.6+ and the 5 family (Haiku from 5.5): adaptive thinking steered by `effort`.
    budget_tokens and sampling parameters are rejected (400) on most of them. */
function adaptiveModel(model: string): boolean {
  const id = (model.split('/').pop() ?? '').toLowerCase();
  return /claude-(opus|sonnet)-4[-.][6-9]|claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(id);
}

// Thinking blocks ride on a tool call's `sig` (the slot Gemini uses for its
// thought signature): with thinking on, the API wants the blocks that led to
// a tool call sent back, unmodified, when the tool loop continues. The prefix
// keeps them apart from other vendors' signatures.
export const ANTHROPIC_SIG_PREFIX = 'anthropic-thinking:';
type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };

function thinkingFromSig(sig?: string): ThinkingBlock[] {
  if (!sig?.startsWith(ANTHROPIC_SIG_PREFIX)) return [];
  try {
    const blocks = JSON.parse(sig.slice(ANTHROPIC_SIG_PREFIX.length));
    return Array.isArray(blocks) ? blocks : [];
  } catch { return []; }
}

// One AdapterMessage may expand to several Anthropic messages (tool results go back as user turns).
// Thinking blocks are replayed only for the turn in progress (the trailing
// assistant message): earlier turns may have been trimmed or summarized since,
// and a block whose preceding conversation changed is no longer valid.
function toMessages(messages: AdapterMessage[]): { role: 'user' | 'assistant'; content: any[] }[] {
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const last = messages.length - 1;

  for (const [index, m] of messages.entries()) {
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
      const replayThinking = index === last;
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
          const thinking = replayThinking ? thinkingFromSig(p.sig) : [];
          // A message that thought must open with its thinking.
          if (thinking.length && !blocks.some((b) => b.type === 'tool_use')) blocks.unshift(...thinking);
          else blocks.push(...thinking);
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

/** Conversation caching: the newest block and the previous user turn get a
    breakpoint, so the next request reads the whole earlier conversation from
    cache (a fraction of the input price) instead of paying for it again. */
function markCacheBreakpoints(messages: { role: string; content: any[] }[]) {
  const mark = (msg?: { content: any[] }) => {
    const block = msg?.content.at(-1);
    if (block && block.type !== 'thinking' && block.type !== 'redacted_thinking') block.cache_control = { type: 'ephemeral' };
  };
  mark(messages.at(-1));
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === 'user') { mark(messages[i]); break; }
  }
}

function toTools(tools?: ToolDef[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

// Older models budget thinking in tokens rather than naming effort levels, so
// the position on the model's ladder is what carries over — that keeps
// working whatever the admin calls the levels.
const MIN_THINKING = 2048;
const MAX_THINKING = 32768;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Request body fields that steer thinking, per model generation. */
function thinkingFields(req: ChatRequest): { fields: Record<string, unknown>; maxTokens: number } {
  const hardMax = req.hardMaxTokens ?? Number.POSITIVE_INFINITY;
  const on = !!req.reasoning && req.reasoning.level !== 'off';
  if (adaptiveModel(req.model)) {
    const id = req.model.toLowerCase();
    // The 5 family thinks even with `thinking` omitted, and several of them
    // (Opus 5.5, Fable) can't turn it off: there "off" means the lowest
    // effort. 4.6–4.8 simply don't think when it's omitted.
    const thinksByDefault = /claude-(opus|sonnet|haiku|fable|mythos)-[5-9]/.test(id);
    const legacy46 = /4[-.]6/.test(id);
    let effort: string | null = !on ? (thinksByDefault ? 'low' : null)
      : EFFORTS.includes(req.reasoning!.level) ? req.reasoning!.level
      : req.reasoning!.ratio >= 0.75 ? 'high' : req.reasoning!.ratio >= 0.35 ? 'medium' : 'low';
    if (legacy46 && effort === 'xhigh') effort = 'high'; // 4.6 has no xhigh
    const fields: Record<string, unknown> = effort ? { output_config: { effort } } : {};
    // Newer models stream an empty thinking text unless asked for a summary.
    if (on) fields.thinking = legacy46 ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' };
    return { fields, maxTokens: Math.min(Math.max(req.maxTokens ?? 8192, on ? 32_768 : 16_384), hardMax) };
  }
  const desired = on ? Math.round(MIN_THINKING + req.reasoning!.ratio * (MAX_THINKING - MIN_THINKING)) : null;
  const budget = desired && hardMax - 4096 >= MIN_THINKING ? Math.min(desired, hardMax - 4096) : null;
  // Extended thinking pins temperature to 1; sending both is a 400.
  const fields: Record<string, unknown> = budget
    ? { thinking: { type: 'enabled', budget_tokens: budget } }
    : req.temperature !== undefined ? { temperature: req.temperature } : {};
  // The reply budget has to leave room for the thinking budget on top of the
  // visible answer, or the request is rejected outright.
  const requested = budget ? Math.max(req.maxTokens ?? 8192, budget + 4096) : req.maxTokens ?? 8192;
  return { fields, maxTokens: Math.min(requested, hardMax) };
}

async function* streamMessages(cfg: ProviderRuntimeConfig, req: ChatRequest): AsyncGenerator<AdapterEvent> {
  const steer = thinkingFields(req);
  const messages = toMessages(req.messages);
  markCacheBreakpoints(messages);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: steer.maxTokens,
    messages,
    stream: true,
    ...steer.fields,
  };
  // Long system prompts (project knowledge riding along) get an explicit cache
  // breakpoint — Anthropic only caches on request, and the docs block is the
  // stable prefix that repeats every turn of a project chat.
  if (req.system) {
    body.system = req.system.length >= 4096
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;
  }
  const tools = toTools(req.tools);
  if (tools) body.tools = tools;

  const res = await fetchRetry(`${base(cfg)}/v1/messages`, {
    method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal,
  }, req.onRetry, { budgetMs: cfg.retryBudgetMs, stopOnBusy: cfg.stopOnBusy });
  if (!res.ok) throw await providerError('Anthropic', res);

  // track tool_use and thinking blocks by content index
  const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();
  const thinkingBlocks = new Map<number, ThinkingBlock>();
  let thinkingSinceCall: ThinkingBlock[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: string | null = null;

  for await (const msg of sseMessages(res, req.onActivity)) {
    let ev: any;
    try { ev = JSON.parse(msg.data); } catch { continue; }
    if (ev.type === 'message_start') {
      // Cached reads and writes are prompt tokens too: without them a cached
      // conversation would all but vanish from usage stats and token limits.
      const u = ev.message?.usage;
      if (u) inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block;
      if (cb?.type === 'tool_use') {
        toolBlocks.set(ev.index, { id: cb.id, name: cb.name, argsJson: '' });
      } else if (cb?.type === 'thinking') {
        thinkingBlocks.set(ev.index, { type: 'thinking', thinking: cb.thinking ?? '', signature: cb.signature ?? '' });
      } else if (cb?.type === 'redacted_thinking') {
        thinkingBlocks.set(ev.index, { type: 'redacted_thinking', data: cb.data ?? '' });
      }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta ?? {};
      if (d.type === 'text_delta' && d.text) {
        yield { type: 'text', text: d.text };
      } else if (d.type === 'thinking_delta' && d.thinking) {
        const t = thinkingBlocks.get(ev.index);
        if (t?.type === 'thinking') t.thinking += d.thinking;
        yield { type: 'reasoning', text: d.thinking };
      } else if (d.type === 'signature_delta' && d.signature) {
        const t = thinkingBlocks.get(ev.index);
        if (t?.type === 'thinking') t.signature += d.signature;
      } else if (d.type === 'input_json_delta') {
        const b = toolBlocks.get(ev.index);
        if (b) b.argsJson += d.partial_json ?? '';
      }
    } else if (ev.type === 'content_block_stop') {
      const t = thinkingBlocks.get(ev.index);
      if (t) { thinkingBlocks.delete(ev.index); thinkingSinceCall.push(t); }
      const b = toolBlocks.get(ev.index);
      if (b) {
        toolBlocks.delete(ev.index);
        const sig = thinkingSinceCall.length ? ANTHROPIC_SIG_PREFIX + JSON.stringify(thinkingSinceCall) : undefined;
        thinkingSinceCall = [];
        yield { type: 'tool_call', id: b.id, name: b.name, args: b.argsJson || '{}', ...(sig ? { sig } : {}) };
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
