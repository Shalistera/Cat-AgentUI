import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Button, Card, Field, Input, Spinner, confirmDialog, toast } from '../../components/ui';
import { t } from '../../i18n';
import type { AppSettings, StorageOverview } from '../../types';
import { SaveBar, SectionIntro, fmtBytes, useSettingsForm } from './settings-common';

/** Who is holding how much — one accent hue, identity in the label. */
function UsageRows({ users }: { users: StorageOverview['topUsers'] }) {
  if (!users.length) return <p className="py-3 text-center text-xs text-tx3">{t('还没有任何用户存放文件')}</p>;
  const max = Math.max(...users.map((u) => u.uploadBytes + u.imageBytes), 1);
  return (
    <div className="space-y-2.5">
      {users.map((u) => {
        const total = u.uploadBytes + u.imageBytes;
        return (
          <div key={u.userId} title={t('附件 {uploads} · 图片 {images}', { uploads: fmtBytes(u.uploadBytes), images: fmtBytes(u.imageBytes) })}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-tx">{u.displayName || u.username}
                {u.displayName && <span className="ml-1 text-tx3">@{u.username}</span>}
              </span>
              <span className="shrink-0 tabular-nums text-tx2">{fmtBytes(total)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg2">
              <div className="h-full rounded-full bg-acc opacity-85" style={{ width: `${Math.max((total / max) * 100, 1)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Usage overview plus the two manual brooms. `reloadKey` refetches after a
    save — limits show in the tiles and a shorter retention sweeps files. */
function OverviewCard({ reloadKey }: { reloadKey: number }) {
  const [data, setData] = useState<StorageOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'orphans' | 'unreferenced'>(null);

  useEffect(() => {
    api.get<StorageOverview>('/api/admin/storage')
      .then((r) => { setData(r); setLoadError(null); })
      .catch((e) => setLoadError(e instanceof Error ? e.message : t('加载存储信息失败')));
  }, [reloadKey]);

  async function cleanup(kind: 'orphans' | 'unreferenced') {
    if (busy || !data) return;
    const ok = await confirmDialog(
      kind === 'orphans' ? t('清理孤儿文件') : t('清理未使用的附件'),
      kind === 'orphans'
        ? t('将删除 {count} 个数据库里没有记录的文件({size})。这些文件不属于任何对话或画廊,最近一小时内写入的文件会跳过。', { count: data.orphans.count, size: fmtBytes(data.orphans.bytes) })
        : t('将删除 {count} 个没有出现在任何对话消息里的附件({size})。最近一小时内上传的会跳过;用户输入框里尚未发送的草稿附件如果早于一小时,也会被清掉。', { count: data.uploads.unreferencedCount, size: fmtBytes(data.uploads.unreferencedBytes) }),
    );
    if (!ok) return;
    setBusy(kind);
    try {
      const r = await api.post<{ result: { orphans: { count: number; bytes: number } | null; unreferencedUploads: { count: number; bytes: number } | null }; overview: StorageOverview }>(
        '/api/admin/storage/cleanup', kind === 'orphans' ? { orphans: true } : { unreferencedUploads: true },
      );
      const done = kind === 'orphans' ? r.result.orphans : r.result.unreferencedUploads;
      toast(done && done.count ? t('已清理 {count} 个文件,释放 {size}', { count: done.count, size: fmtBytes(done.bytes) }) : t('没有需要清理的文件'), 'ok');
      setData(r.overview);
    } catch (e) {
      toast(e instanceof Error ? e.message : t('清理失败'), 'err');
    } finally { setBusy(null); }
  }

  const used = data ? data.uploads.bytes + data.images.bytes + data.orphans.bytes + (data.workspaces?.bytes ?? 0) : 0;
  const pct = data ? Math.min(100, (used / data.limits.total) * 100) : 0;

  return (
    <Card title={t('占用情况')} desc={t('附件与生成图片各占多少、谁占得最多,以及能安全清掉什么。')}>
      {loadError ? (
        <p className="text-sm text-err">{loadError}{t('(服务端可能还是旧版本,请重新构建并重启)')}</p>
      ) : !data ? (
        <div className="flex justify-center py-6 text-tx3"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="text-tx2">{t('已用')} <span className="tabular-nums text-tx">{fmtBytes(used)}</span> {t('/ 上限 {total}(MAX_TOTAL_STORAGE_MB)', { total: fmtBytes(data.limits.total) })}</span>
              <span className="tabular-nums text-tx3">{t('磁盘剩余 {free}', { free: data.freeSpace === null ? t('未知') : fmtBytes(data.freeSpace) })}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg2">
              <div className={`h-full rounded-full ${pct >= 90 ? 'bg-err' : 'bg-acc'}`} style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-bg0 px-3.5 py-3 text-xs">
              <div className="eyebrow mb-1">{t('对话附件')}</div>
              <div className="text-base font-semibold tabular-nums text-tx">{fmtBytes(data.uploads.bytes)}</div>
              <div className="mt-0.5 text-tx3">{t('{count} 个文件 · 每人上限 {limit}', { count: data.uploads.count.toLocaleString(), limit: fmtBytes(data.limits.perUserUploads) })}</div>
              <div className="mt-1 text-tx3">{t('未被任何消息引用:')}<span className="text-tx2">{data.uploads.unreferencedCount}</span> {t('个 / {size}', { size: fmtBytes(data.uploads.unreferencedBytes) })}</div>
            </div>
            <div className="rounded-lg bg-bg0 px-3.5 py-3 text-xs">
              <div className="eyebrow mb-1">{t('生成图片@@storage')}</div>
              <div className="text-base font-semibold tabular-nums text-tx">{fmtBytes(data.images.bytes)}</div>
              <div className="mt-0.5 text-tx3">{t('{count} 张 · 每人上限 {limit}', { count: data.images.count.toLocaleString(), limit: fmtBytes(data.limits.perUserImages) })}</div>
              <div className="mt-1 text-tx3">{t('绘图工坊 {workshop} · 对话作图 {chat}', { workshop: fmtBytes(data.images.workshopBytes), chat: fmtBytes(data.images.chatBytes) })}</div>
            </div>
            <div className="rounded-lg bg-bg0 px-3.5 py-3 text-xs">
              <div className="eyebrow mb-1">{t('孤儿文件')}</div>
              <div className="text-base font-semibold tabular-nums text-tx">{fmtBytes(data.orphans.bytes)}</div>
              <div className="mt-0.5 text-tx3">{t('{count} 个磁盘上有、数据库里没有的文件', { count: data.orphans.count.toLocaleString() })}</div>
              <div className="mt-1 text-tx3">{t('来源:中断的上传、手工拷贝、迁移残留')}</div>
            </div>
            <div className="rounded-lg bg-bg0 px-3.5 py-3 text-xs">
              <div className="eyebrow mb-1">{t('对话工作区')}</div>
              <div className="text-base font-semibold tabular-nums text-tx">{fmtBytes(data.workspaces?.bytes ?? 0)}</div>
              <div className="mt-0.5 text-tx3">{t('{count} 个对话有文件', { count: (data.workspaces?.chats ?? 0).toLocaleString() })}</div>
              <div className="mt-1 text-tx3">{t('随对话删除;上限见 MAX_WORKSPACE_MB')}</div>
            </div>
          </div>

          <div>
            <div className="eyebrow mb-2">{t('占用最多的用户')}</div>
            <UsageRows users={data.topUsers} />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            <p className="mr-auto text-xs text-tx3">
              {t('数据库本身的体积见')}
              <Link to="/admin/backup" className="mx-0.5 text-acc hover:underline">{t('备份与迁移')}</Link>
            </p>
            <Button variant="outline" size="sm" disabled={busy !== null || data.orphans.count === 0} onClick={() => void cleanup('orphans')}>
              {busy === 'orphans' && <Spinner className="h-3.5 w-3.5" />}{t('清理孤儿文件')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null || data.uploads.unreferencedCount === 0} onClick={() => void cleanup('unreferenced')}>
              {busy === 'unreferenced' && <Spinner className="h-3.5 w-3.5" />}{t('立即清理未使用附件')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

interface Form {
  // Raw text so the fields can be emptied while typing; validated on save.
  attachmentCount: string;
  maxUserUploadMb: string;
  imageRetentionDays: string;
  chatImageRetentionDays: string;
  uploadRetentionDays: string;
}

const toForm = (r: AppSettings): Form => ({
  attachmentCount: String(r.maxAttachmentsPerMessage),
  maxUserUploadMb: String(r.maxUserUploadMb),
  imageRetentionDays: String(r.imageRetentionDays ?? 0),
  chatImageRetentionDays: String(r.chatImageRetentionDays ?? 0),
  uploadRetentionDays: String(r.uploadRetentionDays ?? 0),
});

export default function Storage() {
  const { form, set, dirty, busy, reset, save } = useSettingsForm(toForm);
  const [reloadKey, setReloadKey] = useState(0);

  async function submit() {
    if (!form) return;
    const countLimit = Number(form.attachmentCount);
    if (!Number.isInteger(countLimit) || countLimit < 1 || countLimit > 100) {
      toast(t('单次附件数量上限须为 1–100 的整数'), 'err');
      return;
    }
    const uploadLimit = Number(form.maxUserUploadMb);
    if (!Number.isInteger(uploadLimit) || uploadLimit < 1 || uploadLimit > 100000) {
      toast(t('每用户附件上限须为 1–100000 MB 的整数'), 'err');
      return;
    }
    const clampDays = (v: string) => Math.min(3650, Math.max(0, Math.round(Number(v)) || 0));
    const r = await save({
      maxAttachmentsPerMessage: countLimit,
      maxUserUploadMb: uploadLimit,
      imageRetentionDays: clampDays(form.imageRetentionDays),
      chatImageRetentionDays: clampDays(form.chatImageRetentionDays),
      uploadRetentionDays: clampDays(form.uploadRetentionDays),
    });
    if (r) setReloadKey((k) => k + 1);
  }

  const days = (key: 'imageRetentionDays' | 'chatImageRetentionDays' | 'uploadRetentionDays') => (
    <Input
      type="number" min={0} max={3650} step={1} inputMode="numeric" className="max-w-32"
      value={form?.[key] ?? ''} disabled={busy} placeholder="0"
      onChange={(e) => set({ [key]: e.target.value } as Partial<Form>)}
    />
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <SectionIntro title={t('存储空间')}>{t('附件与生成图片的占用、上传上限,以及过期文件的自动清理')}</SectionIntro>

      <OverviewCard reloadKey={reloadKey} />

      {!form ? (
        <div className="flex justify-center py-6 text-tx3"><Spinner /></div>
      ) : (
        <>
          <Card title={t('上传上限')} desc={t('保存后立即生效。附件总大小和模型上下文仍受各自的限制。')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('单次附件数量上限')}
                hint={t('默认 20 个,可设为 1–100 个。适用于每条对话消息及工坊单次提交的附件。')}
              >
                <Input
                  type="number" min={1} max={100} step={1} inputMode="numeric" className="max-w-32"
                  value={form.attachmentCount} disabled={busy}
                  onChange={(e) => set({ attachmentCount: e.target.value })}
                />
              </Field>
              <Field
                label={t('每用户附件上限(MB)')}
                hint={t('所有用户附件的累计存储量,1–100000 MB。调低不会删除已有附件,已超额用户需清理空间后才能继续上传。')}
              >
                <Input
                  type="number" min={1} max={100000} step={1} inputMode="numeric" className="max-w-32"
                  value={form.maxUserUploadMb} disabled={busy}
                  onChange={(e) => set({ maxUserUploadMb: e.target.value })}
                />
              </Field>
            </div>
          </Card>

          <Card title={t('自动清理')} desc={t('0 = 永久保留。过期的文件每小时清理一次,连文件一起删除;缩短期限后保存时立即清理一次。')}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('绘图工坊图片(天)')} hint={t('只影响绘图工坊生成的图片。')}>
                {days('imageRetentionDays')}
              </Field>
              <Field label={t('对话图片(天)')} hint={t('建议永久保留:过期后历史对话里对应的图片将无法显示。')}>
                {days('chatImageRetentionDays')}
              </Field>
              <Field label={t('未使用附件(天)')} hint={t('上传后一直没有出现在任何对话消息里的附件,如放弃的草稿、工坊参考图。')}>
                {days('uploadRetentionDays')}
              </Field>
            </div>
          </Card>
        </>
      )}

      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </div>
  );
}
