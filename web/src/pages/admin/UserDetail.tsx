import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Archive, ChevronRight, FolderOpen, MessageSquare, Pin, Search } from 'lucide-react';
import { api, errMsg, fmtCost, fmtDate, fmtModelName, fmtTokens } from '../../api';
import {
  Badge, Button, Card, EmptyState, Input, SegmentedControl, Spinner, Stat, toast,
} from '../../components/ui';
import { TokensBarChart } from '../../components/TokensBarChart';
import { t } from '../../i18n';
import type { AdminChatList, AdminChatSummary, AdminUser, AdminUserUsage } from '../../types';

/* Per-user usage drill-down. Everything here is a GROUP BY over the existing
   usage_log rows (indexed on userId+day) — no extra bookkeeping is written to
   support this page. */

const DAY_OPTIONS = [7, 30, 90] as const;

const KIND_LABELS: Record<string, string> = {
  chat: t('对话'),
  image: t('绘图'),
  image_tool: t('图片生成工具'),
  image_prompt: t('NAI 提示词助手'),
  title: t('标题生成'),
  followup: t('快速追问'),
  ocr: t('OCR 工坊'),
  translate: t('翻译工坊'),
  ppt: t('PPT 工坊'),
  subagent: t('子代理'),
  compaction: t('上下文压缩'),
  web_search: t('联网搜索'),
  web_fetch: t('网页阅读'),
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
  if (!rows.length) return <p className="py-6 text-center text-xs text-tx3">{t('暂无数据')}</p>;
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

// ---------- 对话记录 ----------
const CHAT_PAGE = 50;

/**
 * Read-only oversight of the person's conversations (Open WebUI has the same
 * admin view). Saved chats only, 归档 included; 临时对话 stay private to the
 * person — the server neither lists nor serves them here.
 */
function UserChatsCard({ userId }: { userId: string }) {
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [chats, setChats] = useState<AdminChatSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);

  async function fetchPage(offset: number, q: string): Promise<AdminChatList> {
    const params = new URLSearchParams({ offset: String(offset), limit: String(CHAT_PAGE) });
    if (q) params.set('q', q);
    return api.get<AdminChatList>(`/api/admin/users/${userId}/chats?${params}`);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchPage(0, applied)
      .then((r) => { if (alive) { setChats(r.chats); setTotal(r.total); } })
      .catch((e) => toast(errMsg(e), 'err'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [userId, applied]);

  async function loadMore() {
    if (more) return;
    setMore(true);
    try {
      const r = await fetchPage(chats.length, applied);
      setChats((prev) => [...prev, ...r.chats.filter((c) => !prev.some((p) => p.id === c.id))]);
      setTotal(r.total);
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setMore(false); }
  }

  return (
    <Card
      title={t('对话记录')}
      desc={t('该用户保存的全部对话(含归档;临时对话不在其中),点击以只读方式查看。查看记录会写入服务器日志。')}
      actions={(
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); setApplied(query.trim()); }}>
          <div className="w-44 sm:w-56">
            <Input uiSize="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索标题或消息内容…')} />
          </div>
          <Button type="submit" variant="outline" size="sm" title={t('搜索')}><Search size={13} /></Button>
        </form>
      )}
    >
      {loading ? (
        <div className="flex justify-center py-8 text-tx3"><Spinner className="h-5 w-5" /></div>
      ) : chats.length === 0 ? (
        <p className="py-6 text-center text-xs text-tx3">{applied ? t('没有匹配的对话') : t('该用户还没有任何对话')}</p>
      ) : (
        <div className="-mx-1 divide-y divide-line">
          {chats.map((c) => (
            <Link
              key={c.id}
              to={`/admin/users/${userId}/chats/${c.id}`}
              className="group flex items-center gap-3 rounded-md px-1 py-2.5 transition-colors hover:bg-bg2"
            >
              <MessageSquare size={15} className="shrink-0 text-tx3" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-tx">{c.title.trim() || t('未命名对话')}</span>
                  {c.pinned && <Pin size={11} className="shrink-0 text-tx3" aria-label={t('置顶')} />}
                  {c.archived && <Badge><Archive size={10} />{t('归档')}</Badge>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-tx3">
                  <span className="tabular-nums">{fmtDate(c.updatedAt)}</span>
                  <span className="tabular-nums">{t('{n} 条消息', { n: c.messageCount })}</span>
                  {c.modelName && <span className="font-mono">{c.modelName}</span>}
                  {c.projectName && (
                    <span className="inline-flex items-center gap-0.5"><FolderOpen size={10} />{c.projectName}</span>
                  )}
                </div>
              </div>
              <ChevronRight size={14} className="shrink-0 text-tx3 opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          ))}
          {chats.length < total && (
            <div className="flex items-center justify-between px-1 pt-3 text-xs text-tx3">
              <span className="tabular-nums">{t('已显示 {shown} / {total}', { shown: chats.length, total })}</span>
              <Button variant="outline" size="sm" disabled={more} onClick={loadMore}>
                {more && <Spinner className="h-3.5 w-3.5" />}{t('加载更多')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function quotaLabel(u: AdminUser): string {
  if (u.role === 'admin') return t('豁免');
  if (u.monthlyTokenQuota === null) return t('默认');
  if (u.monthlyTokenQuota === 0) return t('不限');
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
          title={t('用户不存在')}
          hint={t('该账号可能已被删除。')}
          action={<Link to="/admin/users"><Button variant="outline" size="sm">{t('返回用户列表')}</Button></Link>}
        />
      </div>
    );
  }

  const { totals, byDay, byModel, byKind, currency } = usage;
  const activeDays = byDay.filter((d) => d.requests > 0).length;
  const showCost = totals.cost != null;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="space-y-3">
        <Link to="/admin/users"
          className="inline-flex items-center gap-1 text-xs text-tx3 transition-colors hover:text-tx">
          <ArrowLeft size={13} />{t('返回用户列表')}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight text-tx">
                {user.displayName || user.username}
              </h1>
              {user.displayName && <span className="text-xs text-tx3">@{user.username}</span>}
              <Badge tone={user.role === 'admin' ? 'acc' : 'default'}>{user.role === 'admin' ? t('管理员') : t('用户')}</Badge>
              <Badge tone={user.disabled ? 'err' : 'ok'}>{user.disabled ? t('已停用') : t('正常')}</Badge>
            </div>
            <p className="mt-1 text-xs text-tx3">
              {t('注册于 {date}', { date: fmtDate(user.createdAt) })}
              {user.lastActiveAt ? ` · ${t('最近活跃 {date}', { date: fmtDate(user.lastActiveAt) })}` : ''}
              {` · ${t('本月 {used} / 配额 {quota}', {
                used: fmtTokens(user.usage.monthTokens), quota: quotaLabel(user),
              })}`}
            </p>
          </div>
          <SegmentedControl<number>
            value={days}
            onChange={setDays}
            options={DAY_OPTIONS.map((d) => ({ value: d as number, label: t('{n} 天', { n: d }) }))}
          />
        </div>
      </div>

      {/* hold previous render at reduced opacity while refetching */}
      <div className={`space-y-5 transition-opacity ${busy ? 'opacity-60' : ''}`}>
        <div className={`grid grid-cols-2 gap-3 ${showCost ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
          <Stat label={t('总 Tokens')} value={fmtTokens(totals.totalTokens)}
            hint={t('输入 {prompt} · 输出 {completion}', {
              prompt: fmtTokens(totals.promptTokens), completion: fmtTokens(totals.completionTokens),
            })} />
          {showCost && (
            <Stat label={t('折算成本')} value={fmtCost(totals.cost, currency)} hint={t('按各模型当前单价估算')} />
          )}
          <Stat label={t('请求次数')} value={totals.requests.toLocaleString()} />
          <Stat label={t('生成图片数')} value={totals.images.toLocaleString()} />
          <Stat label={t('活跃天数')} value={`${activeDays} / ${days}`} />
        </div>

        <Card title={t('每日用量')} desc={t('最近 {n} 天,按日聚合', { n: days })}>
          <TokensBarChart byDay={byDay} days={days} />
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={t('模型分布')} desc={t('该用户在统计范围内用过的模型,按 tokens 排序')}>
            <DistRows
              total={totals.totalTokens}
              rows={byModel.map((m) => ({
                key: m.model,
                label: fmtModelName(m.model) ?? m.model,
                mono: true,
                tokens: m.totalTokens,
                detail: `${t('{n} 次请求', { n: m.requests.toLocaleString() })}${
                  showCost && m.cost != null ? ` · ${fmtCost(m.cost, currency)}` : ''}`,
              }))}
            />
          </Card>

          <Card title={t('用途分布')} desc={t('对话、绘图与后台生成各占多少')}>
            <DistRows
              total={totals.totalTokens}
              rows={byKind.map((k) => ({
                key: k.kind,
                label: KIND_LABELS[k.kind] ?? k.kind,
                tokens: k.totalTokens,
                detail: `${t('{n} 次请求', { n: k.requests.toLocaleString() })}${
                  k.images ? ` · ${t('{n} 张图', { n: k.images.toLocaleString() })}` : ''}`,
              }))}
            />
          </Card>
        </div>
      </div>

      <UserChatsCard userId={user.id} />
    </div>
  );
}
