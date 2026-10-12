// 追加 — messages the person sends while a reply is still being generated,
// the way Claude Code takes input typed mid-turn. They wait on the live turn
// (chat-stream-state) and reach the model at the next tool round, or right
// after it stops writing, inside the same reply; the reply stores each one
// as an `interjection` part at the point it was delivered.

import type { AdapterMessage } from './types.js';

/** Per reply. Past this the person can still queue an ordinary message. */
export const MAX_INTERJECTIONS = 10;

/** What the model reads for one. The same text on every replay, so a cached
 * prefix that contains it stays valid. */
export function interjectionPrompt(text: string): string {
  return `用户在你工作期间发来了一条新消息:\n${text}\n\n这是面板转达回复进行中所发消息的方式:它插在本轮回复之中(通常跟在工具结果后面),而不是另起一轮对话。请在继续本轮回复的同时回应上面这条消息。`;
}

export function interjectionMessage(text: string): AdapterMessage {
  return { role: 'user', interjection: text, parts: [{ type: 'text', text: interjectionPrompt(text) }] };
}
