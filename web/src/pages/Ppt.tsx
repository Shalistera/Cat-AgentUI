import { useEffect, useRef, useState } from 'react';
import {
  PanelLeft, Presentation, Sparkles, Download, Trash2, FileText,
} from 'lucide-react';
import { useUi } from '../store';
import { api, ApiError, fmtDuration, fmtTime, fmtTokens } from '../api';
import { tabAlert } from '../tabAlert';
import {
  Button, btnClass, Input, Textarea, Select, Field, Modal, ModalActions, Badge, Spinner, Card, PageHeader,
  toast, confirmDialog, EmptyState,
} from '../components/ui';
import type { DeckDetail, DeckSlide, DeckSummary, PptModel } from '../types';

const PAGE_SIZE = 30;

// ---- slide preview ----
// The preview mirrors the .pptx renderer (server/src/deck.ts): same canvas
// proportions, same ink/grey/accent palette. Sizes are in cqw so a slide reads
// identically at thumbnail and modal width. The design canvas is 960pt wide,
// so font-pt → cqw is n / 9.6.
const INK = '#14181F';
const GREY = '#55606F';
const LIGHT = '#F1F3F6';
const LINE = '#E4E7EC';

function pt(n: number) {
  return `${(n / 9.6).toFixed(2)}cqw`;
}

export function SlideView({ s, index, accent, deckTitle }: {
  s: DeckSlide; index: number; accent: string; deckTitle: string;
}) {
  const acc = `#${accent}`;

  const footer = (
    <div
      className="absolute inset-x-[5.5cqw] bottom-[1.8cqw] flex items-center justify-between"
      style={{ fontSize: pt(9), color: GREY }}
    >
      <span className="max-w-[70%] truncate">{deckTitle}</span>
      <span className="tabular-nums">{index + 1}</span>
    </div>
  );

  const header = (title: string) => (
    <div className="px-[5.5cqw] pt-[5.5cqw]">
      <div className="font-bold leading-tight" style={{ fontSize: pt(24), color: INK }}>{title}</div>
      <div className="mt-[1.4cqw] h-[0.7cqw] w-[9cqw] rounded-full" style={{ background: acc }} />
    </div>
  );

  let body: React.ReactNode;
  switch (s.layout) {
    case 'cover':
      body = (
        <div className="flex h-full flex-col justify-center px-[8cqw]" style={{ background: acc }}>
          <div className="h-[0.9cqw] w-[11cqw] bg-white" />
          <div className="mt-[3cqw] font-bold leading-tight text-white" style={{ fontSize: pt(34) }}>{s.title}</div>
          {s.subtitle && (
            <div className="mt-[2.4cqw] text-white/85" style={{ fontSize: pt(15) }}>{s.subtitle}</div>
          )}
        </div>
      );
      break;
    case 'section':
      body = (
        <div className="h-full">
          <div className="absolute inset-y-0 left-0 w-[2.5cqw]" style={{ background: acc }} />
          <div className="flex h-full flex-col justify-center px-[8cqw]">
            <div className="font-bold" style={{ fontSize: pt(40), color: acc, opacity: 0.55 }}>
              {String(index + 1).padStart(2, '0')}
            </div>
            <div className="mt-[1cqw] font-bold leading-tight" style={{ fontSize: pt(28), color: INK }}>{s.title}</div>
            {s.subtitle && (
              <div className="mt-[1.8cqw] leading-snug" style={{ fontSize: pt(14), color: GREY }}>{s.subtitle}</div>
            )}
          </div>
          {footer}
        </div>
      );
      break;
    case 'bullets':
      body = (
        <div className="h-full">
          {header(s.title)}
          <div className="space-y-[1.8cqw] px-[5.5cqw] pt-[3cqw]">
            {s.points.map((p, i) => (
              <div key={i}>
                <div className="flex gap-[1.6cqw] leading-snug" style={{ fontSize: pt(15), color: INK }}>
                  <span style={{ color: acc }}>●</span>
                  <span className="min-w-0">{p.text}</span>
                </div>
                {(p.sub ?? []).map((t, j) => (
                  <div
                    key={j}
                    className="ml-[5cqw] mt-[0.8cqw] flex gap-[1.4cqw] leading-snug"
                    style={{ fontSize: pt(12.5), color: GREY }}
                  >
                    <span>–</span>
                    <span className="min-w-0">{t}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {footer}
        </div>
      );
      break;
    case 'twoCol':
      body = (
        <div className="h-full">
          {header(s.title)}
          <div className="grid grid-cols-2 gap-[3cqw] px-[5.5cqw] pt-[3cqw]">
            {s.columns.slice(0, 2).map((col, ci) => (
              <div key={ci} className="rounded-[1.2cqw] p-[2.5cqw]" style={{ background: LIGHT }}>
                <div className="font-bold" style={{ fontSize: pt(15), color: acc }}>{col.heading}</div>
                <div className="mt-[1.6cqw] space-y-[1.2cqw]">
                  {col.points.map((t, i) => (
                    <div key={i} className="flex gap-[1.4cqw] leading-snug" style={{ fontSize: pt(12.5), color: INK }}>
                      <span style={{ color: acc }}>●</span>
                      <span className="min-w-0">{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {footer}
        </div>
      );
      break;
    case 'table':
      body = (
        <div className="h-full">
          {header(s.title)}
          <div className="px-[5.5cqw] pt-[3cqw]">
            <table className="w-full border-collapse" style={{ fontSize: pt(12) }}>
              <thead>
                <tr>
                  {s.headers.map((h, i) => (
                    <th
                      key={i}
                      className="border px-[1.6cqw] py-[1cqw] text-left font-bold text-white"
                      style={{ background: acc, borderColor: LINE }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, ri) => (
                  <tr key={ri}>
                    {s.headers.map((_, ci) => (
                      <td key={ci} className="border px-[1.6cqw] py-[1cqw]" style={{ color: INK, borderColor: LINE }}>
                        {r[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {footer}
        </div>
      );
      break;
    case 'quote':
      body = (
        <div className="h-full">
          <div className="absolute left-[6cqw] top-[2cqw] font-bold" style={{ fontSize: pt(96), color: acc, opacity: 0.7 }}>
            “
          </div>
          <div className="flex h-full flex-col items-center justify-center px-[12cqw] text-center">
            <div className="italic leading-relaxed" style={{ fontSize: pt(20), color: INK }}>{s.quote}</div>
            {s.author && (
              <div className="mt-[2.5cqw]" style={{ fontSize: pt(13), color: GREY }}>— {s.author}</div>
            )}
          </div>
          {footer}
        </div>
      );
      break;
    case 'end':
      body = (
        <div className="flex h-full flex-col justify-center px-[8cqw]" style={{ background: INK }}>
          <div className="h-[0.9cqw] w-[11cqw]" style={{ background: acc }} />
          <div className="mt-[3cqw] font-bold leading-tight text-white" style={{ fontSize: pt(30) }}>{s.title}</div>
          {s.subtitle && (
            <div className="mt-[2.2cqw] text-white/80" style={{ fontSize: pt(14) }}>{s.subtitle}</div>
          )}
        </div>
      );
      break;
  }

  return (
    <div
      className="relative aspect-video w-full overflow-hidden bg-white"
      style={{ containerType: 'inline-size' }}
    >
      {body}
    </div>
  );
}

export default function Ppt() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  // ---- generation form ----
  const [models, setModels] = useState<PptModel[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [topic, setTopic] = useState('');
  // Kept as raw text so the field can be emptied while typing; clamped on submit.
  const [slideCount, setSlideCount] = useState('10');
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

  // ---- deck list ----
  const [list, setList] = useState<DeckSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preview, setPreview] = useState<DeckDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

  const model = models?.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    api.get<PptModel[]>('/api/ppt/models')
      .then((r) => {
        const arr = Array.isArray(r) ? r : [];
        setModels(arr);
        if (arr.length) setModelId((prev) => prev || arr[0].id);
      })
      .catch((err) => {
        setModels([]);
        toast(err instanceof Error ? err.message : '加载模型失败', 'err');
      });
    api.get<{ decks: DeckSummary[]; total: number }>(`/api/ppt?limit=${PAGE_SIZE}&offset=0`)
      .then((r) => { setList(r.decks ?? []); setTotal(r.total ?? 0); setListLoaded(true); })
      .catch((err) => {
        setListLoaded(true);
        toast(err instanceof Error ? err.message : '加载列表失败', 'err');
      });
  }, []);

  function startElapsedTimer(startedAt: number) {
    if (timerRef.current) clearInterval(timerRef.current);
    setElapsed((Date.now() - startedAt) / 1000);
    timerRef.current = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
  }

  // The job result may have landed in the library even when the job itself was
  // lost (server restart between polls) — check before surfacing an error.
  async function recoverFromLibrary(sinceTs: number): Promise<number> {
    try {
      const r = await api.get<{ decks: DeckSummary[]; total: number }>(`/api/ppt?limit=${PAGE_SIZE}&offset=0`);
      const fresh = (r.decks ?? []).filter((d) => d.createdAt > sinceTs);
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

  async function runJob(jobId: string, startedAt: number) {
    if (jobRef.current === jobId) return;
    jobRef.current = jobId;
    setGenerating(true);
    startElapsedTimer(startedAt);
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!aliveRef.current) return;
        let st: { status: string; deck?: DeckDetail; error?: string };
        try {
          st = await api.get<typeof st>(`/api/ppt/jobs/${jobId}`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) throw new Error('任务状态已丢失(服务器可能重启过)');
          if (Date.now() - startedAt > 8 * 60_000) throw new Error('等待超时,已放弃');
          continue;
        }
        if (st.status === 'error') throw new Error(st.error || '生成失败');
        if (st.status === 'done' && st.deck) {
          const deck = st.deck;
          setList((prev) => (prev.some((x) => x.id === deck.id) ? prev : [deck, ...prev]));
          setTotal((t) => t + 1);
          setPreview(deck);
          toast(`已生成「${deck.title}」,共 ${deck.slideCount} 页`, 'ok');
          tabAlert();
          return;
        }
      }
    } catch (err) {
      const recovered = await recoverFromLibrary(startedAt);
      if (recovered > 0) {
        toast('生成完成(已从列表找回)', 'ok');
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

  // Re-attach to a still-running job after reload / tab switch.
  useEffect(() => {
    api.get<{ jobId?: string; createdAt?: number }>('/api/ppt/jobs/active')
      .then((r) => { if (r.jobId) void runJob(r.jobId, r.createdAt ?? Date.now()); })
      .catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    const t = topic.trim();
    if (!t || !model || generating) return;
    setGenerating(true);
    setGenError(null);
    const start = Date.now();
    startElapsedTimer(start);
    let jobId: string;
    try {
      ({ jobId } = await api.post<{ jobId: string }>('/api/ppt/generate', {
        modelId: model.id, topic: t,
        slideCount: Math.min(30, Math.max(2, Math.round(Number(slideCount)) || 10)),
      }));
    } catch (err) {
      const active = await api.get<{ jobId?: string; createdAt?: number }>('/api/ppt/jobs/active')
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
      return;
    }
    void runJob(jobId, start);
  }

  async function openDeck(d: DeckSummary) {
    if (previewLoading) return;
    setPreviewLoading(d.id);
    try {
      setPreview(await api.get<DeckDetail>(`/api/ppt/${d.id}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载失败', 'err');
    } finally {
      setPreviewLoading(null);
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.get<{ decks: DeckSummary[]; total: number }>(
        `/api/ppt?limit=${PAGE_SIZE}&offset=${list.length}`,
      );
      setList((prev) => [...prev, ...(r.decks ?? [])]);
      setTotal(r.total ?? total);
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载失败', 'err');
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteDeck(d: DeckSummary) {
    if (!(await confirmDialog('删除演示文稿', `确定删除「${d.title}」?此操作不可恢复。`))) return;
    try {
      await api.del(`/api/ppt/${d.id}`);
      setList((prev) => prev.filter((x) => x.id !== d.id));
      setTotal((t) => Math.max(0, t - 1));
      setPreview((p) => (p?.id === d.id ? null : p));
      toast('已删除', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'err');
    }
  }

  const canGenerate = !!topic.trim() && !!model && !generating;
  const accent = (preview?.spec.accent ?? '1F4FD8').replace(/[^0-9a-fA-F]/g, '').padEnd(6, '0').slice(0, 6);

  return (
    <div className="contents">
      <PageHeader
        title="PPT 工坊"
        subtitle={total > 0 ? `已生成 ${total.toLocaleString()} 份演示文稿` : '一句话生成演示文稿(演示功能)'}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />

      <div className="flex-1 overflow-y-auto bg-bg0">
        <div className="mx-auto max-w-5xl p-6">
          {/* ---- generation form ---- */}
          <Card title="新建演示文稿" desc="描述主题与要求,AI 负责大纲、内容与版式,生成后可下载 .pptx。" className="fade-up"
            flush={models === null || models.length === 0}>
            {models === null ? (
              <div className="flex justify-center py-10 text-tx3"><Spinner className="h-5 w-5" /></div>
            ) : models.length === 0 ? (
              <EmptyState
                icon={<Presentation size={22} />}
                title="管理员尚未配置对话模型"
                hint="生成演示文稿需要一个文本对话模型,请联系管理员在后台添加。"
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
                  <Field label="目标页数(2-30)">
                    <Input
                      type="number" min={2} max={30} step={1} inputMode="numeric"
                      value={slideCount}
                      onChange={(e) => setSlideCount(e.target.value)}
                      placeholder="10"
                    />
                  </Field>
                </div>

                <Field label="主题与要求">
                  <Textarea
                    rows={3}
                    value={topic}
                    maxLength={4000}
                    placeholder="例如:面向新员工的信息安全培训,风格轻松,包含常见钓鱼案例和应对清单…"
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void generate(); }
                    }}
                  />
                </Field>

                {genError && (
                  <div className="whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                    生成失败:{genError}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs leading-relaxed text-tx3">
                    生成通常需要半分钟到两分钟;完成后自动打开预览,可下载 .pptx 到 PowerPoint / WPS / Keynote 继续编辑。Cmd / Ctrl + Enter 快速提交。
                  </p>
                  <Button variant="primary" disabled={!canGenerate} onClick={generate} className="shrink-0">
                    {generating
                      ? <><Spinner className="h-4 w-4" />生成中 {elapsed.toFixed(1)}s</>
                      : <><Sparkles size={15} />生成 PPT</>}
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* ---- deck library ---- */}
          <section className="mt-5">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="eyebrow">文稿库</h2>
              {list.length > 0 && (
                <span className="text-xs tabular-nums text-tx3">显示 {list.length} / {total}</span>
              )}
            </div>
            {!listLoaded ? (
              <div className="flex justify-center py-16 text-tx3"><Spinner className="h-5 w-5" /></div>
            ) : list.length === 0 ? (
              <Card flush>
                <EmptyState
                  icon={<Presentation size={22} />}
                  title="还没有生成过演示文稿"
                  hint="在上方输入主题,生成你的第一份 PPT。"
                />
              </Card>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => void openDeck(d)}
                      className="group cursor-pointer rounded-lg border border-line bg-bg1 p-3.5 text-left shadow-xs transition-colors hover:border-line2 hover:bg-bg2"
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-acc/10 text-acc">
                          {previewLoading === d.id ? <Spinner className="h-4 w-4" /> : <Presentation size={16} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-tx">{d.title || '未命名'}</span>
                          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-tx3">{d.topic}</span>
                        </span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-tx3">
                        <span>{d.slideCount} 页</span>
                        {d.model && <span className="max-w-[10rem] truncate font-mono">{d.model}</span>}
                        <span>{fmtTime(d.createdAt)}</span>
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

      {/* ---- preview ---- */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.title || '演示文稿'} wide>
        {preview && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs tabular-nums text-tx3">
              {preview.model && <Badge mono>{preview.model}</Badge>}
              <span>{preview.slideCount} 页</span>
              <span>耗时 {fmtDuration(preview.durationMs)}</span>
              {preview.totalTokens != null && preview.totalTokens > 0 && (
                <span>Tokens {fmtTokens(preview.totalTokens)}</span>
              )}
              <span>{fmtTime(preview.createdAt)}</span>
            </div>

            {/* Matte behind the white slides — in dark mode a bare white
                stack on bg1 glares; bg0 reads as a projector wall. */}
            <div className="max-h-[58vh] space-y-4 overflow-y-auto rounded-xl bg-bg0 p-3">
              {preview.spec.slides.map((s, i) => (
                <div key={i}>
                  <div className="overflow-hidden rounded-lg border border-line shadow-xs">
                    <SlideView s={s} index={i} accent={accent} deckTitle={preview.spec.title} />
                  </div>
                  {s.notes && (
                    <p className="mt-1 flex items-start gap-1 px-0.5 text-[11px] leading-relaxed text-tx3">
                      <FileText size={11} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">备注:{s.notes}</span>
                    </p>
                  )}
                </div>
              ))}
            </div>

            <ModalActions>
              <a
                href={`/api/ppt/${preview.id}/pptx`}
                download
                className={btnClass('primary', 'md')}
              >
                <Download size={14} />下载 .pptx
              </a>
              <Button variant="danger" onClick={() => deleteDeck(preview)}>
                <Trash2 size={14} />删除
              </Button>
            </ModalActions>
          </div>
        )}
      </Modal>
    </div>
  );
}
