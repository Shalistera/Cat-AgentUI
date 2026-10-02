import { setTimeout as sleep } from 'node:timers/promises';
import type { BusyCounter, ProviderRetry } from '../types.js';
import { config } from '../config.js';

// Minimal SSE parser over a fetch Response body.
export interface SseMessage { event: string | null; data: string }

// For network failures, only retry a POST when it provably wasn't sent.
// Explicit busy rejections (429/503/529) are handled separately below. Two classes of
// connection failures qualify:
//   * connection-phase failures (DNS / connect / connect-timeout): no bytes
//     were ever written;
//   * undici picking a pooled keep-alive socket that the peer had already
//     closed while a long tool call ran — it detects the dead socket BEFORE
//     writing the request and raises UND_ERR_SOCKET "other side closed".
// A mid-flight reset (ECONNRESET / EPIPE / "socket hang up") is deliberately
// NOT retried: the request may have been received, so we surface it and let
// the turn fail rather than risk a second charge.
function isPreSendError(err: unknown): boolean {
  if (!(err instanceof TypeError) || err.message !== 'fetch failed') return false;
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? '';
  const msg = cause?.message ?? '';
  if (/^(UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)$/.test(code)) return true;
  // idle-reused socket found closed before the request was sent
  if (code === 'UND_ERR_SOCKET' && /other side closed/i.test(msg)) return true;
  return false;
}

/** A fetch that never reached the peer (DNS / connect / refused / dead
 * pooled socket) or a mid-flight transport failure. Either way this line did
 * not answer, which is what failover cares about. */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string; cause?: { code?: string } };
  return ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes(e.cause?.code ?? e.code ?? '');
}

const MAX_RATE_RETRIES = 5;
/** Upstream statuses that mean "rejected before doing any work": rate limit
 * (429), Google "model is overloaded" (503) and Anthropic overloaded (529).
 * Nothing was generated or billed, so resending is as safe as for 429. */
export const BUSY_STATUSES = new Set([429, 503, 529]);

function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

// One rejection means every request to the same endpoint sent in the same
// window will be rejected too. Remember until when each endpoint asked us to
// back off, so later callers queue locally instead of piling more requests
// onto the limit and each learning about it separately.
const busyUntil = new Map<string, number>();
function busyKey(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}
function markBusy(key: string, delayMs: number) {
  busyUntil.set(key, Math.max(busyUntil.get(key) ?? 0, Date.now() + delayMs));
}
/** How long callers to this endpoint should hold off right now. */
function busyWaitMs(key: string): number {
  const until = busyUntil.get(key);
  if (!until) return 0;
  const wait = until - Date.now();
  if (wait <= 0) { busyUntil.delete(key); return 0; }
  return wait;
}
/** Test hook: forget every remembered backoff. */
export function resetProviderBusyGates() { busyUntil.clear(); }

/** Retry upstream busy rejections (see BUSY_STATUSES) before reading any
 * generated output. Never replay a successful response body, a partial
 * stream, or a tool turn.
 */
export async function fetchRetry(
  url: string, init: RequestInit & { signal?: AbortSignal },
  onRetry?: (state: ProviderRetry | null) => void,
  opts?: { budgetMs?: number; gate?: string; counter?: BusyCounter; singleAttempt?: boolean; stopOnBusy?: boolean },
): Promise<Response> {
  // `gate` splits one URL into separate backoff queues when requests to it
  // draw on different capacity (Vertex Priority PayGo vs standard).
  const key = opts?.gate ? `${busyKey(url)}#${opts.gate}` : busyKey(url);
  const budgetMs = Math.min(config.providerRetryMaxWaitMs, opts?.budgetMs ?? Infinity);
  let retries = 0;
  let waitedMs = 0;
  let connectionRetried = false;
  let reported = false;
  const report = (state: ProviderRetry) => { reported = true; onRetry?.(state); };
  try {
    for (;;) {
      init.signal?.throwIfAborted();
      // Someone else already hit the limit on this endpoint: wait our turn
      // (a little spread so the queue doesn't fire as one burst) as long as
      // the budget allows; otherwise send and let the response decide.
      const queueMs = busyWaitMs(key);
      if (opts?.stopOnBusy && queueMs > 0) throw new ProviderBusyError('模型服务', 429, 'Endpoint is in shared backoff');
      if (queueMs > 0 && waitedMs + queueMs <= budgetMs) {
        const spread = Math.round(Math.random() * 500);
        waitedMs += queueMs + spread;
        report({ attempt: retries, maxAttempts: MAX_RATE_RETRIES, delayMs: queueMs + spread, queued: true });
        await sleep(queueMs + spread, undefined, { signal: init.signal });
        init.signal?.throwIfAborted();
        report({ attempt: retries, maxAttempts: MAX_RATE_RETRIES, delayMs: 0 });
      }
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (init.signal?.aborted || opts?.singleAttempt || connectionRetried || !isPreSendError(err)) throw err;
        connectionRetried = true;
        await sleep(300, undefined, { signal: init.signal });
        continue;
      }
      if (!BUSY_STATUSES.has(res.status)) return res;
      // Shared across a request's lines: once it runs out, stop waiting here
      // and let the failover layer move on (to the Priority PayGo retry).
      const tallyFull = !!opts?.counter && ++opts.counter.busy >= opts.counter.limit;
      // 1–2s, 2–4s, 4–8s, 8–16s, 16–32s with jitter; respect longer server
      // hints within the total wait budget. Don't retry early when
      // Retry-After exceeds it.
      const delayMs = Math.max(
        Math.round(1000 * 2 ** retries * (1 + Math.random())),
        retryAfterMs(res.headers.get('retry-after')),
      );
      // Handing over at once still leaves the backoff behind, so later
      // callers skip or queue (within their own budgets) rather than each
      // hitting the limit again. A hint longer than anyone would wait is not
      // kept: nothing clears it early, and it would only make lines skip.
      if (opts?.stopOnBusy) {
        if (delayMs <= config.providerRetryMaxWaitMs) markBusy(key, delayMs);
        return res;
      }
      if (opts?.singleAttempt || retries >= MAX_RATE_RETRIES || tallyFull) return res;
      if (waitedMs + delayMs > budgetMs) return res;
      try { await res.body?.cancel(); } catch { /* rejected response discarded */ }
      markBusy(key, delayMs);
      retries++;
      waitedMs += delayMs;
      report({ attempt: retries, maxAttempts: MAX_RATE_RETRIES, delayMs });
      await sleep(delayMs, undefined, { signal: init.signal });
      init.signal?.throwIfAborted();
      report({ attempt: retries, maxAttempts: MAX_RATE_RETRIES, delayMs: 0 });
    }
  } finally {
    if (reported) onRetry?.(null);
  }
}

/** Any non-2xx answer from a provider, with the status kept so the failover
 * layer can tell "this line is down" (5xx, auth) from "this request is bad". */
export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class ProviderBusyError extends ProviderHttpError {
  readonly code = 'provider_busy' as const;
  constructor(name: string, status: number, readonly detail: string) {
    super(`${name} 的上游模型服务当前繁忙（被限流），已自动等待重试仍未成功，请稍后再试。`, status);
  }
}

const MAX_SSE_BUFFER_CHARS = 2 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 2 * 1024 * 1024;

export async function* sseMessages(res: Response, onChunk?: (bytes: number) => void): AsyncGenerator<SseMessage> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let data: string[] = [];
  let dataChars = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value?.byteLength) onChunk?.(value.byteLength);
      // Some gateways close after the last data line without its newline.
      // Drain it only at EOF; a delayed finish event must still be awaited.
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buf && !buf.endsWith('\n')) buf += '\n';
      if (buf.length > MAX_SSE_BUFFER_CHARS) throw new Error('Provider SSE 单行数据超过 2 MiB 限制');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = null; data = []; dataChars = 0;
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          data.push(value);
          dataChars += value.length;
          if (dataChars > MAX_SSE_EVENT_CHARS) {
            throw new Error('Provider SSE 事件超过 2 MiB 限制');
          }
        }
        // ignore comments / other fields
      }
      if (done) break;
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
    try { await res.body.cancel(); } catch { /* already consumed */ }
  }
}

// Gateway-class failures (Cloudflare 52x, nginx 502/504) usually arrive as an
// HTML error page. Nobody wants to read that in a toast, so those collapse to a
// plain-language message; real API errors keep the provider's own wording.
const GATEWAY_STATUS: Record<number, string> = {
  502: '服务暂时不可用,请过一会再试',
  504: '请求超时,请过一会再试',
  520: '服务暂时不可用,请过一会再试',
  521: '服务暂时不可用,请过一会再试',
  522: '连接超时,请过一会再试',
  523: '服务暂时不可用,请过一会再试',
  524: '生成超时,请过一会再试',
  529: '服务繁忙,请过一会再试',
};

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype|html|head|body)/i.test(text);
}

export async function providerError(name: string, res: Response): Promise<Error> {
  const body = await readErrorBody(res);
  const gateway = GATEWAY_STATUS[res.status];
  if (BUSY_STATUSES.has(res.status)) return new ProviderBusyError(name, res.status, body);
  if (gateway) return new ProviderHttpError(`${name}: ${gateway} (${res.status})`, res.status);
  if (looksLikeHtml(body) || !body.trim()) return new ProviderHttpError(`${name}: 上游返回了错误 (${res.status}),请稍后再试`, res.status);
  return new ProviderHttpError(`${name} ${res.status}: ${body}`, res.status);
}

export async function readErrorBody(res: Response): Promise<string> {
  let text = '';
  try { text = (await readBodyLimited(res, 64 * 1024)).toString('utf8'); } catch { /* ignore */ }
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message ?? j?.message ?? j?.error ?? text;
    text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch { /* keep raw */ }
  return text.slice(0, 500);
}

export async function readBodyLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`Provider 响应超过 ${maxBytes} 字节限制`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Provider 响应超过 ${maxBytes} 字节限制`);
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already consumed */ }
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

export async function readJsonLimited(res: Response, maxBytes: number): Promise<any> {
  const body = await readBodyLimited(res, maxBytes);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new Error('Provider 返回了无效 JSON'); }
}
