// Backup lines for a provider. A provider is one vendor type and one model
// roster; behind it can sit several gateways that all serve those models
// (OpenRouter, a LiteLLM proxy, the vendor itself). Requests always go to the
// first healthy line in priority order — never spread across lines — so
// prompt caches keep hitting the same host. A line only loses a request when
// it fails before producing any output, and only loses its turn after a run
// of such failures (a circuit breaker with a timed, single-probe reopen).
import type {
  AdapterEvent, ChatAdapter, ChatRequest, ImageGenRequest, ImageGenResult, ProviderRuntimeConfig,
} from '../types.js';
import { ProviderHttpError, isNetworkError } from './sse.js';

export interface LineHealth {
  /** Consecutive fallback-worthy failures; cleared by the next success. */
  failures: number;
  /** Until when the line is skipped; 0 = closed (healthy). */
  openUntil: number;
  /** A half-open probe is in flight; other callers keep skipping the line. */
  probing: boolean;
  lastError: string | null;
  lastFailureAt: number | null;
  /** Requests this line answered (first byte received) since start. */
  served: number;
  /** Requests this line took over after an earlier line failed. */
  tookOver: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

const health = new Map<string, LineHealth>();

function lineKey(line: ProviderRuntimeConfig): string {
  return line.endpointId ?? `${line.id}:primary`;
}

export function lineHealth(key: string): LineHealth {
  let h = health.get(key);
  if (!h) {
    h = { failures: 0, openUntil: 0, probing: false, lastError: null, lastFailureAt: null, served: 0, tookOver: 0 };
    health.set(key, h);
  }
  return h;
}

/** Forget one line's state, or everything (tests, admin "重置"). */
export function resetLineHealth(key?: string) {
  if (key === undefined) health.clear();
  else health.delete(key);
}

export type LineState = 'ok' | 'degraded' | 'open' | 'probing';

export function lineStatus(key: string): LineHealth & { state: LineState } {
  const h = lineHealth(key);
  const now = Date.now();
  let state: LineState = 'ok';
  if (h.probing) state = 'probing';
  else if (h.openUntil > now) state = 'open';
  else if (h.failures > 0) state = 'degraded';
  return { ...h, state };
}

/** How gateways phrase "I don't serve that model": OpenRouter "unknown
 * provider for model x" (400), LiteLLM "Invalid model name passed in" (400),
 * OpenAI "The model `x` does not exist" (404), Gemini "models/x is not found"
 * (404), Anthropic not_found_error "model: x" (404). */
const UNKNOWN_MODEL_RE = /model/i;
const UNKNOWN_MODEL_HINT_RE = /unknown|not found|does not exist|doesn't exist|invalid|not supported|unsupported|no such|not available|unavailable|not_found/i;

export type FailureKind =
  /** The line is unreachable or refusing us: switch lines, count it. */
  | 'line'
  /** This line does not carry the model: switch lines, but it says nothing
   * about the line's health, so do not count it. */
  | 'model'
  /** The request itself is bad: no other line would do better. */
  | 'request';

export function classifyFailure(err: unknown): FailureKind {
  if (isNetworkError(err)) return 'line';
  if (err instanceof ProviderHttpError) {
    const s = err.status;
    // 429/503/529 arrive here only after the retry budget ran out.
    if (s >= 500 || s === 401 || s === 403 || s === 408 || s === 429) return 'line';
    if (s === 404) return 'model';
    if (s === 400 && UNKNOWN_MODEL_RE.test(err.message) && UNKNOWN_MODEL_HINT_RE.test(err.message)) return 'model';
  }
  return 'request';
}

/** Failures that justify trying another line. */
export function isFallbackWorthy(err: unknown): boolean {
  return classifyFailure(err) !== 'request';
}

function describe(err: unknown): string {
  if (err instanceof ProviderHttpError) {
    return classifyFailure(err) === 'model' ? `该线路没有此模型 (HTTP ${err.status})` : `HTTP ${err.status}`;
  }
  if (isNetworkError(err)) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `网络错误 ${cause.code}` : '网络错误';
  }
  return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
}

function markSuccess(key: string) {
  const h = lineHealth(key);
  h.failures = 0; h.openUntil = 0; h.probing = false; h.lastError = null;
  h.served++;
}

function markFailure(key: string, err: unknown, threshold: number, cooldownMs: number) {
  const h = lineHealth(key);
  h.failures++;
  h.lastError = describe(err);
  h.lastFailureAt = Date.now();
  // A failed probe reopens for a full cooldown; a closed breaker opens once
  // the run of failures reaches the threshold.
  if (h.probing || h.failures >= threshold) h.openUntil = Date.now() + cooldownMs;
  h.probing = false;
}

/** The lines to attempt, in priority order, skipping open breakers. A line
 * whose cooldown has elapsed is admitted once as a probe. If every line is
 * open, all are returned anyway — attempting beats failing flat. */
function plan(cfg: ProviderRuntimeConfig): { line: ProviderRuntimeConfig; probe: boolean }[] {
  const all = [cfg, ...(cfg.fallbacks ?? [])];
  const now = Date.now();
  const ready: { line: ProviderRuntimeConfig; probe: boolean }[] = [];
  for (const line of all) {
    const h = lineHealth(lineKey(line));
    if (h.probing) continue;
    if (h.openUntil > now) continue;
    ready.push({ line, probe: h.openUntil > 0 });
  }
  return ready.length ? ready : all.map((line) => ({ line, probe: false }));
}

export function rewriteModel(line: ProviderRuntimeConfig, model: string): string {
  let m = model;
  const strip = line.stripModelPrefix ?? '';
  if (strip && m.startsWith(strip)) m = m.slice(strip.length);
  return `${line.addModelPrefix ?? ''}${m}`;
}

type Common = Pick<ChatRequest, 'signal' | 'onFailover'> & { model: string };

/** Drive `attempt` across the planned lines. `attempt` must call `first()`
 * as soon as the line has produced output — from that point on a failure
 * belongs to this request, not to the line, and is thrown as-is. */
async function* runLines<T>(
  cfg: ProviderRuntimeConfig, req: Common,
  attempt: (line: ProviderRuntimeConfig, model: string, first: () => void) => AsyncGenerator<T>,
): AsyncGenerator<T> {
  // Nothing to fall back to: behave exactly like the bare adapter.
  if (!cfg.fallbacks?.length) {
    yield* attempt(cfg, rewriteModel(cfg, req.model), () => {});
    return;
  }
  const threshold = cfg.failoverThreshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = cfg.failoverCooldownMs ?? DEFAULT_COOLDOWN_MS;
  const order = plan(cfg);
  for (let i = 0; i < order.length; i++) {
    const { line, probe } = order[i];
    const key = lineKey(line);
    const h = lineHealth(key);
    if (probe) h.probing = true;
    if (line !== cfg) h.tookOver++; // answered instead of the provider's own line
    let produced = false;
    const first = () => { if (!produced) { produced = true; markSuccess(key); } };
    try {
      yield* attempt(line, rewriteModel(line, req.model), first);
      first(); // an empty-but-OK answer still counts as the line working
      return;
    } catch (err) {
      const kind = produced || req.signal.aborted ? 'request' : classifyFailure(err);
      if (kind === 'request') {
        if (probe) h.probing = false;
        throw err;
      }
      if (kind === 'line') markFailure(key, err, threshold, cooldownMs);
      else if (probe) h.probing = false; // the line answered; the probe is settled either way
      const next = order[i + 1];
      const from = line.endpointName ?? '主线路';
      console.warn(`[failover] provider ${cfg.id} line "${from}" failed (${describe(err)}), `
        + (kind === 'model' ? 'model unknown on this line (not counted)'
          : `${h.failures}/${threshold} consecutive${h.openUntil > Date.now() ? ', breaker open' : ''}`)
        + (next ? `; trying "${next.line.endpointName ?? '主线路'}"` : '; no line left'));
      if (!next) throw err;
      req.onFailover?.({ from, to: next.line.endpointName ?? '主线路', reason: describe(err) });
    }
  }
}

/** Wrap a vendor adapter so every call walks the provider's lines. Listing
 * models deliberately does not fail over — the admin testing a line wants to
 * know whether that line works. */
export function withFailover(raw: ChatAdapter): ChatAdapter {
  const wrapped: ChatAdapter = {
    streamChat(cfg, req): AsyncGenerator<AdapterEvent> {
      return runLines(cfg, req, async function* (line, model, first) {
        for await (const ev of raw.streamChat(line, { ...req, model })) {
          first();
          yield ev;
        }
      });
    },
    listModels: (cfg) => raw.listModels(cfg),
  };
  if (raw.generateImages) {
    const gen = raw.generateImages.bind(raw);
    wrapped.generateImages = async (cfg, req: ImageGenRequest): Promise<ImageGenResult> => {
      let out: ImageGenResult | undefined;
      // A single-shot call: nothing is "produced" until the whole answer is in.
      for await (const r of runLines(cfg, req, async function* (line, model, first) {
        const result = await gen(line, { ...req, model });
        first();
        yield result;
      })) out = r;
      return out!;
    };
  }
  return wrapped;
}
