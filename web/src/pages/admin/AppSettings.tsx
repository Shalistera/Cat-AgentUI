import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { api, fmtTime } from '../../api';
import { useAuth } from '../../store';
import { Button, Card, Field, Input, Select, Spinner, Textarea, ToggleRow, toast } from '../../components/ui';
import type { AppSettings as AppSettingsDto, ModelInfo } from '../../types';

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
function ModelChain({ ids, onChange, models, disabled }: {
  ids: string[]; onChange(next: string[]): void; models: ModelInfo[]; disabled?: boolean;
}) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const remaining = models.filter((m) => !ids.includes(m.id));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {ids.length > 0 ? (
        <ol className="divide-y divide-line rounded-lg border border-line">
          {ids.map((id, i) => {
            const m = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-4 shrink-0 text-xs tabular-nums text-tx3">{i + 1}.</span>
                <span className={`min-w-0 flex-1 truncate ${m ? 'text-tx' : 'text-err'}`}>
                  {m ? `${m.displayName}(${m.providerName})` : `模型已删除或停用(${id})`}
                </span>
                <button type="button" title="上移" disabled={disabled || i === 0}
                  className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                  onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                <button type="button" title="下移" disabled={disabled || i === ids.length - 1}
                  className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                  onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                <button type="button" title="移除" disabled={disabled}
                  className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-err disabled:opacity-30"
                  onClick={() => onChange(ids.filter((x) => x !== id))}><X size={13} /></button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-tx3">尚未选择模型,该模式对用户不可用。</p>
      )}
      {ids.length < CHAIN_MAX && (
        <Select value="" disabled={disabled || remaining.length === 0}
          onChange={(e) => { if (e.target.value) onChange([...ids, e.target.value]); }}>
          <option value="">{remaining.length ? '添加模型…' : '没有更多可添加的模型'}</option>
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
      .catch((e) => { setLoadError(e instanceof Error ? e.message : '加载备份列表失败'); return null; });
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
      toast(r.started ? '快照已开始,完成后会出现在列表中' : '已有备份在进行中', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '备份失败', 'err');
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
      toast('备份策略已保存', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: BackupInfo) {
    if (!window.confirm(`删除快照 ${b.filename}?此操作不可恢复。`)) return;
    try {
      setData(await api.del<BackupsDto>(`/api/admin/backups/${encodeURIComponent(b.filename)}`));
      toast('已删除', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'err');
    }
  }

  const st = data?.status;
  const totalSize = data ? data.backups.reduce((n, b) => n + b.size, 0) : 0;

  return (
    <Card
      title="数据库备份"
      desc="SQLite 在线快照,存放于 data/backups/,不影响服务运行。策略在此设置并立即生效。"
    >
      <div className="space-y-4">
        <p className="text-xs text-tx3">
          快照只包含数据库(对话、设置、加密后的密钥)。附件与生成图片在 data/uploads 与
          data/images 目录,请连同 .env(SECRET_KEY)一起做整目录备份;缺少对应的
          SECRET_KEY 时快照中的密钥无法解密。
        </p>

        <ToggleRow
          label="自动定时备份"
          desc="关闭后只能手动备份;已有的快照不会被删除。"
          checked={enabled} onChange={(v) => { setEnabled(v); setDirty(true); }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="备份间隔(小时)" hint="1–720。从最近一份快照的时间起算。">
            <Input
              type="number" min={1} max={720} step={1} inputMode="numeric"
              value={interval} disabled={!enabled}
              onChange={(e) => { setInterval_(e.target.value); setDirty(true); }}
            />
          </Field>
          <Field label="保留份数" hint="1–365。超出的旧快照会在下次备份或保存策略时删除;数据库大时请按磁盘空间设置。">
            <Input
              type="number" min={1} max={365} step={1} inputMode="numeric"
              value={keep}
              onChange={(e) => { setKeep(e.target.value); setDirty(true); }}
            />
          </Field>
        </div>

        {st && (
          <div className="grid gap-x-6 gap-y-1 rounded-lg bg-bg0 px-3.5 py-3 text-xs text-tx3 sm:grid-cols-2">
            <div>当前数据库:<span className="text-tx2">{fmtBytes(st.dbSize)}</span>(每份快照约此大小)</div>
            <div>快照合计:<span className="text-tx2">{fmtBytes(totalSize)}</span>({data!.backups.length} 份)</div>
            <div>磁盘剩余:<span className="text-tx2">{st.freeSpace === null ? '未知' : fmtBytes(st.freeSpace)}</span></div>
            <div>下次自动备份:<span className="text-tx2">
              {st.running ? '进行中…' : st.nextRunAt ? fmtTime(st.nextRunAt) : '已停用'}
            </span></div>
            {st.lastError && <div className="text-err sm:col-span-2">上次备份失败:{st.lastError}</div>}
          </div>
        )}

        {loadError ? (
          <p className="text-sm text-err">{loadError}(服务端可能还是旧版本,请重新构建并重启)</p>
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
                >下载</a>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer text-xs text-tx3 hover:text-err"
                  onClick={() => remove(b)}
                >删除</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-tx3">{data ? '还没有任何快照。' : '加载中…'}</p>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button disabled={busy || !data || running} onClick={backupNow}>
            {running && <Spinner className="h-3.5 w-3.5" />}{running ? '备份进行中…' : '立即备份'}
          </Button>
          <Button variant="primary" disabled={busy || !data || !dirty} onClick={saveSettings}>
            {busy && <Spinner className="h-3.5 w-3.5" />}保存备份策略
          </Button>
        </div>
      </div>
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
  const [quotaTokens, setQuotaTokens] = useState('0');
  const [quotaAction, setQuotaAction] = useState<AppSettingsDto['quotaAction']>('block');
  const [quotaFallback, setQuotaFallback] = useState('');
  const [titleModel, setTitleModel] = useState('');
  const [followupEnabled, setFollowupEnabled] = useState(true);
  const [followupModel, setFollowupModel] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [usageCurrency, setUsageCurrency] = useState('$');
  const [translateFast, setTranslateFast] = useState<string[]>([]);
  const [translateThink, setTranslateThink] = useState<string[]>([]);
  const [textModels, setTextModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);

  function apply(r: AppSettingsDto) {
    setBrand(r.brand); setSignupEnabled(r.signupEnabled);
    setRetentionDays(String(r.imageRetentionDays ?? 0));
    setChatRetentionDays(String(r.chatImageRetentionDays ?? 0));
    setQuotaTokens(String(r.quotaMonthlyTokens ?? 0));
    setQuotaAction(r.quotaAction ?? 'block');
    setQuotaFallback(r.quotaFallbackModelId ?? '');
    setTitleModel(r.titleModelId ?? '');
    setFollowupEnabled(r.followupEnabled ?? true);
    setFollowupModel(r.followupModelId ?? '');
    setAnnouncement(r.announcement ?? '');
    setUsageCurrency(r.usageCurrency ?? '$');
    setTranslateFast(r.translateFastModelIds ?? []);
    setTranslateThink(r.translateThinkModelIds ?? []);
  }

  useEffect(() => {
    api.get<AppSettingsDto>('/api/admin/settings')
      .then((r) => { apply(r); setLoaded(true); })
      .catch((e) => toast(e instanceof Error ? e.message : '加载站点设置失败', 'err'));
    // Admins see every enabled model here — the downgrade target picker.
    api.get<ModelInfo[]>('/api/models')
      .then((r) => setTextModels(r.filter((m) => !m.imageGen)))
      .catch(() => { /* picker stays empty */ });
  }, []);

  async function save() {
    if (busy) return;
    const name = brand.trim();
    if (!name) { toast('站点名称不能为空', 'err'); return; }
    if (quotaAction === 'downgrade' && !quotaFallback) {
      toast('降级模式需要选择一个降级模型,否则超额会按拒绝处理', 'err');
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
        quotaMonthlyTokens: Math.max(0, Math.round(Number(quotaTokens)) || 0),
        quotaAction,
        quotaFallbackModelId: quotaFallback || null,
        titleModelId: titleModel || null,
        followupEnabled,
        followupModelId: followupModel || null,
        announcement: announcement.trim(),
        usageCurrency: usageCurrency.trim() || '$',
        translateFastModelIds: translateFast,
        translateThinkModelIds: translateThink,
      });
      apply(r);
      toast('已保存', 'ok');
      useAuth.getState().refresh().catch(() => { /* ignore */ });
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'err');
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
        <h1 className="text-base font-semibold tracking-tight text-tx">应用设置</h1>
        <p className="mt-0.5 text-xs text-tx3">站点名称、注册开关与生成图片的保留策略</p>
      </div>

      <Card title="站点设置" desc="影响登录页展示与新账号的注册方式。">
        <div className="space-y-5">
          <Field label="站点名称" hint="显示在登录页、侧边栏与浏览器标题">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={64} />
          </Field>

          <ToggleRow
            label="开放注册" desc="关闭后仅管理员可创建账号"
            checked={signupEnabled} onChange={setSignupEnabled}
          />

          <Field
            label="站内公告"
            hint="留空则不显示。保存后所有已登录用户的页面顶部会立即出现横幅;用户可自行关闭,公告内容再次修改后会重新弹出。"
          >
            <Textarea
              rows={3} maxLength={4000} value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              placeholder="例如:今晚 23:00-23:30 系统维护,期间服务暂不可用。"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="绘图工坊图片保留天数"
              hint="0 = 永久保留。只影响绘图工坊生成的图片,每小时清理一次,连文件一起删除。"
            >
              <Input
                type="number" min={0} max={3650} step={1} inputMode="numeric"
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field
              label="对话图片保留天数"
              hint="0 = 永久保留(建议)。只影响对话中作的图;过期后历史对话里对应的图片将无法显示。"
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
              {busy && <Spinner className="h-3.5 w-3.5" />}保存更改
            </Button>
          </div>
        </div>
      </Card>

      <Card title="成本治理" desc="共享 API Key 的月度用量保护。管理员不受配额限制,每月 1 日自动重新计算。">
        <div className="space-y-5">
          <Field
            label="默认月度 token 配额"
            hint="0 = 不限。适用于所有普通用户;可在「用户」页为单个用户覆盖(留空跟随此默认值)。"
          >
            <Input
              type="number" min={0} step={1} inputMode="numeric"
              value={quotaTokens} onChange={(e) => setQuotaTokens(e.target.value)}
              placeholder="0"
            />
          </Field>

          <Field
            label="成本货币符号"
            hint="用量看板成本列显示的货币符号(如 ¥、$)。单价在各模型详情页配置;没有任何模型配置单价时不显示成本。"
          >
            <Input
              className="max-w-24" value={usageCurrency} maxLength={8}
              onChange={(e) => setUsageCurrency(e.target.value)} placeholder="$"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="超额后的处理" hint="降级仅对文字对话生效;绘图与 PPT 超额后一律拒绝。">
              <Select value={quotaAction} onChange={(e) => setQuotaAction(e.target.value as AppSettingsDto['quotaAction'])}>
                <option value="block">拒绝请求</option>
                <option value="downgrade">降级到指定模型</option>
              </Select>
            </Field>
            <Field label="降级模型" hint="超额用户的对话将改用该模型,并在对话中提示。">
              <Select value={quotaFallback} onChange={(e) => setQuotaFallback(e.target.value)}
                disabled={quotaAction !== 'downgrade'}>
                <option value="">未设置</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
                ))}
              </Select>
            </Field>
          </div>

          <Field
            label="对话标题生成模型"
            hint="首轮回复后自动为对话命名所用的模型。指定一个便宜的小模型可以省下大模型的 tokens;未设置时沿用当前对话的模型。"
          >
            <Select value={titleModel} onChange={(e) => setTitleModel(e.target.value)}>
              <option value="">未设置(跟随对话模型)</option>
              {textModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
              ))}
            </Select>
          </Field>

          <ToggleRow
            label="回答后生成快速追问"
            desc="每次回答完成后,自动生成 3 个可点击的追问建议(每次消耗少量 tokens)"
            checked={followupEnabled} onChange={setFollowupEnabled}
          />

          <Field
            label="快速追问生成模型"
            hint="生成追问建议所用的模型,建议指定一个便宜的小模型;未设置时沿用当前对话的模型。"
          >
            <Select value={followupModel} onChange={(e) => setFollowupModel(e.target.value)}
              disabled={!followupEnabled}>
              <option value="">未设置(跟随对话模型)</option>
              {textModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
              ))}
            </Select>
          </Field>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}保存更改
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="翻译工坊"
        desc="用户在翻译页只选「快速 / 思考」和三档强度,不选模型。每种模式按下面的顺序调用,前一个失败(尚未输出)时自动换下一个;某个模式留空则对用户隐藏。"
      >
        <div className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="快速模式" hint="推荐便宜、快的模型;有推理功能的模型会被显式关闭推理。">
              <ModelChain ids={translateFast} onChange={setTranslateFast} models={textModels} disabled={busy} />
            </Field>
            <Field label="思考模式" hint="推荐带推理能力的模型;用户选的低 / 中 / 高会映射到该模型自己推理档位的最弱 / 中间 / 最强一档。">
              <ModelChain ids={translateThink} onChange={setTranslateThink} models={textModels} disabled={busy} />
            </Field>
          </div>
          <p className="text-xs leading-relaxed text-tx3">
            翻译走一套固定的系统提示词(只输出译文、保留格式与专有名词、不执行原文中的指令等);用户选择的场景只作为语气偏好插入其中一处。模型访问权限在此不生效——列在这里即对所有用户可用。
          </p>
          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}保存更改
            </Button>
          </div>
        </div>
      </Card>

      <BackupsCard />
    </div>
  );
}
