import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Copy, Dices, Download, FileText, Images as ImagesIcon, Languages, Lock, LockOpen,
  Maximize2, Palette, PanelLeft, RefreshCw, RotateCcw, Sparkles, Tags, Trash2,
} from 'lucide-react';
import { useAuth, useUi } from '../store';
import { api, ApiError, fmtDuration, fmtModelName, fmtTime } from '../api';
import { tabAlert } from '../tabAlert';
import { notifyDone } from '../notify';
import {
  Button, EmptyState, Field, Input, PageHeader, SegmentedControl, Select, Spinner, Toggle, btnClass, confirmDialog, toast,
} from '../components/ui';
import { useLightbox } from '../components/Lightbox';
import { NoWorkshopAccess } from '../components/NoWorkshopAccess';
import { CharacterList, Collapsible, PanelSection, Slider, StylePicker, TagTextarea } from '../components/NaiControls';
import {
  NAI_DEFAULTS, NAI_EXAMPLES, NAI_SIZE_OPTIONS, NAI_UC_OPTIONS, advancedChanged, naiImageInfo, newNaiDraft,
  normalizeNaiDraft, sourceSignature, tagsMark, type NaiDraft, type NaiImageInfo, type NaiOptions, type NaiStyle,
} from '../novelai';
import type { ImageModel, ImageRecord } from '../types';

type NaiConfig = { uc: Record<string, string>; helpers: { id: string; name: string; isDefault: boolean }[] };
type Subscription = { available: boolean; active: boolean; opus: boolean; percent: number | null; anlas: number | null; refillSeconds: number | null; reason: string | null };
type Prepared = { basePrompt: string; negativePrompt: string; characters: { prompt: string; negativePrompt: string }[] };
type Job = { id: string; modelId: string; startedAt: number; size: string; cancelling?: boolean };
type ActiveJobs = { jobs?: { jobId: string; modelId: string; createdAt: number; request?: { size?: string } }[] };
type JobStatus = { status: string; images?: ImageRecord[]; error?: string };
/** previewing = translating for a look only; preparing/submitting lead to a generation. */
type Phase = 'idle' | 'previewing' | 'preparing' | 'submitting';

const HISTORY_PAGE = 30;
/** The server reported the job failed (and rolled back) — nothing to recover. */
class JobFailed extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
// An empty SVG with the target pixel size: as an <img> it scales exactly like
// the finished picture will, so the placeholder frame never jumps.
const frameSrc = (size: string) => {
  const [w, h] = size.split('x');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`)}`;
};
const ratio = (size: string | null) => (size && /^\d+x\d+$/.test(size) ? size.replace('x', ' / ') : '1 / 1');
const CHECKER = { backgroundImage: 'conic-gradient(var(--color-bg2) 25%, var(--color-bg1) 0 50%, var(--color-bg2) 0 75%, var(--color-bg1) 0)', backgroundSize: '20px 20px' };
const SHIMMER = {
  background: 'linear-gradient(100deg, var(--color-bg2) 30%, var(--color-bg3) 50%, var(--color-bg2) 70%)',
  backgroundSize: '300% 100%', animation: 'shimmer 1.8s linear infinite',
};

function loadDraft(key: string): NaiDraft {
  try { return normalizeNaiDraft(JSON.parse(localStorage.getItem(key) || 'null')); } catch { return newNaiDraft(); }
}
function loadStyles(key: string): NaiStyle[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(list)) return [];
    return list.slice(0, 24).filter((s) => typeof s?.name === 'string' && typeof s?.tags === 'string')
      .map((s) => ({ name: s.name.slice(0, 40), tags: s.tags.slice(0, 2000), artists: normalizeNaiDraft({ options: { artists: s.artists } }).options.artists }));
  } catch { return []; }
}
function copy(text: string) {
  if (!navigator.clipboard) { toast('当前环境不支持复制，请手动选择文字', 'err'); return; }
  navigator.clipboard.writeText(text).then(() => toast('已复制', 'ok'), () => toast('复制失败，请手动选择文字', 'err'));
}

export default function NaiStudio() {
  const user = useAuth((s) => s.user);
  if (!user) return null;
  if (!user.allowImages) return <NoWorkshopAccess />;
  return <Studio key={user.id} userId={user.id} allowModels={user.allowImageModels} />;
}

function Studio({ userId, allowModels }: { userId: string; allowModels: boolean }) {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const [search, setSearch] = useSearchParams();
  const draftKey = `cat-nai-draft:${userId}`;
  const styleKey = `cat-nai-styles:${userId}`;
  const modelKey = `cat-nai-model:${userId}`;

  const [models, setModels] = useState<ImageModel[] | null>(null);
  const [modelId, setModelId] = useState(() => { try { return localStorage.getItem(modelKey) || ''; } catch { return ''; } });
  const [draft, setDraft] = useState(() => loadDraft(draftKey));
  const [styles, setStyles] = useState(() => loadStyles(styleKey));
  const [conf, setConf] = useState<NaiConfig | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState('');
  const [subTick, setSubTick] = useState(0);
  const [history, setHistory] = useState<ImageRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // A focused image that isn't in the loaded history page (opened via ?from=).
  const [extra, setExtra] = useState<ImageRecord | null>(null);
  // Image id on the canvas; 'pending' = the running job; null = newest.
  const [focus, setFocus] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [negOpen, setNegOpen] = useState(() => !!(draft.options.negativeDescription || draft.options.negativePrompt));
  const [advOpen, setAdvOpen] = useState(false);
  const [showPrepared, setShowPrepared] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [, setTick] = useState(0);

  const aliveRef = useRef(true);
  const trackedRef = useRef(new Set<string>());
  const attachedRef = useRef(false);
  const prepAbort = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;

  const naiModels = useMemo(() => (models ?? []).filter((m) => m.providerType === 'novelai'), [models]);
  const naiModelsRef = useRef(naiModels);
  naiModelsRef.current = naiModels;
  const hasGeneric = !!models?.some((m) => m.providerType !== 'novelai');
  const model = naiModels.find((m) => m.id === modelId) ?? naiModels[0] ?? null;
  const o = draft.options;
  const busy = phase !== 'idle' || !!job;
  const fresh = !draft.manual && draft.preparedFor === sourceSignature(draft) && !!o.basePrompt.trim();
  const helper = conf?.helpers.find((h) => h.id === draft.helperModelId) ?? null;
  const helperOn = draft.helperEnabled && !!helper;
  const pending = phase === 'preparing' || phase === 'submitting' || (!!job && focus === 'pending');
  const focused = pending ? null : history.find((i) => i.id === focus) ?? (extra && extra.id === focus ? extra : null) ?? history[0] ?? null;
  const info = useMemo(() => (focused ? naiImageInfo(focused) : null), [focused]);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; prepAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); setStorageWarning(false); } catch { setStorageWarning(true); }
  }, [draftKey, draft]);
  useEffect(() => {
    try { localStorage.setItem(styleKey, JSON.stringify(styles)); } catch { setStorageWarning(true); }
  }, [styleKey, styles]);
  useEffect(() => {
    if (!model) return;
    try { localStorage.setItem(modelKey, model.id); } catch { /* the default model is fine */ }
  }, [modelKey, model]);
  // One ticker drives the elapsed-seconds readouts.
  useEffect(() => {
    if (!job && phase === 'idle') return;
    const t = setInterval(() => setTick((v) => v + 1), 200);
    return () => clearInterval(t);
  }, [job, phase]);

  useEffect(() => {
    api.get<ImageModel[]>('/api/images/models')
      .then((r) => setModels(Array.isArray(r) ? r : []))
      .catch((e) => { setModels([]); toast(errText(e, '加载模型失败'), 'err'); });
    api.get<{ images: ImageRecord[]; total: number }>(`/api/images?kind=novelai&limit=${HISTORY_PAGE}&offset=0`)
      .then((r) => { setHistory(r.images ?? []); setHistoryTotal(r.total ?? 0); })
      .catch((e) => toast(errText(e, '加载作品失败'), 'err'))
      .finally(() => setHistoryLoaded(true));
  }, []);

  const hasNai = naiModels.length > 0;
  useEffect(() => {
    if (!hasNai) return;
    let current = true;
    api.get<NaiConfig>('/api/images/novelai/config').then((c) => {
      if (!current) return;
      setConf(c);
      setDraft((d) => {
        const helperModelId = c.helpers.some((h) => h.id === d.helperModelId)
          ? d.helperModelId : (c.helpers.find((h) => h.isDefault) || c.helpers[0])?.id || '';
        const next = { ...d, helperModelId };
        // Resolving the helper isn't an edit: a translation that was current
        // stays current. A copy made with no helper is not a translation.
        const translated = d.preparedFor === 'restored'
          ? !d.manual && !!d.options.basePrompt.trim() && d.options.basePrompt.trim() !== d.scene.trim()
          : !!(d.helperEnabled && d.helperModelId) && d.preparedFor === sourceSignature(d);
        if (translated) next.preparedFor = sourceSignature(next);
        else if (d.preparedFor === 'restored') next.preparedFor = '';
        return next;
      });
    }).catch((e) => { if (current) toast(errText(e, '加载 NAI 配置失败'), 'err'); });
    return () => { current = false; };
  }, [hasNai]);

  const subModel = model?.id;
  useEffect(() => {
    if (!subModel) return;
    let current = true;
    setSubLoading(true);
    api.get<Subscription>(`/api/images/novelai/${subModel}/subscription`)
      .then((s) => { if (current) { setSub(s); setSubError(''); } })
      .catch((e) => { if (current) { setSub(null); setSubError(errText(e, '额度查询失败')); } })
      .finally(() => { if (current) setSubLoading(false); });
    return () => { current = false; };
  }, [subModel, subTick]);

  // Pick up a generation still running from before a reload or navigation.
  useEffect(() => {
    if (!hasNai || attachedRef.current) return;
    attachedRef.current = true;
    void reattach(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNai]);

  // ?from=<imageId>: 「载入 NAI 创作」 from the gallery.
  const fromId = search.get('from');
  useEffect(() => {
    if (!fromId || models === null) return;
    let current = true;
    api.get<{ image: ImageRecord; modelId: string | null }>(`/api/images/novelai/restore/${encodeURIComponent(fromId)}`).then((r) => {
      if (!current) return;
      const restored = naiImageInfo(r.image);
      if (!restored) { toast('这张图没有可载入的 NAI 设置', 'err'); return; }
      if (r.modelId && naiModelsRef.current.some((m) => m.id === r.modelId)) setModelId(r.modelId);
      applyDraft(restored.draft);
      setExtra(r.image);
      setFocus(r.image.id);
      toast('已载入这张图的设置', 'ok');
    }).catch((e) => { if (current) toast(errText(e, '载入失败'), 'err'); }).finally(() => {
      if (current) setSearch((p) => { const next = new URLSearchParams(p); next.delete('from'); return next; }, { replace: true });
    });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromId, models, setSearch]);

  // Ctrl / Cmd + Enter generates from anywhere on the page.
  const generateRef = useRef<() => void>(() => {});
  generateRef.current = () => { void generate(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); generateRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- draft editing ---------- */

  const patch = (v: Partial<NaiDraft>) => { setDraft((d) => ({ ...d, ...v })); setError(''); };
  const options = (v: Partial<NaiOptions>) => { setDraft((d) => ({ ...d, options: { ...d.options, ...v } })); setError(''); };

  /** Tag 模式 ⇄ 智能描述 without losing what was typed on either side. */
  function setMode(tags: boolean) {
    setShowPrepared(false);
    setDraft((d) => {
      if (tags === d.manual) return d;
      const opts = d.options;
      if (tags) {
        // Keep the raw fields when they hold the user's earlier tags (descriptions
        // untouched since) or a current translation; else start from the descriptions.
        const keep = d.preparedFor === tagsMark(d) || (d.preparedFor === sourceSignature(d) && !!opts.basePrompt.trim());
        return { ...d, manual: true, options: keep ? opts : {
          ...opts, basePrompt: d.scene, negativePrompt: opts.negativeDescription,
          characters: opts.characters.map((c) => ({ ...c, prompt: c.description, negativePrompt: c.negativeDescription })),
        } };
      }
      const next: NaiDraft = { ...d, manual: false,
        scene: d.scene.trim() ? d.scene : opts.basePrompt.slice(0, 4000),
        options: { ...opts,
          negativeDescription: opts.negativeDescription.trim() ? opts.negativeDescription : opts.negativePrompt.slice(0, 2000),
          characters: opts.characters.map((c) => (c.description.trim() ? c : { ...c, description: c.prompt.slice(0, 1500), negativeDescription: c.negativePrompt })),
        } };
      return { ...next, preparedFor: tagsMark(next) };
    });
    setError('');
  }

  /** Load an image's settings. The seed is left random unless asked for: 「载入设置」 means "more like this". */
  function applyDraft(next: NaiDraft) {
    setDraft((d) => {
      const merged: NaiDraft = { ...next, helperEnabled: d.helperEnabled, helperModelId: d.helperModelId, options: { ...next.options, seed: null } };
      // basePrompt equal to the scene means it was sent untranslated — let the helper redo it.
      const translated = !merged.manual && !!merged.options.basePrompt.trim() && merged.options.basePrompt.trim() !== merged.scene.trim();
      return { ...merged, preparedFor: translated ? sourceSignature(merged) : '' };
    });
    setShowPrepared(false);
    setError('');
  }

  function reuse(img: ImageRecord, settings: NaiImageInfo) {
    const target = naiModels.find((m) => m.modelId === img.model);
    if (target) setModelId(target.id);
    applyDraft(settings.draft);
    setNegOpen(!!(settings.draft.options.negativeDescription || settings.draft.options.negativePrompt));
    toast('已载入这张图的设置，可以修改后再生成', 'ok');
  }

  /* ---------- generation ---------- */

  /** Translate descriptions into NAI prompts, reusing the last result while the source is unchanged. */
  async function prepare(d: NaiDraft, naiModelId: string, signal: AbortSignal): Promise<NaiOptions> {
    const opts = d.options;
    if (d.manual) return opts;
    const signature = sourceSignature(d);
    if (d.preparedFor === signature && opts.basePrompt.trim()) return opts;
    let next: NaiOptions;
    if (d.helperEnabled && d.helperModelId) {
      const r = await api.post<Prepared>('/api/images/novelai/prepare', {
        modelId: naiModelId, helperModelId: d.helperModelId, scene: d.scene, negativePrompt: opts.negativeDescription,
        characters: opts.characters.map((c) => ({ name: c.name, description: c.description, negativePrompt: c.negativeDescription })),
      }, signal);
      next = { ...opts, basePrompt: r.basePrompt, negativePrompt: r.negativePrompt,
        characters: opts.characters.map((c, i) => ({ ...c, ...r.characters[i] })) };
    } else {
      next = { ...opts, basePrompt: d.scene.trim(), negativePrompt: opts.negativeDescription,
        characters: opts.characters.map((c) => ({ ...c, prompt: c.description, negativePrompt: c.negativeDescription })) };
    }
    // Store the result only if the source wasn't edited (or Tag 模式 entered) meanwhile.
    setDraft((cur) => (cur.manual || sourceSignature(cur) !== signature ? cur : {
      ...cur, preparedFor: signature,
      options: { ...cur.options, basePrompt: next.basePrompt, negativePrompt: next.negativePrompt,
        characters: cur.options.characters.map((c, i) => ({ ...c, prompt: next.characters[i]?.prompt ?? c.prompt, negativePrompt: next.characters[i]?.negativePrompt ?? c.negativePrompt })) },
    }));
    return next;
  }

  function validate(d: NaiDraft): string | null {
    if (!(d.manual ? d.options.basePrompt : d.scene).trim()) return '先写一句你想画的画面';
    if (model?.modelId.endsWith('curated') && d.options.imageText.length > 374) return 'V5 Curated 的画面文字最多 374 个字符，请缩短或换用 V5 Full';
    const blank = d.options.characters.findIndex((c) => !(d.manual ? c.prompt : c.description).trim());
    if (blank >= 0) return `人物 ${blank + 1} 还没有描述，写一句或删掉 TA`;
    return null;
  }

  async function previewPrompt() {
    if (busy || !model) return;
    if (fresh) { setShowPrepared((v) => !v); return; }
    const problem = validate(draft);
    if (problem) { setError(problem); return; }
    const c = new AbortController();
    prepAbort.current = c;
    setPhase('previewing'); setError('');
    try { await prepare(draft, model.id, c.signal); if (!c.signal.aborted) setShowPrepared(true); }
    catch (e) { if (!c.signal.aborted && aliveRef.current) setError(errText(e, '提示词整理失败')); }
    finally { if (prepAbort.current === c) { prepAbort.current = null; if (aliveRef.current) setPhase('idle'); } }
  }

  async function generate() {
    if (busy || !model) return;
    const d = draft;
    const problem = validate(d);
    if (problem) { setError(problem); if (!(d.manual ? d.options.basePrompt : d.scene).trim()) promptRef.current?.focus(); return; }
    if (sub && !sub.available) { setError(sub.reason || '订阅额度暂不可用'); return; }
    const c = new AbortController();
    prepAbort.current = c;
    const needsHelper = !d.manual && d.helperEnabled && !!d.helperModelId
      && !(d.preparedFor === sourceSignature(d) && d.options.basePrompt.trim());
    setPhase(needsHelper ? 'preparing' : 'submitting'); setError('');
    // Stacked layout: bring the canvas into view (a no-op with three panes, where this never scrolls).
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      const prepared = await prepare(d, model.id, c.signal);
      if (c.signal.aborted || !aliveRef.current) return;
      setPhase('submitting');
      const body = {
        modelId: model.id, n: 1, size: d.size,
        // The gallery caption: the user's own words, or the tags in Tag 模式.
        prompt: (d.manual ? prepared.basePrompt : d.scene).trim().slice(0, 4000),
        novelai: { ...prepared, sourceMode: d.manual ? 'raw' : 'assisted',
          artists: prepared.artists.filter((a) => a.tag.trim()).map((a) => ({ ...a, tag: a.tag.trim() })) },
      };
      const startedAt = Date.now();
      try {
        const { jobId } = await api.post<{ jobId: string }>('/api/images/generate', body);
        setFocus('pending');
        void track({ id: jobId, modelId: model.id, startedAt, size: d.size });
      } catch (err) {
        // A lost response may still have queued the job — look before reporting.
        if (!(err instanceof ApiError) && await reattach(false, model.id)) return;
        throw err;
      }
    } catch (e) {
      if (!c.signal.aborted && aliveRef.current) setError(errText(e, '生成失败'));
    } finally {
      if (prepAbort.current === c) prepAbort.current = null;
      if (aliveRef.current) setPhase('idle');
    }
  }

  function stopPreparing() {
    prepAbort.current?.abort();
    prepAbort.current = null;
    setPhase('idle');
  }

  function addImages(imgs: ImageRecord[]) {
    const have = new Set(historyRef.current.map((x) => x.id));
    const added = imgs.filter((i) => !have.has(i.id));
    if (!added.length) return;
    setHistory((prev) => [...added.filter((i) => !prev.some((p) => p.id === i.id)), ...prev]);
    setHistoryTotal((t) => t + added.length);
  }

  async function recover(since: number): Promise<boolean> {
    try {
      const r = await api.get<{ images: ImageRecord[]; total: number }>('/api/images?kind=novelai&limit=5&offset=0');
      const known = new Set(historyRef.current.map((x) => x.id));
      const found = (r.images ?? []).filter((i) => i.createdAt >= since && !known.has(i.id));
      if (!found.length) return false;
      addImages(found);
      setFocus((f) => (f === 'pending' || f === null ? found[0].id : f));
      return true;
    } catch { return false; }
  }

  async function reattach(onMount: boolean, onlyModel?: string): Promise<boolean> {
    const r = await api.get<ActiveJobs>('/api/images/jobs/active').catch(() => null);
    const ids = new Set(naiModelsRef.current.map((m) => m.id));
    const j = r?.jobs?.find((x) => (onlyModel ? x.modelId === onlyModel : ids.has(x.modelId)));
    if (!j) return false;
    if (!trackedRef.current.has(j.jobId)) {
      if (onMount) setFocus((f) => f ?? 'pending');
      else setFocus('pending');
      void track({ id: j.jobId, modelId: j.modelId, startedAt: j.createdAt, size: j.request?.size || '832x1216' });
    }
    return true;
  }

  async function track(j: Job) {
    if (trackedRef.current.has(j.id)) return;
    trackedRef.current.add(j.id);
    setJob(j);
    try {
      for (;;) {
        await sleep(1500);
        if (!aliveRef.current) return;
        let st: JobStatus;
        try {
          st = await api.get<JobStatus>(`/api/images/jobs/${j.id}`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) throw new Error('任务状态已丢失（服务可能重启过）');
          if (Date.now() - j.startedAt > 12 * 60_000) throw new Error('等待超时，已放弃');
          continue;
        }
        if (st.status === 'running') continue;
        if (st.status === 'stopped') { setFocus((f) => (f === 'pending' ? null : f)); toast('已停止生成', 'info'); return; }
        if (st.status === 'error') throw new JobFailed(st.error || '生成失败');
        const imgs = st.images ?? [];
        addImages(imgs);
        if (imgs[0]) setFocus((f) => (f === 'pending' || f === null ? imgs[0].id : f));
        tabAlert();
        notifyDone('NAI 创作完成', '新图片已生成', '/images/nai');
        return;
      }
    } catch (err) {
      const msg = errText(err, '生成失败');
      // Lost track of the job (restart, timeout): its picture may still have
      // landed. A reported failure was rolled back, so anything new is not ours.
      if (err instanceof JobFailed || !(await recover(j.startedAt))) {
        if (aliveRef.current) { setError(msg); setFocus((f) => (f === 'pending' ? null : f)); }
        tabAlert();
        notifyDone('NAI 创作失败', msg, '/images/nai');
      }
    } finally {
      trackedRef.current.delete(j.id);
      if (aliveRef.current) { setJob((cur) => (cur?.id === j.id ? null : cur)); setSubTick((n) => n + 1); }
    }
  }

  async function cancelJob() {
    if (!job || job.cancelling) return;
    const id = job.id;
    setJob((cur) => (cur?.id === id ? { ...cur, cancelling: true } : cur));
    try { await api.post(`/api/images/jobs/${id}/cancel`); }
    catch (e) {
      toast(errText(e, '停止失败'), 'err');
      setJob((cur) => (cur?.id === id ? { ...cur, cancelling: false } : cur));
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await api.get<{ images: ImageRecord[]; total: number }>(`/api/images?kind=novelai&limit=${HISTORY_PAGE}&offset=${history.length}`);
      setHistory((prev) => { const have = new Set(prev.map((x) => x.id)); return [...prev, ...(r.images ?? []).filter((x) => !have.has(x.id))]; });
      setHistoryTotal(r.total ?? 0);
    } catch (e) { toast(errText(e, '加载失败'), 'err'); }
    finally { setLoadingMore(false); }
  }

  async function remove(img: ImageRecord) {
    if (!(await confirmDialog('删除图片', '确定删除这张图片？此操作不可恢复。'))) return;
    try {
      await api.del(`/api/images/${img.id}`);
      setHistory((prev) => prev.filter((x) => x.id !== img.id));
      setHistoryTotal((t) => Math.max(0, t - 1));
      setExtra((x) => (x?.id === img.id ? null : x));
      setFocus((f) => (f === img.id ? null : f));
      toast('已删除', 'ok');
    } catch (e) { toast(errText(e, '删除失败'), 'err'); }
  }

  /* ---------- render ---------- */

  const header = (
    <PageHeader title="NAI 创作室" subtitle="NovelAI V5 · 使用 Opus 订阅额度出图"
      left={<>
        {!sidebarOpen && <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}><PanelLeft size={16} /></Button>}
        {hasGeneric && <Link to="/images" title="返回绘图工坊" className={btnClass('ghost', 'icon')}><ArrowLeft size={16} /></Link>}
      </>}>
      {naiModels.length > 1 && model && (
        <div className="w-28 sm:w-40">
          <Select aria-label="NAI 模型" title="Full：题材最全；Curated：精选、更稳妥的数据集" value={model.id}
            onChange={(e) => { setModelId(e.target.value); setError(''); }}>
            {naiModels.map((m) => <option key={m.id} value={m.id}>{m.displayName || fmtModelName(m.modelId)}</option>)}
          </Select>
        </div>
      )}
      <span className="hidden sm:contents"><Link to="/images/gallery" className={btnClass('outline', 'sm')}><ImagesIcon size={14} />作品集</Link></span>
    </PageHeader>
  );

  if (models === null) {
    return <div className="contents">{header}<div className="flex flex-1 items-center justify-center text-tx3"><Spinner className="h-5 w-5" /></div></div>;
  }
  if (!model) {
    return (
      <div className="contents">
        {header}
        <div className="flex-1 overflow-y-auto bg-bg0 p-6">
          <div className="mx-auto max-w-lg rounded-xl border border-line bg-bg1">
            <EmptyState icon={<Palette size={22} />}
              title={allowModels ? '还没有可用的 NovelAI 模型' : '没有图像模型使用权限'}
              hint={allowModels ? '请联系管理员在「模型服务」添加 NovelAI V5，并为你开通模型。' : '请联系管理员为你的账号开启图像模型使用权限。'}
              action={hasGeneric ? <Link to="/images" className={btnClass('outline', 'sm')}>回到绘图工坊</Link> : undefined} />
          </div>
        </div>
      </div>
    );
  }

  const elapsed = job ? ((Date.now() - job.startedAt) / 1000).toFixed(1) : '';
  const seedLocked = info?.seed != null && o.seed === info.seed;
  const negText = draft.manual ? o.negativePrompt : o.negativeDescription;
  const ucLabel = NAI_UC_OPTIONS.find((u) => u.value === (o.ucEnabled ? o.ucPreset : 'off'))!.label;
  const curated = model.modelId.endsWith('curated');

  return (
    <div className="contents">
      {header}
      {/* Three panes once the page itself is wide enough (a container query,
          so an open sidebar counts); stacked with the canvas on top below that. */}
      <div ref={scrollRef} className="@container/studio min-h-0 flex-1 overflow-y-auto bg-bg0">
        <div className="flex min-h-full flex-col @4xl/studio:h-full @4xl/studio:flex-row">

          {/* ---- creation panel ---- */}
          <aside className="order-3 flex min-w-0 flex-col bg-bg1 @4xl/studio:order-1 @4xl/studio:min-h-0 @4xl/studio:w-[380px] @4xl/studio:shrink-0 @4xl/studio:border-r @4xl/studio:border-line @6xl/studio:w-[400px]">
            <div className="mx-auto min-h-0 w-full max-w-2xl flex-1 space-y-6 p-4 sm:p-5 @4xl/studio:max-w-none @4xl/studio:overflow-y-auto">
              <PanelSection title="画面描述" action={
                <SegmentedControl value={draft.manual ? 'tags' : 'smart'} onChange={(v) => setMode(v === 'tags')}
                  options={[{ value: 'smart', label: '智能描述' }, { value: 'tags', label: 'Tag 模式' }]} />
              }>
                <TagTextarea textareaRef={promptRef} rows={5} modelId={model.id} suggest={draft.manual} aria-label="画面描述"
                  maxLength={draft.manual ? 6000 : 4000} value={draft.manual ? o.basePrompt : draft.scene}
                  placeholder={draft.manual
                    ? '1girl, white hair, transparent umbrella, rain, neon lights, night, city street, looking back'
                    : '用一句话描述你想要的画面，比如：雨夜的霓虹街头，撑着透明雨伞的白发少女回头看向镜头'}
                  onChange={(v) => (draft.manual ? options({ basePrompt: v }) : patch({ scene: v }))} />
                {!draft.manual && !draft.scene.trim() && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-tx3">试试：</span>
                    {NAI_EXAMPLES.map((ex) => (
                      <button key={ex.title} type="button" title={ex.text} onClick={() => patch({ scene: ex.text })}
                        className="cursor-pointer rounded-full border border-line bg-bg1 px-2.5 py-1 text-xs text-tx2 transition-colors hover:border-line2 hover:bg-bg2 hover:text-tx">
                        {ex.title}
                      </button>
                    ))}
                  </div>
                )}
                {draft.manual ? (
                  <p className="flex gap-1.5 text-xs leading-relaxed text-tx3">
                    <Tags size={13} className="mt-0.5 shrink-0" />
                    内容原样发送给 NovelAI，输入英文时会提示标签。多人画面在开头写人数，比如 2girls。
                  </p>
                ) : helperOn ? (
                  <div className="rounded-lg bg-bg0 text-xs">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Languages size={13} className="shrink-0 text-acc" />
                      <span className="min-w-0 flex-1 leading-relaxed text-tx2">
                        {phase === 'previewing' ? 'AI 正在整理…' : fresh ? 'AI 已整理好提示词，生成时直接使用'
                          : draft.preparedFor && !draft.preparedFor.startsWith('tags:') ? '描述有改动，生成时会重新整理'
                            : '生成前，AI 会把描述整理成 NovelAI 能理解的提示词'}
                      </span>
                      {phase === 'previewing'
                        ? <Button size="xs" variant="ghost" onClick={stopPreparing}>取消</Button>
                        : <Button size="xs" variant="ghost" disabled={busy} onClick={() => void previewPrompt()}>{fresh ? (showPrepared ? '收起' : '查看') : '预览'}</Button>}
                    </div>
                    {fresh && showPrepared && (
                      <div className="space-y-2 border-t border-line px-3 py-2.5">
                        <PromptBlock label="画面" text={o.basePrompt} />
                        {o.characters.map((c, i) => <PromptBlock key={i} label={`人物 ${i + 1}${c.name ? ` · ${c.name}` : ''}`} text={c.prompt} />)}
                        {o.negativePrompt && <PromptBlock label="不想出现" text={o.negativePrompt} />}
                        <Button size="xs" variant="outline" onClick={() => setMode(true)}><Tags size={12} />改用 Tag 模式微调</Button>
                      </div>
                    )}
                  </div>
                ) : conf && (
                  <p className="text-xs leading-relaxed text-tx3">
                    {conf.helpers.length === 0
                      ? '未配置提示词助手，描述会原样发送，建议用英文或 tags。'
                      : <>提示词助手已关闭，描述会原样发送。<button type="button" className="cursor-pointer text-acc hover:underline" onClick={() => patch({ helperEnabled: true })}>开启</button></>}
                  </p>
                )}
              </PanelSection>

              <PanelSection title="画风">
                <StylePicker options={o} onChange={options} saved={styles} onSaved={setStyles} modelId={model.id} />
              </PanelSection>

              <PanelSection title="画幅">
                <div className="grid grid-cols-3 gap-2">
                  {NAI_SIZE_OPTIONS.map((s) => {
                    const [w, h] = s.size.split('x').map(Number);
                    const on = draft.size === s.size;
                    return (
                      <button key={s.size} type="button" aria-pressed={on} title={s.size.replace('x', ' × ')} onClick={() => patch({ size: s.size })}
                        className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-2 pb-2 pt-2.5 transition-colors ${
                          on ? 'border-acc bg-acc/5 text-tx ring-1 ring-acc' : 'border-line text-tx2 hover:border-line2 hover:text-tx'}`}>
                        <span className="flex h-6 items-center"><span className={`block rounded-[3px] border-2 ${on ? 'border-acc' : 'border-current'}`} style={{ width: w / 60, height: h / 60 }} /></span>
                        <span className="text-[13px] font-medium">{s.label}</span>
                        <span className="text-[11px] text-tx3">{s.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </PanelSection>

              <PanelSection title={<>人物 <span className="font-normal text-tx3">· 可选</span></>}
                hint={o.characters.length ? undefined : '画多个人时，给每个人单独描述，发型、衣着不容易串到别人身上。'}>
                <CharacterList characters={o.characters} manual={draft.manual} useCoords={o.useCoords} size={draft.size} modelId={model.id}
                  onChange={(characters) => options({ characters, useCoords: characters.length ? o.useCoords : false })}
                  onUseCoords={(useCoords) => options({ useCoords })} />
              </PanelSection>

              <Collapsible title="不想出现的内容" open={negOpen} onToggle={() => setNegOpen((v) => !v)}
                summary={negText.trim() ? negText : `基础过滤：${ucLabel}`}>
                <TagTextarea rows={2} modelId={model.id} suggest={draft.manual} aria-label="不想出现的内容"
                  maxLength={draft.manual ? 3000 : 2000} value={negText}
                  placeholder={draft.manual ? 'hat, glasses, extra fingers' : '比如：帽子、眼镜、文字水印'}
                  onChange={(v) => options(draft.manual ? { negativePrompt: v } : { negativeDescription: v })} />
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-medium text-tx">基础过滤</span>
                    <div className="w-36">
                      <Select aria-label="基础过滤" value={o.ucEnabled ? o.ucPreset : 'off'}
                        onChange={(e) => {
                          const v = e.target.value as typeof NAI_UC_OPTIONS[number]['value'];
                          options(v === 'off' ? { ucEnabled: false } : { ucEnabled: true, ucPreset: v });
                        }}>
                        {NAI_UC_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                      </Select>
                    </div>
                  </div>
                  <p className="text-xs leading-relaxed text-tx3">自动排除低画质、水印、画面瑕疵等常见问题，一般保持「标准」就好。</p>
                  {o.ucEnabled && conf?.uc[o.ucPreset] && (
                    <details className="text-xs text-tx3">
                      <summary className="cursor-pointer hover:text-tx">包含哪些词</summary>
                      <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed">{conf.uc[o.ucPreset]}</p>
                    </details>
                  )}
                </div>
              </Collapsible>

              <Collapsible title="高级设置" open={advOpen} onToggle={() => setAdvOpen((v) => !v)}
                badge={advancedChanged(o) ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-acc" title="有改动" /> : undefined}
                summary={advancedChanged(o) ? '已调整' : '一般不用改'}>
                <Slider label="精细度（步数）" value={o.steps} min={1} max={28} step={1} onChange={(steps) => options({ steps })}
                  hint="越高细节越多，也更慢。订阅额度内最多 28。" />
                <Slider label="贴合描述（引导强度）" value={o.scale} min={0} max={10} step={0.1} format={(v) => v.toFixed(1)}
                  onChange={(scale) => options({ scale })} hint="越高越严格按描述画，太高画面会发硬、颜色过饱和。" />
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-tx">画质增强</div>
                    <div className="mt-0.5 text-xs text-tx3">自动加上提升画质的词</div>
                  </div>
                  <SegmentedControl value={o.quality} onChange={(quality) => options({ quality })}
                    options={[{ value: 'standard', label: '标准' }, { value: 'light', label: '轻量' }, { value: 'none', label: '关闭' }]} />
                </div>
                <Field label="种子" hint="留空每次随机。固定后，微调描述时构图更稳定；同样的设置能复现同一张图。">
                  <div className="flex gap-2">
                    <Input uiSize="sm" type="number" min={0} max={4294967295} placeholder="随机" value={o.seed ?? ''}
                      onChange={(e) => options({ seed: e.target.value === '' ? null : Math.max(0, Math.min(4294967295, Math.floor(Number(e.target.value) || 0))) })} />
                    <Button variant="outline" size="icon" title="改回随机" disabled={o.seed === null} onClick={() => options({ seed: null })}><Dices size={15} /></Button>
                  </div>
                </Field>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-tx">透明背景</div>
                    <div className="mt-0.5 text-xs text-tx3">适合做贴纸、立绘素材</div>
                  </div>
                  <Toggle label="透明背景" checked={o.transparent} onChange={(transparent) => options({ transparent })} />
                </div>
                <Field label="画面中的文字" hint="需要出现在图里的文字，比如招牌、标题；不需要就留空。">
                  <Input value={o.imageText} maxLength={curated ? 374 : 750} placeholder="例如 OPEN" onChange={(e) => options({ imageText: e.target.value })} />
                </Field>
                {!!conf?.helpers.length && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-tx">提示词助手</div>
                        <div className="mt-0.5 text-xs text-tx3">智能描述模式下把描述整理成英文提示词，消耗文字模型额度，不消耗 Anlas。</div>
                      </div>
                      <Toggle label="提示词助手" checked={draft.helperEnabled} onChange={(helperEnabled) => patch({ helperEnabled })} />
                    </div>
                    {draft.helperEnabled && conf.helpers.length > 1 && (
                      <Select aria-label="提示词助手模型" value={draft.helperModelId} onChange={(e) => patch({ helperModelId: e.target.value })}>
                        {conf.helpers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                      </Select>
                    )}
                  </div>
                )}
                {advancedChanged(o) && (
                  <Button size="xs" variant="ghost" onClick={() => options({ steps: NAI_DEFAULTS.steps, scale: NAI_DEFAULTS.scale, quality: 'standard', seed: null, transparent: false, imageText: '' })}>
                    <RotateCcw size={12} />恢复默认
                  </Button>
                )}
              </Collapsible>
            </div>

            {/* ---- generate bar ---- */}
            <div className="sticky bottom-0 z-10 border-t border-line bg-bg1 px-4 py-3 sm:px-5">
              <div className="mx-auto max-w-2xl space-y-2 @4xl/studio:max-w-none">
              {error && <p role="alert" className="text-xs leading-relaxed text-err">{error}</p>}
              {!error && sub && !sub.available && sub.reason && <p className="text-xs leading-relaxed text-warn">{sub.reason}</p>}
              {storageWarning && <p className="text-xs text-warn">浏览器没能保存草稿，请先别关闭页面。</p>}
              {o.seed !== null && (
                <div className="flex items-center gap-1.5 text-xs text-tx2">
                  <Lock size={12} className="shrink-0" />已固定种子 <span className="font-mono tabular-nums">{o.seed}</span>
                  <button type="button" className="ml-1 cursor-pointer text-acc hover:underline" onClick={() => options({ seed: null })}>改回随机</button>
                </div>
              )}
              <div className="flex gap-2">
                {(phase === 'preparing' || phase === 'previewing') && <Button size="lg" variant="outline" onClick={stopPreparing}>取消</Button>}
                {job && <Button size="lg" variant="outline" disabled={job.cancelling} onClick={() => void cancelJob()}>{job.cancelling ? '停止中…' : '停止'}</Button>}
                <Button variant="primary" size="lg" className="flex-1" disabled={busy || (!!sub && !sub.available)} onClick={() => void generate()}>
                  {phase === 'preparing' ? <><Spinner className="h-4 w-4" />AI 正在整理描述…</>
                    : phase === 'submitting' ? <><Spinner className="h-4 w-4" />提交中…</>
                      : job ? <><Spinner className="h-4 w-4" />绘制中 {elapsed}s</>
                        : <><Sparkles size={16} />生成</>}
                </Button>
              </div>
              <QuotaLine sub={sub} loading={subLoading} error={subError} onRefresh={() => setSubTick((n) => n + 1)} />
              </div>
            </div>
          </aside>

          {/* ---- canvas ---- */}
          <section className={`@container/canvas order-1 flex min-w-0 flex-col @4xl/studio:order-2 @4xl/studio:h-auto @4xl/studio:min-h-0 @4xl/studio:flex-1 ${pending || focused ? 'h-[60vh] min-h-[340px]' : 'h-52'}`}>
            <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
              {pending ? (
                <>
                  <img src={frameSrc(job?.size ?? draft.size)} alt="" className="max-h-full max-w-full rounded-lg border border-line" style={SHIMMER} />
                  <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
                    <Spinner className="h-6 w-6 text-tx3" />
                    <p className="text-sm font-medium text-tx">
                      {phase === 'preparing' ? 'AI 正在整理描述…' : phase === 'submitting' ? '正在提交…' : job?.cancelling ? '正在停止…' : '正在绘制…'}
                    </p>
                    {job && <p className="text-xs tabular-nums text-tx3">{elapsed}s · 通常十几秒，可以先去做别的</p>}
                  </div>
                </>
              ) : focused ? (
                <img key={focused.id} src={`/api/images/${focused.id}/file`} alt={focused.prompt} title="点击放大"
                  onClick={() => useLightbox.getState().open(`/api/images/${focused.id}/file`, focused.prompt)}
                  className="fade-up max-h-full max-w-full cursor-zoom-in rounded-lg object-contain shadow-lg" style={CHECKER} />
              ) : (
                <>
                  {/* The empty frame previews the chosen 画幅. */}
                  <img src={frameSrc(draft.size)} alt="" className="hidden max-h-full max-w-full rounded-lg border-2 border-dashed border-line2 @4xl/studio:block" />
                  <div className="absolute inset-0 flex items-center justify-center p-8">
                    <div className="max-w-xs text-center">
                      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-bg1 text-tx3"><Palette size={22} /></div>
                      <p className="text-sm font-medium text-tx">写下想画的画面，点「生成」</p>
                      <p className="mt-1.5 text-xs leading-relaxed text-tx3">用中文描述就好，AI 会整理成 NovelAI 能理解的提示词。生成的图片会显示在这里。</p>
                    </div>
                  </div>
                </>
              )}
            </div>
            {focused && !pending && (
              <div className="shrink-0 border-t border-line bg-bg1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                  <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-tx3 @xl/canvas:basis-0 @xl/canvas:flex-1">
                    {focused.model && <span className="font-medium text-tx2">{naiModels.find((m) => m.modelId === focused.model)?.displayName || fmtModelName(focused.model)}</span>}
                    {focused.size && <span>{focused.size.replace('x', ' × ')}</span>}
                    {info?.seed != null && <span>种子 <span className="font-mono">{info.seed}</span></span>}
                    <span>{fmtDuration(focused.durationMs)}</span>
                    <span>{fmtTime(focused.createdAt)}</span>
                  </div>
                  <div className="-mx-1.5 flex flex-wrap items-center gap-1 @xl/canvas:mx-0">
                    {info && <>
                      <Button size="sm" variant="ghost" aria-pressed={showPrompt} title="查看这张图实际使用的提示词" onClick={() => setShowPrompt((v) => !v)}>
                        <FileText size={14} /><span className="hidden @md/canvas:inline">提示词</span>
                      </Button>
                      <Button size="sm" variant="ghost" title="把这张图的描述、画风、人物等设置载入左侧" onClick={() => reuse(focused, info)}>
                        <RotateCcw size={14} /><span className="hidden @md/canvas:inline">载入设置</span>
                      </Button>
                      {info.seed != null && (
                        <Button size="sm" variant="ghost" aria-pressed={seedLocked} title={seedLocked ? '改回随机种子' : '用这张图的种子继续画，构图会更接近'}
                          onClick={() => options({ seed: seedLocked ? null : info.seed })}>
                          {seedLocked ? <Lock size={14} /> : <LockOpen size={14} />}<span className="hidden @md/canvas:inline">{seedLocked ? '已固定种子' : '固定种子'}</span>
                        </Button>
                      )}
                    </>}
                    <Button size="iconSm" variant="ghost" title="放大查看" onClick={() => useLightbox.getState().open(`/api/images/${focused.id}/file`, focused.prompt)}><Maximize2 size={14} /></Button>
                    <a href={`/api/images/${focused.id}/file`} download title="下载" className={btnClass('ghost', 'iconSm')}><Download size={14} /></a>
                    <Button size="iconSm" variant="dangerGhost" title="删除" onClick={() => void remove(focused)}><Trash2 size={14} /></Button>
                  </div>
                </div>
                {showPrompt && info && (
                  <div className="max-h-60 space-y-2.5 overflow-y-auto border-t border-line px-4 py-3">
                    {info.draft.options.sourceMode === 'assisted' && focused.prompt && <PromptBlock label="你的描述" text={focused.prompt} plain />}
                    <PromptBlock label="实际提示词" text={info.actualPrompt} />
                    {info.draft.options.characters.map((c, i) => <PromptBlock key={i} label={`人物 ${i + 1}${c.name ? ` · ${c.name}` : ''}`} text={c.prompt} />)}
                    {info.actualNegativePrompt && <PromptBlock label="排除词" text={info.actualNegativePrompt} />}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ---- history ---- */}
          <nav aria-label="生成历史" className={`order-2 border-y border-line bg-bg1 @4xl/studio:order-3 @4xl/studio:flex @4xl/studio:min-h-0 @4xl/studio:w-[132px] @4xl/studio:shrink-0 @4xl/studio:flex-col @4xl/studio:border-y-0 @4xl/studio:border-l ${
            history.length || job ? '' : 'hidden'}`}>
            <div className="hidden items-baseline justify-between px-3 pb-1 pt-3 @4xl/studio:flex">
              <span className="eyebrow">历史</span>
              <span className="text-[11px] tabular-nums text-tx3">{historyTotal || ''}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto p-3 @4xl/studio:min-h-0 @4xl/studio:flex-1 @4xl/studio:flex-col @4xl/studio:overflow-y-auto @4xl/studio:overflow-x-hidden">
              {job && (
                <button type="button" title="正在生成" aria-current={pending} onClick={() => setFocus('pending')}
                  className={`relative flex h-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border @4xl/studio:h-auto @4xl/studio:w-full ${
                    focus === 'pending' ? 'border-acc ring-2 ring-acc' : 'border-line'}`}
                  style={{ aspectRatio: ratio(job.size), ...SHIMMER }}>
                  <Spinner className="h-4 w-4 text-tx3" />
                </button>
              )}
              {history.map((img) => {
                const on = !pending && focused?.id === img.id;
                return (
                  <button key={img.id} type="button" title={img.prompt} aria-current={on} onClick={() => setFocus(img.id)}
                    className={`relative h-20 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-bg2 transition-[border-color,box-shadow] @4xl/studio:h-auto @4xl/studio:w-full ${
                      on ? 'border-acc ring-2 ring-acc' : 'border-line hover:border-line2'}`}
                    style={{ aspectRatio: ratio(img.size) }}>
                    <img loading="lazy" src={`/api/images/${img.id}/file`} alt="" className="h-full w-full object-cover" />
                  </button>
                );
              })}
              {history.length < historyTotal && (
                <Button size="xs" variant="ghost" className="shrink-0 self-center" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? <Spinner className="h-3.5 w-3.5" /> : '更多'}
                </Button>
              )}
              {historyLoaded && !history.length && !job && (
                <p className="hidden px-1 text-[11px] leading-relaxed text-tx3 @4xl/studio:block">生成的图片会按时间排在这里</p>
              )}
              {historyLoaded && history.length > 0 && (
                <Link to="/images/gallery" className="shrink-0 self-center whitespace-nowrap px-1 py-1 text-[11px] text-tx3 hover:text-tx">全部作品</Link>
              )}
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
}

function PromptBlock({ label, text, plain = false }: { label: string; text: string; plain?: boolean }) {
  return (
    <div className="text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium text-tx2">{label}</span>
        <button type="button" title="复制" onClick={() => copy(text)}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-tx3 transition-colors hover:bg-bg2 hover:text-tx">
          <Copy size={12} />
        </button>
      </div>
      <p className={`select-text whitespace-pre-wrap break-words leading-relaxed text-tx ${plain ? '' : 'font-mono text-[11px]'}`}>{text}</p>
    </div>
  );
}

function QuotaLine({ sub, loading, error, onRefresh }: { sub: Subscription | null; loading: boolean; error: string; onRefresh(): void }) {
  const pct = sub?.percent ?? null;
  const tone = !sub || !sub.available ? 'bg-err' : pct !== null && pct < 20 ? 'bg-warn' : 'bg-ok';
  const refill = sub?.refillSeconds ? `约 ${Math.max(1, Math.round(sub.refillSeconds / 60))} 分钟恢复 1%` : '';
  const title = sub
    ? [`Opus 订阅额度剩余 ${pct ?? '未知'}%`, refill, sub.anlas !== null ? `Anlas ${sub.anlas}（仅查看，不会使用）` : ''].filter(Boolean).join('\n')
    : error || '正在查询订阅额度';
  return (
    <div className="flex items-center gap-2 text-xs text-tx3" title={title}>
      <span className="shrink-0">订阅额度</span>
      {sub && pct !== null && (
        <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-bg3">
          <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
        </span>
      )}
      <span className={`min-w-0 truncate tabular-nums ${!sub && !loading ? 'text-err' : ''}`}>
        {sub ? (pct === null ? '未知' : `${pct}%`) : loading ? '查询中…' : '查询失败'}
      </span>
      <button type="button" title="刷新额度" onClick={onRefresh} disabled={loading}
        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-tx3 transition-colors hover:bg-bg2 hover:text-tx disabled:cursor-default">
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button>
      <span className="ml-auto hidden shrink-0 sm:inline">Ctrl / ⌘ + Enter 生成</span>
    </div>
  );
}

