// 系统更新: move the deployed git checkout to a newer upstream commit, rebuild
// it and restart the service from the admin console — no shell, no sudo.
//
// The panel cannot start itself again. It exits and leaves that to whatever
// supervises it (a systemd unit with Restart=, pm2), so restarting is only
// offered when such a supervisor is detected. Everything before that exit can
// be undone: the database is snapshotted, the merge is fast-forward only, the
// new web build goes to a staging directory nothing is served from, and the new
// server build has to start cleanly against a copy of the database. A failure
// anywhere resets the checkout and the build output, and the running process —
// whose code was loaded when it started — carries on as if nothing happened.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { config, repoRoot, serverRoot } from './config.js';
import { backupDir, runBackup } from './backup.js';
import { activeWork } from './admission.js';
import { activePptJobs } from './routes/ppt.js';
import { sandboxProcessEnv } from './sandbox/env.js';

/** Printed by a build started with STARTUP_SELF_TEST=1 once every route is
    registered (index.ts). Older panels look for exactly this line — keep it. */
export const SELF_TEST_OK = 'startup self-test passed';

const UPDATE_DIR = path.join(config.dataDir, 'update');
const JOB_FILE = path.join(UPDATE_DIR, 'last-job.json');
const STAGED_FILE = path.join(UPDATE_DIR, 'staged.json');
const SAVED_SERVER_DIST = path.join(UPDATE_DIR, 'server-dist');
const SERVER_DIST = path.join(serverRoot, 'dist');
const WEB_DIST = path.join(repoRoot, 'web', 'dist');
// The update's web build goes here (vite.config.ts honours WEB_OUT_DIR) and is
// swapped in just before the restart: until then every page load still gets
// the frontend that matches the running server.
const WEB_STAGED = path.join(repoRoot, 'web', 'dist.next');
const WEB_RETIRED = path.join(repoRoot, 'web', 'dist.old');

const GIT_TIMEOUT_MS = 60_000;
const NPM_TIMEOUT_MS = 20 * 60_000;
const SELF_TEST_TIMEOUT_MS = 2 * 60_000;
const IDLE_WAIT_MAX_MS = 20 * 60_000;
const LOG_LINES_MAX = 500;
const OUTPUT_MAX = 1024 * 1024;
const VITE_ASSET_ROW = /^\s*\S+\/assets\/\S+\s+[\d.,]+ kB/;
const INCOMING_MAX = 50;

export interface CommitInfo { hash: string; subject: string; author: string; date: number }

export interface RepoState {
  /** The checkout this process runs from. */
  root: string;
  /** False when this deployment can't be updated from the panel; `reason` says why. */
  available: boolean;
  reason: string | null;
  branch: string | null;
  upstream: string | null;
  remoteUrl: string | null;
  head: CommitInfo | null;
  upstreamHead: CommitInfo | null;
  ahead: number;
  behind: number;
  /** Upstream commits HEAD lacks, newest first (at most INCOMING_MAX). */
  incoming: CommitInfo[];
  changes: { files: number; server: boolean; web: boolean; deps: boolean };
  /** Tracked files with uncommitted changes — an update refuses to run over them. */
  dirty: string[];
  lastFetchAt: number | null;
}

export interface Supervisor {
  kind: 'systemd' | 'pm2' | null;
  /** systemd unit / pm2 app name */
  name: string | null;
  /** systemd Restart= */
  policy: string | null;
  /** Exiting gets this process started again. */
  canRestart: boolean;
  /** Why not, when it can't. */
  problem: 'none' | 'policy' | 'not-main' | 'autorestart-off' | null;
}

type StepId = 'backup' | 'merge' | 'install' | 'build' | 'selftest' | 'wait' | 'restart';

export interface UpdateStep {
  id: StepId;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  startedAt: number | null;
  endedAt: number | null;
}

export interface UpdateJob {
  id: string;
  kind: 'update' | 'restart';
  status: 'running' | 'waiting' | 'restarting' | 'done' | 'failed' | 'cancelled';
  /** Admin who started it. */
  by: string;
  from: string | null;
  to: string | null;
  steps: UpdateStep[];
  log: string[];
  error: string | null;
  /** A failed update whose rollback failed too: the checkout needs a person. */
  rollbackFailed: boolean;
  /** Done, but nothing will restart the process — someone has to. */
  manualRestart: boolean;
  /** Deadline of the wait for running work to finish. */
  waitUntil: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Start time of the process this job restarted into. */
  restartedAt: number | null;
}

export class UpdateError extends Error {}

/** Changes with every start: the admin page polls for a new one to see a restart land. */
export const bootId = crypto.randomUUID();
const bootedAt = Date.now();
const bootCommit = readHead();
const bootVersion = readVersion();

let current: UpdateJob | null = null;
let last: UpdateJob | null = null;
let starting = false;
let fetching: Promise<void> | null = null;
let waitAction: 'now' | 'cancel' | null = null;
let closeServer: (() => Promise<unknown>) | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (hash: string | null) => (hash ? hash.slice(0, 7) : '?');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function readHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? '';
  } catch {
    return '';
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Credentials embedded in a remote URL (https://user:token@host) never reach the page or the log. */
function redactUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1');
}

// ---------- child processes ----------

/** Environment for git, npm and the self-test. */
function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // What npm exports to scripts would leak the outer npm's settings into
    // ours when the panel itself was started through `npm start`.
    if (!k.startsWith('npm_')) env[k] = v;
  }
  // npm, and every node its scripts start, must be the node running the panel:
  // service units often leave its directory off PATH, and a system node of
  // another major version would build native modules (better-sqlite3) for the
  // wrong ABI — the restarted service would then fail to load them.
  env.PATH = [path.dirname(process.execPath), process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(path.delimiter);
  // Service units set NODE_ENV=production, which makes npm leave out the
  // devDependencies the build needs.
  delete env.NODE_ENV;
  // Nobody is there to answer a password or host-key prompt.
  env.GIT_TERMINAL_PROMPT = '0';
  env.SSH_ASKPASS_REQUIRE = 'never';
  env.npm_config_update_notifier = 'false';
  return Object.assign(env, extra);
}

interface RunResult {
  code: number | null; stdout: string; stderr: string;
  /** Some output line matched `failOn`. */
  flagged: boolean;
}

function run(file: string, args: string[], opts: {
  timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; job?: UpdateJob; label?: string; failOn?: RegExp;
}): Promise<RunResult> {
  const { job } = opts;
  if (job) pushLog(job, `$ ${opts.label ?? [file, ...args].join(' ')}`);
  return new Promise((resolve, reject) => {
    // umask 022: what the update writes (checkout, node_modules, builds) gets
    // the modes a person running the same commands would give it, not the
    // panel's own 077. Own process group, so a timeout takes down the whole
    // tree (npm → node-gyp → make), not just its root.
    const child = spawn('/bin/sh', ['-c', 'umask 022 && exec "$@"', 'sh', file, ...args], {
      cwd: opts.cwd ?? repoRoot, env: opts.env ?? toolEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let stdout = '';
    let stderr = '';
    let flagged = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }, opts.timeoutMs);
    // Chunks split lines anywhere; look at whole lines only. The log skips
    // vite's per-file size table, a hundred lines that would push the rest out.
    const line = (raw: string) => {
      const l = stripAnsi(raw);
      if (opts.failOn?.test(l)) flagged = true;
      if (job && !VITE_ASSET_ROW.test(l)) pushLog(job, l);
    };
    const logLines = () => {
      let rest = '';
      return {
        push(s: string) {
          rest += s;
          const parts = rest.split(/\r?\n|\r/);
          rest = parts.pop()!;
          parts.forEach(line);
        },
        flush() { if (rest) line(rest); rest = ''; },
      };
    };
    const outLog = logLines();
    const errLog = logLines();
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (stdout.length < OUTPUT_MAX) stdout += s;
      outLog.push(s);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (stderr.length < OUTPUT_MAX) stderr += s;
      errLog.push(s);
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      outLog.flush();
      errLog.flush();
      if (timedOut) reject(new Error(`${opts.label ?? file} 超时(${Math.round(opts.timeoutMs / 1000)} 秒),已终止`));
      else resolve({ code, stdout, stderr, flagged });
    });
  });
}

/** stdout of a read-only git command, or null when it fails. */
async function gitOut(args: string[]): Promise<string | null> {
  try {
    const r = await run('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], { timeoutMs: GIT_TIMEOUT_MS });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** A git command inside a job: logged, and fatal when it fails. */
async function gitStep(job: UpdateJob, args: string[]): Promise<void> {
  const r = await run('git', args, { timeoutMs: GIT_TIMEOUT_MS, job, label: `git ${args.join(' ')}` });
  if (r.code !== 0) throw new Error(`git ${args[0]} 失败(退出码 ${r.code})`);
}

/** npm's own entry script, to run under this process's node. Null: rely on
    `npm` from PATH (whose `#!/usr/bin/env node` then finds this node first). */
function npmCli(): string | null {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'npm')),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const real = fs.realpathSync(c);
      if (path.basename(real) === 'npm-cli.js' && fs.statSync(real).isFile()) return real;
    } catch { /* next */ }
  }
  return null;
}

// npm's own error lines: "npm ERR!" up to v9, "npm error" since v10.
const NPM_ERROR_LINE = /^npm (?:ERR!|error)(?:\s|$)/;

async function npm(job: UpdateJob, args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  const cli = npmCli();
  const r = await run(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
    timeoutMs: NPM_TIMEOUT_MS, env: toolEnv(extraEnv), job, label: `npm ${args.join(' ')}`, failOn: NPM_ERROR_LINE,
  });
  const what = args[0] === 'run' ? `npm run ${args[1]}` : `npm ${args[0]}`;
  if (r.code !== 0) throw new Error(`${what} 失败(退出码 ${r.code})`);
  // Its exit status alone can't be trusted: npm 9 under Node 22 exits 0 when
  // a workspace script fails (Debian/Ubuntu still ship that npm).
  if (r.flagged) throw new Error(`${what} 失败(npm 报告了错误)`);
}

const NPM_INSTALL = ['install', '--include=dev', '--no-save', '--no-audit', '--no-fund'];

// ---------- repository ----------

const LOG_FORMAT = '--format=%H%x1f%s%x1f%an%x1f%ct';

function parseCommits(out: string | null): CommitInfo[] {
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, subject, author, ct] = line.split('\x1f');
    return { hash, subject, author, date: Number(ct) * 1000 };
  });
}

const DEPS_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc']);
const isDepsFile = (file: string) => DEPS_FILES.has(path.posix.basename(file));

function sameDir(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

/** What stopped `git rev-parse` in the checkout, in words an operator can act on. */
function gitProblem(r: RunResult | null): string {
  if (!r || r.code === 127) return '服务器上找不到 git(没有安装,或不在服务的 PATH 里),无法在面板里更新';
  if (/dubious ownership/.test(r.stderr)) {
    return `仓库 ${repoRoot} 的所有者不是运行服务的用户,git 拒绝操作;请让服务以仓库所有者的身份运行(systemd 单元的 User=),或把仓库 chown 给服务用户`;
  }
  if (/not a git repository/.test(r.stderr)) return `${repoRoot} 不是 git 仓库的检出(例如复制文件或解压部署的),无法在面板里更新`;
  return `无法读取 git 仓库:${redactUrls(r.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? `退出码 ${r.code}`)}`;
}

export async function inspectRepo(): Promise<RepoState> {
  const s: RepoState = {
    root: repoRoot, available: false, reason: null, branch: null, upstream: null, remoteUrl: null,
    head: null, upstreamHead: null, ahead: 0, behind: 0, incoming: [],
    changes: { files: 0, server: false, web: false, deps: false }, dirty: [], lastFetchAt: null,
  };
  const probe = await run('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
    .catch(() => null);
  const top = probe?.code === 0 ? probe.stdout.trim() : '';
  if (!top) {
    s.reason = gitProblem(probe);
    return s;
  }
  if (!sameDir(top, repoRoot)) {
    s.reason = `${repoRoot} 在另一个 git 仓库(${top})里面,无法在面板里更新`;
    return s;
  }
  // Updating as someone other than the owner leaves files the owner can't
  // touch, and their next `git pull` by hand fails on them. git refuses this
  // by itself, unless safe.directory has been set to let it through.
  const uid = process.getuid?.();
  let owner: number | null = null;
  try { owner = fs.statSync(path.join(repoRoot, '.git')).uid; } catch { /* checked by git above */ }
  if (uid !== undefined && owner !== null && owner !== uid) {
    s.reason = `仓库 ${repoRoot} 属于另一个用户(uid ${owner}),服务以 uid ${uid} 运行;从面板更新会留下属主不同的文件。请让服务以仓库所有者的身份运行(systemd 单元的 User=),或把仓库 chown 给服务用户`;
    return s;
  }
  s.head = parseCommits(await gitOut(['log', '-1', LOG_FORMAT, 'HEAD']))[0] ?? null;
  s.dirty = (await gitOut(['status', '--porcelain', '--untracked-files=no']))
    ?.split('\n').filter(Boolean).map((l) => l.slice(3)) ?? [];
  const fetchHead = (await gitOut(['rev-parse', '--git-path', 'FETCH_HEAD']))?.trim();
  if (fetchHead) {
    try { s.lastFetchAt = fs.statSync(path.resolve(repoRoot, fetchHead)).mtimeMs; } catch { /* never fetched */ }
  }
  s.branch = (await gitOut(['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
  if (!s.branch) {
    s.reason = '仓库没有检出分支(处于分离 HEAD 状态),无法在面板里更新';
    return s;
  }
  s.upstream = (await gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))?.trim() || null;
  if (!s.upstream) {
    s.reason = `分支 ${s.branch} 没有设置上游分支,无法在面板里更新`;
    return s;
  }
  const remote = (await gitOut(['config', `branch.${s.branch}.remote`]))?.trim();
  const url = remote ? (await gitOut(['remote', 'get-url', remote]))?.trim() : null;
  s.remoteUrl = url ? redactUrls(url) : null;
  s.upstreamHead = parseCommits(await gitOut(['log', '-1', LOG_FORMAT, '@{upstream}']))[0] ?? null;
  const counts = (await gitOut(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']))?.trim().split(/\s+/).map(Number);
  if (counts?.length === 2 && counts.every(Number.isFinite)) [s.ahead, s.behind] = counts;
  if (s.behind > 0) {
    s.incoming = parseCommits(await gitOut(['log', LOG_FORMAT, `-n${INCOMING_MAX}`, 'HEAD..@{upstream}']));
    const files = (await gitOut(['diff', '--name-only', 'HEAD...@{upstream}']))?.split('\n').filter(Boolean) ?? [];
    s.changes = {
      files: files.length,
      server: files.some((f) => f.startsWith('server/')),
      web: files.some((f) => f.startsWith('web/')),
      deps: files.some(isDepsFile),
    };
  }
  s.available = true;
  return s;
}

/** `git fetch` the current branch's remote. Concurrent callers share one fetch. */
export function fetchUpstream(): Promise<void> {
  if (current) return Promise.reject(new UpdateError('有更新任务正在进行,请稍后再检查'));
  fetching ??= (async () => {
    const branch = (await gitOut(['symbolic-ref', '--short', '-q', 'HEAD']))?.trim();
    const remote = branch ? (await gitOut(['config', `branch.${branch}.remote`]))?.trim() : null;
    if (!remote) throw new UpdateError('当前分支没有设置上游分支');
    let r: RunResult;
    try {
      r = await run('git', ['fetch', '--quiet', remote], { timeoutMs: GIT_TIMEOUT_MS, label: 'git fetch' });
    } catch (err) {
      throw new UpdateError(errorText(err));
    }
    if (r.code !== 0) {
      const detail = redactUrls(r.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? `退出码 ${r.code}`);
      throw new UpdateError(`拉取远端失败:${detail}`);
    }
  })().finally(() => { fetching = null; });
  return fetching;
}

// ---------- supervisor ----------

/** The systemd unit this process runs in, from its cgroup path. */
function systemdUnit(): { name: string; user: boolean } | null {
  let text = '';
  try { text = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    // cgroup v2 "0::/system.slice/caui.service"; v1 "1:name=systemd:/system.slice/…"
    if (!line.startsWith('0::') && !line.includes(':name=systemd:')) continue;
    const parts = line.split(':').slice(2).join(':').split('/').filter(Boolean);
    const isManager = (p: string) => /^user@\d+\.service$/.test(p);
    const unit = [...parts].reverse().find((p) => p.endsWith('.service') && !isManager(p));
    if (unit) return { name: unit, user: parts.some(isManager) };
  }
  return null;
}

// systemd restarts after a clean exit only under these policies; on-failure
// needs a non-zero status.
const RESTARTING_POLICIES = new Set(['always', 'on-success', 'on-failure']);

export async function detectSupervisor(): Promise<Supervisor> {
  if (process.env.pm_id !== undefined) {
    // pm2 exports the app's settings into its environment; it restarts an app
    // whenever it exits unless autorestart was turned off.
    const on = process.env.autorestart !== 'false';
    return { kind: 'pm2', name: process.env.name ?? null, policy: null, canRestart: on, problem: on ? null : 'autorestart-off' };
  }
  const unit = process.env.INVOCATION_ID ? systemdUnit() : null;
  if (!unit) return { kind: null, name: null, policy: null, canRestart: false, problem: 'none' };
  const r = await run('systemctl', [...(unit.user ? ['--user'] : []), 'show', unit.name, '--property=Restart,MainPID'], {
    timeoutMs: 10_000, env: sandboxProcessEnv(),
  }).catch(() => null);
  const props = new Map<string, string>();
  for (const line of r?.code === 0 ? r.stdout.split('\n') : []) {
    const i = line.indexOf('=');
    if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const policy = props.get('Restart') ?? null;
  // Only the unit's main process going away brings the unit down. A panel
  // behind `npm start`, or started by hand from a shell that lives inside some
  // other service, would exit and stay down.
  const isMain = Number(props.get('MainPID')) === process.pid;
  const restarts = !!policy && RESTARTING_POLICIES.has(policy);
  return {
    kind: 'systemd',
    name: unit.name,
    policy,
    canRestart: isMain && restarts,
    problem: !isMain ? 'not-main' : !restarts ? 'policy' : null,
  };
}

/** Running work a restart would cut off. */
export function activity(): { chats: number; images: number; ppt: number } {
  return { ...activeWork(), ppt: activePptJobs() };
}

function busyCount(): number {
  const a = activity();
  return a.chats + a.images + a.ppt;
}

// ---------- jobs ----------

function pushLog(job: UpdateJob, line: string): void {
  const clean = redactUrls(stripAnsi(line)).trimEnd();
  if (!clean.trim()) return;
  job.log.push(clean.length > 500 ? `${clean.slice(0, 500)}…` : clean);
  if (job.log.length > LOG_LINES_MAX) job.log.splice(0, job.log.length - LOG_LINES_MAX);
}

function saveJob(job: UpdateJob): void {
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${JOB_FILE}.tmp`, JSON.stringify(job));
    fs.renameSync(`${JOB_FILE}.tmp`, JOB_FILE);
  } catch (err) {
    console.error('[update] could not record the job:', errorText(err));
  }
}

function loadJob(): UpdateJob | null {
  try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')) as UpdateJob; } catch { return null; }
}

export function currentJob(): UpdateJob | null {
  return current ?? last;
}

function newJob(kind: UpdateJob['kind'], by: string, from: string | null, to: string | null): UpdateJob {
  const ids: StepId[] = kind === 'update'
    ? ['backup', 'merge', 'install', 'build', 'selftest', 'wait', 'restart']
    : ['wait', 'restart'];
  return {
    id: crypto.randomUUID(), kind, status: 'running', by, from, to,
    steps: ids.map((id) => ({ id, status: 'pending', startedAt: null, endedAt: null })),
    log: [], error: null, rollbackFailed: false, manualRestart: false, waitUntil: null,
    startedAt: Date.now(), endedAt: null, restartedAt: null,
  };
}

const stepOf = (job: UpdateJob, id: StepId) => job.steps.find((s) => s.id === id)!;

async function step(job: UpdateJob, id: StepId, fn: () => Promise<void | 'skipped'>): Promise<void> {
  const s = stepOf(job, id);
  s.status = 'running';
  s.startedAt = Date.now();
  try {
    s.status = (await fn()) === 'skipped' ? 'skipped' : 'done';
  } catch (err) {
    s.status = 'failed';
    throw err;
  } finally {
    s.endedAt = Date.now();
    saveJob(job);
  }
}

function finish(job: UpdateJob, status: UpdateJob['status'], error: string | null = null): void {
  job.status = status;
  job.error = error;
  job.endedAt = Date.now();
  current = null;
  last = job;
  saveJob(job);
}

/** Jobs run detached from the request; nothing they throw may take the panel down. */
function detach(job: UpdateJob, work: Promise<void>): void {
  work.catch((err: unknown) => {
    const message = errorText(err);
    console.error(`[update] job failed unexpectedly: ${message}`);
    pushLog(job, message);
    if (current === job) finish(job, 'failed', message);
  });
}

/** Begin an update to `target`, which must lie ahead of HEAD on the upstream branch. */
export async function startUpdate(target: string, by: string): Promise<UpdateJob> {
  if (current || starting) throw new UpdateError('已有更新或重启任务在进行中');
  starting = true;
  try {
    await fetching?.catch(() => undefined);
    const repo = await inspectRepo();
    if (!repo.available) throw new UpdateError(repo.reason ?? '无法在面板里更新');
    if (repo.dirty.length) throw new UpdateError('仓库里有未提交的修改,无法自动更新');
    if (!repo.head || repo.head.hash === target) throw new UpdateError('已经是这个版本');
    // Forward along the upstream branch only: a descendant of HEAD that the
    // upstream contains, not just any commit that is in the object store.
    const ok = async (args: string[]) => (await gitOut(args)) !== null;
    if (!(await ok(['merge-base', '--is-ancestor', 'HEAD', target]))
      || !(await ok(['merge-base', '--is-ancestor', target, '@{upstream}']))) {
      throw new UpdateError('目标版本不在上游分支上,或无法从当前版本快进到它');
    }
    const job = newJob('update', by, repo.head.hash, target);
    current = job;
    saveJob(job);
    console.log(`[update] ${by} started an update ${short(job.from)} → ${short(target)}`);
    detach(job, runUpdate(job));
    return job;
  } finally {
    starting = false;
  }
}

/** Restart only — e.g. to pick up code that was updated by hand. */
export async function startRestart(by: string): Promise<UpdateJob> {
  if (current || starting) throw new UpdateError('已有更新或重启任务在进行中');
  starting = true;
  try {
    const sup = await detectSupervisor();
    if (!sup.canRestart) throw new UpdateError('没有检测到会自动拉起服务的进程守护,无法从面板重启');
    const job = newJob('restart', by, bootCommit, readHead());
    current = job;
    saveJob(job);
    console.log(`[update] ${by} requested a restart`);
    detach(job, restartPhase(job, sup));
    return job;
  } finally {
    starting = false;
  }
}

/** Skip or call off the wait for running work that precedes a restart. */
export function controlWait(action: 'now' | 'cancel'): UpdateJob {
  if (!current || current.status !== 'waiting') throw new UpdateError('没有正在等待重启的任务');
  waitAction = action;
  return current;
}

async function runUpdate(job: UpdateJob): Promise<void> {
  const from = job.from!;
  const to = job.to!;
  let snapshot = '';
  let saved = false;
  let depsChanged = false;
  try {
    await step(job, 'backup', async () => {
      const b = await runBackup();
      snapshot = path.join(backupDir, b.filename);
      pushLog(job, `数据库已快照:${b.filename}`);
    });
    await step(job, 'merge', async () => {
      // The running version's server build, kept until the new one has passed.
      fs.mkdirSync(UPDATE_DIR, { recursive: true, mode: 0o700 });
      fs.rmSync(SAVED_SERVER_DIST, { recursive: true, force: true });
      fs.cpSync(SERVER_DIST, SAVED_SERVER_DIST, { recursive: true });
      saved = true;
      await gitStep(job, ['merge', '--ff-only', to]);
      const files = (await gitOut(['diff', '--name-only', from, to]))?.split('\n').filter(Boolean) ?? [];
      depsChanged = files.some(isDepsFile);
    });
    await step(job, 'install', async () => {
      if (!depsChanged) {
        pushLog(job, '依赖没有变化,跳过安装');
        return 'skipped';
      }
      await npm(job, NPM_INSTALL);
    });
    await step(job, 'build', async () => {
      fs.rmSync(WEB_STAGED, { recursive: true, force: true });
      clearStaged();
      await npm(job, ['run', 'build'], { WEB_OUT_DIR: WEB_STAGED });
      if (!fs.existsSync(path.join(WEB_STAGED, 'index.html'))) {
        throw new Error('前端构建结果没有出现在 web/dist.next(vite.config.ts 需要支持 WEB_OUT_DIR)');
      }
      writeStaged(to);
    });
    await step(job, 'selftest', () => selfTest(job, snapshot));
  } catch (err) {
    const message = errorText(err);
    pushLog(job, message);
    console.error(`[update] failed: ${message}`);
    if (saved) await rollback(job, from, depsChanged);
    finish(job, 'failed', message);
    return;
  }
  fs.rmSync(SAVED_SERVER_DIST, { recursive: true, force: true });
  await restartPhase(job, await detectSupervisor());
}

/** Start the new build once against a scratch copy of the database (index.ts STARTUP_SELF_TEST). */
async function selfTest(job: UpdateJob, snapshot: string): Promise<void> {
  fs.mkdirSync(UPDATE_DIR, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(UPDATE_DIR, 'selftest-'));
  try {
    fs.copyFileSync(snapshot, path.join(dir, 'cat-agentui.db'));
    const env = toolEnv({ DATA_DIR: dir, STARTUP_SELF_TEST: '1' });
    if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
    const r = await run(process.execPath, [path.join(SERVER_DIST, 'index.js')], {
      timeoutMs: SELF_TEST_TIMEOUT_MS, env, cwd: serverRoot, job,
      label: `node dist/index.js (STARTUP_SELF_TEST=1 DATA_DIR=${dir})`,
    });
    if (r.code !== 0 || !r.stdout.includes(SELF_TEST_OK)) throw new Error(`新版本没有通过启动自检(退出码 ${r.code})`);
    pushLog(job, '自检通过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Put the checkout, server build and dependencies back the way they were. */
async function rollback(job: UpdateJob, from: string, depsChanged: boolean): Promise<void> {
  pushLog(job, `回滚到 ${short(from)}…`);
  try {
    fs.rmSync(WEB_STAGED, { recursive: true, force: true });
    clearStaged();
    // The tree had no uncommitted changes when the job began.
    await gitStep(job, ['reset', '--hard', from]);
    fs.rmSync(SERVER_DIST, { recursive: true, force: true });
    fs.cpSync(SAVED_SERVER_DIST, SERVER_DIST, { recursive: true });
    fs.rmSync(SAVED_SERVER_DIST, { recursive: true, force: true });
    if (depsChanged) await npm(job, NPM_INSTALL);
    pushLog(job, '已回滚,运行中的服务没有受到影响');
  } catch (err) {
    job.rollbackFailed = true;
    pushLog(job, `回滚失败:${errorText(err)}`);
  }
}

async function restartPhase(job: UpdateJob, sup: Supervisor): Promise<void> {
  if (!sup.canRestart) {
    stepOf(job, 'wait').status = 'skipped';
    stepOf(job, 'restart').status = 'skipped';
    job.manualRestart = true;
    pushLog(job, '新版本已就绪;面板无法自行重启,请手动重启服务');
    finish(job, 'done');
    return;
  }

  // Let running replies, images and decks finish. New ones may still start
  // meanwhile; the restart takes the first quiet moment.
  const wait = stepOf(job, 'wait');
  wait.startedAt = Date.now();
  if (busyCount() === 0) {
    wait.status = 'skipped';
  } else {
    wait.status = 'running';
    waitAction = null;
    job.status = 'waiting';
    job.waitUntil = Date.now() + IDLE_WAIT_MAX_MS;
    saveJob(job);
    pushLog(job, `等待 ${busyCount()} 个进行中的任务结束…`);
    while (!waitAction && busyCount() > 0 && Date.now() < job.waitUntil) await sleep(1_000);
    if (waitAction === 'cancel') {
      wait.status = 'skipped';
      wait.endedAt = Date.now();
      stepOf(job, 'restart').status = 'skipped';
      pushLog(job, job.kind === 'update' ? '已取消重启;新版本会在下次重启服务后生效' : '已取消重启');
      finish(job, 'cancelled');
      return;
    }
    if (waitAction === 'now') pushLog(job, '不再等待,立即重启');
    else if (busyCount() > 0) pushLog(job, '等待已超过 20 分钟,直接重启');
    wait.status = 'done';
  }
  wait.endedAt = Date.now();

  job.status = 'restarting';
  const restart = stepOf(job, 'restart');
  restart.status = 'running';
  restart.startedAt = Date.now();
  pushLog(job, '正在重启服务…');
  try {
    swapStagedWeb(readHead());
  } catch (err) {
    pushLog(job, `切换前端文件失败:${errorText(err)}`);
  }
  saveJob(job);
  console.log(`[update] restarting for ${job.by} (${sup.kind}${sup.name ? ` ${sup.name}` : ''})`);
  // A beat for the page's poll to see 'restarting', then go. systemd restarts
  // after a clean exit under always/on-success, needs a failure under on-failure.
  const code = sup.policy === 'on-failure' ? 75 : 0;
  setTimeout(() => { void exitForRestart(code); }, 1_500);
}

/** index.ts hands over app.close, so a restart stops taking requests first. */
export function onRestartClose(fn: () => Promise<unknown>): void {
  closeServer = fn;
}

async function exitForRestart(code: number): Promise<never> {
  // Requests in flight get a moment; streams still open after that are cut
  // off, and their replies are marked interrupted at the next start.
  await Promise.race([closeServer?.().catch(() => undefined), sleep(3_000)]);
  process.exit(code);
}

// ---------- staged web build ----------

function writeStaged(commit: string): void {
  fs.writeFileSync(STAGED_FILE, JSON.stringify({ commit }));
}

function clearStaged(): void {
  fs.rmSync(STAGED_FILE, { force: true });
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Make the staged web build live — only when it was built from `commit` and
    nothing newer has been built by hand since; anything else is dropped. */
function swapStagedWeb(commit: string | null): void {
  if (!fs.existsSync(WEB_STAGED)) {
    clearStaged();
    return;
  }
  let built: string | null = null;
  try { built = (JSON.parse(fs.readFileSync(STAGED_FILE, 'utf8')) as { commit?: string }).commit ?? null; } catch { /* none */ }
  clearStaged();
  const stagedIndex = path.join(WEB_STAGED, 'index.html');
  if (!commit || built !== commit || !fs.existsSync(stagedIndex)
    || mtime(path.join(WEB_DIST, 'index.html')) > mtime(stagedIndex)) {
    fs.rmSync(WEB_STAGED, { recursive: true, force: true });
    return;
  }
  fs.rmSync(WEB_RETIRED, { recursive: true, force: true });
  const hadLive = fs.existsSync(WEB_DIST);
  if (hadLive) fs.renameSync(WEB_DIST, WEB_RETIRED);
  try {
    fs.renameSync(WEB_STAGED, WEB_DIST);
  } catch (err) {
    if (hadLive) fs.renameSync(WEB_RETIRED, WEB_DIST);
    throw err;
  }
  fs.rmSync(WEB_RETIRED, { recursive: true, force: true });
}

// ---------- startup ----------

/** At boot: settle what an update left behind and close the record of the
    job whose restart this start is. Not run by the self-test. */
export function initUpdater(): void {
  try {
    for (const name of fs.readdirSync(UPDATE_DIR)) {
      if (name.startsWith('selftest-')) fs.rmSync(path.join(UPDATE_DIR, name), { recursive: true, force: true });
    }
  } catch { /* no update has run yet */ }
  // Normally swapped just before the restart; this covers a restart that came
  // from elsewhere while the job was waiting (systemctl restart, a crash).
  try { swapStagedWeb(bootCommit); } catch (err) { console.error('[update] staged web build:', errorText(err)); }

  last = loadJob();
  if (!last || last.status === 'done' || last.status === 'failed' || last.status === 'cancelled') return;
  // This start is the restart the job asked for — or one from elsewhere that
  // beat it to it while the new version was already in place.
  const restarted = last.status === 'restarting' || (last.status === 'waiting' && last.to === bootCommit);
  for (const s of last.steps) {
    if (s.status !== 'running' && !(restarted && s.id === 'restart')) continue;
    s.status = restarted ? 'done' : 'failed';
    s.endedAt = bootedAt;
  }
  if (restarted) {
    last.status = 'done';
    last.restartedAt = bootedAt;
    pushLog(last, `服务已重启,当前版本 ${short(bootCommit)}`);
  } else {
    last.status = 'failed';
    last.error = '任务进行中服务被重启或中断,没有完成';
  }
  last.endedAt = bootedAt;
  saveJob(last);
}

export async function updateStatus() {
  const [repo, supervisor] = await Promise.all([inspectRepo(), detectSupervisor()]);
  return {
    version: bootVersion,
    process: { bootId, bootedAt, commit: bootCommit },
    repo,
    supervisor,
    activity: activity(),
    job: currentJob(),
  };
}
