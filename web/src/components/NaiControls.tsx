import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { Bookmark, ChevronDown, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { Button, Input, Textarea, Toggle, toast } from './ui';
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

/* ---------- tag suggestions ---------- */

// Shared across inputs and remounts: the same prefix typed twice costs one call.
const tagCache = new Map<string, string[]>();

function useTagSuggestions(modelId: string, query: string | null) {
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    const q = query?.trim() ?? '';
    // NAI suggests English Danbooru tags only; CJK input would never match.
    if (!modelId || q.length < 2 || !/[a-z]/i.test(q)) { setTags([]); return; }
    const key = `${modelId}\n${q.toLowerCase()}`;
    const hit = tagCache.get(key);
    if (hit) { setTags(hit); return; }
    setTags([]);
    let current = true;
    const timer = setTimeout(() => {
      api.get<{ tags: { tag: string }[] }>(`/api/images/novelai/${encodeURIComponent(modelId)}/tags?q=${encodeURIComponent(q.slice(0, 100))}`)
        .then((r) => {
          const list = r.tags.map((t) => t.tag).slice(0, 8);
          if (tagCache.size > 300) tagCache.delete(tagCache.keys().next().value!);
          tagCache.set(key, list);
          if (current) setTags(list);
        })
        .catch(() => { if (current) setTags([]); });
    }, 280);
    return () => { current = false; clearTimeout(timer); };
  }, [modelId, query]);
  return tags;
}

const STOP = ',\n';
/** The comma-separated chunk the caret sits in, minus leading emphasis syntax ({ [ or 1.2::). */
function tokenAt(text: string, caret: number) {
  let start = caret;
  while (start > 0 && !STOP.includes(text[start - 1])) start--;
  const raw = text.slice(start, caret);
  const lead = raw.match(/^\s*(?:[{[]+|-?\d+(?:\.\d+)?::)?\s*/)?.[0].length ?? 0;
  return { start: start + lead, query: raw.slice(lead) };
}

function Suggestions({ id, tags, active, onPick }: { id: string; tags: string[]; active: number; onPick(tag: string): void }) {
  return (
    <div id={id} role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line bg-bg1 py-1 shadow-lg">
      {tags.map((tag, i) => (
        <button key={tag} id={`${id}-${i}`} type="button" role="option" aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(tag)}
          className={`block w-full cursor-pointer truncate px-3 py-1.5 text-left font-mono text-xs ${i === active ? 'bg-acc/10 text-tx' : 'text-tx2 hover:bg-bg2'}`}>
          {tag}
        </button>
      ))}
      <div className="truncate border-t border-line px-3 pt-1 text-[11px] text-tx3">↑↓ 选择 · Enter 填入 · Esc 关闭</div>
    </div>
  );
}

/** Textarea that, when `suggest` is on, offers NAI tag completions for the chunk being typed. */
export function TagTextarea({ value, onChange, modelId, suggest, textareaRef, className = '', ...rest }: {
  value: string; onChange(v: string): void; modelId: string; suggest: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>; rows?: number; placeholder?: string; maxLength?: number;
  'aria-label'?: string; className?: string;
}) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  // After a pick the caret is restored programmatically; that select event
  // must not reopen the list on the tag just inserted. Typing clears it.
  const picked = useRef(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const tags = useTagSuggestions(modelId, suggest ? query : null);
  const open = suggest && query !== null && tags.length > 0;
  const listId = useId();

  function sync(el: HTMLTextAreaElement) {
    if (!suggest || el.selectionStart !== el.selectionEnd || document.activeElement !== el) { setQuery(null); return; }
    setQuery(tokenAt(el.value, el.selectionStart).query);
    setActive(0);
  }
  function pick(tag: string) {
    const el = local.current;
    if (!el) return;
    const caret = el.selectionStart;
    const { start } = tokenAt(value, caret);
    let end = caret;
    while (end < value.length && !',\n}]:'.includes(value[end])) end++;
    const atEnd = end >= value.length || value[end] === '\n';
    const insert = tag + (atEnd ? ', ' : '');
    const next = value.slice(0, start) + insert + value.slice(end);
    onChange(next.slice(0, rest.maxLength ?? next.length));
    setQuery(null);
    picked.current = true;
    const pos = start + insert.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  }
  return (
    <div className="relative">
      <Textarea
        {...rest}
        ref={(el) => {
          local.current = el;
          if (typeof textareaRef === 'function') textareaRef(el);
          else if (textareaRef) textareaRef.current = el;
        }}
        value={value}
        aria-autocomplete={suggest ? 'list' : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        className={`${suggest ? 'font-mono' : ''} ${className}`}
        onChange={(e) => { picked.current = false; onChange(e.target.value); sync(e.target); }}
        onSelect={(e) => { if (!picked.current) sync(e.currentTarget); }}
        onBlur={() => setQuery(null)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % tags.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + tags.length) % tags.length); }
          else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) || e.key === 'Tab') { e.preventDefault(); pick(tags[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(null); }
        }}
      />
      {open && <Suggestions id={listId} tags={tags} active={active} onPick={pick} />}
    </div>
  );
}

/** Single-tag input (artist names) with the same completions. */
function TagInput({ value, onChange, modelId, placeholder, label }: {
  value: string; onChange(v: string): void; modelId: string; placeholder?: string; label: string;
}) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const tags = useTagSuggestions(modelId, focused ? value : null).filter((t) => t !== value.trim());
  const open = focused && tags.length > 0;
  const listId = useId();
  function pick(tag: string) { onChange(tag); setFocused(false); }
  return (
    <div className="relative min-w-0 flex-1">
      <Input uiSize="sm" aria-label={label} value={value} maxLength={160} placeholder={placeholder}
        className="font-mono" aria-autocomplete="list" aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => { onChange(e.target.value); setActive(0); setFocused(true); }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % tags.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + tags.length) % tags.length); }
          else if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'Tab') { e.preventDefault(); pick(tags[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFocused(false); }
        }} />
      {open && <Suggestions id={listId} tags={tags} active={active} onPick={pick} />}
    </div>
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
      <Input uiSize="sm" type="number" aria-label={label} title="权重：1 为正常，越大影响越强"
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

export function StylePicker({ options, onChange, saved, onSaved, modelId }: {
  options: NaiOptions; onChange(v: Partial<NaiOptions>): void;
  saved: NaiStyle[]; onSaved(next: NaiStyle[]): void; modelId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const artists = options.artists.filter((a) => a.tag.trim());
  const preset = NAI_STYLES.find((s) => s.tags === options.stylePrompt.trim());
  const savedActive = saved.find((s) => s.tags === options.stylePrompt
    && JSON.stringify(s.artists) === JSON.stringify(options.artists));

  function save() {
    const n = name.trim();
    if (!n) { toast('先给这个画风起个名字', 'err'); return; }
    if (!saved.some((s) => s.name === n) && saved.length >= 24) { toast('最多保存 24 个画风', 'err'); return; }
    onSaved([...saved.filter((s) => s.name !== n), { name: n, tags: options.stylePrompt, artists: options.artists.map((a) => ({ ...a })) }]);
    toast(`已保存「${n}」`, 'ok');
  }

  return (
    <div className="space-y-3">
      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-tx3">我的画风</span>
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
          <Pencil size={14} />自定义
        </button>
      </div>
      {!editing && (artists.length > 0 || (!preset && options.stylePrompt.trim())) && (
        <button type="button" onClick={() => setEditing(true)}
          className="flex w-full cursor-pointer items-start gap-2 rounded-md bg-bg0 px-2.5 py-2 text-left text-xs text-tx2 hover:text-tx">
          <span className="min-w-0 flex-1 break-words">
            {artists.length > 0 && <>画师：<span className="font-mono">{artists.map((a) => a.weight === 1 ? a.tag : `${a.tag} ×${a.weight}`).join('、')}</span></>}
            {artists.length > 0 && !preset && options.stylePrompt.trim() && <br />}
            {!preset && options.stylePrompt.trim() && <>风格词：<span className="font-mono">{options.stylePrompt}</span></>}
          </span>
          <Pencil size={12} className="mt-0.5 shrink-0" />
        </button>
      )}
      {editing && (
        <div className="space-y-3 rounded-lg border border-line bg-bg0 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs leading-relaxed text-tx3">画师 tag 决定笔触和人物画法，权重越大影响越强。调好后可以保存，换个画面也能一键套用。</p>
            <Button size="iconXs" variant="ghost" title="收起" onClick={() => setEditing(false)}><X size={13} /></Button>
          </div>
          <div className="space-y-2">
            {options.artists.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <TagInput label={`画师 ${i + 1}`} value={a.tag} modelId={modelId} placeholder="artist:名字"
                  onChange={(tag) => onChange({ artists: options.artists.map((x, n) => n === i ? { ...x, tag } : x) })} />
                <WeightInput label={`画师 ${i + 1} 权重`} value={a.weight}
                  onChange={(weight) => onChange({ artists: options.artists.map((x, n) => n === i ? { ...x, weight } : x) })} />
                <Button size="iconSm" variant="dangerGhost" title="移除" onClick={() => onChange({ artists: options.artists.filter((_, n) => n !== i) })}>
                  <X size={14} />
                </Button>
              </div>
            ))}
            <Button size="xs" variant="outline" disabled={options.artists.length >= 12}
              onClick={() => onChange({ artists: [...options.artists, { tag: '', weight: 1 }] })}>
              <Plus size={12} />添加画师
            </Button>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-tx">风格词</span>
            <TagTextarea rows={2} value={options.stylePrompt} maxLength={2000} modelId={modelId} suggest
              placeholder="例如 watercolor, soft colors" onChange={(stylePrompt) => onChange({ stylePrompt })} />
          </label>
          <div className="flex gap-2">
            <Input uiSize="sm" aria-label="画风名称" maxLength={40} value={name} placeholder="给这个画风起个名字"
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(); }} />
            <Button size="sm" variant="outline" onClick={save}><Bookmark size={13} />保存</Button>
          </div>
          {saved.some((s) => s.name === name.trim()) && (
            <Button size="xs" variant="dangerGhost" onClick={() => { onSaved(saved.filter((s) => s.name !== name.trim())); toast('已删除', 'ok'); }}>
              <Trash2 size={12} />删除「{name.trim()}」
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- 人物 ---------- */

export function CharacterList({ characters, manual, useCoords, size, modelId, onChange, onUseCoords }: {
  characters: NaiCharacter[]; manual: boolean; useCoords: boolean; size: string; modelId: string;
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
              <Input uiSize="sm" aria-label={`人物 ${i + 1} 的称呼`} value={c.name} maxLength={60}
                placeholder={`称呼（可选），如「白发女孩」`} onChange={(e) => set(i, { name: e.target.value })} />
              <Button size="iconSm" variant="dangerGhost" title="删除这个人物"
                onClick={() => { onChange(characters.filter((_, n) => n !== i)); setOpenNeg(new Set()); }}>
                <Trash2 size={14} />
              </Button>
            </div>
            <TagTextarea rows={2} aria-label={`人物 ${i + 1} 的描述`} modelId={modelId} suggest={manual}
              value={manual ? c.prompt : c.description} maxLength={manual ? 2000 : 1500}
              placeholder={manual ? 'girl, white hair, long hair, blue eyes, school uniform' : '长相、发型、衣着、动作，比如：白色长发，蓝眼睛，穿校服，正在挥手'}
              onChange={(v) => set(i, manual ? { prompt: v } : { description: v })} />
            {negOpen ? (
              <Input uiSize="sm" aria-label={`人物 ${i + 1} 不想出现的内容`} value={neg} maxLength={1000}
                placeholder={manual ? 'hat, glasses' : '只针对 TA 排除的内容，比如：眼镜、帽子'} onFocus={keepNeg}
                onChange={(e) => { keepNeg(); set(i, manual ? { negativePrompt: e.target.value } : { negativeDescription: e.target.value }); }} />
            ) : (
              <button type="button" onClick={() => setOpenNeg((s) => new Set(s).add(i))}
                className="cursor-pointer text-xs text-tx3 hover:text-tx">+ 不想出现在 TA 身上的内容</button>
            )}
          </div>
        );
      })}
      <Button size="sm" variant="outline" className="w-full border-dashed" disabled={characters.length >= 22}
        onClick={() => onChange([...characters, newNaiCharacter(characters.length)])}>
        <Plus size={14} />添加人物
      </Button>
      {characters.length > 0 && (
        <div className="space-y-2.5 rounded-lg bg-bg0 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-tx">手动摆放位置</div>
              <div className="mt-0.5 text-xs text-tx3">{useCoords ? '拖动圆点安排每个人在画面中的位置' : '关闭时由 AI 按顺序自动安排'}</div>
            </div>
            <Toggle label="手动摆放位置" checked={useCoords} onChange={onUseCoords} />
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
      <div ref={box} role="group" aria-label="人物位置"
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
          <button key={i} type="button" aria-label={`${c.name || `人物 ${i + 1}`}的位置，可用方向键微调`} aria-pressed={sel === i}
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
      <p className="text-center text-[11px] text-tx3">选中圆点后点空白处也能移动 · 方向键微调</p>
    </div>
  );
}
