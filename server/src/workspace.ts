// 工作区 — a private directory per chat or per user within a project that the
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
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema } from './db/index.js';
import type { ToolDef } from './types.js';
import { withChatLock, withScopeLock } from './workspace-lock.js';
import { workspaceFileLink } from './workspace-link.js';
import { WorkspaceError, WORKSPACE_ID_RE, privateWorkspaceRoot, projectWorkspaceRoot, withWorkspaceScope, workspaceScope } from './workspace-scope.js';
import type { WorkspaceScope } from './workspace-scope.js';
export { WorkspaceError } from './workspace-scope.js';

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
  /** Every visible folder, including empty ones, so the panel can show them. */
  dirs: string[];
  bytes: number;
  truncated: boolean;
}

export function workspaceRoot(chatId: string): string {
  return workspaceScope(chatId).root;
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
function openRootPath(root: string, create: boolean): number {
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
  return withRootDir(workspaceRoot(chatId), dirs, create, fn);
}

function withRootDir<T>(root: string, dirs: string[], create: boolean, fn: (dirFd: number) => T): T {
  let fd = openRootPath(root, create);
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

interface WalkVisit {
  file(dirFd: number, name: string, rel: string, st: fs.Stats): void;
  other?(dirFd: number, name: string, rel: string): void;
  /** Called before descending; returning false skips the subtree. */
  dir?(rel: string): boolean | void;
}

/** Depth-first walk anchored on descriptors; symlinks and other irregular
    entries are reported to `other` (if given) and never followed. */
function walk(dirFd: number, relDir: string, depth: number, visit: WalkVisit, strict = false): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(fdPath(dirFd), { withFileTypes: true }); } catch (err) { if (strict) throw err; return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    let st: fs.Stats;
    try { st = fs.lstatSync(fdPath(dirFd, e.name)); } catch (err) { if (strict) throw err; continue; }
    if (st.isDirectory()) {
      if (visit.dir?.(rel) === false) continue;
      if (depth >= MAX_DEPTH + 2) {
        if (strict) throw new WorkspaceError(`目录层级不能超过 ${MAX_DEPTH} 层`);
        continue;
      }
      let child: number;
      try { child = fs.openSync(fdPath(dirFd, e.name), DIR_FLAGS); } catch (err) { if (strict) throw err; continue; }
      try { walk(child, rel, depth + 1, visit, strict); } finally { fs.closeSync(child); }
    } else if (st.isFile()) {
      visit.file(dirFd, e.name, rel, st);
    } else {
      visit.other?.(dirFd, e.name, rel);
    }
  }
}

export function listWorkspace(chatId: string, limit = Number.MAX_SAFE_INTEGER): WorkspaceListing {
  const files: WorkspaceEntry[] = [];
  const dirs: string[] = [];
  let bytes = 0;
  let truncated = false;
  if (!workspaceExists(chatId)) return { files, dirs, bytes, truncated };
  withDir(chatId, [], false, (root) => walk(root, '', 0, {
    file(_fd, name, rel, st) {
      if (name.startsWith('.')) return;
      bytes += st.size;
      if (files.length < limit) files.push({ path: rel, size: st.size, mtime: st.mtimeMs });
      else truncated = true;
    },
    // Hidden folders are unreachable through resolveSafe, so their contents
    // are left out of the listing too (accounting still counts them).
    dir(rel) {
      if (rel.split('/').pop()!.startsWith('.')) return false;
      if (dirs.length < limit) dirs.push(rel);
    },
  }));
  return { files, dirs, bytes, truncated };
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
  return accountRoot(workspaceRoot(chatId));
}

function accountRoot(rootPath: string): { files: WorkspaceEntry[]; bytes: number } {
  const files: WorkspaceEntry[] = [];
  let bytes = 0;
  let root: number;
  try { root = fs.openSync(rootPath, DIR_FLAGS); }
  catch (err) { if (errCode(err) === 'ENOENT') return { files, bytes }; throw err; }
  try { walk(root, '', 0, {
    file(_fd, _name, rel, st) {
      bytes += st.size;
      files.push({ path: rel, size: st.size, mtime: st.mtimeMs });
    },
  }); } finally { fs.closeSync(root); }
  return { files, bytes };
}

type ImportedFile = { signature: string; hash: string };

function hashFile(fd: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (!length) break;
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  return hash.digest('hex');
}

/** Copy with both workspace locks held. All descendant I/O stays anchored on
 * descriptors, including source reads and collision checks. Existing files
 * are never overwritten. A deterministic alternative makes crash retries
 * reuse the same copy rather than adding another version. */
function importFile(chatId: string, root: string, source: number, rel: string, sourceChat: string, hash: string): void {
  const basename = path.posix.basename(rel).replace(/[\x00-\x1f\x7f\\]/g, '_');
  const ext = path.posix.extname(basename).slice(0, 15);
  const stem = basename.slice(0, basename.length - path.posix.extname(basename).length).slice(0, 40);
  const fallback = `import-${sourceChat.slice(0, 8)}-${hash.slice(0, 12)}-${stem}${ext}`;
  let candidate: string;
  try { candidate = resolveSafe(chatId, rel).rel; } catch { candidate = fallback; }
  for (let attempt = 0; ; attempt++) {
    const segments = candidate.split('/');
    const name = segments.pop()!;
    let copied = false;
    try {
      copied = withRootDir(root, segments, true, (dir) => {
        try {
          const st = fs.lstatSync(fdPath(dir, name));
          if (!st.isFile()) return false;
          const existing = fs.openSync(fdPath(dir, name), FILE_READ_FLAGS);
          try { return hashFile(existing) === hash; } finally { fs.closeSync(existing); }
        } catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
        const tmp = `.workspace-import-${hash}.tmp`;
        // Only an interrupted import can leave this temporary file; unlinking
        // the directory entry also safely handles a leftover symlink.
        try { fs.unlinkSync(fdPath(dir, tmp)); } catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
        const dest = fs.openSync(fdPath(dir, tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let offset = 0;
          for (;;) {
            const length = fs.readSync(source, buffer, 0, buffer.length, offset);
            if (!length) break;
            for (let written = 0; written < length;) written += fs.writeSync(dest, buffer, written, length - written);
            offset += length;
          }
          fs.fsyncSync(dest);
          fs.renameSync(fdPath(dir, tmp), fdPath(dir, name));
          return true;
        } finally {
          fs.closeSync(dest);
          try { fs.unlinkSync(fdPath(dir, tmp)); } catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
        }
      });
    } catch (err) {
      // A source directory may collide with a destination file or symlink.
      // Flatten that file into an accessible, deterministic alternative.
      if (!(err instanceof WorkspaceError && err.statusCode === 404) && errCode(err) !== 'ELOOP') throw err;
    }
    if (copied) return;
    candidate = attempt === 0 ? fallback : `import-${attempt}-${fallback.slice(7)}`;
  }
}

/** Import existing private files on access, including already-enabled projects
 * after an upgrade. The host-only ledger records source versions so a deleted
 * or edited shared copy is not resurrected on refresh, toggle or restart.
 * Existing files are retained even when their combined size exceeds today's
 * quota; normal write and sandbox admission checks then require cleanup. */
export async function importProjectWorkspace(chatId: string, scope: WorkspaceScope): Promise<void> {
  const { projectId, userId } = scope;
  if (!projectId || !userId) return;
  await withScopeLock(scope.key, async () => {
    const ledgerDir = path.join(config.dataDir, 'workspace-imports', projectId);
    const ledgerPath = path.join(ledgerDir, `${userId}.json`);
    let ledger = new Map<string, ImportedFile>();
    try { ledger = new Map(JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))); }
    catch (err) { if (errCode(err) !== 'ENOENT') throw err; }
    const chats = db.select({ id: schema.chats.id }).from(schema.chats)
      .where(and(eq(schema.chats.projectId, projectId), eq(schema.chats.userId, userId)))
      .orderBy(asc(schema.chats.createdAt), asc(schema.chats.id)).all();
    for (const chat of chats) await withScopeLock(`chat:${chat.id}`, () => {
      const current = db.select().from(schema.chats).where(eq(schema.chats.id, chat.id)).get();
      if (current?.projectId !== projectId || current.userId !== userId) return;
      let source: number;
      try { source = fs.openSync(privateWorkspaceRoot(chat.id), DIR_FLAGS); }
      catch (err) { if (errCode(err) === 'ENOENT') return; throw err; }
      let changed = false;
      try { walk(source, '', 0, {
        file(dir, name, rel) {
          const fd = fs.openSync(fdPath(dir, name), FILE_READ_FLAGS);
          try {
            const st = fs.fstatSync(fd);
            if (!st.isFile()) return;
            const key = `${chat.id}/${rel}`;
            const signature = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
            const previous = ledger.get(key);
            if (previous?.signature === signature) return;
            const hash = hashFile(fd);
            if (previous?.hash !== hash) importFile(chatId, scope.root, fd, rel, chat.id, hash);
            ledger.set(key, { signature, hash });
            changed = true;
          } finally { fs.closeSync(fd); }
        },
      }, true); } finally {
        fs.closeSync(source);
        if (changed) {
          fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
          const tmp = `${ledgerPath}.tmp`;
          const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW, 0o600);
          try { fs.writeFileSync(fd, JSON.stringify([...ledger])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(tmp, ledgerPath);
        }
      }
    });
  });
}

function directories(root: string): string[] {
  try { return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && WORKSPACE_ID_RE.test(e.name)).map((e) => e.name); }
  catch { return []; }
}

function storedWorkspaces(): { root: string; chatId?: string; projectId?: string; userId?: string }[] {
  const privateDirs = directories(path.join(config.dataDir, 'workspaces'))
    .map((chatId) => ({ root: privateWorkspaceRoot(chatId), chatId }));
  const projectDirs = directories(path.join(config.dataDir, 'project-workspaces')).flatMap((projectId) =>
    directories(projectWorkspaceRoot(projectId)).map((userId) => ({
      root: projectWorkspaceRoot(projectId, userId), projectId, userId,
    })));
  return [...privateDirs, ...projectDirs];
}

/** Physical storage, including inactive private/shared directories, counted once. */
export function allWorkspacesBytes(): { chats: number; bytes: number } {
  const dirs = storedWorkspaces();
  return { chats: dirs.length, bytes: dirs.reduce((n, d) => n + accountRoot(d.root).bytes, 0) };
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
  return sweepRoot(workspaceRoot(chatId));
}

function sweepRoot(rootPath: string): number {
  let root: number;
  try { root = fs.openSync(rootPath, DIR_FLAGS); } catch { return 0; }
  let removed = 0;
  try { walk(root, '', 0, {
    file() { /* keep */ },
    other(dirFd, name) {
      try { fs.unlinkSync(fdPath(dirFd, name)); removed += 1; } catch { /* best effort */ }
    },
  }); } finally { fs.closeSync(root); }
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
  return withChatLock(chatId, () => renameLocked(chatId, from, to));
}

/** Deepest path below a directory, in segments (an empty folder is 0). */
function treeDepth(parentFd: number, name: string, depth: number): number {
  if (depth > MAX_DEPTH + 2) return depth;
  const fd = fs.openSync(fdPath(parentFd, name), DIR_FLAGS);
  try {
    let deepest = 0;
    for (const e of fs.readdirSync(fdPath(fd), { withFileTypes: true })) {
      const st = fs.lstatSync(fdPath(fd, e.name));
      deepest = Math.max(deepest, 1 + (st.isDirectory() ? treeDepth(fd, e.name, depth + 1) : 0));
    }
    return deepest;
  } finally {
    fs.closeSync(fd);
  }
}

function renameLocked(chatId: string, from: string, to: string): { from: string; to: string } {
  const src = split(chatId, from);
  const dst = split(chatId, to);
  if (dst.rel === src.rel) return { from: src.rel, to: dst.rel };
  if (dst.rel.startsWith(`${src.rel}/`)) throw new WorkspaceError(`不能把「${src.rel}」移动到它自己里面`);
  return withDir(chatId, src.dirs, false, (srcFd) => {
    let st: fs.Stats;
    try { st = fs.lstatSync(fdPath(srcFd, src.name)); } catch (err) { translate(err, src.rel); }
    if (!st.isFile() && !st.isDirectory()) throw new WorkspaceError(`不是普通文件:${src.rel}`);
    // Contents pushed past MAX_DEPTH would be unreachable through resolveSafe.
    if (st.isDirectory() && dst.dirs.length + 1 + treeDepth(srcFd, src.name, 0) > MAX_DEPTH) {
      throw new WorkspaceError(`目录层级不能超过 ${MAX_DEPTH} 层`);
    }
    return withDir(chatId, dst.dirs, true, (dstFd) => {
      try { fs.lstatSync(fdPath(dstFd, dst.name)); throw new WorkspaceError(`目标已存在:${dst.rel}`, 409); }
      catch (err) { if (err instanceof WorkspaceError) throw err; }
      try { fs.renameSync(fdPath(srcFd, src.name), fdPath(dstFd, dst.name)); } catch (err) { translate(err, src.rel); }
      return { from: src.rel, to: dst.rel };
    });
  });
}

/** Clean a batch of paths and drop any that sit inside another one: acting
    on the folder already covers them. */
function topLevelPaths(chatId: string, paths: string[]): string[] {
  const cleaned = [...new Set(paths.map((p) => resolveSafe(chatId, p).rel))];
  return cleaned.filter((p) => !cleaned.some((q) => p.startsWith(`${q}/`)));
}

const basename = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

export interface BatchFailure { path: string; error: string }

function batchFailure(path: string, err: unknown): BatchFailure {
  if (err instanceof WorkspaceError) return { path, error: err.message };
  console.warn(`[workspace] batch operation on ${path} failed: ${(err as Error).message}`);
  return { path, error: '操作失败' };
}

export function makeWorkspaceDir(chatId: string, rel: string): Promise<{ rel: string }> {
  return withChatLock(chatId, () => {
    const { dirs, name, rel: cleaned } = split(chatId, rel);
    let count = 0;
    withDir(chatId, [], true, (root) => walk(root, '', 0, { file() { /* files have their own budget */ }, dir() { count += 1; } }));
    if (count + dirs.length + 1 > config.maxWorkspaceFiles) {
      throw new WorkspaceError(`工作区文件夹数不能超过 ${config.maxWorkspaceFiles} 个`, 413);
    }
    return withDir(chatId, dirs, true, (dirFd) => {
      try {
        const st = fs.lstatSync(fdPath(dirFd, name));
        throw new WorkspaceError(st.isDirectory() ? `文件夹已存在:${cleaned}` : `已有同名文件:${cleaned}`, 409);
      } catch (err) { if (err instanceof WorkspaceError) throw err; }
      fs.mkdirSync(fdPath(dirFd, name), 0o700);
      return { rel: cleaned };
    });
  });
}

/** Move entries into `toDir` ('' is the root), keeping their names. Each
    entry succeeds or fails on its own; the folder itself must already exist. */
export function moveWorkspacePaths(chatId: string, paths: string[], toDir: string): Promise<{
  moved: { from: string; to: string }[]; failed: BatchFailure[];
}> {
  return withChatLock(chatId, () => {
    const dest = toDir ? resolveSafe(chatId, toDir) : null;
    if (dest) {
      withDir(chatId, dest.segments.slice(0, -1), false, (dirFd) => {
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(fdPath(dirFd, dest.segments[dest.segments.length - 1])); } catch { /* reported below */ }
        if (!st?.isDirectory()) throw new WorkspaceError(`目标文件夹不存在:${dest.rel}`, 404);
      });
    }
    const moved: { from: string; to: string }[] = [];
    const failed: BatchFailure[] = [];
    for (const from of topLevelPaths(chatId, paths)) {
      const to = dest ? `${dest.rel}/${basename(from)}` : basename(from);
      if (to === from) continue;
      try { moved.push(renameLocked(chatId, from, to)); } catch (err) { failed.push(batchFailure(from, err)); }
    }
    return { moved, failed };
  });
}

export function deleteWorkspacePaths(chatId: string, paths: string[]): Promise<{
  deleted: string[]; removed: number; failed: BatchFailure[];
}> {
  return withChatLock(chatId, () => {
    const deleted: string[] = [];
    const failed: BatchFailure[] = [];
    let removed = 0;
    for (const rel of topLevelPaths(chatId, paths)) {
      try {
        removed += deleteWorkspacePathLocked(chatId, rel).removed;
        deleted.push(rel);
      } catch (err) {
        // Already gone is what the person wanted.
        if (err instanceof WorkspaceError && err.statusCode === 404) deleted.push(rel);
        else failed.push(batchFailure(rel, err));
      }
    }
    return { deleted, removed, failed };
  });
}

/** Zip the chosen files and folders, each named relative to its own parent.
    Reads follow the same descriptor chain as everything else; hidden names
    are left out like in the listing. */
export async function zipWorkspacePaths(chatId: string, paths: string[]): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  let total = 0;
  const add = (zipName: string, fd: number) => {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return;
    total += st.size;
    if (total > config.maxWorkspaceBytes) {
      throw new WorkspaceError(`所选内容超过 ${Math.round(config.maxWorkspaceBytes / 1048576)} MB,请分批下载`, 413);
    }
    zip.file(zipName, fs.readFileSync(fd), { date: new Date(st.mtimeMs) });
  };
  for (const rel of topLevelPaths(chatId, paths)) {
    const { dirs, name } = split(chatId, rel);
    withDir(chatId, dirs, false, (dirFd) => {
      let st: fs.Stats;
      try { st = fs.lstatSync(fdPath(dirFd, name)); } catch (err) { translate(err, rel); }
      if (st.isDirectory()) {
        zip.folder(name);
        const fd = fs.openSync(fdPath(dirFd, name), DIR_FLAGS);
        try {
          walk(fd, name, dirs.length + 1, {
            file(parent, fileName, fileRel) {
              if (fileName.startsWith('.')) return;
              const f = fs.openSync(fdPath(parent, fileName), FILE_READ_FLAGS);
              try { add(fileRel, f); } finally { fs.closeSync(f); }
            },
            dir(dirRel) {
              if (basename(dirRel).startsWith('.')) return false;
              zip.folder(dirRel);
            },
          });
        } finally { fs.closeSync(fd); }
      } else {
        let fd: number;
        try { fd = fs.openSync(fdPath(dirFd, name), FILE_READ_FLAGS); } catch (err) { translate(err, rel); }
        try { add(name, fd); } finally { fs.closeSync(fd); }
      }
    });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Remove the whole directory (chat deleted / swept). fs.rm never follows
    symlinks, and the root path is ours. Best effort. */
export function removeWorkspace(chatId: string): void {
  try { fs.rmSync(privateWorkspaceRoot(chatId), { recursive: true, force: true }); }
  catch (err) { console.warn(`[workspace] remove ${chatId} failed: ${(err as Error).message}`); }
}

/** Project deletion owns the project directory; chat deletion only owns its
    private directory, even while that chat uses a shared workspace. */
export function removeProjectWorkspaces(projectId: string): void {
  try { fs.rmSync(projectWorkspaceRoot(projectId), { recursive: true, force: true }); }
  catch (err) { console.warn(`[workspace] remove project ${projectId} failed: ${(err as Error).message}`); }
  try { fs.rmSync(path.join(config.dataDir, 'workspace-imports', projectId), { recursive: true, force: true }); }
  catch (err) { console.warn(`[workspace] remove import ledger ${projectId} failed: ${(err as Error).message}`); }
}

/** Keep project files even if their last chat was deleted or sharing is off.
    Remove them only when the project or the file owner no longer exists. */
export function sweepOrphanWorkspaces(): number {
  let removed = 0;
  for (const d of storedWorkspaces()) {
    const keep = d.chatId
      ? db.select({ id: schema.chats.id }).from(schema.chats).where(eq(schema.chats.id, d.chatId)).get()
      : db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, d.projectId!)).get()
        && db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, d.userId!)).get();
    if (keep) { sweepRoot(d.root); continue; }
    try {
      fs.rmSync(d.root, { recursive: true, force: true });
      if (d.projectId && d.userId) fs.rmSync(path.join(config.dataDir, 'workspace-imports', d.projectId, `${d.userId}.json`), { force: true });
      removed += 1;
    } catch { /* retry next startup */ }
  }
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

function manifestLines(listing: WorkspaceListing, chatId: string): string {
  const lines = listing.files.map((f) => `- ${workspaceFileLink(chatId, f.path)}(${fmtBytes(f.size)})`);
  if (listing.truncated) lines.push(`…(文件过多,仅列出前 ${listing.files.length} 个)`);
  return lines.join('\n');
}

/** System-prompt block: what the workspace is for, how to use it, and the
    current manifest so the model knows what already exists without a call. */
export function buildWorkspacePrompt(chatId: string): string {
  const listing = listWorkspace(chatId, LIST_LIMIT);
  const manifest = listing.files.length ? manifestLines(listing, chatId) : '(工作区目前为空)';
  return [
    '[工作区]',
    workspaceScope(chatId).kind === 'project'
      ? '本对话使用当前用户的项目工作区,同一用户在本项目中的所有对话和子代理共用这些文件,其他项目成员各自独立。已有文件可能来自另一段对话,修改前先读取。用户可在右侧工作区面板管理文件。你通过 workspace_* 工具读写它。用法:'
      : '本对话有一个私有的文件工作区,用户能在界面右侧的「工作区」面板查看、预览、下载、上传和删除其中的文件。你通过 workspace_* 工具读写它。用法:',
    '- 篇幅较长或需要反复打磨的成果(文章、报告、方案、代码、数据、大纲等)写进文件,而不是整段贴在回复里;回复中说明做了什么、文件叫什么,并给出简短摘要或要点。零散的简短回答照常直接回复,不必写文件。',
    '- 修改已有文件时,先 workspace_read 核对原文,再用 workspace_edit 做局部替换;不要为了改几句话就用 workspace_write 整篇重写。',
    '- 文件名要有意义并带扩展名(如 方案.md、数据.csv、index.html)。用户上传到工作区的文件,先读取再处理。',
    '- 文件已经写好后,不要再把整份内容复制到回复里。',
    `- 提及工作区成果时,用可点击的 Markdown 文件链接。优先原样使用工具结果或下方文件清单给出的链接;格式为 [文件名](/chat/${chatId}?file=URL编码后的工作区相对路径),例如 ${workspaceFileLink(chatId, '方案.md')}。点击会打开工作区中的该文件。不要把文件名拼成 /chat/文件名,不要编造域名、下载地址或本地磁盘地址。文件尚未成功生成时不要声称已可打开。`,
    `当前文件:\n${manifest}`,
  ].join('\n');
}

type ToolOutcome = { result: string; isError: boolean };

export function callWorkspaceTool(chatId: string, name: string, argsJson: string): Promise<ToolOutcome> {
  return withWorkspaceScope(chatId, () => callScopedWorkspaceTool(chatId, name, argsJson));
}

async function callScopedWorkspaceTool(chatId: string, name: string, argsJson: string): Promise<ToolOutcome> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* treated as empty */ }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  try {
    switch (name) {
      case 'workspace_list': {
        const listing = listWorkspace(chatId, LIST_LIMIT);
        if (!listing.files.length) return { result: '工作区目前为空。', isError: false };
        return { result: `${manifestLines(listing, chatId)}\n共 ${listing.files.length} 个文件,${fmtBytes(listing.bytes)}`, isError: false };
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
        return { result: `${header}\n${slice}\n${footer}\n文件链接:${workspaceFileLink(chatId, resolveSafe(chatId, rel).rel)}`, isError: false };
      }
      case 'workspace_write': {
        const rel = str('path');
        if (!rel) return { result: '缺少 path 参数', isError: true };
        if (typeof args.content !== 'string') return { result: '缺少 content 参数', isError: true };
        const r = await writeWorkspaceFile(chatId, rel, args.content);
        return { result: `已写入 ${r.rel}(${fmtBytes(r.size)})\n文件链接:${workspaceFileLink(chatId, r.rel)}`, isError: false };
      }
      case 'workspace_edit': {
        const rel = str('path');
        if (!rel) return { result: '缺少 path 参数', isError: true };
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          return { result: '缺少 old_string / new_string 参数', isError: true };
        }
        const r = await editWorkspaceFile(chatId, rel, args.old_string, args.new_string, args.replace_all === true);
        return {
          result: `已替换 ${r.replacements} 处,${r.rel} 现为 ${fmtBytes(r.size)}。\n文件链接:${workspaceFileLink(chatId, r.rel)}\n修改处附近的新内容:\n…${r.context}…`,
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
