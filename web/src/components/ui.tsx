import { create } from 'zustand';
import { useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// ---------- Button ----------
type BtnVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle';

const btnBase = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none select-none cursor-pointer';
const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-acc text-accfg hover:bg-acc2',
  ghost: 'text-tx2 hover:bg-bg2 hover:text-tx',
  subtle: 'bg-bg2 text-tx hover:bg-bg3 border border-line',
  outline: 'border border-line2 text-tx hover:bg-bg2',
  danger: 'bg-err/10 text-err border border-err/30 hover:bg-err/20',
};

export function Button({ variant = 'subtle', size = 'md', className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg' | 'icon' }) {
  const sizes = {
    sm: 'text-xs px-2.5 py-1.5', md: 'text-sm px-3.5 py-2', lg: 'text-sm px-5 py-2.5',
    icon: 'p-2',
  };
  return <button type="button" className={`${btnBase} ${btnVariants[variant]} ${sizes[size]} ${className}`} {...props} />;
}

// ---------- Inputs ----------
const fieldBase = 'w-full rounded-lg bg-bg1 border border-line px-3 py-2 text-sm text-tx placeholder:text-tx3 outline-none focus:border-acc/60 focus:ring-2 focus:ring-acc/15 transition-colors';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldBase} ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldBase} resize-none ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${fieldBase} cursor-pointer appearance-none bg-no-repeat bg-[right_0.6rem_center] pr-8 ${className}`}
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239b9ba6' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }}
      {...props}>{children}</select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-medium text-tx2">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-tx3">{hint}</div>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-5.5 w-10 shrink-0 rounded-full transition-colors cursor-pointer disabled:opacity-45 ${checked ? 'bg-acc' : 'bg-bg3 border border-line2'}`}>
      <span className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[1.2rem]' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'ok' | 'err' | 'acc' }) {
  const tones = {
    default: 'bg-bg2 text-tx2 border-line',
    ok: 'bg-ok/10 text-ok border-ok/25',
    err: 'bg-err/10 text-err border-err/25',
    acc: 'bg-acc/10 text-acc border-acc/25',
  };
  return <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin text-tx3 ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, wide }: {
  open: boolean; onClose(): void; title: string; children: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className={`fade-up relative max-h-[88vh] w-full ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-y-auto rounded-2xl border border-line bg-bg1 p-5 shadow-2xl`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X size={16} /></Button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
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

export function Toaster() {
  const { toasts, remove } = useToastStore();
  return createPortal(
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div key={t.id} onClick={() => remove(t.id)}
          className={`fade-up pointer-events-auto w-fit max-w-full cursor-pointer rounded-xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur bg-bg1/95 ${
            t.tone === 'err' ? 'border-err/40 text-err' : t.tone === 'ok' ? 'border-ok/40 text-ok' : 'border-line2 text-tx'}`}>
          {t.message}
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
      <p className="mb-5 text-sm text-tx2">{body}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(false)}>取消</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={() => close(true)}>确认</Button>
      </div>
    </Modal>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="text-tx3">{icon}</div>}
      <div className="text-sm font-medium text-tx2">{title}</div>
      {hint && <div className="max-w-sm text-xs text-tx3">{hint}</div>}
    </div>
  );
}
