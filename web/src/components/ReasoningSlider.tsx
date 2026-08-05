import {
  useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ReasoningLevel } from '../types';

// The rail reads as an energy ramp: cobalt at rest, violet in the middle,
// fuchsia at full tilt. The stops live on the FULL rail and the fill merely
// unclips them, so a colour stays glued to its rung — dragging right doesn't
// recolour what you already passed, it reveals hotter ground ahead.
const RAMP: [number, number, number][] = [[37, 99, 235], [124, 58, 237], [217, 38, 169]];
const RAMP_CSS = 'linear-gradient(90deg, rgb(37 99 235), rgb(124 58 237) 55%, rgb(217 38 169))';

// Colour of the ramp at ratio t ∈ [0,1] — keeps the thumb, its glow and the
// active label in step with the ground the thumb is standing on. Exported so
// the trigger button in the composer can wear the same tint as the rung it
// currently sits on. Returns space-separated RGB for use in `rgb(${...})`.
export function rampAt(t: number) {
  const seg = t <= 0.55 ? 0 : 1;
  const local = seg === 0 ? t / 0.55 : (t - 0.55) / 0.45;
  const [a, b] = [RAMP[seg], RAMP[seg + 1]];
  return a.map((v, i) => Math.round(v + (b[i] - v) * local)).join(' ');
}

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
  const ratio = last > 0 ? index / last : 0;
  const progress = ratio * 100;
  const tint = rampAt(ratio);

  // The hit area is the full width split into equal columns, one per label, so
  // the target you aim at is the word you read — not the dot above it.
  function pickAt(clientX: number) {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const r = (clientX - rect.left) / rect.width;
    const next = Math.min(last, Math.max(0, Math.floor(r * levels.length)));
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
          {/* Full-width ramp, unclipped up to the thumb. clip-path (not width)
              keeps the gradient anchored to the rail so colours don't slide. */}
          <div
            className="absolute inset-0 transition-[clip-path] duration-150 ease-out"
            style={{
              background: RAMP_CSS,
              clipPath: `inset(0 ${100 - progress}% 0 0)`,
              boxShadow: `0 0 ${4 + 8 * ratio}px rgb(${tint} / ${0.35 + 0.3 * ratio})`,
            }}
          >
            {/* A slow light sweep across the lit part — the "charged" cue that
                grows more visible the further right the thumb sits. */}
            {index > 0 && (
              <div
                className="absolute inset-0"
                style={{
                  opacity: 0.25 + 0.45 * ratio,
                  background: 'linear-gradient(110deg, transparent 30%, rgb(255 255 255 / 0.5) 50%, transparent 70%)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 2.2s linear infinite',
                }}
              />
            )}
          </div>
        </div>

        {levels.map((l, i) => (
          <span
            key={l.value}
            aria-hidden
            className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
              i <= index ? 'bg-white/90' : 'bg-tx3/45'
            }`}
            style={{ left: `${last > 0 ? (i / last) * 100 : 0}%` }}
          />
        ))}

        <span
          aria-hidden
          className={`absolute top-1/2 h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[6px] bg-bg1 transition-[left,scale,border-color,box-shadow] duration-150 ease-out ${
            dragging ? 'scale-[1.16]' : 'group-hover/sl:scale-110'
          }`}
          style={{
            left: `${progress}%`,
            borderColor: `rgb(${tint})`,
            boxShadow: `0 1px 2px rgb(16 20 28 / 0.2), 0 0 ${3 + 11 * ratio}px rgb(${tint} / ${0.25 + 0.5 * ratio})`,
          }}
        />
      </div>

      <div className="mt-1 grid" style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}>
        {levels.map((l, i) => (
          <span
            key={l.value}
            title={l.label === l.value ? l.value : `${l.label} · ${l.value}`}
            className={`truncate px-0.5 text-center text-[10px] leading-4 transition-[color,transform] ${
              i === index ? 'scale-105 font-semibold' : 'text-tx3 group-hover/sl:text-tx2'
            }`}
            style={i === index ? { color: `rgb(${rampAt(last > 0 ? i / last : 0)})` } : undefined}
          >
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
