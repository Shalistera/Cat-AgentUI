import { getSetting, setSetting } from './db/index.js';

const key = (modelId: string) => `chat_busy_fallback:${modelId}`;
export function configuredModelFallback(modelId: string): string | null {
  const value = getSetting<unknown>(key(modelId), null);
  return typeof value === 'string' && value && value !== modelId ? value : null;
}
export function setModelFallback(modelId: string, fallbackId: string | null) {
  setSetting(key(modelId), fallbackId);
}
