import { memo, useMemo, useState } from 'react';
import {
  BrainCircuit, Check, ChevronDown, ChevronRight, Copy, Clock, Pencil,
  RefreshCw, Wrench, Zap, CircleAlert, Ban,
} from 'lucide-react';
import type { Message, MessagePart } from '../types';
import { fmtDuration, fmtTokens } from '../api';
import { Markdown } from './Markdown';
import { CatLogo } from './Logo';
import { Spinner } from './ui';

function CopyBtn({ text, size = 12 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="复制"
      className="cursor-pointer rounded p-1 text-tx3 transition-colors hover:bg-bg2 hover:text-tx"
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      })}
    >
      {copied ? <Check size={size} className="text-ok" /> : <Copy size={size} />}
    </button>
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const show = open || streaming;
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-line bg-bg1/60">
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs text-tx2 transition-colors hover:bg-bg2/60"
        onClick={() => setOpen(!show)}
      >
        <BrainCircuit size={13} className={streaming ? 'animate-pulse text-acc' : 'text-tx3'} />
        <span className="font-medium">{streaming ? '正在思考…' : '思考过程'}</span>
        {show ? <ChevronDown size={12} className="ml-auto" /> : <ChevronRight size={12} className="ml-auto" />}
      </button>
      {show && (
        <div className="max-h-64 overflow-y-auto border-t border-line px-3.5 py-2.5 text-[13px] leading-relaxed text-tx2 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
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
    <div className="my-2 overflow-hidden rounded-xl border border-line bg-bg1/60">
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-bg2/60"
        onClick={() => setOpen(!open)}
      >
        <Wrench size={13} className={!result ? 'animate-pulse text-acc' : result.isError ? 'text-err' : 'text-ok'} />
        <span className="font-mono font-medium text-tx2">{call.name}</span>
        {!result && <span className="flex items-center gap-1.5 text-tx3"><Spinner className="h-3 w-3" />调用中…</span>}
        {result?.isError && <span className="text-err">失败</span>}
        {open ? <ChevronDown size={12} className="ml-auto text-tx3" /> : <ChevronRight size={12} className="ml-auto text-tx3" />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3.5 py-2.5">
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-tx3">参数</div>
            <pre className="max-h-40 overflow-auto rounded-lg bg-bg2 p-2 font-mono text-[11px] leading-relaxed text-tx2">{prettyArgs}</pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-tx3">结果</div>
              <pre className={`max-h-64 overflow-auto rounded-lg bg-bg2 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap ${result.isError ? 'text-err' : 'text-tx2'}`}>{result.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function partsToPlainText(parts: MessagePart[]): string {
  return parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
}

interface Props {
  msg: Message;
  isStreaming: boolean; // this message is currently being generated
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
}

export const ChatMessage = memo(function ChatMessage({ msg, isStreaming, onRegenerate, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (msg.role === 'user') {
    const text = partsToPlainText(msg.parts);
    const images = msg.parts.filter((p) => p.type === 'image');
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((p, i) => p.type === 'image' && p.uploadId && (
              <img key={i} src={`/api/uploads/${p.uploadId}/file`} alt=""
                className="max-h-40 rounded-xl border border-line object-cover" />
            ))}
          </div>
        )}
        {editing ? (
          <div className="w-full max-w-[85%]">
            <textarea
              className="w-full resize-y rounded-xl border border-acc/50 bg-bg1 px-3.5 py-2.5 text-[15px] text-tx outline-none focus:ring-2 focus:ring-acc/15"
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            />
            <div className="mt-1.5 flex justify-end gap-2 text-xs">
              <button className="cursor-pointer rounded-lg px-3 py-1.5 text-tx2 hover:bg-bg2" onClick={() => setEditing(false)}>取消</button>
              <button className="cursor-pointer rounded-lg bg-acc px-3 py-1.5 font-medium text-accfg hover:bg-acc2"
                onClick={() => { setEditing(false); if (draft.trim()) onEdit?.(draft.trim()); }}>
                发送
              </button>
            </div>
          </div>
        ) : (
          text && (
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bg2 px-4 py-2.5 text-[15px] leading-relaxed">
              {text}
            </div>
          )
        )}
        {!editing && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <CopyBtn text={text} />
            {onEdit && (
              <button title="编辑并重新发送" className="cursor-pointer rounded p-1 text-tx3 hover:bg-bg2 hover:text-tx"
                onClick={() => { setDraft(text); setEditing(true); }}>
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
    }
  });

  const plain = partsToPlainText(msg.parts);
  const hasStats = msg.durationMs != null || msg.totalTokens != null;
  const tps = msg.completionTokens && msg.durationMs && msg.durationMs > (msg.ttftMs ?? 0)
    ? msg.completionTokens / ((msg.durationMs - (msg.ttftMs ?? 0)) / 1000)
    : null;

  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 hidden h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-line bg-bg1 sm:flex">
        <CatLogo size={20} />
      </div>
      <div className="min-w-0 flex-1">
        {rendered}
        {isStreaming && msg.parts.length === 0 && (
          <div className="flex items-center gap-2 py-1 text-sm text-tx3">
            <Spinner className="h-3.5 w-3.5" />正在连接模型…
          </div>
        )}
        {msg.status === 'error' && msg.error && (
          <div className="my-2 flex items-start gap-2 rounded-xl border border-err/30 bg-err/8 px-3.5 py-2.5 text-[13px] text-err">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span className="break-all">{msg.error}</span>
          </div>
        )}
        {msg.status === 'stopped' && (
          <div className="my-1.5 flex items-center gap-1.5 text-xs text-tx3"><Ban size={12} />已停止生成</div>
        )}
        {!isStreaming && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tx3">
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyBtn text={plain} />
              {onRegenerate && (
                <button title="重新生成" className="cursor-pointer rounded p-1 text-tx3 hover:bg-bg2 hover:text-tx" onClick={onRegenerate}>
                  <RefreshCw size={12} />
                </button>
              )}
            </span>
            {msg.model && <span className="font-mono">{msg.model}</span>}
            {hasStats && (
              <>
                <span className="flex items-center gap-1" title="总耗时"><Clock size={11} />{fmtDuration(msg.durationMs)}</span>
                {msg.ttftMs != null && (
                  <span className="flex items-center gap-1" title="首字延迟"><Zap size={11} />{fmtDuration(msg.ttftMs)}</span>
                )}
                {msg.totalTokens != null && msg.totalTokens > 0 && (
                  <span title={`输入 ${msg.promptTokens ?? '?'} tokens · 输出 ${msg.completionTokens ?? '?'} tokens`}>
                    ↑{fmtTokens(msg.promptTokens)} ↓{fmtTokens(msg.completionTokens)} · 共 {fmtTokens(msg.totalTokens)} tokens
                  </span>
                )}
                {tps != null && tps > 0 && <span title="输出速度">{tps.toFixed(1)} tok/s</span>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
