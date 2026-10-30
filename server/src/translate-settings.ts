import { z } from 'zod';
import { getSetting } from './db/index.js';
import type { schema } from './db/index.js';
import { effectiveLevels, OFF } from './reasoning.js';
import type { ProviderType, ReasoningRequest } from './types.js';

export const TRANSLATE_DEFAULT_KEY = 'translate_default_models';
export const TRANSLATE_FAST_KEY = 'translate_fast_models';
export const TRANSLATE_THINK_KEY = 'translate_think_models';
export const TRANSLATE_CHAIN_MAX = 6;

export const translateModelSchema = z.object({
  modelId: z.string().min(1).max(64),
  mode: z.enum(['fast', 'think']),
  // In default mode, null uses the middle of the model's reasoning ladder.
  reasoningEffort: z.string().min(1).max(64).nullable().default(null),
});
export type TranslateModel = z.infer<typeof translateModelSchema>;
export type TranslateMode = 'default' | 'fast' | 'think';

/** Read legacy ID-only chains without changing their behavior or order. */
export function readTranslateChain(key: string): TranslateModel[] {
  const saved = getSetting<unknown>(key, null);
  // Before a default chain is saved, carry the existing preferred chain and
  // its presets forward. An explicitly empty default chain stays disabled.
  if (key === TRANSLATE_DEFAULT_KEY && saved === null) {
    const fast = readTranslateChain(TRANSLATE_FAST_KEY);
    return fast.length ? fast : readTranslateChain(TRANSLATE_THINK_KEY);
  }
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

// A/B 对比: with probability rate% a translation runs on two fixed models
// side by side and the person picks the better one. Each slot carries the
// same preset as a default-chain entry, so translateReasoning() treats it
// exactly like one.
export const TRANSLATE_AB_KEY = 'translate_ab';
export const translateAbSchema = z.object({
  enabled: z.boolean(),
  rate: z.number().int().min(1).max(100), // percent of translations
  a: translateModelSchema.nullable(),
  b: translateModelSchema.nullable(),
});
export type TranslateAb = z.infer<typeof translateAbSchema>;

export function readTranslateAb(): TranslateAb {
  const parsed = translateAbSchema.safeParse(getSetting<unknown>(TRANSLATE_AB_KEY, null));
  return parsed.success ? parsed.data : { enabled: false, rate: 20, a: null, b: null };
}

/** Only 'default' consults admin presets. Explicit user choices always win. */
export function translateReasoning(
  entry: TranslateModel, mode: TranslateMode, userLevel: number,
  model: Pick<typeof schema.models.$inferSelect, 'reasoningMode' | 'reasoningLevels' | 'modelId'>,
  type: ProviderType,
): ReasoningRequest | undefined {
  const levels = effectiveLevels(model.reasoningMode, model.reasoningLevels, type, model.modelId);
  if (!levels.length) return undefined;
  if ((mode === 'default' ? entry.mode : mode) === 'fast') return { level: OFF, ratio: 0 };
  const savedIndex = mode === 'default' ? levels.findIndex((l) => l.value === entry.reasoningEffort) : -1;
  // Default mode ignores the user's previously selected intensity. Removed
  // native tiers safely fall back to the middle; explicit think uses userLevel.
  const level = mode === 'default' ? 2 : userLevel;
  const idx = savedIndex >= 0 ? savedIndex : Math.round((levels.length - 1) * (level - 1) / 2);
  return { level: levels[idx].value, ratio: levels.length > 1 ? idx / (levels.length - 1) : 1 };
}
