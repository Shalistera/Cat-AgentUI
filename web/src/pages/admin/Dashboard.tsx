import { useEffect, useState } from 'react';
import { api, fmtTokens } from '../../api';
import { Spinner, Card, Stat, SegmentedControl, Td, Th, toast } from '../../components/ui';
import { TokensBarChart } from '../../components/TokensBarChart';
import type { AdminUsage } from '../../types';

const DAY_OPTIONS = [7, 30, 90] as const;

const KIND_LABELS: Record<string, string> = {
  chat: '对话',
  image: '绘图',
  title: '标题生成',
};

/** One empty-table placeholder, one voice — every card says it the same way. */
function TableEmpty() {
  return <p className="py-6 text-center text-xs text-tx3">暂无数据</p>;
}

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
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }

  const { totals, byDay, byUser, byModel, byKind } = usage;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      {/* filter row above everything it scopes */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-tx">用量总览</h1>
          <p className="mt-0.5 text-xs text-tx3">统计范围内的 Token 消耗、请求与账号活跃度</p>
        </div>
        <SegmentedControl<number>
          value={days}
          onChange={setDays}
          options={DAY_OPTIONS.map((d) => ({ value: d as number, label: `${d} 天` }))}
        />
      </div>

      {/* hold previous render at reduced opacity while refetching */}
      <div className={`space-y-5 transition-opacity ${busy ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="总 Tokens" value={fmtTokens(totals.totalTokens)} />
          <Stat label="请求次数" value={totals.requests.toLocaleString()} />
          <Stat label="生成图片" value={totals.images.toLocaleString()} />
          <Stat label="活跃用户" value={(totals.activeUsers ?? 0).toLocaleString()} />
        </div>

        <Card title="每日用量" desc={`最近 ${days} 天,按日聚合`}>
          <TokensBarChart byDay={byDay} days={days} />
        </Card>

        <Card title="用户用量排行">
          {byUser.length === 0 ? (
            <TableEmpty />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <Th>用户</Th>
                    <Th className="text-right">Tokens</Th>
                    <Th className="text-right">请求</Th>
                    <Th className="text-right">图片</Th>
                  </tr>
                </thead>
                <tbody>
                  {byUser.map((u) => (
                    <tr key={u.userId} className="group transition-colors hover:bg-bg2/60">
                      <Td className="font-medium text-tx">{u.username}</Td>
                      <Td className="text-right tabular-nums">{fmtTokens(u.totalTokens)}</Td>
                      <Td className="text-right tabular-nums">{u.requests.toLocaleString()}</Td>
                      <Td className="text-right tabular-nums">{u.images.toLocaleString()}</Td>
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
              <TableEmpty />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <Th>模型</Th>
                    <Th className="text-right">Tokens</Th>
                    <Th className="text-right">次数</Th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={m.model} className="group transition-colors hover:bg-bg2/60">
                      <Td>
                        <div className="max-w-[200px] truncate font-mono text-tx" title={m.model}>{m.model}</div>
                      </Td>
                      <Td className="text-right tabular-nums">{fmtTokens(m.totalTokens)}</Td>
                      <Td className="text-right tabular-nums">{m.requests.toLocaleString()}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="类型分布">
            {byKind.length === 0 ? (
              <TableEmpty />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <Th>类型</Th>
                    <Th className="text-right">Tokens</Th>
                    <Th className="text-right">次数</Th>
                    <Th className="text-right">图片</Th>
                  </tr>
                </thead>
                <tbody>
                  {byKind.map((k) => (
                    <tr key={k.kind} className="group transition-colors hover:bg-bg2/60">
                      <Td className="text-tx">{KIND_LABELS[k.kind] ?? k.kind}</Td>
                      <Td className="text-right tabular-nums">{fmtTokens(k.totalTokens)}</Td>
                      <Td className="text-right tabular-nums">{k.requests.toLocaleString()}</Td>
                      <Td className="text-right tabular-nums">{k.images.toLocaleString()}</Td>
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
