// 工作区 — a private directory per chat (data/workspaces/<chatId>) that the
// model reads and writes through in-process tools, the way a coding agent
// treats a repo: long deliverables live in files it can revise in place with
// small targeted edits instead of being re-emitted whole every turn.
//
// Files on disk are the source of truth; nothing about them is mirrored in
// SQLite. Every path the model or the browser supplies goes through
// resolveSafe(), which rejects traversal, absolute paths, symlinks and odd
// characters, so a workspace can never see outside its own directory.
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema } from './db/index.js';
import type { ToolDef } from './types.js';

const READ_WINDOW = 20_000; // chars per workspace_read call
const LIST_LIMIT = 300; // entries shown to the model / in the prompt manifest
const EDIT_CONTEXT = 160; // chars of context echoed back around an edit
const MAX_PATH_CHARS = 200;
const MAX_DEPTH = 8;

export interface WorkspaceEntry {
  path: string; // relative, '/'-separated
  size: number;
  mtime: number;
}

export interface WorkspaceListing {
  files: WorkspaceEntry[];
  bytes: number;
  truncated: boolean;
}

export class WorkspaceError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export function workspaceRoot(chatId: string): string {
  // chat ids are our own nanoid-style strings; refuse anything else outright
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) throw new WorkspaceError('无效的对话', 400);
  return path.join(config.dataDir, 'workspaces', chatId);
}

/** Normalise a user/model supplied relative path and resolve it inside the
    workspace. Returns the absolute path plus the cleaned relative form. */
export function resolveSafe(chatId: string, rel: string): { abs: string; rel: string } {
  const root = workspaceRoot(chatId);
  const raw = String(rel ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw.length > MAX_PATH_CHARS) throw new WorkspaceError('文件路径为空或过长');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new WorkspaceError('只能使用工作区内的相对路径');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new WorkspaceError('文件路径含有非法字符');
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length) throw new WorkspaceError('文件路径为空');
  if (segments.length > MAX_DEPTH) throw new WorkspaceError(`目录层级不能超过 ${MAX_DEPTH} 层`);
  for (const seg of segments) {
    if (seg === '..') throw new WorkspaceError('文件路径不能包含 ..');
    if (seg.startsWith('.')) throw new WorkspaceError('不允许以 . 开头的隐藏文件或目录');
    if (seg.length > 120) throw new WorkspaceError('文件名过长');
  }
  const cleaned = segments.join('/');
  const abs = path.resolve(root, ...segments);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new WorkspaceError('文件路径越界');
  // A symlink anywhere along the way could point outside; we never create
  // them, but an uploaded archive could in theory — refuse to follow.
  let cur = root;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) throw new WorkspaceError('工作区内不允许符号链接');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  return { abs, rel: cleaned };
}

function ensureRoot(chatId: string): string {
  const root = workspaceRoot(chatId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

export function workspaceExists(chatId: string): boolean {
  try { return fs.statSync(workspaceRoot(chatId)).isDirectory(); } catch { return false; }
}

// ---- listing & accounting ----

export function listWorkspace(chatId: string, limit = Number.MAX_SAFE_INTEGER): WorkspaceListing {
  const root = workspaceRoot(chatId);
  const files: WorkspaceEntry[] = [];
  let bytes = 0;
  let truncated = false;
  const walk = (dir: string, relDir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) walk(path.join(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        let st: fs.Stats;
        try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
        bytes += st.size;
        if (files.length < limit) files.push({ path: rel, size: st.size, mtime: st.mtimeMs });
        else truncated = true;
      }
    }
  };
  walk(root, '', 0);
  return { files, bytes, truncated };
}

export function workspaceBytes(chatId: string): number {
  return listWorkspace(chatId, 0).bytes;
}

/** Total workspace bytes across every chat (storage overview). */
export function allWorkspacesBytes(): { chats: number; bytes: number } {
  const base = path.join(config.dataDir, 'workspaces');
  let chats = 0;
  let bytes = 0;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return { chats, bytes }; }
  for (const d of dirs) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(d)) continue;
    const b = workspaceBytes(d);
    chats += 1;
    bytes += b;
  }
  return { chats, bytes };
}

function assertBudget(chatId: string, addedBytes: number, addedFiles: number) {
  const { files, bytes } = listWorkspace(chatId, config.maxWorkspaceFiles + 1);
  if (bytes + addedBytes > config.maxWorkspaceBytes) {
    throw new WorkspaceError(`工作区已达 ${Math.round(config.maxWorkspaceBytes / 1048576)} MB 上限,请先删除一些文件`, 413);
  }
  if (files.length + addedFiles > config.maxWorkspaceFiles) {
    throw new WorkspaceError(`工作区文件数不能超过 ${config.maxWorkspaceFiles} 个`, 413);
  }
}

// ---- reading ----

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'svg', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'r', 'lua', 'pl',
  'tex', 'bib', 'rst', 'org', 'log', 'diff', 'patch', 'mermaid', 'mmd', 'vue', 'svelte', 'graphql', 'proto',
  'srt', 'vtt', 'ass',
]);

export function extOf(rel: string): string {
  const base = rel.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function isTextPath(rel: string): boolean {
  return TEXT_EXT.has(extOf(rel));
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
  }
  return false;
}

/** Text rendition of a workspace file: plain text as-is, docx through
    mammoth; anything else is reported as binary. */
export async function readWorkspaceText(chatId: string, rel: string): Promise<string> {
  const { abs, rel: cleaned } = resolveSafe(chatId, rel);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new WorkspaceError(`文件不存在:${cleaned}`, 404); }
  if (!st.isFile()) throw new WorkspaceError(`不是文件:${cleaned}`);
  const ext = extOf(cleaned);
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ path: abs });
    return r.value.replace(/\r\n/g, '\n');
  }
  const buf = fs.readFileSync(abs);
  if (!isTextPath(cleaned) && looksBinary(buf)) {
    throw new WorkspaceError(`「${cleaned}」是二进制文件(${st.size.toLocaleString()} 字节),无法以文本读取`);
  }
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

// ---- writing ----

export function writeWorkspaceFile(chatId: string, rel: string, content: string | Buffer): { rel: string; size: number } {
  const { abs, rel: cleaned } = resolveSafe(chatId, rel);
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (data.length > config.maxWorkspaceFileBytes) {
    throw new WorkspaceError(`单个文件不能超过 ${Math.round(config.maxWorkspaceFileBytes / 1048576)} MB`, 413);
  }
  ensureRoot(chatId);
  let existing = 0;
  let isNew = true;
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new WorkspaceError(`「${cleaned}」是一个目录`);
    existing = st.size;
    isNew = false;
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
  }
  assertBudget(chatId, data.length - existing, isNew ? 1 : 0);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  // write-then-rename so a crash mid-write never leaves a half file
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, abs);
  return { rel: cleaned, size: data.length };
}

export interface EditResult {
  rel: string;
  replacements: number;
  size: number;
  /** A short window of the new text around the first replacement. */
  context: string;
}

export async function editWorkspaceFile(
  chatId: string, rel: string, oldStr: string, newStr: string, replaceAll: boolean,
): Promise<EditResult> {
  const { rel: cleaned } = resolveSafe(chatId, rel);
  if (extOf(cleaned) === 'docx') throw new WorkspaceError('docx 只能读取,不能局部修改;请把结果写成 .md 或 .txt 文件');
  if (!oldStr) throw new WorkspaceError('old_string 不能为空');
  const text = await readWorkspaceText(chatId, cleaned);
  let count = 0;
  let idx = text.indexOf(oldStr);
  while (idx !== -1) { count += 1; idx = text.indexOf(oldStr, idx + oldStr.length); }
  if (count === 0) throw new WorkspaceError('没有找到要替换的原文,请先用 workspace_read 核对内容(注意空格、标点和换行必须完全一致)');
  if (count > 1 && !replaceAll) {
    throw new WorkspaceError(`原文出现了 ${count} 次,无法确定要改哪一处;请多带一些上下文让它唯一,或设置 replace_all`);
  }
  const first = text.indexOf(oldStr);
  const next = replaceAll ? text.split(oldStr).join(newStr) : text.slice(0, first) + newStr + text.slice(first + oldStr.length);
  const { size } = writeWorkspaceFile(chatId, cleaned, next);
  const start = Math.max(0, first - EDIT_CONTEXT);
  const end = Math.min(next.length, first + newStr.length + EDIT_CONTEXT);
  return { rel: cleaned, replacements: replaceAll ? count : 1, size, context: next.slice(start, end) };
}

export function deleteWorkspacePath(chatId: string, rel: string): { rel: string; removed: number } {
  const { abs, rel: cleaned } = resolveSafe(chatId, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { throw new WorkspaceError(`文件不存在:${cleaned}`, 404); }
  if (st.isDirectory()) {
    const before = listWorkspace(chatId).files.filter((f) => f.path.startsWith(`${cleaned}/`)).length;
    fs.rmSync(abs, { recursive: true, force: true });
    return { rel: cleaned, removed: before };
  }
  fs.rmSync(abs, { force: true });
  return { rel: cleaned, removed: 1 };
}

export function renameWorkspacePath(chatId: string, from: string, to: string): { from: string; to: string } {
  const src = resolveSafe(chatId, from);
  const dst = resolveSafe(chatId, to);
  if (!fs.existsSync(src.abs)) throw new WorkspaceError(`文件不存在:${src.rel}`, 404);
  if (fs.existsSync(dst.abs)) throw new WorkspaceError(`目标已存在:${dst.rel}`, 409);
  fs.mkdirSync(path.dirname(dst.abs), { recursive: true, mode: 0o700 });
  fs.renameSync(src.abs, dst.abs);
  return { from: src.rel, to: dst.rel };
}

/** Remove the whole directory (chat deleted / swept). Best effort. */
export function removeWorkspace(chatId: string): void {
  try { fs.rmSync(workspaceRoot(chatId), { recursive: true, force: true }); }
  catch (err) { console.warn(`[workspace] remove ${chatId} failed: ${(err as Error).message}`); }
}

/** Directories whose chat no longer exists (crash between delete and rm). */
export function sweepOrphanWorkspaces(): number {
  const base = path.join(config.dataDir, 'workspaces');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return 0; }
  let removed = 0;
  for (const d of dirs) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(d)) continue;
    const row = db.select({ id: schema.chats.id }).from(schema.chats).where(eq(schema.chats.id, d)).get();
    if (row) continue;
    removeWorkspace(d);
    removed += 1;
  }
  if (removed) console.log(`[workspace] removed ${removed} orphan workspace dir(s)`);
  return removed;
}

// ---- model-facing tools ----

export const WORKSPACE_TOOL_DEFS: ToolDef[] = [
  {
    name: 'workspace_list',
    description: '列出工作区中的全部文件(相对路径、大小)。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workspace_read',
    description: '读取工作区里一个文件的文本内容。长文件分段返回,响应末尾会给出继续读取所需的 offset。docx 会转成纯文本;其他二进制文件无法读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径,如 方案.md 或 data/表.csv' },
        offset: { type: 'integer', description: '起始字符位置,默认 0' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_write',
    description: '把完整内容写入工作区文件(新建或整体覆盖)。适合创建新文件或重写小文件;修改已有文件的一部分请用 workspace_edit。会自动创建所需目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径,带扩展名,如 报告.md' },
        content: { type: 'string', description: '文件的完整内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_edit',
    description: '对工作区文件做精确的局部替换:把 old_string 替换成 new_string。old_string 必须与文件中的原文逐字一致且只出现一次(可多带几行上下文来保证唯一);要替换全部出现处请设 replace_all。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        old_string: { type: 'string', description: '要被替换的原文(逐字一致)' },
        new_string: { type: 'string', description: '替换后的新文本(可为空字符串表示删除)' },
        replace_all: { type: 'boolean', description: '替换所有出现处,默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_delete',
    description: '删除工作区中的一个文件或目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

export function isWorkspaceTool(name: string): boolean {
  return name.startsWith('workspace_') && WORKSPACE_TOOL_DEFS.some((t) => t.name === name);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function manifestLines(listing: WorkspaceListing): string {
  const lines = listing.files.map((f) => `- ${f.path}(${fmtBytes(f.size)})`);
  if (listing.truncated) lines.push(`…(文件过多,仅列出前 ${listing.files.length} 个)`);
  return lines.join('\n');
}

/** System-prompt block: what the workspace is for, how to use it, and the
    current manifest so the model knows what already exists without a call. */
export function buildWorkspacePrompt(chatId: string): string {
  const listing = listWorkspace(chatId, LIST_LIMIT);
  const manifest = listing.files.length ? manifestLines(listing) : '(工作区目前为空)';
  return [
    '[工作区]',
    '本对话有一个私有的文件工作区,用户能在界面右侧的「工作区」面板查看、预览、下载、上传和删除其中的文件。你通过 workspace_* 工具读写它。用法:',
    '- 篇幅较长或需要反复打磨的成果(文章、报告、方案、代码、数据、大纲等)写进文件,而不是整段贴在回复里;回复中说明做了什么、文件叫什么,并给出简短摘要或要点。零散的简短回答照常直接回复,不必写文件。',
    '- 修改已有文件时,先 workspace_read 核对原文,再用 workspace_edit 做局部替换;不要为了改几句话就用 workspace_write 整篇重写。',
    '- 文件名要有意义并带扩展名(如 方案.md、数据.csv、index.html)。用户上传到工作区的文件,先读取再处理。',
    '- 文件已经写好后,不要再把整份内容复制到回复里。',
    `当前文件:\n${manifest}`,
  ].join('\n');
}

type ToolOutcome = { result: string; isError: boolean };

export async function callWorkspaceTool(chatId: string, name: string, argsJson: string): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* treated as empty */ }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  try {
    switch (name) {
      case 'workspace_list': {
        const listing = listWorkspace(chatId, LIST_LIMIT);
        if (!listing.files.length) return { result: '工作区目前为空。', isError: false };
        return { result: `${manifestLines(listing)}\n共 ${listing.files.length} 个文件,${fmtBytes(listing.bytes)}`, isError: false };
      }
      case 'workspace_read': {
        const rel = str('path');
        if (!rel) return { result: '缺少 path 参数', isError: true };
        const text = await readWorkspaceText(chatId, rel);
        const offset = Math.max(0, Math.min(Number(args.offset) || 0, text.length));
        const slice = text.slice(offset, offset + READ_WINDOW);
        const end = offset + slice.length;
        const header = `<file path=${JSON.stringify(rel)} chars=${text.length} range="${offset}-${end}">`;
        const footer = end < text.length
          ? `</file>\n(未完,继续读取请传 offset=${end})`
          : '</file>';
        return { result: `${header}\n${slice}\n${footer}`, isError: false };
      }
      case 'workspace_write': {
        const rel = str('path');
        if (!rel) return { result: '缺少 path 参数', isError: true };
        if (typeof args.content !== 'string') return { result: '缺少 content 参数', isError: true };
        const r = writeWorkspaceFile(chatId, rel, args.content);
        return { result: `已写入 ${r.rel}(${fmtBytes(r.size)})`, isError: false };
      }
      case 'workspace_edit': {
        const rel = str('path');
        if (!rel) return { result: '缺少 path 参数', isError: true };
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          return { result: '缺少 old_string / new_string 参数', isError: true };
        }
        const r = await editWorkspaceFile(chatId, rel, args.old_string, args.new_string, args.replace_all === true);
        return {
          result: `已替换 ${r.replacements} 处,${r.rel} 现为 ${fmtBytes(r.size)}。修改处附近的新内容:\n…${r.context}…`,
          isError: false,
        };
      }
      case 'workspace_delete': {
        const rel = str('path');
        if (!rel) return { result: '缺少 path 参数', isError: true };
        const r = deleteWorkspacePath(chatId, rel);
        return { result: `已删除 ${r.rel}(${r.removed} 个文件)`, isError: false };
      }
      default:
        return { result: `未知的工作区工具:${name}`, isError: true };
    }
  } catch (err) {
    if (err instanceof WorkspaceError) return { result: err.message, isError: true };
    return { result: `工作区操作失败:${(err as Error).message}`, isError: true };
  }
}
