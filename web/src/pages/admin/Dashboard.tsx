import { useEffect, useState } from 'react';
import { api, fmtTokens } from '../../api';
import { Spinner, toast } from '../../components/ui';
import type { AdminUsage, UsageByDay } from '../../types';

const DAY_OPTIONS = [7, 30, 90] as const;

const KIND_LABELS: Record<string, string> = {
  chat: '对话',
  image: '绘图',
  title: '标题生成',
};

/** Last n calendar days (local time, today inclusive) as YYYY-MM-DD keys. */
function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/** Round a maximum up to a clean axis number (1/2/2.5/5 × 10^k). */
function niceCeil(v: number): number {
  if (v <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 2, 2.5, 5, 10]) {
    if (s * pow >= v) return s * pow;
  }
  return 10 * pow;
}

function DailyChart({ byDay, days }: { byDay: UsageByDay[]; days: number }) {
  const map = new Map(byDay.map((d) => [d.day, d]));
  const series = lastDays(days).map((day) => {
    const d = map.get(day);
    return { day, totalTokens: d?.totalTokens ?? 0, requests: d?.requests ?? 0 };
  });

  // viewBox geometry — responsive via w-full
  const W = 800; const H = 200;
  const padL = 44; const padR = 8; const padT = 10; const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = niceCeil(Math.max(...series.map((d) => d.totalTokens)));
  const slot = plotW / series.length;
  const barW = Math.max(1.5, Math.min(24, slot - 2)); // thin marks, ≥2px surface gap
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelStep = Math.max(1, Math.round(days / 6)); // sparse x labels

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="每日 Token 用量柱状图">
      {/* recessive hairline gridlines + clean y ticks */}
      {ticks.map((t) => {
        const y = padT + plotH - (t / max) * plotH;
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-line)" strokeWidth="1" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--color-tx3)">
              {fmtTokens(t) === '—' ? '0' : fmtTokens(t)}
            </text>
          </g>
        );
      })}
      {/* baseline */}
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke="var(--color-line)" strokeWidth="1" />

      {series.map((d, i) => {
        const h = (d.totalTokens / max) * plotH;
        const x = padL + i * slot + (slot - barW) / 2;
        const y = padT + plotH - h;
        const r = Math.min(4, barW / 2, h); // rounded data-end, square at baseline
        return (
          <g key={d.day} className="group/bar">
            <title>{`${d.day} · ${d.totalTokens.toLocaleString()} tokens · ${d.requests} 次请求`}</title>
            {/* full-slot invisible hit target */}
            <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
            {h > 0 && (
              <path
                d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`}
                fill="var(--color-acc)"
                className="opacity-85 transition-opacity group-hover/bar:opacity-100"
              />
            )}
            {i % labelStep === 0 && (
              <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--color-tx3)">
                {d.day.slice(5).replace('-', '/')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg1 p-4">
      <div className="text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-tx3">{label}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg1 p-5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const th = 'border-b border-line py-2 text-left font-medium text-tx3';
const td = 'py-2';

export default function Dashboard() {
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<AdminUsage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api.get<AdminUsage>(`/api/admin/usage?days=${days}`)
      .then((r) => { if (alive) setUsage(r); })
      .catch((e) => toast(e instanceof Error ? e.message : '加载用量数据失败', 'err'))
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [days]);

  if (!usage) {
    return <div className="flex justify-center py-24"><Spinner className="h-6 w-6" /></div>;
  }

  const { totals, byDay, byUser, byModel, byKind } = usage;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      {/* filter row above everything it scopes */}
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">用量总览</h1>
        <div className="flex gap-1 rounded-lg border border-line bg-bg2 p-0.5">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors ${
                days === d ? 'bg-acc font-medium text-accfg' : 'text-tx2 hover:text-tx'
              }`}
            >
              {d} 天
            </button>
          ))}
        </div>
      </div>

      {/* hold previous render at reduced opacity while refetching */}
      <div className={`space-y-5 transition-opacity ${busy ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="总 Tokens" value={fmtTokens(totals.totalTokens)} />
          <StatTile label="请求次数" value={totals.requests.toLocaleString()} />
          <StatTile label="生成图片" value={totals.images.toLocaleString()} />
          <StatTile label="活跃用户" value={(totals.activeUsers ?? 0).toLocaleString()} />
        </div>

        <Card title="每日用量">
          <DailyChart byDay={byDay} days={days} />
        </Card>

        <Card title="用户用量排行">
          {byUser.length === 0 ? (
            <p className="py-6 text-center text-xs text-tx3">暂无数据</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={th}>用户</th>
                    <th className={th}>Tokens</th>
                    <th className={th}>请求</th>
                    <th className={th}>图片</th>
                  </tr>
                </thead>
                <tbody>
                  {byUser.map((u, i) => (
                    <tr key={u.userId} className={`border-b border-line/60 last:border-0 ${i === 0 ? 'bg-acc/5' : ''}`}>
                      <td className={`${td} font-medium`}>{u.username}</td>
                      <td className={`${td} tabular-nums`}>{fmtTokens(u.totalTokens)}</td>
                      <td className={`${td} tabular-nums`}>{u.requests.toLocaleString()}</td>
                      <td className={`${td} tabular-nums`}>{u.images.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="模型分布">
            {byModel.length === 0 ? (
              <p className="py-6 text-center text-xs text-tx3">暂无数据</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={th}>模型</th>
                    <th className={th}>Tokens</th>
                    <th className={th}>次数</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={m.model} className="border-b border-line/60 last:border-0">
                      <td className={td}>
                        <div className="max-w-[200px] truncate" title={m.model}>{m.model}</div>
                      </td>
                      <td className={`${td} tabular-nums`}>{fmtTokens(m.totalTokens)}</td>
                      <td className={`${td} tabular-nums`}>{m.requests.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="类型分布">
            {byKind.length === 0 ? (
              <p className="py-6 text-center text-xs text-tx3">暂无数据</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={th}>类型</th>
                    <th className={th}>Tokens</th>
                    <th className={th}>次数</th>
                    <th className={th}>图片</th>
                  </tr>
                </thead>
                <tbody>
                  {byKind.map((k) => (
                    <tr key={k.kind} className="border-b border-line/60 last:border-0">
                      <td className={td}>{KIND_LABELS[k.kind] ?? k.kind}</td>
                      <td className={`${td} tabular-nums`}>{fmtTokens(k.totalTokens)}</td>
                      <td className={`${td} tabular-nums`}>{k.requests.toLocaleString()}</td>
                      <td className={`${td} tabular-nums`}>{k.images.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
