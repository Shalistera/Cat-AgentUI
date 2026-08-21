import type { StreamHandlers } from './types';

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

export interface StreamPayload {
  content?: ({ type: 'text'; text: string }
    | { type: 'image'; uploadId: string }
    | { type: 'file'; uploadId: string; name?: string; mime?: string })[];
  modelId?: string;
  regenerateMessageId?: string;
  editMessageId?: string;
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
    try { data = JSON.parse(dataLines.join('\n')); } catch { /* ignore */ }
    switch (event) {
      case 'meta': handlers.onMeta?.(data); break;
      case 'delta': handlers.onDelta?.(data.text ?? ''); break;
      case 'reasoning': handlers.onReasoning?.(data.text ?? ''); break;
      case 'tool_call': handlers.onToolCall?.(data); break;
      case 'tool_result': handlers.onToolResult?.(data); break;
      case 'grounding': handlers.onGrounding?.(data); break;
      case 'image': handlers.onImage?.(data); break;
      case 'usage': handlers.onUsage?.(data); break;
      case 'notice': handlers.onNotice?.(data.message ?? ''); break;
      case 'title': handlers.onTitle?.(data.title ?? ''); break;
      case 'followups': handlers.onFollowups?.(data); break;
      case 'error': handlers.onError?.(data.message ?? '发生错误'); break;
      case 'done': handlers.onDone?.(data.status ?? 'done'); break;
    }
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

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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
