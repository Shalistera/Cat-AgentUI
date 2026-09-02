// 工具调用确认 — the pause between "the model wants to call X" and actually
// calling it. The streaming turn parks here after sending a `tool_confirm`
// event; the client answers through POST /api/chats/:id/tool-decision, which
// resolves the wait. One pending question per assistant message at a time.
//
// Nothing is persisted: if the tab goes away the stream aborts and the wait is
// cancelled through its signal; a decision that arrives for an unknown message
// is simply rejected.

export type ToolDecision = 'allow' | 'deny';

interface Pending {
  userId: string;
  callIds: Set<string>;
  resolve(decisions: Map<string, ToolDecision>): void;
}

const pending = new Map<string, Pending>();

/** How long a turn will sit waiting for a person before treating every call as denied. */
export const TOOL_CONFIRM_TIMEOUT_MS = 10 * 60_000;

/**
 * Wait for the user's verdict on a batch of tool calls. Resolves with one
 * decision per call id; anything unanswered (timeout, abort) counts as 'deny'.
 */
export function waitForToolDecision(
  messageId: string, userId: string, callIds: string[], signal: AbortSignal,
): Promise<Map<string, ToolDecision>> {
  return new Promise((resolve) => {
    const ids = new Set(callIds);
    let done = false;
    const finish = (decisions: Map<string, ToolDecision>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (pending.get(messageId)?.resolve === finish) pending.delete(messageId);
      const full = new Map<string, ToolDecision>();
      for (const id of ids) full.set(id, decisions.get(id) ?? 'deny');
      resolve(full);
    };
    const onAbort = () => finish(new Map());
    const timer = setTimeout(() => finish(new Map()), TOOL_CONFIRM_TIMEOUT_MS);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.set(messageId, { userId, callIds: ids, resolve: finish });
  });
}

/**
 * Deliver a decision from the HTTP side. Returns false when nothing is waiting
 * for this message (already answered, timed out, or never asked) or when the
 * caller is not the person the question was addressed to.
 */
export function submitToolDecision(
  messageId: string, userId: string, decisions: Record<string, ToolDecision>,
): boolean {
  const p = pending.get(messageId);
  if (!p || p.userId !== userId) return false;
  const map = new Map<string, ToolDecision>();
  for (const [id, d] of Object.entries(decisions)) {
    if (p.callIds.has(id) && (d === 'allow' || d === 'deny')) map.set(id, d);
  }
  p.resolve(map);
  return true;
}

/** Is a turn currently waiting on this user for this message? */
export function hasPendingToolDecision(messageId: string, userId: string): boolean {
  const p = pending.get(messageId);
  return !!p && p.userId === userId;
}
