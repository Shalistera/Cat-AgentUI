// Shared domain types — the message "parts" model is the core contract.
// An assistant turn is ONE message whose parts may interleave
// text / reasoning / tool_call / tool_result in stream order.

/** Why the model stopped. 'length' (max output tokens) and 'content_filter'
    (provider safety / refusal) mean the reply is cut short — the chat route
    persists them so the UI can flag "输出可能不完整". */
export type StopReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  // Display-only opaque metadata; never inserted into the text prompt.
  | { type: 'thought_signature'; signature: string; source: 'text' | 'thought' | 'standalone' }
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
  | { type: 'followups'; questions: string[] };

export type Role = 'user' | 'assistant';

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// ---- Provider adapter contract ----

export type ProviderType = 'openai' | 'anthropic' | 'gemini';

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

export interface ChatRequest {
  model: string;
  system?: string;
  messages: AdapterMessage[];
  tools?: ToolDef[];
  /** Enable the provider-native web-search tool for this request. */
  webSearch?: boolean;
  temperature?: number;
  maxTokens?: number;
  hardMaxTokens?: number;
  reasoning?: ReasoningRequest;
  signal: AbortSignal;
}

export type AdapterEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  // Display-only opaque metadata; never inserted into the text prompt.
  | { type: 'thought_signature'; signature: string; source: 'text' | 'thought' | 'standalone' }
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string }
  | { type: 'grounding'; grounding: GroundingInfo }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'stop'; reason: StopReason };

export interface ImageGenRequest {
  model: string;
  prompt: string;
  size?: string; // e.g. '1024x1024' | 'auto'
  quality?: string;
  n?: number;
  signal: AbortSignal;
  // optional input images for editing (nano banana & gpt-image support image input)
  inputImages?: { mime: string; dataBase64: string }[];
  system?: string;
  // Full conversation, for providers whose image models are genuinely multi-turn
  // (Gemini). Adapters that can't use it fall back to `prompt` + `inputImages`.
  context?: AdapterMessage[];
}

export interface GeneratedImage {
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
