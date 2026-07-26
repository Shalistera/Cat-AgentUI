import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp, ChevronDown, ImagePlus, Loader2, Settings2, Square, Wrench, X,
} from 'lucide-react';
import { useMcp, useModels } from '../store';
import { uploadFile } from '../api';
import { toast, Toggle } from './ui';
import type { ModelInfo } from '../types';

function Popover({ trigger, children, open, setOpen, align = 'left' }: {
  trigger: ReactNode; children: ReactNode; open: boolean; setOpen(v: boolean): void; align?: 'left' | 'right';
}) {
  return (
    <div className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`fade-up absolute bottom-full z-50 mb-2 w-72 rounded-xl border border-line bg-bg1 p-1.5 shadow-2xl ${align === 'left' ? 'left-0' : 'right-0'}`}>
            {children}
          </div>
        </>
      )}
    </div>
  );
}

const pillBtn = 'flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-tx2 transition-colors hover:bg-bg2 hover:text-tx';

export interface PendingImage { uploadId: string; previewUrl: string }

interface ComposerProps {
  streaming: boolean;
  disabled?: boolean;
  model: ModelInfo | null;
  onModelChange(m: ModelInfo): void;
  mcpSelected: string[];
  onMcpChange(ids: string[]): void;
  settings: { systemPrompt: string; temperature: string; maxTokens: string };
  onSettingsChange(s: { systemPrompt: string; temperature: string; maxTokens: string }): void;
  onSend(text: string, images: PendingImage[]): void;
  onStop(): void;
  autoFocus?: boolean;
}

export function Composer(props: ComposerProps) {
  const { streaming, model } = props;
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const models = useModels((s) => s.models);
  const mcpServers = useMcp((s) => s.servers).filter((s) => s.enabled);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (props.autoFocus) taRef.current?.focus();
  }, [props.autoFocus]);

  function send() {
    const t = text.trim();
    if ((!t && images.length === 0) || streaming || props.disabled) return;
    props.onSend(t, images);
    setText('');
    setImages([]);
  }

  async function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 4 - images.length)) {
        const up = await uploadFile(f);
        setImages((prev) => [...prev, { uploadId: up.id, previewUrl: `/api/uploads/${up.id}/file` }]);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '上传失败', 'err');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const filteredModels = modelQuery.trim()
    ? models.filter((m) => `${m.displayName} ${m.modelId} ${m.providerName}`.toLowerCase().includes(modelQuery.toLowerCase()))
    : models;
  const chatModels = filteredModels.filter((m) => !m.imageGen);

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-line bg-bg1 shadow-lg transition-colors focus-within:border-line2">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img) => (
              <div key={img.uploadId} className="group relative">
                <img src={img.previewUrl} alt="" className="h-16 w-16 rounded-lg border border-line object-cover" />
                <button
                  className="absolute -right-1.5 -top-1.5 cursor-pointer rounded-full border border-line bg-bg2 p-0.5 text-tx2 opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                  onClick={() => setImages(images.filter((x) => x.uploadId !== img.uploadId))}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {uploading && <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-line"><Loader2 size={16} className="animate-spin text-tx3" /></div>}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={props.disabled ? '管理员尚未配置模型' : '给黑猫留言… (Enter 发送,Shift+Enter 换行)'}
          disabled={props.disabled}
          className="max-h-[220px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed text-tx outline-none placeholder:text-tx3"
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          {/* model picker */}
          <Popover open={modelOpen} setOpen={setModelOpen} trigger={
            <button className={pillBtn} title="选择模型">
              <span className="max-w-[160px] truncate font-medium text-tx">
                {model ? model.displayName : '选择模型'}
              </span>
              <ChevronDown size={12} />
            </button>
          }>
            {models.length > 8 && (
              <input
                autoFocus value={modelQuery} onChange={(e) => setModelQuery(e.target.value)}
                placeholder="搜索模型…"
                className="mb-1 w-full rounded-lg bg-bg2 px-2.5 py-1.5 text-xs text-tx outline-none placeholder:text-tx3"
              />
            )}
            <div className="max-h-72 overflow-y-auto">
              {chatModels.map((m) => (
                <button key={m.id}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-bg2 ${m.id === model?.id ? 'bg-bg2' : ''}`}
                  onClick={() => { props.onModelChange(m); setModelOpen(false); setModelQuery(''); }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-tx">{m.displayName}</span>
                    <span className="block truncate text-[10px] text-tx3">{m.providerName}{m.vision ? ' · 视觉' : ''}{m.tools ? ' · 工具' : ''}</span>
                  </span>
                  {m.id === model?.id && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-acc" />}
                </button>
              ))}
              {chatModels.length === 0 && <p className="px-2.5 py-3 text-center text-xs text-tx3">没有可用模型</p>}
            </div>
          </Popover>

          {/* mcp tools */}
          {mcpServers.length > 0 && model?.tools && (
            <Popover open={mcpOpen} setOpen={setMcpOpen} trigger={
              <button className={`${pillBtn} ${props.mcpSelected.length ? 'text-acc' : ''}`} title="MCP 工具">
                <Wrench size={13} />
                {props.mcpSelected.length > 0 && <span className="text-[10px] font-semibold">{props.mcpSelected.length}</span>}
              </button>
            }>
              <div className="px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-tx3">MCP 工具服务器</div>
              {mcpServers.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-bg2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-tx">{s.name}</div>
                    <div className="text-[10px] text-tx3">{s.toolCount} 个工具{s.lastStatus === 'error' ? ' · 上次连接失败' : ''}</div>
                  </div>
                  <Toggle
                    checked={props.mcpSelected.includes(s.id)}
                    onChange={(v) => props.onMcpChange(v
                      ? [...props.mcpSelected, s.id]
                      : props.mcpSelected.filter((x) => x !== s.id))}
                  />
                </div>
              ))}
            </Popover>
          )}

          {/* chat settings */}
          <Popover open={cfgOpen} setOpen={setCfgOpen} trigger={
            <button className={pillBtn} title="对话设置"><Settings2 size={13} /></button>
          }>
            <div className="space-y-3 p-2">
              <label className="block">
                <div className="mb-1 text-[11px] font-medium text-tx2">系统提示词</div>
                <textarea
                  rows={4}
                  value={props.settings.systemPrompt}
                  onChange={(e) => props.onSettingsChange({ ...props.settings, systemPrompt: e.target.value })}
                  placeholder="设定 AI 的角色与行为…"
                  className="w-full resize-y rounded-lg border border-line bg-bg2 px-2.5 py-2 text-xs text-tx outline-none placeholder:text-tx3 focus:border-acc/50"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <div className="mb-1 text-[11px] font-medium text-tx2">温度 (0-2)</div>
                  <input
                    value={props.settings.temperature}
                    onChange={(e) => props.onSettingsChange({ ...props.settings, temperature: e.target.value })}
                    placeholder="默认" inputMode="decimal"
                    className="w-full rounded-lg border border-line bg-bg2 px-2.5 py-1.5 text-xs text-tx outline-none placeholder:text-tx3 focus:border-acc/50"
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-[11px] font-medium text-tx2">最大输出 tokens</div>
                  <input
                    value={props.settings.maxTokens}
                    onChange={(e) => props.onSettingsChange({ ...props.settings, maxTokens: e.target.value })}
                    placeholder="默认" inputMode="numeric"
                    className="w-full rounded-lg border border-line bg-bg2 px-2.5 py-1.5 text-xs text-tx outline-none placeholder:text-tx3 focus:border-acc/50"
                  />
                </label>
              </div>
              <p className="text-[10px] leading-relaxed text-tx3">修改将在下一条消息生效,并保存到当前对话。</p>
            </div>
          </Popover>

          {/* attach images */}
          {model?.vision && (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
                onChange={(e) => pickFiles(e.target.files)} />
              <button className={pillBtn} title="添加图片" onClick={() => fileRef.current?.click()}
                disabled={images.length >= 4}>
                <ImagePlus size={14} />
              </button>
            </>
          )}

          <div className="flex-1" />

          {streaming ? (
            <button
              title="停止生成"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-tx text-bg0 transition-transform hover:scale-105"
              onClick={props.onStop}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              title="发送"
              disabled={(!text.trim() && images.length === 0) || props.disabled}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-acc text-accfg transition-all hover:bg-acc2 disabled:opacity-35"
              onClick={send}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
