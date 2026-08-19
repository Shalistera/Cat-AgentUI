import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, ListOrdered } from 'lucide-react';
import { api, errMsg } from '../../api';
import { Badge, Button, EmptyState, Spinner, toast } from '../../components/ui';
import { ProviderAvatar } from '../../components/ModelAvatar';
import type { AdminProvider } from '../../types';
import { TYPE_LABELS } from './provider-common';

/**
 * Ordering works on the full row set but only shows what users can actually
 * see: enabled models of enabled providers. Moving a visible item swaps it
 * with its visible neighbour in the full list, so hidden (disabled) rows keep
 * their positions and nothing is renumbered behind the admin's back.
 */
function swapVisible<T>(list: T[], visible: T[], visIndex: number, dir: -1 | 1): T[] | null {
  const a = visible[visIndex];
  const b = visible[visIndex + dir];
  if (!a || !b) return null;
  const i = list.indexOf(a);
  const j = list.indexOf(b);
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export default function ModelOrder() {
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<AdminProvider[] | { providers?: AdminProvider[] }>('/api/admin/providers');
      setProviders(Array.isArray(r) ? r : r.providers ?? []);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visibleProviders = providers.filter((p) => p.enabled && (p.models ?? []).some((m) => m.enabled));

  async function moveProvider(visIndex: number, dir: -1 | 1) {
    if (busy) return;
    const next = swapVisible(providers, visibleProviders, visIndex, dir);
    if (!next) return;
    setProviders(next); // optimistic — the arrows would feel broken with a round-trip lag
    setBusy(true);
    try {
      await api.put('/api/admin/providers/order', { ids: next.map((p) => p.id) });
    } catch (e) {
      toast(errMsg(e), 'err');
      await load();
    } finally { setBusy(false); }
  }

  async function moveModel(provider: AdminProvider, visIndex: number, dir: -1 | 1) {
    if (busy) return;
    const all = provider.models ?? [];
    const visible = all.filter((m) => m.enabled);
    const next = swapVisible(all, visible, visIndex, dir);
    if (!next) return;
    setProviders(providers.map((p) => (p.id === provider.id ? { ...p, models: next } : p)));
    setBusy(true);
    try {
      await api.put(`/api/admin/providers/${provider.id}/models/order`, { ids: next.map((m) => m.id) });
    } catch (e) {
      toast(errMsg(e), 'err');
      await load();
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="min-w-0">
        <h1 className="text-base font-semibold tracking-tight text-tx">模型排序</h1>
        <p className="mt-0.5 text-xs leading-relaxed text-tx3">
          调整模型选择器中的显示顺序:列表先按服务商分组,组内按下面的顺序排列。只列出已启用的服务商与模型,改动立即对所有用户生效。
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
      ) : visibleProviders.length === 0 ? (
        <div className="rounded-xl border border-line bg-bg1 shadow-xs">
          <EmptyState
            icon={<ListOrdered size={22} />}
            title="还没有已启用的模型"
            hint="先到「模型服务」启用服务商和模型,再回到这里调整顺序。"
            action={(
              <Link to="/admin/providers">
                <Button variant="primary" size="sm">前往模型服务</Button>
              </Link>
            )}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {visibleProviders.map((p, pi) => {
            const models = (p.models ?? []).filter((m) => m.enabled);
            const hiddenCount = (p.models ?? []).length - models.length;
            return (
              <div key={p.id} className="overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
                <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
                  <div className="flex shrink-0">
                    <Button variant="ghost" size="iconXs" title="服务商上移(整组前移)"
                      disabled={busy || pi === 0} onClick={() => moveProvider(pi, -1)}>
                      <ChevronUp size={14} />
                    </Button>
                    <Button variant="ghost" size="iconXs" title="服务商下移"
                      disabled={busy || pi === visibleProviders.length - 1} onClick={() => moveProvider(pi, 1)}>
                      <ChevronDown size={14} />
                    </Button>
                  </div>
                  <ProviderAvatar name={p.name} type={p.type} baseUrl={p.baseUrl}
                    avatarUrl={p.avatarUrl} size={24} />
                  <span className="text-[13px] font-semibold text-tx">{p.name}</span>
                  <Badge>{TYPE_LABELS[p.type]}</Badge>
                  <span className="ml-auto text-[11px] tabular-nums text-tx3">
                    {models.length} 个模型{hiddenCount > 0 ? ` · ${hiddenCount} 个未启用不参与排序` : ''}
                  </span>
                </div>
                <div className="divide-y divide-line">
                  {models.map((m, mi) => (
                    <div key={m.id} className="flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-bg2/60">
                      <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-tx3">{mi + 1}</span>
                      <div className="min-w-0 flex-1">
                        <span className="text-xs text-tx">{m.displayName || m.modelId}</span>
                        {m.displayName && (
                          <span className="ml-2 truncate font-mono text-[11px] text-tx3">{m.modelId}</span>
                        )}
                      </div>
                      <div className="flex shrink-0">
                        <Button variant="ghost" size="iconXs" title="上移"
                          disabled={busy || mi === 0} onClick={() => moveModel(p, mi, -1)}>
                          <ChevronUp size={13} />
                        </Button>
                        <Button variant="ghost" size="iconXs" title="下移"
                          disabled={busy || mi === models.length - 1} onClick={() => moveModel(p, mi, 1)}>
                          <ChevronDown size={13} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
