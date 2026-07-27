import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp, ChevronDown, ImagePlus, Loader2, Settings2, Square, Wrench, X,
} from 'lucide-react';
import { useMcp, useModels } from '../store';
import { uploadFile } from '../api';
import { toast, Toggle } from './ui';
import type { ModelInfo } from '../types';

function Popover({ trigger, children, open, setOpen, align = 'left', width = 'w-80' }: {
  trigger: ReactNode; children: ReactNode; open: boolean; setOpen(v: boolean): void;
  align?: 'left' | 'right'; width?: string;
}) {
  return (
    <div className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`fade-up absolute bottom-full z-50 mb-2 ${width} overflow-hidden rounded-lg border border-line bg-bg1 shadow-lg ${align === 'left' ? 'left-0' : 'right-0'}`}>
            {children}
          </div>
        </>
      )}
    </div>
  );
}

const toolBtn = 'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-tx2 transition-colors hover:border-line hover:bg-bg2 hover:text-tx disabled:opacity-40 disabled:pointer-events-none';

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
  const imageModels = filteredModels.filter((m) => m.imageGen);
  const imageMode = !!model?.imageGen;

  const modelRow = (m: ModelInfo) => (
    <button key={m.id}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg2 ${m.id === model?.id ? 'bg-bg2' : ''}`}
      onClick={() => { props.onModelChange(m); setModelOpen(false); setModelQuery(''); }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-tx">{m.displayName}</span>
        <span className="block truncate text-[11px] text-tx3">
          {m.providerName}{m.imageGen ? ' · 生图' : ''}{m.vision ? ' · 视觉' : ''}{m.tools ? ' · 工具' : ''}
        </span>
      </span>
      {m.id === model?.id && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-acc" />}
    </button>
  );

  const groupHead = (label: string) => (
    <div className="eyebrow border-b border-line bg-bg2/60 px-3 py-1.5">{label}</div>
  );

  const popField = 'w-full rounded-md border border-field bg-bg1 px-2.5 py-1.5 text-xs text-tx placeholder:text-tx3 transition-colors hover:border-tx3';

  return (
    <div className="w-full">
      <div className="overflow-hidden rounded-xl border border-line2 bg-bg1 shadow-md transition-colors focus-within:border-acc">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-line px-3 py-3">
            {images.map((img) => (
              <div key={img.uploadId} className="group relative">
                <img src={img.previewUrl} alt="" className="h-16 w-16 rounded-md border border-line object-cover" />
                <button
                  title="移除图片"
                  className="absolute -right-1.5 -top-1.5 cursor-pointer rounded-full border border-line bg-bg1 p-0.5 text-tx2 opacity-0 shadow-sm transition-opacity hover:text-err group-hover:opacity-100"
                  onClick={() => setImages(images.filter((x) => x.uploadId !== img.uploadId))}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-line2">
                <Loader2 size={16} className="animate-spin text-tx3" />
              </div>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={props.disabled ? '管理员尚未配置模型'
            : imageMode ? '描述你想生成的画面…'
            : '输入消息,Enter 发送,Shift + Enter 换行'}
          disabled={props.disabled}
          className="max-h-[220px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed text-tx outline-none placeholder:text-tx3"
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

        {/* Tool rail sits on its own tinted band, separated by a hairline, so the
            typing area stays visually clean. */}
        <div className="flex items-center gap-1 border-t border-line bg-bg2/45 px-2 py-2">
          {/* model picker */}
          <Popover open={modelOpen} setOpen={setModelOpen} trigger={
            <button className={`${toolBtn} border-line bg-bg1`} title="选择模型">
              <span className="max-w-[170px] truncate text-tx">{model ? model.displayName : '选择模型'}</span>
              <ChevronDown size={12} className="text-tx3" />
            </button>
          }>
            {models.length > 8 && (
              <div className="border-b border-line p-2">
                <input
                  autoFocus value={modelQuery} onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="搜索模型…"
                  className={popField}
                />
              </div>
            )}
            <div className="max-h-72 overflow-y-auto">
              {imageModels.length > 0 && chatModels.length > 0 && groupHead('对话模型')}
              {chatModels.map(modelRow)}
              {imageModels.length > 0 && (
                <>
                  {chatModels.length > 0 && groupHead('绘图模型')}
                  {imageModels.map(modelRow)}
                  <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-tx3">
                    绘图模型会带着当前对话的上下文作图,可直接接着说「换成蓝色」。
                  </p>
                </>
              )}
              {filteredModels.length === 0 && <p className="px-3 py-4 text-center text-xs text-tx3">没有可用模型</p>}
            </div>
          </Popover>

          {/* mcp tools */}
          {mcpServers.length > 0 && model?.tools && !imageMode && (
            <Popover open={mcpOpen} setOpen={setMcpOpen} trigger={
              <button className={`${toolBtn} ${props.mcpSelected.length ? 'border-acc/40 bg-acc/10 text-acc hover:border-acc/40 hover:bg-acc/10 hover:text-acc' : ''}`} title="MCP 工具">
                <Wrench size={13} />
                工具
                {props.mcpSelected.length > 0 && <span className="font-semibold tabular-nums">{props.mcpSelected.length}</span>}
              </button>
            }>
              {groupHead('MCP 工具服务器')}
              <div className="max-h-72 overflow-y-auto">
                {mcpServers.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-bg2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-tx">{s.name}</div>
                      <div className="text-[11px] text-tx3">
                        {s.toolCount} 个工具{s.lastStatus === 'error' ? ' · 上次连接失败' : ''}
                      </div>
                    </div>
                    <Toggle
                      checked={props.mcpSelected.includes(s.id)}
                      onChange={(v) => props.onMcpChange(v
                        ? [...props.mcpSelected, s.id]
                        : props.mcpSelected.filter((x) => x !== s.id))}
                    />
                  </div>
                ))}
              </div>
            </Popover>
          )}

          {/* chat settings */}
          <Popover open={cfgOpen} setOpen={setCfgOpen} trigger={
            <button className={toolBtn} title="对话参数"><Settings2 size={13} />参数</button>
          }>
            {groupHead('对话参数')}
            <div className="space-y-3 p-3">
              <label className="block">
                <div className="mb-1.5 text-[11px] font-medium text-tx">系统提示词</div>
                <textarea
                  rows={4}
                  value={props.settings.systemPrompt}
                  onChange={(e) => props.onSettingsChange({ ...props.settings, systemPrompt: e.target.value })}
                  placeholder="设定 AI 的角色与行为…"
                  className={`${popField} resize-y leading-relaxed`}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <div className="mb-1.5 text-[11px] font-medium text-tx">温度 (0–2)</div>
                  <input
                    value={props.settings.temperature}
                    onChange={(e) => props.onSettingsChange({ ...props.settings, temperature: e.target.value })}
                    placeholder="默认" inputMode="decimal" className={popField}
                  />
                </label>
                <label className="block">
                  <div className="mb-1.5 text-[11px] font-medium text-tx">最大输出 tokens</div>
                  <input
                    value={props.settings.maxTokens}
                    onChange={(e) => props.onSettingsChange({ ...props.settings, maxTokens: e.target.value })}
                    placeholder="默认" inputMode="numeric" className={popField}
                  />
                </label>
              </div>
              <p className="text-[11px] leading-relaxed text-tx3">修改将在下一条消息生效,并保存到当前对话。</p>
            </div>
          </Popover>

          {/* attach images — vision models read them, image models use them as references */}
          {(model?.vision || imageMode) && (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
                onChange={(e) => pickFiles(e.target.files)} />
              <button className={toolBtn} title={imageMode ? '添加参考图' : '添加图片'} onClick={() => fileRef.current?.click()}
                disabled={images.length >= 4}>
                <ImagePlus size={14} />图片
              </button>
            </>
          )}

          <div className="flex-1" />

          {streaming ? (
            <button
              title="停止生成"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-line2 bg-bg1 text-tx shadow-xs transition-colors hover:bg-bg2"
              onClick={props.onStop}
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              title="发送消息"
              disabled={(!text.trim() && images.length === 0) || props.disabled}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md bg-pri text-prifg shadow-xs transition-colors hover:bg-pri2 disabled:opacity-30 disabled:pointer-events-none"
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
