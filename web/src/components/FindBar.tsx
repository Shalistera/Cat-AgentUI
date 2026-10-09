import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { t } from '../i18n';

/**
 * 对话内查找 — Ctrl/Cmd+F inside a conversation. Searches the RENDERED text
 * of every message in the scroll container (so Markdown, tables and code are
 * all findable exactly as displayed), paints the hits with the CSS Custom
 * Highlight API, and steps through them with Enter / Shift+Enter.
 *
 * Highlights are applied by the browser over the text without touching the
 * DOM — the React tree is never mutated. Browsers without the API still get
 * counts and scrolling, just no paint.
 */

const HL_ALL = 'find-all';
const HL_CUR = 'find-current';

const highlightsApi = typeof CSS !== 'undefined' && 'highlights' in CSS
  ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights
  : null;
const HighlightCtor = typeof window !== 'undefined'
  ? (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  : undefined;

function clearHighlights() {
  highlightsApi?.delete(HL_ALL);
  highlightsApi?.delete(HL_CUR);
}

/** Every match as a live Range, in document order. */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      // Skip anything not on screen (collapsed panels, hidden inputs) and
      // form controls — their value isn't a text node anyway.
      if (el.closest('[data-find-skip], textarea, input, script, style')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n.nodeValue!;
    const lower = text.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(q, from);
      if (i < 0) break;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      ranges.push(r);
      from = i + q.length;
    }
  }
  return ranges;
}

export function FindBar({ containerRef, open, onClose, initialQuery = '', version }: {
  containerRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  /** Pre-filled query, e.g. the sidebar search term that opened this chat. */
  initialQuery?: string;
  /** Bump to re-run the search (the conversation changed underneath). */
  version: number;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [cur, setCur] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) setQuery(initialQuery); }, [open, initialQuery]);
  useEffect(() => {
    if (open) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [open]);

  // Re-search on query / content change. Debounced: each keystroke walks the
  // whole conversation, which is fine for hundreds of messages but not per key.
  useEffect(() => {
    if (!open) { clearHighlights(); setRanges([]); return; }
    const root = containerRef.current;
    if (!root) return;
    const t = setTimeout(() => {
      const rs = collectRanges(root, query.trim());
      setRanges(rs);
      setCur((c) => Math.min(c, Math.max(0, rs.length - 1)));
    }, 120);
    return () => clearTimeout(t);
  }, [open, query, version, containerRef]);

  // A fresh query starts from the first hit.
  useEffect(() => { setCur(0); }, [query]);

  // Paint + scroll the current hit into view.
  useEffect(() => {
    if (!open) return;
    if (highlightsApi && HighlightCtor) {
      highlightsApi.set(HL_ALL, new HighlightCtor(...ranges));
      const c = ranges[cur];
      highlightsApi.set(HL_CUR, c ? new HighlightCtor(c) : new HighlightCtor());
    }
    const r = ranges[cur];
    const root = containerRef.current;
    if (r && root) {
      const rect = r.getBoundingClientRect();
      const host = root.getBoundingClientRect();
      // Scroll the container, not the window — centre the hit vertically.
      const target = root.scrollTop + (rect.top - host.top) - host.height / 2 + rect.height / 2;
      root.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }, [open, ranges, cur, containerRef]);

  useEffect(() => () => clearHighlights(), []);

  const step = useCallback((dir: 1 | -1) => {
    if (!ranges.length) return;
    setCur((c) => (c + dir + ranges.length) % ranges.length);
  }, [ranges.length]);

  if (!open) return null;
  const total = ranges.length;
  return (
    <div className="fade-up absolute right-4 top-3 z-20 flex items-center gap-1 rounded-lg border border-line2 bg-bg1 py-1 pl-2.5 pr-1 shadow-md sm:right-6" data-find-skip>
      <Search size={13} className="shrink-0 text-tx3" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder={t('在对话中查找')}
        aria-label={t('在对话中查找')}
        className="h-7 w-40 bg-transparent text-[13px] text-tx outline-none placeholder:text-tx3 sm:w-52"
      />
      <span className="min-w-[3.2rem] text-center text-[11px] tabular-nums text-tx3">
        {query.trim() ? (total ? `${cur + 1}/${total}` : '0/0') : ''}
      </span>
      <button title={t('上一个 (Shift+Enter)')} disabled={!total} onClick={() => step(-1)}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-35">
        <ChevronUp size={14} />
      </button>
      <button title={t('下一个 (Enter)')} disabled={!total} onClick={() => step(1)}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-35">
        <ChevronDown size={14} />
      </button>
      <button title={t('关闭 (Esc)')} onClick={onClose}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg2 hover:text-tx">
        <X size={14} />
      </button>
    </div>
  );
}
