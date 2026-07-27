import { memo, useMemo, useState } from 'react';
import {
  BrainCircuit, Check, ChevronDown, ChevronRight, Copy, Clock, Pencil,
  RefreshCw, Wrench, Zap, CircleAlert, Ban,
} from 'lucide-react';
import type { Message, MessagePart } from '../types';
import { fmtDuration, fmtTokens } from '../api';
import { Markdown } from './Markdown';
import { ModelAvatar } from './ModelAvatar';
import { Spinner } from './ui';

const iconBtn = 'flex h-6 w-6 cursor-pointer items-center justify-center rounded text-tx3 transition-colors hover:bg-bg2 hover:text-tx';

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

function ToolBlock({ call, result }: {
  call: Extract<MessagePart, { type: 'tool_call' }>;
  result?: Extract<MessagePart, { type: 'tool_result' }>;
}) {
  const [open, setOpen] = useState(false);
  const prettyArgs = useMemo(() => {
    try { return JSON.stringify(JSON.parse(call.args || '{}'), null, 2); } catch { return call.args; }
  }, [call.args]);

  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen(!open)}
      icon={<Wrench size={13} className={!result ? 'animate-pulse text-acc' : result.isError ? 'text-err' : 'text-ok'} />}
      label={<span className="truncate font-mono text-[12px] font-medium text-tx">{call.name}</span>}
      meta={
        !result ? <span className="flex shrink-0 items-center gap-1.5 text-tx3"><Spinner className="h-3 w-3" />调用中</span>
        : result.isError ? <span className="shrink-0 text-err">失败</span>
        : <span className="shrink-0 text-tx3">完成</span>
      }
    >
      <div className="space-y-2.5 border-t border-line bg-bg1 px-3.5 py-2.5">
        <div>
          <div className="eyebrow mb-1">参数</div>
          <pre className="max-h-40 overflow-auto rounded-md border border-line bg-bg2 p-2 font-mono text-[11px] leading-relaxed text-tx2">{prettyArgs}</pre>
        </div>
        {result && (
          <div>
            <div className="eyebrow mb-1">结果</div>
            <pre className={`max-h-64 overflow-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-[11px] leading-relaxed ${
              result.isError ? 'border-err/30 bg-err/8 text-err' : 'border-line bg-bg2 text-tx2'}`}>{result.result}</pre>
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
  onEdit?: (text: string) => void;
}

export const ChatMessage = memo(function ChatMessage({ msg, isStreaming, pendingLabel, onRegenerate, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (msg.role === 'user') {
    const text = partsToPlainText(msg.parts);
    const images = msg.parts.filter((p) => p.type === 'image');
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((p, i) => p.type === 'image' && partSrc(p) && (
              <img key={i} src={partSrc(p)!} alt=""
                className="max-h-40 rounded-lg border border-line object-cover" />
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
              <button className="h-8 cursor-pointer rounded-md border border-line2 bg-bg1 px-3 text-[13px] font-medium text-tx transition-colors hover:bg-bg2"
                onClick={() => setEditing(false)}>取消</button>
              <button className="h-8 cursor-pointer rounded-md bg-pri px-3 text-[13px] font-medium text-prifg shadow-xs transition-colors hover:bg-pri2"
                onClick={() => { setEditing(false); if (draft.trim()) onEdit?.(draft.trim()); }}>
                重新发送
              </button>
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
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <CopyBtn text={text} />
            {onEdit && (
              <button title="编辑并重新发送" className={iconBtn} onClick={() => { setDraft(text); setEditing(true); }}>
                <Pencil size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // assistant — render parts in order, pairing tool_call/result
  const rendered: React.ReactNode[] = [];
  const resultsByCallId = new Map<string, Extract<MessagePart, { type: 'tool_result' }>>();
  for (const p of msg.parts) if (p.type === 'tool_result') resultsByCallId.set(p.toolCallId, p);
  let lastTextIdx = -1;
  msg.parts.forEach((p, i) => { if (p.type === 'text') lastTextIdx = i; });

  msg.parts.forEach((p, i) => {
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
    } else if (p.type === 'tool_call') {
      rendered.push(<ToolBlock key={i} call={p} result={resultsByCallId.get(p.id)} />);
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
  });

  const plain = partsToPlainText(msg.parts);
  const hasStats = msg.durationMs != null || msg.totalTokens != null;
  const tps = msg.completionTokens && msg.durationMs && msg.durationMs > (msg.ttftMs ?? 0)
    ? msg.completionTokens / ((msg.durationMs - (msg.ttftMs ?? 0)) / 1000)
    : null;

  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 hidden shrink-0 sm:block"><ModelAvatar model={msg.model} size={30} /></div>
      <div className="min-w-0 flex-1">
        {rendered}
        {isStreaming && msg.parts.length === 0 && (
          <div className="flex items-center gap-2 py-1 text-[13px] text-tx3">
            <Spinner className="h-3.5 w-3.5" />{pendingLabel ?? '正在连接模型…'}
          </div>
        )}
        {msg.status === 'error' && msg.error && (
          <div className="my-2 flex items-start gap-2 rounded-lg border border-err/30 bg-err/8 px-3.5 py-2.5 text-[13px] leading-relaxed text-err">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{msg.error}</span>
          </div>
        )}
        {msg.status === 'stopped' && (
          <div className="my-1.5 flex items-center gap-1.5 text-xs text-tx3"><Ban size={12} />已停止生成</div>
        )}
        {!isStreaming && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tx3">
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <CopyBtn text={plain} />
              {onRegenerate && (
                <button title="重新生成" className={iconBtn} onClick={onRegenerate}>
                  <RefreshCw size={12} />
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
      </div>
    </div>
  );
});
