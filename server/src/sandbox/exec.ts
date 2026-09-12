// Run one shell command for a chat, isolated and bounded.
//
//   systemd-run --user (cgroup: memory / CPU / pids / runtime backstop)
//     └─ bwrap (own mount, pid, net, ipc, uts, user namespaces)
//          └─ /bin/sh -c <command>   cwd = /workspace (the chat's 工作区, rw)
//
// The only writable places are the workspace and tmpfs. /usr is read-only,
// the venv is read-only at /opt/venv, there is no network, and the process
// tree dies with the sandbox. Our own timer is the authoritative timeout;
// RuntimeMaxSec is a backstop for the case where we are the ones that died.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { config } from '../config.js';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { enforceWorkspaceQuota, sweepIrregularEntries, workspaceOverQuota, workspaceRoot } from '../workspace.js';
import { withChatLock } from '../workspace-lock.js';
import { ensureSeccompFilter } from './seccomp.js';
import { skillDir, skillsFor, type SkillUser } from '../skills.js';
import { bwrapBaseArgs, cachedSandboxEnv, probeSandboxEnv, sandboxProcessEnv } from './env.js';
import { getSandboxSettings, type SandboxSettings } from './settings.js';
import { venvDir, venvExists } from './venv.js';
import { skillsRoot } from '../skills.js';

export interface RunRequest {
  userId: string;
  /** Role decides which 技能 directories are visible inside the sandbox. */
  user: SkillUser;
  chatId: string;
  messageId?: string;
  command: string;
  /** Caller-requested timeout; clamped to the admin setting. */
  timeoutSec?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  /** Files the quota enforcer had to remove after the run (over budget). */
  quotaRemoved?: { path: string; size: number }[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export class SandboxBusyError extends Error {}

// ---- admission ----
let globalRunning = 0;
const perUserRunning = new Map<string, number>();

function acquire(userId: string): () => void {
  if (globalRunning >= config.maxSandboxConcurrency) throw new SandboxBusyError('沙盒繁忙:同时执行的命令已达上限,请稍后再试');
  if ((perUserRunning.get(userId) ?? 0) >= 1) throw new SandboxBusyError('你已有一条命令在执行中,请等它结束');
  globalRunning += 1;
  perUserRunning.set(userId, (perUserRunning.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalRunning -= 1;
    const n = (perUserRunning.get(userId) ?? 1) - 1;
    if (n <= 0) perUserRunning.delete(userId); else perUserRunning.set(userId, n);
  };
}

export function sandboxLoad(): { running: number; max: number } {
  return { running: globalRunning, max: config.maxSandboxConcurrency };
}

// ---- argv ----

function nodeBinDir(): string { return path.dirname(process.execPath); }

function bwrapArgv(bwrap: string, workspace: string, command: string, user: SkillUser, seccomp: string | null, tmpfsBytes: number): string[] {
  const args = [bwrap, ...bwrapBaseArgs(tmpfsBytes)];
  args.push('--tmpfs', '/home', '--dir', '/home/sandbox');
  args.push('--bind', workspace, '/workspace', '--chdir', '/workspace');
  const pathParts = ['/usr/local/bin', '/usr/bin', '/bin'];
  if (venvExists()) {
    args.push('--ro-bind', venvDir, '/opt/venv');
    pathParts.unshift('/opt/venv/bin');
  }
  args.push('--ro-bind', nodeBinDir(), '/opt/node/bin');
  // 技能 scripts and reference files, read-only — and only the skills this
  // person may use. Mounting the whole tree would let a command `cat` a
  // restricted or disabled skill the application layer refuses to show.
  const visibleSkills = skillsFor(user).filter((r) => fs.existsSync(skillDir(r.slug)));
  if (visibleSkills.length) {
    args.push('--tmpfs', '/skills');
    for (const r of visibleSkills) args.push('--ro-bind', skillDir(r.slug), `/skills/${r.slug}`);
  }
  // Syscall denylist (symlink / mknod / mount / unshare …): fd 3 is opened
  // by the sh wrapper below, before bwrap starts.
  if (seccomp) args.push('--seccomp', '3');
  pathParts.push('/opt/node/bin');
  args.push(
    '--unshare-all', '--new-session', '--die-with-parent', '--clearenv',
    '--setenv', 'PATH', pathParts.join(':'),
    '--setenv', 'HOME', '/home/sandbox',
    '--setenv', 'USER', 'sandbox',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'TERM', 'dumb',
    '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
    '--setenv', 'PYTHONIOENCODING', 'utf-8',
    '--setenv', 'PYTHONUNBUFFERED', '1',
    '--setenv', 'MPLBACKEND', 'Agg',
    '--setenv', 'MPLCONFIGDIR', '/tmp/mpl',
    '--setenv', 'XDG_CACHE_HOME', '/tmp/cache',
    '--setenv', 'XDG_CONFIG_HOME', '/tmp/config',
    '--setenv', 'NO_COLOR', '1',
  );
  if (venvExists()) args.push('--setenv', 'VIRTUAL_ENV', '/opt/venv');
  // Files the command creates stay private to the service user (0600),
  // matching what the panel itself writes.
  args.push('--', '/bin/sh', '-c', `umask 077\n${command}`);
  return args;
}

function systemdArgv(systemdRun: string, unit: string, s: SandboxSettings, timeoutSec: number, inner: string[]): string[] {
  return [
    systemdRun, '--user', '--wait', '--pipe', '--quiet', '--collect', `--unit=${unit}`,
    '-p', `MemoryMax=${s.memoryMb}M`, '-p', 'MemorySwapMax=0',
    '-p', `CPUQuota=${s.cpuPercent}%`,
    '-p', `TasksMax=${s.maxPids}`,
    // per-file ceiling (SIGXFSZ past it): the workspace budget's first line
    // of defence; the post-run enforcer handles the sum
    '-p', `LimitFSIZE=${config.maxWorkspaceFileBytes}`,
    '-p', `RuntimeMaxSec=${timeoutSec + 15}`,
    '--', ...inner,
  ];
}

function stopUnit(systemctlDir: string, unit: string) {
  const systemctl = path.join(systemctlDir, 'systemctl');
  execFile(systemctl, ['--user', 'kill', '--signal=SIGKILL', unit], { env: sandboxProcessEnv(), timeout: 5000 }, () => { /* best effort */ });
}

// ---- run ----

export async function runInSandbox(req: RunRequest): Promise<RunResult> {
  const env = cachedSandboxEnv() ?? await probeSandboxEnv();
  if (!env.runnable || !env.bwrapPath) throw new Error('沙盒环境不可用,请管理员在后台检查');
  const s = getSandboxSettings();
  const timeoutSec = Math.max(5, Math.min(s.timeoutSec, req.timeoutSec ?? s.timeoutSec));
  const workspace = workspaceRoot(req.chatId);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  // Leftovers from an earlier run (or from before seccomp) never meet a
  // command; and a workspace already over budget gets nothing more written.
  try { sweepIrregularEntries(req.chatId); } catch { /* best effort */ }
  const quotaBefore = workspaceOverQuota(req.chatId);
  if (quotaBefore.over) {
    throw new Error(`工作区已超出配额(${Math.round(quotaBefore.bytes / 1048576)} MB / ${quotaBefore.files} 个文件),请先删除一些文件再执行命令`);
  }

  const release = acquire(req.userId);
  const t0 = Date.now();
  const unit = `caui-sbx-${crypto.randomBytes(6).toString('hex')}`;
  const seccomp = ensureSeccompFilter();
  const bwrapPart = bwrapArgv(env.bwrapPath, workspace, req.command, req.user, seccomp, s.memoryMb * 1048576);
  // `sh -c 'exec 3<"$1"; shift; exec "$@"' sh <filter> bwrap …` — opens the
  // filter on fd 3 for --seccomp without any quoting of the real argv.
  let inner = seccomp
    ? ['/bin/sh', '-c', 'exec 3<"$1"; shift; exec "$@"', 'sh', seccomp, ...bwrapPart]
    : bwrapPart;
  const useSystemd = env.limitsAvailable && !!env.systemdRunPath;
  // Without systemd the per-file ceiling comes from prlimit (util-linux).
  if (!useSystemd && env.prlimitPath) inner = [env.prlimitPath, `--fsize=${config.maxWorkspaceFileBytes}`, '--', ...inner];
  const argv = useSystemd ? systemdArgv(env.systemdRunPath!, unit, s, timeoutSec, inner) : inner;

  // The chat lock is shared with every host-side write (tool, panel upload,
  // edit, delete): while a command may be rearranging the directory from
  // inside, nothing on the host writes into it.
  const result = await withChatLock(req.chatId, () => new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const cap = s.maxOutputChars;
    const child = spawn(argv[0], argv.slice(1), {
      env: sandboxProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !useSystemd,
    });
    const append = (which: 'out' | 'err', d: Buffer) => {
      const text = d.toString('utf8');
      if (which === 'out') {
        if (stdout.length < cap) stdout += text.slice(0, cap - stdout.length); else truncated = true;
        if (stdout.length >= cap && text.length > cap - stdout.length) truncated = true;
      } else {
        if (stderr.length < cap) stderr += text.slice(0, cap - stderr.length); else truncated = true;
      }
    };
    child.stdout.on('data', (d: Buffer) => append('out', d));
    child.stderr.on('data', (d: Buffer) => append('err', d));

    const kill = () => {
      if (useSystemd && env.systemdRunPath) stopUnit(path.dirname(env.systemdRunPath), unit);
      try {
        // Without systemd the sandbox is our process group: kill the group so
        // bwrap and everything under it go together.
        if (!useSystemd && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    const onAbort = () => { kill(); };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, truncated, durationMs: Date.now() - t0 });
    };
    child.on('error', (err) => { stderr += `\n无法启动沙盒:${err.message}`; finish(null); });
    child.on('close', (code) => finish(code));
  }).then((r) => {
    // Still inside the chat lock: scrub, then pull the workspace back under
    // budget by removing what this run produced (largest first).
    try { sweepIrregularEntries(req.chatId); } catch { /* best effort */ }
    try {
      const q = enforceWorkspaceQuota(req.chatId);
      if (q.removed.length) r.quotaRemoved = q.removed;
    } catch { /* best effort */ }
    return r;
  })).finally(release);

  db.insert(schema.sandboxRuns).values({
    id: newId(), userId: req.userId, chatId: req.chatId, messageId: req.messageId ?? null,
    command: req.command.slice(0, 4000),
    exitCode: result.exitCode, timedOut: result.timedOut ? 1 : 0,
    durationMs: result.durationMs, outputChars: result.stdout.length + result.stderr.length,
    createdAt: now(),
  }).run();
  return result;
}

/** What the model reads back. Plain text with clear sections; the client
    renders the same string in the tool row. */
export function formatRunResult(r: RunResult, timeoutSec: number): string {
  const head = r.timedOut
    ? `命令超过 ${timeoutSec} 秒时限,已被终止`
    : r.exitCode === 0 ? `退出码 0(${(r.durationMs / 1000).toFixed(1)} 秒)`
    : `退出码 ${r.exitCode ?? '?'}(${(r.durationMs / 1000).toFixed(1)} 秒)`;
  const parts = [head];
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(没有输出)');
  if (r.truncated) parts.push('(输出过长,已截断)');
  if (r.quotaRemoved?.length) {
    parts.push(`工作区超出 ${Math.round(config.maxWorkspaceBytes / 1048576)} MB 配额,本次命令生成的以下文件已被删除:${r.quotaRemoved.map((f) => `${f.path}(${(f.size / 1048576).toFixed(1)} MB)`).join(', ')}。请控制输出文件大小。`);
  }
  return parts.join('\n');
}
