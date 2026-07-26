// Minimal SSE parser over a fetch Response body.
export interface SseMessage { event: string | null; data: string }

export async function* sseMessages(res: Response): AsyncGenerator<SseMessage> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = null; data = [];
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
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
  try { text = await res.text(); } catch { /* ignore */ }
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message ?? j?.message ?? j?.error ?? text;
    text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch { /* keep raw */ }
  return text.slice(0, 500);
}
