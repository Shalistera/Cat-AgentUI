// Host self-check for the 沙盒. Nothing here needs root: each probe runs the
// real tool the executor will use, as the service user, and reports what is
// missing together with the apt/sysctl line an operator should run. The
// admin page renders this as a traffic-light list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { deniedSyscallNames } from './seccomp.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface EnvCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  /** Copy-paste remedy for an operator (needs root). */
  fix?: string;
  /** false = the sandbox cannot run at all without this. */
  required: boolean;
}

export interface SandboxEnv {
  checkedAt: number;
  checks: EnvCheck[];
  /** bwrap + user namespaces work: commands can be isolated. */
  runnable: boolean;
  /** systemd-run --user works: memory/CPU/pids limits apply. */
  limitsAvailable: boolean;
  bwrapPath: string | null;
  systemdRunPath: string | null;
  prlimitPath: string | null;
  python3Path: string | null;
  pandocPath: string | null;
  hostSetupScript: string;
}

const PROBE_TIMEOUT_MS = 10_000;

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    const p = path.join(dir, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  for (const p of [`/usr/bin/${bin}`, `/bin/${bin}`, `/usr/local/bin/${bin}`]) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function run(file: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, env: probeEnv() }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

function probeEnv(): NodeJS.ProcessEnv {
  // systemd --user needs to find the user's bus; a service unit usually has
  // XDG_RUNTIME_DIR unset, so derive it from the uid.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (uid !== null && !env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  return env;
}

export function sandboxProcessEnv(): NodeJS.ProcessEnv { return probeEnv(); }

/** The bwrap argv prefix the executor uses too, so the probe proves the real thing. */
export function bwrapBaseArgs(tmpfsBytes = 256 * 1024 * 1024): string[] {
  const args = [
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
  ];
  if (fs.existsSync('/usr/lib64')) args.push('--symlink', 'usr/lib64', '/lib64');
  if (fs.existsSync('/usr/lib32')) args.push('--symlink', 'usr/lib32', '/lib32');
  // A curated slice of /etc: loader cache, alternatives symlinks, fontconfig,
  // timezone. Never the whole directory — the model is a less trusted
  // principal than the service user and has no business reading host config.
  for (const p of ['/etc/ld.so.cache', '/etc/alternatives', '/etc/fonts', '/etc/localtime', '/etc/ssl/certs', '/etc/mime.types', '/etc/papersize']) {
    args.push('--ro-bind-try', p, p);
  }
  // /tmp is memory-backed: cap it so a runaway write cannot exhaust RAM
  // (the cgroup would catch it too, but with a kill instead of ENOSPC)
  args.push('--proc', '/proc', '--dev', '/dev', '--size', String(tmpfsBytes), '--tmpfs', '/tmp');
  return args;
}

async function checkUserns(bwrap: string | null): Promise<EnvCheck> {
  if (!bwrap) {
    return { id: 'bwrap', label: 'bubblewrap(bwrap)', level: 'fail', required: true, detail: '未安装,无法创建隔离环境', fix: 'sudo apt install -y bubblewrap' };
  }
  const r = await run(bwrap, [...bwrapBaseArgs(), '--unshare-all', '--die-with-parent', '--', '/bin/sh', '-c', 'echo ok']);
  if (r.ok && r.out.endsWith('ok')) {
    return { id: 'bwrap', label: '隔离环境(bwrap + 用户命名空间)', level: 'ok', required: true, detail: '可以在非特权用户下创建独立的文件系统、进程与网络命名空间' };
  }
  let restricted = false;
  try { restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; } catch { /* not ubuntu */ }
  const detail = restricted
    ? '内核参数 kernel.apparmor_restrict_unprivileged_userns=1 禁止了非特权用户命名空间(Ubuntu 23.10+ 默认)'
    : `bwrap 启动失败:${r.out.split('\n').slice(-2).join(' ').slice(0, 300)}`;
  const fix = restricted
    ? "sudo tee /etc/sysctl.d/60-userns.conf <<<'kernel.apparmor_restrict_unprivileged_userns = 0' && sudo sysctl --system"
    : undefined;
  return { id: 'bwrap', label: '隔离环境(bwrap + 用户命名空间)', level: 'fail', required: true, detail, fix };
}

async function checkSystemdRun(systemdRun: string | null): Promise<EnvCheck> {
  const label = '资源限额(systemd-run --user)';
  if (!systemdRun) {
    return { id: 'systemd', label, level: 'warn', required: false, detail: '未找到 systemd-run;命令仍可隔离运行,但没有内存/CPU/进程数限额,只有超时保护' };
  }
  const r = await run(systemdRun, ['--user', '--wait', '--pipe', '--quiet', '--collect', '-p', 'MemoryMax=64M', '-p', 'TasksMax=16', '--', '/bin/sh', '-c', 'echo ok']);
  if (r.ok && r.out.endsWith('ok')) {
    return { id: 'systemd', label, level: 'ok', required: false, detail: '每条命令跑在临时 cgroup 里,内存、CPU、进程数限额生效' };
  }
  const user = os.userInfo().username;
  return {
    id: 'systemd', label, level: 'warn', required: false,
    detail: `systemd 用户实例不可用(${r.out.split('\n').slice(-1)[0]?.slice(0, 200) || '无输出'});命令仍可隔离运行,但没有资源限额`,
    fix: `sudo loginctl enable-linger ${user}`,
  };
}

async function checkPythonVenv(python3: string | null): Promise<EnvCheck> {
  const label = 'Python 3 与 venv';
  if (!python3) return { id: 'python', label, level: 'fail', required: false, detail: '未安装 python3', fix: 'sudo apt install -y python3 python3-venv' };
  const ver = await run(python3, ['--version']);
  const ensure = await run(python3, ['-c', 'import ensurepip, venv']);
  if (ensure.ok) return { id: 'python', label, level: 'ok', required: false, detail: `${ver.out || 'python3'};可以创建运行库环境(venv)` };
  return { id: 'python', label, level: 'warn', required: false, detail: `${ver.out || 'python3'} 可用,但缺少 venv/ensurepip,无法安装运行库`, fix: 'sudo apt install -y python3-venv' };
}

function checkBinary(id: string, label: string, bin: string, pkg: string, why: string): EnvCheck {
  const p = which(bin);
  return p
    ? { id, label, level: 'ok', required: false, detail: `${p};${why}` }
    : { id, label, level: 'warn', required: false, detail: `未安装;${why}`, fix: `sudo apt install -y ${pkg}` };
}

function seccompCheck(): EnvCheck {
  const denied = deniedSyscallNames();
  const label = '系统调用过滤(seccomp)';
  if (denied) return { id: 'seccomp', label, level: 'ok', required: false, detail: `沙盒内禁止 ${denied.join(', ')};命令无法创建符号链接、管道或挂载` };
  return { id: 'seccomp', label, level: 'warn', required: false, detail: `当前架构(${process.arch})没有内置的系统调用表,沙盒不加过滤运行;宿主侧仍有打开后校验与执行后清扫保护` };
}

async function checkCjkFonts(): Promise<EnvCheck> {
  const label = '中文字体';
  const fc = which('fc-list');
  if (!fc) return { id: 'fonts', label, level: 'warn', required: false, detail: '未安装 fontconfig,无法检测;图表和 PDF 里的中文可能显示为方块', fix: 'sudo apt install -y fontconfig fonts-noto-cjk' };
  const r = await run(fc, [':lang=zh', 'family']);
  const families = r.out.split('\n').filter(Boolean);
  if (families.length) return { id: 'fonts', label, level: 'ok', required: false, detail: `已有 ${families.length} 个中文字体(如 ${families[0].split(',')[0]});matplotlib、pandoc 出图/出 PDF 可显示中文` };
  return { id: 'fonts', label, level: 'warn', required: false, detail: '没有中文字体;图表和生成的 PDF 里中文会显示为方块', fix: 'sudo apt install -y fonts-noto-cjk' };
}

let cached: SandboxEnv | null = null;
let probing: Promise<SandboxEnv> | null = null;

export function hostSetupScript(): string {
  const user = os.userInfo().username;
  return [
    '#!/usr/bin/env bash',
    '# Cat-AgentUI 沙盒宿主机准备(Ubuntu/Debian,以 root 运行一次)',
    'set -euo pipefail',
    'apt-get update',
    'apt-get install -y bubblewrap python3 python3-venv pandoc fonts-noto-cjk poppler-utils fontconfig',
    '# Ubuntu 23.10+ 默认禁止非特权用户命名空间;bwrap 需要它',
    "echo 'kernel.apparmor_restrict_unprivileged_userns = 0' > /etc/sysctl.d/60-userns.conf",
    'sysctl --system >/dev/null',
    '# 让服务用户的 systemd 实例常驻,资源限额(cgroup)才能生效',
    `loginctl enable-linger ${user}`,
    'echo "done — 回到管理后台 → 沙盒 点「重新检测」"',
  ].join('\n');
}

export async function probeSandboxEnv(force = false): Promise<SandboxEnv> {
  if (cached && !force) return cached;
  if (probing) return probing;
  probing = (async () => {
    const bwrap = which('bwrap');
    const systemdRun = which('systemd-run');
    const python3 = which('python3');
    const [userns, systemd, python, fonts] = await Promise.all([
      checkUserns(bwrap), checkSystemdRun(systemdRun), checkPythonVenv(python3), checkCjkFonts(),
    ]);
    const checks: EnvCheck[] = [
      userns,
      systemd,
      python,
      checkBinary('pandoc', 'pandoc', 'pandoc', 'pandoc', 'Markdown 与 docx / html 互转'),
      checkBinary('poppler', 'poppler-utils', 'pdftotext', 'poppler-utils', 'pdftotext / pdftoppm 处理 PDF'),
      fonts,
      { id: 'node', label: 'Node.js', level: 'ok', required: false, detail: `${process.execPath}(${process.version});沙盒内以 /opt/node/bin/node 提供` },
      seccompCheck(),
    ];
    const env: SandboxEnv = {
      checkedAt: Date.now(),
      checks,
      runnable: userns.level === 'ok',
      limitsAvailable: systemd.level === 'ok',
      bwrapPath: bwrap,
      systemdRunPath: systemdRun,
      prlimitPath: which('prlimit'),
      python3Path: python3,
      pandocPath: which('pandoc'),
      hostSetupScript: hostSetupScript(),
    };
    cached = env;
    return env;
  })();
  try { return await probing; } finally { probing = null; }
}

export function cachedSandboxEnv(): SandboxEnv | null { return cached; }

export const sandboxDir = path.join(config.dataDir, 'sandbox');
