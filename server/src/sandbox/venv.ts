// Python 运行库 for the 沙盒: a venv under data/sandbox/venv that the panel
// process manages (pip needs the network the sandbox does not have) and the
// executor mounts read-only at /opt/venv. One job at a time; its log is kept
// in memory for the admin page to poll.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandboxDir, sandboxProcessEnv } from './env.js';

export const venvDir = path.join(sandboxDir, 'venv');
const pipCacheDir = path.join(sandboxDir, 'pip-cache');
const JOB_TIMEOUT_MS = 20 * 60_000;
const LOG_LINES_MAX = 400;

export interface PackagePreset {
  /** pip name */
  name: string;
  group: string;
  desc: string;
}

export const PACKAGE_PRESETS: PackagePreset[] = [
  { name: 'pandas', group: '表格与数据', desc: '表格数据处理、统计、透视' },
  { name: 'numpy', group: '表格与数据', desc: '数值计算基础库' },
  { name: 'openpyxl', group: '表格与数据', desc: '读写 Excel(xlsx)' },
  { name: 'python-docx', group: '办公文档', desc: '生成和修改 Word(docx)' },
  { name: 'python-pptx', group: '办公文档', desc: '生成 PowerPoint(pptx)' },
  { name: 'pypdf', group: '办公文档', desc: '读取、合并、拆分 PDF' },
  { name: 'pdfplumber', group: '办公文档', desc: '从 PDF 提取文本与表格' },
  { name: 'matplotlib', group: '图表与图片', desc: '绘制统计图表(输出 PNG/SVG)' },
  { name: 'pillow', group: '图表与图片', desc: '图片缩放、裁剪、格式转换' },
  { name: 'markdown', group: '文本处理', desc: 'Markdown 转 HTML' },
  { name: 'pyyaml', group: '文本处理', desc: '读写 YAML' },
  { name: 'jinja2', group: '文本处理', desc: '模板渲染,批量生成文档' },
  { name: 'beautifulsoup4', group: '文本处理', desc: '解析 HTML' },
  { name: 'lxml', group: '文本处理', desc: 'XML / HTML 高速解析' },
  { name: 'chardet', group: '文本处理', desc: '检测文本编码' },
];

export interface InstalledPackage { name: string; version: string }

export type JobKind = 'create' | 'install' | 'uninstall' | 'rebuild';
export interface VenvJob {
  id: number;
  kind: JobKind;
  args: string[];
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt: number | null;
  log: string[];
  error: string | null;
}

let jobSeq = 0;
let current: VenvJob | null = null;
let last: VenvJob | null = null;
let packagesCache: { at: number; list: InstalledPackage[] } | null = null;

export function venvPython(): string { return path.join(venvDir, 'bin', 'python'); }
export function venvExists(): boolean {
  try { return fs.statSync(venvPython()).isFile(); } catch { return false; }
}

export function currentJob(): VenvJob | null { return current ?? last; }

// pip accepts a lot; we accept the small safe subset an admin actually types:
// name, optional extras, optional version specifiers. Anything starting with
// "-" (pip options), URLs, paths and shell metacharacters are refused.
const SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(\[[A-Za-z0-9._,-]{1,80}\])?((==|>=|<=|~=|!=|<|>)[A-Za-z0-9.*+!-]{1,40}(,(==|>=|<=|~=|!=|<|>)[A-Za-z0-9.*+!-]{1,40})*)?$/;
export function validPackageSpec(spec: string): boolean {
  return SPEC_RE.test(spec);
}
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function pushLog(job: VenvJob, chunk: string) {
  for (const line of chunk.split(/\r?\n|\r/)) {
    if (!line.trim()) continue;
    job.log.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    if (job.log.length > LOG_LINES_MAX) job.log.splice(0, job.log.length - LOG_LINES_MAX);
  }
}

function runLogged(job: VenvJob, file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    pushLog(job, `$ ${[file, ...args].join(' ')}`);
    const child = spawn(file, args, {
      env: {
        ...sandboxProcessEnv(),
        PIP_CACHE_DIR: pipCacheDir,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_NO_INPUT: '1',
        PYTHONUNBUFFERED: '1',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { pushLog(job, '(超时,已终止)'); child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => pushLog(job, d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => pushLog(job, d.toString('utf8')));
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`退出码 ${code}`));
    });
  });
}

function startJob(kind: JobKind, args: string[], body: (job: VenvJob) => Promise<void>): VenvJob {
  if (current) throw new Error('已有任务在进行中,请等它结束');
  const job: VenvJob = { id: ++jobSeq, kind, args, status: 'running', startedAt: Date.now(), endedAt: null, log: [], error: null };
  current = job;
  body(job)
    .then(() => { job.status = 'done'; })
    .catch((err: unknown) => { job.status = 'error'; job.error = err instanceof Error ? err.message : String(err); pushLog(job, `失败:${job.error}`); })
    .finally(() => { job.endedAt = Date.now(); current = null; last = job; packagesCache = null; });
  return job;
}

export function createVenv(python3: string, rebuild = false): VenvJob {
  return startJob(rebuild ? 'rebuild' : 'create', [], async (job) => {
    fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    if (rebuild && fs.existsSync(venvDir)) {
      pushLog(job, '删除旧的运行库环境…');
      fs.rmSync(venvDir, { recursive: true, force: true });
    }
    await runLogged(job, python3, ['-m', 'venv', '--upgrade-deps', venvDir]);
    pushLog(job, '运行库环境已就绪');
  });
}

export function installPackages(specs: string[]): VenvJob {
  if (!venvExists()) throw new Error('请先创建运行库环境');
  const bad = specs.find((s) => !validPackageSpec(s));
  if (bad !== undefined) throw new Error(`包名不合法:${bad}`);
  if (!specs.length) throw new Error('没有要安装的包');
  return startJob('install', specs, async (job) => {
    await runLogged(job, venvPython(), ['-m', 'pip', 'install', '--no-input', ...specs]);
    pushLog(job, `已安装:${specs.join(', ')}`);
  });
}

export function uninstallPackages(names: string[]): VenvJob {
  if (!venvExists()) throw new Error('运行库环境不存在');
  const bad = names.find((s) => !NAME_RE.test(s));
  if (bad !== undefined) throw new Error(`包名不合法:${bad}`);
  if (names.some((n) => /^(pip|setuptools|wheel)$/i.test(n))) throw new Error('pip / setuptools / wheel 不能卸载');
  return startJob('uninstall', names, async (job) => {
    await runLogged(job, venvPython(), ['-m', 'pip', 'uninstall', '-y', ...names]);
    pushLog(job, `已卸载:${names.join(', ')}`);
  });
}

export function installedPackages(): Promise<InstalledPackage[]> {
  if (!venvExists()) return Promise.resolve([]);
  if (packagesCache && Date.now() - packagesCache.at < 60_000) return Promise.resolve(packagesCache.list);
  return new Promise((resolve) => {
    const child = spawn(venvPython(), ['-m', 'pip', 'list', '--format', 'json', '--disable-pip-version-check'], {
      env: { ...sandboxProcessEnv(), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const finish = () => {
      let list: InstalledPackage[] = [];
      try {
        list = (JSON.parse(out) as { name: string; version: string }[])
          .filter((p) => !/^(pip|setuptools|wheel)$/i.test(p.name))
          .map((p) => ({ name: p.name, version: p.version }));
      } catch { /* empty */ }
      packagesCache = { at: Date.now(), list };
      resolve(list);
    };
    child.on('close', finish);
    child.on('error', finish);
    setTimeout(() => { child.kill('SIGKILL'); }, 30_000).unref();
  });
}

/** Names the prompt can mention (cached; never blocks a chat turn on pip). */
export function installedPackageNamesSync(): string[] {
  return packagesCache?.list.map((p) => p.name) ?? [];
}

export function warmPackagesCache(): void {
  installedPackages().catch(() => { /* best effort */ });
}
