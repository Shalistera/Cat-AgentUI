// Minimal SSE parser over a fetch Response body.
export interface SseMessage { event: string | null; data: string }

// Retrying a POST is only safe when the request PROVABLY never reached the
// upstream — otherwise a duplicate could double-bill a completion. Two classes
// qualify:
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

export async function fetchRetry(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted || !isPreSendError(err)) throw err;
    await new Promise((r) => setTimeout(r, 300));
    if (init.signal?.aborted) throw err;
    return fetch(url, init);
  }
}

const MAX_SSE_BUFFER_CHARS = 2 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 2 * 1024 * 1024;

export async function* sseMessages(res: Response): AsyncGenerator<SseMessage> {
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
      if (done) break;
      buf += decoder.decode(value, { stream: true });
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
  503: '服务暂时不可用,请过一会再试',
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
  if (gateway) return new Error(`${name}: ${gateway} (${res.status})`);
  if (res.status === 429) return new Error(`${name}: 上游服务暂时繁忙,请稍等片刻后重试 (429)`);
  if (looksLikeHtml(body) || !body.trim()) return new Error(`${name}: 上游返回了错误 (${res.status}),请稍后再试`);
  return new Error(`${name} ${res.status}: ${body}`);
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
