import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { api, fmtTime } from '../../api';
import { useAuth } from '../../store';
import { Button, Card, Field, Input, Select, Spinner, Textarea, ToggleRow, confirmDialog, toast } from '../../components/ui';
import { t, tServer } from '../../i18n';
import type { AppSettings as AppSettingsDto, ModelInfo, StorageOverview, TranslateModel } from '../../types';

interface BackupInfo { filename: string; size: number; createdAt: number }
interface BackupSettings { enabled: boolean; intervalHours: number; keep: number }
interface BackupStatus {
  running: boolean; nextRunAt: number | null; lastError: string | null;
  dbSize: number; freeSpace: number | null;
}
interface BackupsDto { backups: BackupInfo[]; settings: BackupSettings; status: BackupStatus }

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const CHAIN_MAX = 6;

/** Ordered model chain: the first is tried first, the rest are fallbacks. */
function ModelChain({ entries, mode, configureDefaults = false, onChange, models, disabled }: {
  entries: TranslateModel[]; mode: TranslateModel['mode']; configureDefaults?: boolean;
  onChange(next: TranslateModel[]): void; models: ModelInfo[]; disabled?: boolean;
}) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const remaining = models.filter((m) => !entries.some((entry) => entry.modelId === m.id));
  const update = (i: number, patch: Partial<TranslateModel>) =>
    onChange(entries.map((entry, index) => index === i ? { ...entry, ...patch } : entry));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {entries.length > 0 ? (
        <ol className="divide-y divide-line rounded-lg border border-line">
          {entries.map((entry, i) => {
            const m = byId.get(entry.modelId);
            const levels = m?.reasoningLevels ?? [];
            const staleEffort = !!entry.reasoningEffort && !levels.some((l) => l.value === entry.reasoningEffort);
            return (
              <li key={entry.modelId} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-xs tabular-nums text-tx3">{i + 1}.</span>
                  <span className={`min-w-0 flex-1 truncate ${m ? 'text-tx' : 'text-err'}`}>
                    {m ? `${m.displayName}(${m.providerName})` : t('模型已删除或停用({id})', { id: entry.modelId })}
                  </span>
                  <button type="button" title={t('上移')} disabled={disabled || i === 0}
                    className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                    onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                  <button type="button" title={t('下移')} disabled={disabled || i === entries.length - 1}
                    className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                    onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                  <button type="button" title={t('移除')} disabled={disabled}
                    className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-err disabled:opacity-30"
                    onClick={() => onChange(entries.filter((_, index) => index !== i))}><X size={13} /></button>
                </div>
                {configureDefaults && <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs text-tx3">
                    <span>{t('默认模式')}</span>
                    <Select value={entry.mode} disabled={disabled}
                      onChange={(e) => update(i, { mode: e.target.value as TranslateModel['mode'],
                        ...(e.target.value === 'fast' ? { reasoningEffort: null } : {}) })}>
                      <option value="fast">{t('快速')}</option>
                      <option value="think">{t('思考')}</option>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-tx3">
                    <span>{t('思考等级')}</span>
                    <Select value={entry.reasoningEffort ?? ''}
                      disabled={disabled || entry.mode === 'fast' || (!levels.length && !staleEffort)}
                      onChange={(e) => update(i, { reasoningEffort: e.target.value || null })}>
                      <option value="">{entry.mode === 'fast' ? t('不启用思考') : levels.length ? t('中间档位') : t('无可用思考档位')}</option>
                      {staleEffort && <option value={entry.reasoningEffort!} disabled>{t('已失效：{effort}', { effort: entry.reasoningEffort! })}</option>}
                      {levels.map((l) => <option key={l.value} value={l.value}>{l.label} ({l.value})</option>)}
                    </Select>
                  </label>
                </div>}
                {configureDefaults && staleEffort && <p className="text-xs text-err">{t('思考档位已变更,请重新选择等级或切换为快速模式。')}</p>}
                {configureDefaults && entry.mode === 'think' && !levels.length && !staleEffort && (
                  <p className="text-xs text-tx3">{t('该模型未配置思考档位,将按普通模式调用。可在模型设置中配置思考档位。')}</p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-tx3">{t('尚未选择模型,该模式对用户不可用。')}</p>
      )}
      {entries.length < CHAIN_MAX && (
        <Select value="" disabled={disabled || remaining.length === 0}
          onChange={(e) => { if (e.target.value) onChange([...entries, { modelId: e.target.value, mode, reasoningEffort: null }]); }}>
          <option value="">{remaining.length ? t('添加模型…') : t('没有更多可添加的模型')}</option>
          {remaining.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
          ))}
        </Select>
      )}
    </div>
  );
}

function BackupsCard() {
  const [data, setData] = useState<BackupsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Policy form; raw strings so fields can be emptied while typing.
  const [enabled, setEnabled] = useState(true);
  const [interval, setInterval_] = useState('24');
  const [keep, setKeep] = useState('7');
  const [dirty, setDirty] = useState(false);

  function applySettings(s: BackupSettings) {
    setEnabled(s.enabled); setInterval_(String(s.intervalHours)); setKeep(String(s.keep));
    setDirty(false);
  }

  function load() {
    return api.get<BackupsDto>('/api/admin/backups')
      .then((r) => { setData(r); setLoadError(null); return r; })
      .catch((e) => { setLoadError(e instanceof Error ? e.message : t('加载备份列表失败')); return null; });
  }

  useEffect(() => {
    load().then((r) => { if (r) applySettings(r.settings); });
  }, []);

  // While a snapshot is in flight, poll until it lands (or fails).
  const running = data?.status.running ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => { load(); }, 2000);
    return () => window.clearInterval(t);
  }, [running]);

  async function backupNow() {
    if (busy || running) return;
    setBusy(true);
    try {
      const r = await api.post<BackupsDto & { started: boolean }>('/api/admin/backups');
      setData(r);
      toast(r.started ? t('快照已开始,完成后会出现在列表中') : t('已有备份在进行中'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('备份失败'), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.put<BackupsDto>('/api/admin/backups/settings', {
        enabled,
        intervalHours: Math.min(720, Math.max(1, Math.round(Number(interval)) || 24)),
        keep: Math.min(365, Math.max(1, Math.round(Number(keep)) || 7)),
      });
      setData(r); applySettings(r.settings);
      toast(t('备份策略已保存'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('保存失败'), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: BackupInfo) {
    if (!window.confirm(t('删除快照 {name}?此操作不可恢复。', { name: b.filename }))) return;
    try {
      setData(await api.del<BackupsDto>(`/api/admin/backups/${encodeURIComponent(b.filename)}`));
      toast(t('已删除'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('删除失败'), 'err');
    }
  }

  const st = data?.status;
  const totalSize = data ? data.backups.reduce((n, b) => n + b.size, 0) : 0;

  return (
    <Card
      title={t('数据库备份')}
      desc={t('SQLite 在线快照,存放于 data/backups/,不影响服务运行。策略在此设置并立即生效。')}
    >
      <div className="space-y-4">
        <p className="text-xs text-tx3">
          {t('快照只包含数据库(对话、设置、加密后的密钥)。附件与生成图片在 data/uploads 与 data/images 目录,请连同 .env(SECRET_KEY)一起做整目录备份;缺少对应的 SECRET_KEY 时快照中的密钥无法解密。')}
        </p>

        <ToggleRow
          label={t('自动定时备份')}
          desc={t('关闭后只能手动备份;已有的快照不会被删除。')}
          checked={enabled} onChange={(v) => { setEnabled(v); setDirty(true); }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('备份间隔(小时)')} hint={t('1–720。从最近一份快照的时间起算。')}>
            <Input
              type="number" min={1} max={720} step={1} inputMode="numeric"
              value={interval} disabled={!enabled}
              onChange={(e) => { setInterval_(e.target.value); setDirty(true); }}
            />
          </Field>
          <Field label={t('保留份数')} hint={t('1–365。超出的旧快照会在下次备份或保存策略时删除;数据库大时请按磁盘空间设置。')}>
            <Input
              type="number" min={1} max={365} step={1} inputMode="numeric"
              value={keep}
              onChange={(e) => { setKeep(e.target.value); setDirty(true); }}
            />
          </Field>
        </div>

        {st && (
          <div className="grid gap-x-6 gap-y-1 rounded-lg bg-bg0 px-3.5 py-3 text-xs text-tx3 sm:grid-cols-2">
            <div>{t('当前数据库:')}<span className="text-tx2">{fmtBytes(st.dbSize)}</span>{t('(每份快照约此大小)')}</div>
            <div>{t('快照合计:')}<span className="text-tx2">{fmtBytes(totalSize)}</span>{t('({n} 份)', { n: data!.backups.length })}</div>
            <div>{t('磁盘剩余:')}<span className="text-tx2">{st.freeSpace === null ? t('未知') : fmtBytes(st.freeSpace)}</span></div>
            <div>{t('下次自动备份:')}<span className="text-tx2">
              {st.running ? t('进行中…') : st.nextRunAt ? fmtTime(st.nextRunAt) : t('已停用')}
            </span></div>
            {st.lastError && <div className="text-err sm:col-span-2">{t('上次备份失败:')}{tServer(st.lastError)}</div>}
          </div>
        )}

        {loadError ? (
          <p className="text-sm text-err">{loadError}{t('(服务端可能还是旧版本,请重新构建并重启)')}</p>
        ) : data && data.backups.length > 0 ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.backups.map((b) => (
              <li key={b.filename} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-tx2">{b.filename}</span>
                <span className="shrink-0 text-xs text-tx3">{fmtBytes(b.size)}</span>
                <span className="shrink-0 text-xs text-tx3">{fmtTime(b.createdAt)}</span>
                <a
                  className="shrink-0 text-xs text-acc hover:underline"
                  href={`/api/admin/backups/${encodeURIComponent(b.filename)}`}
                >{t('下载')}</a>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer text-xs text-tx3 hover:text-err"
                  onClick={() => remove(b)}
                >{t('删除')}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-tx3">{data ? t('还没有任何快照。') : t('加载中…')}</p>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button disabled={busy || !data || running} onClick={backupNow}>
            {running && <Spinner className="h-3.5 w-3.5" />}{running ? t('备份进行中…') : t('立即备份')}
          </Button>
          <Button variant="primary" disabled={busy || !data || !dirty} onClick={saveSettings}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{t('保存备份策略')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

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

function StorageCard({ uploadRetentionDays, onUploadRetentionChange, maxUserUploadMb, onMaxUserUploadChange, savedMaxUserUploadMb, attachmentCount, onAttachmentCountChange, saving, onSave }: {
  uploadRetentionDays: string; onUploadRetentionChange(v: string): void; saving: boolean; onSave?(): void;
  maxUserUploadMb: string; onMaxUserUploadChange(v: string): void; savedMaxUserUploadMb: number;
  attachmentCount: string; onAttachmentCountChange(v: string): void;
}) {
  const [data, setData] = useState<StorageOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'orphans' | 'unreferenced'>(null);

  function load() {
    return api.get<StorageOverview>('/api/admin/storage')
      .then((r) => { setData(r); setLoadError(null); })
      .catch((e) => setLoadError(e instanceof Error ? e.message : t('加载存储信息失败')));
  }
  useEffect(() => { void load(); }, [savedMaxUserUploadMb]);

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
    <Card title={t('存储空间')} desc={t('附件与生成图片各占多少、谁占得最多,以及能安全清掉什么。数据库本身的体积见下方备份卡片。')}>
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

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

          <Field
            label={t('单次附件数量上限')}
            hint={t('默认 20 个,可设为 1–100 个。适用于每条对话消息及工坊单次提交的附件,保存后立即生效。附件总大小和模型上下文仍受各自的限制。')}
          >
            <Input
              type="number" min={1} max={100} step={1} inputMode="numeric" className="max-w-40"
              value={attachmentCount} disabled={saving}
              onChange={(e) => onAttachmentCountChange(e.target.value)}
            />
          </Field>

          <Field
            label={t('每用户附件上限(MB)')}
            hint={t('适用于所有用户的附件累计存储量,可设为 1–100000 MB。保存后立即生效;调低上限不会删除已有附件,已超额用户需清理空间后才能继续上传。')}
          >
            <Input
              type="number" min={1} max={100000} step={1} inputMode="numeric" className="max-w-40"
              value={maxUserUploadMb} disabled={saving}
              onChange={(e) => onMaxUserUploadChange(e.target.value)}
            />
          </Field>

          <Field
            label={t('未使用附件保留天数')}
            hint={t('0 = 永久保留。上传后一直没有出现在任何对话消息里的附件(放弃的草稿、工坊参考图等),超过该天数后每小时自动清理。点击本卡片的「保存更改」生效。')}
          >
            <Input
              type="number" min={0} max={3650} step={1} inputMode="numeric" className="max-w-40"
              value={uploadRetentionDays} disabled={saving}
              onChange={(e) => onUploadRetentionChange(e.target.value)} placeholder="0"
            />
          </Field>

          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            {onSave && (
              <Button variant="primary" size="sm" disabled={saving} onClick={onSave} className="mr-auto">
                {saving && <Spinner className="h-3.5 w-3.5" />}{t('保存更改')}
              </Button>
            )}
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

export default function AppSettings() {
  const [loaded, setLoaded] = useState(false);
  const [brand, setBrand] = useState('');
  const [signupEnabled, setSignupEnabled] = useState(false);
  // Raw text so the fields can be emptied while typing; clamped on save.
  const [retentionDays, setRetentionDays] = useState('0');
  const [chatRetentionDays, setChatRetentionDays] = useState('0');
  const [uploadRetentionDays, setUploadRetentionDays] = useState('0');
  const [maxUserUploadMb, setMaxUserUploadMb] = useState('');
  const [savedMaxUserUploadMb, setSavedMaxUserUploadMb] = useState(0);
  const [attachmentCount, setAttachmentCount] = useState('20');
  const [quotaTokens, setQuotaTokens] = useState('0');
  const [quotaAction, setQuotaAction] = useState<AppSettingsDto['quotaAction']>('block');
  const [quotaFallback, setQuotaFallback] = useState('');
  const [titleModel, setTitleModel] = useState('');
  const [followupEnabled, setFollowupEnabled] = useState(true);
  const [followupModel, setFollowupModel] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [usageCurrency, setUsageCurrency] = useState('$');
  const [translateDefault, setTranslateDefault] = useState<TranslateModel[]>([]);
  const [translateFast, setTranslateFast] = useState<TranslateModel[]>([]);
  const [translateThink, setTranslateThink] = useState<TranslateModel[]>([]);
  const [textModels, setTextModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);

  function apply(r: AppSettingsDto) {
    setBrand(r.brand); setSignupEnabled(r.signupEnabled);
    setRetentionDays(String(r.imageRetentionDays ?? 0));
    setChatRetentionDays(String(r.chatImageRetentionDays ?? 0));
    setUploadRetentionDays(String(r.uploadRetentionDays ?? 0));
    setMaxUserUploadMb(String(r.maxUserUploadMb));
    setSavedMaxUserUploadMb(r.maxUserUploadMb);
    setAttachmentCount(String(r.maxAttachmentsPerMessage));
    setQuotaTokens(String(r.quotaMonthlyTokens ?? 0));
    setQuotaAction(r.quotaAction ?? 'block');
    setQuotaFallback(r.quotaFallbackModelId ?? '');
    setTitleModel(r.titleModelId ?? '');
    setFollowupEnabled(r.followupEnabled ?? true);
    setFollowupModel(r.followupModelId ?? '');
    setAnnouncement(r.announcement ?? '');
    setUsageCurrency(r.usageCurrency ?? '$');
    setTranslateDefault(r.translateDefaultModels ?? []);
    setTranslateFast((r.translateFastModels ?? (r.translateFastModelIds ?? []).map((modelId) => ({ modelId })))
      .map((m) => ({ modelId: m.modelId, mode: 'fast', reasoningEffort: null })));
    setTranslateThink((r.translateThinkModels ?? (r.translateThinkModelIds ?? []).map((modelId) => ({ modelId })))
      .map((m) => ({ modelId: m.modelId, mode: 'think', reasoningEffort: null })));
  }

  useEffect(() => {
    api.get<AppSettingsDto>('/api/admin/settings')
      .then((r) => { apply(r); setLoaded(true); })
      .catch((e) => toast(e instanceof Error ? e.message : t('加载站点设置失败'), 'err'));
    // Admins see every enabled model here — the downgrade target picker.
    api.get<ModelInfo[]>('/api/models')
      .then((r) => setTextModels(r.filter((m) => !m.imageGen)))
      .catch(() => { /* picker stays empty */ });
  }, []);

  async function save() {
    if (busy) return;
    const name = brand.trim();
    if (!name) { toast(t('站点名称不能为空'), 'err'); return; }
    const countLimit = Number(attachmentCount);
    if (!Number.isInteger(countLimit) || countLimit < 1 || countLimit > 100) {
      toast(t('单次附件数量上限须为 1–100 的整数'), 'err');
      return;
    }
    const uploadLimit = Number(maxUserUploadMb);
    if (!Number.isInteger(uploadLimit) || uploadLimit < 1 || uploadLimit > 100000) {
      toast(t('每用户附件上限须为 1–100000 MB 的整数'), 'err');
      return;
    }
    if (quotaAction === 'downgrade' && !quotaFallback) {
      toast(t('降级模式需要选择一个降级模型,否则超额会按拒绝处理'), 'err');
      return;
    }
    setBusy(true);
    try {
      const clampDays = (v: string) => Math.min(3650, Math.max(0, Math.round(Number(v)) || 0));
      const r = await api.put<AppSettingsDto>('/api/admin/settings', {
        brand: name,
        signupEnabled,
        imageRetentionDays: clampDays(retentionDays),
        chatImageRetentionDays: clampDays(chatRetentionDays),
        uploadRetentionDays: clampDays(uploadRetentionDays),
        maxUserUploadMb: uploadLimit,
        maxAttachmentsPerMessage: countLimit,
        quotaMonthlyTokens: Math.max(0, Math.round(Number(quotaTokens)) || 0),
        quotaAction,
        quotaFallbackModelId: quotaFallback || null,
        titleModelId: titleModel || null,
        followupEnabled,
        followupModelId: followupModel || null,
        announcement: announcement.trim(),
        usageCurrency: usageCurrency.trim() || '$',
        translateDefaultModels: translateDefault,
        translateFastModels: translateFast,
        translateThinkModels: translateThink,
      });
      apply(r);
      toast(t('已保存'), 'ok');
      useAuth.getState().refresh().catch(() => { /* ignore */ });
    } catch (e) {
      toast(e instanceof Error ? e.message : t('保存失败'), 'err');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-base font-semibold tracking-tight text-tx">{t('应用设置')}</h1>
        <p className="mt-0.5 text-xs text-tx3">{t('站点名称、注册开关与生成图片的保留策略')}</p>
      </div>

      <Card title={t('站点设置')} desc={t('影响登录页展示与新账号的注册方式。')}>
        <div className="space-y-5">
          <Field label={t('站点名称')} hint={t('显示在登录页、侧边栏与浏览器标题')}>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={64} />
          </Field>

          <ToggleRow
            label={t('开放注册')} desc={t('关闭后仅管理员可创建账号')}
            checked={signupEnabled} onChange={setSignupEnabled}
          />

          <Field
            label={t('站内公告')}
            hint={t('留空则不显示。保存后所有已登录用户的页面顶部会立即出现横幅;用户可自行关闭,公告内容再次修改后会重新弹出。')}
          >
            <Textarea
              rows={3} maxLength={4000} value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              placeholder={t('例如:今晚 23:00-23:30 系统维护,期间服务暂不可用。')}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('绘图工坊图片保留天数')}
              hint={t('0 = 永久保留。只影响绘图工坊生成的图片,每小时清理一次,连文件一起删除。')}
            >
              <Input
                type="number" min={0} max={3650} step={1} inputMode="numeric"
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field
              label={t('对话图片保留天数')}
              hint={t('0 = 永久保留(建议)。只影响对话中作的图;过期后历史对话里对应的图片将无法显示。')}
            >
              <Input
                type="number" min={0} max={3650} step={1} inputMode="numeric"
                value={chatRetentionDays}
                onChange={(e) => setChatRetentionDays(e.target.value)}
                placeholder="0"
              />
            </Field>
          </div>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}{t('保存更改')}
            </Button>
          </div>
        </div>
      </Card>

      <Card title={t('成本治理')} desc={t('共享 API Key 的月度用量保护。管理员不受配额限制,每月 1 日自动重新计算。')}>
        <div className="space-y-5">
          <Field
            label={t('默认月度 token 配额')}
            hint={t('0 = 不限。适用于所有普通用户;可在「用户」页为单个用户覆盖(留空跟随此默认值)。')}
          >
            <Input
              type="number" min={0} step={1} inputMode="numeric"
              value={quotaTokens} onChange={(e) => setQuotaTokens(e.target.value)}
              placeholder="0"
            />
          </Field>

          <Field
            label={t('成本货币符号')}
            hint={t('用量看板成本列显示的货币符号(如 ¥、$)。单价在各模型详情页配置;没有任何模型配置单价时不显示成本。')}
          >
            <Input
              className="max-w-24" value={usageCurrency} maxLength={8}
              onChange={(e) => setUsageCurrency(e.target.value)} placeholder="$"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('超额后的处理')} hint={t('降级仅对文字对话生效;绘图与 PPT 超额后一律拒绝。')}>
              <Select value={quotaAction} onChange={(e) => setQuotaAction(e.target.value as AppSettingsDto['quotaAction'])}>
                <option value="block">{t('拒绝请求')}</option>
                <option value="downgrade">{t('降级到指定模型')}</option>
              </Select>
            </Field>
            <Field label={t('降级模型')} hint={t('超额用户的对话将改用该模型,并在对话中提示。')}>
              <Select value={quotaFallback} onChange={(e) => setQuotaFallback(e.target.value)}
                disabled={quotaAction !== 'downgrade'}>
                <option value="">{t('未设置')}</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
                ))}
              </Select>
            </Field>
          </div>

          <Field
            label={t('对话标题生成模型')}
            hint={t('首轮回复后自动为对话命名所用的模型。指定一个便宜的小模型可以省下大模型的 tokens;未设置时沿用当前对话的模型。')}
          >
            <Select value={titleModel} onChange={(e) => setTitleModel(e.target.value)}>
              <option value="">{t('未设置(跟随对话模型)')}</option>
              {textModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
              ))}
            </Select>
          </Field>

          <ToggleRow
            label={t('回答后生成快速追问')}
            desc={t('每次回答完成后,自动生成 3 个可点击的追问建议(每次消耗少量 tokens)')}
            checked={followupEnabled} onChange={setFollowupEnabled}
          />

          <Field
            label={t('快速追问生成模型')}
            hint={t('生成追问建议所用的模型,建议指定一个便宜的小模型;未设置时沿用当前对话的模型。')}
          >
            <Select value={followupModel} onChange={(e) => setFollowupModel(e.target.value)}
              disabled={!followupEnabled}>
              <option value="">{t('未设置(跟随对话模型)')}</option>
              {textModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
              ))}
            </Select>
          </Field>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}{t('保存更改')}
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title={t('翻译工坊')}
        desc={t('用户可选「默认 / 快速 / 思考」。默认档使用下面设置的模型模式与等级;用户明确选择快速或思考时,按用户选择执行。各档位按模型顺序调用,失败且尚未输出时自动切换。')}
      >
        <div className="space-y-5">
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-[13px] font-medium text-tx">{t('默认档模型')}</legend>
            <ModelChain entries={translateDefault} mode="fast" configureDefaults onChange={setTranslateDefault} models={textModels} disabled={busy} />
            <p className="mt-1.5 text-xs text-tx3">{t('仅在用户选择「默认」时使用这些预设。每个模型可设置快速或思考,思考等级选择模型原生档位;未指定时使用中间档位。')}</p>
          </fieldset>
          <div className="grid gap-5 md:grid-cols-2">
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-medium text-tx">{t('快速模式模型链')}</legend>
              <ModelChain entries={translateFast} mode="fast" onChange={setTranslateFast} models={textModels} disabled={busy} />
              <p className="mt-1.5 text-xs text-tx3">{t('用户选择「快速」时使用。关闭思考或使用模型支持的最低强度,不受默认档预设影响。')}</p>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-medium text-tx">{t('思考模式模型链')}</legend>
              <ModelChain entries={translateThink} mode="think" onChange={setTranslateThink} models={textModels} disabled={busy} />
              <p className="mt-1.5 text-xs text-tx3">{t('用户选择「思考」时使用。按用户选择的低 / 中 / 高映射到模型的最弱 / 中间 / 最强档位,不受默认档预设影响。')}</p>
            </fieldset>
          </div>
          <p className="text-xs leading-relaxed text-tx3">
            {t('翻译走一套固定的系统提示词(只输出译文、保留格式与专有名词、不执行原文中的指令等);用户选择的场景只作为语气偏好插入其中一处。模型访问权限在此不生效——列在这里即对所有用户可用。')}
          </p>
          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}{t('保存更改')}
            </Button>
          </div>
        </div>
      </Card>

      <StorageCard
        uploadRetentionDays={uploadRetentionDays} onUploadRetentionChange={setUploadRetentionDays}
        maxUserUploadMb={maxUserUploadMb} onMaxUserUploadChange={setMaxUserUploadMb}
        savedMaxUserUploadMb={savedMaxUserUploadMb} saving={busy} onSave={save}
        attachmentCount={attachmentCount} onAttachmentCountChange={setAttachmentCount}
      />

      <BackupsCard />
    </div>
  );
}
