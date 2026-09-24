// Backup lines for a provider. A provider is one vendor type and one model
// roster; behind it can sit several gateways that all serve those models
// (OpenRouter, a LiteLLM proxy, the vendor itself). Requests always go to the
// first healthy line in priority order — never spread across lines — so
// prompt caches keep hitting the same host. A line only loses a request when
// it fails before producing any output, and only loses its turn after a run
// of such failures (a circuit breaker with a timed, single-probe reopen).
import type {
  AdapterEvent, BusyCounter, ChatAdapter, ChatRequest, ImageGenRequest, ImageGenResult, ProviderRuntimeConfig,
} from '../types.js';
import { BUSY_STATUSES, ProviderHttpError, isNetworkError } from './sse.js';

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

// Lines that answered "no such model", per model (`<line key>|<model>` →
// until when). Such a line is skipped for that model so every request does
// not pay the round trip — and show a switch notice — to learn it again:
// a Vertex multi-region endpoint may lack a preview model the global one has.
const missingModels = new Map<string, number>();
const MISSING_MODEL_TTL_MS = 60 * 60_000;

function isMissing(key: string, model: string, now: number): boolean {
  const until = missingModels.get(`${key}|${model}`);
  if (until === undefined) return false;
  if (until > now) return true;
  missingModels.delete(`${key}|${model}`);
  return false;
}

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
  if (key === undefined) {
    health.clear();
    missingModels.clear();
    return;
  }
  health.delete(key);
  for (const k of missingModels.keys()) if (k.startsWith(`${key}|`)) missingModels.delete(k);
}

export type LineState = 'ok' | 'degraded' | 'open' | 'probing';

export function lineStatus(key: string): LineHealth & { state: LineState; missingModels: string[] } {
  const h = lineHealth(key);
  const now = Date.now();
  const missing: string[] = [];
  for (const k of [...missingModels.keys()]) {
    if (!k.startsWith(`${key}|`)) continue;
    const model = k.slice(key.length + 1);
    if (isMissing(key, model, now)) missing.push(model);
  }
  let state: LineState = 'ok';
  if (h.probing) state = 'probing';
  else if (h.openUntil > now) state = 'open';
  else if (h.failures > 0) state = 'degraded';
  return { ...h, state, missingModels: missing };
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
    if (classifyFailure(err) === 'model') return `该线路没有此模型 (HTTP ${err.status})`;
    if (BUSY_STATUSES.has(err.status)) return `${err.status === 429 ? '限流' : '过载'} HTTP ${err.status}`;
    return `HTTP ${err.status}`;
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

/** The lines to attempt, in priority order, skipping open breakers and lines
 * that don't serve this model (by configuration, or because they recently
 * said so). A line whose cooldown has elapsed is admitted once as a probe.
 * If every line is open, all are returned anyway — attempting beats failing
 * flat. */
function plan(cfg: ProviderRuntimeConfig, model: string): { line: ProviderRuntimeConfig; probe: boolean }[] {
  const now = Date.now();
  const serving = [cfg, ...(cfg.fallbacks ?? [])].filter((line) => !line.servesModel || line.servesModel(model));
  const known = serving.filter((line) => !isMissing(lineKey(line), model, now));
  const all = known.length ? known : serving;
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
  const order = plan(cfg, req.model);
  // The last failure that said something about capacity or reachability: if
  // the lines after it merely lack the model, that is the error worth showing.
  let lineErr: unknown = null;
  // Standard lines share one tally of busy rejections; once it fills up the
  // request skips ahead to the Priority PayGo retry instead of waiting out
  // every remaining location.
  const escalation = order.findIndex((o) => o.line.escalateAfterBusy);
  const counter: BusyCounter | undefined = escalation > 0
    ? { busy: 0, limit: order[escalation].line.escalateAfterBusy! } : undefined;
  for (let i = 0; i < order.length; i++) {
    const { line, probe } = order[i];
    const key = lineKey(line);
    const h = lineHealth(key);
    if (probe) h.probing = true;
    if (line !== cfg) h.tookOver++; // answered instead of the provider's own line
    let produced = false;
    const first = () => { if (!produced) { produced = true; markSuccess(key); } };
    // Its busy-retry cap exists to hand over to the next line. When open
    // breakers or model-specific lines leave nothing after it, the last line
    // tried waits as long as a lone line would.
    let target = line;
    if (i === order.length - 1 && line.retryBudgetMs !== undefined) target = { ...target, retryBudgetMs: undefined };
    if (counter && i < escalation) target = { ...target, busyCounter: counter };
    try {
      yield* attempt(target, rewriteModel(line, req.model), first);
      first(); // an empty-but-OK answer still counts as the line working
      return;
    } catch (err) {
      const kind = produced || req.signal.aborted ? 'request' : classifyFailure(err);
      if (kind === 'request') {
        if (probe) h.probing = false;
        throw err;
      }
      if (kind === 'line') {
        markFailure(key, err, threshold, cooldownMs);
        lineErr = err;
      } else {
        if (probe) h.probing = false; // the line answered; the probe is settled either way
        missingModels.set(`${key}|${req.model}`, Date.now() + MISSING_MODEL_TTL_MS);
      }
      const skip = kind === 'line' && !!counter && i < escalation - 1 && counter.busy >= counter.limit;
      const nextIndex = skip ? escalation : i + 1;
      const next = order[nextIndex];
      const from = line.endpointName ?? '主线路';
      console.warn(`[failover] provider ${cfg.id} line "${from}" failed (${describe(err)}), `
        + (kind === 'model' ? 'model unknown on this line (not counted)'
          : `${h.failures}/${threshold} consecutive${h.openUntil > Date.now() ? ', breaker open' : ''}`)
        + (next ? `; trying "${next.line.endpointName ?? '主线路'}"` : '; no line left'));
      if (!next) throw kind === 'model' && lineErr ? lineErr : err;
      req.onFailover?.({
        from, to: next.line.endpointName ?? '主线路', reason: describe(err),
        ...(nextIndex === escalation ? { priority: true } : {}),
      });
      i = nextIndex - 1;
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
