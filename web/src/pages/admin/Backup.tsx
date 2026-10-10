import { useEffect, useState } from 'react';
import { api, fmtTime } from '../../api';
import { Button, Card, Field, Input, Spinner, ToggleRow, confirmDialog, toast } from '../../components/ui';
import { t, tServer } from '../../i18n';
import { OpenWebUIImport } from './Import';
import { SectionIntro, fmtBytes, useUnsavedGuard } from './settings-common';

interface BackupInfo { filename: string; size: number; createdAt: number }
interface BackupSettings { enabled: boolean; intervalHours: number; keep: number }
interface BackupStatus {
  running: boolean; nextRunAt: number | null; lastError: string | null;
  dbSize: number; freeSpace: number | null;
}
interface BackupsDto { backups: BackupInfo[]; settings: BackupSettings; status: BackupStatus }

function BackupsCard() {
  const [data, setData] = useState<BackupsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Policy form; raw strings so fields can be emptied while typing.
  const [enabled, setEnabled] = useState(true);
  const [interval, setInterval_] = useState('24');
  const [keep, setKeep] = useState('7');
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);

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
    if (!await confirmDialog(t('删除快照'), t('删除快照 {name}?此操作不可恢复。', { name: b.filename }))) return;
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

export default function Backup() {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <SectionIntro title={t('备份与迁移')}>{t('数据库快照的策略与下载,以及从 Open WebUI 迁入用户与聊天记录')}</SectionIntro>
      <BackupsCard />
      <OpenWebUIImport />
    </div>
  );
}
