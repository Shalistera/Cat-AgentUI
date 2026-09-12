// The model-facing side of the 沙盒: one tool, one prompt block.
import type { ToolDef } from '../types.js';
import { cachedSandboxEnv } from './env.js';
import { formatRunResult, runInSandbox, SandboxBusyError } from './exec.js';
import { getSandboxSettings, userMayUseSandbox, type SandboxUser } from './settings.js';
import { installedPackageNamesSync, venvExists } from './venv.js';

export const RUN_COMMAND_TOOL = 'run_command';

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

export function isSandboxTool(name: string): boolean {
  return name === RUN_COMMAND_TOOL;
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
    '适合的用途:数据处理与统计、格式转换(如 pandoc 把 Markdown 转成 docx)、生成图表、运行脚本验证代码或计算结果。纯文字任务不必执行命令。',
    '做法:较长的脚本先用 workspace_write 写成文件再执行;输出只 print 需要的结论,不要打印整份数据;命令失败时先读错误信息再修正,不要反复盲试;需要生成给用户的文件(图表、docx 等)就保存到工作区并在回复里说明文件名。',
  ].join('\n');
}

export async function callSandboxTool(
  ctx: { userId: string; chatId: string; messageId?: string; signal?: AbortSignal },
  argsJson: string,
): Promise<{ result: string; isError: boolean }> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* treated as empty */ }
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return { result: '缺少 command 参数', isError: true };
  if (command.length > 20_000) return { result: '命令过长,请把脚本写进文件再执行', isError: true };
  const timeoutSec = Number.isFinite(Number(args.timeout_seconds)) ? Number(args.timeout_seconds) : undefined;
  try {
    const r = await runInSandbox({ userId: ctx.userId, chatId: ctx.chatId, messageId: ctx.messageId, command, timeoutSec, signal: ctx.signal });
    const effectiveTimeout = Math.max(5, Math.min(getSandboxSettings().timeoutSec, timeoutSec ?? getSandboxSettings().timeoutSec));
    return { result: formatRunResult(r, effectiveTimeout), isError: r.timedOut || r.exitCode !== 0 };
  } catch (err) {
    if (err instanceof SandboxBusyError) return { result: err.message, isError: true };
    return { result: `沙盒执行失败:${(err as Error).message}`, isError: true };
  }
}
