import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListOrdered } from 'lucide-react';
import { api, errMsg } from '../../api';
import { Badge, Button, EmptyState, Spinner, toast, Toggle } from '../../components/ui';
import { ProviderAvatar } from '../../components/ModelAvatar';
import { SortableList } from '../../components/SortableList';

// Flat row from GET /api/admin/models — ordering ignores providers entirely,
// so gpt / gemini / claude rows can interleave however the admin drags them.
interface OrderModel {
  id: string; modelId: string; displayName: string;
  enabled: boolean; imageGen: boolean;
  providerId: string; providerName: string; providerType: string;
  providerBaseUrl: string | null; providerEnabled: boolean;
  avatarUrl: string | null;
  providerAvatarUrl: string | null;
}

/** Permute the members of `subset` inside `full` without moving anything
    else — hidden (disabled) rows keep their global positions. */
function applySubsetOrder(full: OrderModel[], subset: OrderModel[]): OrderModel[] {
  const ids = new Set(subset.map((m) => m.id));
  let k = 0;
  return full.map((m) => (ids.has(m.id) ? subset[k++] : m));
}

export default function ModelOrder() {
  const [rows, setRows] = useState<OrderModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<OrderModel[]>('/api/admin/models');
      setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hiddenCount = rows.filter((m) => !(m.enabled && m.providerEnabled)).length;
  const visible = showHidden ? rows : rows.filter((m) => m.enabled && m.providerEnabled);

  async function reorder(subset: OrderModel[]) {
    if (busy) return;
    const next = applySubsetOrder(rows, subset);
    setRows(next); // optimistic — a drop that snaps back would feel broken
    setBusy(true);
    try {
      await api.put('/api/admin/models/order', { ids: next.map((m) => m.id) });
    } catch (e) {
      toast(errMsg(e), 'err');
      await load();
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div className="min-w-0">
        <h1 className="text-base font-semibold tracking-tight text-tx">模型排序</h1>
        <p className="mt-0.5 text-xs leading-relaxed text-tx3">
          拖动调整模型选择器中的默认显示顺序,不区分服务商,改动立即对所有用户生效。
          用户可以在模型选择器里拖出自己的顺序;自己排过序的用户以其个人顺序为准。
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-bg1 shadow-xs">
          <EmptyState
            icon={<ListOrdered size={22} />}
            title="还没有模型"
            hint="先到「模型服务」添加服务商和模型,再回到这里调整顺序。"
            action={(
              <Link to="/admin/providers">
                <Button variant="primary" size="sm">前往模型服务</Button>
              </Link>
            )}
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <span className="text-[13px] font-semibold text-tx">全部模型</span>
            <span className="text-[11px] tabular-nums text-tx3">{visible.length} 个</span>
            {hiddenCount > 0 && (
              <label className="ml-auto flex cursor-pointer items-center gap-2 text-[11px] text-tx3">
                显示未启用({hiddenCount})
                <Toggle checked={showHidden} onChange={setShowHidden} />
              </label>
            )}
          </div>
          <SortableList
            items={visible}
            keyOf={(m) => m.id}
            onReorder={reorder}
            disabled={busy}
            className="divide-y divide-line"
            renderItem={(m, handle, dragging, index) => {
              const off = !(m.enabled && m.providerEnabled);
              return (
                <div className={`flex items-center gap-2.5 px-3 py-2 transition-colors ${
                  dragging ? '' : 'hover:bg-bg2/60'
                } ${off ? 'opacity-55' : ''}`}>
                  {handle}
                  <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-tx3">
                    {index + 1}
                  </span>
                  <ProviderAvatar name={m.providerName} type={m.providerType}
                    baseUrl={m.providerBaseUrl} avatarUrl={m.avatarUrl ?? m.providerAvatarUrl} size={22} />
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-tx">{m.displayName}</span>
                    <span className="ml-2 truncate font-mono text-[11px] text-tx3 max-sm:hidden">{m.modelId}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-tx3">{m.providerName}</span>
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {m.imageGen && <Badge>绘图</Badge>}
                    {off && <Badge>未启用</Badge>}
                  </span>
                </div>
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
