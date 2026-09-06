import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Server, SlidersHorizontal, Star, Users } from 'lucide-react';
import { api, errMsg, fmtTokens } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, Select,
  Spinner, Td, Th, Toggle, btnClass, toast,
} from '../../components/ui';
import { ProviderAvatar } from '../../components/ModelAvatar';
import type { AdminModel, AdminProvider, AdminUser, ModelAccessMode } from '../../types';
import { TYPE_LABELS } from './provider-common';

// ---------- model visibility ----------
/**
 * Mirrors the MCP servers' access control: shared models are visible to every
 * account, restricted ones only to the ticked ordinary users (admins always
 * see everything). Enforced across chat, 绘图 and PPT.
 */
function AccessModal({ model, reload, onClose }: {
  model: AdminModel; reload(): Promise<void>; onClose(): void;
}) {
  const [mode, setMode] = useState<ModelAccessMode>(model.accessMode);
  const [allowed, setAllowed] = useState<string[]>(model.allowedUserIds);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<AdminUser[]>('/api/admin/users')
      .then((r) => setUsers(r.filter((u) => u.role === 'user')))
      .catch((e) => toast(errMsg(e), 'err'));
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, { accessMode: mode, allowedUserIds: allowed });
      await reload();
      toast('已更新模型可见性', 'ok');
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="模型可见性" desc={model.modelId}>
      <div className="space-y-4">
        <Field label="访问范围" hint="贵模型建议仅指定用户,与配额同属成本治理">
          <Select value={mode} onChange={(e) => setMode(e.target.value as ModelAccessMode)}>
            <option value="shared">所有登录用户</option>
            <option value="restricted">仅指定普通用户</option>
          </Select>
        </Field>

        {mode === 'restricted' && (
          <Field label="指定普通用户" hint="管理员始终可用;未勾选的用户在模型列表里看不到它">
            {!users ? (
              <div className="flex justify-center py-4 text-tx3"><Spinner className="h-4 w-4" /></div>
            ) : (
              <div className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg0">
                {users.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-tx3">暂无普通用户</div>
                ) : users.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-tx">{u.displayName || u.username}</div>
                      {u.displayName && <div className="truncate text-[11px] text-tx3">@{u.username}</div>}
                    </div>
                    {u.disabled && <Badge tone="err">已停用</Badge>}
                    <Toggle
                      checked={allowed.includes(u.id)}
                      onChange={(checked) => setAllowed(checked
                        ? [...allowed, u.id]
                        : allowed.filter((id) => id !== u.id))}
                    />
                  </div>
                ))}
              </div>
            )}
          </Field>
        )}

        <ModalActions>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy && <Spinner className="h-3.5 w-3.5" />}保存
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

function AccessCell({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const restricted = model.accessMode === 'restricted';

  return (
    <>
      <button
        type="button"
        title="设置模型可见性"
        onClick={() => setOpen(true)}
        className="flex cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-bg3"
      >
        <Badge tone={restricted ? 'acc' : 'default'}>
          {restricted ? <><Users size={10} />指定 {model.allowedUserIds.length}</> : '全员'}
        </Badge>
        <Pencil size={11} className="shrink-0 text-tx3" />
      </button>
      {open && <AccessModal model={model} reload={reload} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "每日每人 10 次 · 50.0k tokens" for the list; null when the model is unlimited. */
function limitLabel(m: AdminModel): string | null {
  if (!m.limitRequests && !m.limitTokens) return null;
  const parts: string[] = [];
  if (m.limitRequests) parts.push(`${m.limitRequests} 次`);
  if (m.limitTokens) parts.push(`${fmtTokens(m.limitTokens)} tokens`);
  return `${m.limitPeriod === 'week' ? '每周' : '每日'}每人 ${parts.join(' · ')}`;
}

// ---------- capability row ----------
function ModelRow({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, okMsg = '已更新') {
    if (busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, body);
      await reload();
      toast(okMsg, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <tr className={`group transition-colors hover:bg-bg2/60 ${model.enabled ? '' : 'opacity-55'}`}>
      <Td className="max-w-[260px]">
        <Link to={`/admin/models/${model.id}`} title="打开详细设置" className="group/name block">
          <div className="truncate font-mono text-tx group-hover/name:underline">{model.modelId}</div>
          {model.displayName && <div className="truncate text-[11px] text-tx3">{model.displayName}</div>}
          {limitLabel(model) && (
            <div className="mt-0.5 truncate text-[11px] tabular-nums text-warn" title="使用限制(在详细设置中修改)">
              限 {limitLabel(model)}
            </div>
          )}
        </Link>
      </Td>
      <Td className="text-center"><Toggle checked={model.vision} disabled={busy} onChange={(v) => patch({ vision: v })} /></Td>
      <Td className="text-center"><Toggle checked={model.tools} disabled={busy} onChange={(v) => patch({ tools: v })} /></Td>
      <Td className="text-center"><Toggle checked={model.imageGen} disabled={busy} onChange={(v) => patch({ imageGen: v })} /></Td>
      <Td className="text-center">
        <Toggle
          checked={model.defaultWebSearch} disabled={busy || model.imageGen}
          onChange={(v) => patch({ defaultWebSearch: v }, v ? '新对话将默认开启联网搜索' : '已关闭默认联网')}
        />
      </Td>
      <Td><AccessCell model={model} reload={reload} /></Td>
      <Td className="text-center">
        <Button variant="ghost" size="iconXs"
          title={model.isDefault ? '当前默认模型' : '设为默认'} disabled={busy || model.isDefault}
          onClick={() => patch({ isDefault: true }, '已设为默认')}>
          <Star size={14} className={model.isDefault ? 'text-acc' : ''} fill={model.isDefault ? 'currentColor' : 'none'} />
        </Button>
      </Td>
      <Td className="text-center">
        {model.enabled
          ? <Badge tone="ok">启用中</Badge>
          : <Badge>已停用</Badge>}
      </Td>
      <Td className="text-center">
        <Link to={`/admin/models/${model.id}`} title="详细设置:描述、单价、使用限制、推理档位"
          className={btnClass('ghost', 'iconXs')}>
          <SlidersHorizontal size={14} />
        </Link>
      </Td>
    </tr>
  );
}

// ---------- page ----------
export default function Models() {
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [onlyEnabled, setOnlyEnabled] = useState(false);

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

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .filter((p) => providerFilter === 'all' || p.id === providerFilter)
      .map((p) => ({
        provider: p,
        models: (p.models ?? []).filter((m) =>
          (!onlyEnabled || m.enabled)
          && (!q || m.modelId.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q))),
      }))
      .filter((s) => s.models.length > 0);
  }, [providers, query, providerFilter, onlyEnabled]);

  const totalModels = providers.reduce((n, p) => n + (p.models?.length ?? 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="min-w-0">
        <h1 className="text-base font-semibold tracking-tight text-tx">模型设置</h1>
        <p className="mt-0.5 text-xs leading-relaxed text-tx3">
          配置每个模型的能力、默认联网、可见性与默认模型;点击模型名或行尾按钮进入详细设置(模型描述、单价、使用限制、推理档位)。添加模型和启用开关在
          <Link to="/admin/providers" className="mx-0.5 text-acc hover:underline">模型服务</Link>
          栏目。
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
      ) : totalModels === 0 ? (
        <div className="rounded-xl border border-line bg-bg1 shadow-xs">
          <EmptyState
            icon={<Server size={22} />}
            title="还没有任何模型"
            hint="先到「模型服务」接入提供商并添加模型,再回到这里配置能力。"
            action={(
              <Link to="/admin/providers">
                <Button variant="primary" size="sm">前往模型服务</Button>
              </Link>
            )}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-56">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型 ID / 显示名…" uiSize="sm" />
            </div>
            <Select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="w-auto text-xs">
              <option value="all">全部服务商</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-tx2">
              <Toggle checked={onlyEnabled} onChange={setOnlyEnabled} />
              仅显示已启用
            </label>
          </div>

          {sections.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line2 px-3 py-8 text-center text-xs text-tx3">
              没有匹配的模型
            </p>
          ) : sections.map(({ provider, models }) => (
            <div key={provider.id} className="overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
              <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
                <ProviderAvatar name={provider.name} type={provider.type} baseUrl={provider.baseUrl}
                  avatarUrl={provider.avatarUrl} size={24} />
                <span className="text-[13px] font-semibold text-tx">{provider.name}</span>
                <Badge>{TYPE_LABELS[provider.type]}</Badge>
                {!provider.enabled && <Badge tone="err">服务商已禁用</Badge>}
                <span className="ml-auto text-[11px] tabular-nums text-tx3">{models.length} 个模型</span>
              </div>
              <div className="overflow-x-auto px-4 py-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <Th>模型</Th>
                      <Th className="text-center">视觉</Th>
                      <Th className="text-center">工具</Th>
                      <Th className="text-center">绘图</Th>
                      <Th className="text-center" title="新对话默认开启联网搜索(需要该模型可用搜索)">默认联网</Th>
                      <Th>可见性</Th>
                      <Th className="text-center">默认</Th>
                      <Th className="text-center">状态</Th>
                      <Th className="text-center" title="模型描述、单价、使用限制、推理档位等详细配置">详情</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => <ModelRow key={m.id} model={m} reload={load} />)}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
