import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanelLeft, ImagePlus, Sparkles, X, Download, Trash2, Image as ImageIcon,
  History, Settings2, Plus,
} from 'lucide-react';
import { useUi, useAuth } from '../store';
import { api, uploadFile, fmtDuration, fmtTime, fmtTokens } from '../api';
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
  const [refIds, setRefIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);

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

  async function addFiles(files: File[]) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const room = MAX_REFS - refIds.length;
    if (imgs.length > room) toast(`参考图最多 ${MAX_REFS} 张`, 'err');
    const take = imgs.slice(0, Math.max(0, room));
    if (!take.length) return;
    setUploading(true);
    try {
      for (const f of take) {
        const r = await uploadFile(f);
        setRefIds((prev) => (prev.length >= MAX_REFS ? prev : [...prev, r.id]));
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '上传失败', 'err');
    } finally {
      setUploading(false);
    }
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    void addFiles(files);
  }

  async function onReplaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    const target = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!f || !target) return;
    setUploading(true);
    try {
      const r = await uploadFile(f);
      setRefIds((prev) => prev.map((x) => (x === target ? r.id : x)));
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

  async function generate() {
    const p = prompt.trim();
    if (!p || !model || generating) return;
    setGenerating(true);
    setElapsed(0);
    const start = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    try {
      const body: Record<string, unknown> = { modelId: model.id, prompt: p, n };
      if (refIds.length) body.inputUploadIds = refIds;
      const r = await api.post<{ images: ImageRecord[] }>('/api/images/generate', body);
      const imgs = r.images ?? [];
      setList((prev) => [...imgs, ...prev]);
      setTotal((t) => t + imgs.length);
      // Prompt and reference images stay put on purpose — iterating on the
      // same inputs is the common case.
      toast(`已生成 ${imgs.length} 张图片`, 'ok');
      tabAlert();
    } catch (err) {
      toast(err instanceof Error ? err.message : '生成失败', 'err');
      tabAlert();
    } finally {
      clearInterval(timer);
      setGenerating(false);
    }
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
    <>
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
                  <Field label="数量">
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
                    onClick={() => {
                      if (uploading) return;
                      if (refIds.length >= MAX_REFS) { toast(`参考图最多 ${MAX_REFS} 张`, 'err'); return; }
                      fileRef.current?.click();
                    }}
                    className={`flex min-h-24 cursor-pointer flex-wrap items-center gap-2 rounded-lg border border-dashed p-3 transition-colors ${
                      dragOver ? 'border-acc bg-acc/5' : 'border-line2 hover:border-tx3'
                    }`}
                  >
                    {refIds.map((id) => (
                      <div key={id} className="group/ref relative h-16 w-16 shrink-0">
                        <button
                          type="button"
                          title="点击更换参考图"
                          disabled={uploading}
                          onClick={(e) => {
                            e.stopPropagation();
                            replaceTargetRef.current = id;
                            replaceFileRef.current?.click();
                          }}
                          className="block h-16 w-16 cursor-pointer overflow-hidden rounded-md border border-line transition-colors hover:border-line2"
                        >
                          <img
                            src={`/api/uploads/${id}/file`}
                            alt="参考图"
                            className="h-full w-full object-cover"
                          />
                          <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45 text-[10px] text-white opacity-0 transition-opacity group-hover/ref:opacity-100">
                            更换
                          </span>
                        </button>
                        <button
                          type="button"
                          title="移除"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRefIds((prev) => prev.filter((x) => x !== id));
                          }}
                          className="absolute -right-1.5 -top-1.5 z-10 flex h-4.5 w-4.5 cursor-pointer items-center justify-center rounded-full border border-line bg-bg1 text-tx2 shadow-sm transition-colors hover:border-err/50 hover:text-err"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    {uploading && (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-line2">
                        <Spinner className="h-4 w-4" />
                      </div>
                    )}
                    {refIds.length === 0 && !uploading ? (
                      <div className="flex w-full flex-col items-center gap-1 py-2 text-tx3">
                        <ImagePlus size={18} />
                        <span className="text-xs">点击选择,或拖拽 / Ctrl+V 粘贴图片到此处</span>
                      </div>
                    ) : refIds.length < MAX_REFS && !uploading ? (
                      <div
                        title="添加参考图"
                        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-line2 text-tx3 transition-colors hover:border-tx3 hover:text-tx"
                      >
                        <ImagePlus size={16} />
                      </div>
                    ) : null}
                  </div>
                  <input
                    ref={fileRef} type="file" accept="image/*" multiple hidden
                    onChange={onPickFiles}
                  />
                  <input
                    ref={replaceFileRef} type="file" accept="image/*" hidden
                    onChange={onReplaceFile}
                  />
                  <div className="mt-1.5 text-xs text-tx3">
                    可选,最多 {MAX_REFS} 张;支持拖拽、Ctrl+V 粘贴,点击缩略图可更换。
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs leading-relaxed text-tx3">
                    部分模型生成需要 1–3 分钟。Cmd / Ctrl + Enter 快速提交。
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
    </>
  );
}
