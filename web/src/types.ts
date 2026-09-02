// API DTOs — mirror of server responses.

export interface Bootstrap { needsSetup: boolean; signupEnabled: boolean; brand: string }

export interface User {
  id: string; username: string; role: 'admin' | 'user';
  displayName: string | null;
  /** 绘图工坊访问权限(服务端已折算,管理员恒为 true)。 */
  allowImages: boolean;
  /** 图像模型使用权限(服务端已折算,管理员恒为 true)。 */
  allowImageModels: boolean;
  settings: {
    theme?: 'dark' | 'light'; lang?: 'zh' | 'en'; titleEmoji?: boolean;
    /** Personal model-picker order (model row ids); null/absent = admin order. */
    modelOrder?: string[] | null;
    /** Starred models (model row ids) — always hoisted to the top of the picker. */
    favoriteModels?: string[] | null;
    /** 快捷指令 cards on the new-chat page (max 6); null/absent = built-in default. */
    quickPrompts?: string[] | null;
    /** Workshops pinned to the sidebar icon row (ids, ordered); null/absent = all. */
    workshopPins?: string[] | null;
    /** Personal style presets on the 翻译工坊 page (max 4). */
    translateScenes?: TranslateScene[] | null;
    /** Ask before EVERY MCP tool call, not just servers the admin flagged. */
    confirmTools?: boolean;
    /** 全局自定义指令 — prepended to every chat's system prompt (max 1500 chars). */
    customInstructions?: string | null;
  };
}

export interface TranslateScene { name: string; text: string }

/** /api/translate/config — which modes the admin has wired up. */
export interface TranslateConfig {
  fast: boolean; think: boolean;
  languages: Record<string, string>;
  maxChars: number; maxSceneChars: number;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; uploadId?: string; imageId?: string; mime?: string; url?: string }
  | { type: 'file'; uploadId: string; name?: string; mime?: string }
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string }
  | { type: 'tool_result'; toolCallId: string; name: string; result: string; isError?: boolean }
  | { type: 'grounding'; queries: string[]; sources: { uri: string; title: string }[] }
  | { type: 'followups'; questions: string[] };

export interface Message {
  id: string;
  /** Tree link — the message this one replies to; null = conversation root. */
  parentId: string | null;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  model: string | null;
  status: 'done' | 'error' | 'stopped' | 'streaming';
  /** Provider stop reason; 'length' / 'content_filter' on a done reply = cut short. */
  finishReason: string | null;
  error: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  createdAt: number;
  /** 收藏 — this person bookmarked the message. */
  bookmarked?: boolean;
}

/** One row of /api/bookmarks. */
export interface Bookmark {
  id: string; createdAt: number;
  chatId: string; chatTitle: string; projectId: string | null;
  message: Message;
}

/** A `tool_confirm` stream event: the model wants these calls, the turn waits. */
export interface ToolConfirmRequest {
  messageId: string;
  calls: { id: string; name: string; args: string }[];
}

export interface ChatSummary {
  id: string; title: string; pinned: boolean; archived: boolean;
  /** 临时对话 — not listed, not searchable, swept after idle TTL. */
  temporary: boolean;
  modelId: string | null;
  projectId: string | null;
  createdAt: number; updatedAt: number;
}

export type ProjectAccessMode = 'private' | 'shared' | 'restricted';
export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type ProjectMemberRole = 'editor' | 'viewer';

export interface Project {
  id: string; name: string;
  description: string | null;
  instructions: string | null;
  createdAt: number; updatedAt: number;
  /** Who may use it: nobody else / everyone / the member list. */
  accessMode: ProjectAccessMode;
  /** What I may do with it. */
  role: ProjectRole;
  owner: { id: string; username: string; displayName: string | null };
  /** Present in list responses. */
  docCount?: number; totalChars?: number; memberCount?: number;
}

export interface ProjectMember {
  userId: string; username: string; displayName: string | null; role: ProjectMemberRole;
}

/** /api/users/directory — everyone I can share with (enabled accounts, minus me). */
export interface DirectoryUser { id: string; username: string; displayName: string | null; role: 'admin' | 'user' }

/** /api/auth/sessions — one signed-in device. */
export interface SessionInfo {
  id: string; current: boolean;
  createdAt: number; expiresAt: number; lastSeenAt: number;
  ip: string | null; userAgent: string | null;
}

export interface ProjectDoc { id: string; name: string; chars: number; createdAt: number }

export interface ProjectLimits {
  maxDocs: number; maxDocChars: number; maxTotalChars: number; maxInstructionsChars: number;
  /** At or below this many total chars the corpus is injected whole; above it
      the model retrieves on demand. */
  injectChars: number;
}

/** 'off', or the `value` of one of the model's reasoning levels. */
export type ReasoningEffort = string;

/** `value` goes to the provider, `label` is what the user reads. */
export interface ReasoningLevel { value: string; label: string }

export type ReasoningMode = 'auto' | 'custom' | 'off';

export interface ChatDetail extends ChatSummary {
  systemPrompt: string | null;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
  webSearch: boolean;
  mcpServerIds: string[];
  /** Leaf of the branch on screen; null = no messages yet. */
  currentLeafId: string | null;
}

/** One row of /api/search — a chat plus why it matched. */
export interface SearchResult {
  id: string; title: string; pinned: boolean; archived: boolean;
  projectId: string | null; updatedAt: number;
  titleMatch: boolean; snippet: string | null; matchCount: number;
}

export interface ModelInfo {
  id: string; modelId: string; displayName: string;
  /** Admin-written blurb shown under the model name on the new-chat page. */
  description: string | null;
  vision: boolean; tools: boolean; imageGen: boolean; nativeSearch: boolean; isDefault: boolean;
  /** Admin default for the 联网搜索 toggle on new chats with this model. */
  defaultWebSearch: boolean;
  providerId: string; providerName: string; providerType: 'openai' | 'anthropic' | 'gemini';
  /** Content-addressed URL of this model's own icon; wins over the provider avatar. */
  avatarUrl: string | null;
  /** Content-addressed URL of the provider's custom avatar; null = built-in mark. */
  providerAvatarUrl: string | null;
  /** Ordered reasoning levels, weakest first. Empty = no reasoning control. */
  reasoningLevels: ReasoningLevel[];
}

export interface McpServerInfo {
  id: string; name: string; transport: 'stdio' | 'http' | 'sse';
  enabled: boolean; lastStatus: 'ok' | 'error' | null; toolCount: number;
  tools: { name: string; description: string }[];
  /** Admin-designated web-search provider — surfaces as the 联网搜索 toggle. */
  isSearch: boolean;
  /** Every call from this server pauses for the user's go-ahead. */
  confirmCalls: boolean;
}

export interface ImageModel {
  id: string; modelId: string; displayName: string | null;
  providerName: string; providerType: string;
}

export interface ImageRecord {
  id: string; model: string | null; prompt: string; size: string | null;
  durationMs: number | null; createdAt: number; tokens?: number | null;
}

// ---- PPT 工坊 ----

export interface PptModel {
  id: string; modelId: string; displayName: string | null;
  providerName: string; providerType: string;
}

export interface DeckPoint { text: string; sub?: string[] }

export type DeckSlide =
  | { layout: 'cover'; title: string; subtitle?: string; notes?: string }
  | { layout: 'section'; title: string; subtitle?: string; notes?: string }
  | { layout: 'bullets'; title: string; points: DeckPoint[]; notes?: string }
  | { layout: 'twoCol'; title: string; columns: { heading: string; points: string[] }[]; notes?: string }
  | { layout: 'table'; title: string; headers: string[]; rows: string[][]; notes?: string }
  | { layout: 'quote'; quote: string; author?: string; notes?: string }
  | { layout: 'end'; title: string; subtitle?: string; notes?: string };

export interface DeckSpec {
  title: string;
  subtitle?: string;
  /** 6-digit hex without '#'. */
  accent?: string;
  slides: DeckSlide[];
}

export interface DeckSummary {
  id: string; title: string; topic: string; model: string | null;
  slideCount: number; totalTokens: number | null; durationMs: number | null; createdAt: number;
}

export interface DeckDetail extends DeckSummary { spec: DeckSpec }

export interface UsageTotals {
  promptTokens: number; completionTokens: number; totalTokens: number;
  images: number; requests: number; activeUsers?: number;
  /** 按当前模型单价折算的成本;null = 未配置任何单价。 */
  cost?: number | null;
}
export interface UsageByDay {
  day: string; promptTokens: number; completionTokens: number;
  totalTokens: number; images: number; requests: number;
}
export interface UsageByUser {
  userId: string; username: string; promptTokens: number; completionTokens: number;
  totalTokens: number; images: number; requests: number;
  /** null = 没有任何模型配置了单价,前端隐藏成本列。 */
  cost?: number | null;
}
export interface UsageByModel {
  model: string; totalTokens: number; requests: number;
  cost?: number | null;
}
export interface UsageByKind { kind: string; totalTokens: number; requests: number; images: number }

export interface AdminUsage {
  byDay: UsageByDay[]; byUser: UsageByUser[]; byModel: UsageByModel[];
  byKind: UsageByKind[]; totals: UsageTotals;
  currency: string;
}
/** /api/admin/usage/user/:id — one user's usage over the selected window. */
export interface AdminUserUsage {
  days: number;
  byDay: UsageByDay[];
  byModel: UsageByModel[];
  byKind: UsageByKind[];
  totals: UsageTotals;
  currency: string;
}

export interface MyUsage {
  byDay: UsageByDay[]; byModel: UsageByModel[]; totals: UsageTotals;
  currency: string;
  /** limit null = 不限额;used 为本月已用 tokens。 */
  quota: { limit: number | null; used: number };
}

export interface AdminUser {
  id: string; username: string; displayName: string | null; role: 'admin' | 'user';
  disabled: boolean; createdAt: number; lastActiveAt: number | null;
  /** Raw grants (admins are exempt regardless). */
  allowImages: boolean; allowImageModels: boolean;
  /** null = 跟随全局默认,0 = 不限,>0 = 每月上限。 */
  monthlyTokenQuota: number | null;
  /** Live (unexpired) login sessions right now. */
  activeSessions: number;
  usage: { totalTokens: number; requests: number; images: number; monthTokens: number };
}

export type ModelAccessMode = 'shared' | 'restricted';

export interface AdminModel {
  id: string; providerId: string; modelId: string; displayName: string | null;
  /** Blurb shown to users on the new-chat page; null = not set. */
  description: string | null;
  /** Content-addressed URL of the model's custom icon; null = provider avatar / brand mark. */
  avatarUrl: string | null;
  vision: boolean; tools: boolean; imageGen: boolean; enabled: boolean;
  isDefault: boolean; sortOrder: number;
  defaultWebSearch: boolean;
  accessMode: ModelAccessMode;
  allowedUserIds: string[];
  /** 每 100 万 token 的单价(站点货币);null = 未配置,不计成本。 */
  inputPrice: number | null;
  outputPrice: number | null;
  reasoning: {
    mode: ReasoningMode;
    /** What the model offers right now, under the current mode. */
    levels: ReasoningLevel[];
    /** The saved custom ladder, whether or not it is in use. */
    custom: ReasoningLevel[];
    /** What 'auto' derives from the model id — empty if we don't recognise it. */
    defaults: ReasoningLevel[];
  };
}

export interface AdminProvider {
  id: string; name: string; type: 'openai' | 'anthropic' | 'gemini';
  baseUrl: string | null; hasKey: boolean;
  useResponses: boolean; useVertex: boolean;
  vertexProject: string | null; vertexLocation: string | null; hasVertexSa: boolean;
  hasExtraHeaders: boolean; extraHeaderKeys: string[];
  enabled: boolean; sortOrder: number;
  avatarUrl: string | null;
  models: AdminModel[];
}

// env/headers 为敏感信息,后端只返回是否已配置及键名,不返回值。
export interface AdminMcpServer {
  id: string; isSearch: boolean; name: string; transport: 'stdio' | 'http' | 'sse';
  command: string | null; args: string[]; url: string | null;
  hasEnv: boolean; hasHeaders: boolean;
  envKeys: string[]; headerKeys: string[];
  accessMode: 'shared' | 'restricted';
  confirmCalls: boolean;
  allowedUserIds: string[];
  enabled: boolean; lastStatus: string | null; lastError: string | null;
  toolsCache?: { name: string; description: string }[];
}

export interface McpPresetStatus {
  id: string; name: string; description: string; pkg: string;
  apiKeyEnv: string; keyUrl: string; search: boolean;
  installedVersion: string | null;
  serverId: string | null;
}

export interface AppSettings {
  signupEnabled: boolean;
  brand: string;
  /** 绘图工坊 image retention in days; 0 = keep forever. */
  imageRetentionDays: number;
  /** Chat-born image retention in days; 0 = keep forever. Separate policy. */
  chatImageRetentionDays: number;
  /** Uploads no saved message references: removed after N days; 0 = keep forever. */
  uploadRetentionDays: number;
  /** 默认月度 token 配额,0 = 不限。用户可单独覆盖。 */
  quotaMonthlyTokens: number;
  /** 超额动作:拒绝,或对话降级到指定模型。 */
  quotaAction: 'block' | 'downgrade';
  /** 降级目标模型(models.id),null = 未设置(降级时按拒绝处理)。 */
  quotaFallbackModelId: string | null;
  /** 对话标题生成模型(models.id),null = 跟随当前对话的模型。 */
  titleModelId: string | null;
  /** 回答完成后自动生成 3 个快速追问。 */
  followupEnabled: boolean;
  /** 快速追问生成模型(models.id),null = 跟随当前对话的模型。 */
  followupModelId: string | null;
  /** 站内公告,空字符串 = 不显示横幅。 */
  announcement: string;
  /** 成本显示所用的货币符号,默认 $。 */
  usageCurrency: string;
  /** 翻译工坊 快速 / 思考 两条模型链(models.id,按顺序 failover)。 */
  translateFastModelIds: string[];
  translateThinkModelIds: string[];
}

// SSE stream handler callbacks
export interface StreamHandlers {
  onMeta?(d: { messageId: string; userMessageId: string | null; model: string }): void;
  onDelta?(text: string): void;
  onReasoning?(text: string): void;
  onToolCall?(d: { id: string; name: string; args: string }): void;
  onToolResult?(d: { toolCallId: string; name: string; result: string; isError?: boolean }): void;
  onToolConfirm?(d: ToolConfirmRequest): void;
  onGrounding?(d: Extract<MessagePart, { type: 'grounding' }>): void;
  onImage?(d: { imageId: string; mime?: string }): void;
  onUsage?(d: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; durationMs: number; ttftMs: number | null }): void;
  onNotice?(message: string): void;
  onTitle?(title: string): void;
  onFollowups?(d: { messageId?: string; questions: string[] }): void;
  onError?(message: string): void;
  onDone?(status: 'done' | 'error' | 'stopped', finishReason: string | null): void;
}

/** /api/admin/storage — what data/ is holding and for whom. */
export interface StorageOverview {
  uploads: { count: number; bytes: number; unreferencedCount: number; unreferencedBytes: number };
  images: { count: number; bytes: number; workshopBytes: number; chatBytes: number };
  orphans: { count: number; bytes: number };
  limits: { total: number; perUserUploads: number; perUserImages: number };
  freeSpace: number | null;
  topUsers: { userId: string; username: string; displayName: string | null; uploadBytes: number; imageBytes: number }[];
}
