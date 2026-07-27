import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, PanelLeft } from 'lucide-react';
import { api, streamChat, ApiError } from '../api';
import { useAuth, useChats, useMcp, useModels, useUi } from '../store';
import { Composer, type PendingImage } from '../components/Composer';
import { ChatMessage } from '../components/ChatMessage';
import { CatLogo } from '../components/Logo';
import { Button, toast } from '../components/ui';
import type { ChatDetail, Message, MessagePart, ModelInfo } from '../types';

const LAST_MODEL_KEY = 'cat-last-model';

interface ChatSettingsDraft { systemPrompt: string; temperature: string; maxTokens: string }

function draftFromChat(c: ChatDetail | null): ChatSettingsDraft {
  return {
    systemPrompt: c?.systemPrompt ?? '',
    temperature: c?.temperature != null ? String(c.temperature) : '',
    maxTokens: c?.maxTokens != null ? String(c.maxTokens) : '',
  };
}

function draftToPatch(d: ChatSettingsDraft) {
  const temp = d.temperature.trim() === '' ? null : Number(d.temperature);
  const mt = d.maxTokens.trim() === '' ? null : Math.floor(Number(d.maxTokens));
  return {
    systemPrompt: d.systemPrompt.trim() === '' ? null : d.systemPrompt,
    temperature: temp != null && Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : null,
    maxTokens: mt != null && Number.isFinite(mt) && mt > 0 ? mt : null,
  };
}

export default function Chat() {
  const { id: routeId } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { sidebarOpen, setSidebarOpen } = useUi();
  const models = useModels((s) => s.models);
  const modelsLoaded = useModels((s) => s.loaded);
  const loadModels = useModels((s) => s.load);
  const loadMcp = useMcp((s) => s.load);
  const chatsStore = useChats();

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [modelSel, setModelSel] = useState<ModelInfo | null>(null);
  const [mcpSelected, setMcpSelected] = useState<string[]>([]);
  const [settings, setSettings] = useState<ChatSettingsDraft>(draftFromChat(null));
  const [stick, setStick] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const skipLoadRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRef = useRef<ChatDetail | null>(null);
  chatRef.current = chat;

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
    if (!routeId) {
      setChat(null); setMessages([]); setMcpSelected([]); setSettings(draftFromChat(null));
      return;
    }
    let cancelled = false;
    api.get<{ chat: ChatDetail; messages: Message[] }>(`/api/chats/${routeId}`)
      .then((r) => {
        if (cancelled) return;
        setChat(r.chat); setMessages(r.messages);
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

  // auto scroll
  useEffect(() => {
    if (stick && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, stick]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);

  function persistSettings(next: ChatSettingsDraft, mcp?: string[]) {
    setSettings(next);
    const target = chatRef.current;
    if (!target) return; // applied on chat creation
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      api.patch(`/api/chats/${target.id}`, { ...draftToPatch(next), ...(mcp ? { mcpServerIds: mcp } : {}) })
        .catch(() => toast('保存对话设置失败', 'err'));
    }, 600);
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

  async function ensureChat(): Promise<ChatDetail> {
    if (chatRef.current) return chatRef.current;
    const r = await api.post<{ chat: ChatDetail }>('/api/chats', { modelId: modelSel?.id ?? null });
    let created = r.chat;
    const patch = draftToPatch(settings);
    if (patch.systemPrompt || patch.temperature != null || patch.maxTokens != null || mcpSelected.length) {
      const p = await api.patch<{ chat: ChatDetail }>(`/api/chats/${created.id}`, { ...patch, mcpServerIds: mcpSelected });
      created = p.chat;
    }
    setChat(created);
    chatsStore.upsert({
      id: created.id, title: created.title, pinned: created.pinned,
      modelId: created.modelId, createdAt: created.createdAt, updatedAt: created.updatedAt,
    });
    skipLoadRef.current = created.id;
    nav(`/chat/${created.id}`);
    return created;
  }

  function runStream(chatId: string, payload: Parameters<typeof streamChat>[1]) {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setStick(true);

    // buffered delta application (avoid re-render per token)
    const buf = { text: '', reasoning: '' };
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let finished = false;

    const applyToAssistant = (fn: (m: Message) => Message) => {
      setMessages((prev) => {
        const idx = prev.map((m) => m.role).lastIndexOf('assistant');
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = fn(next[idx]);
        return next;
      });
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
      chatsStore.load().catch(() => { /* ignore */ });
    };

    streamChat(chatId, payload, {
      onMeta(d) {
        setMessages((prev) => prev.map((m) => {
          if (m.id === 'tmp-a') return { ...m, id: d.messageId, model: d.model };
          if (m.id === 'tmp-u' && d.userMessageId) return { ...m, id: d.userMessageId };
          return m;
        }));
      },
      onDelta(t) { buf.text += t; },
      onReasoning(t) { buf.reasoning += t; },
      onToolCall(d) { flush(); applyToAssistant((m) => ({ ...m, parts: [...m.parts, { type: 'tool_call', ...d }] })); },
      onToolResult(d) { flush(); applyToAssistant((m) => ({ ...m, parts: [...m.parts, { type: 'tool_result', ...d }] })); },
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
      onError(message) { applyToAssistant((m) => ({ ...m, status: 'error', error: message })); },
      onDone(status) { finalize(status); },
    }, controller.signal)
      .then(() => finalize('done'))
      .catch((e) => {
        if (controller.signal.aborted) { finalize('stopped'); return; }
        if (e instanceof ApiError) {
          // request rejected before streaming started — drop placeholder
          finished = true;
          if (flushTimer) clearInterval(flushTimer);
          setMessages((prev) => prev.filter((m) => m.id !== 'tmp-a'));
          setStreaming(false);
          toast(e.message, 'err');
          return;
        }
        finalize('error');
      });
  }

  async function send(text: string, images: PendingImage[]) {
    if (streaming) return;
    try {
      const target = await ensureChat();
      const content: ({ type: 'text'; text: string } | { type: 'image'; uploadId: string })[] = [];
      for (const img of images) content.push({ type: 'image', uploadId: img.uploadId });
      if (text) content.push({ type: 'text', text });
      const nowTs = Date.now();
      const parts = content.map((c) => (c.type === 'text'
        ? { type: 'text' as const, text: c.text }
        : { type: 'image' as const, uploadId: c.uploadId }));
      setMessages((prev) => [
        ...prev,
        { id: 'tmp-u', role: 'user', parts, model: null, status: 'done', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: nowTs },
        { id: 'tmp-a', role: 'assistant', parts: [], model: modelSel?.modelId ?? null, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: nowTs + 1 },
      ]);
      runStream(target.id, { content, modelId: modelSel?.id });
    } catch (e) {
      toast(e instanceof Error ? e.message : '发送失败', 'err');
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function regenerate(msgId: string) {
    if (streaming || !chatRef.current) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    setMessages((prev) => [
      ...prev.slice(0, idx),
      { id: 'tmp-a', role: 'assistant', parts: [], model: modelSel?.modelId ?? null, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: Date.now() },
    ]);
    runStream(chatRef.current.id, { regenerateMessageId: msgId, modelId: modelSel?.id });
  }

  function editUser(msgId: string, newText: string) {
    if (streaming || !chatRef.current) return;
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const original = messages[idx];
    const keepImages = original.parts.filter((p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image' && !!p.uploadId);
    const content: ({ type: 'text'; text: string } | { type: 'image'; uploadId: string })[] = [
      ...keepImages.map((p) => ({ type: 'image' as const, uploadId: p.uploadId! })),
      { type: 'text', text: newText },
    ];
    setMessages((prev) => [
      ...prev.slice(0, idx),
      { ...original, parts: content.map((c) => c.type === 'text' ? { type: 'text' as const, text: c.text } : { type: 'image' as const, uploadId: c.uploadId }) },
      { id: 'tmp-a', role: 'assistant', parts: [], model: modelSel?.modelId ?? null, status: 'streaming', error: null, promptTokens: null, completionTokens: null, totalTokens: null, durationMs: null, ttftMs: null, createdAt: Date.now() },
    ]);
    runStream(chatRef.current.id, { editMessageId: msgId, content, modelId: modelSel?.id });
  }

  const isEmpty = !routeId && messages.length === 0;
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf('assistant');

  const composer = (
    <Composer
      streaming={streaming}
      disabled={modelsLoaded && models.length === 0}
      model={modelSel}
      onModelChange={selectModel}
      mcpSelected={mcpSelected}
      onMcpChange={persistMcp}
      settings={settings}
      onSettingsChange={persistSettings}
      onSend={send}
      onStop={stop}
      autoFocus
    />
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        {!sidebarOpen && (
          <Button variant="ghost" size="icon" title="打开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {chat?.title || (routeId ? '对话' : '新对话')}
        </h1>
        {user?.role === 'admin' && models.length === 0 && modelsLoaded && (
          <Button variant="outline" size="sm" onClick={() => nav('/admin/providers')}>去配置模型</Button>
        )}
      </header>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 pb-24">
          <div className="fade-up mb-8 flex flex-col items-center gap-4">
            <div className="rounded-3xl border border-line bg-bg1 p-5 shadow-xl"><CatLogo size={64} /></div>
            <div className="text-center">
              <h2 className="text-lg font-semibold tracking-tight">今天想聊点什么?</h2>
              <p className="mt-1 text-xs text-tx3">黑猫已就位 — 支持多模型对话、MCP 工具与图像理解</p>
            </div>
          </div>
          <div className="w-full max-w-2xl">{composer}</div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
              {messages.map((m, i) => (
                <ChatMessage
                  key={m.id}
                  msg={m}
                  isStreaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
                  pendingLabel={modelSel?.imageGen ? '正在生成图片,可能需要 1–3 分钟…' : undefined}
                  onRegenerate={m.role === 'assistant' && i === lastAssistantIdx && !streaming ? () => regenerate(m.id) : undefined}
                  onEdit={m.role === 'user' && !streaming ? (t) => editUser(m.id, t) : undefined}
                />
              ))}
              <div className="h-2" />
            </div>
          </div>
          <div className="relative shrink-0 px-4 pb-4">
            {!stick && (
              <button
                className="absolute -top-10 left-1/2 -translate-x-1/2 cursor-pointer rounded-full border border-line bg-bg1 p-2 text-tx2 shadow-lg transition-colors hover:text-tx"
                onClick={() => { setStick(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}
              >
                <ArrowDown size={14} />
              </button>
            )}
            <div className="mx-auto max-w-3xl">{composer}</div>
            <p className="mt-2 text-center text-[10px] text-tx3">AI 可能会犯错,请核实重要信息</p>
          </div>
        </>
      )}
    </div>
  );
}
