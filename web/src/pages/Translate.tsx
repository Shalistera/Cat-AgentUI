import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanelLeft, Languages, ArrowRightLeft, Copy, Check, X, Square, Pencil, Plus, Zap, Brain,
  BookOpenText, Columns2, Scale, Equal, ThumbsUp, ChevronRight,
} from 'lucide-react';
import { api, streamSse, fmtDuration, fmtTokens } from '../api';
import { useAuth, useUi } from '../store';
import {
  Button, Card, Field, Input, Modal, ModalActions, Select, Spinner, PageHeader, EmptyState,
  SegmentedControl, Textarea, toast,
} from '../components/ui';
import type { TranslateConfig, TranslateScene, User } from '../types';
import { t, tServer, locale } from '../i18n';

/* 翻译工坊 — a Google-Translate-shaped pair of boxes. The user picks languages,
   默认/快速/思考, a 3-rung intensity for 思考, and a 场景 (a style sentence that
   lands in one slot of the server's fixed prompt). Models are the admin's
   business: see server/src/routes/translate.ts. Nothing runs until the user
   presses 翻译 — every call costs tokens. */

type Mode = 'default' | 'fast' | 'think';
type Level = 1 | 2 | 3;

const PREFS_KEY = 'cat-translate-prefs';
const MAX_CUSTOM_SCENES = 4;

interface Prefs { source: string; target: string; mode: Mode; level: Level; scene: string }
const DEFAULT_PREFS: Prefs = { source: 'auto', target: 'zh-CN', mode: 'default', level: 2, scene: 'general' };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { ...DEFAULT_PREFS, ...raw, mode: ['default', 'fast', 'think'].includes(raw?.mode) ? raw.mode : 'default' };
  } catch { return DEFAULT_PREFS; }
}

/** Built-in 场景: the id is what we persist, the text is what the model sees. */
const BUILTIN_SCENES: { id: string; name: string; text: string }[] = [
  { id: 'general', name: t('通用'), text: '' },
  { id: 'formal', name: t('正式书面'), text: t('正式书面文件:使用规范、正式的书面语,术语准确统一,句式完整,避免口语和缩略。') },
  { id: 'sns', name: t('社交对话'), text: t('社交平台 / 聊天对话:口语化、轻松自然,像母语者在聊天软件或社交媒体上的表达,可保留语气词和常见网络用语,但不要额外添加表情符号。') },
  { id: 'tech', name: t('技术文档'), text: t('技术文档:面向开发者,术语按行业惯例翻译或保留英文原文,代码、命令、参数名一律不译,表述精确简洁。') },
  { id: 'business', name: t('商务邮件'), text: t('商务邮件:礼貌、专业、简洁,符合目标语言的商务书信惯例与敬语习惯。') },
];

/* A/B 对比: when the admin has it on, the server may answer a translation with
   two — one per model, in random order — and ask which is better. The page
   only ever knows them as 译文 1 / 译文 2; the vote, sent as a position, is
   mapped back to a model server-side. Whichever the person picks becomes the
   ordinary 译文, so voting is also simply choosing. */
interface AbSide { text: string; thinking: boolean; stats: { totalTokens: number; durationMs: number } | null }
type AbChoice = 'first' | 'second' | 'tie';
interface AbState {
  sides: [AbSide, AbSide];
  /** Set once both translations finished and the comparison was recorded. */
  id: string | null;
  voting: AbChoice | null;
}
const emptySide = (): AbSide => ({ text: '', thinking: false, stats: null });

/** Model-reported ISO code → a code in our language list, when it has one. */
function normalizeDetected(code: string, languages: Record<string, string>, target: string): string {
  const c = code.toLowerCase();
  if (languages[c]) return c;
  if (c === 'zh' || c.startsWith('zh-')) {
    if (c.includes('tw') || c.includes('hk') || c.includes('hant')) return 'zh-TW';
    // A plain "zh" while translating INTO 简体 is almost always 繁体 input.
    return target === 'zh-CN' ? 'zh-TW' : 'zh-CN';
  }
  const base = c.split('-')[0];
  return languages[base] ? base : c;
}

/** Pair up 原文/译文 paragraphs for 对照阅读. Blank-line blocks when both sides
    agree on them; single lines as a fallback. Counts can still diverge (the
    model merged or split a paragraph) — the caller shows a hint then. */
function pairParagraphs(src: string, dst: string): { rows: [string, string][]; aligned: boolean } {
  const blocks = (s: string, re: RegExp) => s.split(re).map((p) => p.trim()).filter(Boolean);
  let a = blocks(src, /\n\s*\n+/);
  let b = blocks(dst, /\n\s*\n+/);
  if (a.length !== b.length || a.length <= 1) {
    const a2 = blocks(src, /\n+/);
    const b2 = blocks(dst, /\n+/);
    if (a2.length === b2.length && a2.length > 1) { a = a2; b = b2; }
  }
  const n = Math.max(a.length, b.length);
  return {
    rows: Array.from({ length: n }, (_, i) => [a[i] ?? '', b[i] ?? ''] as [string, string]),
    aligned: a.length === b.length,
  };
}

export default function Translate() {
  const { sidebarOpen, setSidebarOpen } = useUi();
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);

  const [cfg, setCfg] = useState<TranslateConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  useEffect(() => {
    api.get<TranslateConfig>('/api/translate/config')
      .then(setCfg)
      .catch((e) => setCfgError(e instanceof Error ? tServer(e.message) : t('加载翻译配置失败')));
  }, []);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);
  const patchPrefs = (p: Partial<Prefs>) => setPrefs((cur) => ({ ...cur, ...p }));

  // A mode the admin hasn't configured can't stay selected.
  useEffect(() => {
    if (!cfg) return;
    if (!cfg[prefs.mode]) {
      const available = (['default', 'fast', 'think'] as const).find((m) => cfg[m]);
      if (available) patchPrefs({ mode: available });
    }
  }, [cfg, prefs.mode]);

  const languages = cfg?.languages ?? {};
  const langEntries = useMemo(() => Object.entries(languages), [languages]);

  // ---- scenes ----
  const customScenes: TranslateScene[] = user?.settings.translateScenes ?? [];
  const scenes = useMemo(() => [
    ...BUILTIN_SCENES,
    ...customScenes.map((s, i) => ({ id: `custom:${i}`, name: s.name, text: s.text })),
  ], [customScenes]);
  const activeScene = scenes.find((s) => s.id === prefs.scene) ?? scenes[0];
  useEffect(() => {
    if (!scenes.some((s) => s.id === prefs.scene)) patchPrefs({ scene: 'general' });
  }, [scenes, prefs.scene]);

  const [sceneEditor, setSceneEditor] = useState<{ index: number | null; name: string; text: string } | null>(null);
  const [savingScene, setSavingScene] = useState(false);

  async function saveScenes(next: TranslateScene[], selectIndex: number | null) {
    setSavingScene(true);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { translateScenes: next } });
      setUser(r.user);
      setSceneEditor(null);
      if (selectIndex !== null) patchPrefs({ scene: `custom:${selectIndex}` });
      else if (prefs.scene.startsWith('custom:')) patchPrefs({ scene: 'general' });
    } catch (e) {
      toast(e instanceof Error ? tServer(e.message) : t('保存场景失败'), 'err');
    } finally {
      setSavingScene(false);
    }
  }

  function submitScene() {
    if (!sceneEditor) return;
    const name = sceneEditor.name.trim();
    const text = sceneEditor.text.trim();
    if (!name) { toast(t('请填写场景名称'), 'err'); return; }
    if (!text) { toast(t('请描述这个场景希望的语气或用词'), 'err'); return; }
    const next = [...customScenes];
    const idx = sceneEditor.index ?? next.length;
    next[idx] = { name, text };
    void saveScenes(next, idx);
  }

  function deleteScene() {
    if (!sceneEditor || sceneEditor.index === null) return;
    const next = customScenes.filter((_, i) => i !== sceneEditor.index);
    void saveScenes(next, null);
  }

  // ---- translation ----
  const [text, setText] = useState('');
  const [result, setResult] = useState('');
  const [detected, setDetected] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ totalTokens: number; durationMs: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // 对照阅读 is opt-in per result: never remembered, reset by every new run.
  const [compare, setCompare] = useState(false);
  const [ab, setAb] = useState<AbState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const modeAvailable = cfg ? cfg[prefs.mode] : false;

  const run = useCallback(async (input: string) => {
    const body = input.trim();
    abortRef.current?.abort();
    setAb(null);
    if (!body || !cfg) { setResult(''); setDetected(null); setError(null); setStats(null); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true); setResult(''); setDetected(null); setError(null); setStats(null); setThinking(false); setCompare(false);
    try {
      let out = '';
      let status = 'done';
      // A/B: events tagged with `side` fill the two columns — until `ab-void`
      // names a survivor, whose stream then fills the ordinary 译文 pane.
      let sides: [AbSide, AbSide] | null = null;
      let keep: number | null = null;
      const patchSide = (i: number, p: Partial<AbSide>) => {
        if (!sides) return;
        const next: [AbSide, AbSide] = [...sides];
        next[i] = { ...next[i], ...p };
        sides = next;
        setAb((cur) => cur && { ...cur, sides: next });
      };
      await streamSse('/api/translate/stream', {
        text: body, source: prefs.source, target: prefs.target,
        mode: prefs.mode, level: prefs.level, scene: activeScene.text,
      }, (event, data) => {
        const side = data.side === 0 || data.side === 1 ? data.side as number : null;
        if (side !== null && sides && keep === null) {
          if (event === 'delta') patchSide(side, { text: sides[side].text + (data.text ?? '') });
          else if (event === 'thinking') patchSide(side, { thinking: true });
          else if (event === 'usage') patchSide(side, { stats: { totalTokens: data.totalTokens ?? 0, durationMs: data.durationMs ?? 0 } });
          return;
        }
        if (side !== null && side !== keep) return;
        if (event === 'ab') {
          sides = [emptySide(), emptySide()];
          setAb({ sides, id: null, voting: null });
        } else if (event === 'ab-void') {
          keep = data.keep === 1 ? 1 : 0;
          const survivor = sides?.[keep] ?? emptySide();
          sides = null;
          out = survivor.text;
          setResult(out); setThinking(survivor.thinking); setStats(survivor.stats); setAb(null);
        } else if (event === 'ab-ready') setAb((cur) => cur && { ...cur, id: String(data.id ?? '') || null });
        else if (event === 'delta') { out += data.text ?? ''; setResult(out); }
        else if (event === 'detected') setDetected(String(data.lang ?? ''));
        else if (event === 'thinking') setThinking(true);
        else if (event === 'usage') setStats({ totalTokens: data.totalTokens ?? 0, durationMs: data.durationMs ?? 0 });
        else if (event === 'error') setError(data.message ? tServer(String(data.message)) : t('翻译失败'));
        else if (event === 'done') status = data.status ?? 'done';
      }, ctrl.signal);
      if (status === 'stopped' && !ctrl.signal.aborted) toast(t('输出已达上限,译文可能不完整'), 'err');
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? tServer(e.message) : t('翻译失败'));
    } finally {
      if (abortRef.current === ctrl) { setRunning(false); abortRef.current = null; }
    }
  }, [cfg, prefs.source, prefs.target, prefs.mode, prefs.level, activeScene.text]);

  function stop() { abortRef.current?.abort(); setRunning(false); abortRef.current = null; }

  /** Leave the comparison with one side as the 译文 — chosen, or by default. */
  function adopt(side: 0 | 1) {
    const s = ab?.sides[side];
    setAb(null);
    if (!s) return;
    setResult(s.text); setStats(s.stats); setThinking(false);
  }

  async function vote(choice: AbChoice) {
    if (!ab?.id || ab.voting) return;
    setAb({ ...ab, voting: choice });
    try {
      await api.post(`/api/translate/ab/${ab.id}/vote`, { choice });
      toast(t('已记下你的选择,谢谢'), 'ok');
    } catch (e) {
      // The translation they picked is still theirs; only the vote is lost.
      toast(e instanceof Error ? tServer(e.message) : t('投票失败'), 'err');
    }
    adopt(choice === 'second' ? 1 : 0);
  }

  function swap() {
    const detectedCode = detected ? normalizeDetected(detected, languages, prefs.target) : null;
    const newSource = prefs.target;
    let newTarget = prefs.source;
    if (newTarget === 'auto') {
      newTarget = detectedCode && languages[detectedCode] && detectedCode !== newSource
        ? detectedCode
        : (newSource === 'zh-CN' ? 'en' : 'zh-CN');
    }
    patchPrefs({ source: newSource, target: newTarget });
    if (result.trim()) { setText(result); setResult(''); setDetected(null); setStats(null); }
  }

  async function copy() {
    await navigator.clipboard.writeText(result);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  const detectedLabel = detected
    ? (tServer(languages[normalizeDetected(detected, languages, prefs.target)] ?? '') || detected.toUpperCase())
    : null;
  const canRun = !!text.trim() && modeAvailable && !running;
  const maxChars = cfg?.maxChars ?? 20_000;

  // 对照阅读 is desktop-only: on phones the panes stack vertically anyway, so
  // the normal view stays and the compare card is hidden via CSS.
  const compareData = useMemo(() => pairParagraphs(text, result), [text, result]);
  const showCompare = compare && !!result;

  const runControl = running ? (
    <Button variant="outline" size="sm" onClick={stop}><Square size={11} fill="currentColor" />{t('停止')}</Button>
  ) : (
    <Button variant="primary" size="sm" disabled={!canRun} onClick={() => void run(text)}>
      {prefs.mode === 'default' ? <Languages size={13} /> : prefs.mode === 'fast' ? <Zap size={13} /> : <Brain size={13} />}{t('翻译')}
    </Button>
  );
  const copyBtn = (
    <Button variant="ghost" size="sm" title={t('复制译文')} onClick={copy}>
      {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
    </Button>
  );
  const statsLine = (
    <>
      <span>{prefs.mode === 'default' ? t('默认 · 管理员预设') : prefs.mode === 'fast' ? t('快速模式') : t('思考模式 · 强度{level}', { level: ['', t('低'), t('中'), t('高')][prefs.level] })}{activeScene.id !== 'general' ? ` · ${activeScene.name}` : ''}</span>
      {stats && <span className="tabular-nums">{fmtTokens(stats.totalTokens)} tokens · {fmtDuration(stats.durationMs)}</span>}
    </>
  );

  const chip = (active: boolean) =>
    `inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors ${
      active ? 'border-acc bg-acc/10 text-acc' : 'border-line bg-bg1 text-tx2 hover:border-line2 hover:text-tx'}`;

  return (
    <div className="contents">
      <PageHeader
        title={t('翻译工坊')}
        subtitle={t('左边输入,点「翻译」,右边出译文')}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title={t('展开侧栏')} onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />

      <div className="flex-1 overflow-y-auto bg-bg0">
        <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
          {!cfg && !cfgError && (
            <div className="flex justify-center py-16 text-tx3"><Spinner className="h-5 w-5" /></div>
          )}
          {cfgError && (
            <Card flush>
              <EmptyState icon={<Languages size={22} />} title={t('翻译工坊暂不可用')} hint={cfgError} />
            </Card>
          )}
          {cfg && !cfg.default && !cfg.fast && !cfg.think && (
            <Card flush>
              <EmptyState
                icon={<Languages size={22} />}
                title={t('管理员尚未配置翻译模型')}
                hint={t('请管理员在「管理后台 → 任务模型 → 翻译工坊」中为默认、快速或思考模式指定至少一个模型。')}
              />
            </Card>
          )}

          {cfg && (cfg.default || cfg.fast || cfg.think) && (
            <>
              {/* toolbar */}
              <div className="space-y-3 rounded-xl border border-line bg-bg1 px-4 py-3 shadow-xs">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="min-w-0 flex-1 sm:w-36 sm:flex-none"><Select value={prefs.source} onChange={(e) => patchPrefs({ source: e.target.value })}>
                      <option value="auto">{detectedLabel && prefs.source === 'auto' ? t('检测到:{lang}', { lang: detectedLabel }) : t('自动检测')}</option>
                      {langEntries.map(([code, name]) => <option key={code} value={code}>{tServer(name)}</option>)}
                    </Select></div>
                    <Button variant="ghost" size="iconSm" title={t('交换语言(译文回填为原文)')} onClick={swap}>
                      <ArrowRightLeft size={14} />
                    </Button>
                    <div className="min-w-0 flex-1 sm:w-36 sm:flex-none"><Select value={prefs.target} onChange={(e) => patchPrefs({ target: e.target.value })}>
                      {langEntries.map(([code, name]) => <option key={code} value={code}>{tServer(name)}</option>)}
                    </Select></div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                    <SegmentedControl<Mode>
                      value={prefs.mode}
                      onChange={(m) => {
                        if (m === 'default' && !cfg.default) { toast(t('管理员尚未配置默认档的模型'), 'err'); return; }
                        if (m === 'fast' && !cfg.fast) { toast(t('管理员尚未配置快速模式的模型'), 'err'); return; }
                        if (m === 'think' && !cfg.think) { toast(t('管理员尚未配置思考模式的模型'), 'err'); return; }
                        patchPrefs({ mode: m });
                      }}
                      options={[
                        { value: 'default', label: t('默认') },
                        { value: 'fast', label: t('快速') },
                        { value: 'think', label: t('思考') },
                      ]}
                    />
                    {prefs.mode === 'default' && <span className="text-xs text-tx3">{t('使用管理员预设')}</span>}
                    {prefs.mode === 'think' && <div className="flex items-center gap-1.5" title={t('思考强度')}>
                      <span className="text-xs text-tx3">{t('强度')}</span>
                      <SegmentedControl<Level>
                        value={prefs.level}
                        onChange={(l) => patchPrefs({ level: l })}
                        options={[{ value: 1, label: t('低') }, { value: 2, label: t('中') }, { value: 3, label: t('高') }]}
                      />
                    </div>}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs text-tx3">{t('场景')}</span>
                  {scenes.map((s) => {
                    const active = s.id === activeScene.id;
                    const customIndex = s.id.startsWith('custom:') ? Number(s.id.slice(7)) : null;
                    return (
                      <button
                        key={s.id} type="button" className={chip(active)} title={s.text || t('不附加风格要求')}
                        onClick={() => {
                          if (active && customIndex !== null) {
                            setSceneEditor({ index: customIndex, name: s.name, text: s.text });
                          } else patchPrefs({ scene: s.id });
                        }}
                      >
                        {s.name}
                        {active && customIndex !== null && <Pencil size={11} className="opacity-70" />}
                      </button>
                    );
                  })}
                  {customScenes.length < MAX_CUSTOM_SCENES && (
                    <button
                      type="button" className={`${chip(false)} border-dashed`}
                      title={t('自定义场景(最多 {max} 个)', { max: MAX_CUSTOM_SCENES })}
                      onClick={() => setSceneEditor({ index: null, name: '', text: '' })}
                    >
                      <Plus size={12} />{t('自定义')}
                    </button>
                  )}
                </div>
              </div>

              {ab && (
                <AbCompare
                  ab={ab} source={text} running={running}
                  sourceLabel={detectedLabel && prefs.source === 'auto' ? t('原文 · {lang}', { lang: detectedLabel }) : t('原文')}
                  onVote={(c) => void vote(c)} onAdopt={adopt} onStop={stop}
                />
              )}

              {/* panes — on desktop both sides share one fixed height (each
                  scrolls itself), so a long 译文 never towers over the 原文.
                  Phones keep the stacked, auto-growing layout. */}
              <div className={`grid gap-4 md:grid-cols-2 ${ab ? 'hidden' : showCompare ? 'md:hidden' : ''}`}>
                <Card
                  title={t('原文')}
                  flush
                  actions={(
                    <>
                      {text && (
                        <Button variant="ghost" size="sm" title={t('清空')} onClick={() => { setText(''); stop(); setResult(''); setDetected(null); setError(null); setStats(null); }}>
                          <X size={14} />
                        </Button>
                      )}
                      {runControl}
                    </>
                  )}
                >
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value.slice(0, maxChars))}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (canRun) void run(text); }
                    }}
                    placeholder={t('输入或粘贴文本,然后点上方「翻译」(Ctrl + Enter)…')}
                    rows={12}
                    className="block min-h-[16rem] w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed text-tx outline-none placeholder:text-tx3 md:h-[calc(100dvh-26rem)] md:min-h-[18rem] md:resize-none"
                    autoFocus
                  />
                  <div className="flex h-10 items-center justify-end border-t border-line px-4">
                    <span className="text-xs tabular-nums text-tx3">{text.length.toLocaleString(locale)} / {maxChars.toLocaleString(locale)}</span>
                  </div>
                </Card>

                <Card
                  title={t('译文')}
                  flush
                  actions={result ? (
                    <>
                      {copyBtn}
                      <span className="max-md:hidden">
                        <Button variant="ghost" size="sm" title={t('逐段对照阅读原文与译文')} onClick={() => setCompare(true)}>
                          <BookOpenText size={14} />{t('对照')}
                        </Button>
                      </span>
                    </>
                  ) : undefined}
                >
                  <div className="min-h-[16rem] px-4 py-3 md:h-[calc(100dvh-26rem)] md:min-h-[18rem] md:overflow-y-auto">
                    {error && (
                      <div className="mb-3 whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                        {t('翻译失败:{error}', { error })}
                      </div>
                    )}
                    {running && !result && !error && (
                      <div className="flex items-center gap-2 py-2 text-sm text-tx3">
                        <Spinner className="h-4 w-4" />{thinking ? t('思考中…') : t('翻译中…')}
                      </div>
                    )}
                    {!running && !result && !error && (
                      <p className="py-2 text-sm text-tx3">{t('译文会显示在这里')}</p>
                    )}
                    {result && (
                      <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-tx">{result}</div>
                    )}
                  </div>
                  <div className="flex h-10 items-center justify-between gap-3 border-t border-line px-4 text-xs text-tx3">
                    {statsLine}
                  </div>
                </Card>
              </div>

              {/* 对照阅读 — desktop only; paragraph i of the 原文 sits beside
                  paragraph i of the 译文, hover highlights the pair. */}
              {showCompare && !ab && (
                <Card
                  title={t('对照阅读')}
                  desc={detectedLabel && prefs.source === 'auto' ? t('检测到源语言:{lang}', { lang: detectedLabel }) : undefined}
                  flush
                  className="hidden md:block"
                  actions={(
                    <>
                      {copyBtn}
                      <Button variant="ghost" size="sm" title={t('返回左右分栏,可继续编辑原文')} onClick={() => setCompare(false)}>
                        <Columns2 size={14} />{t('分栏')}
                      </Button>
                    </>
                  )}
                >
                  {error && (
                    <div className="mx-4 mt-3 whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                      {t('翻译失败:{error}', { error })}
                    </div>
                  )}
                  {!compareData.aligned && !running && (
                    <div className="border-b border-line px-4 py-1.5 text-xs text-tx3">
                      {t('原文与译文的段落数不一致,逐段对照可能错位;悬停高亮仅供参考。')}
                    </div>
                  )}
                  <div className="py-1">
                    {compareData.rows.map(([src, dst], i) => (
                      <div key={i} className="grid grid-cols-2 transition-colors hover:bg-acc/[0.08]">
                        <div className="whitespace-pre-wrap break-words px-4 py-2 text-[15px] leading-relaxed text-tx2">{src}</div>
                        <div className="whitespace-pre-wrap break-words border-l border-line px-4 py-2 text-[15px] leading-relaxed text-tx">{dst}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex h-10 items-center justify-between gap-3 border-t border-line px-4 text-xs text-tx3">
                    {statsLine}
                  </div>
                </Card>
              )}

              <p className="text-xs leading-relaxed text-tx3">
                {t('场景只影响译文的语气和用词,不改变翻译规则。翻译用量计入你的 token 配额;思考模式更准确但更慢、更贵。')}
              </p>
            </>
          )}
        </div>
      </div>

      <Modal
        open={!!sceneEditor}
        onClose={() => setSceneEditor(null)}
        title={sceneEditor?.index === null ? t('新建自定义场景') : t('编辑自定义场景')}
        desc={t('用一两句话描述译文应有的语气、用词或读者。这段话会作为风格偏好加入翻译指令。')}
      >
        {sceneEditor && (
          <form onSubmit={(e) => { e.preventDefault(); submitScene(); }} className="space-y-4">
            <Field label={t('场景名称')} hint={t('显示在场景标签上,20 字以内')}>
              <Input value={sceneEditor.name} maxLength={20} autoFocus
                onChange={(e) => setSceneEditor({ ...sceneEditor, name: e.target.value })}
                placeholder={t('例如:给客户的周报')} />
            </Field>
            <Field label={t('风格描述')} hint={`${sceneEditor.text.length} / ${cfg?.maxSceneChars ?? 300}`}>
              <Textarea rows={4} value={sceneEditor.text} maxLength={cfg?.maxSceneChars ?? 300}
                onChange={(e) => setSceneEditor({ ...sceneEditor, text: e.target.value })}
                placeholder={t('例如:面向日本客户的周报,用敬体(です・ます),数据部分保留阿拉伯数字,语气稳重不夸张。')} />
            </Field>
            <ModalActions>
              {sceneEditor.index !== null && (
                <Button variant="ghost" className="mr-auto text-err" disabled={savingScene} onClick={deleteScene}>{t('删除')}</Button>
              )}
              <Button variant="outline" onClick={() => setSceneEditor(null)}>{t('取消')}</Button>
              <Button variant="primary" disabled={savingScene} onClick={submitScene}>
                {savingScene && <Spinner className="h-3.5 w-3.5" />}{t('保存')}
              </Button>
            </ModalActions>
          </form>
        )}
      </Modal>
    </div>
  );
}

// Fixed column height on desktop (each column scrolls itself, like the panes
// above); phones grow with the text.
const AB_PANE = 'min-h-[8rem] md:h-[calc(100dvh-34rem)] md:min-h-[14rem] md:overflow-y-auto';

/** The blind comparison: 原文 beside 译文 1 and 译文 2 on wide screens, folded
    above them on narrow ones. */
function AbCompare({ ab, source, sourceLabel, running, onVote, onAdopt, onStop }: {
  ab: AbState; source: string; sourceLabel: string; running: boolean;
  onVote(choice: AbChoice): void; onAdopt(side: 0 | 1): void; onStop(): void;
}) {
  const ready = !!ab.id;
  // Finished without a recorded comparison (stopped, or cut short): nothing
  // to vote on, but either translation can still be kept.
  const unvotable = !running && !ready;
  return (
    <section className="fade-up overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
      <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-acc/10 text-acc">
          <Scale size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold tracking-tight text-tx">{t('哪一份译文更好?')}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-tx3">
            {unvotable
              ? t('这次对比没有完成,不计入投票。可以任选一份继续使用。')
              : t('这次请两个模型各译了一份,左右顺序随机。选出你更满意的那份,它就是这次的译文。')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={onStop}><Square size={11} fill="currentColor" />{t('停止')}</Button>
          ) : !unvotable && (
            <Button variant="ghost" size="sm" disabled={!!ab.voting} title={t('不投票,直接用译文 1')} onClick={() => onAdopt(0)}>
              {t('跳过@@ab')}
            </Button>
          )}
        </div>
      </div>

      <details className="group border-b border-line lg:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-tx2 hover:text-tx [&::-webkit-details-marker]:hidden">
          <ChevronRight size={13} className="transition-transform group-open:rotate-90" />{sourceLabel}
        </summary>
        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-5 pb-3 text-[14px] leading-relaxed text-tx2">{source}</div>
      </details>

      <div className="grid md:grid-cols-2 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="hidden min-w-0 flex-col bg-bg0/60 lg:flex">
          <div className="flex h-10 items-center px-4 text-xs font-medium text-tx3">{sourceLabel}</div>
          <div className={`${AB_PANE} whitespace-pre-wrap break-words px-4 pb-3 text-[15px] leading-relaxed text-tx2`}>{source}</div>
        </div>
        {ab.sides.map((side, i) => (
          <AbColumn key={i} index={i as 0 | 1} side={side} running={running} ready={ready}
            voting={ab.voting} unvotable={unvotable} onVote={onVote} onAdopt={onAdopt} />
        ))}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-line px-5 py-3 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-tx3">
          {t('投票时,原文和两份译文会一并提交给管理员,用于比较翻译模型;不投票则不保存内容。')}
        </p>
        {!unvotable && (
          <Button variant="outline" size="sm" disabled={!ready || !!ab.voting} onClick={() => onVote('tie')}
            title={t('两份质量相当,用译文 1 继续')}>
            {ab.voting === 'tie' ? <Spinner className="h-3.5 w-3.5" /> : <Equal size={13} />}{t('差不多')}
          </Button>
        )}
      </div>
    </section>
  );
}

function AbColumn({ index, side, running, ready, voting, unvotable, onVote, onAdopt }: {
  index: 0 | 1; side: AbSide; running: boolean; ready: boolean; voting: AbChoice | null; unvotable: boolean;
  onVote(choice: AbChoice): void; onAdopt(side: 0 | 1): void;
}) {
  const [copied, setCopied] = useState(false);
  const choice: AbChoice = index === 0 ? 'first' : 'second';
  const chosen = voting === choice;
  // A side is finished once its usage arrived; the other may still be going.
  const finished = !!side.stats || !running;
  async function copy() {
    await navigator.clipboard.writeText(side.text);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className={`flex min-w-0 flex-col transition-[background-color,opacity] duration-150 ${
      index === 0 ? 'lg:border-l' : 'border-t md:border-l md:border-t-0'} border-line ${
      chosen ? 'bg-acc/[0.06]' : 'has-[.ab-pick:hover]:bg-acc/[0.04]'} ${voting && !chosen && voting !== 'tie' ? 'opacity-55' : ''}`}>
      <div className="flex h-10 items-center gap-2 px-4">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
          chosen ? 'bg-acc text-accfg' : 'bg-bg3 text-tx2'}`}>{index + 1}</span>
        <span className="text-xs font-medium text-tx2">{t('译文 {n}', { n: index + 1 })}</span>
        {side.text && finished && (
          <Button variant="ghost" size="iconSm" className="ml-auto" title={t('复制这份译文')} onClick={copy}>
            {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
          </Button>
        )}
      </div>
      <div className={`${AB_PANE} px-4 pb-3`}>
        {side.text ? (
          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-tx">{side.text}</div>
        ) : running ? (
          // Same words for both sides: "思考中" would hint which model is which.
          <div className="flex items-center gap-2 py-0.5 text-sm text-tx3"><Spinner className="h-4 w-4" />{t('翻译中…')}</div>
        ) : (
          <p className="py-0.5 text-sm text-tx3">{t('没有内容')}</p>
        )}
      </div>
      <div className="border-t border-line px-4 py-2.5">
        {unvotable ? (
          <Button variant="outline" size="sm" className="w-full" disabled={!side.text} onClick={() => onAdopt(index)}>
            {t('用这份')}
          </Button>
        ) : (
          <Button variant={chosen ? 'primary' : 'outline'} size="sm" className="ab-pick w-full"
            disabled={!ready || !!voting} onClick={() => onVote(choice)}
            title={ready ? undefined : t('两份都译完后就可以选')}>
            {chosen ? <Spinner className="h-3.5 w-3.5" /> : <ThumbsUp size={13} />}
            {!ready && side.stats ? t('等另一份译完…') : t('这份更好')}
          </Button>
        )}
      </div>
    </div>
  );
}
