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
    /** 智能工具 master switch (工作区 / 沙盒 / 技能 / 子代理); undefined = on. */
    agentTools?: boolean;
    /** 全局自定义指令 — prepended to every chat's system prompt (max 1500 chars). */
    customInstructions?: string | null;
    /** 互动画布 (experimental): answers come back as one HTML page, rendered live. */
    canvasAnswers?: boolean;
    showThoughtSignatures?: boolean;
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
  // Display-only opaque metadata; never inserted into the text prompt.
  | { type: 'thought_signature'; signature: string; source: 'text' | 'thought' | 'standalone' }
  | { type: 'image'; uploadId?: string; imageId?: string; mime?: string; url?: string }
  | { type: 'file'; uploadId: string; name?: string; mime?: string }
  | { type: 'tool_call'; id: string; name: string; args: string; sig?: string }
  | { type: 'tool_result'; toolCallId: string; name: string; result: string; isError?: boolean }
  | { type: 'grounding'; queries: string[]; sources: { uri: string; title: string }[]; supports?: { text: string; start: number; sources: number[] }[]; label?: string }
  | { type: 'followups'; questions: string[] };

export interface Message {
  id: string;
  /** Tree link — the message this one replies to; null = conversation root. */
  parentId: string | null;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  model: string | null;
  status: 'done' | 'error' | 'stopped' | 'streaming';
  /** Provider stop reason; 'length' / 'content_filter' / 'incomplete' on a done
      reply = cut short ('incomplete' = no visible body or the stream ended
      without a proper finish signal — e.g. only the thought chain arrived). */
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
  /** 工作区 — per-chat file directory the model edits through tools. */
  workspace: boolean;
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

/** One row of the admin's per-user chat list. */
export interface AdminChatSummary extends ChatSummary {
  modelName: string | null;
  projectName: string | null;
  messageCount: number;
}

export interface AdminChatOwner { id: string; username: string; displayName: string | null }

export interface AdminChatList {
  user: AdminChatOwner;
  total: number;
  chats: AdminChatSummary[];
}

/** /api/admin/chats/:id — the whole tree, read-only. */
export interface AdminChatDetail {
  user: AdminChatOwner;
  chat: AdminChatSummary & { systemPrompt: string | null; currentLeafId: string | null };
  messages: Message[];
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
  /** My allowance on this model this day/week; null = unlimited for me. */
  usageLimit: UsageLimit | null;
}

export type LimitPeriod = 'day' | 'week';

/** Per-account model allowance and how much of it is spent (see quota.ts). */
export interface UsageLimit {
  period: LimitPeriod;
  requests: { used: number; limit: number } | null;
  tokens: { used: number; limit: number } | null;
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

export interface MyUploadFile {
  id: string; name: string | null; mime: string; size: number; createdAt: number;
  /** 引用该附件的对话;null = 未发进任何对话,可直接删除。 */
  chat: { id: string; title: string } | null;
}
export interface MyUploads { limit: number; used: number; files: MyUploadFile[] }

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
  /** Stored conversations (临时对话 excluded), viewable in the admin console. */
  chats: number;
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
  /** 每人在此模型上的周期上限;null = 该项不限。管理员不受限。 */
  limitPeriod: LimitPeriod;
  limitRequests: number | null;
  limitTokens: number | null;
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
  /** 每用户附件存储上限(MB),适用于所有用户。 */
  maxUserUploadMb: number;
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

/** One file in a chat's 工作区. */
export interface WorkspaceFile { path: string; size: number; mtime: number }

export interface WorkspaceListing {
  enabled: boolean;
  files: WorkspaceFile[];
  bytes: number;
  limits: { bytes: number; files: number; fileBytes: number };
}

// SSE stream handler callbacks
export interface StreamHandlers {
  onMeta?(d: { messageId: string; userMessageId: string | null; model: string }): void;
  onDelta?(text: string): void;
  onReasoning?(text: string): void;
  onThoughtSignature?(d: Extract<MessagePart, { type: 'thought_signature' }>): void;
  onToolCall?(d: { id: string; name: string; args: string; sig?: string }): void;
  onToolResult?(d: { toolCallId: string; name: string; result: string; isError?: boolean }): void;
  onToolConfirm?(d: ToolConfirmRequest): void;
  /** 子代理 live progress for the parent's spawn_subagent tool row. */
  onSubagentProgress?(d: { toolCallId: string; text: string }): void;
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
  workspaces: { chats: number; bytes: number };
  limits: { total: number; perUserUploads: number; perUserImages: number };
  freeSpace: number | null;
  topUsers: { userId: string; username: string; displayName: string | null; uploadBytes: number; imageBytes: number }[];
}

// ---- 沙盒 (admin) ----
export interface SandboxEnvCheck {
  id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; fix?: string; required: boolean;
}
export interface SandboxSettings {
  enabled: boolean; confirm: boolean;
  accessMode: 'shared' | 'restricted'; allowedUserIds: string[];
  timeoutSec: number; memoryMb: number; cpuPercent: number; maxPids: number; maxOutputChars: number;
  builtinTools: boolean;
}
export interface SandboxJob {
  id: number; kind: 'create' | 'install' | 'uninstall' | 'rebuild'; args: string[];
  status: 'running' | 'done' | 'error'; startedAt: number; endedAt: number | null; log: string[]; error: string | null;
}
export interface SandboxAdminData {
  env: {
    checkedAt: number; checks: SandboxEnvCheck[]; runnable: boolean; limitsAvailable: boolean;
    python3Path: string | null; pandocPath: string | null; hostSetupScript: string;
  };
  settings: SandboxSettings;
  limits: { maxTimeoutSec: number; maxConcurrency: number };
  load: { running: number; max: number };
  venv: {
    exists: boolean;
    packages: { name: string; version: string }[];
    presets: { name: string; group: string; desc: string }[];
  };
  job: SandboxJob | null;
}
export interface SandboxRun {
  id: string; createdAt: number; command: string; exitCode: number | null; timedOut: boolean;
  durationMs: number; outputChars: number; chatId: string | null; chatTitle: string | null;
  user: { id: string; username: string; displayName: string | null };
}

// ---- 技能 (admin) ----
export interface SkillInfo {
  id: string; slug: string; name: string; description: string; enabled: boolean;
  accessMode: 'shared' | 'restricted'; allowedUserIds: string[];
  fileCount: number; bytes: number; createdAt: number; updatedAt: number;
}
export interface SkillDetail { skill: SkillInfo; files: { path: string; size: number }[]; skillMd: string }

// ---- Agent 能力 ----
export interface AccessPolicy { enabled: boolean; accessMode: 'shared' | 'restricted'; allowedUserIds: string[] }
export interface AgentSettings {
  workspace: AccessPolicy;
  skills: AccessPolicy;
  subagent: AccessPolicy & {
    modelId: string; maxPerTurn: number; maxIterations: number; timeoutSec: number; maxResultChars: number; allowSandbox: boolean;
  };
}
export interface AgentAdminData {
  settings: AgentSettings;
  limits: { workspaceBytes: number; workspaceFileBytes: number; workspaceFiles: number; toolIterations: number };
}
/** /api/agent/capabilities — what this person's chats may use right now. */
export interface AgentCapabilities { agentTools: boolean; workspace: boolean; sandbox: boolean; convert: boolean; sandboxConfirm: boolean; skills: number; subagent: boolean }

