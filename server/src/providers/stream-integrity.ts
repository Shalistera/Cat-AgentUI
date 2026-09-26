import type { AdapterEvent } from '../types.js';
import { isNetworkError } from './sse.js';

export class ProviderEmptyError extends Error {
  readonly code = 'provider_empty' as const;
  constructor(cause?: unknown) { super('暂时未获得有效回复,自动恢复未成功,可以重试', { cause }); }
}

export class ProviderInterruptedError extends Error {
  constructor(readonly endpointId: string, cause?: unknown) {
    super('回复传输未完成', { cause });
  }
}

/** Reasoning/usage alone is not an answer. Hold speculative content until a
 * body or tool call arrives so an empty attempt can safely change lines.
 * The cap bounds buffering; beyond it preserve output and disable replay. */
export async function* checkStream(
  events: AsyncGenerator<AdapterEvent>, endpointId: string, signal: AbortSignal,
  first: () => void,
): AsyncGenerator<AdapterEvent> {
  const pending: AdapterEvent[] = [];
  let buffered = 0;
  let committed = false;
  let stop: Extract<AdapterEvent, { type: 'stop' }> | undefined;
  try {
    for await (const ev of events) {
      if (ev.type === 'usage') { yield ev; continue; } // all attempts are accounted for
      if (ev.type === 'stop') { stop = ev; continue; }
      if (!committed) {
        pending.push(ev);
        buffered += JSON.stringify(ev).length;
        if (!(ev.type === 'text' && ev.text.trim()) && ev.type !== 'tool_call'
          && buffered < 1_048_576 && pending.length < 4096) continue;
        committed = true;
        first();
        yield* pending;
        pending.length = 0;
      } else yield ev;
    }
  } catch (err) {
    if (!signal.aborted && isNetworkError(err)) {
      if (!stop || stop.reason === 'other') {
        if (committed) throw new ProviderInterruptedError(endpointId, err);
        throw new ProviderEmptyError(err);
      }
      // A previously received terminal event is authoritative, including a
      // policy refusal or length limit; a later reset must not bypass it.
    } else throw err;
  }
  signal.throwIfAborted();
  if (stop?.reason === 'content_filter' || stop?.reason === 'length') {
    yield* pending;
    yield stop;
    return;
  }
  if (!committed) throw new ProviderEmptyError();
  if (!stop || stop.reason === 'other') throw new ProviderInterruptedError(endpointId);
  yield stop;
}
