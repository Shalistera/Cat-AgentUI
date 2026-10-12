import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, CircleDashed, CircleMinus, RefreshCw, RotateCw } from 'lucide-react';
import { api, errMsg, fmtDuration, fmtTime } from '../../api';
import { Badge, Button, Card, Spinner, StatusDot, confirmDialog, toast } from '../../components/ui';
import { t, tServer } from '../../i18n';
import { SectionIntro } from './settings-common';

/* 系统更新: pull the deployment's git checkout forward, rebuild and restart —
   the server side is server/src/system-update.ts. The page follows a job
   through the restart by polling; a different bootId answering means the new
   process is up. */

interface CommitInfo { hash: string; subject: string; author: string; date: number }
interface RepoState {
  available: boolean; reason: string | null;
  branch: string | null; upstream: string | null; remoteUrl: string | null;
  head: CommitInfo | null; upstreamHead: CommitInfo | null;
  ahead: number; behind: number; incoming: CommitInfo[];
  changes: { files: number; server: boolean; web: boolean; deps: boolean };
  dirty: string[]; lastFetchAt: number | null;
}
interface Supervisor {
  kind: 'systemd' | 'pm2' | null; name: string | null; policy: string | null; canRestart: boolean;
  problem: 'none' | 'policy' | 'not-main' | 'autorestart-off' | null;
}
interface Activity { chats: number; images: number; ppt: number }
type StepId = 'backup' | 'merge' | 'install' | 'build' | 'selftest' | 'wait' | 'restart';
interface UpdateStep { id: StepId; status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; startedAt: number | null; endedAt: number | null }
interface UpdateJob {
  id: string; kind: 'update' | 'restart';
  status: 'running' | 'waiting' | 'restarting' | 'done' | 'failed' | 'cancelled';
  by: string; from: string | null; to: string | null;
  steps: UpdateStep[]; log: string[]; error: string | null;
  rollbackFailed: boolean; manualRestart: boolean; waitUntil: number | null;
  startedAt: number; endedAt: number | null; restartedAt: number | null;
}
interface UpdateStatus {
  version: string;
  process: { bootId: string; bootedAt: number; commit: string | null };
  repo: RepoState; supervisor: Supervisor; activity: Activity; job: UpdateJob | null;
}
interface JobPoll { bootId: string; job: UpdateJob | null; activity: Activity }

const STEP_LABELS: Record<StepId, string> = {
  backup: t('备份数据库'),
  merge: t('合并新版本'),
  install: t('安装依赖'),
  build: t('构建'),
  selftest: t('启动自检'),
  wait: t('等待任务结束'),
  restart: t('重启服务'),
};

// Past this the restart is reported as stuck (the page keeps trying).
const RESTART_PATIENCE_MS = 120_000;
// Opening the page re-checks the remote when the last fetch is older than this.
const STALE_FETCH_MS = 10 * 60_000;

const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 7) : '—');
const isActive = (job: UpdateJob | null) => !!job && (job.status === 'running' || job.status === 'waiting' || job.status === 'restarting');

function busyText(a: Activity): string {
  const parts = [
    a.chats ? t('{n} 个回复正在生成', { n: a.chats }) : '',
    a.images ? t('{n} 个绘图任务', { n: a.images }) : '',
    a.ppt ? t('{n} 个 PPT 任务', { n: a.ppt }) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(t('、')) : t('没有进行中的任务');
}

function supervisorText(s: Supervisor): string {
  if (s.kind === 'systemd') {
    return s.policy
      ? t('systemd 单元 {name}(Restart={policy})', { name: s.name ?? '', policy: s.policy })
      : t('systemd 单元 {name}', { name: s.name ?? '' });
  }
  if (s.kind === 'pm2') return t('pm2 应用 {name}', { name: s.name ?? '' });
  return t('未检测到');
}

function supervisorProblem(s: Supervisor): string {
  if (s.problem === 'not-main') return t('面板不是 systemd 单元 {name} 的主进程(例如经由 npm 或脚本启动),退出后不一定会被拉起,所以不能从这里重启;让单元的 ExecStart 直接运行 node dist/index.js 即可。', { name: s.name ?? '' });
  if (s.problem === 'policy') return t('这个单元的 Restart= 不会在进程退出后把它拉起来,所以不能从这里重启;在单元里设置 Restart=always 即可。');
  if (s.problem === 'autorestart-off') return t('这个 pm2 应用关闭了 autorestart,所以不能从这里重启。');
  return t('面板退出后没有进程守护会把它拉起来,所以不能从这里重启,更新后需要手动重启服务。建议用 systemd(Restart=always)或 pm2 运行。');
}

/** Where to look when a restart doesn't come back. */
function logsCommand(s: Supervisor): string | null {
  if (s.kind === 'systemd' && s.name) return `journalctl -u ${s.name} -n 100`;
  if (s.kind === 'pm2' && s.name) return `pm2 logs ${s.name}`;
  return null;
}

function Status({ icon, tone = 'default', children }: {
  icon: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'err'; children: ReactNode;
}) {
  const color = { default: 'text-tx2', ok: 'text-ok', warn: 'text-warn', err: 'text-err' }[tone];
  return (
    <div className={`flex min-w-0 items-start gap-2 text-[13px] leading-relaxed ${color}`}>
      <span className="mt-[3px] shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function StepIcon({ status }: { status: UpdateStep['status'] }) {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5 text-acc" />;
  if (status === 'done') return <Check size={14} className="text-ok" />;
  if (status === 'failed') return <CircleAlert size={14} className="text-err" />;
  if (status === 'skipped') return <CircleMinus size={14} className="text-tx3" />;
  return <CircleDashed size={14} className="text-tx3" />;
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <SectionIntro title={t('系统更新')}>{t('从 Git 远端拉取新版本,构建后重启服务')}</SectionIntro>
      {children}
    </div>
  );
}

function JobCard({ job, supervisor, activity, downSince, restarted, onControl }: {
  job: UpdateJob; supervisor: Supervisor; activity: Activity | null;
  /** When the server stopped answering, null while it answers. */
  downSince: number | null;
  /** This page saw the restart happen (so its own code is the old version). */
  restarted: boolean;
  onControl(action: 'now' | 'cancel'): void;
}) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [job.log.length]);
  const live = isActive(job) || downSince !== null;
  const spinner = <Spinner className="h-3.5 w-3.5 text-acc" />;
  const runningStep = job.steps.find((s) => s.status === 'running');
  const logsCmd = logsCommand(supervisor);

  let status: ReactNode;
  if (downSince !== null || job.status === 'restarting') {
    status = downSince !== null && Date.now() - downSince > RESTART_PATIENCE_MS ? (
      <Status tone="err" icon={<CircleAlert size={15} />}>
        {t('服务超过 2 分钟没有恢复,请登录服务器查看日志。')}
        {logsCmd && <code className="ml-1 rounded bg-bg2 px-1.5 py-0.5 font-mono text-xs text-tx2">{logsCmd}</code>}
      </Status>
    ) : (
      <Status icon={spinner}>{t('服务正在重启,恢复后这里会自动更新…')}</Status>
    );
  } else if (job.status === 'running') {
    status = <Status icon={spinner}>{runningStep ? t('正在{step}…', { step: STEP_LABELS[runningStep.id] }) : t('进行中…')}</Status>;
  } else if (job.status === 'waiting') {
    const minutes = job.waitUntil ? Math.max(1, Math.ceil((job.waitUntil - Date.now()) / 60_000)) : null;
    status = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Status icon={spinner}>
          {t('等这些任务结束后重启:{busy}', { busy: activity ? busyText(activity) : '…' })}
          {minutes !== null && <span className="text-tx3">{t('(最多再等 {n} 分钟)', { n: minutes })}</span>}
        </Status>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => onControl('cancel')}>{t('取消重启')}</Button>
          <Button size="sm" onClick={() => onControl('now')}>{t('立即重启')}</Button>
        </div>
      </div>
    );
  } else if (job.status === 'done') {
    status = job.manualRestart ? (
      <Status tone="warn" icon={<CircleAlert size={15} />}>{t('新版本已经构建好,手动重启服务后生效。')}</Status>
    ) : (
      <Status tone="ok" icon={<Check size={15} />}>
        {job.restartedAt ? t('完成,服务已于 {time} 重启', { time: fmtTime(job.restartedAt) }) : t('完成')}
      </Status>
    );
  } else if (job.status === 'failed') {
    const rolledBack = job.kind === 'update' && job.steps.some((s) => s.id === 'merge' && s.status !== 'pending');
    status = (
      <div className="space-y-2">
        <Status tone="err" icon={<CircleAlert size={15} />}>{tServer(job.error ?? '')}</Status>
        {job.rollbackFailed ? (
          <p className="rounded-lg border border-err/30 bg-err/10 px-3.5 py-2.5 text-xs leading-relaxed text-err">
            {t('自动回滚也失败了,仓库和构建产物可能对不上。请登录服务器检查,处理好之前不要重启服务。')}
          </p>
        ) : rolledBack && (
          <p className="text-xs text-tx3">{t('已自动回滚到原来的版本,运行中的服务没有受到影响。')}</p>
        )}
      </div>
    );
  } else {
    status = (
      <Status icon={<CircleMinus size={15} className="text-tx3" />}>
        {job.kind === 'update' ? t('已取消重启,新版本会在下次重启服务后生效。') : t('已取消重启')}
      </Status>
    );
  }

  return (
    <Card
      title={job.kind === 'update' ? t('更新到 {hash}', { hash: short(job.to) }) : t('重启服务')}
      desc={t('{by} 于 {time} 发起', { by: job.by, time: fmtTime(job.startedAt) })}
    >
      <div className="space-y-4">
        {status}
        {restarted && job.status === 'done' && job.kind === 'update' && (
          <div className="flex items-center gap-3 rounded-lg bg-bg0 px-3.5 py-3">
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-tx2">{t('这个页面还是旧版本的界面,刷新后即可使用新版本。')}</span>
            <Button variant="primary" size="sm" onClick={() => location.reload()}>{t('刷新页面')}</Button>
          </div>
        )}
        <ol className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {job.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-[13px]">
              <StepIcon status={s.status} />
              <span className={s.status === 'pending' || s.status === 'skipped' ? 'text-tx3' : 'text-tx'}>{STEP_LABELS[s.id]}</span>
              {s.status === 'skipped' && <span className="text-xs text-tx3">{t('跳过')}</span>}
              {s.status !== 'skipped' && s.status !== 'pending' && s.startedAt && (
                <span className="ml-auto font-mono text-[11px] text-tx3">{fmtDuration((s.endedAt ?? Date.now()) - s.startedAt)}</span>
              )}
            </li>
          ))}
        </ol>
        {job.log.length > 0 && (
          <details open={live || job.status === 'failed'} className="rounded-lg border border-line bg-bg0">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-tx3">{t('日志({n} 行)', { n: job.log.length })}</summary>
            <pre ref={logRef} className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-line p-3 font-mono text-[11px] leading-relaxed text-tx2">
              {job.log.map((l) => tServer(l)).join('\n')}
            </pre>
          </details>
        )}
      </div>
    </Card>
  );
}

export default function SystemUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The process this page talks to; a different one answering = restarted.
  const bootRef = useRef<string | null>(null);
  const [downSince, setDownSince] = useState<number | null>(null);
  const [restarted, setRestarted] = useState(false);
  // A job this page has watched run stays on top once it ends, failures too.
  const [watched, setWatched] = useState(false);
  const [, setClock] = useState(0);

  const adopt = useCallback((r: UpdateStatus) => {
    bootRef.current = r.process.bootId;
    setStatus(r);
    setJob(r.job);
    setActivity(r.activity);
    setLoadError(null);
  }, []);

  const load = useCallback(
    () => api.get<UpdateStatus>('/api/admin/update').then((r) => { adopt(r); return r; }),
    [adopt],
  );

  const check = useCallback(async () => {
    setChecking(true);
    try { adopt(await api.post<UpdateStatus>('/api/admin/update/check')); }
    catch (e) { toast(errMsg(e), 'err'); }
    finally { setChecking(false); }
  }, [adopt]);

  useEffect(() => {
    load()
      .then((r) => {
        const stale = !r.repo.lastFetchAt || Date.now() - r.repo.lastFetchAt > STALE_FETCH_MS;
        if (r.repo.available && stale && !isActive(r.job)) void check();
      })
      .catch((e) => setLoadError(errMsg(e)));
  }, [load, check]);

  useEffect(() => { if (isActive(job)) setWatched(true); }, [job]);

  // Follow a job through to its end, restart included.
  const following = isActive(job) || downSince !== null;
  useEffect(() => {
    if (!following) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await api.get<JobPoll>('/api/admin/update/job');
        if (stopped) return;
        setDownSince(null);
        if (r.bootId !== bootRef.current) {
          // Someone new answered: the restart has landed.
          setRestarted(true);
          await load();
          return;
        }
        setJob(r.job);
        setActivity(r.activity);
        if (!isActive(r.job)) {
          await load();
          return;
        }
      } catch {
        if (stopped) return;
        setDownSince((d) => d ?? Date.now());
      }
      if (!stopped) timer = window.setTimeout(tick, 1000);
    };
    timer = window.setTimeout(tick, 1000);
    // Elapsed times and the wait countdown move on their own.
    const clock = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { stopped = true; window.clearTimeout(timer); window.clearInterval(clock); };
  }, [following, load]);

  async function update() {
    const head = status?.repo.upstreamHead;
    if (!status || !head) return;
    const { repo, supervisor } = status;
    const target = head.hash;
    const body = t('将更新到 {hash}(共 {n} 个新提交):先备份数据库,再合并、构建新版本,并用数据库副本做一次启动自检。任何一步失败都会自动回滚,运行中的服务不受影响。', { hash: short(target), n: repo.behind })
      + (supervisor.canRestart
        ? t('通过后重启服务,网站会中断几秒钟;如有回复正在生成,会先等它们结束(最多 20 分钟)。')
        : t('面板无法自行重启,完成后需要手动重启服务,新版本才会生效。'));
    if (!await confirmDialog(t('更新到最新版本?'), body, false)) return;
    setBusy(true);
    try {
      const r = await api.post<{ job: UpdateJob }>('/api/admin/update/apply', { target });
      setRestarted(false);
      setJob(r.job);
    } catch (e) {
      toast(errMsg(e), 'err');
      load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    if (!await confirmDialog(t('重启服务?'), t('服务会停止几秒钟,然后自动恢复;如有回复正在生成,会先等它们结束(最多 20 分钟)。'), false)) return;
    setBusy(true);
    try {
      const r = await api.post<{ job: UpdateJob }>('/api/admin/update/restart');
      setRestarted(false);
      setJob(r.job);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function control(action: 'now' | 'cancel') {
    try { setJob((await api.post<{ job: UpdateJob }>(`/api/admin/update/job/${action}`)).job); }
    catch (e) { toast(errMsg(e), 'err'); }
  }

  if (!status) {
    return (
      <Page>
        {loadError
          ? <p className="text-sm text-err">{loadError}{t('(服务端可能还是旧版本,请重新构建并重启)')}</p>
          : <p className="text-sm text-tx3">{t('加载中…')}</p>}
      </Page>
    );
  }

  const { repo, supervisor, process: proc } = status;
  const working = isActive(job) || downSince !== null;
  // The checkout moved on (by hand, or an update whose restart was called off)
  // but this process still runs what it started with.
  const notLive = !!repo.head && !!proc.commit && repo.head.hash !== proc.commit;
  const canUpdate = !working && !busy && !checking && repo.behind > 0 && repo.ahead === 0 && repo.dirty.length === 0;
  const jobCard = job && (
    <JobCard
      job={job} supervisor={supervisor} activity={activity}
      downSince={downSince} restarted={restarted} onControl={control}
    />
  );
  // A job in progress (or one this page saw run) leads; an old record trails.
  const jobFirst = working || watched;

  return (
    <Page>
      {jobFirst && jobCard}

      <Card
        title={t('当前版本')}
        actions={supervisor.canRestart && (
          <Button size="sm" disabled={working || busy} onClick={restart}><RotateCw size={13} />{t('重启服务')}</Button>
        )}
      >
        <dl className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[6.5rem_1fr] sm:gap-y-2.5">
          <dt className="text-tx3">{t('运行中')}</dt>
          <dd className="mb-2 min-w-0 text-tx2 sm:mb-0">
            <span className="font-medium text-tx">v{status.version}</span>
            <span className="font-mono text-xs"> · {short(proc.commit)}</span>
            <span className="text-tx3"> · {t('启动于 {time}', { time: fmtTime(proc.bootedAt) })}</span>
          </dd>
          {repo.branch && (
            <>
              <dt className="text-tx3">{t('分支')}</dt>
              <dd className="mb-2 min-w-0 text-tx2 sm:mb-0">
                <span className="font-mono text-xs">{repo.branch}{repo.upstream ? ` ← ${repo.upstream}` : ''}</span>
                {repo.remoteUrl && <div className="truncate font-mono text-[11px] text-tx3" title={repo.remoteUrl}>{repo.remoteUrl}</div>}
              </dd>
            </>
          )}
          <dt className="text-tx3">{t('进程守护')}</dt>
          <dd className="min-w-0 text-tx2">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={supervisor.canRestart ? 'ok' : 'warn'} />{supervisorText(supervisor)}
            </span>
            {!supervisor.canRestart && <p className="mt-1 text-xs leading-relaxed text-tx3">{supervisorProblem(supervisor)}</p>}
          </dd>
        </dl>
        {notLive && !working && (
          <p className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-xs leading-relaxed text-warn">
            {t('仓库里的代码已经是 {head},运行中的服务还是 {running},重启服务后才会生效。', { head: short(repo.head?.hash), running: short(proc.commit) })}
          </p>
        )}
      </Card>

      <Card
        title={t('更新')}
        desc={repo.lastFetchAt ? t('上次检查远端:{time}', { time: fmtTime(repo.lastFetchAt) }) : undefined}
        actions={repo.available && (
          <Button size="sm" disabled={checking || working} onClick={check}>
            {checking ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw size={13} />}{t('检查更新')}
          </Button>
        )}
      >
        {!repo.available ? (
          <p className="text-sm leading-relaxed text-tx2">{tServer(repo.reason ?? '')}</p>
        ) : repo.behind === 0 ? (
          checking && !repo.lastFetchAt ? (
            <p className="flex items-center gap-2 text-sm text-tx3"><Spinner className="h-3.5 w-3.5" />{t('正在检查…')}</p>
          ) : repo.ahead > 0 ? (
            <p className="text-sm text-tx2">{t('本地比 {upstream} 多 {n} 个提交,没有需要拉取的更新。', { upstream: repo.upstream ?? '', n: repo.ahead })}</p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ok"><Check size={15} />{t('已是最新版本')}</p>
          )
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-tx">{t('有 {n} 个新提交', { n: repo.behind })}</span>
              {repo.changes.server && <Badge tone="acc">{t('服务端')}</Badge>}
              {repo.changes.web && <Badge tone="acc">{t('前端')}</Badge>}
              {repo.changes.deps && <Badge tone="warn">{t('依赖有变化')}</Badge>}
              <span className="text-xs text-tx3">{t('{n} 个文件', { n: repo.changes.files })}</span>
            </div>
            <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {repo.incoming.map((c) => (
                <li key={c.hash} className="flex gap-3 px-3 py-2">
                  <span className="shrink-0 pt-px font-mono text-xs text-acc">{short(c.hash)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[13px] text-tx" title={c.subject}>{c.subject}</div>
                    <div className="mt-0.5 text-[11px] text-tx3">{c.author} · {fmtTime(c.date)}</div>
                  </div>
                </li>
              ))}
            </ul>
            {repo.incoming.length < repo.behind && (
              <p className="text-xs text-tx3">{t('只列出最近 {n} 个提交。', { n: repo.incoming.length })}</p>
            )}
            {repo.ahead > 0 && (
              <p className="rounded-lg border border-err/30 bg-err/10 px-3.5 py-2.5 text-xs leading-relaxed text-err">
                {t('本地分支有 {n} 个提交不在 {upstream} 上,两边已经分叉,无法快进更新。请在服务器上手动合并或重置后再试。', { n: repo.ahead, upstream: repo.upstream ?? '' })}
              </p>
            )}
            {repo.dirty.length > 0 && (
              <div className="rounded-lg border border-err/30 bg-err/10 px-3.5 py-2.5 text-xs leading-relaxed text-err">
                {t('仓库里有未提交的修改,自动更新不会覆盖它们。请先在服务器上提交或还原这些文件:')}
                <ul className="mt-1 font-mono text-[11px]">
                  {repo.dirty.slice(0, 8).map((f) => <li key={f} className="truncate">{f}</li>)}
                  {repo.dirty.length > 8 && <li>{t('…另外 {n} 个', { n: repo.dirty.length - 8 })}</li>}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
              {supervisor.canRestart && activity && (
                <span className="mr-auto text-xs text-tx3">{t('当前:{busy}', { busy: busyText(activity) })}</span>
              )}
              <Button variant="primary" disabled={!canUpdate} onClick={update}>
                {busy && <Spinner className="h-3.5 w-3.5" />}
                {supervisor.canRestart ? t('更新并重启') : t('更新(需手动重启)')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {!jobFirst && jobCard}
    </Page>
  );
}
