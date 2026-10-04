// 本地 Claude Code: the admin's own Claude Code login as a chat provider, for
// trying the panel out on this machine. Requests go through the `claude`
// process (Agent SDK), never straight to the API with its credentials.
//
// Claude Code runs with none of its own tools, settings, CLAUDE.md or plugins;
// the panel's tools for the turn are served to it as an in-process MCP server
// whose handlers do not run anything themselves. A call is handed to the
// panel as an ordinary tool_call and the stream stops with 'tool_calls'; the
// `claude` process stays parked, its MCP call open. The panel executes the
// call its usual way (confirm cards and all) and calls streamChat again with
// the tool_result appended; that result answers the open MCP call — matched
// by the tool_use id Claude Code puts in the call's _meta — and the same
// stream carries on.
//
// Across user turns Claude Code's own session is resumed: each finished turn
// records a fingerprint of the conversation it ended on, and a request whose
// history (minus the new user message) has that fingerprint resumes at that
// point, forking so an edit or a regenerate branches off cleanly. Anything
// else — first turn, server restart, history from another model — starts a
// fresh session with the history transcribed into the first message.
//
// The mod in server/claude-code-mod strips what Claude Code injects about
// the machine it runs on (cwd, the operator's e-mail, token counters).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  query, type EffortLevel, type Options, type Query, type SDKMessage, type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { config, serverRoot } from '../config.js';
import type {
  AdapterEvent, AdapterMessage, AdapterMessagePart, ChatAdapter, ChatRequest, StopReason, ToolDef,
} from '../types.js';

const SERVER = 'caui';
const PREFIX = `mcp__${SERVER}__`;
const MOD_DIR = path.join(serverRoot, 'claude-code-mod');
const WORK_DIR = path.join(config.dataDir, 'claude-code');
const SESSIONS_FILE = path.join(WORK_DIR, 'sessions.json');
const MAX_SESSIONS = 500;
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
// A parked run waits on a person (confirm card) or a long tool; past the
// panel's own turn limit nobody is coming back for it.
const PARK_MS = config.chatTurnTimeoutMs + 60_000;
const TRANSCRIPT_RESULT_CHARS = 4000;

function executable(): string | undefined {
  if (config.claudeCodePath) return config.claudeCodePath;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : undefined;
}

// The service's environment, minus anything that would make Claude Code bill
// an API key instead of the logged-in subscription, or think it is nested
// inside another Claude Code session.
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_)/.test(k)) delete env[k];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'cat-agentui';
  // The panel's tools are the whole toolset; never hide them behind search.
  env.ENABLE_TOOL_SEARCH = 'false';
  return env;
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => { this.resolve = res; this.reject = rej; });
    this.promise.catch(() => {});
  }
}

// ---- session fingerprints ----

interface SessionPoint { sessionId: string; uuid: string }

const sessions = new Map<string, SessionPoint>();
let sessionsLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadSessions() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as [string, SessionPoint][];
    for (const [k, v] of raw) sessions.set(k, v);
  } catch { /* first run */ }
}

function rememberSession(fp: string, point: SessionPoint) {
  sessions.delete(fp);
  sessions.set(fp, point);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions]), { mode: 0o600 }); } catch { /* best effort */ }
  }, 1000);
  saveTimer.unref();
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** What the conversation said, insensitive to how the panel split it into
 * parts: text is whitespace-normalised and merged per speaker, media and
 * tool calls are identified by content hash and id. */
function fingerprint(messages: AdapterMessage[], tail = ''): string {
  const items: string[] = [];
  const text = (role: string, t: string | undefined) => {
    const norm = (t ?? '').replace(/\s+/g, ' ').trim();
    if (!norm) return;
    const last = items[items.length - 1];
    if (last?.startsWith(`${role}:`)) items[items.length - 1] = `${last} ${norm}`;
    else items.push(`${role}:${norm}`);
  };
  for (const m of messages) {
    if (m.role === 'user') {
      items.push('U');
      for (const p of m.parts) {
        if (p.type === 'text') text('u', p.text);
        else if (p.dataBase64) items.push(`m:${sha(p.dataBase64)}`);
      }
    } else {
      for (const p of m.parts) {
        if (p.type === 'text') text('a', p.text);
        else if (p.type === 'tool_call') items.push(`c:${p.id}`);
        else if (p.type === 'tool_result') items.push(`r:${p.toolCallId}`);
      }
    }
  }
  text('a', tail);
  return sha(items.join('\n'));
}

// ---- prompt building ----

type Block = Record<string, unknown>;

function mediaBlock(p: AdapterMessagePart): Block | null {
  if (!p.dataBase64) return null;
  if (p.type === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: p.mime || 'image/png', data: p.dataBase64 } };
  }
  if (p.type === 'file') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: p.mime || 'application/pdf', data: p.dataBase64 },
      ...(p.name ? { title: p.name } : {}),
    };
  }
  return null;
}

function userBlocks(m: AdapterMessage): Block[] {
  const out: Block[] = [];
  for (const p of m.parts) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else {
      const b = mediaBlock(p);
      if (b) out.push(b);
    }
  }
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…(已截断)` : s;
}

/** Earlier turns as one readable record, pictures kept in place. Only used
 * when there is no Claude Code session to resume. */
function transcriptBlocks(history: AdapterMessage[]): Block[] {
  if (!history.length) return [];
  const out: Block[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  buf += '<conversation_history>\n以下是本对话此前的记录（由聊天面板转录）。\n';
  for (const m of history) {
    if (m.role === 'user') {
      buf += '\n<user>\n';
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) buf += `${p.text}\n`;
        else {
          const b = mediaBlock(p);
          if (b) { flush(); out.push(b); }
        }
      }
      buf += '</user>\n';
    } else {
      buf += '\n<assistant>\n';
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) buf += `${p.text}\n`;
        else if (p.type === 'tool_call') buf += `[调用工具 ${p.name}] ${clip(p.args || '{}', TRANSCRIPT_RESULT_CHARS)}\n`;
        else if (p.type === 'tool_result') {
          buf += `[工具 ${p.name ?? ''} ${p.isError ? '出错' : '返回'}] ${clip(p.result ?? '', TRANSCRIPT_RESULT_CHARS)}\n`;
        }
      }
      buf += '</assistant>\n';
    }
  }
  buf += '</conversation_history>\n\n';
  flush();
  return out;
}

function userMessage(content: Block[]): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: content as any },
    parent_tool_use_id: null,
  };
}

// ---- runs ----

type Result = { text: string; isError: boolean };

class Run {
  readonly abort = new AbortController();
  readonly done = new Deferred<void>();
  /** Answers for open MCP calls, by tool_use id; whichever side comes first creates it. */
  private readonly answers = new Map<string, Deferred<Result>>();
  /** Calls handed to the panel and not yet answered. */
  readonly awaiting = new Set<string>();
  q!: Query;
  iter!: AsyncIterator<SDKMessage>;
  sessionId: string | null = null;
  lastUuid: string | null = null;
  stderr = '';
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private parkSignal: { signal: AbortSignal; onAbort: () => void } | null = null;
  closed = false;

  answer(id: string): Deferred<Result> {
    let d = this.answers.get(id);
    if (!d) { d = new Deferred(); this.answers.set(id, d); }
    return d;
  }

  /** Wait for the panel to run the calls; stopping the chat meanwhile ends the run. */
  park(signal: AbortSignal) {
    for (const id of this.awaiting) parked.set(id, this);
    this.parkTimer = setTimeout(() => this.close(), PARK_MS);
    this.parkTimer.unref();
    const onAbort = () => this.close();
    signal.addEventListener('abort', onAbort, { once: true });
    this.parkSignal = { signal, onAbort };
  }

  unpark() {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = null;
    this.parkSignal?.signal.removeEventListener('abort', this.parkSignal.onAbort);
    this.parkSignal = null;
    for (const id of this.awaiting) if (parked.get(id) === this) parked.delete(id);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unpark();
    for (const d of this.answers.values()) d.reject(new Error('aborted'));
    this.done.resolve();
    this.abort.abort();
    try { this.q?.close(); } catch { /* already gone */ }
  }
}

/** Parked runs by the tool_use ids they are waiting on. */
const parked = new Map<string, Run>();

function mcpServer(run: Run, tools: ToolDef[]) {
  const server = new McpServer({ name: SERVER, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', ...t.parameters } as { type: 'object' },
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const id = (req.params._meta as Record<string, unknown> | undefined)?.['claudecode/toolUseId'];
    if (typeof id !== 'string') {
      return { content: [{ type: 'text', text: '工具调用缺少 tool_use id，无法交给面板执行' }], isError: true };
    }
    const r = await Promise.race([
      run.answer(id).promise,
      new Promise<never>((_, rej) => extra.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })),
    ]);
    return { content: [{ type: 'text', text: r.text || '(no output)' }], ...(r.isError ? { isError: true } : {}) };
  });
  return { type: 'sdk' as const, name: SERVER, instance: server };
}

function thinkingOptions(req: ChatRequest): Pick<Options, 'thinking' | 'effort'> {
  const level = req.reasoning?.level;
  if (level === 'off') return { thinking: { type: 'disabled' } };
  const thinking = { type: 'adaptive' as const, display: 'summarized' as const };
  if (!level) return { thinking };
  if (EFFORTS.includes(level)) return { thinking, effort: level as EffortLevel };
  // An admin-made ladder with names of its own: go by position.
  const ratio = req.reasoning!.ratio;
  return { thinking, effort: EFFORTS[Math.min(EFFORTS.length - 1, Math.round(ratio * (EFFORTS.length - 1)))] as EffortLevel };
}

function startRun(req: ChatRequest): Run {
  loadSessions();
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  let content: Block[];
  let resume: SessionPoint | undefined;
  if (last?.role === 'user') {
    resume = sessions.get(fingerprint(msgs.slice(0, -1)));
    content = resume ? userBlocks(last) : [...transcriptBlocks(msgs.slice(0, -1)), ...userBlocks(last)];
  } else {
    // A tool round nobody is parked for (server restarted mid-turn): replay
    // everything and let the model pick up from the results.
    content = [...transcriptBlocks(msgs), { type: 'text', text: '请根据以上记录（包括最后的工具结果）继续完成回复。' }];
  }
  if (!content.length) content = [{ type: 'text', text: '(空消息)' }];

  const run = new Run();
  const tools = req.tools ?? [];
  async function* input() {
    yield userMessage(content);
    await run.done.promise;
  }
  run.q = query({
    prompt: input(),
    options: {
      pathToClaudeCodeExecutable: executable(),
      cwd: WORK_DIR,
      env: childEnv(),
      abortController: run.abort,
      model: req.model,
      systemPrompt: { type: 'custom', prompt: req.system || 'You are a helpful assistant.', snapshot: false },
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: tools.length ? { [SERVER]: mcpServer(run, tools) } : {},
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      plugins: [{ type: 'local', path: MOD_DIR }],
      includePartialMessages: true,
      title: 'Cat-AgentUI',
      ...thinkingOptions(req),
      ...(resume ? { resume: resume.sessionId, resumeSessionAt: resume.uuid, forkSession: true } : {}),
      stderr: (d) => { run.stderr = (run.stderr + d).slice(-2000); },
    },
  });
  run.iter = run.q[Symbol.asyncIterator]();
  return run;
}

function stopReason(r: string | null | undefined): StopReason {
  return r === 'end_turn' || r === 'stop_sequence' ? 'stop'
    : r === 'tool_use' ? 'tool_calls'
    : r === 'max_tokens' ? 'length'
    : r === 'refusal' ? 'content_filter' : 'other';
}

function errorText(m: Extract<SDKMessage, { type: 'assistant' }>): string {
  const t = (m.message.content as { type: string; text?: string }[])
    .filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
  return t || m.error || 'Claude Code 返回错误';
}

/** Read the run until the model stops: parked on panel tool calls, or done. */
async function* pump(run: Run, req: ChatRequest): AsyncGenerator<AdapterEvent> {
  const onAbort = () => run.close();
  if (req.signal.aborted) run.close();
  req.signal.addEventListener('abort', onAbort, { once: true });
  let promptTokens = 0;
  let completionTokens = 0;
  let reason: string | null = null;
  let assistantError: string | null = null;
  let tail = '';
  let parkedNow = false;
  try {
    for (;;) {
      if (run.closed) throw new Error(req.signal.aborted ? '对话已停止' : 'Claude Code 会话已结束');
      const next = await run.iter.next();
      if (req.signal.aborted) throw new Error('对话已停止');
      if (next.done) {
        throw new Error(`Claude Code 意外退出${run.stderr ? `: ${run.stderr.trim().split('\n').pop()}` : ''}`);
      }
      const m = next.value;
      req.onActivity?.();
      if (m.type === 'system' && m.subtype === 'init') {
        run.sessionId = m.session_id;
      } else if (m.type === 'stream_event') {
        if (m.parent_tool_use_id) continue;
        const ev = m.event as any;
        if (ev.type === 'message_start') {
          const u = ev.message?.usage ?? {};
          promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          completionTokens = 0;
          reason = null;
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && d.text) { tail += d.text; yield { type: 'text', text: d.text }; }
          else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) reason = ev.delta.stop_reason;
          if (ev.usage?.output_tokens !== undefined) completionTokens = ev.usage.output_tokens;
        } else if (ev.type === 'message_stop') {
          if (promptTokens || completionTokens) {
            yield { type: 'usage', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
          }
          promptTokens = completionTokens = 0;
          if (reason === 'tool_use' && run.awaiting.size) {
            run.park(req.signal);
            parkedNow = true;
            yield { type: 'stop', reason: 'tool_calls' };
            return;
          }
        }
      } else if (m.type === 'assistant') {
        if (m.parent_tool_use_id) continue;
        run.sessionId = m.session_id;
        run.lastUuid = m.uuid;
        if (m.error) assistantError = errorText(m);
        for (const b of m.message.content as { type: string; id?: string; name?: string; input?: unknown }[]) {
          if (b.type !== 'tool_use' || !b.id || !b.name?.startsWith(PREFIX)) continue;
          run.awaiting.add(b.id);
          yield { type: 'tool_call', id: b.id, name: b.name.slice(PREFIX.length), args: JSON.stringify(b.input ?? {}) };
        }
      } else if (m.type === 'result') {
        run.sessionId = m.session_id;
        if (m.subtype !== 'success') {
          throw new Error(`Claude Code: ${m.errors?.join('; ') || m.subtype}`);
        }
        if (m.is_error) throw new Error(`Claude Code: ${assistantError || m.result || '请求失败'}`);
        if (run.sessionId && run.lastUuid) {
          rememberSession(fingerprint(req.messages, tail), { sessionId: run.sessionId, uuid: run.lastUuid });
        }
        yield { type: 'stop', reason: stopReason(reason ?? m.stop_reason) };
        return;
      }
    }
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    // Done, failed, or the consumer walked away mid-stream: only a run that
    // just parked on tool calls lives on.
    if (!parkedNow) run.close();
  }
}

/** The run this request continues: its last message answers calls a parked run handed out. */
function resumeParked(req: ChatRequest): Run | null {
  const last = req.messages[req.messages.length - 1];
  if (last?.role !== 'assistant') return null;
  const results = new Map<string, AdapterMessagePart>();
  for (const p of last.parts) if (p.type === 'tool_result' && p.toolCallId) results.set(p.toolCallId, p);
  let run: Run | undefined;
  for (const id of results.keys()) { run = parked.get(id); if (run) break; }
  if (!run) return null;
  run.unpark();
  for (const id of run.awaiting) {
    const r = results.get(id);
    run.answer(id).resolve(r
      ? { text: r.result ?? '', isError: !!r.isError }
      : { text: '(调用未执行)', isError: true });
  }
  run.awaiting.clear();
  return run;
}

export const claudeCodeAdapter: ChatAdapter = {
  async *streamChat(_cfg, req) {
    const run = resumeParked(req) ?? startRun(req);
    yield* pump(run, req);
  },

  async listModels() {
    const run = new Run();
    async function* input(): AsyncGenerator<SDKUserMessage> { await run.done.promise; }
    const q = query({
      prompt: input(),
      options: {
        pathToClaudeCodeExecutable: executable(),
        cwd: WORK_DIR, env: childEnv(), abortController: run.abort,
        tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
      },
    });
    run.q = q;
    try {
      const list = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Claude Code 没有响应（是否已安装并登录？）')), 30_000).unref()),
      ]);
      const seen = new Set<string>();
      const out: { id: string; name?: string }[] = [];
      for (const m of list) {
        if (m.value === 'default') continue;
        const id = m.resolvedModel || m.value;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: m.displayName });
      }
      return out;
    } finally {
      run.close();
    }
  },
};
