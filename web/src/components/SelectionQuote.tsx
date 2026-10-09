import { useEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquareQuote } from 'lucide-react';
import { t } from '../i18n';

/**
 * 划词引用 — a floating "引用追问" chip that follows a text selection inside
 * any [data-quotable] block within `containerRef`. Clicking hands the
 * selected text to `onQuote` (the page turns it into a > blockquote in the
 * composer). Purely presentational: the selection itself is the browser's.
 */
export function SelectionQuote({ containerRef, onQuote }: {
  containerRef: RefObject<HTMLElement | null>;
  onQuote(text: string): void;
}) {
  const [hit, setHit] = useState<{ text: string; x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const compute = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setHit(null); return; }
      const text = sel.toString().replace(/\s+$/g, '').replace(/^\s+/g, '');
      if (text.length < 2) { setHit(null); return; }
      const range = sel.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor as Element;
      // Both ends must sit in one quotable block: no chips for selections
      // that sweep across the action bar or several messages.
      if (!el || !root.contains(el) || !el.closest('[data-quotable]')) { setHit(null); return; }
      const rects = range.getClientRects();
      const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      const host = root.getBoundingClientRect();
      setHit({
        text,
        x: Math.min(Math.max(last.right - host.left, 8), host.width - 8),
        y: last.bottom - host.top + root.scrollTop + 6,
      });
    };
    const schedule = () => {
      if (timer.current) window.clearTimeout(timer.current);
      // selectionchange fires per caret step; settle before measuring.
      timer.current = window.setTimeout(compute, 120);
    };
    const clearOnOutside = (e: PointerEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      // A fresh press means a new selection is starting (or a click clearing it).
      setHit(null);
    };
    document.addEventListener('selectionchange', schedule);
    root.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('pointerdown', clearOnOutside);
    return () => {
      document.removeEventListener('selectionchange', schedule);
      root.removeEventListener('scroll', schedule);
      document.removeEventListener('pointerdown', clearOnOutside);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [containerRef]);

  if (!hit) return null;
  return (
    <button
      ref={chipRef}
      type="button"
      title={t('把选中的文字作为引用放进输入框,再接着追问')}
      // Positioned in the scroll container's coordinate space — it moves with
      // the text rather than staying pinned to the viewport.
      style={{ left: hit.x, top: hit.y }}
      className="fade-up absolute z-20 flex -translate-x-full cursor-pointer items-center gap-1.5 rounded-full border border-line2 bg-bg1 px-3 py-1.5 text-xs font-medium text-tx shadow-md transition-colors hover:bg-bg2 hover:text-acc"
      onPointerDown={(e) => e.preventDefault() /* keep the selection alive through the click */}
      onClick={() => {
        onQuote(hit.text);
        document.getSelection()?.removeAllRanges();
        setHit(null);
      }}
    >
      <MessageSquareQuote size={13} />{t('引用追问')}
    </button>
  );
}

/** Markdown blockquote of the selection, one `>` per line, trailing blank line
    so the user's question lands below it rather than inside it. */
export function asQuote(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => `> ${l}`).join('\n');
}
