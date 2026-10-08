import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanelLeft, Languages, ArrowRightLeft, Copy, Check, X, Square, Pencil, Plus, Zap, Brain,
  BookOpenText, Columns2,
} from 'lucide-react';
import { api, streamSse, fmtDuration, fmtTokens } from '../api';
import { useAuth, useUi } from '../store';
import {
  Button, Card, Field, Input, Modal, ModalActions, Select, Spinner, PageHeader, EmptyState,
  SegmentedControl, Textarea, toast,
} from '../components/ui';
import type { TranslateConfig, TranslateScene, User } from '../types';

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
  { id: 'general', name: '通用', text: '' },
  { id: 'formal', name: '正式书面', text: '正式书面文件:使用规范、正式的书面语,术语准确统一,句式完整,避免口语和缩略。' },
  { id: 'sns', name: '社交对话', text: '社交平台 / 聊天对话:口语化、轻松自然,像母语者在聊天软件或社交媒体上的表达,可保留语气词和常见网络用语,但不要额外添加表情符号。' },
  { id: 'tech', name: '技术文档', text: '技术文档:面向开发者,术语按行业惯例翻译或保留英文原文,代码、命令、参数名一律不译,表述精确简洁。' },
  { id: 'business', name: '商务邮件', text: '商务邮件:礼貌、专业、简洁,符合目标语言的商务书信惯例与敬语习惯。' },
];

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
      .catch((e) => setCfgError(e instanceof Error ? e.message : '加载翻译配置失败'));
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
      toast(e instanceof Error ? e.message : '保存场景失败', 'err');
    } finally {
      setSavingScene(false);
    }
  }

  function submitScene() {
    if (!sceneEditor) return;
    const name = sceneEditor.name.trim();
    const text = sceneEditor.text.trim();
    if (!name) { toast('请填写场景名称', 'err'); return; }
    if (!text) { toast('请描述这个场景希望的语气或用词', 'err'); return; }
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
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const modeAvailable = cfg ? cfg[prefs.mode] : false;

  const run = useCallback(async (input: string) => {
    const body = input.trim();
    abortRef.current?.abort();
    if (!body || !cfg) { setResult(''); setDetected(null); setError(null); setStats(null); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true); setResult(''); setDetected(null); setError(null); setStats(null); setThinking(false); setCompare(false);
    try {
      let out = '';
      let status = 'done';
      await streamSse('/api/translate/stream', {
        text: body, source: prefs.source, target: prefs.target,
        mode: prefs.mode, level: prefs.level, scene: activeScene.text,
      }, (event, data) => {
        if (event === 'delta') { out += data.text ?? ''; setResult(out); }
        else if (event === 'detected') setDetected(String(data.lang ?? ''));
        else if (event === 'thinking') setThinking(true);
        else if (event === 'usage') setStats({ totalTokens: data.totalTokens ?? 0, durationMs: data.durationMs ?? 0 });
        else if (event === 'error') setError(data.message ?? '翻译失败');
        else if (event === 'done') status = data.status ?? 'done';
      }, ctrl.signal);
      if (status === 'stopped' && !ctrl.signal.aborted) toast('输出已达上限,译文可能不完整', 'err');
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : '翻译失败');
    } finally {
      if (abortRef.current === ctrl) { setRunning(false); abortRef.current = null; }
    }
  }, [cfg, prefs.source, prefs.target, prefs.mode, prefs.level, activeScene.text]);

  function stop() { abortRef.current?.abort(); setRunning(false); abortRef.current = null; }

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
    ? (languages[normalizeDetected(detected, languages, prefs.target)] ?? detected.toUpperCase())
    : null;
  const canRun = !!text.trim() && modeAvailable && !running;
  const maxChars = cfg?.maxChars ?? 20_000;

  // 对照阅读 is desktop-only: on phones the panes stack vertically anyway, so
  // the normal view stays and the compare card is hidden via CSS.
  const compareData = useMemo(() => pairParagraphs(text, result), [text, result]);
  const showCompare = compare && !!result;

  const runControl = running ? (
    <Button variant="outline" size="sm" onClick={stop}><Square size={11} fill="currentColor" />停止</Button>
  ) : (
    <Button variant="primary" size="sm" disabled={!canRun} onClick={() => void run(text)}>
      {prefs.mode === 'default' ? <Languages size={13} /> : prefs.mode === 'fast' ? <Zap size={13} /> : <Brain size={13} />}翻译
    </Button>
  );
  const copyBtn = (
    <Button variant="ghost" size="sm" title="复制译文" onClick={copy}>
      {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
    </Button>
  );
  const statsLine = (
    <>
      <span>{prefs.mode === 'default' ? '默认 · 管理员预设' : prefs.mode === 'fast' ? '快速模式' : `思考模式 · 强度${['', '低', '中', '高'][prefs.level]}`}{activeScene.id !== 'general' ? ` · ${activeScene.name}` : ''}</span>
      {stats && <span className="tabular-nums">{fmtTokens(stats.totalTokens)} tokens · {fmtDuration(stats.durationMs)}</span>}
    </>
  );

  const chip = (active: boolean) =>
    `inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors ${
      active ? 'border-acc bg-acc/10 text-acc' : 'border-line bg-bg1 text-tx2 hover:border-line2 hover:text-tx'}`;

  return (
    <div className="contents">
      <PageHeader
        title="翻译工坊"
        subtitle="左边输入,点「翻译」,右边出译文"
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
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
              <EmptyState icon={<Languages size={22} />} title="翻译工坊暂不可用" hint={cfgError} />
            </Card>
          )}
          {cfg && !cfg.default && !cfg.fast && !cfg.think && (
            <Card flush>
              <EmptyState
                icon={<Languages size={22} />}
                title="管理员尚未配置翻译模型"
                hint="请管理员在「管理后台 → 应用设置 → 翻译工坊」中为默认、快速或思考模式指定至少一个模型。"
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
                      <option value="auto">{detectedLabel && prefs.source === 'auto' ? `检测到:${detectedLabel}` : '自动检测'}</option>
                      {langEntries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                    </Select></div>
                    <Button variant="ghost" size="iconSm" title="交换语言(译文回填为原文)" onClick={swap}>
                      <ArrowRightLeft size={14} />
                    </Button>
                    <div className="min-w-0 flex-1 sm:w-36 sm:flex-none"><Select value={prefs.target} onChange={(e) => patchPrefs({ target: e.target.value })}>
                      {langEntries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                    </Select></div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                    <SegmentedControl<Mode>
                      value={prefs.mode}
                      onChange={(m) => {
                        if (m === 'default' && !cfg.default) { toast('管理员尚未配置默认档的模型', 'err'); return; }
                        if (m === 'fast' && !cfg.fast) { toast('管理员尚未配置快速模式的模型', 'err'); return; }
                        if (m === 'think' && !cfg.think) { toast('管理员尚未配置思考模式的模型', 'err'); return; }
                        patchPrefs({ mode: m });
                      }}
                      options={[
                        { value: 'default', label: '默认' },
                        { value: 'fast', label: '快速' },
                        { value: 'think', label: '思考' },
                      ]}
                    />
                    {prefs.mode === 'default' && <span className="text-xs text-tx3">使用管理员预设</span>}
                    {prefs.mode === 'think' && <div className="flex items-center gap-1.5" title="思考强度">
                      <span className="text-xs text-tx3">强度</span>
                      <SegmentedControl<Level>
                        value={prefs.level}
                        onChange={(l) => patchPrefs({ level: l })}
                        options={[{ value: 1, label: '低' }, { value: 2, label: '中' }, { value: 3, label: '高' }]}
                      />
                    </div>}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs text-tx3">场景</span>
                  {scenes.map((s) => {
                    const active = s.id === activeScene.id;
                    const customIndex = s.id.startsWith('custom:') ? Number(s.id.slice(7)) : null;
                    return (
                      <button
                        key={s.id} type="button" className={chip(active)} title={s.text || '不附加风格要求'}
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
                      title={`自定义场景(最多 ${MAX_CUSTOM_SCENES} 个)`}
                      onClick={() => setSceneEditor({ index: null, name: '', text: '' })}
                    >
                      <Plus size={12} />自定义
                    </button>
                  )}
                </div>
              </div>

              {/* panes — on desktop both sides share one fixed height (each
                  scrolls itself), so a long 译文 never towers over the 原文.
                  Phones keep the stacked, auto-growing layout. */}
              <div className={`grid gap-4 md:grid-cols-2 ${showCompare ? 'md:hidden' : ''}`}>
                <Card
                  title="原文"
                  flush
                  actions={(
                    <>
                      {text && (
                        <Button variant="ghost" size="sm" title="清空" onClick={() => { setText(''); stop(); setResult(''); setDetected(null); setError(null); setStats(null); }}>
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
                    placeholder="输入或粘贴文本,然后点上方「翻译」(Ctrl + Enter)…"
                    rows={12}
                    className="block min-h-[16rem] w-full resize-y bg-transparent px-4 py-3 text-[15px] leading-relaxed text-tx outline-none placeholder:text-tx3 md:h-[calc(100dvh-26rem)] md:min-h-[18rem] md:resize-none"
                    autoFocus
                  />
                  <div className="flex h-10 items-center justify-end border-t border-line px-4">
                    <span className="text-xs tabular-nums text-tx3">{text.length.toLocaleString()} / {maxChars.toLocaleString()}</span>
                  </div>
                </Card>

                <Card
                  title="译文"
                  flush
                  actions={result ? (
                    <>
                      {copyBtn}
                      <span className="max-md:hidden">
                        <Button variant="ghost" size="sm" title="逐段对照阅读原文与译文" onClick={() => setCompare(true)}>
                          <BookOpenText size={14} />对照
                        </Button>
                      </span>
                    </>
                  ) : undefined}
                >
                  <div className="min-h-[16rem] px-4 py-3 md:h-[calc(100dvh-26rem)] md:min-h-[18rem] md:overflow-y-auto">
                    {error && (
                      <div className="mb-3 whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                        翻译失败:{error}
                      </div>
                    )}
                    {running && !result && !error && (
                      <div className="flex items-center gap-2 py-2 text-sm text-tx3">
                        <Spinner className="h-4 w-4" />{thinking ? '思考中…' : '翻译中…'}
                      </div>
                    )}
                    {!running && !result && !error && (
                      <p className="py-2 text-sm text-tx3">译文会显示在这里</p>
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
              {showCompare && (
                <Card
                  title="对照阅读"
                  desc={detectedLabel && prefs.source === 'auto' ? `检测到源语言:${detectedLabel}` : undefined}
                  flush
                  className="hidden md:block"
                  actions={(
                    <>
                      {copyBtn}
                      <Button variant="ghost" size="sm" title="返回左右分栏,可继续编辑原文" onClick={() => setCompare(false)}>
                        <Columns2 size={14} />分栏
                      </Button>
                    </>
                  )}
                >
                  {error && (
                    <div className="mx-4 mt-3 whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                      翻译失败:{error}
                    </div>
                  )}
                  {!compareData.aligned && !running && (
                    <div className="border-b border-line px-4 py-1.5 text-xs text-tx3">
                      原文与译文的段落数不一致,逐段对照可能错位;悬停高亮仅供参考。
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
                场景只影响译文的语气和用词,不改变翻译规则。翻译用量计入你的 token 配额;思考模式更准确但更慢、更贵。
              </p>
            </>
          )}
        </div>
      </div>

      <Modal
        open={!!sceneEditor}
        onClose={() => setSceneEditor(null)}
        title={sceneEditor?.index === null ? '新建自定义场景' : '编辑自定义场景'}
        desc="用一两句话描述译文应有的语气、用词或读者。这段话会作为风格偏好加入翻译指令。"
      >
        {sceneEditor && (
          <form onSubmit={(e) => { e.preventDefault(); submitScene(); }} className="space-y-4">
            <Field label="场景名称" hint="显示在场景标签上,20 字以内">
              <Input value={sceneEditor.name} maxLength={20} autoFocus
                onChange={(e) => setSceneEditor({ ...sceneEditor, name: e.target.value })}
                placeholder="例如:给客户的周报" />
            </Field>
            <Field label="风格描述" hint={`${sceneEditor.text.length} / ${cfg?.maxSceneChars ?? 300}`}>
              <Textarea rows={4} value={sceneEditor.text} maxLength={cfg?.maxSceneChars ?? 300}
                onChange={(e) => setSceneEditor({ ...sceneEditor, text: e.target.value })}
                placeholder="例如:面向日本客户的周报,用敬体(です・ます),数据部分保留阿拉伯数字,语气稳重不夸张。" />
            </Field>
            <ModalActions>
              {sceneEditor.index !== null && (
                <Button variant="ghost" className="mr-auto text-err" disabled={savingScene} onClick={deleteScene}>删除</Button>
              )}
              <Button variant="outline" onClick={() => setSceneEditor(null)}>取消</Button>
              <Button variant="primary" disabled={savingScene} onClick={submitScene}>
                {savingScene && <Spinner className="h-3.5 w-3.5" />}保存
              </Button>
            </ModalActions>
          </form>
        )}
      </Modal>
    </div>
  );
}
