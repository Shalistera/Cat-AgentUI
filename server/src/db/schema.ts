import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'), // 'admin' | 'user'
  displayName: text('display_name'),
  disabled: integer('disabled').notNull().default(0),
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
  vertexLocation: text('vertex_location'),
  vertexSaJsonEnc: text('vertex_sa_json_enc'), // encrypted service account JSON
  extraHeaders: text('extra_headers').notNull().default('{}'), // JSON
  // Optional custom avatar as a data URI. null = fall back to the built-in
  // brand mark for this provider's type. Stored inline rather than on disk so
  // it survives a plain db copy and needs no cleanup path.
  avatar: text('avatar'),
  enabled: integer('enabled').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const models = sqliteTable('models', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(), // API model name, e.g. gpt-4o
  displayName: text('display_name'),
  vision: integer('vision').notNull().default(1),
  tools: integer('tools').notNull().default(1),
  imageGen: integer('image_gen').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  isDefault: integer('is_default').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  modelId: text('model_id'), // references models.id, kept loose so model deletion doesn't break chats
  systemPrompt: text('system_prompt'),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  // 'off' | 'low' | 'medium' | 'high'; null = off. Adapters translate this to
  // whatever each vendor calls it (effort level vs. thinking token budget).
  reasoningEffort: text('reasoning_effort'),
  mcpServerIds: text('mcp_server_ids').notNull().default('[]'), // JSON string[]
  pinned: integer('pinned').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_chats_user').on(t.userId, t.updatedAt)]);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  // Monotonic per-chat ordering key. createdAt is millisecond-granular and
  // collides between messages written in the same request, which makes it
  // unusable for "delete everything after message X".
  seq: integer('seq').notNull().default(0),
  role: text('role').notNull(), // 'user' | 'assistant'
  parts: text('parts').notNull().default('[]'), // JSON MessagePart[]
  model: text('model'),
  providerId: text('provider_id'),
  status: text('status').notNull().default('done'), // 'done' | 'error' | 'stopped' | 'streaming'
  error: text('error'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  durationMs: integer('duration_ms'),
  ttftMs: integer('ttft_ms'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_messages_chat').on(t.chatId, t.seq)]);

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
  lastStatus: text('last_status'), // 'ok' | 'error' | null(untested)
  lastError: text('last_error'),
  toolsCache: text('tools_cache').notNull().default('[]'), // JSON cached tool list
  createdAt: integer('created_at').notNull(),
});

export const images = sqliteTable('images', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id'),
  model: text('model'),
  prompt: text('prompt').notNull(),
  size: text('size'),
  filename: text('filename').notNull(),
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_images_user').on(t.userId, t.createdAt)]);

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(), // stored name on disk
  origName: text('orig_name'),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON
});
