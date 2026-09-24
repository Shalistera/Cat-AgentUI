import type { ModelInfo, StreamHandlers, UsageLimit } from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const onUnauthorized: { handler: (() => void) | null } = { handler: null };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-csrf': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) onUnauthorized.handler?.();
  let json: { error?: string } & Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new ApiError(res.status, (json.error as string) || `请求失败 (${res.status})`);
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export async function uploadFile(file: File): Promise<{ id: string; mime: string; size: number; name?: string | null }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/uploads', {
    method: 'POST', credentials: 'same-origin', headers: { 'x-csrf': '1' }, body: form,
  });
  if (res.status === 401) onUnauthorized.handler?.();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error || '上传失败');
  return json;
}

/** Upload one file into a chat's 工作区 (optionally under a sub-folder). */
export async function uploadWorkspaceFile(chatId: string, file: File, dir?: string): Promise<{ path: string; size: number }> {
  const form = new FormData();
  if (dir) form.append('dir', dir);
  form.append('file', file);
  const res = await fetch(`/api/chats/${chatId}/workspace/upload`, {
    method: 'POST', credentials: 'same-origin', headers: { 'x-csrf': '1' }, body: form,
  });
  if (res.status === 401) onUnauthorized.handler?.();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error || '上传失败');
  return json;
}

export interface StreamPayload {
  content?: ({ type: 'text'; text: string }
    | { type: 'image'; uploadId: string }
    | { type: 'file'; uploadId: string; name?: string; mime?: string })[];
  modelId?: string;
  regenerateMessageId?: string;
  editMessageId?: string;
  /** Parent for a new message — the leaf of the branch being viewed. */
  parentMessageId?: string;
}

// POST + parse SSE from response body.
export async function streamChat(
  chatId: string, payload: StreamPayload, handlers: StreamHandlers, signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}/stream`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf': '1' },
    body: JSON.stringify(payload),
    signal,
  });
  if (res.status === 401) onUnauthorized.handler?.();
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(res.status, json.error || `请求失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let dataLines: string[] = [];

  const dispatch = () => {
    if (!dataLines.length) return;
    let data: any = {};
    try { data = JSON.parse(dataLines.join('\n')); }
    catch { event = null; dataLines = []; return; }
    switch (event) {
      case 'meta': handlers.onMeta?.(data); break;
      case 'delta': handlers.onDelta?.(data.text ?? ''); break;
      case 'reasoning': handlers.onReasoning?.(data.text ?? ''); break;
      case 'thought_signature': handlers.onThoughtSignature?.(data); break;
      case 'tool_call': handlers.onToolCall?.(data); break;
      case 'tool_result': handlers.onToolResult?.(data); break;
      case 'subagent_progress': handlers.onSubagentProgress?.(data); break;
      case 'tool_confirm': handlers.onToolConfirm?.(data); break;
      case 'grounding': handlers.onGrounding?.(data); break;
      case 'image': handlers.onImage?.(data); break;
      case 'usage': handlers.onUsage?.(data); break;
      case 'notice': handlers.onNotice?.(data.message ?? ''); break;
      case 'retry': handlers.onRetry?.(data); break;
      case 'title': handlers.onTitle?.(data.title ?? ''); break;
      case 'followups': handlers.onFollowups?.(data); break;
      case 'error': handlers.onError?.(data.message ?? '发生错误', data.code); break;
      case 'done': handlers.onDone?.(data.status ?? 'done', data.finishReason ?? null); break;
    }
    event = null; dataLines = [];
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buf && !buf.endsWith('\n')) buf += '\n';
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') dispatch();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
    dispatch();
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
    reader.releaseLock();
  }
}

/**
 * POST a JSON body and feed back every SSE event (name + parsed data). The
 * building block behind streamChat; other streaming endpoints (OCR) reuse it.
 */
export async function streamSse(
  path: string, payload: unknown, onEvent: (event: string, data: any) => void, signal: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf': '1' },
    body: JSON.stringify(payload),
    signal,
  });
  if (res.status === 401) onUnauthorized.handler?.();
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(res.status, json.error || `请求失败 (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let dataLines: string[] = [];
  const dispatch = () => {
    if (!dataLines.length) return;
    let data: any = {};
    try { data = JSON.parse(dataLines.join('\n')); } catch { /* ignore */ }
    if (event) onEvent(event, data);
    event = null; dataLines = [];
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') dispatch();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  dispatch();
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/**
 * The model name as a person should read it. Rows imported from Open WebUI can
 * carry gateway routing in front of the name
 * (`modelref::openai::personal::id:9156397c::gpt-5.6-sol`) — show the last
 * segment only. Native rows are plain API names and pass through untouched.
 */
export function fmtModelName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.includes('::')) return raw;
  const last = raw.split('::').map((s) => s.trim()).filter(Boolean).pop();
  return last || raw;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Every axis of a per-model allowance is spent → the next request bounces. */
export function usageLimitExhausted(l: UsageLimit): boolean {
  return (!!l.requests && l.requests.used >= l.requests.limit)
    || (!!l.tokens && l.tokens.used >= l.tokens.limit);
}

/** Who to hand a conversation to when its provider keeps rate-limiting: the
 * first model in the person's own order (starred first, as the picker shows
 * it) from a different provider that can carry this conversation — a text
 * model, with vision when there are pictures, with tools when tools are in
 * play — and still has allowance left. null = nothing suitable. */
export function suggestFallbackModel(
  models: ModelInfo[],
  opts: { avoidProviderId: string | null; needsVision: boolean; needsTools: boolean },
): ModelInfo | null {
  return models.find((m) => !m.imageGen
    && m.providerId !== opts.avoidProviderId
    && (!opts.needsVision || m.vision)
    && (!opts.needsTools || m.tools)
    && !(m.usageLimit && usageLimitExhausted(m.usageLimit))) ?? null;
}

/** "今日已用 3 / 10 次 · 1.2k / 50.0k tokens" for the picker and new-chat page. */
export function fmtUsageLimit(l: UsageLimit): string {
  const tok = (n: number) => (n === 0 ? '0' : fmtTokens(n));
  const parts: string[] = [];
  if (l.requests) parts.push(`${l.requests.used} / ${l.requests.limit} 次`);
  if (l.tokens) parts.push(`${tok(l.tokens.used)} / ${tok(l.tokens.limit)} tokens`);
  return `${l.period === 'week' ? '本周' : '今日'}已用 ${parts.join(' · ')}`;
}

/** The shortest honest reading: the exhausted axis if any, else the first one. */
export function fmtUsageLimitShort(l: UsageLimit): string {
  const tok = (n: number) => (n === 0 ? '0' : fmtTokens(n));
  const reqOut = !!l.requests && l.requests.used >= l.requests.limit;
  const tokOut = !!l.tokens && l.tokens.used >= l.tokens.limit;
  if (l.requests && (reqOut || !tokOut)) return `${l.requests.used}/${l.requests.limit} 次`;
  if (l.tokens) return `${tok(l.tokens.used)}/${tok(l.tokens.limit)}`;
  return '';
}

/** Money from the usage endpoints — precision follows magnitude. */
export function fmtCost(n: number | null | undefined, currency: string): string {
  if (n == null) return '—';
  const digits = n >= 100 ? 1 : n >= 1 ? 2 : 4;
  return `${currency}${n.toFixed(digits)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Human message from a thrown value — the admin pages' toast helper. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}
