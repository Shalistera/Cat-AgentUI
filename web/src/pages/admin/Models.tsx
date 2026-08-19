import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Pencil, Plus, Server, Star, Users, X } from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, SegmentedControl, Select,
  Spinner, Td, Th, Toggle, toast,
} from '../../components/ui';
import { ProviderAvatar } from '../../components/ModelAvatar';
import type { AdminModel, AdminProvider, AdminUser, ModelAccessMode, ReasoningLevel, ReasoningMode } from '../../types';
import { TYPE_LABELS } from './provider-common';

// ---------- reasoning levels ----------
const MODE_LABELS: Record<ReasoningMode, string> = { auto: '默认', custom: '自定义', off: '关闭' };

/**
 * Levels default to the vendor's common tiers, derived from the model id, and
 * reach the user in Chinese. Custom is there for the week a vendor ships a tier
 * we have never heard of — which is why it takes both halves: the name the API
 * expects and the one a person can read.
 */
function ReasoningModal({ model, reload, onClose }: {
  model: AdminModel; reload(): Promise<void>; onClose(): void;
}) {
  const { mode: savedMode, custom, defaults } = model.reasoning;
  const [mode, setMode] = useState<ReasoningMode>(savedMode);
  // Seed the editor with whatever is already in effect, so picking 自定义 is an
  // edit rather than a blank page.
  const [rows, setRows] = useState<ReasoningLevel[]>(() => {
    const seed = custom.length ? custom : defaults;
    return seed.length ? seed : [{ value: '', label: '' }];
  });
  const [busy, setBusy] = useState(false);

  const filled = rows.filter((r) => r.value.trim());
  const setRow = (i: number, patch: Partial<ReasoningLevel>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(i, 1);
    next.splice(i + dir, 0, row);
    setRows(next);
  };

  async function save() {
    if (mode === 'custom' && !filled.length) { toast('请至少填写一个档位', 'err'); return; }
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, {
        reasoningMode: mode,
        // Only send the ladder when it is the one in use — otherwise a stray
        // half-typed row would overwrite what is saved.
        ...(mode === 'custom' ? { reasoningLevels: filled } : {}),
      });
      await reload();
      toast('已更新推理档位', 'ok');
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="推理档位" desc={model.modelId}>
      <div className="space-y-4">
        <SegmentedControl<ReasoningMode>
          value={mode}
          onChange={setMode}
          options={(['auto', 'custom', 'off'] as const).map((m) => ({ value: m, label: MODE_LABELS[m] }))}
        />

        {mode === 'auto' && (defaults.length ? (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-tx3">按该模型所属系列的常见档位自动设置,用户端显示中文。</p>
            <div className="flex flex-wrap gap-1.5">
              {defaults.map((l) => (
                <Badge key={l.value}>{l.label}<span className="font-mono text-tx3">{l.value}</span></Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-tx3">
            未识别到该模型的推理档位,聊天页不会显示推理强度。如果它其实支持,改用「自定义」填写即可。
          </p>
        ))}

        {mode === 'custom' && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-tx3">
              从弱到强排列。左侧是发送给服务端的值(OpenAI 会原样作为 <span className="font-mono">reasoning_effort</span> 发出),
              右侧是用户看到的名称,留空则自动取常见档位的中文名。
            </p>
            <div className="flex gap-2 pr-[4.5rem] text-[11px] text-tx3">
              <span className="flex-1">值(英文)</span>
              <span className="flex-1">显示名</span>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={r.value} placeholder="xhigh" uiSize="sm" className="flex-1 font-mono text-xs"
                  onChange={(e) => setRow(i, { value: e.target.value })}
                />
                <Input
                  value={r.label} placeholder="留空自动" uiSize="sm" className="flex-1 text-xs"
                  onChange={(e) => setRow(i, { label: e.target.value })}
                />
                <div className="flex shrink-0">
                  <Button variant="ghost" size="iconXs" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ChevronUp size={13} />
                  </Button>
                  <Button variant="ghost" size="iconXs" title="下移" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                    <ChevronDown size={13} />
                  </Button>
                  <Button variant="dangerGhost" size="iconXs" title="删除此档位"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <X size={13} />
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex gap-2 pt-0.5">
              <Button variant="outline" size="sm" onClick={() => setRows([...rows, { value: '', label: '' }])}>
                <Plus size={13} />添加档位
              </Button>
              {defaults.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setRows(defaults)}>填入默认档位</Button>
              )}
            </div>
          </div>
        )}

        {mode === 'off' && (
          <p className="text-xs leading-relaxed text-tx3">
            视为该模型没有推理模式:聊天页隐藏推理强度,请求里也不会带上这个字段。
          </p>
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

function ReasoningCell({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const { mode, levels } = model.reasoning;

  return (
    <>
      <button
        type="button"
        title="设置推理档位"
        onClick={() => setOpen(true)}
        className="flex max-w-[15rem] cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-bg3"
      >
        <Badge tone={mode === 'custom' ? 'acc' : 'default'}>{MODE_LABELS[mode]}</Badge>
        {levels.length ? (
          <span className="truncate text-[11px] text-tx2">{levels.map((l) => l.label).join(' · ')}</span>
        ) : (
          <span className="text-[11px] text-tx3">无</span>
        )}
        <Pencil size={11} className="shrink-0 text-tx3" />
      </button>
      {open && <ReasoningModal model={model} reload={reload} onClose={() => setOpen(false)} />}
    </>
  );
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
        <div className="truncate font-mono text-tx">{model.modelId}</div>
        {model.displayName && <div className="truncate text-[11px] text-tx3">{model.displayName}</div>}
      </Td>
      <Td className="text-center"><Toggle checked={model.vision} disabled={busy} onChange={(v) => patch({ vision: v })} /></Td>
      <Td className="text-center"><Toggle checked={model.tools} disabled={busy} onChange={(v) => patch({ tools: v })} /></Td>
      <Td className="text-center"><Toggle checked={model.imageGen} disabled={busy} onChange={(v) => patch({ imageGen: v })} /></Td>
      <Td><ReasoningCell model={model} reload={reload} /></Td>
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
          配置每个模型的能力、推理档位、默认联网、可见性与默认模型。添加模型和启用开关在
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
                      <Th>推理档位</Th>
                      <Th className="text-center" title="新对话默认开启联网搜索(需要该模型可用搜索)">默认联网</Th>
                      <Th>可见性</Th>
                      <Th className="text-center">默认</Th>
                      <Th className="text-center">状态</Th>
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
