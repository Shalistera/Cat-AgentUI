// Minimal SSE parser over a fetch Response body.
export interface SseMessage { event: string | null; data: string }

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
