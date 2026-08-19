import { useModels } from './store';

// A single long-lived /api/events stream per signed-in session. The server
// sends bare invalidation events (no payload); we answer by refetching the
// matching shared cache, which is what makes admin edits show up in every
// open tab without an F5.
//
// EventSource cannot send the x-csrf header, so this reuses the same
// fetch-and-parse approach as streamChat.

let ctrl: AbortController | null = null;

export function startRealtime(): void {
  if (ctrl) return;
  const c = new AbortController();
  ctrl = c;
  void loop(c);
}

export function stopRealtime(): void {
  ctrl?.abort();
  ctrl = null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dispatch(event: string) {
  if (event === 'models-updated') {
    const s = useModels.getState();
    // Not loaded yet = nothing stale; the first consumer will fetch fresh.
    if (s.loaded) void s.load(true).catch(() => { /* next event retries */ });
  }
}

async function loop(c: AbortController) {
  let retry = 1000;
  while (!c.signal.aborted) {
    try {
      const res = await fetch('/api/events', {
        credentials: 'same-origin',
        headers: { 'x-csrf': '1', accept: 'text/event-stream' },
        signal: c.signal,
      });
      // Session gone — Shell tears us down and restarts after the next login.
      if (res.status === 401) return;
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      retry = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let event = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line === '') {
            if (event) dispatch(event);
            event = '';
          } else if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          }
          // data lines are ignored — invalidation events carry no payload
        }
      }
    } catch { /* network error or server restart — reconnect below */ }
    if (c.signal.aborted) return;
    await sleep(retry);
    retry = Math.min(retry * 2, 30_000);
  }
}
