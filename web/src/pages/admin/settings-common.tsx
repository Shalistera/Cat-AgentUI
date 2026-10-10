import { useEffect, useState, type ReactNode } from 'react';
import { api, errMsg } from '../../api';
import { Button, Select, Spinner, confirmDialog, toast } from '../../components/ui';
import { t } from '../../i18n';
import type { AppSettings, ModelInfo } from '../../types';

/* Shared plumbing for the admin pages carved out of the old 站点设置 page
   (通用 / 任务模型 / 存储空间). They all edit slices of the same
   /api/admin/settings document; the PUT accepts partial bodies, so each page
   sends only its own fields and a save on one page never carries half-edited
   values from another. */

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------- unsaved-changes guard ----------
// One admin section is mounted at a time, so a single flag is enough. Admin.tsx
// asks before switching sections or closing; beforeunload covers reloads.
let unsaved = false;

export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    unsaved = dirty;
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => { window.removeEventListener('beforeunload', h); unsaved = false; };
  }, [dirty]);
}

/** Resolves true when it is fine to leave the current admin section. */
export async function confirmLeave(): Promise<boolean> {
  if (!unsaved) return true;
  const ok = await confirmDialog(t('放弃未保存的更改?'), t('本页有尚未保存的修改,离开后这些修改会丢失。'));
  if (ok) unsaved = false;
  return ok;
}

export function hasUnsaved() { return unsaved; }

// ---------- settings form ----------
/** Loads the settings document and keeps a page-local form derived from it.
    `toForm` must be a stable (module-level) function: dirty is computed by
    comparing the form with `toForm(saved)`. */
export function useSettingsForm<F>(toForm: (s: AppSettings) => F) {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [form, setForm] = useState<F | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<AppSettings>('/api/admin/settings')
      .then((r) => { setSaved(r); setForm(toForm(r)); })
      .catch((e) => toast(e instanceof Error ? e.message : t('加载站点设置失败'), 'err'));
  }, [toForm]);

  const dirty = !!saved && !!form && JSON.stringify(form) !== JSON.stringify(toForm(saved));
  useUnsavedGuard(dirty);

  const set = (patch: Partial<F>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const reset = () => { if (saved) setForm(toForm(saved)); };

  async function save(body: Partial<AppSettings>): Promise<AppSettings | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await api.put<AppSettings>('/api/admin/settings', body);
      setSaved(r); setForm(toForm(r));
      toast(t('已保存'), 'ok');
      return r;
    } catch (e) {
      toast(errMsg(e), 'err');
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { saved, form, set, dirty, busy, reset, save };
}

/** Enabled text models — the pickers for every "which model does X" field.
    null until loaded, so a picker doesn't flash "unavailable" meanwhile. */
export function useTextModels(): ModelInfo[] | null {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  useEffect(() => {
    // Admins see every enabled model here.
    api.get<ModelInfo[]>('/api/models')
      .then((r) => setModels(r.filter((m) => !m.imageGen)))
      .catch(() => setModels([]));
  }, []);
  return models;
}

/** A text-model picker. A saved id that is no longer enabled stays visible as
    "unavailable" instead of silently reading as the empty option. */
export function ModelSelect({ value, onChange, models, emptyLabel, disabled }: {
  value: string; onChange(id: string): void; models: ModelInfo[] | null; emptyLabel: string; disabled?: boolean;
}) {
  const list = models ?? [];
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">{emptyLabel}</option>
      {value && !list.some((m) => m.id === value) && (
        <option value={value}>{models ? t('模型不可用:{id}', { id: value }) : t('加载中…')}</option>
      )}
      {list.map((m) => <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>)}
    </Select>
  );
}

/** Sticks to the bottom of the admin scroll area while the page has edits —
    the page's only save button, so what it saves is never ambiguous. */
export function SaveBar({ dirty, busy, onSave, onReset }: {
  dirty: boolean; busy: boolean; onSave(): void; onReset(): void;
}) {
  if (!dirty && !busy) return null;
  return (
    <div className="pointer-events-none sticky bottom-3 z-10">
      <div className="fade-up pointer-events-auto flex items-center gap-2 rounded-xl border border-line2 bg-bg1 py-2 pl-4 pr-2 shadow-lg">
        <span className="min-w-0 flex-1 truncate text-[13px] text-tx2">{t('有未保存的更改')}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReset}>{t('放弃更改')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={onSave}>
          {busy && <Spinner className="h-3.5 w-3.5" />}{t('保存更改')}
        </Button>
      </div>
    </div>
  );
}

/** Title + one-line summary at the top of an admin section. */
export function SectionIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-base font-semibold tracking-tight text-tx">{title}</h1>
      <p className="mt-0.5 text-xs leading-relaxed text-tx3">{children}</p>
    </div>
  );
}
