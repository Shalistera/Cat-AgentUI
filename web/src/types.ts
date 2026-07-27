// API DTOs — mirror of server responses.

export interface Bootstrap { needsSetup: boolean; signupEnabled: boolean; brand: string }

export interface User {
  id: string; username: string; role: 'admin' | 'user';
  displayName: string | null;
  settings: { theme?: 'dark' | 'light'; lang?: 'zh' | 'en' };
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; uploadId?: string; imageId?: string; mime?: string; url?: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; toolCallId: string; name: string; result: string; isError?: boolean };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  model: string | null;
  status: 'done' | 'error' | 'stopped' | 'streaming';
  error: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  createdAt: number;
}

export interface ChatSummary {
  id: string; title: string; pinned: boolean; modelId: string | null;
  createdAt: number; updatedAt: number;
}

/** 'off' plus whatever level names the admin configured for the model. */
export type ReasoningEffort = string;

export interface ChatDetail extends ChatSummary {
  systemPrompt: string | null;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
  mcpServerIds: string[];
}

export interface ModelInfo {
  id: string; modelId: string; displayName: string;
  vision: boolean; tools: boolean; imageGen: boolean; isDefault: boolean;
  providerId: string; providerName: string; providerType: 'openai' | 'anthropic' | 'gemini';
  /** Content-addressed URL of the provider's custom avatar; null = built-in mark. */
  providerAvatarUrl: string | null;
  /** Ordered vendor level names, weakest first. Empty = no reasoning control. */
  reasoningLevels: string[];
}

export interface McpServerInfo {
  id: string; name: string; transport: 'stdio' | 'http' | 'sse';
  enabled: boolean; lastStatus: 'ok' | 'error' | null; toolCount: number;
  tools: { name: string; description: string }[];
}

export interface ImageModel {
  id: string; modelId: string; displayName: string | null;
  providerName: string; providerType: string;
}

export interface ImageRecord {
  id: string; model: string | null; prompt: string; size: string | null;
  durationMs: number | null; createdAt: number; tokens?: number | null;
}

export interface UsageTotals {
  promptTokens: number; completionTokens: number; totalTokens: number;
  images: number; requests: number; activeUsers?: number;
}
export interface UsageByDay {
  day: string; promptTokens: number; completionTokens: number;
  totalTokens: number; images: number; requests: number;
}
export interface UsageByUser {
  userId: string; username: string; promptTokens: number; completionTokens: number;
  totalTokens: number; images: number; requests: number;
}
export interface UsageByModel { model: string; totalTokens: number; requests: number }
export interface UsageByKind { kind: string; totalTokens: number; requests: number; images: number }

export interface AdminUsage {
  byDay: UsageByDay[]; byUser: UsageByUser[]; byModel: UsageByModel[];
  byKind: UsageByKind[]; totals: UsageTotals;
}
export interface MyUsage { byDay: UsageByDay[]; byModel: UsageByModel[]; totals: UsageTotals }

export interface AdminUser {
  id: string; username: string; displayName: string | null; role: 'admin' | 'user';
  disabled: boolean; createdAt: number; lastActiveAt: number | null;
  usage: { totalTokens: number; requests: number; images: number };
}

export interface AdminModel {
  id: string; providerId: string; modelId: string; displayName: string | null;
  vision: boolean; tools: boolean; imageGen: boolean; enabled: boolean;
  isDefault: boolean; sortOrder: number;
  reasoningLevels: string[];
}

export interface AdminProvider {
  id: string; name: string; type: 'openai' | 'anthropic' | 'gemini';
  baseUrl: string | null; hasKey: boolean;
  useResponses: boolean; useVertex: boolean;
  vertexProject: string | null; vertexLocation: string | null; hasVertexSa: boolean;
  extraHeaders: Record<string, string>; enabled: boolean; sortOrder: number;
  avatarUrl: string | null;
  models: AdminModel[];
}

// env/headers 为敏感信息,后端只返回是否已配置及键名,不返回值。
export interface AdminMcpServer {
  id: string; name: string; transport: 'stdio' | 'http' | 'sse';
  command: string | null; args: string[]; url: string | null;
  hasEnv: boolean; hasHeaders: boolean;
  envKeys: string[]; headerKeys: string[];
  enabled: boolean; lastStatus: string | null; lastError: string | null;
  toolsCache?: { name: string; description: string }[];
}

export interface AppSettings { signupEnabled: boolean; brand: string }

// SSE stream handler callbacks
export interface StreamHandlers {
  onMeta?(d: { messageId: string; userMessageId: string | null; model: string }): void;
  onDelta?(text: string): void;
  onReasoning?(text: string): void;
  onToolCall?(d: { id: string; name: string; args: string }): void;
  onToolResult?(d: { toolCallId: string; name: string; result: string; isError?: boolean }): void;
  onImage?(d: { imageId: string; mime?: string }): void;
  onUsage?(d: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; durationMs: number; ttftMs: number | null }): void;
  onNotice?(message: string): void;
  onTitle?(title: string): void;
  onError?(message: string): void;
  onDone?(status: 'done' | 'error' | 'stopped'): void;
}
