import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bookmark, ChevronDown, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button, Input, Toggle, toast } from './ui';
import { TagInput, TagTextarea } from './NaiTagEditor';
import { t } from '../i18n';
import { NAI_CHAR_COLORS, NAI_STYLES, newNaiCharacter, type NaiCharacter, type NaiOptions, type NaiStyle } from '../novelai';

/* ---------------------------------------------------------------------------
   Building blocks of the NAI 创作室. Plain-language first: every technical
   knob sits behind a label that says what it does, not what it's called.
   ------------------------------------------------------------------------ */

export function PanelSection({ title, hint, action, children }: {
  title: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-tx">{title}</h3>
        {action}
      </div>
      {hint && <p className="-mt-1 text-xs leading-relaxed text-tx3">{hint}</p>}
      {children}
    </section>
  );
}

export function Collapsible({ title, summary, badge, open, onToggle, children }: {
  title: string; summary?: string; badge?: ReactNode; open: boolean; onToggle(): void; children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg2">
        <span className="shrink-0 text-[13px] font-semibold text-tx">{title}</span>
        {badge}
        <span className="ml-auto min-w-0 truncate text-xs text-tx3">{!open && summary}</span>
        <ChevronDown size={15} className={`shrink-0 text-tx3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="space-y-4 border-t border-line px-3 pb-3.5 pt-3">{children}</div>}
    </section>
  );
}

export function Slider({ label, value, min, max, step, onChange, format, hint }: {
  label: string; value: number; min: number; max: number; step: number; onChange(v: number): void;
  format?: (v: number) => string; hint?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium text-tx">{label}</span>
        <span className="tabular-nums text-tx2">{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full cursor-pointer accent-accs" />
      {hint && <div className="mt-0.5 text-xs leading-relaxed text-tx3">{hint}</div>}
    </label>
  );
}

/** Artist weight. Edits a string so the field can be cleared or start with "-"; only valid numbers reach the draft. */
function WeightInput({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);
  return (
    // Sized by a wrapper: Input always carries w-full.
    <div className="w-16 shrink-0">
      <Input uiSize="sm" type="number" aria-label={label} title={t('权重：1 为正常，越大影响越强')}
        min={-3} max={3} step={0.1} value={text} className="text-center tabular-nums"
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setText(String(value)); }}
        onChange={(e) => {
          setText(e.target.value);
          const w = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(w)) onChange(Math.round(Math.max(-3, Math.min(3, w)) * 100) / 100);
        }} />
    </div>
  );
}

/* ---------- 画风 ---------- */

/** One line naming the current 画风, for the collapsed section in Tag 模式. */
export function styleSummary(o: NaiOptions, saved: NaiStyle[]) {
  const mine = saved.find((s) => s.tags === o.stylePrompt && JSON.stringify(s.artists) === JSON.stringify(o.artists));
  if (mine) return mine.name;
  const artists = o.artists.filter((a) => a.tag.trim()).length;
  const preset = NAI_STYLES.find((s) => s.tags === o.stylePrompt.trim());
  const name = preset ? preset.name : t('自定义风格词');
  if (!artists) return preset && !preset.tags ? t('自动（不加画风词）') : name;
  return preset && !preset.tags ? t('{n} 位画师', { n: artists }) : t('{name} · {n} 位画师', { name, n: artists });
}

export function StylePicker({ options, onChange, saved, onSaved }: {
  options: NaiOptions; onChange(v: Partial<NaiOptions>): void;
  saved: NaiStyle[]; onSaved(next: NaiStyle[]): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const artists = options.artists.filter((a) => a.tag.trim());
  const preset = NAI_STYLES.find((s) => s.tags === options.stylePrompt.trim());
  const savedActive = saved.find((s) => s.tags === options.stylePrompt
    && JSON.stringify(s.artists) === JSON.stringify(options.artists));

  function save() {
    const n = name.trim();
    if (!n) { toast(t('先给这个画风起个名字'), 'err'); return; }
    if (!saved.some((s) => s.name === n) && saved.length >= 24) { toast(t('最多保存 24 个画风'), 'err'); return; }
    onSaved([...saved.filter((s) => s.name !== n), { name: n, tags: options.stylePrompt, artists: options.artists.map((a) => ({ ...a })) }]);
    toast(t('已保存「{name}」', { name: n }), 'ok');
  }

  return (
    <div className="space-y-3">
      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-tx3">{t('我的画风')}</span>
          {saved.map((s) => (
            <button key={s.name} type="button" aria-pressed={savedActive?.name === s.name}
              onClick={() => { onChange({ stylePrompt: s.tags, artists: s.artists.map((a) => ({ ...a })) }); setName(s.name); }}
              className={`inline-flex max-w-[160px] cursor-pointer items-center gap-1 truncate rounded-full border px-2.5 py-1 text-xs transition-colors ${
                savedActive?.name === s.name ? 'border-acc bg-acc/10 text-tx' : 'border-line text-tx2 hover:border-line2 hover:text-tx'}`}>
              <Bookmark size={11} className="shrink-0" /><span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-4 gap-2">
        {NAI_STYLES.map((s) => {
          const on = preset?.name === s.name;
          return (
            <button key={s.name} type="button" title={s.hint} aria-pressed={on}
              onClick={() => onChange({ stylePrompt: s.tags })}
              className={`group cursor-pointer rounded-lg border p-1 text-center transition-colors ${on ? 'border-acc ring-1 ring-acc' : 'border-line hover:border-line2'}`}>
              <span className="block h-10 rounded-md" style={{ background: s.swatch }} aria-hidden />
              <span className={`mt-1 block truncate text-[11px] ${on ? 'font-medium text-tx' : 'text-tx2 group-hover:text-tx'}`}>{s.name}</span>
            </button>
          );
        })}
        <button type="button" aria-expanded={editing} onClick={() => setEditing((v) => !v)}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-1 text-[11px] transition-colors ${
            editing || (!preset && !savedActive) ? 'border-acc text-acc' : 'border-line2 text-tx2 hover:border-tx3 hover:text-tx'}`}>
          <Pencil size={14} />{t('自定义')}
        </button>
      </div>
      {!editing && (artists.length > 0 || (!preset && options.stylePrompt.trim())) && (
        <button type="button" onClick={() => setEditing(true)}
          className="flex w-full cursor-pointer items-start gap-2 rounded-md bg-bg0 px-2.5 py-2 text-left text-xs text-tx2 hover:text-tx">
          <span className="min-w-0 flex-1 break-words">
            {artists.length > 0 && <>{t('画师：')}<span className="font-mono">{artists.map((a) => a.weight === 1 ? a.tag : `${a.tag} ×${a.weight}`).join(t('、'))}</span></>}
            {artists.length > 0 && !preset && options.stylePrompt.trim() && <br />}
            {!preset && options.stylePrompt.trim() && <>{t('风格词：')}<span className="font-mono">{options.stylePrompt}</span></>}
          </span>
          <Pencil size={12} className="mt-0.5 shrink-0" />
        </button>
      )}
      {editing && (
        <div className="space-y-3 rounded-lg border border-line bg-bg0 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs leading-relaxed text-tx3">{t('画师 tag 决定笔触和人物画法，权重越大影响越强。调好后可以保存，换个画面也能一键套用。')}</p>
            <Button size="iconXs" variant="ghost" title={t('收起')} onClick={() => setEditing(false)}><X size={13} /></Button>
          </div>
          <div className="space-y-2">
            {options.artists.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <TagInput label={t('画师 {n}', { n: i + 1 })} value={a.tag} placeholder={t('artist:名字')}
                  onChange={(tag) => onChange({ artists: options.artists.map((x, n) => n === i ? { ...x, tag } : x) })} />
                <WeightInput label={t('画师 {n} 权重', { n: i + 1 })} value={a.weight}
                  onChange={(weight) => onChange({ artists: options.artists.map((x, n) => n === i ? { ...x, weight } : x) })} />
                <Button size="iconSm" variant="dangerGhost" title={t('移除')} onClick={() => onChange({ artists: options.artists.filter((_, n) => n !== i) })}>
                  <X size={14} />
                </Button>
              </div>
            ))}
            <Button size="xs" variant="outline" disabled={options.artists.length >= 12}
              onClick={() => onChange({ artists: [...options.artists, { tag: '', weight: 1 }] })}>
              <Plus size={12} />{t('添加画师')}
            </Button>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-tx">{t('风格词')}</span>
            <TagTextarea rows={2} value={options.stylePrompt} maxLength={2000} suggest
              placeholder={t('例如 watercolor, soft colors')} onChange={(stylePrompt) => onChange({ stylePrompt })} />
          </label>
          <div className="flex gap-2">
            <Input uiSize="sm" aria-label={t('画风名称')} maxLength={40} value={name} placeholder={t('给这个画风起个名字')}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(); }} />
            <Button size="sm" variant="outline" onClick={save}><Bookmark size={13} />{t('保存')}</Button>
          </div>
          {saved.some((s) => s.name === name.trim()) && (
            <Button size="xs" variant="dangerGhost" onClick={() => { onSaved(saved.filter((s) => s.name !== name.trim())); toast(t('已删除'), 'ok'); }}>
              <Trash2 size={12} />{t('删除「{name}」', { name: name.trim() })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- 人物 ---------- */

export function CharacterList({ characters, manual, useCoords, size, onChange, onUseCoords }: {
  characters: NaiCharacter[]; manual: boolean; useCoords: boolean; size: string;
  onChange(next: NaiCharacter[]): void; onUseCoords(v: boolean): void;
}) {
  const [openNeg, setOpenNeg] = useState<Set<number>>(new Set());
  const set = (i: number, v: Partial<NaiCharacter>) => onChange(characters.map((c, n) => n === i ? { ...c, ...v } : c));
  return (
    <div className="space-y-2.5">
      {characters.map((c, i) => {
        const color = NAI_CHAR_COLORS[i % NAI_CHAR_COLORS.length];
        const neg = manual ? c.negativePrompt : c.negativeDescription;
        const negOpen = openNeg.has(i) || !!neg;
        const keepNeg = () => { if (!openNeg.has(i)) setOpenNeg((s) => new Set(s).add(i)); };
        return (
          <div key={i} className="space-y-2 rounded-lg border border-line p-2.5" style={{ borderLeft: `3px solid ${color}` }}>
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: color }}>{i + 1}</span>
              <Input uiSize="sm" aria-label={t('人物 {n} 的称呼', { n: i + 1 })} value={c.name} maxLength={60}
                placeholder={t('称呼（可选），如「白发女孩」')} onChange={(e) => set(i, { name: e.target.value })} />
              <Button size="iconSm" variant="dangerGhost" title={t('删除这个人物')}
                onClick={() => { onChange(characters.filter((_, n) => n !== i)); setOpenNeg(new Set()); }}>
                <Trash2 size={14} />
              </Button>
            </div>
            <TagTextarea rows={2} aria-label={t('人物 {n} 的描述', { n: i + 1 })} suggest={manual} tools="compact"
              value={manual ? c.prompt : c.description} maxLength={manual ? 2000 : 1500}
              placeholder={manual ? 'girl, white hair, long hair, blue eyes, school uniform' : t('长相、发型、衣着、动作，比如：白色长发，蓝眼睛，穿校服，正在挥手')}
              onChange={(v) => set(i, manual ? { prompt: v } : { description: v })} />
            {negOpen ? (
              <Input uiSize="sm" aria-label={t('人物 {n} 不想出现的内容', { n: i + 1 })} value={neg} maxLength={1000}
                placeholder={manual ? 'hat, glasses' : t('只针对 TA 排除的内容，比如：眼镜、帽子')} onFocus={keepNeg}
                onChange={(e) => { keepNeg(); set(i, manual ? { negativePrompt: e.target.value } : { negativeDescription: e.target.value }); }} />
            ) : (
              <button type="button" onClick={() => setOpenNeg((s) => new Set(s).add(i))}
                className="cursor-pointer text-xs text-tx3 hover:text-tx">{t('+ 不想出现在 TA 身上的内容')}</button>
            )}
          </div>
        );
      })}
      <Button size="sm" variant="outline" className="w-full border-dashed" disabled={characters.length >= 22}
        onClick={() => onChange([...characters, newNaiCharacter(characters.length)])}>
        <Plus size={14} />{t('添加人物')}
      </Button>
      {characters.length > 0 && (
        <div className="space-y-2.5 rounded-lg bg-bg0 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-tx">{t('手动摆放位置')}</div>
              <div className="mt-0.5 text-xs text-tx3">{useCoords ? t('拖动圆点安排每个人在画面中的位置') : t('关闭时由 AI 按顺序自动安排')}</div>
            </div>
            <Toggle label={t('手动摆放位置')} checked={useCoords} onChange={onUseCoords} />
          </div>
          {useCoords && <PositionCanvas characters={characters} size={size} onMove={(i, x, y) => set(i, { x, y })} />}
        </div>
      )}
    </div>
  );
}

function PositionCanvas({ characters, size, onMove }: {
  characters: NaiCharacter[]; size: string; onMove(i: number, x: number, y: number): void;
}) {
  const [w, h] = size.split('x').map(Number);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const [selected, setSelected] = useState(0);
  const sel = Math.min(selected, characters.length - 1);
  const clamp = (v: number) => Math.round(Math.max(0.02, Math.min(0.98, v)) * 100) / 100;
  function at(e: React.PointerEvent) {
    const r = box.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)] as const;
  }
  return (
    <div className="space-y-1.5">
      <div ref={box} role="group" aria-label={t('人物位置')}
        className="relative mx-auto w-full max-w-[200px] touch-none select-none overflow-hidden rounded-md border border-line2 bg-bg1"
        style={{
          aspectRatio: `${w} / ${h}`,
          backgroundImage: 'linear-gradient(to right, var(--color-line) 1px, transparent 1px), linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)',
          backgroundSize: '20% 20%',
        }}
        // Pressing empty canvas moves the selected person there and keeps dragging it.
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget || e.button !== 0) return;
          const [x, y] = at(e); onMove(sel, x, y);
          drag.current = sel; e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => { if (drag.current !== null) { const [x, y] = at(e); onMove(drag.current, x, y); } }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}>
        {characters.map((c, i) => (
          <button key={i} type="button" aria-label={t('{name}的位置，可用方向键微调', { name: c.name || t('人物 {n}', { n: i + 1 }) })} aria-pressed={sel === i}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault(); e.stopPropagation(); setSelected(i); drag.current = i; box.current?.setPointerCapture(e.pointerId);
            }}
            onKeyDown={(e) => {
              const d = e.shiftKey ? 0.1 : 0.02;
              const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
              const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
              if (!dx && !dy) return;
              e.preventDefault(); setSelected(i); onMove(i, clamp(c.x + dx), clamp(c.y + dy));
            }}
            className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-md active:cursor-grabbing ${sel === i ? 'z-10 ring-2 ring-acc ring-offset-1' : ''}`}
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, background: NAI_CHAR_COLORS[i % NAI_CHAR_COLORS.length] }}>
            {i + 1}
          </button>
        ))}
      </div>
      <p className="text-center text-[11px] text-tx3">{t('选中圆点后点空白处也能移动 · 方向键微调')}</p>
    </div>
  );
}
