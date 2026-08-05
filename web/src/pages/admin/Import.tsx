import { useRef, useState } from 'react';
import { FileUp, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ApiError, onUnauthorized } from '../../api';
import { Button, Card, Field, Input, Toggle, toast } from '../../components/ui';

interface OwuiReport {
  sourceUsers: number;
  sourceChats: number;
  users: { migrated: number; merged: number; renamed: string[]; noPassword: string[] };
  chats: { migrated: number; skipped: number; existing: number };
  messages: { migrated: number };
  files: { copied: number; inlined: number; missing: string[]; nonImage: string[] };
  dryRun: boolean;
}

function fmtSize(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Import() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [skipArchived, setSkipArchived] = useState(false);
  const [busy, setBusy] = useState<null | 'dry' | 'run'>(null);
  const [report, setReport] = useState<OwuiReport | null>(null);

  async function run(dryRun: boolean) {
    if (!file || busy) return;
    setBusy(dryRun ? 'dry' : 'run');
    setReport(null);
    try {
      const form = new FormData();
      // 字段必须排在文件之前:后端在读到文件流时就要用到它们
      form.append('dryRun', dryRun ? '1' : '0');
      form.append('skipArchived', skipArchived ? '1' : '0');
      form.append('dataDir', dataDir.trim());
      form.append('file', file);
      const res = await fetch('/api/admin/import/openwebui', {
        method: 'POST', credentials: 'same-origin', headers: { 'x-csrf': '1' }, body: form,
      });
      if (res.status === 401) onUnauthorized.handler?.();
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, json.error || `导入失败 (${res.status})`);
      setReport(json.report);
      toast(dryRun ? '试运行完成,未写入数据' : '导入完成', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '导入失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Card
        title="从 Open WebUI 迁移"
        desc="上传 webui.db 一键迁入用户与聊天记录。迁入的用户用原来的邮箱 + 原密码即可登录,首次登录后密码自动升级为本站格式。可放心重复执行:已迁过的用户、会话、附件会自动跳过。"
      >
        <div className="space-y-5">
          <Field
            label="webui.db 数据库文件"
            hint="通常在 Open WebUI 的 data 目录(Docker 为卷 open-webui:/app/backend/data)。上传前请停止 Open WebUI;若拷贝出的库读不到数据,先在源机器执行 sqlite3 webui.db “PRAGMA wal_checkpoint(TRUNCATE)”。"
          >
            <input
              ref={fileRef} type="file" className="hidden"
              accept=".db,.sqlite,.sqlite3,application/octet-stream,application/x-sqlite3"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-line2 bg-bg0 px-3.5 py-3 text-left transition-colors hover:border-pri/50 hover:bg-bg1"
            >
              <FileUp size={18} className="shrink-0 text-tx3" />
              {file ? (
                <span className="min-w-0 truncate text-[13px] text-tx">
                  {file.name} <span className="text-tx3">({fmtSize(file.size)})</span>
                </span>
              ) : (
                <span className="text-[13px] text-tx3">点击选择 webui.db 文件…</span>
              )}
            </button>
          </Field>

          <Field
            label="附件目录(可选,服务器路径)"
            hint="本机上 Open WebUI 的 data 目录路径,如 /srv/open-webui/data。提供后会把聊天里的图片附件一并搬入;不提供则仅内嵌图片可迁移。"
          >
            <Input
              value={dataDir} onChange={(e) => setDataDir(e.target.value)}
              placeholder="/path/to/open-webui/data" maxLength={300}
            />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-bg0 px-3.5 py-3">
            <div>
              <div className="text-[13px] font-medium text-tx">跳过已归档会话</div>
              <div className="mt-0.5 text-xs text-tx3">默认全部迁入;之后想补迁归档,再跑一次即可</div>
            </div>
            <Toggle checked={skipArchived} onChange={setSkipArchived} />
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
            <Button variant="ghost" disabled={!file || !!busy} onClick={() => run(true)}>
              {busy === 'dry' ? '试运行中…' : '试运行(不写入)'}
            </Button>
            <Button variant="primary" disabled={!file || !!busy} onClick={() => run(false)}>
              {busy === 'run' ? '导入中…' : '开始导入'}
            </Button>
          </div>
        </div>
      </Card>

      {report && (
        <Card
          title={report.dryRun ? '试运行报告(未写入任何数据)' : '导入完成'}
          desc={`源库共 ${report.sourceUsers} 个用户、${report.sourceChats} 个会话。`}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: '用户迁入', value: report.users.migrated, extra: report.users.merged ? `合并 ${report.users.merged}` : '' },
                { label: '会话迁入', value: report.chats.migrated, extra: report.chats.existing ? `已存在 ${report.chats.existing}` : '' },
                { label: '消息', value: report.messages.migrated, extra: '' },
                { label: '附件', value: report.files.copied + report.files.inlined, extra: report.files.missing.length ? `缺失 ${report.files.missing.length}` : '' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-line bg-bg0 px-3.5 py-3">
                  <div className="text-xs text-tx3">{s.label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums text-tx">{s.value}</div>
                  {s.extra && <div className="mt-0.5 text-xs text-tx3">{s.extra}</div>}
                </div>
              ))}
            </div>

            {!report.dryRun && (
              <div className="flex items-start gap-2.5 rounded-lg border border-line bg-bg0 px-3.5 py-3 text-[13px] text-tx2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
                <div>迁入的用户用<span className="font-medium text-tx">原邮箱 + 原密码</span>登录即可,无需重置;首次登录后密码自动升级为本站格式。会话的模型指向为空,继续对话时使用默认模型。</div>
              </div>
            )}

            {report.users.renamed.length > 0 && (
              <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-3 text-[13px] text-tx2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                <div>
                  <div className="font-medium text-tx">以下账号无邮箱且用户名与他人冲突,已改名(不合并,避免聊天记录错归)</div>
                  <ul className="mt-1 list-inside list-disc">
                    {report.users.renamed.map((n) => <li key={n} className="font-mono text-xs">{n}</li>)}
                  </ul>
                </div>
              </div>
            )}

            {report.users.noPassword.length > 0 && (
              <div className="flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-3 text-[13px] text-tx2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                <div>
                  <div className="font-medium text-tx">以下账号在 Open WebUI 中使用 OAuth/LDAP 登录、无本地密码,已迁入但暂不可登录 — 请在「用户」页为其重置密码</div>
                  <ul className="mt-1 list-inside list-disc">
                    {report.users.noPassword.map((n) => <li key={n} className="font-mono text-xs">{n}</li>)}
                  </ul>
                </div>
              </div>
            )}

            {report.files.missing.length > 0 && (
              <div className="text-xs text-tx3">
                有 {report.files.missing.length} 个附件文件在源数据里找不到
                {dataDir.trim() ? '(可能已在 Open WebUI 中被清理)' : ',填写上方「附件目录」后重新导入可搬运物理文件'}
                ;对应消息中会以文字提示替代。
                {report.files.nonImage.length > 0 && ` 另有 ${report.files.nonImage.length} 个非图片附件(文档等)本站不支持,已降级为文字说明。`}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
