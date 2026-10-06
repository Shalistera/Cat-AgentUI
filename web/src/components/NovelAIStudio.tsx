import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Bookmark, Download, Image as ImageIcon, Move, Palette, Plus, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { Button, Field, Input, Select, Spinner, Textarea, btnClass, toast } from './ui';
import type { ImageModel, ImageRecord } from '../types';
import { NAI_SIZES, NAI_STYLES, newNaiDraft, normalizeNaiDraft, type NaiDraft, type NaiOptions, type NaiImageRequest, type NaiStyle } from '../novelai';

type NaiConfig = { uc: Record<string, string>; helpers: { id: string; name: string; isDefault: boolean }[] };
type Subscription = { available: boolean; active: boolean; opus: boolean; percent: number | null; anlas: number | null; refillSeconds: number | null; reason: string | null };
type Prepared = { basePrompt: string; negativePrompt: string; characters: { prompt: string; negativePrompt: string }[] };
function sourceSignature(draft: NaiDraft) {
  const o = draft.options;
  return JSON.stringify([draft.scene, o.negativeDescription, o.characters.map(c => [c.name, c.description, c.negativeDescription]), draft.helperModelId]);
}

function loadDraft(key: string) {
  try { return normalizeNaiDraft(JSON.parse(localStorage.getItem(key) || 'null')); } catch { return newNaiDraft(); }
}
function loadStyles(key: string): NaiStyle[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(list)) return [];
    return list.slice(0, 24).filter(s => typeof s?.name === 'string' && typeof s?.tags === 'string')
      .map(s => ({ name: s.name.slice(0, 40), tags: s.tags.slice(0, 2000), artists: normalizeNaiDraft({ options: { artists: s.artists } }).options.artists }));
  } catch { return []; }
}

function ArtistInput({ value, onChange, modelId, index }: { value: string; onChange(v: string): void; modelId: string; index: number }) {
  const [tags, setTags] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let current = true; setTags([]);
    if (!focused || value.trim().length < 2) return;
    const timer = setTimeout(() => {
      api.get<{ tags: { tag: string }[] }>(`/api/images/novelai/${modelId}/tags?q=${encodeURIComponent(value.slice(0, 100))}`)
        .then(r => { if (current) setTags(r.tags.map(t => t.tag)); }).catch(() => {});
    }, 350);
    return () => { current = false; clearTimeout(timer); };
  }, [value, focused, modelId]);
  return <div className="relative min-w-0">
    <Input aria-label={`画师 ${index + 1} 的 tag`} value={value} maxLength={160} placeholder="画师 tag" onChange={e => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
    {focused && tags.length > 0 && <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-line bg-bg1 p-1 shadow-lg">
      {tags.map(tag => <button key={tag} type="button" className="block w-full break-words rounded p-2 text-left text-xs hover:bg-bg2" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(tag); setFocused(false); }}>{tag}</button>)}
    </div>}
  </div>;
}

export function NovelAIStudio({ open, onClose, userId, models, modelId, onModelChange, initial, onSubmit, busy, error, image, onCancel }: {
  open: boolean; onClose(): void; userId: string; models: ImageModel[]; modelId: string; onModelChange(id: string): void;
  initial?: { id: string; draft: NaiDraft } | null;
  onSubmit(request: NaiImageRequest): Promise<boolean>; busy: boolean; error?: string | null;
  image?: ImageRecord; onCancel?: () => void;
}) {
  const key = `cat-nai-draft:${userId}`, styleKey = `cat-nai-styles:${userId}`;
  const [draft, setDraft] = useState(() => loadDraft(key));
  const [styles, setStyles] = useState(() => loadStyles(styleKey));
  const [styleName, setStyleName] = useState('');
  const [styleOpen, setStyleOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState(0);
  const [conf, setConf] = useState<NaiConfig | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subscriptionError, setSubscriptionError] = useState('');
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const run = useRef(0);
  const preparationAbort = useRef<AbortController | null>(null);
  const openRef = useRef(open); openRef.current = open;
  const o = draft.options;
  const activeCharacter = Math.min(selected, Math.max(0, o.characters.length - 1));
  const [width, height] = draft.size.split('x').map(Number);
  const patch = (v: Partial<NaiDraft>) => { setDraft(d => ({ ...d, ...v })); setLocalError(''); };
  const options = (v: Partial<NaiOptions>) => { setDraft(d => ({ ...d, options: { ...d.options, ...v } })); setLocalError(''); };
  const character = (i: number, v: Partial<NaiOptions['characters'][number]>) => setDraft(d => ({ ...d, options: { ...d.options, characters: d.options.characters.map((c, n) => n === i ? { ...c, ...v } : c) } }));

  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(draft)); setStorageWarning(false); } catch { setStorageWarning(true); } }, [key, draft]);
  useEffect(() => { try { localStorage.setItem(styleKey, JSON.stringify(styles)); } catch { setStorageWarning(true); } }, [styleKey, styles]);
  useEffect(() => { if (initial) { setDraft(normalizeNaiDraft(initial.draft)); setStep(0); setSubmitted(false); } }, [initial]);
  useEffect(() => {
    if (!open) { run.current++; preparationAbort.current?.abort(); return; }
    const el = dialog.current; if (!el) return;
    el.showModal();
    return () => { run.current++; preparationAbort.current?.abort(); el.close(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.get<NaiConfig>('/api/images/novelai/config').then(c => {
      if (!current) return; setConf(c);
      setDraft(d => {
        const next = { ...d, helperModelId: c.helpers.some(h => h.id === d.helperModelId) ? d.helperModelId : (c.helpers.find(h => h.isDefault) || c.helpers[0])?.id || '' };
        if (next.preparedFor === 'restored') next.preparedFor = sourceSignature(next);
        return next;
      });
    }).catch(e => { if (current) setLocalError(e.message); });
    return () => { current = false; };
  }, [open]);
  useEffect(() => {
    if (!open || !modelId) return;
    let current = true; setQuotaLoading(true); setSubscription(null); setSubscriptionError('');
    api.get<Subscription>(`/api/images/novelai/${modelId}/subscription`).then(s => { if (current) setSubscription(s); })
      .catch(e => { if (current) setSubscriptionError(e.message); }).finally(() => { if (current) setQuotaLoading(false); });
    return () => { current = false; };
  }, [open, modelId, refresh, busy]);

  async function prepare(signal: AbortSignal): Promise<NaiOptions> {
    if (draft.manual) return o;
    const signature = sourceSignature(draft);
    if (draft.preparedFor === signature) return o;
    let result: NaiOptions;
    if (draft.helperEnabled && draft.helperModelId) {
      const r = await api.post<Prepared>('/api/images/novelai/prepare', {
        modelId, helperModelId: draft.helperModelId, scene: draft.scene, negativePrompt: o.negativeDescription,
        characters: o.characters.map(c => ({ name: c.name, description: c.description, negativePrompt: c.negativeDescription })),
      }, signal);
      result = { ...o, basePrompt: r.basePrompt, negativePrompt: r.negativePrompt,
        characters: o.characters.map((c, i) => ({ ...c, ...r.characters[i] })) };
    } else result = { ...o, basePrompt: draft.scene, negativePrompt: o.negativeDescription,
      characters: o.characters.map(c => ({ ...c, prompt: c.description, negativePrompt: c.negativeDescription })) };
    return result;
  }
  async function generate(preview = false) {
    if (preparing || busy) return;
    if (!draft.scene.trim() && !(draft.manual && o.basePrompt.trim())) { setLocalError('先写下想画的内容。'); setStep(0); return; }
    if (o.characters.some(c => !(draft.manual ? c.prompt : c.description).trim())) { setLocalError('请补充每个角色的描述，或移除空白角色。'); setStep(1); return; }
    const version = ++run.current; setPreparing(true); setLocalError('');
    const controller = new AbortController(); preparationAbort.current = controller;
    try {
      const prepared = await prepare(controller.signal);
      if (run.current !== version || !openRef.current) return;
      if (!draft.manual) setDraft(d => ({ ...d, options: prepared, preparedFor: sourceSignature(draft) }));
      if (preview) { setShowPrompt(true); return; }
      const accepted = await onSubmit({ modelId, prompt: (draft.scene.trim() || prepared.basePrompt).slice(0, 4000), n: 1, size: draft.size,
        novelai: { ...prepared, sourceMode: draft.manual ? 'raw' : 'assisted', artists: prepared.artists.filter(a => a.tag.trim()).map(a => ({ ...a, tag: a.tag.trim() })) } });
      if (accepted) setSubmitted(true);
    } catch (e) { if (run.current === version) setLocalError(e instanceof Error ? e.message : '生成失败'); }
    finally { if (preparationAbort.current === controller) preparationAbort.current = null; setPreparing(false); }
  }
  function move(x: number, y: number, index = activeCharacter) {
    character(index, { x: Math.max(.02, Math.min(.98, x)), y: Math.max(.02, Math.min(.98, y)) });
  }
  function saveStyle() {
    const name = styleName.trim(); if (!name) { toast('先给画风取个名字'); return; }
    const value = { name, tags: o.stylePrompt, artists: o.artists.map(a => ({ ...a })) };
    if (!styles.some(s => s.name === name) && styles.length >= 24) { toast('最多保存 24 个画风', 'err'); return; }
    setStyles(s => [...s.filter(x => x.name !== name), value]); toast('画风已保存', 'ok');
  }
  if (!open) return null;
  const disabled = preparing || busy;
  return createPortal(<dialog ref={dialog} aria-labelledby="nai-studio-title" onCancel={e => { e.preventDefault(); onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}
    className="m-auto max-h-[94dvh] w-[calc(100%_-_24px)] max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-bg1 p-0 text-tx shadow-xl backdrop:bg-scrim open:flex">
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4">
      <Palette size={22} className="text-acc" /><div className="min-w-0 flex-1"><h2 id="nai-studio-title" className="font-semibold">NAI 创作</h2><p className="text-xs text-tx3">{['先说说你想画什么', '需要时，再给人物加一点细节', '最后选好画幅，就可以开始'][step]}</p></div>
      <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭 NAI 创作，保留草稿"><X size={18} /></Button>
    </header>
    <nav aria-label="NAI 创作步骤" className="grid shrink-0 grid-cols-3 gap-2 px-4 pt-3">
      {['描述与画风', '人物与位置', '画幅与生成'].map((label, i) => <button key={label} disabled={disabled} type="button" onClick={() => { setStep(i); setLocalError(''); }} aria-current={step === i ? 'step' : undefined}
        className={`border-b-2 px-1 py-2.5 text-xs sm:text-sm ${step === i ? 'border-acc text-acc' : 'border-line text-tx3'}`}>{i + 1} · {label}</button>)}
    </nav>
    <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
      <div className="grid items-start gap-5 md:grid-cols-[1.15fr_1fr]">
        <fieldset disabled={disabled} className="min-w-0 space-y-4">
          {step === 0 && <>
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">你想画什么？</h3><Button size="xs" variant="ghost" onClick={() => patch({ scene: '两位女孩坐在雨天的咖啡馆，白发女孩靠窗，黑发女孩坐在对面。她们一边喝热可可一边聊天，窗边有暖暖的灯光。' })}>试试示例</Button></div>
            <Textarea aria-label="画面描述" rows={5} value={draft.scene} maxLength={4000} placeholder="用平时说话的方式，描述人物、动作和场景就好。" onChange={e => patch({ scene: e.target.value })} />
            <p className="text-xs text-tx3">{draft.manual ? '原始提示词已锁定，修改这里不会覆盖它。' : draft.helperEnabled && draft.helperModelId ? '生成前会自动整理成适合 NAI 的英文描述与 tags，保留你的原意。' : '将直接使用你的描述，也支持自行填写英文或 tags。'}</p>
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">喜欢什么画风？</h3><Button variant="ghost" size="xs" onClick={() => setStyleOpen(!styleOpen)}>我的画风</Button></div>
            <div className="grid grid-cols-3 gap-2">{NAI_STYLES.map(s => <button key={s.name} type="button" aria-pressed={o.stylePrompt === s.tags} onClick={() => options({ stylePrompt: s.tags })} className={`rounded-lg border p-2 text-left ${o.stylePrompt === s.tags ? 'border-acc ring-1 ring-acc' : 'border-line'}`}>
              <span className="flex h-6 overflow-hidden rounded" aria-hidden="true">{s.colors.map(color => <span key={color} className="flex-1" style={{ background: color }} />)}</span><span className="mt-2 block text-xs">{s.name}</span>
            </button>)}</div>
            {styles.length > 0 && <div className="flex flex-wrap gap-2">{styles.map(s => <Button key={s.name} size="xs" onClick={() => { options({ stylePrompt: s.tags, artists: s.artists.map(a => ({ ...a })) }); setStyleName(s.name); }}><Bookmark size={12} />{s.name}</Button>)}</div>}
            {styleOpen && <section className="space-y-3 rounded-lg border border-line bg-bg0 p-3">
              <p className="text-xs text-tx3">保存喜欢的画师组合，之后换场景也能继续用。</p>
              {o.artists.map((a, i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_68px_28px] items-center gap-2"><ArtistInput value={a.tag} modelId={modelId} index={i} onChange={tag => options({ artists: o.artists.map((a, n) => n === i ? { ...a, tag } : a) })} /><Input aria-label={`画师 ${i + 1} 权重`} type="number" min={-3} max={3} step={.1} value={a.weight} onChange={e => options({ artists: o.artists.map((a, n) => n === i ? { ...a, weight: Math.max(-3, Math.min(3, Number(e.target.value))) } : a) })} /><Button size="iconXs" variant="ghost" aria-label={`移除画师 ${i + 1}`} onClick={() => options({ artists: o.artists.filter((_, n) => n !== i) })}><X size={14} /></Button></div>)}
              <Button size="xs" disabled={o.artists.length >= 12} onClick={() => options({ artists: [...o.artists, { tag: '', weight: 1 }] })}><Plus size={12} />添加画师 tag</Button>
              <Field label="风格 tags"><Textarea rows={2} value={o.stylePrompt} maxLength={2000} onChange={e => options({ stylePrompt: e.target.value })} /></Field>
              <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" aria-label="画风名称" maxLength={40} value={styleName} onChange={e => setStyleName(e.target.value)} placeholder="画风名称" /><Button size="sm" onClick={saveStyle}>保存画风</Button></div>
              {styles.some(s => s.name === styleName) && <Button size="xs" variant="ghost" onClick={() => setStyles(s => s.filter(x => x.name !== styleName))}>删除此已存画风</Button>}
            </section>}
          </>}
          {step === 1 && <>
            <p className="text-xs text-tx3">想固定外貌或分清人物时，再添加角色。留空也能画。</p>
            {o.characters.map((c, i) => <section key={i} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex items-center gap-2"><span className="text-xs text-tx3">{i + 1}</span><Input aria-label={`角色 ${i + 1} 名称`} value={c.name} maxLength={60} onChange={e => character(i, { name: e.target.value })} /><Button size="iconSm" variant="ghost" aria-label={`删除角色 ${i + 1}`} onClick={() => options({ characters: o.characters.filter((_, n) => n !== i) })}><X size={14} /></Button></div>
              <Textarea aria-label={`角色 ${i + 1} 描述`} rows={3} value={draft.manual ? c.prompt : c.description} maxLength={1500} placeholder="描述外貌、衣着和动作，中文就可以。" onChange={e => character(i, draft.manual ? { prompt: e.target.value } : { description: e.target.value })} />
              <details><summary className="cursor-pointer text-xs text-tx3">只对这个角色排除的内容</summary><Input className="mt-2" aria-label={`角色 ${i + 1} UC`} value={draft.manual ? c.negativePrompt : c.negativeDescription} maxLength={1000} onChange={e => character(i, draft.manual ? { negativePrompt: e.target.value } : { negativeDescription: e.target.value })} /></details>
            </section>)}
            <Button size="sm" disabled={o.characters.length >= 22} onClick={() => options({ characters: [...o.characters, { name: `角色 ${o.characters.length + 1}`, description: '', prompt: '', negativePrompt: '', negativeDescription: '', x: .5, y: .5 }] })}><Plus size={14} />添加角色</Button>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-acc" checked={o.useCoords} disabled={!o.characters.length} onChange={e => options({ useCoords: e.target.checked })} /><Move size={15} />手动安排角色位置</label>
          </>}
          {step === 2 && <>
            <Field label="模型"><Select value={modelId} onChange={e => onModelChange(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.displayName || m.modelId} · {m.providerName}</option>)}</Select></Field>
            <Field label="画幅 · Normal"><div className="grid grid-cols-3 gap-2">{NAI_SIZES.map((size, i) => <button type="button" key={size} aria-pressed={draft.size === size} onClick={() => patch({ size })} className={`rounded-lg border px-2 py-3 ${draft.size === size ? 'border-acc bg-acc/5 text-acc' : 'border-line'}`}><span className="block text-sm">{['竖图', '横图', '方图'][i]}</span><span className="text-[11px]">{size.replace('x', ' × ')}</span></button>)}</div></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-acc" checked={o.transparent} onChange={e => options({ transparent: e.target.checked })} />透明背景</label>
            <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm">排除内容与更多设置</summary><div className="mt-3 space-y-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-acc" checked={o.ucEnabled} onChange={e => options({ ucEnabled: e.target.checked })} />使用官方推荐 UC</label>
              <Select aria-label="官方 UC 预设" disabled={!o.ucEnabled} value={o.ucPreset} onChange={e => options({ ucPreset: e.target.value as NaiOptions['ucPreset'] })}><option value="heavy">Heavy · 官方默认</option><option value="light">Light · 轻量</option><option value="human">Human Focus · 人物</option><option value="furry">Furry Focus · 兽人</option></Select>
              <details><summary className="cursor-pointer text-xs text-tx3">查看官方 UC tags</summary><p className="mt-2 break-words text-xs text-tx3">{conf?.uc[o.ucPreset]}</p></details>
              <Field label="你不想出现的内容"><Textarea rows={2} value={draft.manual ? o.negativePrompt : o.negativeDescription} maxLength={2000} onChange={e => options(draft.manual ? { negativePrompt: e.target.value } : { negativeDescription: e.target.value })} placeholder="例如帽子、眼镜；也可填写 tags" /></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="步数（最多 28）"><Input type="number" min={1} max={28} value={o.steps} onChange={e => options({ steps: Math.max(1, Math.min(28, Math.round(Number(e.target.value) || 23))) })} /></Field><Field label="引导强度"><Input type="number" min={0} max={10} step={.1} value={o.scale} onChange={e => options({ scale: Math.max(0, Math.min(10, Number(e.target.value))) })} /></Field></div>
              <Field label="固定种子 Seed" hint="留空时每次生成新的变化"><Input type="number" min={0} max={4294967295} value={o.seed ?? ''} onChange={e => options({ seed: e.target.value === '' ? null : Math.max(0, Math.min(4294967295, Math.floor(Number(e.target.value)))) })} /></Field>
              <Field label="质量预设"><Select value={o.quality} onChange={e => options({ quality: e.target.value as NaiOptions['quality'] })}><option value="standard">Standard · 官方默认</option><option value="light">Light</option><option value="none">关闭</option></Select></Field>
              <Field label="画面中的文字"><Textarea rows={2} value={o.imageText} maxLength={models.find(m => m.id === modelId)?.modelId.endsWith('curated') ? 374 : 750} placeholder="需要写在图里的文字；不需要就留空" onChange={e => options({ imageText: e.target.value })} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-acc" checked={draft.helperEnabled} disabled={!conf?.helpers.length || draft.manual} onChange={e => patch({ helperEnabled: e.target.checked, preparedFor: '' })} />中文提示词助手</label>
              {conf?.helpers.length ? <Select aria-label="提示词助手模型" value={draft.helperModelId} disabled={!draft.helperEnabled || draft.manual} onChange={e => patch({ helperModelId: e.target.value, preparedFor: '' })}>{conf.helpers.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</Select> : <p className="text-xs text-tx3">没有可用的文字模型，将直接使用你的提示词。</p>}
              <p className="text-xs text-tx3">提示词助手使用面板文字模型的 token 额度，不使用 Anlas。</p>
            </div></details>
            <Button size="sm" onClick={() => void generate(true)}><Sparkles size={14} />整理并查看提示词</Button>
            <details open={showPrompt} onToggle={e => setShowPrompt(e.currentTarget.open)} className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm">专业编辑 · Base Prompt</summary><div className="mt-3 space-y-2">
              <Textarea aria-label="Base Prompt" rows={5} value={o.basePrompt} maxLength={6000} onChange={e => { setDraft(d => ({ ...d, manual: true, options: { ...d.options, basePrompt: e.target.value } })); }} />
              <p className="text-xs text-tx3">画师、风格、质量预设会单独追加。编辑此处将锁定原始提示词，角色步骤也会显示原始词。</p>
              {draft.manual && <Button size="xs" onClick={() => patch({ manual: false, preparedFor: '' })}>解除锁定，恢复中文整理</Button>}
            </div></details>
          </>}
        </fieldset>
        <aside className={`min-w-0 space-y-3 ${step === 0 && !busy && !submitted ? 'hidden md:block' : ''}`}>
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5 text-xs"><span>{step === 1 && o.useCoords ? '角色站位' : busy ? '正在生成' : '画面预览'}</span><span className="text-tx3">{draft.size.replace('x', ' × ')}</span></div>
            <div className="flex min-h-64 items-center justify-center bg-bg0 p-4">
              {busy ? <div role="status" className="flex flex-col items-center gap-3 py-12 text-sm text-tx3"><Spinner />图片正在生成，可以关闭弹窗继续其他操作。{onCancel && <Button size="sm" onClick={onCancel}>停止生成</Button>}</div> : step === 1 && o.useCoords && o.characters.length > 0 ? <div ref={canvas} role="group" aria-label="角色位置画布" className="relative w-full max-w-64 touch-none overflow-hidden rounded border border-line bg-bg1" style={{ aspectRatio: `${width}/${height}`, backgroundImage: 'linear-gradient(to right, transparent calc(100% - 1px),var(--color-line) 0),linear-gradient(to bottom,transparent calc(100% - 1px),var(--color-line) 0)', backgroundSize: '33.333% 33.333%' }}
                onPointerMove={e => { if (drag.current === null || disabled) return; const r = e.currentTarget.getBoundingClientRect(); move((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, drag.current); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
                {o.characters.map((c, i) => <button key={i} type="button" disabled={disabled} aria-label={`${c.name || `角色 ${i + 1}`}的位置，用方向键调整`} aria-pressed={activeCharacter === i}
                  onPointerDown={e => { if (disabled) return; setSelected(i); drag.current = i; canvas.current?.setPointerCapture(e.pointerId); e.preventDefault(); }}
                  onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); setSelected(i); const d = e.shiftKey ? .1 : .02; move(c.x + (e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0), c.y + (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0), i); }}
                  className={`absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border-2 border-bg1 text-xs shadow-md ${activeCharacter === i ? 'bg-accs text-accfg ring-2 ring-acc ring-offset-2' : 'bg-pri text-prifg'}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>{i + 1}</button>)}
              </div> : image ? <img src={`/api/images/${image.id}/file`} alt={image.prompt} className="max-h-80 max-w-full rounded object-contain" /> : <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-tx3"><ImageIcon size={26} strokeWidth={1.4} /><p>生成的图片会显示在这里</p></div>}
            </div>
            {step === 1 && o.useCoords && o.characters.length > 0 && <div className="space-y-2 border-t border-line p-3"><Select aria-label="要定位的角色" value={activeCharacter} disabled={disabled} onChange={e => setSelected(Number(e.target.value))}>{o.characters.map((c, i) => <option key={i} value={i}>{i + 1} · {c.name || '角色'}</option>)}</Select><div className="flex flex-wrap gap-2">{['靠左', '居中', '靠右'].map((label, i) => <Button key={label} size="xs" disabled={disabled} onClick={() => move([.25, .5, .75][i], .5)}>{label}</Button>)}</div><p className="text-xs text-tx3">拖动编号即可安排位置，也可以用方向键微调。</p></div>}
            {image && !busy && <div className="border-t border-line p-3"><a className={btnClass('outline', 'sm')} href={`/api/images/${image.id}/file`} download><Download size={14} />下载图片</a></div>}
          </div>
          <div className="rounded-lg border border-line p-3 text-xs">
            <div className="flex items-center justify-between"><span>Opus 订阅额度</span><Button size="iconXs" variant="ghost" disabled={quotaLoading || busy} onClick={() => setRefresh(n => n + 1)} aria-label="刷新订阅额度"><RefreshCw size={12} /></Button></div>
            {quotaLoading ? <p className="mt-2 text-tx3">正在查询…</p> : subscription ? <><p className="mt-2 font-medium">{subscription.percent === null ? '额度未知' : `剩余 ${subscription.percent}%`}</p><p className="mt-1 text-tx3">Anlas：{subscription.anlas ?? '未知'}（仅查看）</p>{subscription.reason && <p className="mt-2 text-warn">{subscription.reason}</p>}</> : <p className="mt-2 text-err">{subscriptionError || '暂时无法查询额度'}</p>}
          </div>
        </aside>
      </div>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-bg1 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1 text-xs"><p className="flex items-center gap-1.5 text-tx3"><ShieldCheck size={13} />订阅额度模式 · 单张 · 最多 28 步</p>{(localError || error) && <p role="alert" className="mt-1 text-err">{localError || error}</p>}{storageWarning && <p className="mt-1 text-warn">浏览器未能保存草稿，请暂时保留此页面。</p>}</div>
      <div className="flex w-full gap-2 sm:w-auto">{step > 0 && <Button disabled={disabled} onClick={() => setStep(s => s - 1)}><ArrowLeft size={14} />上一步</Button>}
        <Button variant="primary" className="min-w-36 flex-1" disabled={disabled || step === 2 && (!subscription?.available || quotaLoading)} onClick={() => {
          if (step === 0 && !draft.scene.trim() && !(draft.manual && o.basePrompt.trim())) { setLocalError('先写一点想画的内容。'); return; }
          if (step < 2) { setStep(s => s + 1); setLocalError(''); } else void generate();
        }}>{preparing ? <><Spinner className="h-4 w-4" />正在整理提示词</> : busy ? '正在生成…' : step < 2 ? <>下一步<ArrowRight size={14} /></> : <><Sparkles size={14} />生成 1 张</>}</Button>
      </div>
    </footer>
  </dialog>, document.body);
}
