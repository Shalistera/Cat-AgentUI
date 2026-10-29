import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, fmtBytes, fmtDate } from '../api';
import { useAuth } from '../store';
import { Button, Input, Modal, ModalActions, SegmentedControl, Spinner, ToggleRow, confirmDialog, toast } from './ui';
import { useLightbox } from './Lightbox';
import { t } from '../i18n';
import type { ImageCleanupPreview, ImageStorageInfo, User } from '../types';

const DAY = 86_400_000;

/** A new image only starts when its worst-case size still fits. */
export function imageStorageTight(info: ImageStorageInfo): boolean {
  return info.limit - info.used < info.reservePerImage;
}

/** Bar plus "used / limit" line, the same on the gallery and in the cleanup dialog. */
export function ImageStorageMeter({ info }: { info: ImageStorageInfo }) {
  const pct = info.limit > 0 ? Math.min(100, (info.used / info.limit) * 100) : 0;
  const tight = imageStorageTight(info);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-bg3">
        <div
          className={`h-full rounded-full transition-[width] ${tight && !info.autoClean ? 'bg-err' : pct >= 85 ? 'bg-warn' : 'bg-acc'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-tx3">
        {t('图片空间已用')} <span className="tabular-nums text-tx2">{fmtBytes(info.used)}</span>
        {' / '}<span className="tabular-nums text-tx2">{fmtBytes(info.limit)}</span>
        {t(',共 {n} 张', { n: info.count })}
        {info.autoClean
          ? <span className="text-acc">{t(' · 已开启自动清理')}</span>
          : tight && <span className="text-err">{t(' · 剩余空间不够生成新图片(每张需预留 {size})', { size: fmtBytes(info.reservePerImage) })}</span>}
      </p>
    </div>
  );
}

/** Local midnight of a YYYY-MM-DD input value. */
function startOfDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

const chipClass = (active: boolean) => `cursor-pointer rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors ${
  active ? 'border-acc/50 bg-acc/10 text-acc' : 'border-line bg-bg1 text-tx2 hover:border-line2 hover:bg-bg2 hover:text-tx'}`;

type Mode = 'oldest' | 'before';
type Criteria =
  | { mode: 'oldest'; count: number; includeChat: boolean }
  | { mode: 'before'; before: number; includeChat: boolean };

/**
 * 清理空间: delete the oldest N images or everything before a date, with a
 * live preview (count, bytes, date range, thumbnails from both ends) of
 * exactly what will go — plus the 自动清理 switch, the "don't make me do this
 * again" answer. Chat-born images stay out unless the user opts them in.
 */
export function ImageCleanupDialog({ open, onClose, onChanged }: {
  open: boolean;
  onClose(): void;
  /** After a delete or an 自动清理 switch: refresh whatever the page shows. */
  onChanged(): void;
}) {
  const [info, setInfo] = useState<ImageStorageInfo | null>(null);
  const [mode, setMode] = useState<Mode>('oldest');
  const [count, setCount] = useState('');
  const [date, setDate] = useState('');
  const [includeChat, setIncludeChat] = useState(false);
  const [preview, setPreview] = useState<ImageCleanupPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const seq = useRef(0);
  // What the preview on screen was computed for — the delete sends exactly
  // this, never inputs changed a moment before the click.
  const previewFor = useRef<Criteria | null>(null);

  // Fresh numbers every time it opens.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setInfo(null); setPreview(null); setMode('oldest'); setIncludeChat(false);
    api.get<ImageStorageInfo>('/api/images/storage')
      .then((s) => {
        if (!current) return;
        setInfo(s);
        // Server-side default: counted on real sizes, so room actually opens up.
        setCount(String(s.suggestedCount || ''));
        setDate(fmtDate(Date.now() - 30 * DAY));
      })
      .catch((err) => {
        if (!current) return;
        toast(err instanceof Error ? err.message : t('加载失败'), 'err');
        onClose();
      });
    return () => { current = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const criteria = useMemo((): Criteria | null => {
    if (mode === 'oldest') {
      const n = Number(count);
      return Number.isInteger(n) && n >= 1 ? { mode, count: Math.min(n, 100_000), includeChat } : null;
    }
    const before = startOfDay(date);
    return before !== null ? { mode, before, includeChat } : null;
  }, [mode, count, date, includeChat]);

  // The preview follows the inputs (debounced); a stale answer never lands.
  const ready = open && !!info;
  useEffect(() => {
    const id = ++seq.current;
    if (!ready || !criteria) { setPreview(null); setPreviewing(false); return; }
    setPreviewing(true);
    const timer = setTimeout(() => {
      api.post<ImageCleanupPreview>('/api/images/cleanup', { ...criteria, dryRun: true })
        .then((p) => {
          if (seq.current !== id) return;
          previewFor.current = criteria;
          setPreview(p);
        })
        .catch(() => { if (seq.current === id) setPreview(null); })
        .finally(() => { if (seq.current === id) setPreviewing(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, criteria]);

  async function run() {
    const shown = previewFor.current;
    if (!shown || !preview?.count || deleting) return;
    const size = fmtBytes(preview.bytes);
    const body = preview.chat > 0
      ? t('确定删除这 {n} 张图片吗?其中 {chat} 张来自对话,删除后对话里将不再显示。将释放 {size},此操作不可恢复。', { n: preview.count, chat: preview.chat, size })
      : t('确定删除这 {n} 张图片吗?将释放 {size},此操作不可恢复。', { n: preview.count, size });
    if (!(await confirmDialog(t('清理空间'), body))) return;
    setDeleting(true);
    try {
      // The previewed criteria, pinned by upTo: a picture finished in the
      // meantime is never swept up with the old ones.
      const r = await api.post<{ deleted: number; bytes: number }>('/api/images/cleanup', {
        ...shown, ...(preview.to !== null ? { upTo: preview.to } : {}),
      });
      toast(t('已删除 {n} 张图片,释放 {size}', { n: r.deleted, size: fmtBytes(r.bytes) }), 'ok');
      onChanged();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('删除失败'), 'err');
    } finally {
      setDeleting(false);
    }
  }

  async function setAutoClean(v: boolean) {
    if (!info || savingAuto) return;
    if (v && !(await confirmDialog(t('开启自动清理'), t('开启后,生成新图片时如果空间不够,会自动删除最早的作品,删掉的图片无法恢复。对话里生成的图片不会被自动删除。确定开启吗?')))) return;
    setSavingAuto(true);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { imageAutoClean: v } });
      useAuth.setState({ user: r.user });
      setInfo((cur) => cur && { ...cur, autoClean: v });
      toast(v ? t('已开启自动清理') : t('已关闭自动清理'), 'ok');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('保存失败'), 'err');
    } finally {
      setSavingAuto(false);
    }
  }

  const eligible = info ? (includeChat ? info.count : info.count - info.chat.count) : 0;
  const countChips = [...new Set([20, 50, 100, 200].filter((v) => v < eligible).concat(eligible >= 4 ? [Math.floor(eligible / 2)] : []))]
    .sort((a, b) => a - b);
  const samples = preview?.samples ?? [];
  const head = preview && preview.count > samples.length ? samples.slice(0, Math.ceil(samples.length / 2)) : samples;
  const tail = preview && preview.count > samples.length ? samples.slice(Math.ceil(samples.length / 2)) : [];

  return (
    <Modal open={open} onClose={onClose} title={t('清理图片空间')} desc={t('从最早的图片开始删,删之前可以先看清楚会删掉哪些。')} wide>
      {!info ? (
        <div className="flex justify-center py-10 text-tx3"><Spinner className="h-5 w-5" /></div>
      ) : (
        <div className="space-y-5">
          <ImageStorageMeter info={info} />

          {info.count === 0 ? (
            <p className="rounded-lg border border-line bg-bg0 px-3.5 py-3 text-xs text-tx3">{t('还没有图片,不需要清理。')}</p>
          ) : (
            <>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-tx">{t('删除哪些图片')}</span>
                  <SegmentedControl<Mode>
                    value={mode} onChange={setMode}
                    options={[{ value: 'oldest', label: t('最早的若干张') }, { value: 'before', label: t('某天之前的') }]}
                  />
                </div>
                {mode === 'oldest' ? (
                  <div className="space-y-2">
                    <label className="flex flex-wrap items-center gap-2 text-[13px] text-tx2">
                      {t('删除最早的')}
                      <span className="w-24">
                        <Input
                          uiSize="sm" type="number" min={1} max={Math.max(1, eligible)} value={count}
                          onChange={(e) => setCount(e.target.value)} className="text-center tabular-nums"
                        />
                      </span>
                      {t('张')}
                    </label>
                    {countChips.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {countChips.map((v) => (
                          <button key={v} type="button" className={chipClass(count === String(v))} onClick={() => setCount(String(v))}>
                            {v === Math.floor(eligible / 2) && eligible >= 4 ? t('一半({n} 张)', { n: v }) : t('{n} 张', { n: v })}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label className="flex flex-wrap items-center gap-2 text-[13px] text-tx2">
                      {t('删除@@before-date')}
                      <span className="w-40">
                        <Input
                          uiSize="sm" type="date" value={date} max={fmtDate(Date.now())}
                          min={info.oldestAt ? fmtDate(info.oldestAt) : undefined}
                          onChange={(e) => setDate(e.target.value)}
                        />
                      </span>
                      {t('之前生成的图片(不含当天)')}
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {([[7, t('一周前')], [30, t('一个月前')], [90, t('三个月前')], [180, t('半年前')]] as const).map(([days, label]) => {
                        const value = fmtDate(Date.now() - days * DAY);
                        return <button key={days} type="button" className={chipClass(date === value)} onClick={() => setDate(value)}>{label}</button>;
                      })}
                    </div>
                  </div>
                )}
                {info.chat.count > 0 && (
                  <label className="flex cursor-pointer items-start gap-2 text-[13px] text-tx2">
                    <input
                      type="checkbox" checked={includeChat} onChange={(e) => setIncludeChat(e.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-acc"
                    />
                    <span>
                      {t('同时删除对话里生成的图片(共 {n} 张)', { n: info.chat.count })}
                      <span className="mt-0.5 block text-xs leading-relaxed text-tx3">{t('默认只删绘图工坊的作品;对话里的图片删除后,那段对话里将不再显示。')}</span>
                    </span>
                  </label>
                )}
              </div>

              <div className={`min-h-[4.5rem] rounded-lg border border-line bg-bg0 px-3.5 py-3 transition-opacity ${previewing && preview ? 'opacity-60' : ''}`}>
                {!criteria ? (
                  <p className="text-xs text-tx3">{mode === 'oldest' ? t('请输入要删除的张数') : t('请选择日期')}</p>
                ) : !preview ? (
                  <div className="flex justify-center py-3 text-tx3">{previewing && <Spinner />}</div>
                ) : preview.count === 0 ? (
                  <p className="text-xs leading-relaxed text-tx3">
                    {t('没有符合条件的图片。')}
                    {!includeChat && info.chat.count > 0 && eligible === 0 && t('你的图片都是在对话里生成的,勾选上面的选项才能删除。')}
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    <div>
                      <p className="text-[13px] text-tx">
                        {t('将删除 {n} 张图片,释放 {size}', { n: preview.count, size: fmtBytes(preview.bytes) })}
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-tx3">
                        {preview.from !== null && preview.to !== null && t('生成于 {from} 至 {to}', { from: fmtDate(preview.from), to: fmtDate(preview.to) })}
                        {t(' · 删除后已用 {used} / {limit}', { used: fmtBytes(Math.max(0, info.used - preview.bytes)), limit: fmtBytes(info.limit) })}
                      </p>
                      {preview.chat > 0 && <p className="mt-0.5 text-xs text-warn">{t('其中 {n} 张来自对话', { n: preview.chat })}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
                      {head.map((s) => <Thumb key={s.id} sample={s} />)}
                      {tail.length > 0 && <span className="px-0.5 text-tx3">…</span>}
                      {tail.map((s) => <Thumb key={s.id} sample={s} />)}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          <ToggleRow
            label={t('空间不够时自动删除最早的图片')}
            desc={t('开启后,生成新图片时如果空间不够,会从最早的作品开始删,只删到刚好放得下;对话里生成的图片不会被自动删除。')}
            checked={info.autoClean} onChange={(v) => void setAutoClean(v)} disabled={savingAuto}
          />

          <ModalActions>
            <Button variant="outline" onClick={onClose}>{t('关闭')}</Button>
            <Button variant="dangerSolid" disabled={!criteria || !preview?.count || previewing || deleting} onClick={() => void run()}>
              {deleting ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 size={14} />}
              {preview?.count && criteria ? t('删除 {n} 张', { n: preview.count }) : t('删除')}
            </Button>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

function Thumb({ sample }: { sample: ImageCleanupPreview['samples'][number] }) {
  const src = `/api/images/${sample.id}/file`;
  return (
    <button
      type="button" title={`${fmtDate(sample.createdAt)} · ${sample.prompt}`}
      onClick={() => useLightbox.getState().open(src, sample.prompt)}
      className="h-10 w-10 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-line bg-bg1 sm:h-12 sm:w-12"
    >
      <img loading="lazy" src={src} alt={sample.prompt} className="h-full w-full object-cover" />
    </button>
  );
}
