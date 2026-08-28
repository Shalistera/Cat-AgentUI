import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive, ArrowDown, Check, FolderClosed, Ghost, ListOrdered, PanelLeft, Pencil,
  Plus, Send, Trash2,
} from 'lucide-react';
import { api, errMsg, streamChat, ApiError } from '../api';
import { chatHandoff, LAST_MODEL_KEY, useAuth, useChats, useMcp, useModels, useProjects, useQueue, useUi, type QueuedMessage } from '../store';
import { Composer, type ComposerSettings, type PendingAttachment } from '../components/Composer';
import { ChatMessage } from '../components/ChatMessage';
import { ModelAvatar } from '../components/ModelAvatar';
import { CatMark } from '../components/Logo';
import { Button, Modal, ModalActions, PageHeader, Textarea, confirmDialog, toast } from '../components/ui';
import { tabAlert } from '../tabAlert';
import type { ChatDetail, ChatSummary, Message, MessagePart, ModelInfo, User } from '../types';

function draftFromChat(c: ChatDetail | null): ComposerSettings {
  return {
    systemPrompt: c?.systemPrompt ?? '',
    reasoningEffort: c?.reasoningEffort ?? 'off',
  };
}

// temperature / maxTokens are no longer surfaced, so they are simply left
// alone here rather than being nulled out from under existing chats.
function draftToPatch(d: ComposerSettings) {
  return {
    systemPrompt: d.systemPrompt.trim() === '' ? null : d.systemPrompt,
    reasoningEffort: d.reasoningEffort,
  };
}

// ---- message tree helpers ----
// `all` holds every branch in (seq, createdAt) order; the visible conversation
// is the root→leaf chain ending at leafId. Regenerated replies and edited user
// messages are SIBLINGS (same parentId) switched with the version arrows.

function computePath(all: Message[], leafId: string | null): Message[] {
  if (!all.length) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const leaf = (leafId && byId.get(leafId)) || all[all.length - 1];
  const path: Message[] = [];
  const seen = new Set<string>();
  let cur: Message | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Walk down from a node always taking the newest child — the branch's tip. */
function newestLeafUnder(all: Message[], id: string): string {
  let cur = id;
  for (;;) {
    const kids = all.filter((m) => m.parentId === cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1].id;
  }
}

// ---- model comparison (用其他模型对比生成) ----
// Picking another model in the regenerate menu does NOT replace the reply:
// the challenger streams as a hidden sibling and both render side by side
// until the user keeps one. The loser stays reachable via the version arrows.

interface CompareState {
  originalId: string;
  /** 'tmp-a' until the stream's meta event names the real row. */
  challengerId: string;
  /** Leaf before the compare started — restored when the original is kept. */
  prevLeafId: string | null;
  /** chat.modelId before the compare — the stream pins the challenger's. */
  prevModelId: string | null;
  challengerModel: ModelInfo;
}

function CompareView({ original, challenger, challengerModel, streaming, onKeep }: {
  original: Message;
  challenger: Message | null;
  challengerModel: ModelInfo;
  streaming: boolean;
  onKeep(side: 'original' | 'challenger'): void;
}) {
  const card = 'flex min-w-0 flex-col overflow-hidden rounded-xl border bg-bg1';
  const head = 'flex items-center gap-2 border-b border-line bg-bg2/45 px-3 py-2 text-xs font-medium text-tx';
  const body = 'min-h-0 max-h-[32rem] flex-1 overflow-y-auto px-3.5 py-3';
  const keepBtn = 'm-2.5 mt-0 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none';
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className={`${card} border-line`}>
        <div className={head}>
          <span className="rounded-sm bg-bg3 px-1.5 py-0.5 text-[10px] text-tx2">当前回复</span>
          {original.model && <span className="truncate font-mono text-[11px] text-tx3">{original.model}</span>}
        </div>
        <div className={body}>
          <ChatMessage msg={original} isStreaming={false} />
        </div>
        <button className={`${keepBtn} border-line2 text-tx2 hover:bg-bg2 hover:text-tx`}
          disabled={streaming} onClick={() => onKeep('original')}>
          <Check size={13} />保留这个回复
        </button>
      </div>
      <div className={`${card} border-acc/50`}>
        <div className={head}>
          <ModelAvatar info={challengerModel} size={16} tile={false} />
          <span className="truncate">{challengerModel.displayName}</span>
          {streaming && <span className="animate-pulse text-[11px] font-normal text-acc">生成中…</span>}
        </div>
        <div className={body}>
          {challenger
            ? <ChatMessage msg={challenger} isStreaming={streaming} />
            : <p className="py-2 text-[13px] text-tx3">正在准备…</p>}
        </div>
        <button className={`${keepBtn} border-acc/50 text-acc hover:bg-acc/10`}
          disabled={streaming} onClick={() => onKeep('challenger')}>
          <Check size={13} />保留这个回复
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-tx3 md:col-span-2">
        选择保留后,另一个回复仍会作为历史版本保留,可随时用消息下方的左右箭头切换。
      </p>
    </div>
  );
}

// ---- queued sends (generation-time message queue) ----

function QueueBar({ items, streaming, onSendNow, onRemove, onUpdate }: {
  items: QueuedMessage[];
  streaming: boolean;
  onSendNow(item: QueuedMessage): void;
  onRemove(item: QueuedMessage): void;
  onUpdate(item: QueuedMessage, text: string): void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (!items.length) return null;
  const iconBtn = 'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-tx3 transition-colors hover:bg-bg2 hover:text-tx';
  return (
    <div className="mx-auto mb-2 w-full max-w-[48rem] overflow-hidden rounded-lg border border-line bg-bg1 shadow-xs">
      <div className="flex items-center gap-1.5 border-b border-line bg-bg2/45 px-3 py-1.5 text-[11px] font-medium text-tx2">
        <ListOrdered size={12} className="text-tx3" />
        已排队 {items.length} 条消息{streaming ? '，将在当前回复完成后依次发送' : ''}
      </div>
      <div className="max-h-40 divide-y divide-line/70 overflow-y-auto">
        {items.map((item) => (
          <div key={item.id} className="px-3 py-1.5">
            {editingId === item.id ? (
              <div>
                <textarea
                  className="w-full resize-y rounded-md border border-field bg-bg1 px-2.5 py-1.5 text-[13px] leading-relaxed text-tx"
                  rows={Math.min(6, Math.max(2, draft.split('\n').length))}
                  value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
                />
                <div className="mt-1.5 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>取消</Button>
                  <Button variant="primary" size="sm" onClick={() => {
                    if (draft.trim()) onUpdate(item, draft.trim());
                    setEditingId(null);
                  }}>保存</Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-tx2" title={item.text}>
                  {item.text || '(仅附件)'}
                  {item.attachments.length > 0 && (
                    <span className="ml-1.5 text-[11px] text-tx3">📎{item.attachments.length}</span>
                  )}
                </span>
                <button title="立即发送：打断当前生成并发送这条" className={iconBtn} onClick={() => onSendNow(item)}>
                  <Send size={12} />
                </button>
                <button title="编辑" className={iconBtn}
                  onClick={() => { setDraft(item.text); setEditingId(item.id); }}>
                  <Pencil size={12} />
                </button>
                <button title="移出队列" className={`${iconBtn} hover:text-err`} onClick={() => onRemove(item)}>
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- 快捷指令 (new-chat page) ----
// User-owned one-click prompts stored in settings.quickPrompts. null/absent
// falls back to the single built-in example; an emptied list stays empty —
// deleting the default is a choice, not a reset.

const DEFAULT_QUICK_PROMPTS = ['用通俗的比喻解释一下大语言模型是怎么工作的'];
const MAX_QUICK_PROMPTS = 6;
const QUICK_PROMPT_MAX_CHARS = 300;

function QuickPrompts({ onSend }: { onSend(q: string): void }) {
  const user = useAuth((s) => s.user);
  const prompts = user?.settings.quickPrompts ?? DEFAULT_QUICK_PROMPTS;
  const [editor, setEditor] = useState<{ index: number | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: string[]): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { quickPrompts: next } });
      useAuth.getState().setUser(r.user);
      return true;
    } catch (e) { toast(errMsg(e), 'err'); return false; }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {prompts.map((q, i) => (
        <div key={`${i}-${q}`} className="group/qp relative">
          <button
            type="button"
            title="点击直接发送"
            onClick={() => onSend(q)}
            className="h-full w-full cursor-pointer rounded-lg border border-line bg-bg1 px-3.5 py-2.5 text-left text-[13px] leading-relaxed text-tx2 shadow-xs transition-colors hover:border-line2 hover:bg-bg2 hover:text-tx"
          >
            {q}
          </button>
          <div className="absolute right-1.5 top-1.5 flex rounded-md bg-bg1/90 opacity-0 shadow-xs backdrop-blur-[2px] transition-opacity group-hover/qp:opacity-100 group-focus-within/qp:opacity-100">
            <Button variant="ghost" size="iconXs" title="编辑快捷指令"
              onClick={() => setEditor({ index: i, text: q })}>
              <Pencil size={12} />
            </Button>
            <Button variant="dangerGhost" size="iconXs" title="删除快捷指令" disabled={busy}
              onClick={() => void save(prompts.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </Button>
          </div>
        </div>
      ))}

      {prompts.length < MAX_QUICK_PROMPTS && (
        <button
          type="button"
          title={`自定义快捷指令,最多 ${MAX_QUICK_PROMPTS} 条`}
          onClick={() => setEditor({ index: null, text: '' })}
          className="flex min-h-[2.75rem] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-3.5 py-2.5 text-[13px] text-tx3 transition-colors hover:border-line2 hover:bg-bg2 hover:text-tx"
        >
          <Plus size={14} />添加快捷指令
        </button>
      )}

      {editor && (
        <Modal open onClose={() => setEditor(null)}
          title={editor.index === null ? '添加快捷指令' : '编辑快捷指令'}
          desc="显示在新对话首页,点击卡片即直接发送这段内容。">
          <div className="space-y-3">
            <Textarea
              rows={3}
              maxLength={QUICK_PROMPT_MAX_CHARS}
              autoFocus
              value={editor.text}
              onChange={(e) => setEditor({ ...editor, text: e.target.value })}
              placeholder="例如:把下面的内容翻译成英文"
            />
            <div className="text-right text-[11px] tabular-nums text-tx3">
              {editor.text.length}/{QUICK_PROMPT_MAX_CHARS}
            </div>
            <ModalActions>
              <Button variant="outline" onClick={() => setEditor(null)}>取消</Button>
              <Button variant="primary" disabled={busy || !editor.text.trim()}
                onClick={async () => {
                  const text = editor.text.trim();
                  const next = editor.index === null
                    ? [...prompts, text]
                    : prompts.map((p, j) => (j === editor.index ? text : p));
                  if (await save(next)) setEditor(null);
                }}>
                保存
              </Button>
            </ModalActions>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Chat() {
  const { id: routeId } = useParams();
  // `/?project=<id>` seeds a fresh chat into that project; once the chat is
  // created the association lives on the chat row itself.
  const [searchParams] = useSearchParams();
  const projectParam = routeId ? null : searchParams.get('project');
  // `/?temp=1` starts a 临时对话: created with the temporary flag, so it never
  // enters the sidebar/search and the server sweeps it after the idle TTL.
  const tempMode = !routeId && !projectParam && searchParams.get('temp') === '1';
  const projects = useProjects((s) => s.projects);
  const nav = useNavigate();
  const { user, bootstrap } = useAuth();
  const { sidebarOpen, setSidebarOpen } = useUi();
  const models = useModels((s) => s.models);
  const modelsLoaded = useModels((s) => s.loaded);
  const loadModels = useModels((s) => s.load);
  const loadMcp = useMcp((s) => s.load);
  const mcpServers = useMcp((s) => s.servers);
  const chatsStore = useChats();
  const queueStore = useQueue();

  const [chat, setChat] = useState<ChatDetail | null>(null);
  // ALL messages of the chat — every branch. The rendered conversation is the
  // chain ending at leafId (computed below as `path`).
  const [messages, setMessages] = useState<Message[]>([]);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [modelSel, setModelSel] = useState<ModelInfo | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [mcpSelected, setMcpSelected] = useState<string[]>([]);
  const [settings, setSettings] = useState<ComposerSettings>(draftFromChat(null));
  const [stick, setStick] = useState(true);
  const [compare, setCompare] = useState<CompareState | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const skipLoadRef = useRef<string | null>(null);
  // A handed-off send chose its own 联网搜索 state; the model-default effect
  // below must not overwrite it when the model subsequently changes state.
  const handoffAppliedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRef = useRef<ChatDetail | null>(null);
  chatRef.current = chat;
  // The message currently receiving stream deltas ('tmp-a' until meta arrives).
  const streamMsgIdRef = useRef<string | null>(null);
  // True from the moment a send is committed until its stream finishes — the
  // queue auto-dispatcher keys off this, not the async `streaming` state.
  const sendingRef = useRef(false);

  const path = useMemo(() => computePath(messages, leafId), [messages, leafId]);

  useEffect(() => { loadModels().catch(() => { /* toast below via disabled state */ }); loadMcp().catch(() => { /* optional */ }); }, [loadModels, loadMcp]);

  // pick model: chat's model → last used → default
  useEffect(() => {
    if (!modelsLoaded) return;
    const chatModel = chat?.modelId ? models.find((m) => m.id === chat.modelId) : null;
    if (chatModel) { setModelSel(chatModel); return; }
    if (modelSel && models.some((m) => m.id === modelSel.id)) return;
    const last = localStorage.getItem(LAST_MODEL_KEY);
    // an image model is only ever picked deliberately, never as the default
    const pick = models.find((m) => m.id === last)
      ?? models.find((m) => m.isDefault && !m.imageGen)
      ?? models.find((m) => !m.imageGen)
      ?? models[0]
      ?? null;
    setModelSel(pick);
  }, [modelsLoaded, models, chat]); // eslint-disable-line react-hooks/exhaustive-deps

  // load chat on route change
  useEffect(() => {
    // A chat we just created and are already streaming into: the route change is
    // our own navigation, so don't abort the in-flight stream or reload state.
    if (skipLoadRef.current === routeId) { skipLoadRef.current = null; return; }
    abortRef.current?.abort();
    setStreaming(false);
    sendingRef.current = false;
    setCompare(null);
    if (!routeId) {
      handoffAppliedRef.current = false;
      setChat(null); setMessages([]); setLeafId(null); setWebSearch(false); setMcpSelected([]); setSettings(draftFromChat(null));
      return;
    }
    let cancelled = false;
    api.get<{ chat: ChatDetail; messages: Message[] }>(`/api/chats/${routeId}`)
      .then((r) => {
        if (cancelled) return;
        setChat(r.chat); setMessages(r.messages); setLeafId(r.chat.currentLeafId);
        setWebSearch(r.chat.webSearch);
        setMcpSelected(r.chat.mcpServerIds); setSettings(draftFromChat(r.chat));
        setStick(true);
      })
      .catch((e) => {
        if (cancelled) return;
        toast(e instanceof Error ? e.message : '加载对话失败', 'err');
        nav('/', { replace: true });
      });
    return () => { cancelled = true; };
  }, [routeId, nav]);

  // New chats adopt the admin-configured 联网搜索 default of the selected model
  // (only when search is actually available to it). Loaded chats keep their own
  // saved preference; a handed-off send carries its own explicit choice, which
  // this must not clobber — hence the payload/applied guards.
  useEffect(() => {
    if (routeId || chat || !modelSel || chatHandoff.payload || handoffAppliedRef.current) return;
    const fallback = mcpServers.some((s) => s.isSearch && s.enabled);
    const available = modelSel.nativeSearch || (fallback && modelSel.tools && !modelSel.imageGen);
    setWebSearch(available && modelSel.defaultWebSearch);
  }, [routeId, chat, mcpServers, modelSel]);

  // A payload handed off from the project page's composer: adopt its model /
  // settings / MCP choices, then fire it through the normal send path.
  // Consumed exactly once — see chatHandoff.
  useEffect(() => {
    const h = chatHandoff.payload;
    if (routeId || !h || streaming || !modelsLoaded) return;
    const m = (h.modelId ? models.find((x) => x.id === h.modelId) : null) ?? modelSel;
    if (!m) return; // no models yet (default pick lands next render) — keep the payload
    chatHandoff.payload = null;
    handoffAppliedRef.current = true;
    setModelSel(m);
    setSettings(h.settings);
    setWebSearch(h.webSearch);
    setMcpSelected(h.mcpSelected);
    void send(h.text, h.attachments, {
      modelId: m.id, settings: h.settings, webSearch: h.webSearch, mcpSelected: h.mcpSelected,
    });
  }, [routeId, modelsLoaded, models, modelSel, streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // auto scroll
  useEffect(() => {
    if (stick && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [path, stick]);

  // Mobile: scrolling back up through the conversation folds the composer to
  // one row so more of the transcript fits; tapping the input unfolds it.
  const [composerCompact, setComposerCompact] = useState(false);
  const lastScrollTop = useRef(0);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    const dy = el.scrollTop - lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    // Threshold filters out the jitter from the on-screen keyboard resizing
    // the viewport, which would otherwise fold the input mid-typing.
    if (dy < -12 && window.innerWidth < 640) setComposerCompact(true);
  }, []);
  useEffect(() => { setComposerCompact(false); }, [routeId]);

  function persistSettings(next: ComposerSettings, mcp?: string[]) {
    setSettings(next);
    const target = chatRef.current;
    if (!target) return; // applied on chat creation
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      api.patch(`/api/chats/${target.id}`, { ...draftToPatch(next), ...(mcp ? { mcpServerIds: mcp } : {}) })
        .catch(() => toast('保存对话设置失败', 'err'));
    }, 600);
  }

  function persistWebSearch(enabled: boolean) {
    setWebSearch(enabled);
    const target = chatRef.current;
    if (!target) return;
    api.patch(`/api/chats/${target.id}`, { webSearch: enabled })
      .catch(() => toast('保存联网搜索设置失败', 'err'));
  }

  function persistMcp(ids: string[]) {
    setMcpSelected(ids);
    const target = chatRef.current;
    if (!target) return;
    api.patch(`/api/chats/${target.id}`, { mcpServerIds: ids })
      .catch(() => toast('保存 MCP 设置失败', 'err'));
  }

  function selectModel(m: ModelInfo) {
    setModelSel(m);
    localStorage.setItem(LAST_MODEL_KEY, m.id);
  }

  // Overrides let a handed-off send (project page composer) use its own model /
  // settings without waiting for this page's setState round-trips.
  interface SendOverrides {
    modelId?: string;
    settings?: ComposerSettings;
    webSearch?: boolean;
    mcpSelected?: string[];
  }

  async function ensureChat(o?: SendOverrides): Promise<ChatDetail> {
    if (chatRef.current) return chatRef.current;
    const r = await api.post<{ chat: ChatDetail }>('/api/chats', {
      modelId: o?.modelId ?? modelSel?.id ?? null,
      projectId: projectParam,
      temporary: tempMode || undefined,
    });
    let created = r.chat;
    const patch = draftToPatch(o?.settings ?? settings);
    const search = o?.webSearch ?? webSearch;
    const mcp = o?.mcpSelected ?? mcpSelected;
    if (patch.systemPrompt || patch.reasoningEffort !== 'off' || search || mcp.length) {
      const p = await api.patch<{ chat: ChatDetail }>(`/api/chats/${created.id}`, {
        ...patch, webSearch: search, mcpServerIds: mcp,
      });
      created = p.chat;
    }
    setChat(created);
    // A 临时对话 must not surface in the sidebar list.
    if (!created.temporary) {
      chatsStore.upsert({
        id: created.id, title: created.title, pinned: created.pinned, archived: created.archived,
        temporary: created.temporary,
        modelId: created.modelId, projectId: created.projectId,
        createdAt: created.createdAt, updatedAt: created.updatedAt,
      });
    }
    skipLoadRef.current = created.id;
    nav(`/chat/${created.id}`);
    return created;
  }

  function runStream(chatId: string, payload: Parameters<typeof streamChat>[1]) {
    const controller = new AbortController();
    abortRef.current = controller;
    sendingRef.current = true;
    streamMsgIdRef.current = 'tmp-a';
    setStreaming(true);
    setStick(true);

    // buffered delta application (avoid re-render per token)
    const buf = { text: '', reasoning: '' };
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;

    const applyToAssistant = (fn: (m: Message) => Message) => {
      setMessages((prev) => prev.map((m) => (m.id === streamMsgIdRef.current ? fn(m) : m)));
    };

    const appendPart = (type: 'text' | 'reasoning', text: string) => {
      applyToAssistant((m) => {
        const parts = [...m.parts];
        const last = parts[parts.length - 1];
        if (last && last.type === type) {
          parts[parts.length - 1] = { ...last, text: (last as { text: string }).text + text } as MessagePart;
        } else {
          parts.push({ type, text } as MessagePart);
        }
        return { ...m, parts };
      });
    };

    const flush = () => {
      if (buf.reasoning) { appendPart('reasoning', buf.reasoning); buf.reasoning = ''; }
      if (buf.text) { appendPart('text', buf.text); buf.text = ''; }
    };
    flushTimer = setInterval(flush, 80);

    const finalize = (status: Message['status']) => {
      if (finished) return;
      finished = true;
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      flush();
      applyToAssistant((m) => ({ ...m, status: m.status === 'error' ? 'error' : status }));
      setStreaming(false);
      sendingRef.current = false;
      // "stopped" is always user-initiated from this tab — no need to flag it.
      if (status !== 'stopped') tabAlert();
      chatsStore.load().catch(() => { /* ignore */ });
    };

    streamChat(chatId, payload, {
      onMeta(d) {
        streamMsgIdRef.current = d.messageId;
        setMessages((prev) => prev.map((m) => {
          let next = m;
          if (next.id === 'tmp-a') next = { ...next, id: d.messageId, model: d.model };
          else if (next.id === 'tmp-u' && d.userMessageId) next = { ...next, id: d.userMessageId };
          if (next.parentId === 'tmp-u' && d.userMessageId) next = { ...next, parentId: d.userMessageId };
          return next;
        }));
        setLeafId((l) => (l === 'tmp-a' ? d.messageId : l));
        setCompare((c) => (c && c.challengerId === 'tmp-a' ? { ...c, challengerId: d.messageId } : c));
        // The server un-archives a chat on new activity — mirror it locally.
        setChat((c) => (c && c.archived ? { ...c, archived: false } : c));
        chatsStore.patch(chatId, { archived: false });
      },
      onDelta(t) { buf.text += t; },
      onReasoning(t) { buf.reasoning += t; },
      onToolCall(d) { flush(); applyToAssistant((m) => ({ ...m, parts: [...m.parts, { type: 'tool_call', ...d }] })); },
      onToolResult(d) { flush(); applyToAssistant((m) => ({ ...m, parts: [...m.parts, { type: 'tool_result', ...d }] })); },
      onGrounding(d) { flush(); applyToAssistant((m) => ({ ...m, parts: [...m.parts, d] })); },
      onImage(d) { flush(); applyToAssistant((m) => ({ ...m, parts: [...m.parts, { type: 'image', imageId: d.imageId, mime: d.mime }] })); },
      onUsage(d) {
        applyToAssistant((m) => ({
          ...m,
          promptTokens: d.promptTokens, completionTokens: d.completionTokens,
          totalTokens: d.totalTokens, durationMs: d.durationMs, ttftMs: d.ttftMs,
        }));
      },
      onNotice(msg) { toast(msg, 'info'); },
      onTitle(title) { chatsStore.patch(chatId, { title }); setChat((c) => (c ? { ...c, title } : c)); },
      onFollowups(d) {
        if (!d.questions?.length || !d.messageId) return;
        flush();
        // Arrives after 'done', so the user may already be sending the next
        // message — target the reply by id, never "the last assistant".
        setMessages((prev) => prev.map((m) => (m.id === d.messageId
          ? { ...m, parts: [...m.parts, { type: 'followups', questions: d.questions }] }
          : m)));
      },
      onError(message) { applyToAssistant((m) => ({ ...m, status: 'error', error: message })); },
      onDone(status) { finalize(status); },
    }, controller.signal)
      .then(() => finalize('done'))
      .catch((e) => {
        if (controller.signal.aborted) { finalize('stopped'); return; }
        if (e instanceof ApiError) {
          // request rejected before anything was persisted — drop placeholders
          finished = true;
          if (flushTimer) clearInterval(flushTimer);
          setMessages((prev) => prev.filter((m) => m.id !== 'tmp-a' && m.id !== 'tmp-u'));
          setLeafId((l) => (l === 'tmp-a' || l === 'tmp-u' ? null : l));
          setStreaming(false);
          sendingRef.current = false;
          toast(e.message, 'err');
          return;
        }
        finalize('error');
      });
  }

  async function send(text: string, attachments: PendingAttachment[], o?: SendOverrides) {
    if (sendingRef.current || streaming) return;
    sendingRef.current = true;
    // Sending while a comparison is open implicitly keeps the branch on screen
    // (the original) — the panel closes, both versions stay as siblings.
    setCompare(null);
    const sendModel = (o?.modelId ? models.find((m) => m.id === o.modelId) : null) ?? modelSel;
    try {
      const target = await ensureChat(o);
      const content: ({ type: 'text'; text: string }
        | { type: 'image'; uploadId: string }
        | { type: 'file'; uploadId: string; name?: string; mime?: string })[] = [];
      for (const att of attachments) {
        content.push(att.kind === 'image'
          ? { type: 'image', uploadId: att.uploadId }
          : { type: 'file', uploadId: att.uploadId, name: att.name, mime: att.mime });
      }
      if (text) content.push({ type: 'text', text });
      const nowTs = Date.now();
      const parts: MessagePart[] = content;
      // Parent = the leaf of the branch on screen, so a send while viewing an
      // older version continues THAT branch.
      const parentId = path.length ? path[path.length - 1].id : null;
      setMessages((prev) => [
        ...prev,
        { id: 'tmp-u', parentId, role: 'user', parts, model: null, status: 'done', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: nowTs },
        { id: 'tmp-a', parentId: 'tmp-u', role: 'assistant', parts: [], model: sendModel?.modelId ?? null, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: nowTs + 1 },
      ]);
      setLeafId('tmp-a');
      runStream(target.id, { content, modelId: sendModel?.id, parentMessageId: parentId ?? undefined });
    } catch (e) {
      sendingRef.current = false;
      toast(e instanceof Error ? e.message : '发送失败', 'err');
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Queue: sends fired while a reply streams wait here; whenever this chat is
  // open and idle the next item goes out automatically (also right after the
  // current reply finishes). Queues live per chat id and survive switching.
  const queued = chat ? queueStore.queues[chat.id] ?? [] : [];
  useEffect(() => {
    // A pending model comparison also pauses the queue — dispatching would
    // grow the conversation under a reply the user may not keep.
    if (!chat || streaming || sendingRef.current || compare) return;
    if (!(queueStore.queues[chat.id] ?? []).length) return;
    const item = queueStore.shift(chat.id);
    if (item) void send(item.text, item.attachments);
  }, [chat, streaming, compare, queueStore.queues]); // eslint-disable-line react-hooks/exhaustive-deps

  function enqueue(text: string, attachments: PendingAttachment[]) {
    const target = chatRef.current;
    if (!target) return;
    queueStore.enqueue(target.id, text, attachments);
  }

  function queueSendNow(item: QueuedMessage) {
    const target = chatRef.current;
    if (!target) return;
    queueStore.promote(target.id, item.id);
    // Aborting finalizes the current turn; the idle dispatcher then fires the
    // promoted item. Not streaming (paused queue) → the dispatcher effect has
    // already been re-armed by the promote() state change.
    if (streaming) stop();
  }

  function regenerate(msgId: string) {
    if (streaming || sendingRef.current || !chatRef.current) return;
    const target = messages.find((m) => m.id === msgId);
    if (!target) return;
    setCompare(null);
    // Non-destructive: the new attempt is a SIBLING of the old reply — the old
    // version (and everything under it) stays reachable via the arrows.
    setMessages((prev) => [
      ...prev,
      { id: 'tmp-a', parentId: target.parentId, role: 'assistant', parts: [], model: modelSel?.modelId ?? null, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: Date.now() },
    ]);
    setLeafId('tmp-a');
    runStream(chatRef.current.id, { regenerateMessageId: msgId, modelId: modelSel?.id });
  }

  // 用其他模型对比生成:当前回复留在原位,挑战者作为隐藏兄弟并排流式输出,
  // 完成后由用户选择保留哪个(未选中的仍是可切换的历史版本)。
  function regenerateCompare(msgId: string, withModel: ModelInfo) {
    if (streaming || sendingRef.current || !chatRef.current) return;
    const target = messages.find((m) => m.id === msgId);
    if (!target || target.role !== 'assistant') return;
    setCompare({
      originalId: msgId,
      challengerId: 'tmp-a',
      prevLeafId: leafId,
      prevModelId: chatRef.current.modelId,
      challengerModel: withModel,
    });
    setMessages((prev) => [
      ...prev,
      { id: 'tmp-a', parentId: target.parentId, role: 'assistant', parts: [], model: withModel.modelId, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: Date.now() },
    ]);
    // Pin the view to the original: the compare panel renders in its place,
    // its descendants stay hidden until a side is kept.
    setLeafId(msgId);
    runStream(chatRef.current.id, { regenerateMessageId: msgId, modelId: withModel.id });
  }

  function keepCompare(side: 'original' | 'challenger') {
    const c = compare;
    if (!c || streaming || !chatRef.current) return;
    setCompare(null);
    if (side === 'original') {
      // The stream pinned chat.modelId and currentLeafId to the challenger —
      // put both back on the original branch.
      const leaf = c.prevLeafId && messages.some((m) => m.id === c.prevLeafId) ? c.prevLeafId : c.originalId;
      setLeafId(leaf);
      setChat((cc) => (cc ? { ...cc, modelId: c.prevModelId } : cc));
      api.patch(`/api/chats/${chatRef.current.id}`, { currentLeafId: leaf, modelId: c.prevModelId })
        .catch(() => toast('保存分支选择失败', 'err'));
    } else {
      // Challenger wins: its branch is already the server-side leaf; its model
      // becomes the conversation default.
      setLeafId(c.challengerId);
      selectModel(c.challengerModel);
      setChat((cc) => (cc ? { ...cc, modelId: c.challengerModel.id } : cc));
    }
  }

  function editUser(msgId: string, newText: string) {
    if (streaming || sendingRef.current || !chatRef.current) return;
    const original = messages.find((m) => m.id === msgId);
    if (!original) return;
    setCompare(null);
    // Editing rewrites the text but keeps every attachment (images and files).
    const keepAtts = original.parts.filter((p): p is Extract<MessagePart, { type: 'image' | 'file' }> => (
      (p.type === 'image' || p.type === 'file') && !!p.uploadId
    ));
    const content: ({ type: 'text'; text: string }
      | { type: 'image'; uploadId: string }
      | { type: 'file'; uploadId: string; name?: string; mime?: string })[] = [
      ...keepAtts.map((p) => (p.type === 'image'
        ? { type: 'image' as const, uploadId: p.uploadId! }
        : { type: 'file' as const, uploadId: p.uploadId, name: p.name, mime: p.mime })),
      { type: 'text', text: newText },
    ];
    const nowTs = Date.now();
    // Non-destructive: the edited message is a SIBLING of the original — the
    // old wording and its replies stay switchable.
    setMessages((prev) => [
      ...prev,
      { ...original, id: 'tmp-u', parentId: original.parentId, parts: content as MessagePart[], createdAt: nowTs },
      { id: 'tmp-a', parentId: 'tmp-u', role: 'assistant', parts: [], model: modelSel?.modelId ?? null, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: nowTs + 1 },
    ]);
    setLeafId('tmp-a');
    runStream(chatRef.current.id, { editMessageId: msgId, content, modelId: modelSel?.id });
  }

  // In-place correction of a model reply (no regeneration): the edited text
  // replaces the reply's text content and feeds later context.
  async function editAssistant(msgId: string, newText: string) {
    if (!chatRef.current) return;
    try {
      const r = await api.patch<{ message: Message }>(`/api/chats/${chatRef.current.id}/messages/${msgId}`, { text: newText });
      setMessages((prev) => prev.map((m) => (m.id === msgId ? r.message : m)));
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存修改失败', 'err');
    }
  }

  async function deleteMessage(msgId: string) {
    if (streaming || !chatRef.current) return;
    const ok = await confirmDialog('删除这条消息?', '删除后这条消息将不再作为上下文参与后续回复,且无法恢复。');
    if (!ok) return;
    try {
      await api.del(`/api/chats/${chatRef.current.id}/messages/${msgId}`);
      setCompare(null);
      const target = messages.find((m) => m.id === msgId);
      // Splice the local tree the same way the server did: children reattach
      // to the deleted message's parent.
      setMessages((prev) => prev.filter((m) => m.id !== msgId)
        .map((m) => (m.parentId === msgId ? { ...m, parentId: target?.parentId ?? null } : m)));
      setLeafId((l) => (l === msgId ? (target?.parentId ?? null) : l));
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除消息失败', 'err');
    }
  }

  function switchSibling(msg: Message, dir: -1 | 1) {
    if (streaming || sendingRef.current || !chatRef.current) return;
    setCompare(null);
    const sibs = messages.filter((m) => m.parentId === msg.parentId);
    const idx = sibs.findIndex((m) => m.id === msg.id);
    const target = sibs[idx + dir];
    if (!target) return;
    const newLeaf = newestLeafUnder(messages, target.id);
    setLeafId(newLeaf);
    api.patch(`/api/chats/${chatRef.current.id}`, { currentLeafId: newLeaf })
      .catch(() => { /* view already switched; persistence is best-effort */ });
  }

  const [branching, setBranching] = useState(false);
  async function branchChat(uptoMessageId: string) {
    if (!chatRef.current || branching) return;
    setBranching(true);
    try {
      const r = await api.post<{ chat: ChatSummary }>(`/api/chats/${chatRef.current.id}/branch`, { uptoMessageId });
      chatsStore.upsert(r.chat);
      nav(`/chat/${r.chat.id}`);
      toast('已创建分支对话', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建分支失败', 'err');
    } finally {
      setBranching(false);
    }
  }

  const isEmpty = !routeId && path.length === 0;
  const lastAssistantIdx = path.map((m) => m.role).lastIndexOf('assistant');
  // 无痕 means no local traces either: temporary chats never persist drafts.
  const draftKey = tempMode || chat?.temporary
    ? undefined
    : routeId ? `chat:${routeId}` : projectParam ? `new:project:${projectParam}` : 'new';

  async function saveTemporary() {
    const target = chatRef.current;
    if (!target) return;
    try {
      const r = await api.patch<{ chat: ChatDetail }>(`/api/chats/${target.id}`, { temporary: false });
      setChat(r.chat);
      chatsStore.upsert({
        id: r.chat.id, title: r.chat.title, pinned: r.chat.pinned, archived: r.chat.archived,
        temporary: r.chat.temporary, modelId: r.chat.modelId, projectId: r.chat.projectId,
        createdAt: r.chat.createdAt, updatedAt: r.chat.updatedAt,
      });
      toast('已保存为正式对话', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'err');
    }
  }

  const composer = (
    <Composer
      streaming={streaming}
      disabled={modelsLoaded && models.length === 0}
      model={modelSel}
      onModelChange={selectModel}
      webSearch={webSearch}
      onWebSearchChange={persistWebSearch}
      mcpSelected={mcpSelected}
      onMcpChange={persistMcp}
      settings={settings}
      onSettingsChange={persistSettings}
      onSend={send}
      onEnqueue={chat ? enqueue : undefined}
      onStop={stop}
      draftKey={draftKey}
      autoFocus
      compact={composerCompact}
      onExpand={() => setComposerCompact(false)}
    />
  );

  // Click-to-send starters: the fastest first message a new user can have.
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={chat?.title || (routeId ? '对话' : tempMode ? '临时对话' : '新建对话')}
        subtitle={modelSel?.displayName ? `当前模型 · ${modelSel.displayName}` : undefined}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="打开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      >
        {(() => {
          const pid = chat?.projectId ?? projectParam;
          const project = pid ? projects.find((p) => p.id === pid) : null;
          return project ? (
            <Link to={`/projects/${project.id}`} title="打开项目"
              className="flex max-w-[14rem] items-center gap-1.5 rounded-md border border-line bg-bg2 px-2.5 py-1 text-xs font-medium text-tx2 transition-colors hover:border-line2 hover:text-tx">
              <FolderClosed size={12} className="shrink-0 text-tx3" />
              <span className="truncate">{project.name}</span>
            </Link>
          ) : null;
        })()}
        {chat?.temporary && (
          <div className="flex items-center gap-1.5">
            <span title={'临时对话:不会出现在历史记录和搜索中,\n闲置 24 小时后自动删除(用量仍正常统计)'}
              className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 bg-bg2 px-2.5 py-1 text-xs font-medium text-tx2">
              <Ghost size={12} className="shrink-0 text-tx3" />临时对话
            </span>
            <Button variant="outline" size="sm" title="将这段对话保存进历史记录" onClick={() => void saveTemporary()}>
              保存为正式对话
            </Button>
          </div>
        )}
        {chat?.archived && (
          <button
            title="此对话已归档,点击取消归档"
            onClick={() => {
              const target = chatRef.current;
              if (!target) return;
              api.patch(`/api/chats/${target.id}`, { archived: false })
                .then(() => { setChat((c) => (c ? { ...c, archived: false } : c)); chatsStore.patch(target.id, { archived: false }); })
                .catch(() => toast('取消归档失败', 'err'));
            }}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg2 px-2.5 py-1 text-xs font-medium text-tx2 transition-colors hover:border-line2 hover:text-tx"
          >
            <Archive size={12} className="shrink-0 text-tx3" />已归档
          </button>
        )}
        {user?.role === 'admin' && models.length === 0 && modelsLoaded && (
          <Button variant="primary" size="sm" onClick={() => nav('/admin/providers')}>配置模型服务</Button>
        )}
      </PageHeader>

      {isEmpty ? (
        // Centering lives on the child's auto margins, not justify-center: a
        // justify-centered scroll container clips overflowing content above
        // the scroll start, which cut the cat mark off on phones.
        <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6 sm:py-10">
          {/* 54rem shell matches the conversation column; the composer itself is
              capped at 48rem here too so its width doesn't jump when the first
              message lands. */}
          <div className="fade-up m-auto w-full max-w-[54rem]">
            <div className="mb-8 flex flex-col items-center text-center">
              {/* The mark and title follow the selected model, so the empty
                  page answers "who am I about to talk to" — the cat only
                  fronts it while no model is available. */}
              {!tempMode && modelSel
                ? <ModelAvatar info={modelSel} size={56} />
                : <CatMark size={56} />}
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-tx">
                {tempMode
                  ? '临时对话'
                  : modelSel?.displayName || bootstrap?.brand || 'Cat AgentUI'}
              </h2>
              {!tempMode && modelSel?.description && (
                <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-tx2">{modelSel.description}</p>
              )}
              <p className="mt-1.5 text-[13px] text-tx3">
                {tempMode
                  ? '这段对话不会写入历史记录,闲置 24 小时后自动删除;之后也可以随时保存为正式对话。'
                  : '开始一段新对话,或从左侧继续此前的记录。'}
              </p>
              {!projectParam && (
                <button
                  type="button"
                  aria-pressed={tempMode}
                  title={tempMode ? '切回普通对话' : '开启临时对话:不写入历史记录'}
                  onClick={() => nav(tempMode ? '/' : '/?temp=1', { replace: true })}
                  className={`mt-3 flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    tempMode
                      ? 'border-dashed border-line2 bg-bg2 text-tx shadow-xs'
                      : 'border-line bg-bg1 text-tx3 hover:border-line2 hover:bg-bg2 hover:text-tx'
                  }`}
                >
                  <Ghost size={13} />
                  {tempMode ? '临时对话已开启' : '临时对话'}
                </button>
              )}
            </div>

            <div className="mx-auto max-w-[48rem]">{composer}</div>

            {modelSel && !streaming && (
              <QuickPrompts onSend={(q) => void send(q, [])} />
            )}

          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
            {/* 54rem message column over a 48rem composer (chatgpt-style: content
                slightly wider than the input). Both widths are deliberate user
                picks — change them in tandem with the composer wrappers below
                and in the empty state. */}
            <div className="mx-auto flex w-full max-w-[54rem] flex-col gap-7 px-4 py-7 sm:px-6">
              {path.map((m, i) => {
                if (compare && m.id === compare.originalId) {
                  const challenger = messages.find((x) => x.id === compare.challengerId) ?? null;
                  return (
                    <CompareView
                      key={`compare-${m.id}`}
                      original={m}
                      challenger={challenger}
                      challengerModel={compare.challengerModel}
                      streaming={streaming}
                      onKeep={keepCompare}
                    />
                  );
                }
                const sibs = messages.filter((x) => x.parentId === m.parentId);
                const sibIdx = sibs.findIndex((x) => x.id === m.id);
                return (
                  <ChatMessage
                    key={m.id}
                    msg={m}
                    isStreaming={streaming && m.id === streamMsgIdRef.current}
                    pendingLabel={modelSel?.imageGen ? '正在生成图片,可能需要 1–3 分钟…' : undefined}
                    siblingInfo={sibs.length > 1 ? { index: sibIdx, total: sibs.length } : undefined}
                    onSiblingPrev={!streaming && sibIdx > 0 ? () => switchSibling(m, -1) : undefined}
                    onSiblingNext={!streaming && sibIdx < sibs.length - 1 ? () => switchSibling(m, 1) : undefined}
                    onRegenerate={m.role === 'assistant' && !streaming && !!chat ? () => regenerate(m.id) : undefined}
                    onRegenerateWith={m.role === 'assistant' && !streaming && !!chat ? (pick) => regenerateCompare(m.id, pick) : undefined}
                    onEdit={m.role === 'user' && !streaming ? (t) => editUser(m.id, t) : undefined}
                    onEditAssistant={m.role === 'assistant' && m.status !== 'streaming' && !streaming && !!chat
                      ? (t) => void editAssistant(m.id, t)
                      : undefined}
                    onDelete={!streaming && !!chat ? () => void deleteMessage(m.id) : undefined}
                    onBranch={!streaming && !!chat ? () => void branchChat(m.id) : undefined}
                    onFollowup={m.role === 'assistant' && i === lastAssistantIdx && i === path.length - 1 && !streaming
                      ? (q) => void send(q, [])
                      : undefined}
                  />
                );
              })}
              <div className="h-2" />
            </div>
          </div>
          <div className="relative shrink-0 border-t border-line bg-bg1 px-4 pb-3 pt-3 sm:px-6">
            {!stick && (
              <button
                title="回到底部"
                className="absolute -top-11 left-1/2 flex h-8 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-line2 bg-bg1 text-tx2 shadow-md transition-colors hover:bg-bg2 hover:text-tx"
                onClick={() => { setStick(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}
              >
                <ArrowDown size={14} />
              </button>
            )}
            <QueueBar
              items={queued}
              streaming={streaming}
              onSendNow={queueSendNow}
              onRemove={(item) => chat && queueStore.remove(chat.id, item.id)}
              onUpdate={(item, t) => chat && queueStore.update(chat.id, item.id, t)}
            />
            <div className="mx-auto max-w-[48rem]">{composer}</div>
            {!composerCompact && <p className="mt-2 text-center text-[11px] text-tx3">内容由 AI 生成,请自行核实关键信息。</p>}
          </div>
        </>
      )}
    </div>
  );
}
