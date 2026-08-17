import { config } from './config.js';

export interface AdmissionLease { release(): void }

function once(fn: () => void): AdmissionLease {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      fn();
    },
  };
}

let activeChatsGlobal = 0;
const activeChatsByUser = new Map<string, number>();
const activeChatIds = new Set<string>();

export function tryAcquireChatTurn(userId: string, chatId: string): AdmissionLease | null {
  const userActive = activeChatsByUser.get(userId) ?? 0;
  if (userActive >= config.maxChatConcurrencyPerUser
    || activeChatsGlobal >= config.maxChatConcurrencyGlobal
    || activeChatIds.has(chatId)) return null;
  activeChatsGlobal++;
  activeChatsByUser.set(userId, userActive + 1);
  activeChatIds.add(chatId);
  return once(() => {
    activeChatsGlobal = Math.max(0, activeChatsGlobal - 1);
    activeChatIds.delete(chatId);
    const next = Math.max(0, (activeChatsByUser.get(userId) ?? 1) - 1);
    if (next) activeChatsByUser.set(userId, next);
    else activeChatsByUser.delete(userId);
  });
}

let activeImagesGlobal = 0;
const activeImagesByUser = new Map<string, number>();
// One job per (user, model): a user can drive several different image models
// at once, but the same model queues behind itself.
const activeImageModels = new Set<string>();

export type ImageJobAdmission =
  | { ok: true; lease: AdmissionLease }
  | { ok: false; reason: 'model-busy' | 'limit' };

export function tryAcquireImageJob(userId: string, modelId: string): ImageJobAdmission {
  const key = `${userId}:${modelId}`;
  if (activeImageModels.has(key)) return { ok: false, reason: 'model-busy' };
  const userActive = activeImagesByUser.get(userId) ?? 0;
  if (userActive >= config.maxImageConcurrencyPerUser
    || activeImagesGlobal >= config.maxImageConcurrencyGlobal) return { ok: false, reason: 'limit' };
  activeImagesGlobal++;
  activeImagesByUser.set(userId, userActive + 1);
  activeImageModels.add(key);
  return {
    ok: true,
    lease: once(() => {
      activeImagesGlobal = Math.max(0, activeImagesGlobal - 1);
      activeImageModels.delete(key);
      const next = Math.max(0, (activeImagesByUser.get(userId) ?? 1) - 1);
      if (next) activeImagesByUser.set(userId, next);
      else activeImagesByUser.delete(userId);
    }),
  };
}

let activeContextImageBytesGlobal = 0;
const activeContextImageBytesByUser = new Map<string, number>();

/** Reserve raw media bytes before they expand to base64 in live contexts. */
export function tryReserveContextImageBytes(userId: string, bytes: number): AdmissionLease | null {
  if (bytes <= 0) return once(() => {});
  const userBytes = activeContextImageBytesByUser.get(userId) ?? 0;
  if (userBytes + bytes > config.maxContextImageBytesPerUser
    || activeContextImageBytesGlobal + bytes > config.maxContextImageBytesGlobal) return null;
  activeContextImageBytesGlobal += bytes;
  activeContextImageBytesByUser.set(userId, userBytes + bytes);
  return once(() => {
    activeContextImageBytesGlobal = Math.max(0, activeContextImageBytesGlobal - bytes);
    const next = Math.max(0, (activeContextImageBytesByUser.get(userId) ?? bytes) - bytes);
    if (next) activeContextImageBytesByUser.set(userId, next);
    else activeContextImageBytesByUser.delete(userId);
  });
}
