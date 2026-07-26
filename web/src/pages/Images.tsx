import { useEffect, useRef, useState } from 'react';
import {
  PanelLeft, ImagePlus, Sparkles, X, Download, Trash2, Image as ImageIcon,
} from 'lucide-react';
import { useUi } from '../store';
import { api, uploadFile, fmtDuration, fmtTime, fmtTokens } from '../api';
import {
  Button, Textarea, Select, Field, Modal, Badge, Spinner, toast, confirmDialog, EmptyState,
} from '../components/ui';
import type { ImageModel, ImageRecord } from '../types';

const PAGE_SIZE = 60;
const OPENAI_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const OPENAI_QUALITIES = ['auto', 'low', 'medium', 'high'];
const GEMINI_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'];

export default function Images() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  // ---- generation form state ----
  const [models, setModels] = useState<ImageModel[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('auto');
  const [quality, setQuality] = useState('auto');
  const [n, setN] = useState(1);
  const [refIds, setRefIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // ---- gallery state ----
  const [list, setList] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [galleryLoaded, setGalleryLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lightbox, setLightbox] = useState<ImageRecord | null>(null);

  const model = models?.find((m) => m.id === modelId) ?? null;

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

  function selectModel(id: string) {
    setModelId(id);
    setSize('auto');
    setQuality('auto');
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const room = 4 - refIds.length;
    if (files.length > room) toast('参考图最多 4 张', 'err');
    const take = files.slice(0, Math.max(0, room));
    if (!take.length) return;
    setUploading(true);
    try {
      for (const f of take) {
        const r = await uploadFile(f);
        setRefIds((prev) => (prev.length >= 4 ? prev : [...prev, r.id]));
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '上传失败', 'err');
    } finally {
      setUploading(false);
    }
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
      if ((model.providerType === 'openai' || model.providerType === 'gemini') && size !== 'auto') body.size = size;
      if (model.providerType === 'openai' && quality !== 'auto') body.quality = quality;
      if (refIds.length) body.inputUploadIds = refIds;
      const r = await api.post<{ images: ImageRecord[] }>('/api/images/generate', body);
      const imgs = r.images ?? [];
      setList((prev) => [...imgs, ...prev]);
      setTotal((t) => t + imgs.length);
      setPrompt('');
      toast(`已生成 ${imgs.length} 张图片`, 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '生成失败', 'err');
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        {!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
        <h1 className="text-sm font-semibold">绘图工坊</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-6">
          {/* ---- generation form ---- */}
          <section className="fade-up rounded-2xl border border-line bg-bg1 p-5">
            {models === null ? (
              <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>
            ) : models.length === 0 ? (
              <EmptyState
                icon={<ImageIcon size={28} />}
                title="管理员尚未配置图像模型"
                hint="请联系管理员在后台添加支持图像生成的模型后再来创作。"
              />
            ) : (
              <div className="space-y-4">
                <Field label="模型">
                  <Select value={modelId} onChange={(e) => selectModel(e.target.value)}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {`${m.displayName || m.modelId} · ${m.providerName}`}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="提示词">
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
                </Field>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {model?.providerType === 'openai' && (
                    <>
                      <Field label="尺寸">
                        <Select value={size} onChange={(e) => setSize(e.target.value)}>
                          {OPENAI_SIZES.map((s) => <option key={s} value={s}>{s === 'auto' ? '自动' : s}</option>)}
                        </Select>
                      </Field>
                      <Field label="质量">
                        <Select value={quality} onChange={(e) => setQuality(e.target.value)}>
                          {OPENAI_QUALITIES.map((q) => <option key={q} value={q}>{q === 'auto' ? '自动' : q}</option>)}
                        </Select>
                      </Field>
                    </>
                  )}
                  {model?.providerType === 'gemini' && (
                    <Field label="宽高比">
                      <Select value={size} onChange={(e) => setSize(e.target.value)}>
                        {GEMINI_RATIOS.map((s) => <option key={s} value={s}>{s === 'auto' ? '自动' : s}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Field label="数量">
                    <Select value={String(n)} onChange={(e) => setN(Number(e.target.value))}>
                      {[1, 2, 3, 4].map((i) => <option key={i} value={i}>{i} 张</option>)}
                    </Select>
                  </Field>
                </div>

                <div>
                  <div className="mb-1.5 text-xs font-medium text-tx2">参考图</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {refIds.map((id) => (
                      <div key={id} className="relative h-16 w-16 shrink-0">
                        <img
                          src={`/api/uploads/${id}/file`}
                          alt="参考图"
                          className="h-16 w-16 rounded-lg border border-line object-cover"
                        />
                        <button
                          type="button"
                          title="移除"
                          onClick={() => setRefIds((prev) => prev.filter((x) => x !== id))}
                          className="absolute -right-1.5 -top-1.5 flex h-4.5 w-4.5 cursor-pointer items-center justify-center rounded-full border border-line2 bg-bg3 text-tx2 hover:bg-err/20 hover:text-err"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    {refIds.length < 4 && (
                      <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                        {uploading ? <Spinner className="h-3.5 w-3.5" /> : <ImagePlus size={14} />}
                        {uploading ? '上传中…' : '添加参考图'}
                      </Button>
                    )}
                    <input
                      ref={fileRef} type="file" accept="image/*" multiple hidden
                      onChange={onPickFiles}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-tx3">可选,最多 4 张,作为图像编辑 / 参考输入。</div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] text-tx3">部分模型生成可能需要 1–3 分钟,请耐心等待。Cmd/Ctrl + Enter 快速提交。</p>
                  <Button variant="primary" disabled={!canGenerate} onClick={generate} className="shrink-0">
                    {generating
                      ? <><Spinner className="h-4 w-4" />生成中 {elapsed.toFixed(1)}s…</>
                      : <><Sparkles size={15} />生成图片</>}
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* ---- gallery ---- */}
          <section className="mt-6">
            {!galleryLoaded ? (
              <div className="flex justify-center py-16"><Spinner className="h-5 w-5" /></div>
            ) : list.length === 0 ? (
              <EmptyState
                icon={<ImageIcon size={28} />}
                title="还没有生成过图片"
                hint="在上方输入提示词,开始你的第一次创作吧。"
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {list.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => setLightbox(img)}
                      className="group relative aspect-square cursor-pointer overflow-hidden rounded-xl border border-line bg-bg1 text-left"
                    >
                      <img
                        loading="lazy"
                        src={`/api/images/${img.id}/file`}
                        alt={img.prompt}
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-2.5 pt-8 opacity-0 transition-opacity group-hover:opacity-100">
                        <p className="truncate text-xs text-white">{img.prompt}</p>
                        {img.model && (
                          <span className="mt-1 inline-block max-w-full truncate rounded bg-white/15 px-1.5 py-0.5 text-[10px] text-white/90">
                            {img.model}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                {list.length < total && (
                  <div className="mt-5 flex justify-center">
                    <Button variant="subtle" disabled={loadingMore} onClick={loadMore}>
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

      {/* ---- lightbox ---- */}
      <Modal open={!!lightbox} onClose={() => setLightbox(null)} title="图片详情" wide>
        {lightbox && (
          <div className="space-y-4">
            <img
              src={`/api/images/${lightbox.id}/file`}
              alt={lightbox.prompt}
              className="mx-auto max-h-[60vh] rounded-xl object-contain"
            />
            <p className="select-text whitespace-pre-wrap text-sm text-tx2">{lightbox.prompt}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-tx3">
              {lightbox.model && <Badge tone="acc">{lightbox.model}</Badge>}
              {lightbox.size && <span>尺寸 {lightbox.size}</span>}
              <span>耗时 {fmtDuration(lightbox.durationMs)}</span>
              <span>{fmtTime(lightbox.createdAt)}</span>
              {lightbox.tokens != null && lightbox.tokens > 0 && <span>Tokens {fmtTokens(lightbox.tokens)}</span>}
            </div>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <a
                href={`/api/images/${lightbox.id}/file`}
                download
                className="inline-flex cursor-pointer select-none items-center justify-center gap-1.5 rounded-lg border border-line bg-bg2 px-3.5 py-2 text-sm font-medium text-tx transition-colors hover:bg-bg3"
              >
                <Download size={14} />下载
              </a>
              <Button variant="danger" onClick={() => deleteImage(lightbox)}>
                <Trash2 size={14} />删除
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
