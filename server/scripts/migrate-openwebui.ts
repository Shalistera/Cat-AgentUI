// Import users and chat history from an Open WebUI instance (webui.db).
//
// Usage:
//   npm run db:import-openwebui -w server -- --db /path/to/webui.db [options]
//
// Options:
//   --db <path>          Open WebUI 的 webui.db(必填)
//   --data-dir <path>    Open WebUI 的 data 目录(可选,用于搬运聊天附件/生成图片)
//   --dry-run            只报告将要迁移的内容,不写入
//   --skip-archived      跳过已归档的会话(默认全部迁入)
//
// What migrates:
//   user + auth  → users      (登录名 = 邮箱小写;bcrypt/argon2 哈希原样保留,
//                              首次登录时由 verifyPassword 兼容验证并自动升级为 scrypt)
//   chat         → chats + messages(取当前活跃分支;reasoning/tool_calls 解析为 parts)
//   附件图片      → uploads/images 目录 + uploads 表(需 --data-dir)
//
// Re-running is safe: existing ids/usernames are skipped (merge semantics).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db, schema, now } from '../src/db/index.js';
import { config } from '../src/config.js';
import type { MessagePart } from '../src/types.js';

// ---------- CLI args ----------

function parseArgs(argv: string[]) {
  const out: { db?: string; dataDir?: string; dryRun: boolean; skipArchived: boolean } = {
    dryRun: false, skipArchived: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-archived') out.skipArchived = true;
    else { console.error(`未知参数: ${a}`); process.exit(1); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) {
  console.error('用法: npm run db:import-openwebui -w server -- --db /path/to/webui.db [--data-dir /path/to/open-webui/data] [--dry-run] [--skip-archived]');
  process.exit(1);
}
if (!fs.existsSync(args.db)) {
  console.error(`找不到数据库文件: ${args.db}`);
  process.exit(1);
}

const src = new Database(args.db, { readonly: true, fileMustExist: true });

// ---------- source row shapes (Open WebUI) ----------

interface OwuiUser {
  id: string; email: string | null; name: string | null; username?: string | null;
  role: string | null; created_at: number | null; last_active_at: number | null;
  password: string | null; // joined from auth
  active: number | null;   // joined from auth (0/1/null)
}

interface OwuiChat {
  id: string; user_id: string; title: string | null; chat: string | null;
  created_at: number | null; updated_at: number | null;
  archived: number | null; pinned: number | null;
}

interface OwuiFileRow { id: string; filename: string | null; path: string | null; meta: string | null }

// Open WebUI stores epoch seconds in some tables/versions and nanoseconds or
// milliseconds crept into others; normalize anything plausible to ms.
function toMs(ts: number | null | undefined, fallback: number): number {
  if (!ts || !Number.isFinite(ts)) return fallback;
  if (ts > 1e14) return Math.round(ts / 1e6); // ns
  if (ts > 1e12) return Math.round(ts);       // already ms
  return Math.round(ts * 1000);               // s
}

function tableExists(name: string): boolean {
  return !!src.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnExists(table: string, col: string): boolean {
  const rows = src.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

// ---------- message extraction ----------

interface OwuiMessage {
  id?: string; role?: string; content?: unknown; timestamp?: number;
  parentId?: string | null; childrenIds?: string[];
  model?: string; models?: string[]; files?: OwuiMsgFile[];
  output?: OwuiOutputItem[];
  usage?: Record<string, unknown>; info?: Record<string, unknown>;
}

interface OwuiMsgFile {
  type?: string; url?: string; id?: string; name?: string;
  file?: { id?: string; filename?: string; meta?: { content_type?: string } };
  // image generation results ride as {type:'image', url:'/cache/image/generations/...'}
}

interface OwuiOutputItem {
  type?: string; // 'message' | 'reasoning' | 'tool_call' | function call variants
  role?: string;
  content?: unknown; // list of {type,text} or string
  summary?: unknown;
  id?: string; name?: string; arguments?: unknown; result?: unknown;
  // Responses-API style fields
  call_id?: string; output?: unknown;
}

// Walk the history tree from the current leaf back to the root → linear branch.
// Mirrors Open WebUI's own repair logic when currentId is missing/stale: pick
// the newest childless message as the leaf. Real-world webui.db files contain
// broken trees (server-side writes drop parentId), so the flat chat.messages
// list is extracted too and whichever source is more complete wins.
function extractBranch(chatJson: Record<string, unknown>): OwuiMessage[] {
  let fromTree: OwuiMessage[] = [];
  const history = chatJson?.history as { messages?: Record<string, OwuiMessage>; currentId?: string } | undefined;
  const map = history?.messages;
  if (map && typeof map === 'object' && Object.keys(map).length) {
    let leafId = history?.currentId;
    const valid = (id: string | undefined | null): id is string =>
      !!id && !!map[id] && typeof map[id] === 'object' && !!map[id].role;
    if (!valid(leafId)) {
      let bestTs = -1; let best: string | undefined;
      for (const [id, m] of Object.entries(map)) {
        if (!m || typeof m !== 'object' || !m.role) continue;
        const kids = Array.isArray(m.childrenIds) ? m.childrenIds : [];
        const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
        if (kids.length === 0 && ts >= bestTs) { bestTs = ts; best = id; }
      }
      leafId = best;
    }
    if (valid(leafId)) {
      const chain: OwuiMessage[] = [];
      const seen = new Set<string>();
      let cur: string | undefined | null = leafId;
      while (cur && map[cur] && !seen.has(cur)) {
        seen.add(cur);
        chain.push(map[cur]);
        cur = map[cur].parentId;
      }
      chain.reverse();
      fromTree = chain;
    }
  }
  const list = chatJson?.messages;
  const fromList = Array.isArray(list)
    ? (list as OwuiMessage[]).filter((m) => m && typeof m === 'object' && !!m.role)
    : [];
  // A healthy branch starts at a user message. When the tree walk delivers one,
  // trust it (the flat list may contain extra siblings from edits/regenerates).
  // When the chain is broken — real webui.db files contain assistant messages
  // whose parentId was dropped by server-side writes — fall back to the flat
  // chat.messages list, which the frontend maintains as the active branch.
  // Either way the map holds the freshest server-side write of each message
  // (the list may keep an empty pre-stream stub), so resolve bodies through it.
  const treeHealthy = fromTree.length > 0 && fromTree[0].role === 'user';
  const chosen = treeHealthy || fromTree.length >= fromList.length ? fromTree : fromList;
  return chosen.map((m) => {
    const fresh = m.id && map ? map[m.id] : undefined;
    const hasBody = (x?: OwuiMessage) => !!x && (!!x.content || (Array.isArray(x.output) && x.output.length > 0));
    return fresh && hasBody(fresh) && !hasBody(m) ? fresh : m;
  });
}

// -- content string parsing (old-style inline <details> blocks) --

const DETAILS_RE = /<details\b([^>]*)>([\s\S]*?)<\/details>\s*/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = unescapeHtml(m[2]);
  return out;
}

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// "> line" blockquote → plain text (Open WebUI stores reasoning blockquoted)
function unquoteReasoning(s: string): string {
  return s.split('\n').map((l) => l.replace(/^\s*>\s?/, '')).join('\n')
    .replace(/^\s*<summary>[\s\S]*?<\/summary>\s*/,'').trim();
}

function pushText(parts: MessagePart[], type: 'text' | 'reasoning', text: string) {
  const t = text ?? '';
  if (!t.trim()) return;
  const last = parts[parts.length - 1];
  if (last && last.type === type) (last as { text: string }).text += t;
  else parts.push({ type, text: t } as MessagePart);
}

let toolSeq = 0;

function detailsToParts(attrs: Record<string, string>, inner: string, parts: MessagePart[]) {
  const kind = attrs.type ?? '';
  if (kind === 'reasoning' || kind === 'thinking') {
    pushText(parts, 'reasoning', unquoteReasoning(inner));
    return;
  }
  if (kind === 'tool_calls') {
    // attrs: name, arguments (JSON), result (JSON), id — result may be absent when interrupted
    const id = attrs.id || `owui_tool_${++toolSeq}`;
    const name = attrs.name || 'tool';
    if (attrs.done === 'false' && attrs.result === undefined) {
      // interrupted call — represent as text so we don't fabricate a dangling tool_call
      pushText(parts, 'text', `\n(工具 ${name} 调用未完成)\n`);
      return;
    }
    parts.push({ type: 'tool_call', id, name, args: attrs.arguments ?? '{}' });
    parts.push({
      type: 'tool_result', toolCallId: id, name,
      result: attrs.result !== undefined ? String(attrs.result) : '',
    });
    return;
  }
  if (kind === 'code_interpreter') {
    // keep the code visible as text; execution output lives in `result`-ish attrs
    pushText(parts, 'text', `\n${inner.replace(/<summary>[\s\S]*?<\/summary>/, '').trim()}\n`);
    return;
  }
  // citations / unknown details — keep inner text, drop the wrapper
  const cleaned = inner.replace(/<summary>[\s\S]*?<\/summary>/, '').trim();
  if (cleaned) pushText(parts, 'text', `\n${cleaned}\n`);
}

function contentStringToParts(content: string, parts: MessagePart[]) {
  let lastIndex = 0;
  DETAILS_RE.lastIndex = 0;
  for (let m = DETAILS_RE.exec(content); m; m = DETAILS_RE.exec(content)) {
    pushText(parts, 'text', content.slice(lastIndex, m.index));
    detailsToParts(parseAttrs(m[1]), m[2], parts);
    lastIndex = DETAILS_RE.lastIndex;
  }
  pushText(parts, 'text', content.slice(lastIndex));
}

// -- 0.11+ structured `output` items --

function outputItemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? p?.output_text ?? ''))).join('');
  }
  return '';
}

function outputToParts(output: OwuiOutputItem[], parts: MessagePart[]): boolean {
  let producedText = false;
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const t = item.type ?? '';
    if (t === 'reasoning') {
      const text = outputItemText(item.content) || outputItemText(item.summary);
      pushText(parts, 'reasoning', text);
    } else if (t === 'message') {
      pushText(parts, 'text', outputItemText(item.content));
      producedText = true;
    } else if (t === 'tool_call' || t === 'function_call' || t === 'tool_calls') {
      const id = item.call_id || item.id || `owui_tool_${++toolSeq}`;
      const name = item.name || 'tool';
      const argsStr = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      const resVal = item.result ?? item.output;
      parts.push({ type: 'tool_call', id, name, args: argsStr });
      parts.push({
        type: 'tool_result', toolCallId: id, name,
        result: typeof resVal === 'string' ? resVal : JSON.stringify(resVal ?? ''),
      });
    }
    // other item types (status, citations…) are presentation-only; skip
  }
  return producedText;
}

// ---------- attachment migration ----------

const report = {
  users: { migrated: 0, merged: 0, renamed: [] as string[], noPassword: [] as string[] },
  chats: { migrated: 0, skipped: 0, existing: 0 },
  messages: { migrated: 0 },
  files: { copied: 0, inlined: 0, missing: [] as string[], nonImage: [] as string[] },
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

const fileRowById = tableExists('file')
  ? (() => {
      const stmt = src.prepare(`SELECT id, filename, path, meta FROM file WHERE id = ?`);
      return (id: string) => stmt.get(id) as OwuiFileRow | undefined;
    })()
  : () => undefined;

interface PendingUpload { uploadId: string; filename: string; mime: string; size: number; data: Buffer; origName: string | null }

// Resolve an Open WebUI message file to image bytes. Sources, in order:
//   data: URL (inline base64) → decode
//   /api/v1/files/{id}/content → file table row → physical file under --data-dir
//   /cache/... (image generations) → --data-dir/cache/...
function resolveFile(f: OwuiMsgFile): { mime: string; data: Buffer; origName: string | null } | null {
  const url = f.url ?? '';
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return { mime, data, origName: f.name ?? null };
  }
  const fileId = f.id ?? f.file?.id ?? /\/api\/v1\/files\/([^/]+)/.exec(url)?.[1];
  if (fileId) {
    const row = fileRowById(fileId);
    if (row) {
      let meta: { content_type?: string; name?: string } = {};
      try { meta = JSON.parse(row.meta ?? '{}'); } catch { /* ignore */ }
      const candidates: string[] = [];
      if (row.path) {
        candidates.push(row.path);
        if (args.dataDir) {
          // stored paths look like "data/uploads/xxx" or absolute paths from the old box
          candidates.push(path.join(args.dataDir, row.path.replace(/^.*?data\//, '')));
          candidates.push(path.join(args.dataDir, 'uploads', path.basename(row.path)));
        }
      } else if (args.dataDir && row.filename) {
        candidates.push(path.join(args.dataDir, 'uploads', `${row.id}_${row.filename}`));
      }
      for (const p of candidates) {
        try {
          if (p && fs.existsSync(p)) {
            return {
              mime: meta.content_type || 'application/octet-stream',
              data: fs.readFileSync(p),
              origName: meta.name ?? row.filename ?? null,
            };
          }
        } catch { /* try next */ }
      }
      report.files.missing.push(fileId);
      return null;
    }
    report.files.missing.push(fileId);
    return null;
  }
  if (url.startsWith('/cache/') && args.dataDir) {
    const p = path.join(args.dataDir, url.replace(/^\//, ''));
    if (fs.existsSync(p)) {
      const ext = path.extname(p).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
      return { mime, data: fs.readFileSync(p), origName: path.basename(p) };
    }
    report.files.missing.push(url);
    return null;
  }
  if (url) report.files.missing.push(url.slice(0, 80));
  return null;
}

// ---------- main migration ----------

console.log(`源库: ${args.db}`);

// A copied webui.db without its -wal sidecar looks valid but reads empty/stale.
{
  const walPath = `${args.db}-wal`;
  const userCount = (src.prepare('SELECT count(*) c FROM user').get() as { c: number }).c;
  if (userCount === 0) {
    console.error('⚠ 源库里没有任何用户。若这是从别处拷贝的 webui.db,请连同 webui.db-wal / webui.db-shm 一起拷贝,');
    console.error('  或先在源机器上执行 `sqlite3 webui.db "PRAGMA wal_checkpoint(TRUNCATE)"` 再拷贝。');
    if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
      console.error(`  (检测到 ${walPath} 存在且非空——数据很可能都在 WAL 里)`);
    }
    process.exit(1);
  }
}
const hasUsernameCol = columnExists('user', 'username');
const users = src.prepare(`
  SELECT u.id, u.email, u.name, ${hasUsernameCol ? 'u.username,' : ''} u.role, u.created_at, u.last_active_at,
         a.password, a.active
  FROM user u LEFT JOIN auth a ON a.id = u.id
`).all() as OwuiUser[];

const chatWhere = args.skipArchived ? 'WHERE archived IS NOT 1' : '';
const chatsRows = src.prepare(`
  SELECT id, user_id, title, chat, created_at, updated_at, archived, pinned
  FROM chat ${chatWhere} ORDER BY created_at
`).all() as OwuiChat[];

console.log(`发现 ${users.length} 个用户,${chatsRows.length} 个会话${args.skipArchived ? '(已跳过归档)' : ''}`);

// user id mapping: owui user id → Cat user id (existing user on username conflict)
const userIdMap = new Map<string, string>();
const pendingUsers: (typeof schema.users.$inferInsert)[] = [];

const existingByUsername = new Map<string, { id: string }>();
const existingById = new Set<string>();
for (const u of db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).all()) {
  existingByUsername.set(u.username, { id: u.id });
  existingById.add(u.id);
}

for (const u of users) {
  // Re-run identity: first migration keeps the Open WebUI uuid as the Cat user
  // id, so an id hit means "already migrated" regardless of email/rename state.
  if (existingById.has(u.id)) {
    userIdMap.set(u.id, u.id);
    report.users.merged++;
    continue;
  }
  // Merge into an existing account ONLY on email identity — emails are unique
  // in Open WebUI. Fallback names (OAuth users without email) are NOT unique,
  // so a collision there gets a fresh uniquified username instead; silently
  // merging by display name would hand one person's chats to another.
  const email = (u.email ?? '').trim().toLowerCase();
  let username = email || (u.username ?? u.name ?? '').trim().toLowerCase() || u.id;
  const existing = existingByUsername.get(username);
  if (existing) {
    if (email) {
      userIdMap.set(u.id, existing.id);
      report.users.merged++;
      continue;
    }
    const alt = `${username}.${u.id.slice(0, 8)}`;
    const finalName = existingByUsername.has(alt) ? u.id : alt;
    report.users.renamed.push(`${username} → ${finalName}`);
    username = finalName;
  }
  const id = existingById.has(u.id) ? crypto.randomUUID() : u.id;
  existingById.add(id);
  const hasPassword = !!u.password && u.password.length > 0;
  if (!hasPassword) report.users.noPassword.push(username);
  const role = u.role === 'admin' ? 'admin' : 'user';
  const disabled = u.role === 'pending' || u.active === 0 ? 1 : 0;
  pendingUsers.push({
    id, username,
    // '!' 开头的哈希无法匹配任何格式 → 账号存在但不可登录,管理员可重置
    passwordHash: hasPassword ? u.password! : '!openwebui-oauth-no-password',
    role, disabled,
    displayName: u.name ?? null,
    settings: '{}',
    createdAt: toMs(u.created_at, now()),
    lastActiveAt: u.last_active_at ? toMs(u.last_active_at, now()) : null,
  });
  userIdMap.set(u.id, id);
  existingByUsername.set(username, { id });
  report.users.migrated++;
}

// chats + messages
const existingChatIds = new Set(db.select({ id: schema.chats.id }).from(schema.chats).all().map((c) => c.id));
// Ownership must survive re-runs: without it a second pass would treat every
// upload migrated last time as foreign and duplicate the file under a new id.
const uploadOwner = new Map<string, string>(); // uploadId → cat userId
for (const u of db.select({ id: schema.uploads.id, userId: schema.uploads.userId }).from(schema.uploads).all()) {
  uploadOwner.set(u.id, u.userId);
}
const existingUploadIds = new Set(uploadOwner.keys());

const pendingChats: (typeof schema.chats.$inferInsert)[] = [];
const pendingMessages: (typeof schema.messages.$inferInsert)[] = [];
const pendingUploads: PendingUpload[] = [];

for (const c of chatsRows) {
  const catUserId = userIdMap.get(c.user_id);
  if (!catUserId) { report.chats.skipped++; continue; }
  if (existingChatIds.has(c.id)) { report.chats.existing++; continue; }

  let chatJson: Record<string, unknown> = {};
  try { chatJson = JSON.parse(c.chat ?? '{}'); } catch { report.chats.skipped++; continue; }

  const branch = extractBranch(chatJson);
  const chatCreated = toMs(c.created_at, now());
  const chatUpdated = toMs(c.updated_at, chatCreated);

  const params = (chatJson.params ?? {}) as Record<string, unknown>;
  pendingChats.push({
    id: c.id,
    userId: catUserId,
    title: (c.title ?? '').slice(0, 300) || '(无标题)',
    modelId: null, // Open WebUI 的模型名对不上本站的模型配置;进入会话后重新选择即可
    systemPrompt: typeof params.system === 'string' && params.system.trim() ? params.system : null,
    temperature: typeof params.temperature === 'number' ? params.temperature : null,
    maxTokens: typeof params.max_tokens === 'number' ? params.max_tokens : null,
    reasoningEffort: null,
    mcpServerIds: '[]',
    pinned: c.pinned ? 1 : 0,
    createdAt: chatCreated,
    updatedAt: chatUpdated,
  });
  existingChatIds.add(c.id);
  report.chats.migrated++;

  let seq = 0;
  let lastTs = chatCreated; // fallback for messages without a timestamp
  for (const m of branch) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue; // system entries live in params.system already

    const parts: MessagePart[] = [];

    // attachments (user uploads / generated images) go first, like our UI does
    for (const f of Array.isArray(m.files) ? m.files : []) {
      const resolved = resolveFile(f);
      if (!resolved) {
        if (f.name || f.file?.filename) pushText(parts, 'text', `(附件: ${f.name ?? f.file?.filename})\n`);
        continue;
      }
      if (!EXT_BY_MIME[resolved.mime]) {
        // Cat 只支持图片附件;文档类附件降级为文字说明
        report.files.nonImage.push(resolved.origName ?? resolved.mime);
        pushText(parts, 'text', `(附件: ${resolved.origName ?? '文件'},未随迁移导入)\n`);
        continue;
      }
      let uploadId = f.id ?? f.file?.id ?? crypto.randomUUID();
      if (existingUploadIds.has(uploadId) && uploadOwner.get(uploadId) !== catUserId) {
        uploadId = crypto.randomUUID();
      }
      if (!existingUploadIds.has(uploadId)) {
        pendingUploads.push({
          uploadId,
          filename: `${uploadId}.${EXT_BY_MIME[resolved.mime]}`,
          mime: resolved.mime,
          size: resolved.data.length,
          data: resolved.data,
          origName: resolved.origName,
        });
        existingUploadIds.add(uploadId);
        uploadOwner.set(uploadId, catUserId);
        report.files[f.url?.startsWith('data:') ? 'inlined' : 'copied']++;
      }
      parts.push({ type: 'image', uploadId, mime: resolved.mime });
    }

    // body
    let handled = false;
    if (role === 'assistant' && Array.isArray(m.output) && m.output.length) {
      handled = outputToParts(m.output, parts);
      // 0.11 dual-writes plain text into content as well — only fall back to
      // content when output produced no message text (older partial writes)
    }
    if (!handled) {
      const content = m.content;
      if (typeof content === 'string' && content.length) {
        contentStringToParts(content, parts);
      } else if (Array.isArray(content)) {
        // multi-modal user content: [{type:'text',text}, {type:'image_url',...}]
        for (const p of content) {
          if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
            pushText(parts, 'text', p.text);
          }
        }
      }
    }

    if (!parts.length) continue;

    const usage = (m.usage ?? m.info ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    const promptTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
    const completionTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);

    seq += 1;
    pendingMessages.push({
      id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
      chatId: c.id,
      seq,
      role,
      parts: JSON.stringify(parts),
      model: typeof m.model === 'string' ? m.model : null,
      providerId: null,
      status: 'done',
      error: null,
      promptTokens,
      completionTokens,
      totalTokens: num(usage.total_tokens) ?? (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null),
      durationMs: null,
      ttftMs: null,
      createdAt: lastTs = toMs(m.timestamp ?? null, lastTs),
    });
    report.messages.migrated++;
  }
}

// message ids must be globally unique; regenerate colliding ones
{
  const existingMsgIds = new Set(db.select({ id: schema.messages.id }).from(schema.messages).all().map((m) => m.id));
  const seen = new Set<string>();
  for (const m of pendingMessages) {
    if (existingMsgIds.has(m.id) || seen.has(m.id)) m.id = crypto.randomUUID();
    seen.add(m.id);
  }
}

// ---------- report & write ----------

console.log('');
console.log(`用户: 新迁入 ${report.users.migrated},合并到已有账号 ${report.users.merged},改名 ${report.users.renamed.length}`);
if (report.users.renamed.length) {
  console.log(`  ⚠ 以下账号无邮箱且用户名与他人冲突,已改名(不合并,避免聊天记录错归):`);
  for (const n of report.users.renamed) console.log(`    - ${n}`);
}
if (report.users.noPassword.length) {
  console.log(`  ⚠ 以下账号在 Open WebUI 中无本地密码(OAuth/LDAP 登录),已迁入但暂不可登录,请管理员在后台重置密码:`);
  for (const n of report.users.noPassword) console.log(`    - ${n}`);
}
console.log(`会话: 迁入 ${report.chats.migrated},已存在跳过 ${report.chats.existing},无法解析/无归属跳过 ${report.chats.skipped}`);
console.log(`消息: ${report.messages.migrated} 条`);
console.log(`附件: 复制 ${report.files.copied},内联解码 ${report.files.inlined},缺失 ${report.files.missing.length},非图片降级 ${report.files.nonImage.length}`);
if (report.files.missing.length && !args.dataDir) {
  console.log('  提示: 传入 --data-dir /path/to/open-webui/data 可搬运附件文件');
}

if (args.dryRun) {
  console.log('\n(dry-run,未写入任何数据)');
  process.exit(0);
}

const uploadsDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Files land on disk before the DB transaction: a failed run leaves harmless
// orphan files, never DB rows pointing at files that were never written — and
// on failure the files written this run are removed again below.
try {
  for (const f of pendingUploads) {
    fs.writeFileSync(path.join(uploadsDir, f.filename), f.data);
  }
  db.transaction((tx) => {
    for (const u of pendingUsers) tx.insert(schema.users).values(u).run();
    for (const c of pendingChats) tx.insert(schema.chats).values(c).run();
    for (const m of pendingMessages) tx.insert(schema.messages).values(m).run();
    for (const f of pendingUploads) {
      tx.insert(schema.uploads).values({
        id: f.uploadId,
        userId: uploadOwner.get(f.uploadId)!,
        filename: f.filename,
        origName: f.origName,
        mime: f.mime,
        size: f.size,
        createdAt: now(),
      }).run();
    }
  });
} catch (err) {
  for (const f of pendingUploads) {
    try { fs.unlinkSync(path.join(uploadsDir, f.filename)); } catch { /* ignore */ }
  }
  console.error('\n❌ 写入失败,事务已整体回滚,本轮没有任何数据落库。上方计数仅为预检结果。');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log('\n迁移完成 ✅');
console.log('迁入用户用原来的邮箱 + 原密码即可登录;首次登录后密码会自动升级为本站格式。');
src.close();
