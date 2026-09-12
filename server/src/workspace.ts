// 工作区 — a private directory per chat (data/workspaces/<chatId>) that the
// model reads and writes through in-process tools, the way a coding agent
// treats a repo: long deliverables live in files it can revise in place with
// small targeted edits instead of being re-emitted whole every turn.
//
// Files on disk are the source of truth; nothing about them is mirrored in
// SQLite.
//
// Security model. The 沙盒 mounts this directory read-write, so its contents
// are attacker-controlled while a command runs and may contain leftovers
// (symlinks) from before seccomp existed. Every host-side operation therefore
// resolves the path ONE COMPONENT AT A TIME against an already-open directory
// descriptor — `/proc/self/fd/<dirfd>/<name>` is the kernel's own handle to
// that directory, so an ancestor being swapped for a symlink (even atomically
// with RENAME_EXCHANGE) cannot redirect us: we never re-resolve ancestors by
// path. Each step uses O_NOFOLLOW / O_DIRECTORY, so a symlink at any level is
// refused rather than followed. This is the openat(dirfd, name, O_NOFOLLOW)
// chain that openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) performs in-kernel,
// expressed with what Node exposes. Nothing here touches an absolute path
// below the root except to open the root itself (which we own).
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema } from './db/index.js';
import type { ToolDef } from './types.js';
import { withChatLock } from './workspace-lock.js';

const READ_WINDOW = 20_000; // chars per workspace_read call
const LIST_LIMIT = 300; // entries shown to the model / in the prompt manifest
const EDIT_CONTEXT = 160; // chars of context echoed back around an edit
const MAX_PATH_CHARS = 200;
export const MAX_DEPTH = 8;

const { O_RDONLY, O_WRONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY, O_CREAT, O_EXCL } = fs.constants;
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOCTTY;
const FILE_READ_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY;

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

const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function workspaceRoot(chatId: string): string {
  // chat ids are our own nanoid-style strings; refuse anything else outright
  if (!CHAT_ID_RE.test(chatId)) throw new WorkspaceError('无效的对话', 400);
  return path.join(config.dataDir, 'workspaces', chatId);
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Validate a user/model supplied relative path. Returns the cleaned relative
    form and its segments; `abs` is informational only — no I/O ever uses it. */
export function resolveSafe(chatId: string, rel: string): { abs: string; rel: string; segments: string[] } {
  const root = workspaceRoot(chatId);
  const raw = String(rel ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw.length > MAX_PATH_CHARS) throw new WorkspaceError('文件路径为空或过长');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new WorkspaceError('只能使用工作区内的相对路径');
  if (hasControlChars(raw)) throw new WorkspaceError('文件路径含有非法字符');
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length) throw new WorkspaceError('文件路径为空');
  if (segments.length > MAX_DEPTH) throw new WorkspaceError(`目录层级不能超过 ${MAX_DEPTH} 层`);
  for (const seg of segments) {
    if (seg === '..') throw new WorkspaceError('文件路径不能包含 ..');
    if (seg.startsWith('.')) throw new WorkspaceError('不允许以 . 开头的隐藏文件或目录');
    if (seg.length > 120) throw new WorkspaceError('文件名过长');
  }
  return { abs: path.join(root, ...segments), rel: segments.join('/'), segments };
}

// ---- descriptor-anchored path resolution ----

const fdPath = (fd: number, name?: string) => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);

function errCode(err: unknown): string { return (err as NodeJS.ErrnoException).code ?? ''; }

function translate(err: unknown, what: string): never {
  const code = errCode(err);
  if (code === 'ELOOP') throw new WorkspaceError('工作区内不允许符号链接');
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new WorkspaceError(`文件不存在:${what}`, 404);
  if (code === 'EISDIR') throw new WorkspaceError(`「${what}」是一个目录`);
  if (code === 'ENOTEMPTY') throw new WorkspaceError(`「${what}」不是空目录`);
  throw err;
}

/** Open the workspace root directory (creating it when asked). The root's own
    path is ours — nothing below data/ is attacker-writable except the
    workspace contents, which this fd sits above. */
function openRoot(chatId: string, create: boolean): number {
  const root = workspaceRoot(chatId);
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { return fs.openSync(root, DIR_FLAGS); } catch (err) {
    if (errCode(err) === 'ENOENT') throw new WorkspaceError('工作区为空', 404);
    throw err;
  }
}

/** openat(parent, name, O_DIRECTORY|O_NOFOLLOW), optionally mkdir first. */
function openChildDir(parentFd: number, name: string, create: boolean): number {
  try {
    return fs.openSync(fdPath(parentFd, name), DIR_FLAGS);
  } catch (err) {
    if (create && errCode(err) === 'ENOENT') {
      try { fs.mkdirSync(fdPath(parentFd, name), 0o700); } catch (e2) { if (errCode(e2) !== 'EEXIST') throw e2; }
      return fs.openSync(fdPath(parentFd, name), DIR_FLAGS);
    }
    throw err;
  }
}

/** Walk `dirs` from the root, one descriptor per level, and hand the final
    directory fd to `fn`. Every fd opened along the way is closed afterwards. */
function withDir<T>(chatId: string, dirs: string[], create: boolean, fn: (dirFd: number) => T): T {
  let fd = openRoot(chatId, create);
  try {
    for (const seg of dirs) {
      let next: number;
      try { next = openChildDir(fd, seg, create); } catch (err) { translate(err, seg); }
      fs.closeSync(fd);
      fd = next;
    }
    return fn(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Split a validated path into (parent dirs, final name). */
function split(chatId: string, rel: string): { dirs: string[]; name: string; rel: string } {
  const { segments, rel: cleaned } = resolveSafe(chatId, rel);
  return { dirs: segments.slice(0, -1), name: segments[segments.length - 1], rel: cleaned };
}

export function workspaceExists(chatId: string): boolean {
  try { return fs.statSync(workspaceRoot(chatId)).isDirectory(); } catch { return false; }
}

// ---- listing & accounting ----

interface WalkVisit { file(dirFd: number, name: string, rel: string, st: fs.Stats): void; other?(dirFd: number, name: string, rel: string): void }

/** Depth-first walk anchored on descriptors; symlinks and other irregular
    entries are reported to `other` (if given) and never followed. */
function walk(dirFd: number, relDir: string, depth: number, visit: WalkVisit): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(fdPath(dirFd), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    let st: fs.Stats;
    try { st = fs.lstatSync(fdPath(dirFd, e.name)); } catch { continue; }
    if (st.isDirectory()) {
      if (depth >= MAX_DEPTH + 2) continue;
      let child: number;
      try { child = fs.openSync(fdPath(dirFd, e.name), DIR_FLAGS); } catch { continue; }
      try { walk(child, rel, depth + 1, visit); } finally { fs.closeSync(child); }
    } else if (st.isFile()) {
      visit.file(dirFd, e.name, rel, st);
    } else {
      visit.other?.(dirFd, e.name, rel);
    }
  }
}

export function listWorkspace(chatId: string, limit = Number.MAX_SAFE_INTEGER): WorkspaceListing {
  const files: WorkspaceEntry[] = [];
  let bytes = 0;
  let truncated = false;
  if (!workspaceExists(chatId)) return { files, bytes, truncated };
  withDir(chatId, [], false, (root) => walk(root, '', 0, {
    file(_fd, name, rel, st) {
      if (name.startsWith('.')) return;
      bytes += st.size;
      if (files.length < limit) files.push({ path: rel, size: st.size, mtime: st.mtimeMs });
      else truncated = true;
    },
  }));
  return { files, bytes, truncated };
}

export function workspaceBytes(chatId: string): number {
  return accountWorkspace(chatId).bytes;
}

/**
 * Quota accounting counts EVERY regular file, including dot-files. The
 * model-facing listing above hides names starting with '.', but a command
 * could hide bulk data as .hidden-* to evade a display-based quota — so the
 * budget and the reclaimer must never rely on that listing.
 */
export function accountWorkspace(chatId: string): { files: WorkspaceEntry[]; bytes: number } {
  const files: WorkspaceEntry[] = [];
  let bytes = 0;
  if (!workspaceExists(chatId)) return { files, bytes };
  withDir(chatId, [], false, (root) => walk(root, '', 0, {
    file(_fd, name, rel, st) {
      bytes += st.size;
      files.push({ path: rel, size: st.size, mtime: st.mtimeMs });
    },
  }));
  return { files, bytes };
}

/** Total workspace bytes across every chat (storage overview). */
export function allWorkspacesBytes(): { chats: number; bytes: number } {
  const base = path.join(config.dataDir, 'workspaces');
  let chats = 0;
  let bytes = 0;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return { chats, bytes }; }
  for (const d of dirs) {
    if (!CHAT_ID_RE.test(d)) continue;
    bytes += workspaceBytes(d);
    chats += 1;
  }
  return { chats, bytes };
}

function assertBudget(chatId: string, addedBytes: number, addedFiles: number) {
  const { files, bytes } = accountWorkspace(chatId);
  if (bytes + addedBytes > config.maxWorkspaceBytes) {
    throw new WorkspaceError(`工作区已达 ${Math.round(config.maxWorkspaceBytes / 1048576)} MB 上限,请先删除一些文件`, 413);
  }
  if (files.length + addedFiles > config.maxWorkspaceFiles) {
    throw new WorkspaceError(`工作区文件数不能超过 ${config.maxWorkspaceFiles} 个`, 413);
  }
}

/** Is the workspace within its byte / file-count budget right now? */
export function workspaceOverQuota(chatId: string): { over: boolean; bytes: number; files: number } {
  const { files, bytes } = accountWorkspace(chatId);
  return { over: bytes > config.maxWorkspaceBytes || files.length > config.maxWorkspaceFiles, bytes, files: files.length };
}

/**
 * After a 沙盒 run: the command could write more than the budget allows
 * (seccomp does not police write/truncate). Bring the workspace back under
 * the limits by removing what that run produced, largest first, and report
 * what went. Files untouched by the run are never removed.
 */
/** Unlink a regular file by its accounting-relative path, tolerating dot
    names (which resolveSafe rejects). Walks parents via descriptors, refuses
    to follow symlinks and refuses '..'. Reclaimer-only. */
function reclaimUnlink(chatId: string, rel: string): void {
  const segs = rel.split('/').filter((x) => x && x !== '.');
  if (!segs.length || segs.some((x) => x === '..')) return;
  const dirs = segs.slice(0, -1);
  const name = segs[segs.length - 1];
  withDir(chatId, dirs, false, (dirFd) => {
    const st = fs.lstatSync(fdPath(dirFd, name));
    if (st.isFile()) fs.unlinkSync(fdPath(dirFd, name));
  });
}

export function enforceWorkspaceQuota(chatId: string): { removed: { path: string; size: number }[]; bytes: number } {
  const removed: { path: string; size: number }[] = [];
  if (!workspaceExists(chatId)) return { removed, bytes: 0 };
  let { files, bytes } = accountWorkspace(chatId);
  let count = files.length;
  const over = () => bytes > config.maxWorkspaceBytes || count > config.maxWorkspaceFiles;
  if (!over()) return { removed, bytes };
  // The pre-run check guaranteed the workspace was under budget before this
  // command, and the chat lock let nothing else write meanwhile — so every
  // byte over the limit was produced by this run. Trim largest-first, all
  // files eligible (mtime is attacker-controlled and must not gate this),
  // including dot-files.
  const candidates = [...files].sort((a, b) => b.size - a.size);
  for (const f of candidates) {
    if (!over()) break;
    try {
      reclaimUnlink(chatId, f.path);
      removed.push({ path: f.path, size: f.size });
      bytes -= f.size;
      count -= 1;
    } catch { /* keep going */ }
  }
  return { removed, bytes };
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
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Open a workspace file for reading through the descriptor chain: every
 * directory via O_DIRECTORY|O_NOFOLLOW, the file via O_NOFOLLOW (O_NONBLOCK
 * keeps a FIFO from hanging us), then fstat must say "regular file". The
 * caller owns the descriptor.
 */
export function openRegular(chatId: string, rel: string): { fd: number; rel: string; size: number } {
  const { dirs, name, rel: cleaned } = split(chatId, rel);
  return withDir(chatId, dirs, false, (dirFd) => {
    let fd: number;
    try { fd = fs.openSync(fdPath(dirFd, name), FILE_READ_FLAGS); } catch (err) { translate(err, cleaned); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new WorkspaceError(`不是普通文件:${cleaned}`);
      return { fd, rel: cleaned, size: st.size };
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  });
}

function readRegular(chatId: string, rel: string): { buf: Buffer; rel: string } {
  const { fd, rel: cleaned } = openRegular(chatId, rel);
  try { return { buf: fs.readFileSync(fd), rel: cleaned }; } finally { fs.closeSync(fd); }
}

const CRLF = /\r\n/g;

/** Text rendition of a workspace file: plain text as-is, docx through
    mammoth; anything else is reported as binary. */
export async function readWorkspaceText(chatId: string, rel: string): Promise<string> {
  const { buf, rel: cleaned } = readRegular(chatId, rel);
  const ext = extOf(cleaned);
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value.replace(CRLF, '\n');
  }
  if (!isTextPath(cleaned) && looksBinary(buf)) {
    throw new WorkspaceError(`「${cleaned}」是二进制文件(${buf.length.toLocaleString()} 字节),无法以文本读取`);
  }
  return buf.toString('utf8').replace(CRLF, '\n');
}

/** Delete anything that is neither a regular file nor a directory (symlinks,
    FIFOs, sockets). Run before and after every 沙盒 command and at startup,
    so the host side only ever meets plain files. */
export function sweepIrregularEntries(chatId: string): number {
  if (!workspaceExists(chatId)) return 0;
  let removed = 0;
  withDir(chatId, [], false, (root) => walk(root, '', 0, {
    file() { /* keep */ },
    other(dirFd, name) {
      try { fs.unlinkSync(fdPath(dirFd, name)); removed += 1; } catch { /* best effort */ }
    },
  }));
  if (removed) console.warn(`[workspace] ${chatId}: removed ${removed} irregular entr${removed === 1 ? 'y' : 'ies'}`);
  return removed;
}

// ---- writing ----

export function writeWorkspaceFile(chatId: string, rel: string, content: string | Buffer): Promise<{ rel: string; size: number }> {
  return withChatLock(chatId, () => writeWorkspaceFileLocked(chatId, rel, content));
}

function writeWorkspaceFileLocked(chatId: string, rel: string, content: string | Buffer): { rel: string; size: number } {
  const { dirs, name, rel: cleaned } = split(chatId, rel);
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (data.length > config.maxWorkspaceFileBytes) {
    throw new WorkspaceError(`单个文件不能超过 ${Math.round(config.maxWorkspaceFileBytes / 1048576)} MB`, 413);
  }
  return withDir(chatId, dirs, true, (dirFd) => {
    let existing = 0;
    let isNew = true;
    try {
      const st = fs.lstatSync(fdPath(dirFd, name));
      if (st.isDirectory()) throw new WorkspaceError(`「${cleaned}」是一个目录`);
      if (st.isFile()) { existing = st.size; isNew = false; }
      // a leftover symlink/FIFO at that name is simply renamed over below
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
    }
    assertBudget(chatId, data.length - existing, isNew ? 1 : 0);
    // write-then-rename so a crash mid-write never leaves a half file; the
    // temp file is created exclusively (O_EXCL|O_NOFOLLOW) in the SAME
    // directory descriptor, and the rename is expressed through that
    // descriptor too, so no ancestor can be re-pointed under either step.
    const tmp = `.${name}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(fdPath(dirFd, tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    try { fs.renameSync(fdPath(dirFd, tmp), fdPath(dirFd, name)); } catch (err) {
      try { fs.unlinkSync(fdPath(dirFd, tmp)); } catch { /* ignore */ }
      translate(err, cleaned);
    }
    return { rel: cleaned, size: data.length };
  });
}

export interface EditResult {
  rel: string;
  replacements: number;
  size: number;
  /** A short window of the new text around the first replacement. */
  context: string;
}

export function editWorkspaceFile(
  chatId: string, rel: string, oldStr: string, newStr: string, replaceAll: boolean,
): Promise<EditResult> {
  return withChatLock(chatId, () => editWorkspaceFileLocked(chatId, rel, oldStr, newStr, replaceAll));
}

async function editWorkspaceFileLocked(
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
  const { size } = writeWorkspaceFileLocked(chatId, cleaned, next);
  const start = Math.max(0, first - EDIT_CONTEXT);
  const end = Math.min(next.length, first + newStr.length + EDIT_CONTEXT);
  return { rel: cleaned, replacements: replaceAll ? count : 1, size, context: next.slice(start, end) };
}

/** rm -r expressed on descriptors: recurse into real directories only,
    unlink everything else, rmdir on the way out. Returns files removed. */
function removeTree(parentFd: number, name: string, depth: number): number {
  let removed = 0;
  let fd: number;
  try { fd = fs.openSync(fdPath(parentFd, name), DIR_FLAGS); } catch (err) { translate(err, name); }
  try {
    for (const e of fs.readdirSync(fdPath(fd), { withFileTypes: true })) {
      let st: fs.Stats;
      try { st = fs.lstatSync(fdPath(fd, e.name)); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH + 2) removed += removeTree(fd, e.name, depth + 1);
      } else {
        try { fs.unlinkSync(fdPath(fd, e.name)); if (st.isFile()) removed += 1; } catch { /* best effort */ }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.rmdirSync(fdPath(parentFd, name));
  return removed;
}

export function deleteWorkspacePath(chatId: string, rel: string): Promise<{ rel: string; removed: number }> {
  return withChatLock(chatId, () => deleteWorkspacePathLocked(chatId, rel));
}

function deleteWorkspacePathLocked(chatId: string, rel: string): { rel: string; removed: number } {
  const { dirs, name, rel: cleaned } = split(chatId, rel);
  return withDir(chatId, dirs, false, (dirFd) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(fdPath(dirFd, name)); } catch (err) { translate(err, cleaned); }
    if (st.isDirectory()) {
      const removed = removeTree(dirFd, name, dirs.length);
      return { rel: cleaned, removed };
    }
    try { fs.unlinkSync(fdPath(dirFd, name)); } catch (err) { translate(err, cleaned); }
    return { rel: cleaned, removed: st.isFile() ? 1 : 0 };
  });
}

export function renameWorkspacePath(chatId: string, from: string, to: string): Promise<{ from: string; to: string }> {
  return withChatLock(chatId, () => {
    const src = split(chatId, from);
    const dst = split(chatId, to);
    return withDir(chatId, src.dirs, false, (srcFd) => withDir(chatId, dst.dirs, true, (dstFd) => {
      let st: fs.Stats;
      try { st = fs.lstatSync(fdPath(srcFd, src.name)); } catch (err) { translate(err, src.rel); }
      if (!st.isFile() && !st.isDirectory()) throw new WorkspaceError(`不是普通文件:${src.rel}`);
      try { fs.lstatSync(fdPath(dstFd, dst.name)); throw new WorkspaceError(`目标已存在:${dst.rel}`, 409); }
      catch (err) { if (err instanceof WorkspaceError) throw err; }
      try { fs.renameSync(fdPath(srcFd, src.name), fdPath(dstFd, dst.name)); } catch (err) { translate(err, src.rel); }
      return { from: src.rel, to: dst.rel };
    }));
  });
}

/** Remove the whole directory (chat deleted / swept). fs.rm never follows
    symlinks, and the root path is ours. Best effort. */
export function removeWorkspace(chatId: string): void {
  try { fs.rmSync(workspaceRoot(chatId), { recursive: true, force: true }); }
  catch (err) { console.warn(`[workspace] remove ${chatId} failed: ${(err as Error).message}`); }
}

/** Startup: drop directories whose chat no longer exists (crash between
    delete and rm) and scrub irregular entries from the ones that remain —
    a workspace from before seccomp may still hold a planted symlink. */
export function sweepOrphanWorkspaces(): number {
  const base = path.join(config.dataDir, 'workspaces');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return 0; }
  let removed = 0;
  for (const d of dirs) {
    if (!CHAT_ID_RE.test(d)) continue;
    const row = db.select({ id: schema.chats.id }).from(schema.chats).where(eq(schema.chats.id, d)).get();
    if (row) { try { sweepIrregularEntries(d); } catch { /* best effort */ } continue; }
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
        const r = await writeWorkspaceFile(chatId, rel, args.content);
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
        const r = await deleteWorkspacePath(chatId, rel);
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
