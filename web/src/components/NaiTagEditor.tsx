import {
  createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode, type Ref,
} from 'react';
import { flushSync } from 'react-dom';
import { BookMarked, BookmarkPlus, Braces, Brackets, Check, History, Languages, Library, Search, Trash2, WandSparkles } from 'lucide-react';
import { api } from '../api';
import { Button, Input, Popover, SegmentedControl, Spinner, Textarea, toast } from './ui';
import {
  addMissing, analyze, appendTags, cjkPieces, diffEdit, duplicateCount, emphasize, EMPTY_HISTORY, fmtWeight, HAS_CJK,
  HAS_WIDE, missingChunks, pieces, removeTag, replaceRanges, tagKey, tagSet, textStart, tidyPrompt, toHalfWidth, tokenAt, weightAt,
  type Analysis, type Edit, type TagGroup, type TagHistory, type TagStat,
} from '../naiTags';

/* ---------------------------------------------------------------------------
   Tag 模式 editing. The prompt stays a plain textarea — what's typed is what
   NovelAI gets — with help layered on: weights shown as colour, one-key
   emphasis, Chinese punctuation fixed while typing, completions from the
   user's own history, the 词库 and NovelAI, and saved tag groups.
   ------------------------------------------------------------------------ */

export interface NaiTagEnv {
  /** NAI model the completions are asked from. */
  modelId: string;
  /** Tags the user has generated with, most used first. */
  history: TagHistory;
  groups: TagGroup[];
  onGroups(next: TagGroup[]): void;
  /** Turns Chinese fragments into tags with the prompt helper; null without one. */
  convert: ((items: string[], signal?: AbortSignal) => Promise<string[]>) | null;
}
export const NaiTagContext = createContext<NaiTagEnv>({
  modelId: '', history: EMPTY_HISTORY, groups: [], onGroups: () => {}, convert: null,
});

type Library = typeof import('../naiTagLibrary');
let library: Library | null = null;
let loadingLibrary: Promise<Library> | null = null;
/** The 词库 module, fetched the first time something in Tag 模式 needs it. */
function useLibrary(enabled: boolean) {
  const [lib, setLib] = useState(library);
  useEffect(() => {
    if (!enabled || lib) return;
    let live = true;
    (loadingLibrary ??= import('../naiTagLibrary')).then(
      (m) => { library = m; if (live) setLib(m); },
      () => { loadingLibrary = null; },
    );
    return () => { live = false; };
  }, [enabled, lib]);
  return lib;
}

const finePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;

/* ---------- completions ---------- */

type Remote = { tag: string; count: number | null };
// Shared across inputs and remounts: the same prefix typed twice costs one call.
const tagCache = new Map<string, Remote[]>();
const matches = (tag: string, q: string) => tag.startsWith(q) || (q.length >= 2 && tag.split(/[\s()_:-]+/).some((w) => w.startsWith(q)));

/** NovelAI's own suggestions (English only), with how common each tag is. */
function useRemoteTags(modelId: string, query: string | null) {
  const [tags, setTags] = useState<Remote[]>([]);
  useEffect(() => {
    const q = query?.trim().toLowerCase() ?? '';
    if (!modelId || q.length < 2 || !/[a-z]/.test(q) || HAS_CJK.test(q)) { setTags([]); return; }
    const key = `${modelId}\n${q}`;
    const hit = tagCache.get(key);
    if (hit) { setTags(hit); return; }
    // Keep what still fits while the next answer is on its way: no flicker.
    setTags((prev) => prev.filter((t) => matches(t.tag.toLowerCase(), q)));
    let current = true;
    const timer = setTimeout(() => {
      api.get<{ tags: Remote[] }>(`/api/images/novelai/${encodeURIComponent(modelId)}/tags?q=${encodeURIComponent(q.slice(0, 100))}`)
        .then((r) => {
          const list = r.tags.slice(0, 8).map((t) => ({ tag: t.tag, count: typeof t.count === 'number' ? t.count : null }));
          if (tagCache.size > 300) tagCache.delete(tagCache.keys().next().value!);
          tagCache.set(key, list);
          if (current) setTags(list);
        })
        .catch(() => { if (current) setTags([]); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [modelId, query]);
  return tags;
}

type Item =
  | { kind: 'tag'; tag: string; zh?: string; count?: number | null; mine: boolean; have: boolean }
  | { kind: 'group'; group: TagGroup }
  | { kind: 'ai'; text: string };

/**
 * What to offer for the chunk being typed. English: the user's own tags
 * first, then NovelAI's, then the 词库. Chinese: the 词库, saved groups by
 * name, and — with a prompt helper — an AI conversion as the last resort.
 */
function buildItems(query: string, mine: TagStat[], remote: Remote[], lib: Library | null, groups: TagGroup[],
  present: Map<string, number>, ai: boolean): Item[] {
  const q = query.trim();
  if (!q) return [];
  const key = q.toLowerCase();
  const self = tagKey(q);
  const cjk = HAS_CJK.test(q);
  const mineSet = new Set(mine.map((m) => m.tag));
  const tags = new Map<string, Extract<Item, { kind: 'tag' }>>();
  const add = (tag: string, count?: number | null) => {
    const k = tagKey(tag);
    const cur = tags.get(k);
    if (cur) { if (count != null) cur.count = count; return; }
    // The chunk being typed is in the prompt too; it doesn't count as 已添加.
    const have = (present.get(k) ?? 0) - (k === self ? 1 : 0) > 0;
    tags.set(k, { kind: 'tag', tag, zh: lib?.zhLabel(k), count, mine: mineSet.has(k), have });
  };
  if (cjk) {
    for (const l of lib?.searchLibrary(q, 6) ?? []) add(l.tag);
  } else {
    let n = 0;
    for (const m of mine) {
      if (n >= 4) break;
      if (matches(m.tag, key)) { add(m.tag); n++; }
    }
    for (const r of remote) add(r.tag, r.count);
    for (const l of lib?.searchLibrary(q, 3) ?? []) add(l.tag);
  }
  const items: Item[] = [...tags.values()].slice(0, 8);
  for (const g of groups) {
    if (items.length >= 10) break;
    if (g.name.toLowerCase().includes(key)) items.push({ kind: 'group', group: g });
  }
  if (cjk && ai) items.push({ kind: 'ai', text: q });
  return items;
}

const fmtCount = (n: number | null | undefined) =>
  n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function Suggestions({ id, items, active, above, onPick }: {
  id: string; items: Item[]; active: number; above: boolean; onPick(item: Item): void;
}) {
  return (
    <div id={id} role="listbox" className={`absolute inset-x-0 z-30 overflow-hidden rounded-lg border border-line bg-bg1 py-1 shadow-lg ${above ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
      {items.map((item, i) => (
        <button key={item.kind === 'tag' ? item.tag : item.kind === 'group' ? `g:${item.group.name}` : 'ai'} id={`${id}-${i}`}
          type="button" role="option" aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(item)}
          className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs ${i === active ? 'bg-acc/10 text-tx' : 'text-tx2 hover:bg-bg2'}`}>
          {item.kind === 'tag' ? <>
            <span className="flex w-3 shrink-0 justify-center text-tx3">{item.mine && <History size={12} aria-label="用过" />}</span>
            <span className="min-w-0 truncate font-mono">{item.tag}</span>
            {item.zh && <span className="shrink-0 text-tx3">{item.zh}</span>}
            <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-tx3">{item.have ? '已添加' : fmtCount(item.count)}</span>
          </> : item.kind === 'group' ? <>
            <BookMarked size={12} className="shrink-0 text-acc" />
            <span className="shrink-0 font-medium">{item.group.name}</span>
            <span className="min-w-0 truncate font-mono text-tx3">{item.group.tags}</span>
          </> : <>
            <Languages size={12} className="shrink-0 text-acc" />
            <span className="min-w-0 truncate">用 AI 把「{item.text}」转成 tag</span>
          </>}
        </button>
      ))}
      <div className="truncate border-t border-line px-3 pt-1 text-[11px] text-tx3">↑↓ 选择 · Enter 填入 · Esc 关闭</div>
    </div>
  );
}

/* ---------- weight highlighting ---------- */

const STEP = Math.log(1.05);
const HIGHLIGHT: Record<string, CSSProperties> = {
  err: { backgroundColor: 'rgb(239 68 68 / 0.45)', borderRadius: 2 },
  neg: { backgroundColor: 'rgb(147 51 234 / 0.22)', borderRadius: 2 },
};
for (let n = 1; n <= 5; n++) {
  HIGHLIGHT[`up${n}`] = { backgroundColor: `rgb(245 158 11 / ${(0.1 + n * 0.07).toFixed(2)})`, borderRadius: 2 };
  HIGHLIGHT[`down${n}`] = { backgroundColor: `rgb(59 130 246 / ${(0.08 + n * 0.06).toFixed(2)})`, borderRadius: 2 };
}
function bucket(w: number) {
  if (w <= 0) return 'neg';
  const level = Math.round(Math.log(w) / STEP);
  return level > 0 ? `up${Math.min(level, 5)}` : level < 0 ? `down${Math.min(-level, 5)}` : '';
}

/**
 * Sits under a transparent textarea with the same box and font, painting
 * only backgrounds: stronger tags warm, weaker ones cool, stray brackets red.
 * The textarea still draws every glyph, so the two can't visibly disagree.
 */
function Backdrop({ text, analysis, innerRef }: { text: string; analysis: Analysis; innerRef: Ref<HTMLDivElement> }) {
  const parts = useMemo(() => {
    const keys: string[] = new Array(text.length).fill('');
    for (const s of analysis.spans) {
      const k = bucket(s.weight);
      for (let i = s.start; i < s.end && i < text.length; i++) keys[i] = k;
    }
    for (const e of analysis.errors) if (e < text.length) keys[e] = 'err';
    const out: ReactNode[] = [];
    for (let i = 0; i < text.length;) {
      let j = i + 1;
      while (j < text.length && keys[j] === keys[i]) j++;
      const chunk = text.slice(i, j);
      out.push(keys[i] ? <span key={i} style={HIGHLIGHT[keys[i]]}>{chunk}</span> : chunk);
      i = j;
    }
    return out;
  }, [text, analysis]);
  return (
    <div ref={innerRef} aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent bg-bg1 px-3 py-2 font-mono text-sm leading-relaxed text-transparent"
      style={{ scrollbarGutter: 'stable' }}>
      {parts}{'\n'}
    </div>
  );
}

/* ---------- the prompt field ---------- */

/**
 * Textarea for prompts. In Tag 模式 (`suggest`) it completes tags, colours
 * weights, turns Chinese punctuation into ASCII and takes Ctrl/⌘ + ↑↓ to
 * step emphasis; `tools` adds the button row (full for the main prompt,
 * icons only for the smaller fields).
 */
export function TagTextarea({ value, onChange, suggest, textareaRef, tools = 'none', pool = 'tags', className = '', ...rest }: {
  value: string; onChange(v: string): void; suggest: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>; rows?: number; placeholder?: string; maxLength?: number;
  'aria-label'?: string; className?: string;
  tools?: 'full' | 'compact' | 'none';
  /** Which remembered tags to offer: prompt tags or exclusions. */
  pool?: 'tags' | 'negative';
}) {
  const env = useContext(NaiTagContext);
  const local = useRef<HTMLTextAreaElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  // After an edit the caret is set programmatically; that select event must
  // not reopen the list on the tag just inserted. Typing clears it.
  const picked = useRef(false);
  // Our own execCommand edits fire input events too; they skip the typing helpers.
  const editing = useRef(false);
  const composing = useRef(false);
  // Last selection, for toolbar buttons pressed after the field lost focus.
  const sel = useRef<[number, number]>([value.length, value.length]);
  const pendingCaret = useRef<[number, number] | null>(null);
  const convertAbort = useRef<AbortController | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState<number | null>(null);
  const [above, setAbove] = useState(false);
  const [converting, setConverting] = useState(false);
  const lib = useLibrary(suggest);
  const remote = useRemoteTags(env.modelId, suggest && !converting ? query : null);
  const listId = useId();
  const max = rest.maxLength;

  const analysis = useMemo(() => (suggest ? analyze(value) : null), [suggest, value]);
  const present = useMemo(() => {
    const m = new Map<string, number>();
    if (suggest) for (const p of pieces(value)) {
      const k = tagKey(value.slice(p.coreStart, p.coreEnd));
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [suggest, value]);
  const items = useMemo(() => (suggest && query !== null && !converting
    ? buildItems(query, env.history[pool], remote, lib, env.groups, present, !!env.convert) : []),
  [suggest, query, converting, env.history, pool, remote, lib, env.groups, present, env.convert]);
  const open = items.length > 0;
  const act = Math.min(active, Math.max(0, items.length - 1));

  useLayoutEffect(() => {
    const c = pendingCaret.current;
    const el = local.current;
    if (!c || !el) return;
    pendingCaret.current = null;
    el.setSelectionRange(c[0], c[1]);
  }, [value]);
  useLayoutEffect(() => {
    const el = local.current;
    const b = backdrop.current;
    if (el && b) { b.scrollTop = el.scrollTop; b.scrollLeft = el.scrollLeft; }
  });
  // Open the list upward when the field sits low on the screen.
  useLayoutEffect(() => {
    if (!open || !local.current) return;
    const r = local.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setAbove(below < 300 && r.top > below);
  }, [open]);
  useEffect(() => () => convertAbort.current?.abort(), []);

  function sync(el: HTMLTextAreaElement) {
    sel.current = [el.selectionStart, el.selectionEnd];
    setCaret(document.activeElement === el ? el.selectionStart : null);
    // Composing text still completes: Android keyboards compose plain English words too.
    if (!suggest || el.selectionStart !== el.selectionEnd || document.activeElement !== el) { setQuery(null); return; }
    setQuery(tokenAt(el.value, el.selectionStart).query);
    setActive(0);
  }

  /**
   * Apply an edit through the browser's own editing, so Ctrl/⌘ + Z can undo
   * it like typing. Falls back to a plain state update where that's missing.
   */
  function apply(edit: Edit, keepQuery = false) {
    const el = local.current;
    if (!el) return;
    const cur = el.value;
    const next = cur.slice(0, edit.start) + edit.insert + cur.slice(edit.end);
    if (max !== undefined && next.length > max) { toast(`内容超出 ${max} 字的上限`, 'err'); return; }
    el.focus({ preventScroll: true });
    el.setSelectionRange(edit.start, edit.end);
    let done = false;
    editing.current = true;
    try {
      done = edit.insert ? document.execCommand('insertText', false, edit.insert)
        : edit.start === edit.end || document.execCommand('delete', false);
    } catch { done = false; } finally { editing.current = false; }
    if (!done || el.value !== next) {
      pendingCaret.current = [edit.selStart, edit.selEnd];
      onChange(next);
    } else el.setSelectionRange(edit.selStart, edit.selEnd);
    sel.current = [edit.selStart, edit.selEnd];
    setCaret(edit.selStart);
    if (!keepQuery) { picked.current = true; setQuery(null); }
  }

  /** 「，」→「, 」 and friends, right after they're typed or pasted. */
  function fixWidth() {
    const el = local.current;
    if (!el || composing.current || !HAS_WIDE.test(el.value)) return;
    const r = toHalfWidth(el.value, el.selectionStart);
    if (r.text === el.value) return;
    if (document.activeElement !== el) { onChange(r.text); return; }
    apply({ ...diffEdit(el.value, r.text), selStart: r.caret, selEnd: r.caret }, true);
    sync(el);
  }

  function pick(item: Item) {
    const el = local.current;
    if (!el) return;
    if (item.kind === 'ai') { convertAt(el.selectionStart); return; }
    const v = el.value;
    const c = el.selectionStart;
    const { start } = tokenAt(v, c);
    let end = c;
    while (end < v.length && !',\n}]:'.includes(v[end])) end++;
    const atEnd = end >= v.length || v[end] === '\n';
    // A group brings only the tags the prompt doesn't have yet.
    const insert = item.kind === 'group' ? missingChunks(v.slice(0, start) + v.slice(end), item.group.tags).join(', ') : item.tag;
    if (item.kind === 'group' && !insert) toast('这组 tag 都已经在了', 'info');
    const text = insert && atEnd ? `${insert}, ` : insert;
    apply({ start, end, insert: text, selStart: start + text.length, selEnd: start + text.length });
  }

  function selection(): [number, number] {
    const el = local.current;
    return el && document.activeElement === el ? [el.selectionStart, el.selectionEnd] : sel.current;
  }

  function step(dir: 1 | -1) {
    const el = local.current;
    if (!el) return;
    const [a, b] = selection();
    const r = emphasize(el.value, a, b, dir);
    if (typeof r === 'string') { toast(r, 'info'); return; }
    apply(r);
  }

  function tidy() {
    const el = local.current;
    if (!el) return;
    const r = tidyPrompt(el.value);
    if (r.text === el.value) { toast('格式已经很整齐了', 'info'); return; }
    apply(diffEdit(el.value, r.text));
    toast(r.removed ? `已整理，去掉 ${r.removed} 个重复的 tag` : '已整理格式', 'ok');
  }

  async function convert(ranges: { start: number; end: number; text: string }[]) {
    const el = local.current;
    if (!el || !env.convert || converting || !ranges.length) return;
    const items = [...new Set(ranges.map((r) => r.text.trim()))];
    if (items.length > 40) { toast('中文片段太多，一次最多转换 40 段', 'err'); return; }
    const snapshot = el.value;
    const ctrl = new AbortController();
    convertAbort.current = ctrl;
    setConverting(true);
    setQuery(null);
    try {
      const out = await env.convert(items, ctrl.signal);
      if (ctrl.signal.aborted) return;
      // The field is read-only meanwhile; let it take the edit again first.
      flushSync(() => setConverting(false));
      if (local.current?.value !== snapshot) return;
      const r = replaceRanges(snapshot, ranges, new Map(items.map((t, i) => [t, out[i] ?? ''])));
      if (!r.replaced) { toast('没有可以替换的内容', 'info'); return; }
      apply(diffEdit(snapshot, r.text));
      toast(`已转成 tag（${r.replaced} 处）`, 'ok');
    } catch (e) {
      if (!ctrl.signal.aborted) toast(e instanceof Error ? e.message : '转换失败', 'err');
    } finally {
      if (convertAbort.current === ctrl) { convertAbort.current = null; setConverting(false); }
    }
  }
  function convertAt(pos: number) {
    const v = local.current?.value ?? value;
    const p = pieces(v).find((x) => pos >= x.start && pos <= x.end && HAS_CJK.test(v.slice(x.coreStart, x.coreEnd)));
    if (p) void convert([{ start: p.ownStart, end: p.ownEnd, text: v.slice(p.ownStart, p.ownEnd) }]);
  }

  const showTools = suggest && tools !== 'none';
  const caretWeight = analysis && caret !== null ? weightAt(analysis, caret) : 1;
  const cjk = useMemo(() => (showTools ? cjkPieces(value) : []), [showTools, value]);
  // The piece being typed is the completion list's business, not the notice's.
  const cjkElsewhere = cjk.filter((p) => caret === null || caret < p.start || caret > p.end).length;

  return (
    <div className="space-y-1.5">
      {showTools && (
        <TagTools compact={tools === 'compact'} value={value} analysis={analysis!} caretWeight={caretWeight}
          busy={converting} pool={pool} onStep={step} onTidy={tidy}
          onReplace={(next) => onChange(max !== undefined ? next.slice(0, max) : next)}
          selectedText={() => { const [a, b] = selection(); return a === b ? '' : value.slice(Math.min(a, b), Math.max(a, b)); }} />
      )}
      <div className="relative">
        {suggest && analysis && <Backdrop text={value} analysis={analysis} innerRef={backdrop} />}
        <Textarea
          {...rest}
          ref={(el) => {
            local.current = el;
            if (typeof textareaRef === 'function') textareaRef(el);
            else if (textareaRef) textareaRef.current = el;
          }}
          value={value}
          readOnly={converting}
          spellCheck={suggest ? false : undefined}
          aria-autocomplete={suggest ? 'list' : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${act}` : undefined}
          aria-busy={converting || undefined}
          className={`relative ${suggest ? 'font-mono' : ''} ${className}`}
          style={suggest ? { backgroundColor: 'transparent', scrollbarGutter: 'stable' } : undefined}
          onChange={(e) => {
            const el = e.target;
            onChange(el.value);
            if (editing.current) return;
            picked.current = false;
            sync(el);
            // Punctuation waits until the input method has committed the text.
            if (suggest && !composing.current && !(e.nativeEvent as InputEvent).isComposing && HAS_WIDE.test(el.value)) requestAnimationFrame(fixWidth);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => {
            composing.current = false;
            const el = e.currentTarget;
            picked.current = false;
            sync(el);
            if (suggest) requestAnimationFrame(fixWidth);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (!picked.current) sync(el);
            else { sel.current = [el.selectionStart, el.selectionEnd]; setCaret(el.selectionStart); }
          }}
          onScroll={(e) => {
            const b = backdrop.current;
            if (b) { b.scrollTop = e.currentTarget.scrollTop; b.scrollLeft = e.currentTarget.scrollLeft; }
          }}
          onBlur={() => { setQuery(null); setCaret(null); }}
          onKeyDown={(e) => {
            // While an input method is composing, these keys pick its candidates.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (suggest && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
              && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              if (!converting) step(e.key === 'ArrowUp' ? 1 : -1);
              return;
            }
            if (!open) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((act + 1) % items.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((act - 1 + items.length) % items.length); }
            else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); pick(items[act]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(null); }
          }}
        />
        {open && <Suggestions id={listId} items={items} active={act} above={above} onPick={pick} />}
      </div>
      {showTools && (cjkElsewhere > 0 || converting) && (
        <div role="status" className="flex items-center gap-2 rounded-md bg-warn/10 py-1 pl-2.5 pr-1 text-xs text-warn">
          <Languages size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 leading-relaxed">
            {converting ? 'AI 正在把中文换成 tag…' : tools === 'compact' ? `有 ${cjkElsewhere} 处中文` : `有 ${cjkElsewhere} 处中文，NovelAI 只认英文 tag`}
          </span>
          {converting ? <>
            <Spinner className="h-3.5 w-3.5 shrink-0" />
            <Button size="xs" variant="ghost" onClick={() => { convertAbort.current?.abort(); convertAbort.current = null; setConverting(false); }}>取消</Button>
          </> : env.convert ? (
            <Button size="xs" variant="outline" onMouseDown={(e) => e.preventDefault()} onClick={() => void convert(cjkPieces(local.current?.value ?? value))}
              title="用提示词助手把中文片段换成英文 tag，其余内容不变（消耗文字模型额度）">
              转成 tag
            </Button>
          ) : <span className="shrink-0 pr-1.5 text-tx3">请改用英文</span>}
        </div>
      )}
    </div>
  );
}

/* ---------- tool row ---------- */

function TagTools({ compact, value, analysis, caretWeight, busy, pool, onStep, onTidy, onReplace, selectedText }: {
  compact: boolean; value: string; analysis: Analysis; caretWeight: number; busy: boolean;
  pool: 'tags' | 'negative'; onStep(dir: 1 | -1): void; onTidy(): void;
  onReplace(next: string): void; selectedText(): string;
}) {
  const stats = useMemo(() => ({
    count: pieces(value).filter((p) => p.coreStart < p.coreEnd).length,
    dupes: duplicateCount(value),
  }), [value]);
  // Buttons keep the caret where it is: pressing one must not blur the field.
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const size = compact ? 'iconSm' : 'xs';
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  let status: ReactNode = null;
  if (analysis.errors.length) status = <span className="text-err" title="多余或没闭合的括号已用红色标出">括号没配对</span>;
  else if (stats.dupes) status = <span className="text-warn" title="点「整理」可以去掉">{stats.dupes} 个重复</span>;
  else if (Math.abs(caretWeight - 1) > 1e-9) status = <span className="font-mono text-acc" title="光标处 tag 的实际权重：每层 { } ×1.05，每层 [ ] ÷1.05">×{fmtWeight(caretWeight)}</span>;
  else if (!compact && stats.count) status = <span>{stats.count} 个 tag</span>;
  return (
    <div role="toolbar" aria-label="Tag 工具" className={`flex items-center gap-0.5 ${compact ? '-ml-1.5' : '-ml-2'}`}>
      <Button size={size} variant="ghost" onMouseDown={keep} onClick={() => onStep(1)} disabled={busy}
        aria-label="加强" title={`加强：给光标所在或选中的 tag 加一层 { }（${mod} + ↑）`}>
        <Braces size={14} />{!compact && '加强'}
      </Button>
      <Button size={size} variant="ghost" onMouseDown={keep} onClick={() => onStep(-1)} disabled={busy}
        aria-label="减弱" title={`减弱：加一层 [ ]，或去掉一层 { }（${mod} + ↓）`}>
        <Brackets size={14} />{!compact && '减弱'}
      </Button>
      <Button size={size} variant="ghost" onMouseDown={keep} onClick={onTidy} disabled={busy || !value.trim()}
        aria-label="整理" title="整理：统一成英文逗号和空格，下划线换成空格，去掉重复的 tag">
        <WandSparkles size={14} />{!compact && '整理'}
      </Button>
      <TagLibrary compact={compact} value={value} pool={pool} onReplace={onReplace} selectedText={selectedText} disabled={busy} />
      <span className="ml-auto min-w-0 truncate pl-2 text-[11px] tabular-nums text-tx3">{status}</span>
    </div>
  );
}

/* ---------- tag library ---------- */

type Tab = 'mine' | 'saved' | 'lib';

function Chip({ tag, zh, on, zhFirst, title, onClick }: {
  tag: string; zh?: string; on: boolean; zhFirst?: boolean; title?: string; onClick(): void;
}) {
  return (
    <button type="button" aria-pressed={on} title={title ?? (on ? '已在提示词中，点一下移除' : '点一下加入')} onClick={onClick}
      className={`inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
        on ? 'border-acc bg-acc/10 text-tx' : 'border-line text-tx2 hover:border-line2 hover:text-tx'}`}>
      {on && <Check size={11} className="shrink-0 text-acc" />}
      {zhFirst && zh ? <>
        <span className="shrink-0">{zh}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-tx3">{tag}</span>
      </> : <>
        <span className="min-w-0 truncate font-mono">{tag}</span>
        {zh && <span className="shrink-0 text-[11px] text-tx3">{zh}</span>}
      </>}
    </button>
  );
}

/**
 * 「tag 库」: tags used before (常用), saved groups (收藏) and the built-in
 * 词库. Chips toggle: one click adds the tag, another removes it.
 */
function TagLibrary({ compact, value, pool, onReplace, selectedText, disabled }: {
  compact: boolean; value: string; pool: 'tags' | 'negative'; onReplace(next: string): void;
  selectedText(): string; disabled: boolean;
}) {
  const env = useContext(NaiTagContext);
  const [open, setOpen] = useState(false);
  const lib = useLibrary(open);
  const mine = env.history[pool];
  const [tab, setTab] = useState<Tab>('mine');
  // Until a tab is picked, open on 常用 when there is history, else the 词库.
  const tabChosen = useRef(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(0);
  const [name, setName] = useState('');
  const [toSave, setToSave] = useState('');
  const present = useMemo(() => tagSet(value), [value]);
  const key = q.trim().toLowerCase();

  function show(next: boolean) {
    // A disabled trigger lets clicks through to the popover's wrapper.
    if (next && disabled) return;
    if (next) {
      setToSave(selectedText());
      setQ('');
      if (!tabChosen.current) setTab(mine.length ? 'mine' : 'lib');
    }
    setOpen(next);
  }
  function toggle(tag: string) {
    const k = tagKey(tag);
    onReplace(present.has(k) ? removeTag(value, k) : appendTags(value, tag));
  }
  function insertGroup(g: TagGroup) {
    const r = addMissing(value, g.tags);
    if (!r.added) { toast('这组 tag 都已经在了', 'info'); return; }
    onReplace(r.text);
    toast(`已加入 ${r.added} 个 tag`, 'ok');
  }
  function save() {
    const n = name.trim();
    const text = (toSave || value.slice(0, textStart(value))).replace(/^[\s,]+|[\s,]+$/g, '').slice(0, 2000);
    if (!text) { toast('先写一些 tag 再收藏', 'err'); return; }
    if (!n) { toast('给这组 tag 起个名字', 'err'); return; }
    if (!env.groups.some((g) => g.name === n) && env.groups.length >= 60) { toast('最多收藏 60 组', 'err'); return; }
    env.onGroups([...env.groups.filter((g) => g.name !== n), { name: n, tags: text }]);
    setName('');
    toast(`已收藏「${n}」`, 'ok');
  }

  const mineShown = useMemo(() => mine.filter((t) => !key || t.tag.includes(key) || !!lib?.zhLabel(t.tag)?.includes(key)).slice(0, 80), [mine, key, lib]);
  const libShown = useMemo(() => (!lib ? [] : key ? lib.searchLibrary(key, 60) : lib.TAG_LIBRARY[cat]?.tags ?? []), [lib, key, cat]);
  const groupsShown = env.groups.filter((g) => !key || g.name.toLowerCase().includes(key) || g.tags.toLowerCase().includes(key));

  return (
    <Popover open={open} setOpen={show} width="w-[22rem]" trigger={
      <Button size={compact ? 'iconSm' : 'xs'} variant="ghost" aria-label="tag 库" aria-expanded={open} disabled={disabled}
        title="tag 库：用过的 tag、收藏的组合和常用词库，点一下加入">
        <Library size={14} />{!compact && 'tag 库'}
      </Button>
    }>
      <div className="flex max-h-[inherit] flex-col" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
        <div className="space-y-2 border-b border-line p-2.5">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
            <Input uiSize="sm" aria-label="搜索 tag" autoFocus={finePointer()} value={q} maxLength={60}
              placeholder="搜索 tag 或中文，如 双马尾" className="pl-8" onChange={(e) => setQ(e.target.value)} />
          </div>
          <SegmentedControl<Tab> value={tab} onChange={(t) => { tabChosen.current = true; setTab(t); }} options={[
            { value: 'mine', label: '常用' }, { value: 'saved', label: `收藏${env.groups.length ? ` ${env.groups.length}` : ''}` }, { value: 'lib', label: '词库' },
          ]} />
        </div>
        {tab === 'lib' && !key && lib && (
          <div className="flex flex-wrap gap-1 border-b border-line px-2.5 py-2">
            {lib.TAG_LIBRARY.map((c, i) => (
              <button key={c.name} type="button" aria-pressed={cat === i} onClick={() => setCat(i)}
                className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] transition-colors ${cat === i ? 'bg-pri text-prifg' : 'text-tx2 hover:bg-bg2 hover:text-tx'}`}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {tab === 'mine' && (mineShown.length ? (
            <div className="flex flex-wrap gap-1.5">
              {mineShown.map((t) => (
                <Chip key={t.tag} tag={t.tag} zh={lib?.zhLabel(t.tag)} on={present.has(t.tag)}
                  title={`用过 ${t.count} 次 · ${present.has(t.tag) ? '点一下移除' : '点一下加入'}`} onClick={() => toggle(t.tag)} />
              ))}
            </div>
          ) : (
            <p className="px-2 py-6 text-center text-xs leading-relaxed text-tx3">
              {key ? '没有找到用过的 tag' : pool === 'negative' ? '生成过的图片里排除过的内容会记在这里。' : '生成过的图片里用到的 tag 会按常用程度记在这里，下次一点就能加入。'}
            </p>
          ))}
          {tab === 'lib' && (!lib ? (
            <div className="flex justify-center py-6 text-tx3"><Spinner /></div>
          ) : libShown.length ? (
            <div className="flex flex-wrap gap-1.5">
              {libShown.map((t) => <Chip key={t.tag} tag={t.tag} zh={t.zh} zhFirst on={present.has(t.tag)} onClick={() => toggle(t.tag)} />)}
            </div>
          ) : <p className="px-2 py-6 text-center text-xs text-tx3">词库里没有找到，可以直接在输入框里输入</p>)}
          {tab === 'saved' && (groupsShown.length ? (
            <div className="-mx-1 space-y-0.5">
              {groupsShown.map((g) => (
                <div key={g.name} className="flex items-start gap-1 rounded-md px-1 hover:bg-bg2">
                  <button type="button" onClick={() => insertGroup(g)} title="加入这组 tag（已经有的不会重复加入）"
                    className="min-w-0 flex-1 cursor-pointer px-1 py-1.5 text-left">
                    <span className="block truncate text-[13px] font-medium text-tx">{g.name}</span>
                    <span className="line-clamp-2 break-words font-mono text-[11px] leading-relaxed text-tx3">{g.tags}</span>
                  </button>
                  <Button size="iconXs" variant="dangerGhost" className="mt-1.5" title={`删除「${g.name}」`}
                    onClick={() => { env.onGroups(env.groups.filter((x) => x.name !== g.name)); toast('已删除', 'ok'); }}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-2 py-6 text-center text-xs leading-relaxed text-tx3">
              {key ? '没有找到收藏' : '把常用的一组 tag 存起来，比如角色的发型、发色和衣着，之后一键加入。'}
            </p>
          ))}
        </div>
        {tab === 'saved' && (
          <div className="space-y-1.5 border-t border-line p-2.5">
            <p className="text-[11px] text-tx3">{toSave ? '收藏选中的内容' : '收藏当前全部 tag'}</p>
            <div className="flex gap-1.5">
              <Input uiSize="sm" aria-label="收藏名称" value={name} maxLength={40} placeholder="起个名字，如「我的角色」"
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(); }} />
              <Button size="sm" variant="outline" onClick={save}><BookmarkPlus size={13} />收藏</Button>
            </div>
          </div>
        )}
      </div>
    </Popover>
  );
}

/* ---------- single tag ---------- */

/** One-tag input (artist names) with the same completions, history first. */
export function TagInput({ value, onChange, placeholder, label }: {
  value: string; onChange(v: string): void; placeholder?: string; label: string;
}) {
  const env = useContext(NaiTagContext);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const lib = useLibrary(focused);
  const remote = useRemoteTags(env.modelId, focused ? value : null);
  const items = useMemo(() => (focused
    ? buildItems(value, env.history.tags, remote, lib, [], new Map(), false).filter((i) => i.kind === 'tag' && i.tag !== value.trim())
    : []), [focused, value, env.history.tags, remote, lib]);
  const open = items.length > 0;
  const act = Math.min(active, Math.max(0, items.length - 1));
  const listId = useId();
  function pick(item: Item) { if (item.kind === 'tag') onChange(item.tag); setFocused(false); }
  return (
    <div className="relative min-w-0 flex-1">
      <Input uiSize="sm" aria-label={label} value={value} maxLength={160} placeholder={placeholder}
        className="font-mono" aria-autocomplete="list" aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${act}` : undefined} spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setActive(0); setFocused(true); }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((act + 1) % items.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((act - 1 + items.length) % items.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[act]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFocused(false); }
        }} />
      {open && <Suggestions id={listId} items={items} active={act} above={false} onPick={pick} />}
    </div>
  );
}
