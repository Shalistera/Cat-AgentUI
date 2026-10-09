import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, RefreshCw, TriangleAlert } from 'lucide-react';
import { api, errMsg, fmtDuration, fmtTime } from '../../api';
import {
  Badge, Button, Card, Field, Input, Select, Spinner, Td, Th, Toggle, ToggleRow, confirmDialog, toast,
} from '../../components/ui';
import { t, tServer } from '../../i18n';
import type { AdminUser, SandboxAdminData, SandboxJob, SandboxRun, SandboxSettings } from '../../types';

function LevelIcon({ level }: { level: 'ok' | 'warn' | 'fail' }) {
  if (level === 'ok') return <Check size={14} className="shrink-0 text-ok" />;
  if (level === 'warn') return <TriangleAlert size={14} className="shrink-0 text-warn" />;
  return <CircleAlert size={14} className="shrink-0 text-err" />;
}

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-bg2 px-2 py-1 font-mono text-[11px] text-tx2" title={text}>{text}</code>
      <button
        className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] text-tx2 hover:bg-bg2 hover:text-tx"
        onClick={() => { navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}
      >
        {done ? <Check size={12} /> : <Copy size={12} />}{done ? t('已复制') : t('复制')}
      </button>
    </div>
  );
}

// ---- environment ----

function EnvCard({ data, onRefresh, refreshing }: { data: SandboxAdminData; onRefresh(): void; refreshing: boolean }) {
  const [showScript, setShowScript] = useState(false);
  const { env } = data;
  const summary = !env.runnable
    ? { tone: 'err' as const, text: t('沙盒不可用:缺少隔离环境') }
    : !env.limitsAvailable
      ? { tone: 'warn' as const, text: t('可运行,但没有资源限额') }
      : { tone: 'ok' as const, text: t('就绪') };
  return (
    <Card
      title={t('环境自检')}
      desc={t('面板以普通用户运行,系统包和内核参数需要运维在宿主机上处理;每一项红灯或黄灯旁边都给出了对应命令。')}
      actions={
        <>
          <Badge tone={summary.tone}>{summary.text}</Badge>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw size={13} />}{t('重新检测')}
          </Button>
        </>
      }
    >
      <ul className="divide-y divide-line">
        {env.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-3 py-2.5">
            <div className="mt-0.5"><LevelIcon level={c.level} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium text-tx">
                {tServer(c.label)}
                {c.required && c.level !== 'ok' && <Badge tone="err">{t('必需')}</Badge>}
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-tx3">{tServer(c.detail)}</div>
              {c.fix && c.level !== 'ok' && <CopyLine text={c.fix} />}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between text-xs text-tx3">
        <span>{t('上次检测 {time}', { time: fmtTime(env.checkedAt) })}</span>
        <button className="cursor-pointer text-acc hover:underline" onClick={() => setShowScript((v) => !v)}>
          {showScript ? t('收起一键准备脚本') : t('新机器一键准备脚本')}
        </button>
      </div>
      {showScript && (
        <div className="mt-2">
          <pre className="max-h-64 overflow-auto rounded-lg bg-bg2 p-3 font-mono text-[11px] leading-relaxed text-tx2">{env.hostSetupScript}</pre>
          <CopyLine text={env.hostSetupScript} />
        </div>
      )}
    </Card>
  );
}

// ---- settings ----

function SettingsCard({ data, users, onSaved }: { data: SandboxAdminData; users: AdminUser[]; onSaved(s: SandboxSettings): void }) {
  const [s, setS] = useState<SandboxSettings>(data.settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setS(data.settings); }, [data.settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings);
  const normalUsers = users.filter((u) => u.role !== 'admin');

  async function save() {
    setSaving(true);
    try {
      const r = await api.put<{ settings: SandboxSettings }>('/api/admin/sandbox/settings', s);
      onSaved(r.settings);
      toast(t('已保存'), 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setSaving(false); }
  }

  const num = (k: keyof SandboxSettings, min: number, max: number) => (
    <Input type="number" min={min} max={max} step={1} inputMode="numeric" className="max-w-32"
      value={s[k] as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
  );

  return (
    <Card
      title={t('执行设置')}
      desc={t('开启后,已启用工作区的对话里,模型多一个 run_command 工具:在隔离沙盒中执行命令,工作目录即该对话的工作区。')}
      actions={<Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>{saving && <Spinner className="h-3.5 w-3.5" />}{t('保存更改')}</Button>}
    >
      <div className="space-y-3">
        <ToggleRow label={t('允许模型执行命令')}
          desc={data.env.runnable
            ? t('总开关。关闭后任何对话都不会出现 run_command。')
            : t('环境自检未通过,开启也不会生效。')}
          checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} />
        <ToggleRow label={t('内置文档转换(convert_file)')}
          desc={t('PDF / Word / Markdown 互转,由固定脚本完成、不需要确认。只要环境自检通过就可用,不受上面「允许模型执行命令」的影响;出 PDF 需在运行库里安装 weasyprint 与 markdown。')}
          checked={s.builtinTools} onChange={(v) => setS({ ...s, builtinTools: v })} />
        <ToggleRow label={t('执行前需用户确认')}
          desc={t('模型每次想执行命令时先在对话里展示命令,由用户点「允许」或「拒绝」。建议保持开启,熟悉后再关。')}
          checked={s.confirm} onChange={(v) => setS({ ...s, confirm: v })} />
        <Field label={t('谁可以使用')} hint={t('管理员始终可用')}>
          <Select value={s.accessMode} onChange={(e) => setS({ ...s, accessMode: e.target.value as SandboxSettings['accessMode'] })}>
            <option value="shared">{t('所有登录用户')}</option>
            <option value="restricted">{t('仅指定普通用户')}</option>
          </Select>
        </Field>
        {s.accessMode === 'restricted' && (
          <div className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg0">
            {normalUsers.length === 0 ? (
              <div className="px-3 py-3 text-xs text-tx3">{t('暂无普通用户')}</div>
            ) : normalUsers.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-tx">{u.displayName || u.username}</div>
                  {u.displayName && <div className="truncate text-[11px] text-tx3">@{u.username}</div>}
                </div>
                {u.disabled && <Badge tone="err">{t('已停用')}</Badge>}
                <Toggle checked={s.allowedUserIds.includes(u.id)}
                  onChange={(v) => setS({ ...s, allowedUserIds: v ? [...s.allowedUserIds, u.id] : s.allowedUserIds.filter((id) => id !== u.id) })} />
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('单条命令超时(秒)')}
            hint={t('上限 {max}(MAX_SANDBOX_TIMEOUT_SECONDS)', { max: data.limits.maxTimeoutSec })}>{num('timeoutSec', 5, data.limits.maxTimeoutSec)}</Field>
          <Field label={t('内存上限(MB)')}
            hint={data.env.limitsAvailable ? t('超出即被 OOM 终止') : t('需要 systemd 用户实例才生效')}>{num('memoryMb', 64, 16384)}</Field>
          <Field label={t('CPU 配额(%)')} hint={t('100 = 一个核心')}>{num('cpuPercent', 10, 800)}</Field>
          <Field label={t('进程数上限')}>{num('maxPids', 8, 4096)}</Field>
          <Field label={t('输出上限(字符)')} hint={t('stdout / stderr 各自截断到此长度后交给模型')}>{num('maxOutputChars', 2000, 200000)}</Field>
          <div className="text-xs text-tx3">
            <div className="eyebrow mb-1">{t('并发')}</div>
            {t('全站同时最多 {max} 条命令(MAX_SANDBOX_CONCURRENCY),每人 1 条;当前 {running} 条在跑。', {
              max: data.limits.maxConcurrency, running: data.load.running,
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---- venv & packages ----

function JobLog({ job }: { job: SandboxJob }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [job.log.length]);
  const kind = {
    create: t('创建运行库环境'),
    rebuild: t('重建运行库环境'),
    install: t('安装 {specs}', { specs: job.args.join(' ') }),
    uninstall: t('卸载 {specs}', { specs: job.args.join(' ') }),
  }[job.kind];
  return (
    <div className="rounded-lg border border-line bg-bg0">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        {job.status === 'running' ? <Spinner className="h-3.5 w-3.5 text-acc" /> : job.status === 'done' ? <Check size={14} className="text-ok" /> : <CircleAlert size={14} className="text-err" />}
        <span className="font-medium text-tx">{kind}</span>
        <span className="text-tx3">
          {job.status === 'running'
            ? t('进行中…')
            : job.status === 'done' ? t('完成') : t('失败:{error}', { error: tServer(job.error ?? '') })}
        </span>
      </div>
      <pre ref={ref} className="max-h-56 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-tx2">{job.log.join('\n') || t('(等待输出)')}</pre>
    </div>
  );
}

function PackagesCard({ data, reload }: { data: SandboxAdminData; reload(): Promise<void> }) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const job = data.job;
  const running = job?.status === 'running';
  const pythonCheck = data.env.checks.find((c) => c.id === 'python');
  const canCreate = pythonCheck?.level === 'ok';
  const installed = useMemo(() => new Map(data.venv.packages.map((p) => [p.name.toLowerCase().replace(/_/g, '-'), p.version])), [data.venv.packages]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof data.venv.presets>();
    for (const p of data.venv.presets) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [data.venv.presets]);

  async function post(path: string, body: unknown) {
    setBusy(true);
    try { await api.post(path, body); await reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }
  const missingPresets = data.venv.presets.filter((p) => !installed.has(p.name.toLowerCase())).map((p) => p.name);

  return (
    <Card
      title={t('Python 运行库')}
      desc={t('沙盒里的 python3 只能用这里装好的库(只读挂载,模型改不了)。下载由面板进程完成,沙盒本身始终无网络。')}
      actions={data.venv.exists ? (
        <Button variant="outline" size="sm" disabled={running || busy} onClick={async () => {
          if (await confirmDialog(t('重建运行库环境'), t('会删除现有 venv 与全部已装库后重新创建,之后需要重新安装。'))) post('/api/admin/sandbox/venv', { rebuild: true });
        }}>{t('重建')}</Button>
      ) : (
        <Button variant="primary" size="sm" disabled={!canCreate || running || busy} onClick={() => post('/api/admin/sandbox/venv', {})}>{t('创建运行库环境')}</Button>
      )}
    >
      {!data.venv.exists && !canCreate && (
        <p className="mb-3 text-xs text-warn">
          {pythonCheck?.detail ? tServer(pythonCheck.detail) : t('需要 python3 与 venv')}
          {pythonCheck?.fix ? t(';运维执行:{cmd}', { cmd: pythonCheck.fix }) : ''}
        </p>
      )}
      {job && <div className="mb-4"><JobLog job={job} /></div>}

      <div className="space-y-4">
        {groups.map(([group, presets]) => (
          <div key={group}>
            <div className="eyebrow mb-1.5">{tServer(group)}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {presets.map((p) => {
                const ver = installed.get(p.name.toLowerCase());
                return (
                  <div key={p.name} className="flex items-center gap-2 rounded-lg border border-line bg-bg0 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium text-tx">
                        <span className="font-mono">{p.name}</span>
                        {ver && <span className="text-[11px] font-normal tabular-nums text-tx3">{ver}</span>}
                      </div>
                      <div className="truncate text-[11px] text-tx3" title={tServer(p.desc)}>{tServer(p.desc)}</div>
                    </div>
                    {ver ? (
                      <Button variant="ghost" size="sm" disabled={running || busy || !data.venv.exists}
                        onClick={() => post('/api/admin/sandbox/packages/uninstall', { names: [p.name] })}>{t('卸载')}</Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={running || busy || !data.venv.exists}
                        onClick={() => post('/api/admin/sandbox/packages/install', { specs: [p.name] })}>{t('安装')}</Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('安装其他包')} hint={t('pip 包名,可带版本,如 xlsxwriter 或 tabulate==0.9.0;空格分隔多个')}>
            <Input className="w-80 max-w-full font-mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="xlsxwriter tabulate" disabled={!data.venv.exists} />
          </Field>
          <Button variant="outline" disabled={running || busy || !data.venv.exists || !custom.trim()}
            onClick={() => { post('/api/admin/sandbox/packages/install', { specs: custom.trim().split(/\s+/) }); setCustom(''); }}>{t('安装')}</Button>
          {missingPresets.length > 0 && data.venv.exists && (
            <Button variant="outline" disabled={running || busy}
              onClick={() => post('/api/admin/sandbox/packages/install', { specs: missingPresets })}>
              {t('一键安装全部推荐库({n})', { n: missingPresets.length })}
            </Button>
          )}
        </div>
        {data.venv.packages.length > 0 && (
          <div>
            <div className="eyebrow mb-1.5">{t('已安装({n})', { n: data.venv.packages.length })}</div>
            <div className="flex flex-wrap gap-1.5">
              {data.venv.packages.map((p) => (
                <span key={p.name} className="rounded-md bg-bg2 px-2 py-0.5 font-mono text-[11px] text-tx2">{p.name} <span className="text-tx3">{p.version}</span></span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- audit ----

function RunsCard() {
  const [runs, setRuns] = useState<SandboxRun[] | null>(null);
  const load = useCallback(() => {
    api.get<{ runs: SandboxRun[] }>('/api/admin/sandbox/runs').then((r) => setRuns(r.runs)).catch((e) => toast(errMsg(e), 'err'));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <Card title={t('最近执行')} desc={t('最近 100 条命令:谁、在哪个对话、结果如何。')} flush
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={load}><RefreshCw size={13} />{t('刷新')}</Button>
          <Button variant="ghost" size="sm" onClick={async () => {
            if (await confirmDialog(t('清空执行记录'), t('删除全部沙盒执行记录。'))) { await api.del('/api/admin/sandbox/runs'); load(); }
          }}>{t('清空')}</Button>
        </>
      }
    >
      {!runs ? <div className="flex justify-center py-6 text-tx3"><Spinner /></div>
        : runs.length === 0 ? <p className="py-6 text-center text-xs text-tx3">{t('暂无记录')}</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr><Th>{t('时间')}</Th><Th>{t('用户')}</Th><Th>{t('对话')}</Th><Th>{t('命令')}</Th><Th>{t('结果')}</Th><Th className="text-right">{t('耗时')}</Th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="group">
                    <Td className="whitespace-nowrap text-tx3">{fmtTime(r.createdAt)}</Td>
                    <Td className="whitespace-nowrap">{r.user.displayName || r.user.username}</Td>
                    <Td className="max-w-[10rem] truncate text-tx2" title={r.chatTitle ?? ''}>{r.chatTitle || <span className="text-tx3">{t('(无标题)')}</span>}</Td>
                    <Td className="max-w-[24rem]"><code className="block truncate font-mono text-[11px] text-tx2" title={r.command}>{r.command.replace(/\s+/g, ' ')}</code></Td>
                    <Td className="whitespace-nowrap">
                      {r.timedOut
                        ? <Badge tone="err">{t('超时')}</Badge>
                        : r.exitCode === 0
                          ? <Badge tone="ok">{t('成功')}</Badge>
                          : <Badge tone="err">{t('退出码 {code}', { code: r.exitCode ?? '?' })}</Badge>}
                    </Td>
                    <Td className="whitespace-nowrap text-right tabular-nums text-tx3">{fmtDuration(r.durationMs)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Card>
  );
}

// ---- page ----

export default function Sandbox() {
  const [data, setData] = useState<SandboxAdminData | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const r = await api.get<SandboxAdminData>(`/api/admin/sandbox${refresh ? '?refresh=1' : ''}`);
      setData(r);
    } catch (e) { toast(errMsg(e), 'err'); } finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    load();
    api.get<AdminUser[]>('/api/admin/users').then(setUsers).catch(() => { /* optional */ });
  }, [load]);

  // A pip job in flight: poll its log until it settles, then refresh the package list.
  const running = data?.job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const r = await api.get<{ job: SandboxJob | null }>('/api/admin/sandbox/job');
        setData((d) => (d ? { ...d, job: r.job } : d));
        if (r.job && r.job.status !== 'running') load();
      } catch { /* next tick */ }
    }, 1000);
    return () => clearInterval(t);
  }, [running, load]);

  if (!data) return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-base font-semibold tracking-tight text-tx">{t('沙盒')}</h1>
        <p className="mt-0.5 text-xs text-tx3">
          {t('让模型在隔离环境里执行命令:只能看到当前对话的工作区,没有网络,资源与时长受限。')}
        </p>
      </div>
      <EnvCard data={data} onRefresh={() => load(true)} refreshing={refreshing} />
      <SettingsCard data={data} users={users} onSaved={(s) => setData((d) => (d ? { ...d, settings: s } : d))} />
      <PackagesCard data={data} reload={() => load()} />
      <RunsCard />
    </div>
  );
}
