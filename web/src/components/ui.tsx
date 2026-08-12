import { create } from 'zustand';
import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type TextareaHTMLAttributes, type SelectHTMLAttributes, type ThHTMLAttributes, type TdHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { X, CircleCheck, CircleAlert, Info } from 'lucide-react';

/* ---------------------------------------------------------------------------
   Primitives for the Ink & Cobalt system.

   Two rules the whole set follows:
   1. Only ONE control on a screen carries an ink fill — the primary action.
      Everything else is a bordered or ghost neutral, so scanning is unambiguous.
   2. Nothing paints its own focus state; the global :focus-visible ring in
      index.css handles every control uniformly.
   ------------------------------------------------------------------------ */

// ---------- Button ----------
type BtnVariant = 'primary' | 'accent' | 'outline' | 'subtle' | 'ghost' | 'danger' | 'dangerSolid' | 'dangerGhost';
type BtnSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'iconSm' | 'iconXs';

const btnBase = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium leading-none whitespace-nowrap transition-[background-color,border-color,color,box-shadow,opacity,filter] duration-150 disabled:opacity-40 disabled:pointer-events-none select-none cursor-pointer';

const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-pri text-prifg shadow-xs hover:bg-pri2',
  accent: 'bg-accs text-accfg shadow-xs hover:brightness-110',
  outline: 'bg-bg1 text-tx border border-line2 shadow-xs hover:bg-bg2 hover:border-field',
  subtle: 'bg-bg2 text-tx border border-transparent hover:bg-bg3',
  ghost: 'text-tx2 hover:bg-bg2 hover:text-tx',
  danger: 'bg-bg1 text-err border border-err/35 shadow-xs hover:bg-err/10 hover:border-err/60',
  dangerSolid: 'bg-errs text-errfg shadow-xs hover:brightness-110',
  // Quiet until hovered — for destructive row actions that shouldn't shout.
  dangerGhost: 'text-tx2 hover:bg-err/10 hover:text-err',
};

const btnSizes: Record<BtnSize, string> = {
  xs: 'h-7 px-2 text-xs',
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-[13px]',
  lg: 'h-10 px-5 text-sm',
  icon: 'h-8 w-8',
  iconSm: 'h-7 w-7',
  iconXs: 'h-6 w-6',
};

/** Button classes for non-<button> elements (<a>, router <Link>) — the ONLY
    sanctioned way to make a link look like a button; hand-copied class strings
    drift. */
export function btnClass(variant: BtnVariant = 'outline', size: BtnSize = 'md', extra = ''): string {
  return `${btnBase} ${btnVariants[variant]} ${btnSizes[size]} ${extra}`.trim();
}

export function Button({ variant = 'outline', size = 'md', className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  return <button type="button" className={btnClass(variant, size, className)} {...props} />;
}

// ---------- form controls ----------
// A visible 1px edge on every field (not a fill-only affordance) is what makes
// an admin console read as trustworthy — and --color-field clears 3:1 non-text
// contrast against both canvases.
const fieldBase = 'w-full rounded-md bg-bg1 border border-field px-3 text-tx placeholder:text-tx3 transition-colors hover:border-tx3 disabled:cursor-not-allowed disabled:bg-bg2 disabled:text-tx2 disabled:hover:border-field';

export function Input({ className = '', uiSize = 'md', ...props }:
  InputHTMLAttributes<HTMLInputElement> & { uiSize?: 'sm' | 'md' }) {
  return <input className={`${fieldBase} ${uiSize === 'sm' ? 'h-8 text-[13px]' : 'h-9 text-sm'} ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldBase} resize-y py-2 text-sm leading-relaxed ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={`${fieldBase} h-9 cursor-pointer appearance-none pr-8 text-sm ${className}`} {...props}>{children}</select>
      <svg className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tx3"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

export function Field({ label, hint, error, required, children }: {
  label: string; hint?: string; error?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline gap-1 text-[13px] font-medium text-tx">
        {label}
        {required && <span className="text-err">*</span>}
      </div>
      {children}
      {error
        ? <div className="mt-1.5 flex items-center gap-1 text-xs text-err"><CircleAlert size={12} />{error}</div>
        : hint && <div className="mt-1.5 text-xs text-tx3">{hint}</div>}
    </label>
  );
}

// The knob is laid out by flexbox, not `absolute`: an absolutely positioned child
// with no `left` falls back to its static position, which a button centers — that
// put the knob mid-track when off and pushed it past the edge when on.
export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        checked ? 'border-accs bg-accs' : 'border-field bg-bg3'}`}>
      {/* The off-state knob needs its own edge — a white knob on a pale track is
          otherwise invisible in light mode. */}
      <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
        checked ? 'translate-x-4 ring-0' : 'translate-x-0 ring-1 ring-line2'}`} />
    </button>
  );
}

// ---------- data display ----------
type BadgeTone = 'default' | 'ok' | 'err' | 'warn' | 'acc' | 'solid';

export function Badge({ children, tone = 'default', mono }: { children: ReactNode; tone?: BadgeTone; mono?: boolean }) {
  const tones: Record<BadgeTone, string> = {
    default: 'bg-bg2 text-tx2 border-line2',
    ok: 'bg-ok/10 text-ok border-ok/30',
    err: 'bg-err/10 text-err border-err/30',
    warn: 'bg-warn/10 text-warn border-warn/30',
    acc: 'bg-acc/10 text-acc border-acc/30',
    solid: 'bg-pri text-prifg border-transparent',
  };
  return (
    <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-4 ${tones[tone]} ${mono ? 'font-mono' : ''}`}>
      {children}
    </span>
  );
}

/** Status light — a dot plus a label reads faster than colour alone. */
export function StatusDot({ tone }: { tone: 'ok' | 'err' | 'warn' | 'idle' }) {
  const c = { ok: 'bg-ok', err: 'bg-err', warn: 'bg-warn', idle: 'bg-tx3' }[tone];
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}

/** Inherits currentColor so it stays legible inside filled buttons (prifg on
    primary, errfg on dangerSolid). Standalone loading wrappers should set
    `text-tx3` themselves. */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v2.5A5.5 5.5 0 006.5 12H4z" />
    </svg>
  );
}

// ---------- layout ----------
/** Sticky page header shared by every route, so chrome never shifts. */
export function PageHeader({ title, subtitle, left, children }: {
  title: string; subtitle?: string; left?: ReactNode; children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg1/85 px-4 backdrop-blur-md sm:px-6">
      {left}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-tx">{title}</h1>
        {subtitle && <p className="truncate text-xs text-tx3">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}

export function Card({ title, desc, actions, children, flush, className = '', bodyClassName = '' }: {
  title?: string; desc?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
  /** Body without padding — for full-bleed content (tables, image grids). */
  flush?: boolean;
}) {
  return (
    <section className={`overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs ${className}`}>
      {(title || actions) && (
        <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[13px] font-semibold tracking-tight text-tx">{title}</h2>}
            {desc && <p className="mt-0.5 text-xs leading-relaxed text-tx3">{desc}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={`${flush ? '' : 'px-5 py-4'} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function SegmentedControl<T extends string | number>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange(v: T): void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-line bg-bg2 p-0.5">
      {options.map((o) => (
        <button key={String(o.value)} type="button" onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`cursor-pointer rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors ${
            o.value === value ? 'bg-bg1 text-tx shadow-xs' : 'text-tx2 hover:text-tx'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Label + description + switch in a quiet recessed row — the one way every
    settings surface phrases a boolean. */
export function ToggleRow({ label, desc, checked, onChange, disabled }: {
  label: string; desc?: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-bg0 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-tx">{label}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-tx3">{desc}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// The one data-table cell treatment (Users' variant won: tinted header reads
// as a header even when the table scrolls). Rows must set `group` so the
// last-row border clears via `group-last`.
export function Th({ className = '', ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={`border-b border-line bg-bg2/50 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-tx3 ${className}`} {...props} />;
}

export function Td({ className = '', ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`border-b border-line px-3 py-2.5 text-tx2 group-last:border-0 ${className}`} {...props} />;
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg1 px-4 py-3 shadow-xs">
      <div className="eyebrow">{label}</div>
      <div className="stat-value mt-1.5 text-2xl font-semibold tracking-tight text-tx">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-tx3">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: {
  icon?: ReactNode; title: string; hint?: string; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg2 text-tx3">
          {icon}
        </div>
      )}
      <div>
        <div className="text-sm font-medium text-tx">{title}</div>
        {hint && <div className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-tx3">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

// ---------- Popover ----------
/** Anchored floating panel (portal + viewport-aware flip). Shared by the
    composer's pickers and any menu that hangs off a trigger — one panel style,
    one placement algorithm. */
export function Popover({ trigger, children, open, setOpen, align = 'left', width = 'w-80' }: {
  trigger: ReactNode; children: ReactNode; open: boolean; setOpen(v: boolean): void;
  align?: 'left' | 'right'; width?: string;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }

    function place() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const edge = 12;
      const gap = 8;
      const above = rect.top - edge - gap;
      const below = window.innerHeight - rect.bottom - edge - gap;
      const placeAbove = above >= 300 || above >= below;
      const maxHeight = Math.max(160, Math.min(placeAbove ? above : below, 544));
      const horizontal = align === 'right'
        ? { right: Math.max(edge, window.innerWidth - rect.right) }
        : { left: Math.max(edge, rect.left) };

      setPosition(placeAbove
        ? { ...horizontal, bottom: window.innerHeight - rect.top + gap, maxHeight }
        : { ...horizontal, top: rect.bottom + gap, maxHeight });
    }

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [align, open]);

  return (
    <div ref={anchorRef} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            style={position ?? { visibility: 'hidden' }}
            className={`fade-up fixed z-50 ${width} max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-line bg-bg1 shadow-lg`}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, desc, children, wide, className = '' }: {
  open: boolean; onClose(): void; title: string; desc?: string; children: ReactNode; wide?: boolean;
  /** Extra classes on the dialog panel — modals portal to <body>, so page-scoped
      styling (e.g. the workshop's type bump) must ride in explicitly. */
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={onClose} />
      <div className={`fade-up relative flex max-h-[88vh] w-full flex-col ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-hidden rounded-xl border border-line bg-bg1 shadow-xl ${className}`}>
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold tracking-tight text-tx">{title}</h2>
            {desc && <p className="mt-0.5 text-xs leading-relaxed text-tx3">{desc}</p>}
          </div>
          <Button variant="ghost" size="iconSm" onClick={onClose} title="关闭"><X size={15} /></Button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Right-aligned action row for modal footers — keeps button order consistent. */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">{children}</div>;
}

// ---------- Toast ----------
interface ToastItem { id: number; message: string; tone: 'ok' | 'err' | 'info' }
const useToastStore = create<{ toasts: ToastItem[]; push(t: ToastItem): void; remove(id: number): void }>((set, get) => ({
  toasts: [],
  push(t) { set({ toasts: [...get().toasts, t] }); },
  remove(id) { set({ toasts: get().toasts.filter((x) => x.id !== id) }); },
}));

let toastSeq = 1;
export function toast(message: string, tone: 'ok' | 'err' | 'info' = 'info') {
  const id = toastSeq++;
  useToastStore.getState().push({ id, message, tone });
  setTimeout(() => useToastStore.getState().remove(id), tone === 'err' ? 6000 : 3500);
}

const toastIcons = {
  ok: <CircleCheck size={15} className="mt-px shrink-0 text-ok" />,
  err: <CircleAlert size={15} className="mt-px shrink-0 text-err" />,
  info: <Info size={15} className="mt-px shrink-0 text-acc" />,
};

export function Toaster() {
  const { toasts, remove } = useToastStore();
  return createPortal(
    <div className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-full max-w-sm flex-col items-end gap-2">
      {toasts.map((t) => (
        <div key={t.id} onClick={() => remove(t.id)} role="status"
          className="fade-up pointer-events-auto flex w-fit max-w-full cursor-pointer items-start gap-2 rounded-lg border border-line bg-bg1 py-2.5 pl-3 pr-4 text-[13px] leading-relaxed text-tx shadow-lg">
          {toastIcons[t.tone]}
          <span className="min-w-0 break-words">{t.message}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------- Confirm ----------
interface ConfirmState {
  open: boolean; title: string; body: string; danger: boolean;
  resolve: ((v: boolean) => void) | null;
  ask(title: string, body: string, danger?: boolean): Promise<boolean>;
  close(v: boolean): void;
}
export const useConfirm = create<ConfirmState>((set, get) => ({
  open: false, title: '', body: '', danger: false, resolve: null,
  ask(title, body, danger = true) {
    return new Promise<boolean>((resolve) => set({ open: true, title, body, danger, resolve }));
  },
  close(v) { get().resolve?.(v); set({ open: false, resolve: null }); },
}));

export function confirmDialog(title: string, body: string, danger = true) {
  return useConfirm.getState().ask(title, body, danger);
}

export function ConfirmHost() {
  const { open, title, body, danger, close } = useConfirm();
  return (
    <Modal open={open} onClose={() => close(false)} title={title}>
      <p className="text-[13px] leading-relaxed text-tx2">{body}</p>
      <ModalActions>
        <Button variant="outline" onClick={() => close(false)}>取消</Button>
        <Button variant={danger ? 'dangerSolid' : 'primary'} onClick={() => close(true)}>确认</Button>
      </ModalActions>
    </Modal>
  );
}
