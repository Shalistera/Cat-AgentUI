import { ApiError, onUnauthorized } from './api';
import type { ChatStreamState, Message } from './types';

export interface StreamIdentity { requestId?: string; messageId?: string }

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Recover the original generation with GETs only. A missing SSE 'done' is
 * not completion; only the server's persisted terminal state can finish it.
 * Transient connectivity failures keep the loading state and back off. */
export async function recoverChatStream(
  chatId: string, identity: StreamIdentity, onSnapshot: (state: ChatStreamState) => void,
  signal: AbortSignal, intervalMs = 1500,
): Promise<ChatStreamState> {
  const query = new URLSearchParams();
  if (identity.requestId) query.set('requestId', identity.requestId);
  if (identity.messageId) query.set('messageId', identity.messageId);
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      const res = await fetch(`/api/chats/${chatId}/stream-state?${query}`, {
        credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (res.status === 401) onUnauthorized.handler?.();
      if ([401, 403, 404].includes(res.status)) throw new ApiError(res.status, '无法恢复这条回复,请重新打开对话');
      if (!res.ok) throw new Error('生成状态暂时不可用');
      const state = await res.json() as ChatStreamState;
      if (typeof state.active !== 'boolean') throw new Error('无效的生成状态');
      if (!query.has('requestId') && state.activeTurn?.requestId) query.set('requestId', state.activeTurn.requestId);
      if (!query.has('messageId') && state.message?.id) query.set('messageId', state.message.id);
      signal.throwIfAborted();
      onSnapshot(state);
      if (!state.active && state.message?.status !== 'streaming') return state;
      failures = 0;
    } catch (err) {
      if (signal.aborted || err instanceof ApiError) throw err;
      failures++;
    }
    await wait(Math.min(8000, intervalMs * 2 ** Math.min(failures, 3)), signal);
  }
}

/** Replace optimistic ids and live snapshots without appending duplicate
 * text, losing siblings, or replaying a user message after reconnection. */
export function mergeStreamSnapshot(messages: Message[], state: ChatStreamState, placeholders: boolean): Message[] {
  const incoming = [state.userMessage, state.message && {
    ...state.message, recovering: state.active,
  }].filter((m): m is Message => !!m);
  const out = messages.map((m) => {
    const replacement = incoming.find((next) => next.id === m.id
      || (placeholders && m.id === 'tmp-a' && next.role === 'assistant')
      || (placeholders && m.id === 'tmp-u' && next.role === 'user'));
    return replacement ?? m;
  });
  for (const m of incoming) if (!out.some((prev) => prev.id === m.id)) out.push(m);
  return out;
}
