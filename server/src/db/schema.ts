import { sqliteTable, text, integer, real, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'), // 'admin' | 'user'
  displayName: text('display_name'),
  disabled: integer('disabled').notNull().default(0),
  // Monthly token ceiling: null = follow the app-wide default, 0 = unlimited
  // for this user, >0 = hard cap. Admins are always exempt (see quota.ts).
  monthlyTokenQuota: integer('monthly_token_quota'),
  // Feature gates, default off. Admins are always exempt (see model-access.ts):
  // allow_images = the 绘图工坊 pages, allow_image_models = seeing/using
  // image-generation models anywhere (picker, workshop, chat).
  allowImages: integer('allow_images').notNull().default(0),
  allowImageModels: integer('allow_image_models').notNull().default(0),
  settings: text('settings').notNull().default('{}'), // JSON: { theme, lang, ... }
  createdAt: integer('created_at').notNull(),
  lastActiveAt: integer('last_active_at'),
});

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  // Refreshed at most every few minutes per session (see auth.ts), enough for
  // the 登录设备 list to say "active just now" vs "last seen last week".
  lastSeenAt: integer('last_seen_at'),
}, (t) => [index('idx_sessions_user').on(t.userId), index('idx_sessions_exp').on(t.expiresAt)]);

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'openai' | 'anthropic' | 'gemini'
  baseUrl: text('base_url'), // null = provider default
  apiKeyEnc: text('api_key_enc'), // AES-256-GCM encrypted
  useResponses: integer('use_responses').notNull().default(0), // openai: Responses API
  useVertex: integer('use_vertex').notNull().default(0), // gemini: Vertex AI
  vertexProject: text('vertex_project'),
  // Comma-separated locations in priority order ("global,us,eu"); null =
  // global. Rate-limited on one, the request moves on to the next.
  vertexLocation: text('vertex_location'),
  // Priority PayGo: 'off' | 'fallback' (after standard locations/retries) |
  // 'first_failure' (after one pre-output failure) | 'always'. See vertex.ts.
  vertexPriority: text('vertex_priority').notNull().default('off'),
  vertexSaJsonEnc: text('vertex_sa_json_enc'), // encrypted service account JSON
  // extra_headers is retained only as a one-start compatibility source for
  // pre-0012 rows. New values live encrypted in extra_headers_enc.
  extraHeaders: text('extra_headers').notNull().default('{}'),
  extraHeadersEnc: text('extra_headers_enc'), // encrypted JSON Record<string,string>
  // Optional custom avatar as a data URI. null = fall back to the built-in
  // brand mark for this provider's type. Stored inline rather than on disk so
  // it survives a plain db copy and needs no cleanup path.
  avatar: text('avatar'),
  // Failover: after this many consecutive fallback-worthy failures an endpoint
  // (the provider's own line or a backup) is skipped for cooldown seconds,
  // then probed once. See providers/failover.ts.
  failoverThreshold: integer('failover_threshold').notNull().default(3),
  failoverCooldownSeconds: integer('failover_cooldown_seconds').notNull().default(60),
  // The provider's own line, described the same way a backup is so the two
  // can trade places: an optional label (null = "主线路") and the model-id
  // rewrite applied before sending (see providerEndpoints).
  primaryName: text('primary_name'),
  stripModelPrefix: text('strip_model_prefix').notNull().default(''),
  addModelPrefix: text('add_model_prefix').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

// Backup lines for a provider: same vendor type and the same model roster, a
// different gateway. Tried in priority order only when the line before it is
// unreachable — never round-robin, so prompt caches keep hitting one host.
export const providerEndpoints = sqliteTable('provider_endpoints', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  apiKeyEnc: text('api_key_enc'),
  extraHeadersEnc: text('extra_headers_enc'),
  // null = follow the provider's setting.
  useResponses: integer('use_responses'),
  // Gateways name the same model differently (OpenRouter `openai/gpt-4o`,
  // LiteLLM `gpt-4o`): strip this prefix from the roster's model id, then add
  // that one, before sending. Empty = send as-is.
  stripModelPrefix: text('strip_model_prefix').notNull().default(''),
  addModelPrefix: text('add_model_prefix').notNull().default(''),
  priority: integer('priority').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_provider_endpoints_provider').on(t.providerId, t.priority)]);

export const models = sqliteTable('models', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(), // API model name, e.g. gpt-4o
  displayName: text('display_name'),
  // Admin-written blurb shown to users under the model name on the new-chat
  // page, e.g. “现在世界上最强的模型,但是很贵”. null = say nothing.
  description: text('description'),
  // Optional custom icon as a data URI (SVG/PNG/…). Wins over the provider
  // avatar and the built-in brand mark everywhere the model is shown.
  // null = fall back to those.
  avatar: text('avatar'),
  vision: integer('vision').notNull().default(1),
  tools: integer('tools').notNull().default(1),
  imageGen: integer('image_gen').notNull().default(0),
  // Where the reasoning ladder comes from: 'auto' derives the vendor's common
  // tiers from the model id, 'custom' uses reasoningLevels verbatim, 'off' says
  // the model has no reasoning mode so the control is hidden. See reasoning.ts.
  reasoningMode: text('reasoning_mode').notNull().default('auto'),
  // Ordered JSON [{value,label}], weakest first — the name the vendor receives
  // plus the one the user reads, e.g. [{"value":"xhigh","label":"极高"}].
  // Only consulted when reasoningMode is 'custom'.
  reasoningLevels: text('reasoning_levels').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  isDefault: integer('is_default').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  // Admin-set price per 1M tokens, in the site's display currency (see the
  // usage_currency app setting). null = not priced → usage shows tokens only.
  inputPrice: real('input_price'),
  outputPrice: real('output_price'),
  // Admin-set default for the composer's 联网搜索 toggle on NEW chats with this
  // model. Only takes effect when search is actually available to the model
  // (Vertex native search or the designated search MCP).
  defaultWebSearch: integer('default_web_search').notNull().default(0),
  // Mirrors mcpServers.accessMode: 'shared' shows the model to everyone,
  // 'restricted' only to explicitly granted users. Admins always see all.
  accessMode: text('access_mode').notNull().default('shared'),
  // Per-account usage ceiling for THIS model, on top of the monthly quota:
  // each ordinary user may make at most limitRequests user-initiated requests
  // and/or consume limitTokens tokens with it per window. 'day' resets at
  // local midnight, 'week' on Monday 00:00. null = no limit on that axis.
  // Admins are exempt (see quota.ts).
  limitPeriod: text('limit_period').notNull().default('day'), // 'day' | 'week'
  limitRequests: integer('limit_requests'),
  limitTokens: integer('limit_tokens'),
  createdAt: integer('created_at').notNull(),
});

// Restricted models require an explicit ordinary-user grant; admins retain
// implicit access. Same shape as mcpServerAccess for the same reasons.
export const modelAccess = sqliteTable('model_access', {
  modelId: text('model_id').notNull().references(() => models.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.modelId, t.userId] }),
  index('idx_model_access_user').on(t.userId),
]);

// A project bundles custom instructions and reference documents; chats opted
// into it get both injected into their system prompt. Documents are plain text
// only (the UI reads files client-side) — no binary parsing, no OCR.
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  instructions: text('instructions'),
  // Who besides the owner may use the project in their own chats:
  // 'private' = nobody, 'shared' = every account, 'restricted' = the rows in
  // projectMembers. Admins get NO implicit access — a project is personal
  // data until its owner opens it up. Chats stay per-user in every mode.
  accessMode: text('access_mode').notNull().default('private'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_projects_user').on(t.userId, t.updatedAt)]);

// Explicit grants on a project. 'viewer' can read docs and chat inside the
// project; 'editor' can also change the instructions and add/remove docs.
// Renaming, deleting and sharing itself stay with the owner. Rows are
// meaningful in every access mode (an editor grant on a 'shared' project
// promotes that person above the read-only default).
export const projectMembers = sqliteTable('project_members', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('viewer'), // 'viewer' | 'editor'
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.userId] }),
  index('idx_project_members_user').on(t.userId),
]);

export const projectDocs = sqliteTable('project_docs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // display filename
  content: text('content').notNull(), // plain text, injected verbatim
  chars: integer('chars').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_project_docs_project').on(t.projectId)]);

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  modelId: text('model_id'), // references models.id, kept loose so model deletion doesn't break chats
  // references projects.id, kept loose so deleting a project leaves its chats
  // intact (they just fall out of the project)
  projectId: text('project_id'),
  systemPrompt: text('system_prompt'),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  // 'off' or a level `value` from the model's ladder; null = off. Adapters
  // translate it per vendor (effort name vs. thinking token budget), and a level
  // no longer on the ladder is dropped rather than sent.
  reasoningEffort: text('reasoning_effort'),
  // Provider-neutral user intent. Vertex Gemini fulfills it with the native
  // googleSearch tool; other providers can fall back to the designated MCP.
  webSearch: integer('web_search').notNull().default(0),
  mcpServerIds: text('mcp_server_ids').notNull().default('[]'), // JSON string[]
  // The leaf message of the branch currently on screen. Messages form a tree
  // (see messages.parentId); the visible conversation is the root→leaf chain
  // ending here. null = fall back to the newest message.
  currentLeafId: text('current_leaf_id'),
  pinned: integer('pinned').notNull().default(0),
  // Archived chats leave the sidebar's normal sections for a collapsed 归档
  // shelf. New activity in the chat un-archives it automatically.
  archived: integer('archived').notNull().default(0),
  // 临时对话: hidden from the chat list and search, swept (with uploads) after
  // a TTL of inactivity. Clearing the flag "saves" it as a normal chat.
  temporary: integer('temporary').notNull().default(0),
  // 工作区: a private per-chat directory (data/workspaces/<chatId>) the model
  // reads and writes through in-process tools, so long deliverables live in
  // files it can revise in place instead of being re-emitted every turn.
  workspace: integer('workspace').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_chats_user').on(t.userId, t.updatedAt)]);

// 上下文压缩: the summary that stands in for the older part of a branch once
// it outgrows the model's history budget. Anchored to the last message it
// covers, so it only applies to branches that run through that message.
export const chatSummaries = sqliteTable('chat_summaries', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  upToMessageId: text('up_to_message_id').notNull(),
  summary: text('summary').notNull(),
  // Messages folded in so far, earlier summaries included.
  covered: integer('covered').notNull().default(0),
  model: text('model'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_chat_summaries_chat').on(t.chatId, t.createdAt)]);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  // Monotonic per-chat ordering key. createdAt is millisecond-granular and
  // collides between messages written in the same request, which makes it
  // unusable for "delete everything after message X".
  seq: integer('seq').notNull().default(0),
  // Tree link: the message this one replies to (null = conversation root).
  // Regenerating a reply or editing a user message inserts a SIBLING (same
  // parentId) instead of deleting history — every version stays switchable.
  // Kept loose (no FK) so legacy rows and imports can't fail the constraint.
  parentId: text('parent_id'),
  role: text('role').notNull(), // 'user' | 'assistant'
  parts: text('parts').notNull().default('[]'), // JSON MessagePart[]
  model: text('model'),
  providerId: text('provider_id'),
  status: text('status').notNull().default('done'), // 'done' | 'error' | 'stopped' | 'streaming'
  // Provider stop reason of the last model turn ('stop' | 'length' | 'content_filter' | 'other' | 'tool_calls'),
  // or 'incomplete' (route-assigned: done reply with no visible body / no proper finish signal).
  // 'length' / 'content_filter' / 'incomplete' on a 'done' row = the reply was cut short.
  finishReason: text('finish_reason'),
  error: text('error'),
  errorCode: text('error_code'), // 'provider_busy' | null
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  durationMs: integer('duration_ms'),
  ttftMs: integer('ttft_ms'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_messages_chat').on(t.chatId, t.seq)]);

// 收藏的消息. One row per (user, message); a chat is single-owner so the user
// column is redundant for access checks but gives the 收藏 page one indexed
// scan. Rows vanish with their message or chat.
export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('idx_bookmarks_user_message').on(t.userId, t.messageId),
  index('idx_bookmarks_user').on(t.userId, t.createdAt),
]);

export const usageLog = sqliteTable('usage_log', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  chatId: text('chat_id'),
  messageId: text('message_id'),
  providerId: text('provider_id'),
  providerType: text('provider_type'),
  model: text('model'),
  kind: text('kind').notNull(), // 'chat' | 'image' | 'title'
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  images: integer('images').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  day: text('day').notNull(), // YYYY-MM-DD (local server time)
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_usage_user_day').on(t.userId, t.day), index('idx_usage_day').on(t.day)]);

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull(), // 'stdio' | 'http' | 'sse'
  command: text('command'),
  args: text('args').notNull().default('[]'), // JSON string[]
  envEnc: text('env_enc'), // AES-256-GCM encrypted JSON Record<string,string>
  url: text('url'),
  headersEnc: text('headers_enc'), // AES-256-GCM encrypted JSON Record<string,string>
  enabled: integer('enabled').notNull().default(1),
  accessMode: text('access_mode').notNull().default('shared'), // 'shared' | 'restricted'
  // Ask the person before running any tool from this server. The turn pauses
  // on a tool_confirm SSE event until they allow or deny each call (see
  // chats.ts / tool-confirm.ts). For file, shell and other side-effecting
  // servers; a search server should leave it off.
  confirmCalls: integer('confirm_calls').notNull().default(0),
  lastStatus: text('last_status'), // 'ok' | 'error' | null(untested)
  lastError: text('last_error'),
  toolsCache: text('tools_cache').notNull().default('[]'), // JSON cached tool list
  createdAt: integer('created_at').notNull(),
});

// Shared MCP servers are available to every active account. Restricted servers
// require an explicit ordinary-user grant; admins always retain implicit access.
// The composite primary key also makes grant replacement idempotent.
export const mcpServerAccess = sqliteTable('mcp_server_access', {
  serverId: text('server_id').notNull().references(() => mcpServers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.serverId, t.userId] }),
  index('idx_mcp_access_user').on(t.userId),
]);

export const images = sqliteTable('images', {
  generationSettings: text('generation_settings'),
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id'),
  model: text('model'),
  // Where the image was born: 'workshop' (绘图工坊) or 'chat' (对话中作图).
  // The two carry separate retention policies — a chat image disappearing
  // breaks a conversation, a workshop image expiring just trims the gallery.
  source: text('source').notNull().default('workshop'),
  prompt: text('prompt').notNull(),
  size: text('size'),
  filename: text('filename').notNull(),
  byteSize: integer('byte_size').notNull().default(0),
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_images_user').on(t.userId, t.createdAt)]);

// Generated slide decks. The deck itself is a JSON spec (DeckSpec) — the .pptx
// file is assembled from it on every download rather than stored, so the only
// disk cost per deck is a few KB of JSON in this row.
export const decks = sqliteTable('decks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id'),
  model: text('model'),
  topic: text('topic').notNull(),
  title: text('title').notNull().default(''),
  spec: text('spec').notNull(), // JSON DeckSpec
  slideCount: integer('slide_count').notNull().default(0),
  totalTokens: integer('total_tokens'),
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_decks_user').on(t.userId, t.createdAt)]);

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(), // stored name on disk
  origName: text('orig_name'),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  // Plain-text rendition of a binary document the server can't parse itself
  // (PDF, .doc, .xlsx …), carried over from Open WebUI's extraction at import
  // time. When present the model reads this instead of the bytes, so the
  // document works on every provider and stays out of the media budget.
  extractedText: text('extracted_text'),
  createdAt: integer('created_at').notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON
});

// 沙盒执行审计: one row per run_command the model executed, so an admin can
// see who ran what, how long it took, and whether it hit the limits.
export const sandboxRuns = sqliteTable('sandbox_runs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chatId: text('chat_id'),
  messageId: text('message_id'),
  command: text('command').notNull(),
  exitCode: integer('exit_code'),
  timedOut: integer('timed_out').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  outputChars: integer('output_chars').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_sandbox_runs_created').on(t.createdAt)]);

// 技能 (Agent Skills): a directory under data/skills/<slug> holding SKILL.md
// (frontmatter name/description + instructions) plus optional scripts and
// reference files. The row carries what the prompt and ACL need; the files
// on disk are the source of truth for content.
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(), // directory name == frontmatter name
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  enabled: integer('enabled').notNull().default(1),
  accessMode: text('access_mode').notNull().default('shared'), // 'shared' | 'restricted'
  allowedUserIds: text('allowed_user_ids').notNull().default('[]'), // JSON string[]
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
