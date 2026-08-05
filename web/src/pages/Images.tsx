import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanelLeft, ImagePlus, Sparkles, X, Download, Trash2, Image as ImageIcon,
  History, Settings2, Plus, ZoomIn,
} from 'lucide-react';
import { useUi, useAuth } from '../store';
import { api, ApiError, uploadFile, fmtDuration, fmtTime, fmtTokens } from '../api';
import { tabAlert } from '../tabAlert';
import {
  Button, Input, Textarea, Select, Field, Modal, ModalActions, Badge, Spinner, Card, PageHeader,
  toast, confirmDialog, EmptyState,
} from '../components/ui';
import type { ImageModel, ImageRecord } from '../types';

const PAGE_SIZE = 60;
const MAX_REFS = 3;
const HISTORY_MAX = 10;
const DEFAULT_QUICK_PROMPTS = ['去背景'];

export default function Images() {
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
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobRef = useRef<string | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);
  const slotFileRef = useRef<HTMLInputElement>(null);
  const slotTargetRef = useRef<number>(0);

  // ---- quick / history prompts ----
  const quickKey = `cat-img-quick:${user?.id ?? 'anon'}`;
  const [quick, setQuick] = useState<string[]>(DEFAULT_QUICK_PROMPTS);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickDraft, setQuickDraft] = useState<string[]>([]);
  const [histOpen, setHistOpen] = useState(false);

  // ---- gallery state ----
  const [list, setList] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [galleryLoaded, setGalleryLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lightbox, setLightbox] = useState<ImageRecord | null>(null);
  // Which reference slot is open in the zoom preview (index into refSlots).
  const [refPreview, setRefPreview] = useState<number | null>(null);

  const model = models?.find((m) => m.id === modelId) ?? null;

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
      setQuick(raw !== null ? (JSON.parse(raw) as string[]) : DEFAULT_QUICK_PROMPTS);
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

  function saveQuick(next: string[]) {
    setQuick(next);
    try { localStorage.setItem(quickKey, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function startElapsedTimer(startedAt: number) {
    if (timerRef.current) clearInterval(timerRef.current);
    setElapsed((Date.now() - startedAt) / 1000);
    timerRef.current = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
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
  async function runJob(jobId: string, startedAt: number) {
    if (jobRef.current === jobId) return;
    jobRef.current = jobId;
    setGenerating(true);
    startElapsedTimer(startedAt);
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!aliveRef.current) return;
        let st: { status: string; images?: ImageRecord[]; error?: string };
        try {
          st = await api.get<typeof st>(`/api/images/jobs/${jobId}`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) throw new Error('任务状态已丢失(服务器可能重启过)');
          if (Date.now() - startedAt > 12 * 60_000) throw new Error('等待超时,已放弃');
          continue;
        }
        if (st.status === 'error') throw new Error(st.error || '生成失败');
        if (st.status === 'done') {
          const imgs = st.images ?? [];
          setList((prev) => {
            const have = new Set(prev.map((x) => x.id));
            return [...imgs.filter((i) => !have.has(i.id)), ...prev];
          });
          setTotal((t) => t + imgs.length);
          // Prompt and reference images stay put on purpose — iterating on
          // the same inputs is the common case.
          toast(`已生成 ${imgs.length} 张图片`, 'ok');
          tabAlert();
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
      if (aliveRef.current) setGenError(msg);
      toast(msg, 'err');
      tabAlert();
    } finally {
      jobRef.current = null;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (aliveRef.current) setGenerating(false);
    }
  }

  // Re-attach to a still-running job after a reload / tab switch, so closing
  // the page mid-generation loses nothing.
  useEffect(() => {
    api.get<{ jobId?: string; createdAt?: number }>('/api/images/jobs/active')
      .then((r) => {
        if (r.jobId) void runJob(r.jobId, r.createdAt ?? Date.now());
      })
      .catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    const p = prompt.trim();
    if (!p || !model || generating) return;
    setGenerating(true);
    setGenError(null);
    const start = Date.now();
    startElapsedTimer(start);
    let jobId: string;
    try {
      const body: Record<string, unknown> = { modelId: model.id, prompt: p, n };
      const refIds = refSlots.filter((x): x is string => !!x);
      if (refIds.length) body.inputUploadIds = refIds;
      ({ jobId } = await api.post<{ jobId: string }>('/api/images/generate', body));
    } catch (err) {
      // The submit response can get lost in transit (e.g. a proxy cutting the
      // connection) while the server accepted the job — ask it before failing.
      const active = await api.get<{ jobId?: string; createdAt?: number }>('/api/images/jobs/active')
        .catch(() => null);
      if (active?.jobId) {
        void runJob(active.jobId, active.createdAt ?? start);
        return;
      }
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setGenerating(false);
      const msg = err instanceof Error ? err.message : '生成失败';
      setGenError(msg);
      toast(msg, 'err');
      tabAlert();
      return;
    }
    void runJob(jobId, start);
  }

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.get<{ images: ImageRecord[]; total: number }>(
        `/api/images?limit=${PAGE_SIZE}&offset=${list.length}`,
      );
      setList((prev) => [...prev, ...(r.images ?? [])]);
      setTotal(r.total ?? total);
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载失败', 'err');
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteImage(img: ImageRecord) {
    if (!(await confirmDialog('删除图片', '确定删除这张图片?此操作不可恢复。'))) return;
    try {
      await api.del(`/api/images/${img.id}`);
      setList((prev) => prev.filter((x) => x.id !== img.id));
      setTotal((t) => Math.max(0, t - 1));
      setLightbox(null);
      toast('已删除', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'err');
    }
  }

  const canGenerate = !!prompt.trim() && !!model && !generating && !uploading;

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
            bodyClassName={models === null || models.length === 0 ? '!p-0' : ''}>
            {models === null ? (
              <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>
            ) : models.length === 0 ? (
              <EmptyState
                icon={<ImageIcon size={22} />}
                title="管理员尚未配置图像模型"
                hint="请联系管理员在后台添加支持图像生成的模型后再来创作。"
              />
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
                    {quick.map((q) => (
                      <button
                        key={q}
                        type="button"
                        title="点击填入提示词"
                        onClick={() => applyQuickPrompt(q)}
                        className="cursor-pointer rounded-full border border-line bg-bg1 px-2.5 py-1 text-xs text-tx2 transition-colors hover:border-line2 hover:bg-bg2 hover:text-tx"
                      >
                        {q}
                      </button>
                    ))}
                    <button
                      type="button"
                      title="管理快捷提示词"
                      onClick={() => { setQuickDraft(quick.length ? [...quick] : ['']); setQuickOpen(true); }}
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
                          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] leading-none text-white">
                            图{i + 1}
                          </span>
                          <button
                            type="button"
                            title="移除"
                            onClick={() => setRefSlots((prev) => prev.map((x, j) => (j === i ? null : x)))}
                            className="absolute right-1 top-1 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/70 text-white ring-1 ring-white/70 transition-colors hover:bg-err"
                          >
                            <X size={15} />
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
                    生成失败:{genError}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs leading-relaxed text-tx3">
                    部分模型生成需要几分钟,请耐心等待;期间可切到其他标签页,完成后标签会有提示。Cmd / Ctrl + Enter 快速提交。
                  </p>
                  <Button variant="primary" disabled={!canGenerate} onClick={generate} className="shrink-0">
                    {generating
                      ? <><Spinner className="h-4 w-4" />生成中 {elapsed.toFixed(1)}s</>
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
              {list.length > 0 && (
                <span className="text-xs tabular-nums text-tx3">显示 {list.length} / {total}</span>
              )}
            </div>
            {!galleryLoaded ? (
              <div className="flex justify-center py-16"><Spinner className="h-5 w-5" /></div>
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
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {list.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => setLightbox(img)}
                      className="group relative aspect-square cursor-pointer overflow-hidden rounded-lg border border-line bg-bg1 text-left shadow-xs transition-shadow hover:shadow-md"
                    >
                      <img
                        loading="lazy"
                        src={`/api/images/${img.id}/file`}
                        alt={img.prompt}
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2.5 pt-10 opacity-0 transition-opacity group-hover:opacity-100">
                        <p className="line-clamp-2 text-[11px] leading-snug text-white">{img.prompt}</p>
                        {img.model && (
                          <span className="mt-1.5 inline-block max-w-full truncate rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px] text-white">
                            {img.model}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                {list.length < total && (
                  <div className="mt-5 flex justify-center">
                    <Button variant="outline" disabled={loadingMore} onClick={loadMore}>
                      {loadingMore && <Spinner className="h-3.5 w-3.5" />}
                      {loadingMore ? '加载中…' : '加载更多'}
                    </Button>
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
              className="mx-auto max-h-[62vh] rounded-lg border border-line object-contain"
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
        desc="常用的提示词片段,点击即可填入。">
        <div className="space-y-2">
          {quickDraft.map((q, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={q}
                maxLength={200}
                placeholder="输入提示词,例如:去背景"
                onChange={(e) => setQuickDraft((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <Button
                variant="ghost" size="icon" title="删除"
                onClick={() => setQuickDraft((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {quickDraft.length === 0 && (
            <p className="py-1 text-xs text-tx3">暂无快捷提示词,点击下方按钮添加。</p>
          )}
          <Button variant="outline" size="sm" onClick={() => setQuickDraft((prev) => [...prev, ''])}>
            <Plus size={14} />添加一条
          </Button>
        </div>
        <ModalActions>
          <Button variant="outline" onClick={() => setQuickOpen(false)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              saveQuick(quickDraft.map((x) => x.trim()).filter(Boolean));
              setQuickOpen(false);
            }}
          >
            保存
          </Button>
        </ModalActions>
      </Modal>

      {/* ---- lightbox ---- */}
      <Modal open={!!lightbox} onClose={() => setLightbox(null)} title="图片详情" wide>
        {lightbox && (
          <div className="space-y-4">
            <img
              src={`/api/images/${lightbox.id}/file`}
              alt={lightbox.prompt}
              className="mx-auto max-h-[58vh] rounded-lg border border-line object-contain"
            />
            <p className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-tx2">{lightbox.prompt}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs tabular-nums text-tx3">
              {lightbox.model && <Badge mono>{lightbox.model}</Badge>}
              {lightbox.size && <span>尺寸 {lightbox.size}</span>}
              <span>耗时 {fmtDuration(lightbox.durationMs)}</span>
              <span>{fmtTime(lightbox.createdAt)}</span>
              {lightbox.tokens != null && lightbox.tokens > 0 && <span>Tokens {fmtTokens(lightbox.tokens)}</span>}
            </div>
            <ModalActions>
              <a
                href={`/api/images/${lightbox.id}/file`}
                download
                className="inline-flex h-9 cursor-pointer select-none items-center justify-center gap-1.5 rounded-md border border-line2 bg-bg1 px-3.5 text-[13px] font-medium leading-none text-tx shadow-xs transition-colors hover:bg-bg2"
              >
                <Download size={14} />下载
              </a>
              <Button variant="danger" onClick={() => deleteImage(lightbox)}>
                <Trash2 size={14} />删除
              </Button>
            </ModalActions>
          </div>
        )}
      </Modal>
    </div>
  );
}
