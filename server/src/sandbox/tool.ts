// The model-facing side of the 沙盒: one tool, one prompt block.
import type { ToolDef } from '../types.js';
import { cachedSandboxEnv } from './env.js';
import { formatRunResult, runInSandbox, SandboxBusyError } from './exec.js';
import { getSandboxSettings, userMayUseSandbox, type SandboxUser } from './settings.js';
import { installedPackageNamesSync, venvExists } from './venv.js';

export const RUN_COMMAND_TOOL = 'run_command';

// convert_file is appended in isSandboxTool consumers via SANDBOX_TOOL_DEFS below.
export const SANDBOX_TOOL_DEFS: ToolDef[] = [
  {
    name: RUN_COMMAND_TOOL,
    description: '在隔离沙盒里执行一条 shell 命令,工作目录是本对话的工作区(/workspace),对其中文件的改动会保留。有 python3(含预装库)、node、常用命令行工具;没有网络,不能安装软件包。返回退出码和 stdout/stderr。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令(sh -c),如 python3 分析.py 或 pandoc 报告.md -o 报告.docx' },
        timeout_seconds: { type: 'integer', description: '本次命令的超时秒数,不能超过管理员设置的上限;默认即上限' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

export const CONVERT_FILE_TOOL = 'convert_file';

/** Format conversion as a first-class tool: the command is ours (a fixed
    converter script mounted read-only), never model-authored, so it needs no
    confirmation and the model cannot fumble the invocation. */
export const CONVERT_TOOL_DEF: ToolDef = {
  name: CONVERT_FILE_TOOL,
  description: '把工作区里的文档转换成另一种格式,一步完成、不需要写命令。支持:md/txt/html/docx/doc → pdf;md/txt/html/docx/doc → docx;docx/doc/html/pdf → md/txt。需要 PDF、Word 时优先用它,不要自己拼 pandoc / weasyprint 命令。',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '工作区内的源文件相对路径,如 报告.md' },
      output: { type: 'string', description: '目标文件相对路径,由扩展名决定格式,如 报告.pdf' },
    },
    required: ['input', 'output'],
    additionalProperties: false,
  },
};

export function isSandboxTool(name: string): boolean {
  return name === RUN_COMMAND_TOOL || name === CONVERT_FILE_TOOL;
}

/** Skill scripts are admin-authored: a plain invocation of one of them with
    simple arguments is trusted and skips 执行前确认. Anything that could
    chain, redirect or expand (; & | < > $ `) falls back to asking. */
const TRUSTED_SKILL_CMD = /^(?:python3?|node|sh|bash)\s+\/skills\/[a-z0-9-]+\/[^\s;&|<>$`'"\\]+(?:\s+[^\s;&|<>$`'"\\]+)*\s*$/;
export function isTrustedCommand(name: string, argsJson: string): boolean {
  if (name === CONVERT_FILE_TOOL) return true;
  if (name !== RUN_COMMAND_TOOL) return false;
  try {
    const a = JSON.parse(argsJson || '{}') as { command?: unknown };
    return typeof a.command === 'string' && TRUSTED_SKILL_CMD.test(a.command.trim());
  } catch { return false; }
}

function shellQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

/** Path rules mirror the workspace: relative, no traversal, no control chars. */
function safeRel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const p = v.trim().replace(/\\/g, '/');
  if (!p || p.length > 200 || p.startsWith('/') || p.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return null;
  for (let i = 0; i < p.length; i++) { const c = p.charCodeAt(i); if (c < 0x20 || c === 0x7f) return null; }
  return p;
}

/** Offered to this turn? Policy + host readiness. */
export function sandboxAvailableFor(user: SandboxUser): boolean {
  if (!userMayUseSandbox(user)) return false;
  const env = cachedSandboxEnv();
  return !!env && env.runnable;
}

export function sandboxNeedsConfirm(): boolean {
  return getSandboxSettings().confirm;
}

export function buildSandboxPrompt(): string {
  const s = getSandboxSettings();
  const env = cachedSandboxEnv();
  const libs = venvExists() ? installedPackageNamesSync() : [];
  const tools = ['python3', 'node', 'sh、grep、sed、awk、sort 等常用命令'];
  if (env?.pandocPath) tools.push('pandoc(Markdown ↔ docx/html)');
  const libLine = libs.length
    ? `python3 已安装的库:${libs.slice(0, 40).join(', ')}${libs.length > 40 ? ' 等' : ''}。`
    : 'python3 只有标准库(管理员尚未安装第三方库)。';
  return [
    '[命令执行]',
    `可以用 run_command 在隔离沙盒里执行 shell 命令:工作目录就是本工作区(/workspace),文件改动会保留;可用工具:${tools.join('、')}。${libLine}没有网络,不能 pip/npm 安装任何东西;单条命令最长 ${s.timeoutSec} 秒,内存 ${s.memoryMb} MB。`,
    '格式转换(PDF、Word、Markdown 互转)直接用 convert_file,一步完成,不要自己写 pandoc / weasyprint 命令。run_command 适合:数据处理与统计、生成图表、运行脚本验证代码或计算结果。纯文字任务不必执行命令。',
    '做法:较长的脚本先用 workspace_write 写成文件再执行;输出只 print 需要的结论,不要打印整份数据;命令失败时先读错误信息再修正,不要反复盲试;需要生成给用户的文件(图表、docx 等)就保存到工作区并在回复里说明文件名。',
  ].join('\n');
}

export async function callSandboxTool(
  ctx: { user: SandboxUser; chatId: string; messageId?: string; signal?: AbortSignal },
  argsJson: string,
  toolName: string = RUN_COMMAND_TOOL,
): Promise<{ result: string; isError: boolean }> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* treated as empty */ }
  if (toolName === CONVERT_FILE_TOOL) {
    const input = safeRel(args.input);
    const output = safeRel(args.output);
    if (!input || !output) return { result: 'input / output 必须是工作区内的相对路径', isError: true };
    try {
      const r = await runInSandbox({
        userId: ctx.user.id, user: ctx.user, chatId: ctx.chatId, messageId: ctx.messageId, signal: ctx.signal,
        command: `python3 /opt/tools/convert.py ${shellQuote(input)} ${shellQuote(output)}`,
      });
      const msg = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim();
      return { result: msg || (r.exitCode === 0 ? `已生成 ${output}` : '转换失败'), isError: r.exitCode !== 0 || r.timedOut };
    } catch (err) {
      if (err instanceof SandboxBusyError) return { result: err.message, isError: true };
      return { result: `转换失败:${(err as Error).message}`, isError: true };
    }
  }
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return { result: '缺少 command 参数', isError: true };
  if (command.length > 20_000) return { result: '命令过长,请把脚本写进文件再执行', isError: true };
  const timeoutSec = Number.isFinite(Number(args.timeout_seconds)) ? Number(args.timeout_seconds) : undefined;
  try {
    const r = await runInSandbox({ userId: ctx.user.id, user: ctx.user, chatId: ctx.chatId, messageId: ctx.messageId, command, timeoutSec, signal: ctx.signal });
    const effectiveTimeout = Math.max(5, Math.min(getSandboxSettings().timeoutSec, timeoutSec ?? getSandboxSettings().timeoutSec));
    return { result: formatRunResult(r, effectiveTimeout), isError: r.timedOut || r.exitCode !== 0 };
  } catch (err) {
    if (err instanceof SandboxBusyError) return { result: err.message, isError: true };
    return { result: `沙盒执行失败:${(err as Error).message}`, isError: true };
  }
}

SANDBOX_TOOL_DEFS.push(CONVERT_TOOL_DEF);
