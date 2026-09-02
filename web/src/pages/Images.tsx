import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PanelLeft, ImagePlus, Sparkles, X, Download, Trash2, Image as ImageIcon,
  History, Settings2, Plus, ZoomIn, ArrowRight, MessageSquare, Send,
} from 'lucide-react';
import { useUi, useAuth } from '../store';
import { api, ApiError, uploadFile } from '../api';
import { tabAlert } from '../tabAlert';
import { notifyDone } from '../notify';
import {
  Button, Input, Textarea, Select, Field, Modal, ModalActions, Spinner, Card, PageHeader,
  toast, EmptyState, btnClass,
} from '../components/ui';
import { ImageLightbox, ImageTile, TileOverlay } from '../components/ImageGallery';
import { NoWorkshopAccess } from '../components/NoWorkshopAccess';
import { Markdown } from '../components/Markdown';
import type { ImageModel, ImageRecord } from '../types';

const PAGE_SIZE = 24;
const MAX_REFS = 3;
// Older images shown beside the featured one; the rest live in /images/gallery.
const GALLERY_PREVIEW = 6;
const HISTORY_MAX = 10;
// Quick prompts are titled templates: the chip shows the short title, clicking
// inserts the (possibly very long) prompt body.
type QuickPrompt = { title: string; prompt: string };
const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [{ title: '去背景', prompt: '去背景' }];

// A generation in flight. The server admits one job per model per user, so
// several of these can run side by side — one per model.
type RunningJob = { id: string; modelId: string; prompt: string; startedAt: number };
type ActiveJobs = { jobs?: { jobId: string; modelId: string; prompt: string; createdAt: number }[] };
type JobStatus = { status: string; images?: ImageRecord[]; reply?: string; turns?: ConvoTurn[]; error?: string };

// Conversational image models (Gemini) sometimes answer in words instead of
// pictures — "here are two options, which one?". The exchange is kept here so
// the user can pick or reply, and the follow-up replays it to the model.
type ConvoTurn = { role: 'user' | 'assistant'; text: string };
type Convo = { modelId: string; turns: ConvoTurn[] };

// "方案一 / 方案二 / Option A" mentioned in the reply become one-click choices.
function detectOptions(text: string): string[] {
  const out: string[] = [];
  const re = /(方案|选项|Option)\s*([一二三四五六七八九十]|[1-9]\d?|[A-H])(?![\d\w])/gi;
  for (const m of text.matchAll(re)) {
    const label = `${m[1]}${m[2]}`;
    if (!out.includes(label)) out.push(label);
    if (out.length >= 8) break;
  }
  return out;
}

// Accepts both the current {title, prompt} shape and the legacy plain-string
// entries (which double as their own title).
function normalizeQuick(raw: unknown): QuickPrompt[] {
  if (!Array.isArray(raw)) return DEFAULT_QUICK_PROMPTS;
  const out: QuickPrompt[] = [];
  for (const x of raw) {
    if (typeof x === 'string') {
      if (x.trim()) out.push({ title: x, prompt: x });
    } else if (x && typeof x === 'object') {
      const { title, prompt } = x as Record<string, unknown>;
      if (typeof prompt === 'string' && prompt.trim()) {
        out.push({ title: typeof title === 'string' && title.trim() ? title : prompt, prompt });
      }
    }
  }
  return out;
}

export default function Images() {
  const user = useAuth((s) => s.user);
  if (user && !user.allowImages) return <NoWorkshopAccess />;
  return <ImagesInner />;
}

function ImagesInner() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const user = useAuth((s) => s.user);

  // ---- generation form state ----
  const [models, setModels] = useState<ImageModel[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [n, setN] = useState(1);
  // Fixed reference slots: 图1/图2/图3 are stable positions — uploading or
  // removing one never shifts the others.
  const [refSlots, setRefSlots] = useState<(string | null)[]>(Array(MAX_REFS).fill(null));
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Generation state is a list, not a boolean: one job per model can run at a
  // time, so picking another model lets the user start a second one right away.
  const [running, setRunning] = useState<RunningJob[]>([]);
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [genError, setGenError] = useState<{ label: string; message: string } | null>(null);
  const [convo, setConvo] = useState<Convo | null>(null);
  const [replyText, setReplyText] = useState('');
  // One ticker drives every job's elapsed counter.
  const [, setTick] = useState(0);
  const aliveRef = useRef(true);
  const trackedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setTick((v) => v + 1), 100);
    return () => clearInterval(t);
  }, [running.length]);
  const slotFileRef = useRef<HTMLInputElement>(null);
  const slotTargetRef = useRef<number>(0);

  // ---- quick / history prompts ----
  const quickKey = `cat-img-quick:${user?.id ?? 'anon'}`;
  const [quick, setQuick] = useState<QuickPrompt[]>(DEFAULT_QUICK_PROMPTS);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickDraft, setQuickDraft] = useState<QuickPrompt[]>([]);
  const [histOpen, setHistOpen] = useState(false);

  // ---- gallery state ----
  const [list, setList] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [galleryLoaded, setGalleryLoaded] = useState(false);
  const [lightbox, setLightbox] = useState<ImageRecord | null>(null);
  // Which reference slot is open in the zoom preview (index into refSlots).
  const [refPreview, setRefPreview] = useState<number | null>(null);

  const model = models?.find((m) => m.id === modelId) ?? null;
  // Async job callbacks outlive the render they were created in, so they read
  // the model list through a ref instead of a stale closure.
  const modelsRef = useRef<ImageModel[] | null>(null);
  modelsRef.current = models;
  function modelLabel(id: string) {
    const m = modelsRef.current?.find((x) => x.id === id);
    return m ? (m.displayName || m.modelId) : '图像模型';
  }

  const busyModels = useMemo(
    () => new Set([...running.map((j) => j.modelId), ...submitting]),
    [running, submitting],
  );

  // Last 10 distinct prompts, straight from the user's own gallery — survives
  // reloads and other devices without any extra storage.
  const history = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const img of list) {
      const p = img.prompt?.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= HISTORY_MAX) break;
    }
    return out;
  }, [list]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(quickKey);
      setQuick(raw !== null ? normalizeQuick(JSON.parse(raw)) : DEFAULT_QUICK_PROMPTS);
    } catch {
      setQuick(DEFAULT_QUICK_PROMPTS);
    }
  }, [quickKey]);

  // Ctrl/Cmd+V anywhere on the page uploads clipboard images as references.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files);
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  useEffect(() => {
    api.get<ImageModel[]>('/api/images/models')
      .then((r) => {
        const arr = Array.isArray(r) ? r : [];
        setModels(arr);
        if (arr.length) setModelId((prev) => prev || arr[0].id);
      })
      .catch((err) => {
        setModels([]);
        toast(err instanceof Error ? err.message : '加载模型失败', 'err');
      });
    api.get<{ images: ImageRecord[]; total: number }>(`/api/images?limit=${PAGE_SIZE}&offset=0`)
      .then((r) => { setList(r.images ?? []); setTotal(r.total ?? 0); setGalleryLoaded(true); })
      .catch((err) => {
        setGalleryLoaded(true);
        toast(err instanceof Error ? err.message : '加载图片失败', 'err');
      });
  }, []);

  // Bulk entry (drag-drop / paste): fill empty slots in order, positions of
  // already-filled slots untouched.
  async function addFiles(files: File[]) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const room = refSlots.filter((s) => !s).length;
    if (!room) { toast(`参考图最多 ${MAX_REFS} 张`, 'err'); return; }
    if (imgs.length > room) toast(`参考图最多 ${MAX_REFS} 张`, 'err');
    setUploading(true);
    try {
      for (const f of imgs.slice(0, room)) {
        const r = await uploadFile(f);
        setRefSlots((prev) => {
          const idx = prev.indexOf(null);
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = r.id;
          return next;
        });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '上传失败', 'err');
    } finally {
      setUploading(false);
    }
  }

  function openSlotPicker(idx: number) {
    if (uploading) return;
    slotTargetRef.current = idx;
    slotFileRef.current?.click();
  }

  // Fill or replace exactly the slot the user clicked.
  async function onSlotFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    const idx = slotTargetRef.current;
    if (!f || !f.type.startsWith('image/')) return;
    setUploading(true);
    try {
      const r = await uploadFile(f);
      setRefSlots((prev) => prev.map((x, i) => (i === idx ? r.id : x)));
    } catch (err) {
      toast(err instanceof Error ? err.message : '上传失败', 'err');
    } finally {
      setUploading(false);
    }
  }

  function applyQuickPrompt(text: string) {
    setPrompt((p) => {
      const cur = p.trim();
      if (!cur) return text;
      return cur.includes(text) ? cur : `${cur},${text}`;
    });
  }

  function saveQuick(next: QuickPrompt[]) {
    setQuick(next);
    try { localStorage.setItem(quickKey, JSON.stringify(next)); } catch { /* ignore */ }
  }

  // Last-resort recovery: the job result may have landed in the gallery even
  // when we lost track of the job itself. Returns how many fresh images were
  // pulled in.
  async function recoverFromGallery(sinceTs: number): Promise<number> {
    try {
      const r = await api.get<{ images: ImageRecord[]; total: number }>(
        `/api/images?limit=${PAGE_SIZE}&offset=0`,
      );
      const fresh = (r.images ?? []).filter((i) => i.createdAt > sinceTs);
      if (fresh.length) {
        setList((prev) => {
          const have = new Set(prev.map((x) => x.id));
          return [...fresh.filter((f) => !have.has(f.id)), ...prev];
        });
        setTotal((t) => Math.max(t, r.total ?? 0));
      }
      return fresh.length;
    } catch {
      return 0;
    }
  }

  // Poll a server-side job to completion. Tolerates any transient poll
  // failure for up to 12 minutes (the server gives up at 10), and before
  // surfacing any error it checks the gallery in case the result arrived
  // despite us losing the job.
  async function runJob(job: RunningJob) {
    if (trackedRef.current.has(job.id)) return;
    trackedRef.current.add(job.id);
    setRunning((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]));
    const { id: jobId, startedAt } = job;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!aliveRef.current) return;
        let st: JobStatus;
        try {
          st = await api.get<JobStatus>(`/api/images/jobs/${jobId}`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) throw new Error('任务状态已丢失(服务器可能重启过)');
          if (Date.now() - startedAt > 12 * 60_000) throw new Error('等待超时,已放弃');
          continue;
        }
        if (st.status === 'error') throw new Error(st.error || '生成失败');
        if (st.status === 'done') {
          const imgs = st.images ?? [];
          if (!imgs.length) {
            // The model talked instead of drawing. Not a failure: show what it
            // said and let the user answer.
            if (aliveRef.current) {
              setConvo({ modelId: job.modelId, turns: st.turns ?? [{ role: 'user', text: job.prompt }, { role: 'assistant', text: st.reply ?? '' }] });
              setReplyText('');
            }
            toast(`${modelLabel(job.modelId)}:模型回复了文字,请选择方案或继续对话`, 'ok');
            tabAlert();
            notifyDone('绘图工坊', `${modelLabel(job.modelId)}:模型回复了文字,请选择方案或继续对话`, '/images');
            return;
          }
          if (aliveRef.current) setConvo((c) => (c?.modelId === job.modelId ? null : c));
          setList((prev) => {
            const have = new Set(prev.map((x) => x.id));
            return [...imgs.filter((i) => !have.has(i.id)), ...prev];
          });
          setTotal((t) => t + imgs.length);
          // Prompt and reference images stay put on purpose — iterating on
          // the same inputs is the common case.
          toast(`${modelLabel(job.modelId)}:已生成 ${imgs.length} 张图片`, 'ok');
          tabAlert();
          notifyDone('绘图完成', `${modelLabel(job.modelId)}:已生成 ${imgs.length} 张图片`, '/images');
          return;
        }
      }
    } catch (err) {
      const recovered = await recoverFromGallery(startedAt);
      if (recovered > 0) {
        toast(`已生成 ${recovered} 张图片(已从作品库找回)`, 'ok');
        tabAlert();
        return;
      }
      const msg = err instanceof Error ? err.message : '生成失败';
      if (aliveRef.current) setGenError({ label: modelLabel(job.modelId), message: msg });
      toast(msg, 'err');
      tabAlert();
      notifyDone('绘图失败', `${modelLabel(job.modelId)}:${msg}`, '/images');
    } finally {
      trackedRef.current.delete(jobId);
      if (aliveRef.current) setRunning((prev) => prev.filter((j) => j.id !== jobId));
    }
  }

  // Re-attach to every still-running job after a reload / tab switch, so
  // closing the page mid-generation loses nothing — and a second window shows
  // the same tasks instead of looking idle.
  useEffect(() => {
    api.get<ActiveJobs>('/api/images/jobs/active')
      .then((r) => {
        for (const j of r.jobs ?? []) {
          void runJob({ id: j.jobId, modelId: j.modelId, prompt: j.prompt, startedAt: j.createdAt });
        }
      })
      .catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function generate() {
    const p = prompt.trim();
    if (!p || !model) return;
    void submit(model.id, p);
  }

  // Answer a model that replied in words — the whole exchange goes along so
  // "方案一" means something.
  function replyToModel(text: string) {
    const t = text.trim();
    if (!convo || !t) return;
    setReplyText('');
    void submit(convo.modelId, t, convo.turns);
  }

  async function submit(mid: string, p: string, history?: ConvoTurn[]) {
    if (uploading || busyModels.has(mid)) return;
    setGenError(null);
    setSubmitting((prev) => [...prev, mid]);
    const start = Date.now();
    try {
      const body: Record<string, unknown> = { modelId: mid, prompt: p, n };
      const refIds = refSlots.filter((x): x is string => !!x);
      if (refIds.length) body.inputUploadIds = refIds;
      if (history?.length) body.history = history;
      const { jobId } = await api.post<{ jobId: string }>('/api/images/generate', body);
      void runJob({ id: jobId, modelId: mid, prompt: p, startedAt: start });
    } catch (err) {
      // Pick up anything this window doesn't know about yet — typically a job
      // the same user started in another tab, which is also why a refusal
      // (429 「该模型正在生成中」) can arrive out of nowhere.
      const active = await api.get<ActiveJobs>('/api/images/jobs/active').catch(() => null);
      const untracked = (active?.jobs ?? []).filter((j) => !trackedRef.current.has(j.jobId));
      for (const j of untracked) {
        void runJob({ id: j.jobId, modelId: j.modelId, prompt: j.prompt, startedAt: j.createdAt });
      }
      // An ApiError means the server answered and refused: nothing was queued,
      // so report it. Anything else is a lost response (e.g. a proxy cutting
      // the connection) and one of the jobs above is probably ours.
      if (!(err instanceof ApiError) && untracked.some((j) => j.modelId === mid)) return;
      const msg = err instanceof Error ? err.message : '生成失败';
      setGenError({ label: modelLabel(mid), message: msg });
      toast(msg, 'err');
      tabAlert();
    } finally {
      setSubmitting((prev) => prev.filter((x) => x !== mid));
    }
  }

  const currentJob = model ? running.find((j) => j.modelId === model.id) ?? null : null;
  const convoBusy = !!convo && busyModels.has(convo.modelId);
  const convoOptions = useMemo(() => {
    const last = convo?.turns.filter((t) => t.role === 'assistant').at(-1);
    return last ? detectOptions(last.text) : [];
  }, [convo]);
  const canGenerate = !!prompt.trim() && !!model && !uploading && !busyModels.has(model.id);

  return (
    // The +1px type bump this page pioneered is now app-wide (see index.css).
    <div className="contents">
      <PageHeader
        title="绘图工坊"
        subtitle={total > 0 ? `已生成 ${total.toLocaleString()} 张图片` : '文生图与参考图编辑'}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />

      <div className="flex-1 overflow-y-auto bg-bg0">
        <div className="mx-auto max-w-5xl p-6">
          {/* ---- generation form ---- */}
          <Card title="新建生成" desc="描述目标画面,可附参考图作为编辑输入。" className="fade-up"
            flush={models === null || models.length === 0}>
            {models === null ? (
              <div className="flex justify-center py-10 text-tx3"><Spinner className="h-5 w-5" /></div>
            ) : models.length === 0 ? (
              user && !user.allowImageModels ? (
                <EmptyState
                  icon={<ImageIcon size={22} />}
                  title="没有图像模型使用权限"
                  hint="请联系管理员为你的账号开启图像模型使用权限后再来创作。"
                />
              ) : (
                <EmptyState
                  icon={<ImageIcon size={22} />}
                  title="管理员尚未配置图像模型"
                  hint="请联系管理员在后台添加支持图像生成的模型后再来创作。"
                />
              )
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <Field label="模型">
                      <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {`${m.displayName || m.modelId} · ${m.providerName}`}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="生成数量">
                    <Select value={String(n)} onChange={(e) => setN(Number(e.target.value))}>
                      {[1, 2, 3, 4].map((i) => <option key={i} value={i}>{i} 张</option>)}
                    </Select>
                  </Field>
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[13px] font-medium text-tx">提示词</span>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setHistOpen((v) => !v)}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-tx2 transition-colors hover:bg-bg2 hover:text-tx"
                      >
                        <History size={13} />历史提示词
                      </button>
                      {histOpen && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setHistOpen(false)} />
                          <div className="absolute right-0 top-full z-20 mt-1 max-h-72 w-80 max-w-[80vw] overflow-y-auto rounded-lg border border-line bg-bg1 py-1 shadow-lg">
                            {history.length === 0 ? (
                              <div className="px-3 py-2.5 text-xs text-tx3">还没有历史提示词</div>
                            ) : history.map((h) => (
                              <button
                                key={h}
                                type="button"
                                onClick={() => { setPrompt(h); setHistOpen(false); }}
                                className="block w-full cursor-pointer px-3 py-2 text-left text-xs leading-relaxed text-tx2 transition-colors hover:bg-bg2 hover:text-tx"
                              >
                                <span className="line-clamp-2">{h}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <Textarea
                    rows={3}
                    value={prompt}
                    maxLength={4000}
                    placeholder="描述你想生成的图像,例如:一只黑猫坐在雨后的屋顶上,水彩风格…"
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
                    }}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {quick.map((q, i) => (
                      <button
                        key={`${q.title}-${i}`}
                        type="button"
                        title={q.prompt}
                        onClick={() => applyQuickPrompt(q.prompt)}
                        className="max-w-[200px] cursor-pointer truncate rounded-full border border-line bg-bg1 px-2.5 py-1 text-xs text-tx2 transition-colors hover:border-line2 hover:bg-bg2 hover:text-tx"
                      >
                        {q.title}
                      </button>
                    ))}
                    <button
                      type="button"
                      title="管理快捷提示词"
                      onClick={() => {
                        setQuickDraft(quick.length ? quick.map((q) => ({ ...q })) : [{ title: '', prompt: '' }]);
                        setQuickOpen(true);
                      }}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-tx3 transition-colors hover:border-line2 hover:text-tx"
                    >
                      <Settings2 size={12} />管理
                    </button>
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-[13px] font-medium text-tx">参考图</div>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      void addFiles(Array.from(e.dataTransfer?.files ?? []));
                    }}
                    className="grid grid-cols-3 gap-2 sm:gap-3"
                  >
                    {refSlots.map((id, i) => (
                      id ? (
                        <div key={i} className="group/ref relative h-24 overflow-hidden rounded-lg border border-line sm:h-28">
                          <button
                            type="button"
                            title={`放大查看图${i + 1}`}
                            onClick={() => setRefPreview(i)}
                            className="block h-full w-full cursor-pointer"
                          >
                            <img
                              src={`/api/uploads/${id}/file`}
                              alt={`图${i + 1}`}
                              className="h-full w-full object-cover"
                            />
                            <span className="absolute inset-0 flex items-center justify-center gap-1 bg-black/45 text-[11px] text-white opacity-0 transition-opacity group-hover/ref:opacity-100">
                              <ZoomIn size={13} />查看
                            </span>
                          </button>
                          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-sm bg-black/55 px-1.5 py-0.5 text-[10px] leading-none text-white">
                            图{i + 1}
                          </span>
                          <button
                            type="button"
                            title="移除"
                            onClick={() => setRefSlots((prev) => prev.map((x, j) => (j === i ? null : x)))}
                            className="absolute right-1 top-1 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-black/70 text-white ring-1 ring-white/70 transition-colors hover:bg-errs"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <button
                          key={i}
                          type="button"
                          title={`上传图${i + 1}`}
                          disabled={uploading}
                          onClick={() => openSlotPicker(i)}
                          className={`flex h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed transition-colors sm:h-28 disabled:cursor-default disabled:opacity-60 ${
                            dragOver ? 'border-acc bg-acc/5 text-acc' : 'border-line2 text-tx3 hover:border-tx3 hover:text-tx'
                          }`}
                        >
                          {uploading ? <Spinner className="h-4 w-4" /> : <ImagePlus size={17} />}
                          <span className="text-[11px] tabular-nums">图{i + 1}</span>
                        </button>
                      )
                    ))}
                  </div>
                  <input
                    ref={slotFileRef} type="file" accept="image/*" hidden
                    onChange={onSlotFile}
                  />
                  <div className="mt-1.5 text-xs text-tx3">
                    可选;支持拖拽或 Ctrl+V 粘贴,点击已上传的图片可放大查看。
                  </div>
                </div>

                {genError && (
                  <div className="whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                    生成失败({genError.label}):{genError.message}
                  </div>
                )}

                {convo && (
                  <div className="space-y-2.5 rounded-lg border border-acc/30 bg-acc/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-tx">
                        <MessageSquare size={14} className="shrink-0 text-acc" />
                        {modelLabel(convo.modelId)} 回复了文字,还没有生成图片
                      </span>
                      <button
                        type="button"
                        title="结束这段对话"
                        onClick={() => setConvo(null)}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-tx3 transition-colors hover:bg-bg2 hover:text-tx"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {convo.turns.map((t, i) => (
                      t.role === 'user' ? (
                        <div key={i} className="line-clamp-2 text-xs text-tx3">你:{t.text}</div>
                      ) : i === convo.turns.length - 1 ? (
                        <div key={i} className="max-h-80 overflow-y-auto rounded-md border border-line bg-bg1 px-3 py-2 text-[13px]">
                          <Markdown text={t.text} />
                        </div>
                      ) : (
                        <div key={i} className="line-clamp-2 text-xs text-tx3">{modelLabel(convo.modelId)}:{t.text}</div>
                      )
                    ))}
                    {convoOptions.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-tx3">按这个方案生成:</span>
                        {convoOptions.map((o) => (
                          <button
                            key={o}
                            type="button"
                            disabled={convoBusy}
                            onClick={() => replyToModel(`请按「${o}」生成图片`)}
                            className="cursor-pointer rounded-full border border-acc/40 bg-bg1 px-2.5 py-1 text-xs text-tx transition-colors hover:border-acc hover:bg-acc/10 disabled:cursor-default disabled:opacity-60"
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        value={replyText}
                        disabled={convoBusy}
                        maxLength={4000}
                        placeholder="回复模型继续,例如:方案一,背景换成雨夜"
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); replyToModel(replyText); }
                        }}
                      />
                      <Button
                        variant="primary"
                        disabled={!replyText.trim() || convoBusy}
                        onClick={() => replyToModel(replyText)}
                        className="shrink-0"
                      >
                        {convoBusy ? <Spinner className="h-4 w-4" /> : <Send size={14} />}继续生成
                      </Button>
                    </div>
                  </div>
                )}

                {/* Every job in flight, one row each — the same list shows up
                    in a second window after re-attaching. */}
                {running.length > 0 && (
                  <div className="space-y-1.5">
                    {running.map((j) => (
                      <div
                        key={j.id}
                        className="flex items-center gap-2 rounded-md border border-line bg-bg1 px-3 py-2 text-[13px]"
                      >
                        <Spinner className="h-3.5 w-3.5 shrink-0 text-tx3" />
                        <span className="shrink-0 font-medium text-tx">{modelLabel(j.modelId)}</span>
                        <span className="truncate text-tx3">{j.prompt}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-tx3">
                          {((Date.now() - j.startedAt) / 1000).toFixed(1)}s
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs leading-relaxed text-tx3">
                    部分模型生成需要几分钟,请耐心等待;期间可切到其他标签页,完成后标签会有提示。
                    换一个模型即可同时发起下一张,同一模型需等当前任务完成。Cmd / Ctrl + Enter 快速提交。
                  </p>
                  <Button variant="primary" disabled={!canGenerate} onClick={generate} className="shrink-0">
                    {currentJob
                      ? <><Spinner className="h-4 w-4" />生成中 {((Date.now() - currentJob.startedAt) / 1000).toFixed(1)}s</>
                      : model && submitting.includes(model.id)
                        ? <><Spinner className="h-4 w-4" />提交中</>
                        : <><Sparkles size={15} />生成图片</>}
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* ---- gallery ---- */}
          <section className="mt-5">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="eyebrow">作品库</h2>
              {total > 0 && (
                <Link
                  to="/images/gallery"
                  className="inline-flex cursor-pointer items-center gap-1 text-xs tabular-nums text-tx2 transition-colors hover:text-tx"
                >
                  作品集 · 共 {total.toLocaleString()} 张<ArrowRight size={12} />
                </Link>
              )}
            </div>
            {!galleryLoaded ? (
              <div className="flex justify-center py-16 text-tx3"><Spinner className="h-5 w-5" /></div>
            ) : list.length === 0 ? (
              <div className="rounded-xl border border-line bg-bg1">
                <EmptyState
                  icon={<ImageIcon size={22} />}
                  title="还没有生成过图片"
                  hint="在上方输入提示词,开始你的第一次创作。"
                />
              </div>
            ) : (
              <>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  {/* Newest image gets the spotlight: oversized, with its own
                      download affordances (corner pill + full-width bar). */}
                  <div>
                    <div className="group relative overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs transition-shadow hover:shadow-md">
                      <button
                        type="button"
                        onClick={() => setLightbox(list[0])}
                        className="block aspect-square w-full cursor-pointer text-left"
                      >
                        <img
                          src={`/api/images/${list[0].id}/file`}
                          alt={list[0].prompt}
                          className="h-full w-full object-cover"
                        />
                        <TileOverlay featured prompt={list[0].prompt} model={list[0].model} />
                      </button>
                      <a
                        href={`/api/images/${list[0].id}/file`}
                        download
                        title="下载图片"
                        className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/70 transition-colors hover:bg-black/85"
                      >
                        <Download size={16} />
                      </a>
                    </div>
                    <a
                      href={`/api/images/${list[0].id}/file`}
                      download
                      className={btnClass('outline', 'lg', 'mt-3 w-full')}
                    >
                      <Download size={16} />下载图片
                    </a>
                  </div>
                  {/* Older images: a capped preview grid — the full archive
                      lives on the 作品集 page. */}
                  {list.length > 1 && (
                    <div className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3 lg:grid-cols-2">
                      {list.slice(1, 1 + GALLERY_PREVIEW).map((img) => (
                        <ImageTile key={img.id} img={img} onClick={() => setLightbox(img)} />
                      ))}
                    </div>
                  )}
                </div>
                {total > 1 + GALLERY_PREVIEW && (
                  <div className="mt-5 flex justify-center">
                    <Link
                      to="/images/gallery"
                      className={btnClass('outline', 'sm')}
                    >
                      查看全部 {total.toLocaleString()} 张作品<ArrowRight size={14} />
                    </Link>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      {/* ---- reference image preview ---- */}
      <Modal
        open={refPreview !== null} onClose={() => setRefPreview(null)}
        title={`参考图${(refPreview ?? 0) + 1}`} wide
      >
        {refPreview !== null && refSlots[refPreview] && (
          <div className="space-y-4">
            <img
              src={`/api/uploads/${refSlots[refPreview]}/file`}
              alt={`图${refPreview + 1}`}
              className="mx-auto max-h-[62vh] rounded-lg border border-line bg-bg0 object-contain"
            />
            <ModalActions>
              <Button
                variant="outline"
                disabled={uploading}
                onClick={() => { const i = refPreview; setRefPreview(null); openSlotPicker(i); }}
              >
                <ImagePlus size={14} />更换
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRefSlots((prev) => prev.map((x, j) => (j === refPreview ? null : x)));
                  setRefPreview(null);
                }}
              >
                <Trash2 size={14} />移除
              </Button>
            </ModalActions>
          </div>
        )}
      </Modal>

      {/* ---- quick prompt manager ---- */}
      <Modal open={quickOpen} onClose={() => setQuickOpen(false)} title="管理快捷提示词"
        desc="常用的提示词模板,页面上显示标题,点击填入完整提示词。">
        <div className="space-y-2.5">
          {quickDraft.map((q, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-line p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  value={q.title}
                  maxLength={30}
                  placeholder="标题,例如:去背景"
                  onChange={(e) => setQuickDraft((prev) => prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                />
                <Button
                  variant="ghost" size="icon" title="删除"
                  onClick={() => setQuickDraft((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <Textarea
                rows={2}
                value={q.prompt}
                maxLength={2000}
                placeholder="提示词内容,可以很长…"
                onChange={(e) => setQuickDraft((prev) => prev.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))}
              />
            </div>
          ))}
          {quickDraft.length === 0 && (
            <p className="py-1 text-xs text-tx3">暂无快捷提示词,点击下方按钮添加。</p>
          )}
          <Button variant="outline" size="sm" onClick={() => setQuickDraft((prev) => [...prev, { title: '', prompt: '' }])}>
            <Plus size={14} />添加一条
          </Button>
        </div>
        <ModalActions>
          <Button variant="outline" onClick={() => setQuickOpen(false)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              saveQuick(
                quickDraft
                  .map((x) => ({ title: x.title.trim(), prompt: x.prompt.trim() }))
                  .filter((x) => x.prompt)
                  .map((x) => ({ title: x.title || x.prompt, prompt: x.prompt })),
              );
              setQuickOpen(false);
            }}
          >
            保存
          </Button>
        </ModalActions>
      </Modal>

      {/* ---- lightbox ---- */}
      <ImageLightbox
        image={lightbox}
        onClose={() => setLightbox(null)}
        onDeleted={(img) => {
          setList((prev) => prev.filter((x) => x.id !== img.id));
          setTotal((t) => Math.max(0, t - 1));
          setLightbox(null);
        }}
      />
    </div>
  );
}
