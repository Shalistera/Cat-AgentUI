import { useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { fmtTime } from '../api';
import { usePlanUsage } from '../store';
import type { PlanUsage, PlanWindow } from '../types';
import { t, tServer } from '../i18n';
import { Badge, Popover, Spinner } from './ui';

/* 本地 Claude Code: how much of the claude.ai plan is used — the windows
   Claude Code's own /usage and claude.ai's settings show, shared with every
   other place the account signs in. Read by the server (planUsage in
   providers/claude-code.ts); a finished reply re-reads it (planUsageAfterReply). */

// A meter that appears re-reads a reading older than this.
const STALE_MS = 60_000;

function windowLabel(w: PlanWindow): string {
  switch (w.key) {
    case 'five_hour': return t('5 小时');
    case 'seven_day': return t('本周 · 全部模型');
    case 'seven_day_opus': return t('本周 · Opus');
    case 'seven_day_sonnet': return t('本周 · Sonnet');
    case 'seven_day_oauth_apps': return t('本周 · 第三方应用');
    default: return t('本周 · {model}', { model: w.label ?? '?' });
  }
}

function sourceLabel(s: { key: string | null; label: string }): string {
  if (s.key === 'chat') return t('网页和 App 对话');
  if (s.key === 'other') return t('其他');
  return s.label;
}

const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
const textTone = (v: number | null | undefined) => (v === null || v === undefined ? 'text-tx3' : v >= 90 ? 'text-err' : v >= 70 ? 'text-warn' : 'text-tx2');
const barTone = (v: number) => (v >= 90 ? 'bg-err' : v >= 70 ? 'bg-warn' : 'bg-acc');

/** How far a window moved since the reading before — within the same window only. */
function moved(w: PlanWindow, previous: PlanUsage | null): number | null {
  const p = previous?.windows.find((x) => x.key === w.key && x.label === w.label);
  if (!p || p.resetsAt !== w.resetsAt || p.utilization === null || w.utilization === null) return null;
  const d = w.utilization - p.utilization;
  return d > 0 ? d : null;
}

function WindowRow({ w, previous }: { w: PlanWindow; previous: PlanUsage | null }) {
  const d = moved(w, previous);
  const used = Math.min(100, Math.max(0, w.utilization ?? 0));
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-tx2">{windowLabel(w)}</span>
        {d !== null && <span className="text-[11px] text-tx3">{t('较上次 +{n}%', { n: Math.round(d) })}</span>}
        <span className={`ml-auto font-medium tabular-nums ${textTone(w.utilization)}`}>{pct(w.utilization)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg3">
        <div className={`h-full rounded-full ${barTone(used)}`} style={{ width: `${used}%` }} />
      </div>
      {w.resetsAt && <div className="mt-0.5 text-[11px] text-tx3">{t('{time} 重置', { time: fmtTime(w.resetsAt) })}</div>}
    </div>
  );
}

/** Header meter for a chat on a 本地 Claude Code model: the 5-hour and weekly
    windows at a glance, the rest a click away. */
export function PlanUsageMeter() {
  const { usage, previous, error, loading, receivedAt, load } = usePlanUsage();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    usePlanUsage.setState((s) => ({ watchers: s.watchers + 1 }));
    const s = usePlanUsage.getState();
    if (!s.usage || Date.now() - s.receivedAt > STALE_MS) void s.load();
    return () => usePlanUsage.setState((s) => ({ watchers: s.watchers - 1 }));
  }, []);

  function toggle(next: boolean) {
    setOpen(next);
    if (next && Date.now() - receivedAt > STALE_MS) void load();
  }

  const five = usage?.windows.find((w) => w.key === 'five_hour');
  const week = usage?.windows.find((w) => w.key === 'seven_day');
  const limit = usage?.limit;
  // A verdict from the latest turn, while it still holds.
  const limitNow = limit && limit.status !== 'allowed' && (!limit.resetsAt || limit.resetsAt > Date.now()) ? limit : null;
  const worst = Math.max(five?.utilization ?? 0, week?.utilization ?? 0);
  const tone = limitNow?.status === 'rejected' ? 'text-err' : usage?.available ? textTone(worst) : 'text-tx3';

  const trigger = (
    <button
      type="button"
      title={t('Claude 订阅用量')}
      className={`flex items-center gap-1.5 rounded-md border border-line bg-bg2 px-2 py-1 text-xs tabular-nums transition-colors hover:border-line2 ${tone}`}
    >
      {loading && !usage ? <Spinner className="h-3 w-3" /> : <Gauge size={13} />}
      {usage?.available ? (
        <>
          <span>5h {pct(five?.utilization)}</span>
          <span className="hidden sm:inline">· {t('周')} {pct(week?.utilization)}</span>
        </>
      ) : (
        <span>{t('用量')}</span>
      )}
    </button>
  );

  const problem = error ?? usage?.error ?? null;
  return (
    <Popover trigger={trigger} open={open} setOpen={toggle} align="right" width="w-80">
      <div className="space-y-3.5 p-4 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-tx">{t('Claude 订阅用量')}</span>
          {usage?.plan && <Badge>{planName(usage.plan)}</Badge>}
          <button
            type="button"
            title={t('刷新')}
            className="ml-auto rounded p-1 text-tx3 transition-colors hover:bg-bg2 hover:text-tx"
            onClick={() => void load(true)}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {limitNow && (
          <p className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${limitNow.status === 'rejected'
            ? 'border-err/30 bg-err/10 text-err' : 'border-warn/30 bg-warn/10 text-warn'}`}>
            {limitNow.status === 'rejected'
              ? (limitNow.resetsAt
                ? t('已达到用量上限,{time} 恢复', { time: fmtTime(limitNow.resetsAt) })
                : t('已达到用量上限'))
              : t('快到用量上限了')}
          </p>
        )}

        {!usage ? (
          problem
            ? <p className="text-xs leading-relaxed text-err">{tServer(problem)}</p>
            : <p className="flex items-center gap-2 text-xs text-tx3"><Spinner className="h-3 w-3" />{t('正在读取…')}</p>
        ) : !usage.available ? (
          <p className="text-xs leading-relaxed text-tx2">{t('Claude Code 登录的不是 claude.ai 订阅(例如用的是 API Key),没有订阅额度可看。')}</p>
        ) : (
          <>
            <div className="space-y-3">
              {usage.windows.map((w) => <WindowRow key={`${w.key}:${w.label ?? ''}`} w={w} previous={previous} />)}
            </div>
            {usage.extra?.enabled && (
              <div className="flex items-baseline text-xs">
                <span className="text-tx2">{t('额外用量')}</span>
                <span className="ml-auto tabular-nums text-tx2">{pct(usage.extra.utilization)}</span>
              </div>
            )}
            {usage.sources && (
              <div className="text-xs leading-relaxed">
                <div className="text-tx3">{t('本周用量来自(本面板算在 Claude Code 里)')}</div>
                <div className="mt-0.5 text-tx2">
                  {usage.sources.map((s) => `${sourceLabel(s)} ${pct(s.percent)}`).join(t('、'))}
                </div>
              </div>
            )}
          </>
        )}

        <p className="border-t border-line pt-2.5 text-[11px] leading-relaxed text-tx3">
          {t('与 claude.ai、手机 App 和其他 Claude Code 共用同一份额度。')}
          {usage && <span className="block">{t('更新于 {time}', { time: fmtTime(usage.fetchedAt) })}</span>}
          {usage && problem && <span className="block text-err">{tServer(problem)}</span>}
        </p>
      </div>
    </Popover>
  );
}
