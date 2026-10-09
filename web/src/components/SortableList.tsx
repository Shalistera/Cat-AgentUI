import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { t } from '../i18n';

/* Hand-rolled pointer-based drag sort — a dependency for two flat lists would
   be overkill. The dragged row is reordered live (the array is re-spliced as
   the pointer crosses row boundaries), so there is no transform math and rect
   measurements are always taken from the real layout.

   The pointer is captured by the list CONTAINER, not the handle: reordering
   re-inserts row nodes, and a capture held by a re-inserted element is
   released by the browser mid-drag. The container never moves, so its capture
   survives, and move/up events retarget to it while the drag is live.
   `touch-action: none` on the handle stops touch scrolling from stealing the
   gesture on mobile. */

interface DragState<T> {
  key: string;
  items: T[];
  moved: boolean;
  scrollParent: HTMLElement | null;
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.scrollHeight > cur.clientHeight + 1) {
      const { overflowY } = getComputedStyle(cur);
      if (overflowY === 'auto' || overflowY === 'scroll') return cur;
    }
  }
  return null;
}

export function SortableList<T>(props: {
  items: T[];
  keyOf(item: T): string;
  /** Called once on drop, with the full reordered list. */
  onReorder(next: T[]): void;
  /** `handle` must be rendered somewhere inside the row; it owns the gesture.
      `index` is the live position, updating while the row is dragged. */
  renderItem(item: T, handle: ReactNode, dragging: boolean, index: number): ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const { keyOf } = props;
  const [drag, setDrag] = useState<DragState<T> | null>(null);
  const dragRef = useRef<DragState<T> | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);

  // The list can be swapped out under us (SSE refresh) — a stale drag would
  // then commit ids that no longer exist, so just cancel it.
  useEffect(() => {
    if (dragRef.current) { dragRef.current = null; setDrag(null); }
  }, [props.items]);

  const items = drag?.items ?? props.items;

  function start(e: React.PointerEvent, key: string) {
    if (props.disabled || dragRef.current) return;
    e.preventDefault();
    try { listRef.current?.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const d: DragState<T> = {
      key, items: props.items.slice(), moved: false,
      scrollParent: findScrollParent(listRef.current),
    };
    dragRef.current = d;
    setDrag(d);
  }

  function move(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const y = e.clientY;
    const sc = d.scrollParent;
    if (sc) {
      const r = sc.getBoundingClientRect();
      if (y < r.top + 32) sc.scrollTop -= 12;
      else if (y > r.bottom - 32) sc.scrollTop += 12;
    }
    const from = d.items.findIndex((it) => keyOf(it) === d.key);
    if (from < 0) return;
    let to = from;
    for (let i = 0; i < d.items.length; i++) {
      if (i === from) continue;
      const el = rowRefs.current.get(keyOf(d.items[i]));
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { to = i; break; }
    }
    if (to === from) return;
    const next = d.items.slice();
    const [movedItem] = next.splice(from, 1);
    next.splice(to, 0, movedItem);
    const nd = { ...d, items: next, moved: true };
    dragRef.current = nd;
    setDrag(nd);
  }

  function end(commit: boolean) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    if (commit && d.moved) props.onReorder(d.items);
  }

  return (
    <div
      ref={listRef}
      className={props.className}
      onPointerMove={move}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
    >
      {items.map((item, index) => {
        const key = keyOf(item);
        const dragging = drag?.key === key;
        const handle = props.disabled ? null : (
          <span
            role="button"
            aria-label={t('拖动排序')}
            title={t('拖动排序')}
            className={`touch-none select-none px-0.5 py-1 text-tx3 hover:text-tx ${
              dragging ? 'cursor-grabbing' : 'cursor-grab'
            }`}
            onPointerDown={(e) => start(e, key)}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={14} />
          </span>
        );
        return (
          <div
            key={key}
            ref={(el) => { if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key); }}
            className={dragging ? 'relative z-10 bg-bg2 shadow-md' : undefined}
          >
            {props.renderItem(item, handle, dragging, index)}
          </div>
        );
      })}
    </div>
  );
}
