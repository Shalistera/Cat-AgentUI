import {
  useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ReasoningLevel } from '../types';

// A native <input type="range"> gives named, discrete levels nothing to hold on
// to: no visible stops, no labels, and a thumb that comes to rest between two
// meanings. This draws the ladder itself — one column per level, the whole
// column a hit target — so the control reads as "pick a rung", which is what it
// is. Click, drag and arrow keys all land on a named stop.
export function ReasoningSlider({ levels, index, onChange }: {
  levels: ReasoningLevel[];
  index: number;
  onChange(index: number): void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = levels.length - 1;
  const progress = last > 0 ? (index / last) * 100 : 0;

  // The hit area is the full width split into equal columns, one per label, so
  // the target you aim at is the word you read — not the dot above it.
  function pickAt(clientX: number) {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    const next = Math.min(last, Math.max(0, Math.floor(ratio * levels.length)));
    if (next !== index) onChange(next);
  }

  function step(delta: number) {
    const next = Math.min(last, Math.max(0, index + delta));
    if (next !== index) onChange(next);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    const move = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (move) { e.preventDefault(); step(move); return; }
    if (e.key === 'Home') { e.preventDefault(); onChange(0); }
    if (e.key === 'End') { e.preventDefault(); onChange(last); }
  }

  return (
    <div
      ref={boxRef}
      role="slider"
      tabIndex={0}
      aria-label="思考强度"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={levels[index]?.label}
      onKeyDown={onKeyDown}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        setDragging(true);
        pickAt(e.clientX);
      }}
      onPointerMove={(e) => { if (dragging) pickAt(e.clientX); }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      className="group/sl relative cursor-pointer touch-none select-none rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-acc/45"
      style={{ '--n': levels.length } as CSSProperties}
    >
      {/* The rail spans stop-centre to stop-centre, so it is inset by half a
          column on each side and the labels below line up with the dots. */}
      <div className="relative mx-[calc(50%/var(--n))] h-6">
        <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 overflow-hidden rounded-full bg-bg3 shadow-[inset_0_1px_2px_rgb(16_20_28_/_0.14)]">
          <div
            className="h-full rounded-full bg-linear-to-r from-acc/55 to-accs transition-[width] duration-150 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {levels.map((l, i) => (
          <span
            key={l.value}
            aria-hidden
            className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
              i <= index ? 'bg-accfg/75' : 'bg-tx3/45'
            }`}
            style={{ left: `${last > 0 ? (i / last) * 100 : 0}%` }}
          />
        ))}

        <span
          aria-hidden
          className={`absolute top-1/2 h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[6px] border-accs bg-bg1 shadow-sm transition-[left,scale] duration-150 ease-out ${
            dragging ? 'scale-[1.16]' : 'group-hover/sl:scale-110'
          }`}
          style={{ left: `${progress}%` }}
        />
      </div>

      <div className="mt-1 grid" style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}>
        {levels.map((l, i) => (
          <span
            key={l.value}
            title={l.label === l.value ? l.value : `${l.label} · ${l.value}`}
            className={`truncate px-0.5 text-center text-[10px] leading-4 transition-colors ${
              i === index ? 'font-semibold text-acc' : 'text-tx3 group-hover/sl:text-tx2'
            }`}
          >
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
