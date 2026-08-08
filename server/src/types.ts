// Shared domain types — the message "parts" model is the core contract.
// An assistant turn is ONE message whose parts may interleave
// text / reasoning / tool_call / tool_result in stream order.

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  // user attachment (uploadId) or model-generated image (imageId → images table)
  | { type: 'image'; uploadId?: string; imageId?: string; mime?: string; url?: string }
  // sig: opaque per-call signature some vendors (Gemini 3 thought_signature)
  // require to be echoed verbatim when the call is replayed as history.
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string } // args = JSON string
  | { type: 'tool_result'; toolCallId: string; name: string; result: string; isError?: boolean };

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

// Normalized message fed into adapters. Attachments already resolved to base64.
export interface AdapterMessagePart {
  type: 'text' | 'image' | 'tool_call' | 'tool_result';
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
  temperature?: number;
  maxTokens?: number;
  hardMaxTokens?: number;
  reasoning?: ReasoningRequest;
  signal: AbortSignal;
}

export type AdapterEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'stop'; reason: 'stop' | 'tool_calls' | 'length' | 'other' };

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
  text?: string; // commentary returned alongside the image (Gemini)
}

export interface ChatAdapter {
  streamChat(cfg: ProviderRuntimeConfig, req: ChatRequest): AsyncGenerator<AdapterEvent>;
  listModels(cfg: ProviderRuntimeConfig): Promise<{ id: string; name?: string }[]>;
  generateImages?(cfg: ProviderRuntimeConfig, req: ImageGenRequest): Promise<GeneratedImage[]>;
}
