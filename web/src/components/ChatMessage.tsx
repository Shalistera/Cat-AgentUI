import { memo, useEffect, useState } from 'react';
import {
  BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Clock, FileText, GitBranch, Globe,
  Pencil, RefreshCw, Search, Shuffle, Trash2, Wrench, Zap, CircleAlert, Ban,
} from 'lucide-react';
import type { Message, MessagePart, ModelInfo } from '../types';
import { fmtDuration, fmtTokens } from '../api';
import { useModels } from '../store';
import { Markdown } from './Markdown';
import { ModelAvatar } from './ModelAvatar';
import { Button, Popover, Spinner } from './ui';

const iconBtn = 'flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-tx3 transition-colors hover:bg-bg2 hover:text-tx';

function CopyBtn({ text, size = 12 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="复制"
      className={iconBtn}
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      })}
    >
      {copied ? <Check size={size} className="text-ok" /> : <Copy size={size} />}
    </button>
  );
}

/** 重新生成菜单:沿用上次的模型,或换一个模型(同时成为本对话的默认模型)。 */
function RegenerateMenu({ lastModel, onSame, onWith }: {
  /** Provider model id of the message being regenerated — display only. */
  lastModel: string | null;
  onSame(): void;
  onWith(m: ModelInfo): void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const models = useModels((s) => s.models);

  useEffect(() => {
    if (!open) { setPicking(false); setQuery(''); }
  }, [open]);

  const filtered = query.trim()
    ? models.filter((m) => `${m.displayName} ${m.modelId} ${m.providerName}`.toLowerCase().includes(query.toLowerCase()))
    : models;

  const menuRow = 'flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg2';

  return (
    <Popover open={open} setOpen={setOpen} width="w-72" trigger={
      <button title="重新生成" className={iconBtn}><RefreshCw size={12} /></button>
    }>
      {!picking ? (
        <div className="py-1">
          <button className={menuRow} onClick={() => { setOpen(false); onSame(); }}>
            <RefreshCw size={14} className="mt-0.5 shrink-0 text-tx3" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-tx">用上次的模型重新生成</span>
              {lastModel && <span className="mt-0.5 block truncate font-mono text-[11px] text-tx3">{lastModel}</span>}
            </span>
          </button>
          <button className={menuRow} onClick={() => setPicking(true)}>
            <Shuffle size={14} className="mt-0.5 shrink-0 text-tx3" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-tx">用其他模型重新生成</span>
              <span className="mt-0.5 block text-[11px] text-tx3">选择的模型将成为本对话的默认模型</span>
            </span>
            <ChevronRight size={13} className="mt-1 shrink-0 text-tx3" />
          </button>
        </div>
      ) : (
        <>
          <div className="border-b border-line p-2">
            <label className="relative block">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
              <input
                autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索模型" placeholder="搜索名称、ID 或服务商…"
                className="w-full rounded-md border border-field bg-bg1 py-1.5 pl-8 pr-2.5 text-xs text-tx transition-colors placeholder:text-tx3 hover:border-tx3"
              />
            </label>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filtered.map((m) => (
              <button key={m.id}
                className="flex w-full cursor-pointer items-center gap-2.5 border-b border-line/70 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-bg2"
                onClick={() => { setOpen(false); onWith(m); }}
              >
                <ModelAvatar info={m} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-tx">{m.displayName}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-tx3">{m.providerName} · {m.modelId}</span>
                </span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-xs text-tx3">没有匹配的模型</p>}
          </div>
        </>
      )}
    </Popover>
  );
}

/** 版本切换:同一位置的多个回复/编辑版本(树的兄弟节点)之间左右切换。 */
function SiblingSwitch({ info, onPrev, onNext }: {
  info: { index: number; total: number };
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const arrow = 'flex h-5 w-5 cursor-pointer items-center justify-center rounded-sm text-tx3 transition-colors hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-35';
  return (
    <span className="flex items-center gap-0 text-[11px] tabular-nums text-tx3">
      <button title="上一个版本" className={arrow} disabled={!onPrev} onClick={onPrev}>
        <ChevronLeft size={13} />
      </button>
      <span className="px-0.5">{info.index + 1}/{info.total}</span>
      <button title="下一个版本" className={arrow} disabled={!onNext} onClick={onNext}>
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

/** Shared shell for the collapsible reasoning / tool panels. */
function Disclosure({ open, onToggle, icon, label, meta, children }: {
  open: boolean; onToggle(): void; icon: React.ReactNode; label: React.ReactNode;
  meta?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-line bg-bg2/40">
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-bg2"
        onClick={onToggle}
      >
        {icon}
        {label}
        {meta}
        {open ? <ChevronDown size={13} className="ml-auto shrink-0 text-tx3" /> : <ChevronRight size={13} className="ml-auto shrink-0 text-tx3" />}
      </button>
      {open && children}
    </div>
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const show = open || streaming;
  return (
    <Disclosure
      open={show}
      onToggle={() => setOpen(!show)}
      icon={<BrainCircuit size={13} className={streaming ? 'animate-pulse text-acc' : 'text-tx3'} />}
      label={<span className="font-medium text-tx2">{streaming ? '正在推理…' : '推理过程'}</span>}
    >
      <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-line bg-bg1 px-3.5 py-2.5 text-[13px] leading-relaxed text-tx2">
        {text}
      </div>
    </Disclosure>
  );
}

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

// 'Brave_____brave_web_search' → 'brave_web_search' (namespace prefix ends
// with the double underscore the server inserts).
function toolShortName(name: string): string {
  const parts = name.split('__');
  return (parts[parts.length - 1] || name).replace(/^_+/, '');
}

function isSearchTool(name: string): boolean {
  return /search|news|query/i.test(toolShortName(name));
}

function queryOf(call: ToolCallPart): string {
  try {
    const a = JSON.parse(call.args || '{}') as Record<string, unknown>;
    const q = a.query ?? a.q ?? a.keyword ?? a.searchTerm;
    return typeof q === 'string' ? q : '';
  } catch { return ''; }
}

// One compact status line for a whole run of consecutive tool calls. Users see
// what the model is doing, never how (no raw params/results) — expanding shows
// one row per call, and error text only when a call actually failed.
function ToolRun({ calls, results, organizing }: {
  calls: ToolCallPart[];
  results: Map<string, ToolResultPart>;
  /** All calls answered but the model hasn't produced anything after them yet. */
  organizing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = calls.filter((c) => !results.has(c.id));
  const failed = calls.filter((c) => results.get(c.id)?.isError);
  const searching = calls.some((c) => isSearchTool(c.name));
  const active = pending.length > 0;
  const busy = active || organizing;
  const noun = searching ? '搜索' : '调用工具';

  let label: string;
  if (active) {
    const q = queryOf(pending[pending.length - 1]);
    label = q ? `正在${noun}「${q}」…` : `正在${noun}…`;
  } else if (organizing) {
    label = `${noun}完成,正在整理结果…`;
  } else if (failed.length) {
    label = `${searching ? '已搜索' : '已调用工具'} ${calls.length} 次,${failed.length} 次失败`;
  } else {
    label = calls.length === 1 ? `${noun}完成` : `${searching ? '已搜索' : '已调用工具'} ${calls.length} 次`;
  }

  const Icon = searching ? Globe : Wrench;

  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen(!open)}
      icon={busy
        ? <Spinner className="h-3.5 w-3.5 shrink-0 text-acc" />
        : <Icon size={13} className={`shrink-0 ${failed.length ? 'text-err' : 'text-tx3'}`} />}
      label={
        <span className={`truncate font-medium ${busy ? 'animate-pulse text-acc' : 'text-tx2'}`}>
          {label}
        </span>
      }
    >
      <div className="divide-y divide-line/70 border-t border-line bg-bg1">
        {calls.map((c) => {
          const r = results.get(c.id);
          const q = queryOf(c);
          return (
            <div key={c.id} className="px-3.5 py-2 text-xs">
              <div className="flex items-center gap-2">
                {/* Spinner inherits currentColor; without this it would pick up
                    body ink instead of the muted in-progress grey. */}
                {!r ? <Spinner className="h-3 w-3 shrink-0 text-tx3" />
                  : r.isError ? <CircleAlert size={13} className="shrink-0 text-err" />
                  : <Check size={13} className="shrink-0 text-ok" />}
                <span className="shrink-0 text-tx2">{isSearchTool(c.name) ? '搜索' : toolShortName(c.name)}</span>
                {q && <span className="truncate text-tx3">「{q}」</span>}
              </div>
              {r?.isError && (
                <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-err/30 bg-err/10 px-2 py-1.5 text-[11px] leading-relaxed text-err">
                  {r.result.slice(0, 500)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}

type GroundingPart = Extract<MessagePart, { type: 'grounding' }>;

function sourceHost(uri: string): string {
  try { return new URL(uri).hostname.replace(/^www\./, ''); } catch { return uri; }
}

function GroundingBlock({ part }: { part: GroundingPart }) {
  const [open, setOpen] = useState(false);
  const count = part.sources.length;
  if (count === 0 && part.queries.length === 0) return null;
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen(!open)}
      icon={<Globe size={13} className="shrink-0 text-tx3" />}
      label={<span className="font-medium text-tx2">Google 搜索{count ? ` · ${count} 个来源` : ''}</span>}
    >
      <div className="border-t border-line bg-bg1 px-3.5 py-2.5">
        {part.queries.length > 0 && (
          <p className="mb-2 break-words text-[11px] leading-relaxed text-tx3">
            搜索：{part.queries.join(' · ')}
          </p>
        )}
        {count > 0 && (
          <div className="space-y-1.5">
            {part.sources.map((source, i) => (
              <a key={`${source.uri}-${i}`} href={source.uri} target="_blank" rel="noreferrer"
                className="block rounded-md px-2 py-1.5 transition-colors hover:bg-bg2">
                <span className="block truncate text-xs font-medium text-tx hover:text-acc">{source.title}</span>
                <span className="mt-0.5 block truncate text-[10px] text-tx3">{sourceHost(source.uri)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </Disclosure>
  );
}

function partsToPlainText(parts: MessagePart[]): string {
  return parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
}

function partSrc(p: Extract<MessagePart, { type: 'image' }>): string | null {
  if (p.imageId) return `/api/images/${p.imageId}/file`;
  if (p.uploadId) return `/api/uploads/${p.uploadId}/file`;
  return p.url ?? null;
}

interface Props {
  msg: Message;
  isStreaming: boolean; // this message is currently being generated
  pendingLabel?: string; // shown while waiting for the first output
  onRegenerate?: () => void;
  /** Regenerate with a different model, which becomes the chat's default. */
  onRegenerateWith?: (m: ModelInfo) => void;
  onEdit?: (text: string) => void;
  /** Remove this message from the conversation (and from all later context). */
  onDelete?: () => void;
  /** Fork a new chat carrying the conversation up to and including this message. */
  onBranch?: () => void;
  /** Send a suggested follow-up question — only supplied on the latest reply. */
  onFollowup?: (q: string) => void;
  /** Save an in-place correction of this reply's text (no regeneration). */
  onEditAssistant?: (text: string) => void;
  /** Sibling versions at this position (regenerations / edits); shown when >1. */
  siblingInfo?: { index: number; total: number };
  onSiblingPrev?: () => void;
  onSiblingNext?: () => void;
}

export const ChatMessage = memo(function ChatMessage({ msg, isStreaming, pendingLabel, onRegenerate, onRegenerateWith, onEdit, onDelete, onBranch, onFollowup, onEditAssistant, siblingInfo, onSiblingPrev, onSiblingNext }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (msg.role === 'user') {
    const text = partsToPlainText(msg.parts);
    const images = msg.parts.filter((p) => p.type === 'image');
    const files = msg.parts.filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file');
    return (
      <div className="flex flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((p, i) => p.type === 'image' && partSrc(p) && (
              <img key={i} src={partSrc(p)!} alt=""
                className="max-h-40 rounded-lg border border-line object-cover" />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {files.map((p, i) => (
              <a key={i} href={`/api/uploads/${p.uploadId}/file`} target="_blank" rel="noreferrer"
                title="查看附件"
                className="flex max-w-64 items-center gap-2 rounded-lg border border-line bg-bg1 px-3 py-2 text-xs text-tx transition-colors hover:bg-bg2">
                <FileText size={15} className="shrink-0 text-tx2" />
                <span className="truncate font-medium">{p.name || '附件文档'}</span>
                {p.mime === 'application/pdf' && <span className="shrink-0 text-[10px] text-tx3">PDF</span>}
              </a>
            ))}
          </div>
        )}
        {editing ? (
          <div className="w-full max-w-[85%]">
            <textarea
              className="w-full resize-y rounded-lg border border-field bg-bg1 px-3.5 py-2.5 text-[15px] leading-relaxed text-tx"
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>取消</Button>
              <Button variant="primary" size="sm"
                onClick={() => { setEditing(false); if (draft.trim()) onEdit?.(draft.trim()); }}>
                重新发送
              </Button>
            </div>
          </div>
        ) : (
          text && (
            <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm border border-line bg-bg2 px-3.5 py-2.5 text-[15px] leading-relaxed text-tx">
              {text}
            </div>
          )
        )}
        {!editing && (
          <div className="flex items-center gap-0.5">
            {siblingInfo && <SiblingSwitch info={siblingInfo} onPrev={onSiblingPrev} onNext={onSiblingNext} />}
            <CopyBtn text={text} />
            {onEdit && (
              <button title="编辑并重新发送" className={iconBtn} onClick={() => { setDraft(text); setEditing(true); }}>
                <Pencil size={12} />
              </button>
            )}
            {onBranch && (
              <button title="从这里创建分支:复制到此为止的对话到一个新对话" className={iconBtn} onClick={onBranch}>
                <GitBranch size={12} />
              </button>
            )}
            {onDelete && (
              <button title="删除这条消息(之后的回复不再引用它)" className={`${iconBtn} hover:text-err`} onClick={onDelete}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // assistant — render parts in order, folding each run of consecutive tool
  // activity into a single status line
  const rendered: React.ReactNode[] = [];
  const resultsByCallId = new Map<string, ToolResultPart>();
  for (const p of msg.parts) if (p.type === 'tool_result') resultsByCallId.set(p.toolCallId, p);
  let lastTextIdx = -1;
  msg.parts.forEach((p, i) => { if (p.type === 'text') lastTextIdx = i; });

  for (let i = 0; i < msg.parts.length; i++) {
    const p = msg.parts[i];
    if (p.type === 'reasoning') {
      const isLast = i === msg.parts.length - 1;
      rendered.push(<ReasoningBlock key={i} text={p.text} streaming={isStreaming && isLast} />);
    } else if (p.type === 'text') {
      const streamingThis = isStreaming && i === lastTextIdx && i === msg.parts.length - 1;
      rendered.push(
        <div key={i} className={streamingThis ? 'blink-cursor' : ''}>
          <Markdown text={p.text} />
        </div>,
      );
    } else if (p.type === 'tool_call' || p.type === 'tool_result') {
      const start = i;
      const calls: ToolCallPart[] = [];
      let end = i;
      while (end < msg.parts.length) {
        const tp = msg.parts[end];
        if (tp.type !== 'tool_call' && tp.type !== 'tool_result') break;
        if (tp.type === 'tool_call') calls.push(tp);
        end++;
      }
      i = end - 1;
      if (calls.length) {
        // "Organizing": every call answered, nothing after the run yet, still
        // streaming — the model is reading results, tell the user so.
        const trailing = end === msg.parts.length;
        const allDone = calls.every((c) => resultsByCallId.has(c.id));
        rendered.push(
          <ToolRun key={start} calls={calls} results={resultsByCallId}
            organizing={isStreaming && trailing && allDone} />,
        );
      }
    } else if (p.type === 'grounding') {
      rendered.push(<GroundingBlock key={i} part={p} />);
    } else if (p.type === 'image') {
      const src = partSrc(p);
      if (src) {
        rendered.push(
          <a key={i} href={src} target="_blank" rel="noreferrer" title="在新标签页查看原图"
            className="my-2.5 block w-fit max-w-full">
            <img src={src} alt="模型生成的图片"
              className="max-h-[28rem] max-w-full rounded-lg border border-line" />
          </a>,
        );
      }
    }
  }

  const plain = partsToPlainText(msg.parts);
  const followups = msg.parts.flatMap((p) => (p.type === 'followups' ? p.questions : []));
  const hasStats = msg.durationMs != null || msg.totalTokens != null;
  const tps = msg.completionTokens && msg.durationMs && msg.durationMs > (msg.ttftMs ?? 0)
    ? msg.completionTokens / ((msg.durationMs - (msg.ttftMs ?? 0)) / 1000)
    : null;

  return (
    // sm:pr mirrors the avatar column (30px + gap-3) so the text block sits
    // centered in the column and the composer overhangs it equally per side.
    <div className="flex gap-3 sm:pr-[42px]">
      <div className="mt-0.5 hidden shrink-0 sm:block"><ModelAvatar model={msg.model} size={30} /></div>
      <div className="min-w-0 flex-1">
        {editing ? (
          // The editor works on the merged plain text; reasoning/tool/image
          // blocks are untouched by the edit and come back on save.
          <div className="w-full">
            <textarea
              className="w-full resize-y rounded-lg border border-field bg-bg1 px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-tx"
              rows={Math.min(20, Math.max(4, draft.split('\n').length + 1))}
              value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>取消</Button>
              <Button variant="primary" size="sm"
                onClick={() => {
                  setEditing(false);
                  const t = draft.trim();
                  if (t && t !== plain) onEditAssistant?.(t);
                }}>
                保存修改
              </Button>
            </div>
          </div>
        ) : rendered}
        {isStreaming && msg.parts.length === 0 && (
          <div className="flex items-center gap-2 py-1 text-[13px] text-tx3">
            <Spinner className="h-3.5 w-3.5" />{pendingLabel ?? '正在思考…'}
          </div>
        )}
        {msg.status === 'error' && msg.error && (
          <div className="my-2 flex items-start gap-2 rounded-lg border border-err/30 bg-err/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-err">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{msg.error}</span>
          </div>
        )}
        {msg.status === 'stopped' && (
          <div className="my-1.5 flex items-center gap-1.5 text-xs text-tx3"><Ban size={12} />已停止生成</div>
        )}
        {!isStreaming && !editing && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tx3">
            <span className="flex items-center gap-0.5">
              {siblingInfo && <SiblingSwitch info={siblingInfo} onPrev={onSiblingPrev} onNext={onSiblingNext} />}
              <CopyBtn text={plain} />
              {onEditAssistant && !!plain && (
                <button title="编辑回复内容(直接修改文字,不重新生成)" className={iconBtn}
                  onClick={() => { setDraft(plain); setEditing(true); }}>
                  <Pencil size={12} />
                </button>
              )}
              {onRegenerate && (
                onRegenerateWith
                  ? <RegenerateMenu lastModel={msg.model} onSame={onRegenerate} onWith={onRegenerateWith} />
                  : (
                    <button title="重新生成" className={iconBtn} onClick={onRegenerate}>
                      <RefreshCw size={12} />
                    </button>
                  )
              )}
              {onBranch && (
                <button title="从这里创建分支:复制到此为止的对话到一个新对话" className={iconBtn} onClick={onBranch}>
                  <GitBranch size={12} />
                </button>
              )}
              {onDelete && (
                <button title="删除这条消息(之后的回复不再引用它)" className={`${iconBtn} hover:text-err`} onClick={onDelete}>
                  <Trash2 size={12} />
                </button>
              )}
            </span>
            {msg.model && <span className="font-mono text-tx2">{msg.model}</span>}
            {hasStats && (
              <>
                <span className="flex items-center gap-1 tabular-nums" title="总耗时"><Clock size={11} />{fmtDuration(msg.durationMs)}</span>
                {msg.ttftMs != null && (
                  <span className="flex items-center gap-1 tabular-nums" title="首字延迟"><Zap size={11} />{fmtDuration(msg.ttftMs)}</span>
                )}
                {msg.totalTokens != null && msg.totalTokens > 0 && (
                  <span className="tabular-nums" title={`输入 ${msg.promptTokens ?? '?'} tokens · 输出 ${msg.completionTokens ?? '?'} tokens`}>
                    ↑{fmtTokens(msg.promptTokens)} ↓{fmtTokens(msg.completionTokens)} · 共 {fmtTokens(msg.totalTokens)} tokens
                  </span>
                )}
                {tps != null && tps > 0 && <span className="tabular-nums" title="输出速度">{tps.toFixed(1)} tok/s</span>}
              </>
            )}
          </div>
        )}
        {/* 快速追问 — only under the latest reply (onFollowup gates it), so
            stale suggestions never linger on older messages. */}
        {!isStreaming && !editing && onFollowup && followups.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {followups.map((q) => (
              <button
                key={q} type="button" title="点击发送这个追问"
                onClick={() => onFollowup(q)}
                className="cursor-pointer rounded-full border border-line bg-bg1 px-3.5 py-1.5 text-left text-[13px] leading-relaxed text-tx2 shadow-xs transition-colors hover:border-line2 hover:bg-bg2 hover:text-tx"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
