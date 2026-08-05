import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ArrowUp, Check, ChevronDown, Gauge, Image as ImageIcon,
  Loader2, Plus, Search, Settings2, Square, Wrench, X,
} from 'lucide-react';
import { useMcp, useModels } from '../store';
import { uploadFile } from '../api';
import { ModelAvatar } from './ModelAvatar';
import { rampAt, ReasoningSlider } from './ReasoningSlider';
import { toast, Toggle } from './ui';
import type { ModelInfo, ReasoningEffort, ReasoningLevel } from '../types';

function Popover({ trigger, children, open, setOpen, align = 'left', width = 'w-80' }: {
  trigger: ReactNode; children: ReactNode; open: boolean; setOpen(v: boolean): void;
  align?: 'left' | 'right'; width?: string;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }

    function place() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const edge = 12;
      const gap = 8;
      const above = rect.top - edge - gap;
      const below = window.innerHeight - rect.bottom - edge - gap;
      const placeAbove = above >= 300 || above >= below;
      const maxHeight = Math.max(160, Math.min(placeAbove ? above : below, 544));
      const horizontal = align === 'right'
        ? { right: Math.max(edge, window.innerWidth - rect.right) }
        : { left: Math.max(edge, rect.left) };

      setPosition(placeAbove
        ? { ...horizontal, bottom: window.innerHeight - rect.top + gap, maxHeight }
        : { ...horizontal, top: rect.bottom + gap, maxHeight });
    }

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [align, open]);

  return (
    <div ref={anchorRef} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            style={position ?? { visibility: 'hidden' }}
            className={`fade-up fixed z-50 ${width} max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-line bg-bg1 shadow-lg`}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

const toolBtn = 'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-tx2 transition-colors hover:border-line hover:bg-bg2 hover:text-tx disabled:opacity-40 disabled:pointer-events-none';

// `off` is a real stop rather than an absence — Gemini needs an explicit zero
// budget to actually stop thinking. Everything above it comes from the model's
// ladder, where each level carries both the name the vendor receives and the
// one worth showing a person.
const OFF_LEVEL: ReasoningLevel = { value: 'off', label: '关闭' };
type ModelPanelView = 'models' | 'settings';
type ModelKind = 'all' | 'chat' | 'image';

// The ladder is admin-defined, so the only thing we can say about a rung is
// where it sits on it — which is also the part a person actually wants to know.
function effortHint(idx: number, total: number) {
  if (idx === 0) return '不额外思考，回答最快';
  if (idx === total - 1) return '思考最久，适合复杂推理';
  return '边想边答，兼顾速度与深度';
}

export interface PendingImage { uploadId: string; previewUrl: string }

export interface ComposerSettings {
  systemPrompt: string;
  reasoningEffort: ReasoningEffort;
}

interface ComposerProps {
  streaming: boolean;
  disabled?: boolean;
  model: ModelInfo | null;
  onModelChange(m: ModelInfo): void;
  mcpSelected: string[];
  onMcpChange(ids: string[]): void;
  settings: ComposerSettings;
  onSettingsChange(s: ComposerSettings): void;
  onSend(text: string, images: PendingImage[]): void;
  onStop(): void;
  autoFocus?: boolean;
}

export function Composer(props: ComposerProps) {
  const { streaming, model } = props;
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelView, setPanelView] = useState<ModelPanelView>('models');
  const [modelKind, setModelKind] = useState<ModelKind>('all');
  const [mcpOpen, setMcpOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
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

  useEffect(() => {
    if (panelOpen) return;
    setPanelView('models');
    setModelKind('all');
    setModelQuery('');
  }, [panelOpen]);

  function send() {
    const t = text.trim();
    if ((!t && images.length === 0) || streaming || props.disabled) return;
    props.onSend(t, images);
    setText('');
    setImages([]);
  }

  async function pickFiles(files: FileList | File[] | null) {
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

  const searchedModels = modelQuery.trim()
    ? models.filter((m) => `${m.displayName} ${m.modelId} ${m.providerName} ${
      m.imageGen ? '绘图 生图 image' : '对话 chat'
    } ${m.vision ? '视觉 vision' : ''} ${m.tools ? '工具 tools' : ''}`.toLowerCase().includes(modelQuery.toLowerCase()))
    : models;
  const filteredModels = searchedModels.filter((m) => (
    modelKind === 'all' || (modelKind === 'image' ? m.imageGen : !m.imageGen)
  ));
  const chatModels = filteredModels.filter((m) => !m.imageGen);
  const imageModels = filteredModels.filter((m) => m.imageGen);
  const imageMode = !!model?.imageGen;
  const canAttach = model?.vision || imageMode;

  const efforts: ReasoningLevel[] = [OFF_LEVEL, ...(model?.reasoningLevels ?? [])];
  // A level the current model does not offer falls back to the off stop instead
  // of leaving the slider pointing at nothing.
  const effortIdx = Math.max(0, efforts.findIndex((e) => e.value === (props.settings.reasoningEffort || OFF_LEVEL.value)));
  const effort = efforts[effortIdx];
  const thinking = efforts.length > 1 && effort.value !== OFF_LEVEL.value;
  const effortTint = rampAt(efforts.length > 1 ? effortIdx / (efforts.length - 1) : 0);

  function setReasoningEffort(next: ReasoningLevel) {
    props.onSettingsChange({ ...props.settings, reasoningEffort: next.value });
  }

  function modelHint(m: ModelInfo) {
    const capabilities = [
      m.imageGen ? '图像生成' : '对话',
      m.vision ? '视觉理解' : '',
      m.tools ? '工具调用' : '',
      m.reasoningLevels.length ? '可调推理强度' : '',
    ].filter(Boolean).join(' · ');
    return `${m.displayName}\n模型 ID：${m.modelId}\n服务商：${m.providerName}\n能力：${capabilities}`;
  }

  const modelRow = (m: ModelInfo) => (
    <button key={m.id}
      title={modelHint(m)}
      className={`group flex w-full cursor-pointer items-center gap-2.5 border-b border-line/70 px-3 py-2 text-left text-xs transition-colors last:border-b-0 hover:bg-bg2 ${m.id === model?.id ? 'bg-acc/10' : ''}`}
      onClick={() => { props.onModelChange(m); setModelQuery(''); setPanelOpen(false); }}
    >
      <ModelAvatar info={m} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-tx">{m.displayName}</span>
        <span className="mt-0.5 block truncate text-[10px] text-tx3">
          {m.providerName} · {m.modelId}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-tx3">
        {m.imageGen && <ImageIcon size={12} aria-label="图像生成" />}
        {m.vision && !m.imageGen && <span className="rounded bg-bg3 px-1 py-0.5 text-[9px] font-medium">视觉</span>}
        {m.tools && !m.imageGen && <Wrench size={11} aria-label="工具调用" />}
      </span>
      {m.id === model?.id && <Check size={14} className="shrink-0 text-acc" />}
    </button>
  );

  const groupHead = (label: string) => (
    <div className="eyebrow border-y border-line bg-bg2/60 px-3 py-1.5">{label}</div>
  );

  const popField = 'w-full rounded-md border border-field bg-bg1 px-2.5 py-1.5 text-xs text-tx placeholder:text-tx3 transition-colors hover:border-tx3';

  return (
    <div className="w-full">
      {/* No `overflow-hidden` here: it clipped every popover to the width of the
          composer. The inner bands round their own corners instead. */}
      <div className="rounded-xl border border-line2 bg-bg1 shadow-md transition-[border-color,box-shadow] focus-within:border-tx3 focus-within:shadow-lg">
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
          className="max-h-[220px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed text-tx outline-none focus-visible:outline-none placeholder:text-tx3"
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
            if (!files.length || !canAttach || images.length >= 4) return;
            e.preventDefault();
            void pickFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
              e.preventDefault();
              send();
            }
          }}
        />

        <div className="flex items-center gap-1 rounded-b-xl border-t border-line bg-bg2/45 px-2 py-2">
          {/* left: attachments, then tools */}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
            onChange={(e) => pickFiles(e.target.files)} />
          <button
            className={toolBtn}
            title={canAttach ? (imageMode ? '添加参考图' : '添加附件') : '当前模型不支持读图'}
            onClick={() => fileRef.current?.click()}
            disabled={!canAttach || images.length >= 4}
          >
            <Plus size={15} />
          </button>

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

          <div className="flex-1" />

          {/* Model selection stays primary; lower-frequency controls live in
              their own secondary views inside the same anchored popover. */}
          <Popover open={panelOpen} setOpen={setPanelOpen} align="right" width="w-[22rem]" trigger={
            <button
              className={`${toolBtn} border-line bg-bg1 pl-1.5`}
              title="选择模型"
            >
              {model && <ModelAvatar info={model} size={16} tile={false} />}
              <span className="max-w-[150px] truncate text-tx">{model ? model.displayName : '选择模型'}</span>
              <ChevronDown size={12} className="text-tx3" />
            </button>
          }>
            <div className="flex min-h-0 flex-col" style={{ maxHeight: 'inherit' }}>
              {panelView === 'models' && (
                <>
                  <div className="flex shrink-0 items-center gap-1.5 border-b border-line p-2">
                    <label className="relative min-w-0 flex-1">
                      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
                      <input
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        aria-label="搜索模型"
                        placeholder="搜索名称、ID 或服务商…"
                        className={`${popField} pl-8`}
                      />
                    </label>
                    <button
                      type="button"
                      title="其他设置"
                      aria-label="打开其他设置"
                      onClick={() => setPanelView('settings')}
                      className="relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line text-tx2 transition-colors hover:border-field hover:bg-bg2 hover:text-tx"
                    >
                      <Settings2 size={15} />
                      {props.settings.systemPrompt && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accs" />}
                    </button>
                  </div>

                  <div className="flex shrink-0 items-center gap-1 border-b border-line bg-bg2/45 px-2 py-1.5">
                    {([
                      ['all', '全部', searchedModels.length],
                      ['chat', '对话', searchedModels.filter((m) => !m.imageGen).length],
                      ['image', '绘图', searchedModels.filter((m) => m.imageGen).length],
                    ] as const).map(([value, label, count]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={modelKind === value}
                        onClick={() => setModelKind(value)}
                        className={`cursor-pointer rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                          modelKind === value ? 'bg-bg1 text-tx shadow-xs' : 'text-tx3 hover:text-tx'
                        }`}
                      >
                        {label} <span className="tabular-nums opacity-65">{count}</span>
                      </button>
                    ))}
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {chatModels.length > 0 && imageModels.length > 0 && groupHead('对话模型')}
                    {chatModels.map(modelRow)}
                    {imageModels.length > 0 && (
                      <>
                        {chatModels.length > 0 && groupHead('绘图模型')}
                        {imageModels.map(modelRow)}
                      </>
                    )}
                    {filteredModels.length === 0 && (
                      <div className="px-3 py-8 text-center">
                        <Search size={18} className="mx-auto mb-2 text-tx3" />
                        <p className="text-xs font-medium text-tx2">没有匹配的模型</p>
                        <p className="mt-1 text-[10px] text-tx3">换个名称、模型 ID 或服务商试试</p>
                      </div>
                    )}
                  </div>

                </>
              )}

              {panelView === 'settings' && (
                <>
                  <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
                    <button
                      type="button"
                      title="返回模型列表"
                      aria-label="返回模型列表"
                      onClick={() => setPanelView('models')}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg2 hover:text-tx"
                    >
                      <ArrowLeft size={15} />
                    </button>
                    <Settings2 size={15} className="text-tx2" />
                    <span className="text-xs font-semibold text-tx">其他设置</span>
                  </div>
                  <div className="overflow-y-auto p-3">
                    <label className="block">
                      <div className="mb-1.5 text-[11px] font-semibold text-tx">系统提示词</div>
                      <textarea
                        rows={6}
                        value={props.settings.systemPrompt}
                        onChange={(e) => props.onSettingsChange({ ...props.settings, systemPrompt: e.target.value })}
                        placeholder="设定 AI 的角色与行为…"
                        className={`${popField} min-h-28 resize-y leading-relaxed`}
                      />
                    </label>
                  </div>
                </>
              )}
            </div>
          </Popover>

          {/* Thinking effort lives beside the model button, not buried inside
              its panel: picking a model closes the panel, so anything pinned in
              there was invisible by the time you'd want it. `key` remounts the
              button on model switch, replaying the fade so the control
              announces itself exactly when a thinking-capable model arrives. */}
          {efforts.length > 1 && (
            <Popover key={model?.id} open={effortOpen} setOpen={setEffortOpen} align="right" width="w-80" trigger={
              <button
                className={`${toolBtn} fade-up border-line bg-bg1`}
                title={`思考强度：${effort.label}`}
                style={thinking ? {
                  color: `rgb(${effortTint})`,
                  borderColor: `rgb(${effortTint} / 0.45)`,
                  background: `rgb(${effortTint} / 0.09)`,
                } : undefined}
              >
                <Gauge size={14} className="shrink-0" />
                <span className="max-w-[4.5rem] truncate">{thinking ? effort.label : '思考强度'}</span>
              </button>
            }>
              <div className="flex items-center gap-1.5 border-b border-line bg-bg2/45 px-3 py-2">
                <Gauge size={14} className="shrink-0" style={{ color: `rgb(${effortTint})` }} />
                <span className="text-xs font-semibold text-tx">思考强度</span>
                <span className="flex-1" />
                <span
                  className={`max-w-[8rem] truncate rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                    thinking ? 'text-white shadow-xs' : 'border border-line2 bg-bg1 text-tx2'
                  }`}
                  style={thinking ? { background: `rgb(${effortTint})` } : undefined}
                >
                  {effort.label}
                </span>
              </div>
              <div className="px-3 pb-2.5 pt-2">
                <ReasoningSlider
                  levels={efforts}
                  index={effortIdx}
                  onChange={(i) => setReasoningEffort(efforts[i])}
                />
                <p className="mt-1 text-[10px] leading-4 text-tx3">{effortHint(effortIdx, efforts.length)}</p>
              </div>
            </Popover>
          )}

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
