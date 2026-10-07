// Shared domain types — the message "parts" model is the core contract.
// An assistant turn is ONE message whose parts may interleave
// text / reasoning / tool_call / tool_result in stream order.

/** Why the model stopped. 'length' (max output tokens) and 'content_filter'
    (provider safety / refusal) mean the reply is cut short — the chat route
    persists them so the UI can flag "输出可能不完整". 'other' is any
    provider-specific finish the adapter doesn't recognise (Gemini OTHER /
    MALFORMED_FUNCTION_CALL, Anthropic pause_turn, …) or a stream that closed
    without a finish signal at all. */
export type StopReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

/** Stored on the message row: a provider StopReason, or 'incomplete' — set by
    the chat route (never by an adapter) when a 'done' reply has no visible
    body (only reasoning, e.g. Vertex dropping the stream after the thinking
    part) or ended with 'other' / no finish signal. The UI treats it like
    'length': flag the reply and offer 重新生成. */
export type FinishReason = StopReason | 'incomplete';

interface ComparisonBase {
  title: string;
  unit: string;
  source: string;
}
export interface BarComparison extends ComparisonBase {
  /** Absent on older saved charts. */
  chart?: 'bar';
  items: { label: string; value: number }[];
}
export interface LineComparison extends ComparisonBase {
  chart: 'line';
  xLabel: string;
  /** Strictly increasing numeric coordinates; labels only affect display. */
  x: number[];
  xLabels?: string[];
  series: { label: string; values: (number | null)[] }[];
}
export type DataComparison = BarComparison | LineComparison;

export type MessagePart =
  | ({ type: 'data_comparison' } & DataComparison)
  | { type: 'response_recovery'; kind: 'continuation'; state: 'running' | 'done' | 'failed' }
  | { type: 'model_fallback'; sourceMessageId: string; fromModelId: string; fromName: string; toModelId: string; toName: string; adopted: boolean; reason?: 'busy' | 'empty' }
  | { type: 'service_tier'; tier: 'priority' }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  // user attachment (uploadId) or model-generated image (imageId → images table)
  | { type: 'image'; uploadId?: string; imageId?: string; mime?: string; url?: string }
  // non-image attachment. name/mime are denormalized from the uploads row at
  // send time so history renders without an extra fetch per chip.
  | { type: 'file'; uploadId: string; name?: string; mime?: string }
  // sig: opaque per-call signature some vendors (Gemini 3 thought_signature)
  // require to be echoed verbatim when the call is replayed as history.
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string } // args = JSON string
  | { type: 'tool_result'; toolCallId: string; name: string; result: string; isError?: boolean }
  // Google Search grounding is executed inside Vertex AI rather than through
  // our function/MCP loop. Keep its attribution metadata beside the answer so
  // saved chats can still render sources.
  | { type: 'grounding'; queries: string[]; sources: GroundingSource[]; supports?: GroundingSupport[]; label?: string }
  // Post-answer follow-up suggestions. UI-only: never replayed to providers.
  | { type: 'followups'; questions: string[] }
  // 上下文压缩 happened before this reply: older turns now ride as a summary.
  // UI-only; the summary itself reaches the model through the history.
  | { type: 'context_summary'; state: 'running' | 'done' | 'failed'; covered: number; text?: string };

export type Role = 'user' | 'assistant';

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// ---- Provider adapter contract ----

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'claude-code' | 'novelai';

export interface ProviderRuntimeConfig {
  id: string;
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string | null; // decrypted
  useResponses: boolean;
  useVertex: boolean;
  vertexProject: string | null;
  vertexLocation: string | null;
  vertexSaJson: string | null; // decrypted
  extraHeaders: Record<string, string>;
  /** Which line this config points at: the provider's own ('primary') or a
   * backup endpoint's row id. Keys the circuit-breaker state. */
  endpointId?: string;
  /** Admin-facing name of the line, for notices and logs. */
  endpointName?: string;
  /** Model-id rewrite for gateways that name the same model differently. */
  stripModelPrefix?: string;
  addModelPrefix?: string;
  /** Cap on the busy-retry wait for this line; unset = PROVIDER_RETRY_MAX_WAIT_SECONDS. */
  retryBudgetMs?: number;
  /** Vertex: request Priority PayGo on this line (for models that offer it). */
  vertexPriority?: boolean;
  /** Lines that only make sense for some models — the Priority fallback line
   * would just repeat a standard request for an image model — are skipped
   * for the rest. Unset = serves every model. */
  servesModel?: (model: string) => boolean;
  /** Marks the Vertex Priority PayGo retry: once the standard lines before it
   * were rate limited this many times in one request, skip straight here. */
  escalateAfterBusy?: number;
  /** First fallback-worthy failure jumps directly to this Priority line. */
  escalateOnFailure?: boolean;
  /** Do not retry inside a standard line before escalating to Priority. */
  singleAttempt?: boolean;
  /** A client with a configured fallback model: never wait out a busy
   * rejection; try each remaining line once, except the paid Priority one,
   * then return it. */
  stopOnBusy?: boolean;
  /** Chat-only recovery of successful HTTP streams with no usable answer. */
  recoverEmptyStreams?: boolean;
  /** Per-request tally of busy rejections on standard lines, shared by them
   * (set by the failover layer, read by fetchRetry). */
  busyCounter?: BusyCounter;
  /** Lines to try, in order, when this one fails before producing output. */
  fallbacks?: ProviderRuntimeConfig[];
  failoverThreshold?: number;
  failoverCooldownMs?: number;
}

export interface ProviderFailover {
  recovery?: 'empty';
  /** The line that just failed and the one now being tried. */
  from: string;
  to: string;
  reason: string;
  /** The new line is the Priority PayGo retry after standard ones were rate limited. */
  priority?: boolean;
}

export interface BusyCounter {
  busy: number;
  limit: number;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface GroundingSource {
  uri: string;
  title: string;
}

/** One span of the answer and the sources (indices into `sources`) that
    back it — Vertex's groundingSupports, resolved to our source list. */
export interface GroundingSupport {
  /** The exact answer text of the span (used to locate it in the reply). */
  text: string;
  /** Byte offset in the reply, for ordering only. */
  start: number;
  sources: number[];
}

export interface GroundingInfo {
  queries: string[];
  sources: GroundingSource[];
  supports?: GroundingSupport[];
  /** Where the results came from, for the UI header ('Google 搜索' when absent). */
  label?: string;
}

// Normalized message fed into adapters. Attachments already resolved to base64.
// 'file' parts are always PDFs: text-bearing documents (txt/md/docx/…) are
// extracted server-side and arrive as plain text parts instead.
export interface AdapterMessagePart {
  type: 'text' | 'image' | 'file' | 'tool_call' | 'tool_result';
  text?: string;
  mime?: string;
  dataBase64?: string;
  id?: string; // tool_call id
  name?: string;
  args?: string;
  sig?: string; // vendor thought signature riding on a tool_call
  toolCallId?: string;
  result?: string;
  isError?: boolean;
}

export interface AdapterMessage {
  role: 'user' | 'assistant';
  parts: AdapterMessagePart[];
}

export interface ReasoningRequest {
  /** Vendor level name, exactly as the admin configured it (e.g. 'xhigh'). */
  level: string;
  /** Position on the model's ladder, 0..1 — for vendors that budget in tokens. */
  ratio: number;
}

export interface ProviderRetry {
  recovery?: 'empty' | 'continuation';
  attempt: number;
  maxAttempts: number;
  /** Zero means the retry is now being sent rather than waiting. */
  delayMs: number;
  /** Waiting behind a limit another request already hit, not our own retry. */
  queued?: boolean;
  /** The request being retried goes over Vertex Priority PayGo. */
  priority?: boolean;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: AdapterMessage[];
  tools?: ToolDef[];
  /** Enable the provider-native web-search tool for this request. */
  webSearch?: boolean;
  /** Gemini only: let the model read URLs named in the prompt (urlContext tool). */
  urlContext?: boolean;
  temperature?: number;
  maxTokens?: number;
  hardMaxTokens?: number;
  reasoning?: ReasoningRequest;
  signal: AbortSignal;
  onRetry?: (state: ProviderRetry | null) => void;
  onFailover?: (info: ProviderFailover) => void;
  /** Upstream bytes (including keepalives), not just generated tokens. */
  onActivity?: () => void;
  /** Metadata only: never includes prompts, response text or credentials. */
  onStreamEnd?: (info: ProviderStreamEnd) => void;
  onServiceTier?: (tier: 'standard' | 'priority') => void;
}

export interface ProviderStreamEnd {
  /** Actual request cap and separate Gemini usage counters for truncation diagnosis. */
  requestedMaxOutputTokens?: number;
  thoughtTokens?: number;
  answerTokens?: number;
  endpointId: string;
  location: string | null;
  priority: boolean;
  transport: 'eof' | 'error' | 'aborted' | 'consumer_closed';
  finishReason: string | null;
  promptBlockReason: string | null;
  errorCode: string | null;
  receivedBytes: number;
  events: number;
  invalidEvents: number;
  durationMs: number;
  sinceLastByteMs: number;
}

export type AdapterEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string }
  | { type: 'grounding'; grounding: GroundingInfo }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'stop'; reason: StopReason };

export interface ImageGenRequest {
  novelai?: import('./novelai.js').NovelAIOptions;
  model: string;
  prompt: string;
  size?: string; // e.g. '1024x1024' | 'auto'
  quality?: string;
  n?: number;
  signal: AbortSignal;
  onRetry?: (state: ProviderRetry | null) => void;
  onFailover?: (info: ProviderFailover) => void;
  // optional input images for editing (nano banana & gpt-image support image input)
  inputImages?: { mime: string; dataBase64: string }[];
  system?: string;
  // Full conversation, for providers whose image models are genuinely multi-turn
  // (Gemini). Adapters that can't use it fall back to `prompt` + `inputImages`.
  context?: AdapterMessage[];
}

export interface GeneratedImage {
  generationSettings?: Record<string, unknown>;
  mime: string;
  dataBase64: string;
  usage?: UsageInfo;
}

// What an image model answered. Conversational image models (Gemini) may reply
// with text next to the pictures, or with text *only* — asking a question,
// offering options to pick from, declining. That is a legitimate answer, not a
// failure, so it travels as `text` and callers decide how to show it.
export interface ImageGenResult {
  images: GeneratedImage[];
  text?: string;
  /** Usage for a text-only reply, when there is no image to hang it on. */
  usage?: UsageInfo;
}

export interface ChatAdapter {
  streamChat(cfg: ProviderRuntimeConfig, req: ChatRequest): AsyncGenerator<AdapterEvent>;
  listModels(cfg: ProviderRuntimeConfig): Promise<{ id: string; name?: string }[]>;
  generateImages?(cfg: ProviderRuntimeConfig, req: ImageGenRequest): Promise<ImageGenResult>;
}
