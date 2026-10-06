// 子代理 — a nested model run the parent turn delegates a self-contained task
// to. It gets its own context (only the task text, never the parent's
// history), the same in-process tools (工作区 / 技能 / 项目资料 and, when
// allowed, 沙盒), no MCP, no further nesting, and hands back plain text; any
// files it wrote stay in the shared workspace.
import type { AdapterMessage, AdapterMessagePart, ChatAdapter, ProviderRuntimeConfig, ToolDef } from './types.js';
import { config } from './config.js';
import { schema } from './db/index.js';
import { recordUsage } from './usage.js';
import { StreamingSecretRedactor, redactSensitiveText } from './secrets.js';
import { getAgentSettings, policyAllows, type AgentUser } from './agent-settings.js';
import { WORKSPACE_TOOL_DEFS, buildWorkspacePrompt, callWorkspaceTool, isWorkspaceTool } from './workspace.js';
import { SKILL_TOOL_DEFS, buildSkillsPrompt, callSkillTool, isSkillTool, skillsFor } from './skills.js';
import { CONVERT_FILE_TOOL, CONVERT_TOOL_DEF, SANDBOX_TOOL_DEFS, buildConvertPrompt, buildSandboxPrompt, callSandboxTool, convertAvailableFor, isSandboxTool, isTrustedCommand, sandboxAvailableFor, sandboxNeedsConfirm } from './sandbox/tool.js';
import { callProjectTool, isProjectTool } from './knowledge.js';
import { buildProjectPrompt, projectFilesPrompt } from './routes/projects.js';
import { historyBudget } from './compaction.js';

export const SPAWN_SUBAGENT_TOOL = 'spawn_subagent';

export const SUBAGENT_TOOL_DEFS: ToolDef[] = [
  {
    name: SPAWN_SUBAGENT_TOOL,
    description: '把一个独立、边界清晰的子任务交给子代理完成(例如通读某份长文档或几份项目资料并提炼要点、按大纲写出某一章、跑一次数据分析并给结论)。子代理有同样的工作区/技能/沙盒工具和本项目的资料,但看不到本对话的历史,所以 task 必须自带全部背景:输入文件名或资料名、要求、期望产出(写到哪个文件、回复什么)。它返回文字结论;写好的文件留在工作区。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整的任务说明,像给一个没有上下文的同事写工单' },
        title: { type: 'string', description: '给用户看的一句话标题,如「提炼合同要点」' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
];

export function isSubagentTool(name: string): boolean {
  return name === SPAWN_SUBAGENT_TOOL;
}

export function subagentAvailableFor(user: AgentUser): boolean {
  return policyAllows(getAgentSettings().subagent, user);
}

export function buildSubagentPrompt(): string {
  const s = getAgentSettings().subagent;
  return [
    '[子代理]',
    `可以用 spawn_subagent 把独立的子任务委派出去并行推进思路:适合"通读并提炼一份长材料""逐份阅读几份项目资料后汇总""按大纲写出某一章""跑一遍分析并给结论"这类边界清晰、产出明确的活;大量阅读交给子代理,也能让本对话的上下文保持精简。简单的、几句话能答的任务不要委派。子代理看不到本对话,但能检索和阅读本项目的资料;task 里要写清背景、要读的资料名或文件名和期望产出;每轮最多委派 ${s.maxPerTurn} 次。拿到结果后由你整合并对用户负责,不要原样转发。`,
  ].join('\n');
}

const SUBAGENT_SYSTEM = [
  '你是一个子代理:上级把一个独立任务交给你,你看不到它与用户的对话,只能依据下面的任务说明和工作区里的文件工作。',
  '要求:直接动手,不要反问(信息不足时基于合理假设完成并在结论里注明);需要产出文件就写进工作区并在结论里给出文件名;最后用简洁的文字给出结论/要点,这段文字会原样交给上级,不要寒暄,不要重复任务说明。',
].join('\n');

export interface SubagentDeps {
  user: AgentUser & { settings?: string };
  chatId: string;
  projectId: string | null;
  parentMessageId: string;
  adapter: ChatAdapter;
  cfg: ProviderRuntimeConfig;
  model: typeof schema.models.$inferSelect;
  provider: typeof schema.providers.$inferSelect;
  reasoning: { level: string; ratio: number } | undefined;
  secretValues: string[];
  signal: AbortSignal;
  /** Sandbox confirmation, routed to the parent's tab. */
  askConfirm(calls: { id: string; name: string; args: string }[]): Promise<Map<string, 'allow' | 'deny'>>;
  /** Live progress lines for the parent's tool row. */
  onProgress(line: string): void;
  /** Parent enforces the same overall output budget. */
  consumeOutput(chars: number): void;
}

export interface SubagentResult {
  text: string;
  toolCalls: number;
  iterations: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  stopped: 'done' | 'timeout' | 'iterations' | 'aborted' | 'error';
  error?: string;
}

function summarizeArgs(name: string, args: string): string {
  try {
    const a = JSON.parse(args || '{}') as Record<string, unknown>;
    if (typeof a.path === 'string') return a.path;
    if (typeof a.command === 'string') return a.command.split('\n')[0].slice(0, 80);
    if (typeof a.name === 'string') return a.name;
    if (typeof a.query === 'string') return a.query;
  } catch { /* ignore */ }
  return '';
}

const VERB: Record<string, string> = {
  workspace_read: '读取', workspace_write: '写入', workspace_edit: '修改', workspace_delete: '删除', workspace_list: '查看工作区',
  run_command: '执行', convert_file: '转换', load_skill: '加载技能', read_skill_file: '读取技能文件', project_search: '检索资料', project_read_doc: '读取资料',
};

export async function runSubagent(deps: SubagentDeps, task: string): Promise<SubagentResult> {
  const s = getAgentSettings().subagent;
  const t0 = Date.now();
  const user = deps.user;

  // ---- tools & prompt (mirrors the parent turn, minus MCP and nesting) ----
  const agent = getAgentSettings();
  const workspaceOn = policyAllows(agent.workspace, user);
  const sandboxOn = workspaceOn && s.allowSandbox && sandboxAvailableFor(user);
  const convertOn = workspaceOn && convertAvailableFor(user);
  const skillRows = policyAllows(agent.skills, user) ? skillsFor(user) : [];
  const tools: ToolDef[] = [];
  if (workspaceOn) tools.push(...WORKSPACE_TOOL_DEFS);
  if (sandboxOn) tools.push(...SANDBOX_TOOL_DEFS);
  if (convertOn) tools.push(CONVERT_TOOL_DEF);
  if (skillRows.length) tools.push(...SKILL_TOOL_DEFS);
  // 项目资料 the same way the parent turn gets them, sized for this model.
  const project = deps.projectId
    ? buildProjectPrompt(deps.projectId, user.id, { canUseTools: true, modelId: deps.model.modelId })
    : { block: null, tools: null, docCount: 0 };
  const projectOn = !!project.tools?.length;
  if (projectOn) tools.push(...project.tools!);
  const sandboxProjectId = project.docCount ? deps.projectId : null;
  const blocks = [SUBAGENT_SYSTEM];
  if (project.block) blocks.push(project.block);
  if (workspaceOn) blocks.push(buildWorkspacePrompt(deps.chatId));
  if (sandboxOn) blocks.push(sandboxProjectId ? `${buildSandboxPrompt()}\n${projectFilesPrompt(project.docCount)}` : buildSandboxPrompt());
  else if (convertOn) blocks.push(buildConvertPrompt());
  if (skillRows.length) blocks.push(buildSkillsPrompt(skillRows, sandboxOn));
  const system = blocks.join('\n\n');

  const messages: AdapterMessage[] = [{ role: 'user', parts: [{ type: 'text', text: task }] }];
  const assistantParts: AdapterMessagePart[] = [];
  let finalText = '';
  let toolCalls = 0;
  let iterations = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let stopped: SubagentResult['stopped'] = 'done';
  let error: string | undefined;
  const sandboxConfirm = sandboxOn && sandboxNeedsConfirm();

  const timeout = AbortSignal.timeout(s.timeoutSec * 1000);
  const signal = AbortSignal.any([deps.signal, timeout]);

  try {
    for (;;) {
      iterations += 1;
      if (iterations > s.maxIterations) { stopped = 'iterations'; break; }
      const turnMessages: AdapterMessage[] = assistantParts.length
        ? [...messages, { role: 'assistant', parts: assistantParts.slice() }]
        : messages;
      const pending: { id: string; name: string; args: string; sig?: string }[] = [];
      let text = '';
      let stopReason = 'stop';
      const redactor = new StreamingSecretRedactor(deps.secretValues);
      for await (const ev of deps.adapter.streamChat(deps.cfg, {
        model: deps.model.modelId,
        system,
        messages: turnMessages,
        tools: tools.length ? tools : undefined,
        maxTokens: Math.min(config.defaultModelOutputTokens, config.maxModelOutputTokens),
        hardMaxTokens: config.maxModelOutputTokens,
        reasoning: deps.reasoning,
        signal,
      })) {
        if (ev.type === 'text') {
          deps.consumeOutput(ev.text.length);
          text += redactor.push(ev.text);
        } else if (ev.type === 'tool_call') {
          deps.consumeOutput(ev.id.length + ev.name.length + ev.args.length);
          pending.push({ id: ev.id, name: ev.name, args: ev.args, sig: ev.sig });
        } else if (ev.type === 'usage') {
          promptTokens += ev.usage.promptTokens ?? 0;
          completionTokens += ev.usage.completionTokens ?? 0;
        } else if (ev.type === 'stop') {
          stopReason = ev.reason;
        }
      }
      text += redactor.flush();
      if (text) {
        assistantParts.push({ type: 'text', text });
        finalText = text; // the last text block is the answer
      }
      if (stopReason !== 'tool_calls' || !pending.length) break;

      const denied = new Set<string>();
      const askFor = pending.filter((c) => isSandboxTool(c.name) && sandboxConfirm && !isTrustedCommand(c.name, c.args));
      if (askFor.length) {
        deps.onProgress(`等待用户确认 ${askFor.length} 条命令…`);
        const decisions = await deps.askConfirm(askFor.map((c) => ({ id: c.id, name: c.name, args: c.args })));
        for (const [id, d] of decisions) if (d !== 'allow') denied.add(id);
      }
      for (const call of pending) {
        assistantParts.push({ type: 'tool_call', id: call.id, name: call.name, args: call.args, sig: call.sig });
        toolCalls += 1;
        const what = summarizeArgs(call.name, call.args);
        deps.onProgress(`${VERB[call.name] ?? call.name}${what ? `「${what}」` : ''}`);
        let result: string;
        let isError = false;
        if (denied.has(call.id)) {
          result = '用户拒绝了这次调用'; isError = true;
        } else if (signal.aborted) {
          result = '任务已中止'; isError = true;
        } else if (isWorkspaceTool(call.name) && workspaceOn) {
          ({ result, isError } = await callWorkspaceTool(deps.chatId, call.name, call.args));
        } else if (isSandboxTool(call.name) && (sandboxOn || (call.name === CONVERT_FILE_TOOL && convertOn))) {
          ({ result, isError } = await callSandboxTool({ user, chatId: deps.chatId, messageId: deps.parentMessageId, signal, projectId: sandboxProjectId }, call.args, call.name));
        } else if (isSkillTool(call.name) && skillRows.length) {
          ({ result, isError } = callSkillTool(user, call.name, call.args));
        } else if (isProjectTool(call.name) && projectOn) {
          ({ result, isError } = callProjectTool(deps.projectId!, call.name, call.args));
        } else {
          result = `子代理不能使用工具「${call.name}」`; isError = true;
        }
        const safe = redactSensitiveText(result, deps.secretValues);
        const cap = Math.min(100_000, Math.floor(historyBudget(deps.model.modelId).textChars / 4));
        const trimmed = safe.length > cap ? `${safe.slice(0, cap)}\n…(结果已截断)` : safe;
        deps.consumeOutput(trimmed.length);
        assistantParts.push({ type: 'tool_result', toolCallId: call.id, name: call.name, result: trimmed || '(空)', isError });
      }
      if (signal.aborted) { stopped = timeout.aborted ? 'timeout' : 'aborted'; break; }
    }
  } catch (err) {
    if (timeout.aborted) stopped = 'timeout';
    else if (deps.signal.aborted) stopped = 'aborted';
    else { stopped = 'error'; error = redactSensitiveText(err instanceof Error ? err.message : String(err), deps.secretValues); }
  }

  const durationMs = Date.now() - t0;
  recordUsage({
    userId: user.id, chatId: deps.chatId, messageId: deps.parentMessageId,
    providerId: deps.provider.id, providerType: deps.provider.type, model: deps.model.modelId,
    kind: 'subagent', images: 0,
    promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, durationMs,
  });
  return {
    text: finalText.length > s.maxResultChars ? `${finalText.slice(0, s.maxResultChars)}\n…(结论过长,已截断)` : finalText,
    toolCalls, iterations, promptTokens, completionTokens, durationMs, stopped, error,
  };
}

export function formatSubagentResult(r: SubagentResult): string {
  const head = r.stopped === 'done'
    ? `子代理完成(${r.toolCalls} 次工具调用,${(r.durationMs / 1000).toFixed(0)} 秒)`
    : r.stopped === 'timeout' ? `子代理超时被终止(${r.toolCalls} 次工具调用),以下是它中止前的最后输出`
    : r.stopped === 'iterations' ? `子代理达到工具轮数上限后停止(${r.toolCalls} 次工具调用),以下是它的最后输出`
    : r.stopped === 'aborted' ? '子代理已中止'
    : `子代理出错:${r.error ?? '未知错误'}`;
  return `${head}\n\n${r.text.trim() || '(没有文字结论;请查看工作区里的文件)'}`;
}

