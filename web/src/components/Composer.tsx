import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowUp, Check, ChevronDown, FileText, Gauge, Globe, Image as ImageIcon,
  ListPlus, Loader2, Mic, Paperclip, Plus, RotateCcw, Search, Settings2, Square, Star, Wrench, X,
} from 'lucide-react';
import { useAuth, useMcp, useModels, useUi, useComposerInsert } from '../store';
import { api, errMsg, uploadFile } from '../api';
import { ModelAvatar } from './ModelAvatar';
import { rampAt, rampTextAt, ReasoningSlider } from './ReasoningSlider';
import { SortableList } from './SortableList';
import { Button, Field, Popover, toast, Toggle } from './ui';
import { sttSupported, startDictation, type SpeechRecognitionLike } from '../speech';
import type { ModelInfo, ReasoningEffort, ReasoningLevel, User } from '../types';

/* Active tool buttons build their palette on top of the colourless shape base,
   never on `toolBtn`: stacking `text-accfg` after `text-tx2` leaves the winner
   to Tailwind's stylesheet order, which is how the 联网 on-state ended up grey
   on cobalt in both themes. */
const toolBtnShape = 'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none';
const toolBtn = `${toolBtnShape} border-transparent text-tx2 hover:border-line hover:bg-bg2 hover:text-tx`;

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

export interface PendingAttachment {
  uploadId: string;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  previewUrl?: string; // images only
}

// Broad but honest: the server accepts any UTF-8 text file, so the picker
// lists the common ones and drag-and-drop covers the rest.
const FILE_ACCEPT = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
  '.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.yaml', '.yml', '.xml', '.html', '.log', '.py', '.js', '.ts', '.tsx', '.jsx',
  '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.sql', '.toml', '.ini',
].join(',');

const isImageFile = (f: File) => f.type.startsWith('image/');
const isPdfFile = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

export interface ComposerSettings {
  systemPrompt: string;
  reasoningEffort: ReasoningEffort;
}

// ---- draft autosave ----
// Unsent input (text + attachment refs) is kept per draftKey in localStorage,
// so switching conversations or refreshing the page never loses a half-typed
// message. Attachment previews are rebuilt from the uploadId on restore.
const DRAFT_PREFIX = 'caui-draft:';

function loadDraft(key: string): { text: string; atts: PendingAttachment[] } {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return { text: '', atts: [] };
    const d = JSON.parse(raw) as { text?: unknown; atts?: unknown };
    const text = typeof d.text === 'string' ? d.text : '';
    const atts = (Array.isArray(d.atts) ? d.atts : [])
      .filter((a): a is PendingAttachment => !!a && typeof (a as PendingAttachment).uploadId === 'string')
      .map((a) => ({
        ...a,
        previewUrl: a.kind === 'image' ? `/api/uploads/${a.uploadId}/file` : undefined,
      }));
    return { text, atts };
  } catch { return { text: '', atts: [] }; }
}

function saveDraft(key: string, text: string, atts: PendingAttachment[]) {
  try {
    if (!text && atts.length === 0) {
      localStorage.removeItem(DRAFT_PREFIX + key);
    } else {
      const slim = atts.map(({ previewUrl: _p, ...rest }) => rest);
      localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ text, atts: slim, ts: Date.now() }));
    }
  } catch { /* storage full — drafts are best-effort */ }
}

function clearDraft(key: string) {
  try { localStorage.removeItem(DRAFT_PREFIX + key); } catch { /* ignore */ }
}

interface ComposerProps {
  streaming: boolean;
  disabled?: boolean;
  model: ModelInfo | null;
  onModelChange(m: ModelInfo): void;
  webSearch: boolean;
  onWebSearchChange(enabled: boolean): void;
  mcpSelected: string[];
  onMcpChange(ids: string[]): void;
  settings: ComposerSettings;
  onSettingsChange(s: ComposerSettings): void;
  onSend(text: string, attachments: PendingAttachment[]): void;
  /** Present = sends during generation queue up instead of being blocked. */
  onEnqueue?(text: string, attachments: PendingAttachment[]): void;
  onStop(): void;
  /** Persist unsent input under this key (per chat); omit to disable drafts. */
  draftKey?: string;
  autoFocus?: boolean;
  /** Mobile: fold to a single row (input + model name). Tapping the input
      calls onExpand; sending, or leaving an empty input, calls onCollapse. */
  compact?: boolean;
  onExpand?(): void;
  onCollapse?(): void;
}

export function Composer(props: ComposerProps) {
  const { streaming, model, compact = false } = props;
  const [text, setText] = useState('');

  // —— 语音输入 —— dictation is all in-browser (Chrome/Edge); the transcript
  // appends to whatever was already typed when the mic went live.
  const [listening, setListening] = useState(false);
  const dictationRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef('');
  function toggleDictation() {
    if (listening) { dictationRef.current?.stop(); return; }
    dictationBaseRef.current = text;
    const rec = startDictation(
      (t) => setText(dictationBaseRef.current + t),
      () => setListening(false),
    );
    if (!rec) { toast('当前浏览器不支持语音输入,请使用 Chrome / Edge', 'err'); return; }
    dictationRef.current = rec;
    setListening(true);
  }
  useEffect(() => () => { dictationRef.current?.stop(); }, []);
  const [atts, setAtts] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child the cursor crosses; only a
  // depth counter can tell "left the window" apart from "moved over a div".
  const dragDepth = useRef(0);
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
  const user = useAuth((s) => s.user);
  const dark = useUi((s) => s.theme) === 'dark';
  const mcpServers = useMcp((s) => s.servers).filter((s) => s.enabled);
  // Vertex Gemini exposes Google Search natively. The designated search MCP
  // remains a fallback for other providers; both share one provider-neutral
  // chat preference and one composer toggle.
  const searchServer = mcpServers.find((s) => s.isSearch) ?? null;
  const toolServers = mcpServers.filter((s) => !s.isSearch);
  const searchAvailable = !!model?.nativeSearch || (!!searchServer && !!model?.tools && !model.imageGen);
  const searchOn = props.webSearch;
  const toolCount = props.mcpSelected.filter((id) => id !== searchServer?.id).length;

  function toggleSearch() {
    if (!searchAvailable) return;
    props.onWebSearchChange(!searchOn);
  }

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [text, props.compact]);

  useEffect(() => {
    // A folded composer must not grab focus on mount: focusing is what unfolds it.
    if (props.autoFocus && !compact) taRef.current?.focus();
  }, [props.autoFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draft restore: switching draftKey swaps the input to that conversation's
  // saved draft. loadedDraftKeyRef gates the save effect so the OLD text can
  // never be written under the NEW key during the swap.
  const loadedDraftKeyRef = useRef<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!props.draftKey) { loadedDraftKeyRef.current = null; return; }
    const d = loadDraft(props.draftKey);
    setText(d.text);
    setAtts(d.atts);
    loadedDraftKeyRef.current = props.draftKey;
  }, [props.draftKey]);

  useEffect(() => {
    const key = props.draftKey;
    if (!key || loadedDraftKeyRef.current !== key) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft(key, text, atts), 300);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [text, atts, props.draftKey]);

  // 划词引用 etc.: append the published text under whatever is typed, unfold
  // a compact composer, and put the caret at the end ready to type the question.
  const insertPending = useComposerInsert((s) => s.pending);
  const consumeInsert = useComposerInsert((s) => s.consume);
  useEffect(() => {
    if (!insertPending) return;
    const add = insertPending.text;
    setText((cur) => {
      const base = cur.trimEnd();
      return base ? `${base}\n\n${add}` : add;
    });
    consumeInsert();
    props.onExpand?.();
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }, [insertPending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (panelOpen) return;
    setPanelView('models');
    setModelKind('all');
    setModelQuery('');
  }, [panelOpen]);

  function send() {
    const t = text.trim();
    if ((!t && atts.length === 0) || props.disabled) return;
    if (streaming) {
      // Generation in progress: queue the follow-up instead of dropping it.
      if (!props.onEnqueue) return;
      props.onEnqueue(t, atts);
    } else {
      props.onSend(t, atts);
    }
    setText('');
    setAtts([]);
    // Clear immediately — the debounced save must not race a navigation.
    if (props.draftKey) clearDraft(props.draftKey);
    taRef.current?.blur();
    props.onCollapse?.();
  }

  // Blur-to-collapse must not fire for taps inside the composer itself —
  // toolbar buttons steal focus before their click lands, and on iOS they
  // never become relatedTarget, so a capture-phase pointerdown flag is the
  // only reliable tell.
  const rootRef = useRef<HTMLDivElement>(null);
  const innerTap = useRef(false);
  function onTextBlur(e: FocusEvent<HTMLTextAreaElement>) {
    if (!props.onCollapse) return;
    if (innerTap.current || rootRef.current?.contains(e.relatedTarget as Node | null)) return;
    if (text.trim() || atts.length > 0 || uploading) return;
    props.onCollapse();
  }

  async function pickFiles(files: FileList | File[] | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      let room = 4 - atts.length;
      for (const f of Array.from(files)) {
        if (room <= 0) { toast('每条消息最多 4 个附件', 'err'); break; }
        // Per-file capability gate, so one wrong file in a batch doesn't
        // block the rest — each rejection says which file and why.
        if (imageMode && !isImageFile(f)) {
          toast(`「${f.name}」未添加:绘图模型只接受参考图片`, 'err');
          continue;
        }
        if ((isImageFile(f) || isPdfFile(f)) && !canAttachImages) {
          toast(`「${f.name}」未添加:当前模型不支持读取图片/PDF`, 'err');
          continue;
        }
        try {
          const up = await uploadFile(f);
          const kind = up.mime.startsWith('image/') ? 'image' : 'file';
          setAtts((prev) => [...prev, {
            uploadId: up.id,
            kind,
            name: f.name || (kind === 'image' ? '图片' : '文件'),
            mime: up.mime,
            previewUrl: kind === 'image' ? `/api/uploads/${up.id}/file` : undefined,
          }]);
          room--;
        } catch (e) {
          toast(`「${f.name}」${e instanceof Error ? e.message : '上传失败'}`, 'err');
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function removeAttachment(att: PendingAttachment) {
    setAtts((prev) => prev.filter((x) => x.uploadId !== att.uploadId));
    api.del(`/api/uploads/${att.uploadId}`).catch((e) => {
      toast(e instanceof Error ? e.message : '清理附件失败', 'err');
    });
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
  // Pictures and PDFs need a model that can see; text documents are flattened
  // to prompt text server-side, so every chat model takes them.
  const canAttachImages = !!model?.vision || imageMode;
  const canAttach = !props.disabled;
  const attachFull = atts.length >= 4;
  // Why the drop target can't take files right now — the overlay says it out
  // loud instead of silently swallowing the drop. Kind-specific limits are
  // enforced per file inside pickFiles.
  const dropBlocked = props.disabled ? '管理员尚未配置模型'
    : attachFull ? '最多添加 4 个附件' : null;
  const dropHint = imageMode
    ? { title: '松开鼠标，添加参考图', sub: '支持 PNG / JPEG / WebP / GIF，最多 4 张' }
    : canAttachImages
      ? { title: '松开鼠标，附件将随消息发送', sub: '支持图片、PDF、Word(docx)与各类文本文件，最多 4 个' }
      : { title: '松开鼠标，添加文档附件', sub: '当前模型不支持图片和 PDF；支持 txt / md / docx 等文本，最多 4 个' };

  // The whole window is the drop zone: listeners live on `window` so a file
  // dragged anywhere over the app raises the overlay, which in turn shows
  // where things will land. Only real file drags count — text selections and
  // in-app drags (model reordering) carry no 'Files' type.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const reset = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // never let the browser navigate to the dropped file
      reset();
      if (dropBlocked) return; // the overlay already explained why
      // Type/capability rules live per-file in pickFiles, which also lets the
      // server's content sniffing be the final word on odd files.
      void pickFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pickFiles is recreated per render
  }, [dropBlocked, atts.length]);

  // Personal model order: dragging a row rewrites the whole flat order and
  // saves it to the profile; the server then serves /api/models in that order
  // until 恢复默认 clears it. Search results are a lookup, not a ranking, so
  // dragging is off while a query is active.
  const customOrder = user?.settings.modelOrder;
  const hasCustomOrder = Array.isArray(customOrder) && customOrder.length > 0;
  const dragEnabled = !modelQuery.trim() && models.length > 1;
  const favoriteIds = Array.isArray(user?.settings.favoriteModels) ? user.settings.favoriteModels : [];
  const favSet = new Set(favoriteIds);

  // Starred rows sit above everything, keeping relative order inside each group.
  const hoistFavorites = (list: ModelInfo[], fav: Set<string>) => [
    ...list.filter((m) => fav.has(m.id)), ...list.filter((m) => !fav.has(m.id)),
  ];

  async function saveUserOrder(section: ModelInfo[]) {
    // The dragged section (chat or image rows, possibly kind-filtered) is a
    // subset of the flat list: permute its members in place, touch nothing
    // else. Favorites are re-hoisted so a drop can't fight the star pinning —
    // what we save is exactly what stays on screen.
    const ids = new Set(section.map((m) => m.id));
    let k = 0;
    const full = hoistFavorites(models.map((m) => (ids.has(m.id) ? section[k++] : m)), favSet);
    const prev = models;
    useModels.setState({ models: full }); // optimistic — a snap-back drop feels broken
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', {
        settings: { modelOrder: full.map((m) => m.id) },
      });
      useAuth.getState().setUser(r.user);
    } catch (e) {
      useModels.setState({ models: prev });
      toast(errMsg(e), 'err');
    }
  }

  async function toggleFavorite(m: ModelInfo) {
    if (!user) return;
    const next = favSet.has(m.id) ? favoriteIds.filter((id) => id !== m.id) : [...favoriteIds, m.id];
    const prevUser = user;
    const prevModels = models;
    // Optimistic: fill the star and hoist right away. Un-starring keeps the
    // row in place until the refetch below settles it back into its real slot.
    useAuth.getState().setUser({ ...user, settings: { ...user.settings, favoriteModels: next } });
    useModels.setState({ models: hoistFavorites(models, new Set(next)) });
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', {
        settings: { favoriteModels: next.length ? next : null },
      });
      useAuth.getState().setUser(r.user);
      await useModels.getState().load(true);
    } catch (e) {
      useAuth.getState().setUser(prevUser);
      useModels.setState({ models: prevModels });
      toast(errMsg(e), 'err');
    }
  }

  async function resetUserOrder() {
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { modelOrder: null } });
      useAuth.getState().setUser(r.user);
      await useModels.getState().load(true);
      toast('已恢复默认排序', 'ok');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  const efforts: ReasoningLevel[] = [OFF_LEVEL, ...(model?.reasoningLevels ?? [])];
  // A level the current model does not offer falls back to the off stop instead
  // of leaving the slider pointing at nothing.
  const effortIdx = Math.max(0, efforts.findIndex((e) => e.value === (props.settings.reasoningEffort || OFF_LEVEL.value)));
  const effort = efforts[effortIdx];
  const thinking = efforts.length > 1 && effort.value !== OFF_LEVEL.value;
  const effortRatio = efforts.length > 1 ? effortIdx / (efforts.length - 1) : 0;
  // Solid rail for grounds that carry white text; text rail for tinted
  // text/borders sitting on the page surface (lifted on dark).
  const effortTint = rampAt(effortRatio);
  const effortText = rampTextAt(effortRatio, dark);

  function setReasoningEffort(next: ReasoningLevel) {
    props.onSettingsChange({ ...props.settings, reasoningEffort: next.value });
  }

  function modelHint(m: ModelInfo) {
    const capabilities = [
      m.imageGen ? '图像生成' : '对话',
      m.vision ? '视觉理解' : '',
      m.tools ? '工具调用' : '',
      m.nativeSearch ? 'Vertex Google 搜索' : '',
      m.reasoningLevels.length ? '可调推理强度' : '',
    ].filter(Boolean).join(' · ');
    return `${m.displayName}\n模型 ID：${m.modelId}\n服务商：${m.providerName}\n能力：${capabilities}`;
  }

  const modelRow = (m: ModelInfo, handle?: ReactNode) => (
    <button key={m.id}
      title={modelHint(m)}
      className={`group flex w-full cursor-pointer items-center gap-2.5 border-b border-line/70 px-3 py-2 text-left text-xs transition-colors last:border-b-0 hover:bg-bg2 ${m.id === model?.id ? 'bg-acc/10' : ''}`}
      onClick={() => { props.onModelChange(m); setModelQuery(''); setPanelOpen(false); }}
    >
      {handle}
      <ModelAvatar info={m} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-tx">{m.displayName}</span>
        <span className="mt-0.5 block truncate text-[11px] text-tx3">
          {m.providerName} · {m.modelId}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-tx3">
        {m.imageGen && <ImageIcon size={12} aria-label="图像生成" />}
        {m.vision && !m.imageGen && <span className="rounded-sm bg-bg3 px-1 py-0.5 text-[9px] font-medium">视觉</span>}
        {m.tools && !m.imageGen && <Wrench size={11} aria-label="工具调用" />}
      </span>
      <span
        role="button"
        aria-label={favSet.has(m.id) ? '取消收藏' : '收藏'}
        aria-pressed={favSet.has(m.id)}
        title={favSet.has(m.id) ? '取消收藏' : '收藏:收藏的模型始终排在最前'}
        className={`-m-1 shrink-0 cursor-pointer p-1 transition-colors ${
          favSet.has(m.id) ? 'text-amber-400' : 'text-tx3/60 hover:text-amber-400'
        }`}
        onClick={(e) => { e.stopPropagation(); void toggleFavorite(m); }}
      >
        <Star size={13} className={favSet.has(m.id) ? 'fill-current' : undefined} />
      </span>
      {m.id === model?.id && <Check size={14} className="shrink-0 text-acc" />}
    </button>
  );

  const groupHead = (label: string) => (
    <div className="eyebrow border-y border-line bg-bg2/60 px-3 py-1.5">{label}</div>
  );

  const popField = 'w-full rounded-md border border-field bg-bg1 px-2.5 py-1.5 text-xs text-tx placeholder:text-tx3 transition-colors hover:border-tx3';

  return (
    <div
      ref={rootRef}
      className="w-full"
      onPointerDownCapture={() => {
        innerTap.current = true;
        setTimeout(() => { innerTap.current = false; }, 300);
      }}
    >
      {/* Raised the moment a file drag crosses the window: the scrim dims the
          page and one dashed card names the outcome, so there is no guessing
          where the image should be dropped — anywhere counts. */}
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6">
          <div className={`pointer-events-none flex flex-col items-center gap-2.5 rounded-2xl border-2 border-dashed bg-bg1 px-14 py-10 text-center shadow-lg ${
            dropBlocked ? 'border-err/60' : 'border-acc'
          }`}>
            <ImageIcon size={32} className={dropBlocked ? 'text-err' : 'text-acc'} />
            <p className="text-sm font-semibold text-tx">
              {dropBlocked ?? dropHint.title}
            </p>
            <p className="text-xs text-tx3">
              {dropBlocked ? '松开鼠标不会上传任何内容' : dropHint.sub}
            </p>
          </div>
        </div>
      )}
      {/* No `overflow-hidden` here: it clipped every popover to the width of the
          composer. The inner bands round their own corners instead. */}
      <div className={`rounded-xl border bg-bg1 shadow-md transition-[border-color,box-shadow] focus-within:shadow-lg ${
        dragging && !dropBlocked ? 'border-acc shadow-lg' : 'border-line2 focus-within:border-tx3'
      }`}>
        {(atts.length > 0 || uploading) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-3">
            {atts.map((att) => (
              <div key={att.uploadId} className="group relative">
                {att.kind === 'image' ? (
                  <img src={att.previewUrl} alt={att.name}
                    className="h-16 w-16 rounded-md border border-line object-cover" />
                ) : (
                  <div title={att.name}
                    className="flex h-16 max-w-52 items-center gap-2 rounded-md border border-line bg-bg2/60 px-3">
                    <FileText size={18} className="shrink-0 text-tx2" />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-tx">{att.name}</span>
                      <span className="block text-[10px] uppercase text-tx3">
                        {att.mime === 'application/pdf' ? 'PDF'
                          : att.mime.includes('wordprocessingml') ? 'DOCX'
                          : att.mime === 'text/markdown' ? 'MD' : '文本'}
                      </span>
                    </span>
                  </div>
                )}
                <button
                  title="移除附件"
                  className="absolute -right-1.5 -top-1.5 cursor-pointer rounded-full border border-line bg-bg1 p-0.5 text-tx2 opacity-0 shadow-sm transition-opacity hover:text-err group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={() => removeAttachment(att)}
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

        {/* Collapsed (mobile, after scrolling up): one row — the input plus the
            current model's name as a reminder. Focusing the input unfolds the
            full toolbar again. */}
        <div className={compact ? 'flex items-center gap-2 pr-3' : 'contents'}>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={props.disabled ? '管理员尚未配置模型'
            : compact ? '输入消息…'
            : imageMode ? '描述你想生成的画面…'
            : '输入消息,Enter 发送,Shift + Enter 换行'}
          disabled={props.disabled}
          className={`max-h-[220px] w-full resize-none bg-transparent px-4 text-[15px] leading-relaxed text-tx outline-none focus-visible:outline-none placeholder:text-tx3 ${
            compact ? 'min-w-0 flex-1 py-2.5' : 'pb-2 pt-3.5'}`}
          onFocus={() => { if (compact) props.onExpand?.(); }}
          onBlur={onTextBlur}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length || !canAttach || attachFull) return;
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

          {compact && model && (
            <button
              className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-tx2"
              title="展开输入区"
              onClick={() => {
                props.onExpand?.();
                // The picker's trigger lives in the toolbar that is about to
                // unhide; open it once it has a real position to anchor to.
                setTimeout(() => setPanelOpen(true), 0);
              }}
            >
              <ModelAvatar info={model} size={14} tile={false} />
              <span className="max-w-[6.5rem] truncate">{model.displayName}</span>
            </button>
          )}
          {/* The toolbar (and its stop button) is hidden while collapsed, but a
              reply in flight must stay stoppable without unfolding first. */}
          {compact && streaming && (
            <button
              title="停止生成"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line2 bg-bg1 text-tx shadow-xs transition-colors hover:bg-bg2"
              onClick={props.onStop}
            >
              <Square size={12} fill="currentColor" />
            </button>
          )}
        </div>

        <div className={`flex items-center gap-1 rounded-b-xl border-t border-line bg-bg2/45 px-2 py-2 ${compact ? 'hidden' : ''}`}>
          {/* left: attachments, then tools */}
          <input ref={fileRef} type="file" multiple hidden
            accept={imageMode ? 'image/png,image/jpeg,image/webp,image/gif' : FILE_ACCEPT}
            onChange={(e) => pickFiles(e.target.files)} />
          <button
            className={toolBtn}
            title={imageMode ? '添加参考图'
              : canAttachImages ? '添加附件:图片、PDF、Word(docx)或文本文件'
              : '添加文档附件(当前模型不支持图片/PDF)'}
            onClick={() => fileRef.current?.click()}
            disabled={!canAttach || attachFull}
          >
            {imageMode ? <Plus size={15} /> : <Paperclip size={14} />}
          </button>

          {searchAvailable && !imageMode && (
            <button
              aria-pressed={searchOn}
              /* On-state is a solid accs fill: a mere tint was routinely read
                 as "off". accs keeps white text AA in both themes. */
              className={searchOn
                ? `${toolBtnShape} border-accs bg-accs text-accfg shadow-xs hover:opacity-90`
                : toolBtn}
              title={searchOn
                ? model?.nativeSearch
                  ? '联网搜索已开启(Vertex AI 原生 Google Search):模型会按需搜索;与其他工具冲突时本轮优先其他工具'
                  : `联网搜索已开启(${searchServer?.name ?? 'MCP'}):模型会在需要时自行搜索,点击关闭`
                : '开启联网搜索:模型将在需要时自行决定是否搜索'}
              onClick={toggleSearch}
            >
              <Globe size={13} />
              <span className="max-sm:hidden">联网</span>
            </button>
          )}

          {toolServers.length > 0 && model?.tools && !imageMode && (
            <Popover open={mcpOpen} setOpen={setMcpOpen} trigger={
              <button className={toolCount ? `${toolBtnShape} border-acc/40 bg-acc/10 text-acc` : toolBtn} title="MCP 工具">
                <Wrench size={13} />
                <span className="max-sm:hidden">工具</span>
                {toolCount > 0 && <span className="font-semibold tabular-nums">{toolCount}</span>}
              </button>
            }>
              {groupHead('MCP 工具服务器')}
              <div className="max-h-72 overflow-y-auto">
                {toolServers.map((s) => (
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
              className={`${toolBtnShape} border-line bg-bg1 pl-1.5 text-tx2 hover:bg-bg2 hover:text-tx`}
              title="选择模型"
            >
              {model && <ModelAvatar info={model} size={16} tile={false} />}
              <span className="max-w-[150px] truncate text-tx max-sm:max-w-[76px]">{model ? model.displayName : '选择模型'}</span>
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
                      className="relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line2 text-tx2 transition-colors hover:border-field hover:bg-bg2 hover:text-tx"
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
                        className={`cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                          modelKind === value ? 'bg-bg1 text-tx shadow-xs' : 'text-tx3 hover:text-tx'
                        }`}
                      >
                        {label} <span className="tabular-nums opacity-65">{count}</span>
                      </button>
                    ))}
                    {hasCustomOrder && (
                      <button
                        type="button"
                        title="你拖动过模型顺序,点击恢复为管理员设置的默认排序"
                        onClick={() => void resetUserOrder()}
                        className="ml-auto flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-tx3 transition-colors hover:text-tx"
                      >
                        <RotateCcw size={11} />
                        恢复默认
                      </button>
                    )}
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {chatModels.length > 0 && imageModels.length > 0 && groupHead('对话模型')}
                    {dragEnabled
                      ? (
                        <SortableList items={chatModels} keyOf={(m) => m.id}
                          onReorder={(next) => void saveUserOrder(next)}
                          renderItem={(m, handle) => modelRow(m, handle)} />
                      )
                      : chatModels.map((m) => modelRow(m))}
                    {imageModels.length > 0 && (
                      <>
                        {chatModels.length > 0 && groupHead('绘图模型')}
                        {dragEnabled
                          ? (
                            <SortableList items={imageModels} keyOf={(m) => m.id}
                              onReorder={(next) => void saveUserOrder(next)}
                              renderItem={(m, handle) => modelRow(m, handle)} />
                          )
                          : imageModels.map((m) => modelRow(m))}
                      </>
                    )}
                    {filteredModels.length === 0 && (
                      <div className="px-3 py-8 text-center">
                        <Search size={18} className="mx-auto mb-2 text-tx3" />
                        <p className="text-xs font-medium text-tx2">没有匹配的模型</p>
                        <p className="mt-1 text-[11px] text-tx3">换个名称、模型 ID 或服务商试试</p>
                      </div>
                    )}
                  </div>

                </>
              )}

              {panelView === 'settings' && (
                <>
                  <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
                    <Button variant="ghost" size="iconSm" title="返回模型列表" aria-label="返回模型列表"
                      onClick={() => setPanelView('models')}>
                      <ArrowLeft size={15} />
                    </Button>
                    <Settings2 size={15} className="text-tx2" />
                    <span className="text-xs font-semibold text-tx">其他设置</span>
                  </div>
                  <div className="overflow-y-auto p-3">
                    <Field label="系统提示词">
                      <textarea
                        rows={6}
                        value={props.settings.systemPrompt}
                        onChange={(e) => props.onSettingsChange({ ...props.settings, systemPrompt: e.target.value })}
                        placeholder="设定 AI 的角色与行为…"
                        className={`${popField} min-h-28 resize-y leading-relaxed`}
                      />
                    </Field>
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
                className={`${toolBtnShape} fade-up border-line bg-bg1 text-tx2 hover:bg-bg2 hover:text-tx`}
                title={`思考强度：${effort.label}`}
                style={thinking ? {
                  color: `rgb(${effortText})`,
                  borderColor: `rgb(${effortText} / 0.45)`,
                  background: `rgb(${effortText} / 0.09)`,
                } : undefined}
              >
                <Gauge size={14} className="shrink-0" />
                <span className="max-w-[4.5rem] truncate max-sm:hidden">{thinking ? effort.label : '思考强度'}</span>
              </button>
            }>
              <div className="flex items-center gap-1.5 border-b border-line bg-bg2/45 px-3 py-2">
                <Gauge size={14} className="shrink-0" style={{ color: `rgb(${effortText})` }} />
                <span className="text-xs font-semibold text-tx">思考强度</span>
                <span className="flex-1" />
                <span
                  className={`max-w-[8rem] truncate rounded-md px-2 py-0.5 text-[11px] font-semibold ${
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
                <p className="mt-1 text-[11px] leading-4 text-tx3">{effortHint(effortIdx, efforts.length)}</p>
              </div>
            </Popover>
          )}

          {sttSupported() && !props.disabled && (
            <button
              title={listening ? '停止语音输入' : '语音输入(浏览器本地识别,无服务器开销)'}
              className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border shadow-xs transition-colors ${
                listening
                  ? 'animate-pulse border-err/40 bg-err/10 text-err'
                  : 'border-line2 bg-bg1 text-tx2 hover:bg-bg2 hover:text-tx'}`}
              onClick={toggleDictation}
            >
              <Mic size={15} />
            </button>
          )}
          {streaming ? (
            <>
              {props.onEnqueue && (
                <button
                  title="加入队列:当前回复完成后自动发送"
                  disabled={!text.trim() && atts.length === 0}
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-line2 bg-bg1 text-tx2 shadow-xs transition-colors hover:bg-bg2 hover:text-tx disabled:opacity-40 disabled:pointer-events-none"
                  onClick={send}
                >
                  <ListPlus size={15} />
                </button>
              )}
              <button
                title="停止生成"
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-line2 bg-bg1 text-tx shadow-xs transition-colors hover:bg-bg2"
                onClick={props.onStop}
              >
                <Square size={12} fill="currentColor" />
              </button>
            </>
          ) : (
            <button
              title="发送消息"
              disabled={(!text.trim() && atts.length === 0) || props.disabled}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md bg-pri text-prifg shadow-xs transition-colors hover:bg-pri2 disabled:opacity-40 disabled:pointer-events-none"
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
