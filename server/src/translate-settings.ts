import { z } from 'zod';
import { getSetting } from './db/index.js';
import type { schema } from './db/index.js';
import { effectiveLevels, OFF } from './reasoning.js';
import type { ProviderType, ReasoningRequest } from './types.js';

export const TRANSLATE_FAST_KEY = 'translate_fast_models';
export const TRANSLATE_THINK_KEY = 'translate_think_models';
export const TRANSLATE_CHAIN_MAX = 6;

export const translateModelSchema = z.object({
  modelId: z.string().min(1).max(64),
  mode: z.enum(['fast', 'think']),
  // null preserves the user's three-rung intensity selection.
  reasoningEffort: z.string().min(1).max(64).nullable().default(null),
});
export type TranslateModel = z.infer<typeof translateModelSchema>;

/** Read legacy ID-only chains without changing their behavior or order. */
export function readTranslateChain(key: string): TranslateModel[] {
  const saved = getSetting<unknown>(key, []);
  if (!Array.isArray(saved)) return [];
  const mode = key === TRANSLATE_FAST_KEY ? 'fast' : 'think';
  const entries: TranslateModel[] = [];
  const seen = new Set<string>();
  for (const item of saved) {
    const parsed = translateModelSchema.safeParse(typeof item === 'string'
      ? { modelId: item, mode, reasoningEffort: null } : item);
    if (!parsed.success || seen.has(parsed.data.modelId)) continue;
    seen.add(parsed.data.modelId);
    entries.push(parsed.data);
    if (entries.length === TRANSLATE_CHAIN_MAX) break;
  }
  return entries;
}

/** Each fallback uses its own mode and native effort, never the previous model's. */
export function translateReasoning(
  entry: TranslateModel, userLevel: number,
  model: Pick<typeof schema.models.$inferSelect, 'reasoningMode' | 'reasoningLevels' | 'modelId'>,
  type: ProviderType,
): ReasoningRequest | undefined {
  const levels = effectiveLevels(model.reasoningMode, model.reasoningLevels, type, model.modelId);
  if (!levels.length) return undefined;
  if (entry.mode === 'fast') return { level: OFF, ratio: 0 };
  const savedIndex = levels.findIndex((l) => l.value === entry.reasoningEffort);
  // A removed tier falls back to the user's intensity, never an invalid API value.
  const idx = savedIndex >= 0 ? savedIndex : Math.round((levels.length - 1) * (userLevel - 1) / 2);
  return { level: levels[idx].value, ratio: levels.length > 1 ? idx / (levels.length - 1) : 1 };
}
