import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, errMsg, fmtDate, fmtTokens } from '../../api';
import { Badge, Button, Card, EmptyState, SegmentedControl, Spinner, Stat, toast } from '../../components/ui';
import { TokensBarChart } from '../../components/TokensBarChart';
import type { AdminUser, AdminUserUsage } from '../../types';

/* Per-user usage drill-down. Everything here is a GROUP BY over the existing
   usage_log rows (indexed on userId+day) — no extra bookkeeping is written to
   support this page. */

const DAY_OPTIONS = [7, 30, 90] as const;

const KIND_LABELS: Record<string, string> = {
  chat: '对话',
  image: '绘图',
  title: '标题生成',
  followup: '快速追问',
  ppt: 'PPT 工坊',
};

/**
 * A single-measure distribution: label + accent bar + value per row. Bars are
 * normalized to the largest row (widths stay proportional to tokens); the
 * percentage reads against the window total. One hue on purpose — identity
 * lives in the row label, not in color.
 */
function DistRows({ rows, total }: {
  rows: { key: string; label: string; mono?: boolean; tokens: number; detail: string }[];
  total: number;
}) {
  if (!rows.length) return <p className="py-6 text-center text-xs text-tx3">暂无数据</p>;
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const share = total > 0 ? (r.tokens / total) * 100 : 0;
        return (
          <div key={r.key} className="group/dist" title={`${r.label} · ${r.tokens.toLocaleString()} tokens · ${r.detail}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className={`min-w-0 truncate text-tx ${r.mono ? 'font-mono' : ''}`}>{r.label}</span>
              <span className="shrink-0 tabular-nums text-tx2">
                {fmtTokens(r.tokens)}
                <span className="ml-1.5 text-tx3">{share >= 0.1 ? `${share.toFixed(share >= 10 ? 0 : 1)}%` : '<0.1%'}</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg2">
              <div
                className="h-full rounded-full bg-acc opacity-85 transition-opacity group-hover/dist:opacity-100"
                style={{ width: `${Math.max((r.tokens / max) * 100, r.tokens > 0 ? 1 : 0)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function quotaLabel(u: AdminUser): string {
  if (u.role === 'admin') return '豁免';
  if (u.monthlyTokenQuota === null) return '默认';
  if (u.monthlyTokenQuota === 0) return '不限';
  return fmtTokens(u.monthlyTokenQuota);
}

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<AdminUserUsage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<AdminUser[]>('/api/admin/users')
      .then((list) => setUser(list.find((u) => u.id === id) ?? null))
      .catch((e) => toast(errMsg(e), 'err'))
      .finally(() => setUserLoaded(true));
  }, [id]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api.get<AdminUserUsage>(`/api/admin/usage/user/${id}?days=${days}`)
      .then((r) => { if (alive) setUsage(r); })
      .catch((e) => toast(errMsg(e), 'err'))
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [id, days]);

  if (!userLoaded || !usage) {
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }
  if (!user) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <EmptyState
          title="用户不存在"
          hint="该账号可能已被删除。"
          action={<Link to="/admin/users"><Button variant="outline" size="sm">返回用户列表</Button></Link>}
        />
      </div>
    );
  }

  const { totals, byDay, byModel, byKind } = usage;
  const activeDays = byDay.filter((d) => d.requests > 0).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="space-y-3">
        <Link to="/admin/users"
          className="inline-flex items-center gap-1 text-xs text-tx3 transition-colors hover:text-tx">
          <ArrowLeft size={13} />返回用户列表
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight text-tx">
                {user.displayName || user.username}
              </h1>
              {user.displayName && <span className="text-xs text-tx3">@{user.username}</span>}
              <Badge tone={user.role === 'admin' ? 'acc' : 'default'}>{user.role === 'admin' ? '管理员' : '用户'}</Badge>
              <Badge tone={user.disabled ? 'err' : 'ok'}>{user.disabled ? '已停用' : '正常'}</Badge>
            </div>
            <p className="mt-1 text-xs text-tx3">
              注册于 {fmtDate(user.createdAt)}
              {user.lastActiveAt ? ` · 最近活跃 ${fmtDate(user.lastActiveAt)}` : ''}
              {` · 本月 ${fmtTokens(user.usage.monthTokens)} / 配额 ${quotaLabel(user)}`}
            </p>
          </div>
          <SegmentedControl<number>
            value={days}
            onChange={setDays}
            options={DAY_OPTIONS.map((d) => ({ value: d as number, label: `${d} 天` }))}
          />
        </div>
      </div>

      {/* hold previous render at reduced opacity while refetching */}
      <div className={`space-y-5 transition-opacity ${busy ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="总 Tokens" value={fmtTokens(totals.totalTokens)}
            hint={`输入 ${fmtTokens(totals.promptTokens)} · 输出 ${fmtTokens(totals.completionTokens)}`} />
          <Stat label="请求次数" value={totals.requests.toLocaleString()} />
          <Stat label="生成图片" value={totals.images.toLocaleString()} />
          <Stat label="活跃天数" value={`${activeDays} / ${days}`} />
        </div>

        <Card title="每日用量" desc={`最近 ${days} 天,按日聚合`}>
          <TokensBarChart byDay={byDay} days={days} />
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="模型分布" desc="该用户在统计范围内用过的模型,按 tokens 排序">
            <DistRows
              total={totals.totalTokens}
              rows={byModel.map((m) => ({
                key: m.model,
                label: m.model,
                mono: true,
                tokens: m.totalTokens,
                detail: `${m.requests.toLocaleString()} 次请求`,
              }))}
            />
          </Card>

          <Card title="用途分布" desc="对话、绘图与后台生成各占多少">
            <DistRows
              total={totals.totalTokens}
              rows={byKind.map((k) => ({
                key: k.kind,
                label: KIND_LABELS[k.kind] ?? k.kind,
                tokens: k.totalTokens,
                detail: `${k.requests.toLocaleString()} 次请求${k.images ? ` · ${k.images.toLocaleString()} 张图` : ''}`,
              }))}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
