import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, PanelLeft, MessagesSquare, Wrench, Image as ImageIcon } from 'lucide-react';
import { api, streamChat, ApiError } from '../api';
import { useAuth, useChats, useMcp, useModels, useUi } from '../store';
import { Composer, type ComposerSettings, type PendingImage } from '../components/Composer';
import { ChatMessage } from '../components/ChatMessage';
import { CatMark } from '../components/Logo';
import { Button, PageHeader, toast } from '../components/ui';
import type { ChatDetail, Message, MessagePart, ModelInfo } from '../types';

const LAST_MODEL_KEY = 'cat-last-model';

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

export default function Chat() {
  const { id: routeId } = useParams();
  const nav = useNavigate();
  const { user, bootstrap } = useAuth();
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
  const [settings, setSettings] = useState<ComposerSettings>(draftFromChat(null));
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
    if (patch.systemPrompt || patch.reasoningEffort !== 'off' || mcpSelected.length) {
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

  const capabilities = [
    { icon: <MessagesSquare size={15} />, title: '多模型对话', desc: '在同一界面切换不同服务商的模型' },
    { icon: <Wrench size={15} />, title: 'MCP 工具', desc: '接入外部工具服务器,扩展模型能力' },
    { icon: <ImageIcon size={15} />, title: '图像理解与生成', desc: '读图分析,或直接在对话中作图' },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={chat?.title || (routeId ? '对话' : '新建对话')}
        subtitle={modelSel?.displayName ? `当前模型 · ${modelSel.displayName}` : undefined}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="打开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      >
        {user?.role === 'admin' && models.length === 0 && modelsLoaded && (
          <Button variant="primary" size="sm" onClick={() => nav('/admin/providers')}>配置模型服务</Button>
        )}
      </PageHeader>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
          <div className="fade-up w-full max-w-2xl">
            <div className="mb-8 flex flex-col items-center text-center">
              <CatMark size={56} />
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-tx">
                {bootstrap?.brand || 'Cat AgentUI'}
              </h2>
              <p className="mt-1.5 text-[13px] text-tx2">开始一段新对话,或从左侧继续此前的记录。</p>
            </div>

            {composer}

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {capabilities.map((c) => (
                <div key={c.title} className="rounded-lg border border-line bg-bg0 px-3.5 py-3">
                  <div className="flex items-center gap-2 text-tx">
                    <span className="text-tx3">{c.icon}</span>
                    <span className="text-[13px] font-medium">{c.title}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-tx3">{c.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-7 sm:px-6">
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
          <div className="relative shrink-0 border-t border-line bg-bg1 px-4 pb-3 pt-3 sm:px-6">
            {!stick && (
              <button
                title="回到底部"
                className="absolute -top-11 left-1/2 flex h-8 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-line2 bg-bg1 text-tx2 shadow-md transition-colors hover:text-tx"
                onClick={() => { setStick(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}
              >
                <ArrowDown size={14} />
              </button>
            )}
            <div className="mx-auto max-w-3xl">{composer}</div>
            <p className="mt-2 text-center text-[11px] text-tx3">内容由 AI 生成,请自行核实关键信息。</p>
          </div>
        </>
      )}
    </div>
  );
}
