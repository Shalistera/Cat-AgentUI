import { db, schema, now, today } from './db/index.js';
import { newId } from './crypto.js';

export interface UsageRecord {
  userId: string;
  chatId?: string;
  messageId?: string;
  providerId?: string;
  providerType?: string;
  model?: string;
  kind: 'chat' | 'image' | 'title' | 'ppt';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  images?: number;
  durationMs?: number;
}

export function recordUsage(r: UsageRecord) {
  const total = r.totalTokens ?? ((r.promptTokens ?? 0) + (r.completionTokens ?? 0));
  db.insert(schema.usageLog).values({
    id: newId(),
    userId: r.userId,
    chatId: r.chatId ?? null,
    messageId: r.messageId ?? null,
    providerId: r.providerId ?? null,
    providerType: r.providerType ?? null,
    model: r.model ?? null,
    kind: r.kind,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    totalTokens: total,
    images: r.images ?? 0,
    durationMs: r.durationMs ?? 0,
    day: today(),
    createdAt: now(),
  }).run();
}
