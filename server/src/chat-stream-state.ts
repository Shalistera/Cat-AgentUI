import type { MessagePart, ProviderRetry } from './types.js';

export interface ChatStreamState {
  requestId: string;
  messageId: string | null;
  userMessageId: string | null;
  controller: AbortController;
  parts: MessagePart[];
  retry: ProviderRetry | null;
  retrySince?: number;
  priority: boolean;
  toolConfirm: { messageId: string; calls: { id: string; name: string; args: string }[] } | null;
}

const active = new Map<string, ChatStreamState>();
// Small receipts let a browser that missed even 'meta' find its saved reply.
// Keep only identifiers here; completed content remains in SQLite.
const receipts = new Map<string, { messageId: string; userMessageId: string | null }>();
const key = (chatId: string, requestId: string) => `${chatId}:${requestId}`;

export function activeChatStream(chatId: string) { return active.get(chatId); }
export function chatStreamReceipt(chatId: string, requestId: string) { return receipts.get(key(chatId, requestId)); }
export function beginChatStream(chatId: string, requestId: string): ChatStreamState {
  const state: ChatStreamState = {
    requestId, messageId: null, userMessageId: null, controller: new AbortController(),
    parts: [], retry: null, priority: false, toolConfirm: null,
  };
  active.set(chatId, state);
  return state;
}
export function identifyChatStream(chatId: string, state: ChatStreamState, messageId: string, userMessageId: string | null) {
  state.messageId = messageId;
  state.userMessageId = userMessageId;
  receipts.set(key(chatId, state.requestId), { messageId, userMessageId });
  while (receipts.size > 1024) receipts.delete(receipts.keys().next().value!);
}
export function endChatStream(chatId: string, state: ChatStreamState) {
  // Old title/follow-up cleanup must never remove the next active turn.
  if (active.get(chatId) === state) {
    active.delete(chatId);
    if (state.messageId) {
      receipts.delete(key(chatId, state.requestId));
      identifyChatStream(chatId, state, state.messageId, state.userMessageId);
    }
  }
}
