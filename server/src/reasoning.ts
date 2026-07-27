/**
 * Reasoning ladders.
 *
 * A model exposes an ordered list of effort levels, weakest first. Each level
 * has a `value` — what goes on the wire, in the vendor's own vocabulary — and a
 * `label`, which is what the user actually reads. Those are separate on purpose:
 * `xhigh` is an API token, not a word anybody should have to interpret in a
 * chat composer.
 *
 * Where the list comes from is the model's `reasoningMode`:
 *   auto   — derived here from the model id, using each vendor's common tiers.
 *   custom — exactly what the admin typed, values and labels both.
 *   off    — the model has no reasoning mode; the control is hidden.
 *
 * `auto` is the default, so a freshly added model is useful immediately, and
 * `custom` is there for the week a vendor ships a tier we have never heard of.
 */

import type { ProviderType } from './types.js';

export interface ReasoningLevel {
  /** Sent to the provider. OpenAI passes it through as `reasoning_effort`. */
  value: string;
  /** Shown to the user. */
  label: string;
}

export type ReasoningMode = 'auto' | 'custom' | 'off';

/** Our own sentinel for "don't think", never a vendor value — adapters omit the field. */
export const OFF = 'off';

export const MAX_LEVELS = 12;

/** Names the three vendors actually use, in Chinese. Unknown names show as-is. */
const BUILTIN_LABELS: Record<string, string> = {
  off: '关闭',
  none: '不推理',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  auto: '自动',
  dynamic: '动态',
};

export function labelFor(value: string): string {
  return BUILTIN_LABELS[value.toLowerCase()] ?? value;
}

function ladder(...values: string[]): ReasoningLevel[] {
  return values.map((v) => ({ value: v, label: labelFor(v) }));
}

/**
 * First match wins, so a narrower rule goes above a broader one. An empty
 * ladder is a real answer: it says the model has no reasoning mode.
 *
 * Only OpenAI puts the level name on the wire, so those values have to be real
 * `reasoning_effort` tokens. Anthropic and Gemini budget in thinking tokens and
 * read only the position on the ladder, so their names are ours to choose.
 */
const RULES: Record<ProviderType, { re: RegExp; levels: ReasoningLevel[] }[]> = {
  openai: [
    // gpt-5-chat is the non-reasoning sibling of the family below it.
    { re: /^gpt-5[\d.]*-chat/, levels: [] },
    { re: /^(o[1-9]|gpt-[5-9])/, levels: ladder('minimal', 'low', 'medium', 'high') },
  ],
  anthropic: [
    { re: /^claude-(3-7|[4-9]|opus-[4-9]|sonnet-[4-9]|haiku-[4-9])/, levels: ladder('low', 'medium', 'high') },
  ],
  gemini: [
    { re: /^gemini-(2\.5|[3-9])/, levels: ladder('low', 'medium', 'high') },
  ],
};

/**
 * The common tiers for a model, or an empty ladder if we don't recognise it.
 * Deliberately conservative: a model we guess wrong about costs the admin one
 * trip to the console, and guessing *low* only ever hides a control.
 */
export function defaultLevels(type: ProviderType, modelId: string): ReasoningLevel[] {
  // Gateways prefix the vendor (`openai/gpt-5`, `google/gemini-3-pro`); match the
  // model itself, and ignore any trailing date or region suffix by not anchoring.
  const id = (modelId.split('/').pop() ?? '').trim().toLowerCase();
  for (const rule of RULES[type] ?? []) {
    if (rule.re.test(id)) return rule.levels.map((l) => ({ ...l }));
  }
  return [];
}

type LevelInput = string | { value?: unknown; label?: unknown };

/**
 * Read a stored/submitted ladder. Tolerant on purpose: it parses the bare
 * `string[]` written before levels carried labels, and it drops anything
 * unusable rather than failing the request that carries it.
 */
export function normalizeLevels(input: unknown): ReasoningLevel[] {
  if (!Array.isArray(input)) return [];
  const out: ReasoningLevel[] = [];
  const seen = new Set<string>();
  for (const item of input as LevelInput[]) {
    const rawValue = typeof item === 'string' ? item : item?.value;
    if (typeof rawValue !== 'string') continue;
    const value = rawValue.trim();
    const key = value.toLowerCase();
    // `off` is prepended by the client as its own stop; a second one would sit
    // twice on the same slider.
    if (!value || key === OFF || seen.has(key)) continue;
    seen.add(key);
    const rawLabel = typeof item === 'string' ? undefined : item?.label;
    const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : labelFor(value);
    out.push({ value, label });
    if (out.length >= MAX_LEVELS) break;
  }
  return out;
}

export function parseLevels(raw: string | null | undefined): ReasoningLevel[] {
  try {
    return normalizeLevels(JSON.parse(raw || '[]'));
  } catch { return []; }
}

export function parseMode(raw: string | null | undefined): ReasoningMode {
  return raw === 'custom' || raw === 'off' ? raw : 'auto';
}

/** The ladder a model actually offers right now. */
export function effectiveLevels(
  mode: string | null | undefined,
  levelsJson: string | null | undefined,
  type: ProviderType,
  modelId: string,
): ReasoningLevel[] {
  const m = parseMode(mode);
  if (m === 'off') return [];
  if (m === 'custom') return parseLevels(levelsJson);
  return defaultLevels(type, modelId);
}
