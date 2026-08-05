// Import users and chat history from an Open WebUI webui.db into our database.
// Used by the admin UI (POST /api/admin/import/openwebui) and the CLI wrapper
// (server/scripts/migrate-openwebui.ts).
//
// What migrates:
//   user + auth  → users      (登录名 = 邮箱小写;bcrypt/argon2 哈希原样保留,
//                              首次登录时由 verifyPassword 兼容验证并自动升级为 scrypt)
//   chat         → chats + messages(取当前活跃分支;reasoning/tool_calls 解析为 parts)
//   附件图片      → uploads 目录 + uploads 表(需提供 Open WebUI 的 data 目录)
//
// Re-running is safe: users are recognised by id/email, existing chats and
// uploads are skipped (merge semantics).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, schema, now } from './db/index.js';
import { config } from './config.js';
import type { MessagePart } from './types.js';

export interface OwuiImportOptions {
  dbPath: string;
  dataDir?: string | null; // Open WebUI data dir, for physical attachment files
  dryRun?: boolean;
  skipArchived?: boolean;
}

export interface OwuiImportReport {
  sourceUsers: number;
  sourceChats: number;
  users: { migrated: number; merged: number; renamed: string[]; noPassword: string[] };
  chats: { migrated: number; skipped: number; existing: number };
  messages: { migrated: number };
  files: { copied: number; inlined: number; missing: string[]; nonImage: string[] };
  dryRun: boolean;
}

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

// ---------- pure helpers ----------

// Open WebUI stores epoch seconds in some tables/versions and nanoseconds or
// milliseconds crept into others; normalize anything plausible to ms.
function toMs(ts: number | null | undefined, fallback: number): number {
  if (!ts || !Number.isFinite(ts)) return fallback;
  if (ts > 1e14) return Math.round(ts / 1e6); // ns
  if (ts > 1e12) return Math.round(ts);       // already ms
  return Math.round(ts * 1000);               // s
}

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
    .replace(/^\s*<summary>[\s\S]*?<\/summary>\s*/, '').trim();
}

function pushText(parts: MessagePart[], type: 'text' | 'reasoning', text: string) {
  const t = text ?? '';
  if (!t.trim()) return;
  const last = parts[parts.length - 1];
  if (last && last.type === type) (last as { text: string }).text += t;
  else parts.push({ type, text: t } as MessagePart);
}

function outputItemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? p?.output_text ?? ''))).join('');
  }
  return '';
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
  // When the chain is broken, fall back to the flat chat.messages list, which
  // the frontend maintains as the active branch. Either way the map holds the
  // freshest server-side write of each message (the list may keep an empty
  // pre-stream stub), so resolve bodies through it.
  const treeHealthy = fromTree.length > 0 && fromTree[0].role === 'user';
  const chosen = treeHealthy || fromTree.length >= fromList.length ? fromTree : fromList;
  return chosen.map((m) => {
    const fresh = m.id && map ? map[m.id] : undefined;
    const hasBody = (x?: OwuiMessage) => !!x && (!!x.content || (Array.isArray(x.output) && x.output.length > 0));
    return fresh && hasBody(fresh) && !hasBody(m) ? fresh : m;
  });
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

interface PendingUpload { uploadId: string; filename: string; mime: string; size: number; data: Buffer; origName: string | null }

// ---------- main ----------

export function importOpenwebui(opts: OwuiImportOptions): OwuiImportReport {
  const { dbPath, dataDir, dryRun = false, skipArchived = false } = opts;
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库文件: ${dbPath}`);
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const tableExists = (name: string): boolean =>
      !!src.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    const columnExists = (table: string, col: string): boolean => {
      const rows = src.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[];
      return rows.some((r) => r.name === col);
    };

    if (!tableExists('user') || !tableExists('chat')) {
      throw new Error('这不是 Open WebUI 的数据库(缺少 user/chat 表)');
    }

    const report: OwuiImportReport = {
      sourceUsers: 0, sourceChats: 0,
      users: { migrated: 0, merged: 0, renamed: [], noPassword: [] },
      chats: { migrated: 0, skipped: 0, existing: 0 },
      messages: { migrated: 0 },
      files: { copied: 0, inlined: 0, missing: [], nonImage: [] },
      dryRun,
    };

    // A copied webui.db without its -wal sidecar looks valid but reads empty.
    const userCount = (src.prepare('SELECT count(*) c FROM user').get() as { c: number }).c;
    if (userCount === 0) {
      const walPath = `${dbPath}-wal`;
      const walHint = fs.existsSync(walPath) && fs.statSync(walPath).size > 0
        ? '(检测到同目录的 -wal 文件非空,数据很可能都在 WAL 里)' : '';
      throw new Error(
        `源库里没有任何用户${walHint}。若这是拷贝出来的 webui.db,请先在源机器上执行 `
        + `sqlite3 webui.db "PRAGMA wal_checkpoint(TRUNCATE)" 再拷贝/上传。`,
      );
    }

    // -- content parsers (stateful: tool call fallback ids) --
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
      const re = /<details\b([^>]*)>([\s\S]*?)<\/details>\s*/g;
      let lastIndex = 0;
      for (let m = re.exec(content); m; m = re.exec(content)) {
        pushText(parts, 'text', content.slice(lastIndex, m.index));
        detailsToParts(parseAttrs(m[1]), m[2], parts);
        lastIndex = re.lastIndex;
      }
      pushText(parts, 'text', content.slice(lastIndex));
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

    // -- attachment resolution --
    const fileRowById = tableExists('file')
      ? (() => {
          const stmt = src.prepare(`SELECT id, filename, path, meta FROM file WHERE id = ?`);
          return (id: string) => stmt.get(id) as OwuiFileRow | undefined;
        })()
      : () => undefined;

    // Resolve an Open WebUI message file to image bytes. Sources, in order:
    //   data: URL (inline base64) → decode
    //   /api/v1/files/{id}/content → file table row → physical file under dataDir
    //   /cache/... (image generations) → dataDir/cache/...
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
            if (dataDir) {
              // stored paths look like "data/uploads/xxx" or absolute paths from the old box
              candidates.push(path.join(dataDir, row.path.replace(/^.*?data\//, '')));
              candidates.push(path.join(dataDir, 'uploads', path.basename(row.path)));
            }
          } else if (dataDir && row.filename) {
            candidates.push(path.join(dataDir, 'uploads', `${row.id}_${row.filename}`));
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
      if (url.startsWith('/cache/') && dataDir) {
        const p = path.join(dataDir, url.replace(/^\//, ''));
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

    // -- read source --
    const hasUsernameCol = columnExists('user', 'username');
    const users = src.prepare(`
      SELECT u.id, u.email, u.name, ${hasUsernameCol ? 'u.username,' : ''} u.role, u.created_at, u.last_active_at,
             a.password, a.active
      FROM user u LEFT JOIN auth a ON a.id = u.id
    `).all() as OwuiUser[];

    const chatWhere = skipArchived ? 'WHERE archived IS NOT 1' : '';
    const chatsRows = src.prepare(`
      SELECT id, user_id, title, chat, created_at, updated_at, archived, pinned
      FROM chat ${chatWhere} ORDER BY created_at
    `).all() as OwuiChat[];

    report.sourceUsers = users.length;
    report.sourceChats = chatsRows.length;

    // -- users --
    const userIdMap = new Map<string, string>();
    const pendingUsers: (typeof schema.users.$inferInsert)[] = [];

    const existingByUsername = new Map<string, { id: string }>();
    const existingById = new Set<string>();
    for (const u of db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).all()) {
      existingByUsername.set(u.username, { id: u.id });
      existingById.add(u.id);
    }

    for (const u of users) {
      // Re-run identity: first migration keeps the Open WebUI uuid as the Cat
      // user id, so an id hit means "already migrated" regardless of rename state.
      if (existingById.has(u.id)) {
        userIdMap.set(u.id, u.id);
        report.users.merged++;
        continue;
      }
      // Merge into an existing account ONLY on email identity — emails are
      // unique in Open WebUI. Fallback names (OAuth users without email) are
      // NOT unique, so a collision there gets a fresh uniquified username;
      // silently merging by display name would hand one person's chats to another.
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
      const id = u.id;
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

    // -- chats + messages --
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
            // 只支持图片附件;文档类附件降级为文字说明
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

    if (dryRun) return report;

    // -- write --
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
      throw new Error(`写入失败,事务已整体回滚,本轮没有任何数据落库: ${err instanceof Error ? err.message : String(err)}`);
    }

    return report;
  } finally {
    src.close();
  }
}
