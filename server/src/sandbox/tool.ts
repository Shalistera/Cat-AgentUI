// The model-facing side of the 沙盒: one tool, one prompt block.
import type { ToolDef } from '../types.js';
import { cachedSandboxEnv } from './env.js';
import { formatRunResult, runInSandbox, SandboxBusyError } from './exec.js';
import { getSandboxSettings, userMayUseSandbox, type SandboxUser } from './settings.js';
import { installedPackageNamesSync, venvExists } from './venv.js';
import { workspaceFileLink } from '../workspace-link.js';

export const RUN_COMMAND_TOOL = 'run_command';

/** Model-authored execution (run_command). convert_file is separate: see CONVERT_TOOL_DEF. */
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

/** convert_file needs only a working sandbox host and the built-in switch —
    not the "allow the model to run commands" policy, which is about
    model-authored commands. */
export function convertAvailableFor(_user: SandboxUser): boolean {
  const env = cachedSandboxEnv();
  return !!env && env.runnable && getSandboxSettings().builtinTools;
}

/** Prompt block when only the built-in conversion is available. */
export function buildConvertPrompt(): string {
  return [
    '[文档转换]',
    '可以用 convert_file 把工作区里的文档一步转换格式:md/txt/html/docx → pdf 或 docx,docx/html/pdf → md/txt。用户要 PDF、Word 时直接用它,转换完在回复里说明文件名。本对话没有其他命令执行能力,不要写脚本或给出终端命令让人去跑。',
  ].join('\n');
}

export function buildSandboxPrompt(comparisonActive = false): string {
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
    '格式转换(PDF、Word、Markdown 互转)直接用 convert_file,一步完成,不要自己写 pandoc / weasyprint 命令。run_command 适合:数据处理与统计、运行脚本验证代码或计算结果、制作需要导出的文件。纯文字任务不必执行命令。',
    comparisonActive
      ? '对话内柱状图和单/多曲线折线图直接用 compare_data,多条曲线不是改用 Python 绘图的理由。确需计算或拟合数值时才先运行计算代码,取得数据后再调用 compare_data;复杂图形或明确要求导出图片时才在沙盒绘图。'
      : '需要图表文件时可在沙盒计算并绘制,先确认所需运行库可用。',
    '依赖以已安装库清单为准,不要假定 scipy、pandas、matplotlib 存在。遇到 ModuleNotFoundError,可行时改用已安装工具或标准库;必需的计算无法完成时如实说明,不要反复导入或伪造计算结果。',
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
      const isError = r.exitCode !== 0 || r.timedOut;
      const result = msg || (isError ? '转换失败' : `已生成 ${output}`);
      return { result: isError ? result : `${result}\n文件链接:${workspaceFileLink(ctx.chatId, output)}`, isError };
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
