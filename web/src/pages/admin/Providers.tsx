import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronUp, Download, FlaskConical, Pencil, Plus, Server, Star, Trash2, Upload, Users, X,
} from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, SegmentedControl, Select, Spinner,
  StatusDot, Td, Textarea, Th, Toggle, ToggleRow, confirmDialog, toast,
} from '../../components/ui';
import { KeyValueEditor, objectToPairs, pairsToObject, type KVPair } from '../../components/KeyValueEditor';
import { ProviderAvatar } from '../../components/ModelAvatar';
import type { AdminModel, AdminProvider, AdminUser, ModelAccessMode, ReasoningLevel, ReasoningMode } from '../../types';

type ProviderType = AdminProvider['type'];

const TYPE_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

const DEFAULT_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

// ---------- provider create / edit modal ----------
function ProviderModal({ provider, onClose, onSaved }: {
  provider: AdminProvider | null; onClose(): void; onSaved(): Promise<void>;
}) {
  const isEdit = provider !== null;
  const [name, setName] = useState(provider?.name ?? '');
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [useResponses, setUseResponses] = useState(provider?.useResponses ?? false);
  const [useVertex, setUseVertex] = useState(provider?.useVertex ?? false);
  const [vertexProject, setVertexProject] = useState(provider?.vertexProject ?? '');
  const [vertexLocation, setVertexLocation] = useState(provider?.vertexLocation ?? '');
  const [vertexSaJson, setVertexSaJson] = useState('');
  const [headers, setHeaders] = useState<KVPair[]>(objectToPairs(provider?.extraHeaders));
  const [hasKey, setHasKey] = useState(provider?.hasKey ?? false);
  const [hasVertexSa, setHasVertexSa] = useState(provider?.hasVertexSa ?? false);
  const [busy, setBusy] = useState(false);
  const saFileRef = useRef<HTMLInputElement>(null);

  const vertexMode = type === 'gemini' && useVertex;

  function applySaJson(text: string): boolean {
    try {
      const j = JSON.parse(text) as { project_id?: unknown };
      setVertexSaJson(JSON.stringify(j, null, 2));
      if (j.project_id && !vertexProject.trim()) setVertexProject(String(j.project_id));
      return true;
    } catch {
      return false;
    }
  }

  async function pickSaFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const ok = applySaJson(await f.text());
    toast(ok ? '已读取服务账号 JSON' : '文件不是有效的 JSON', ok ? 'ok' : 'err');
  }

  async function submit() {
    if (busy) return;
    if (!name.trim()) { toast('请填写名称', 'err'); return; }
    const body: Record<string, unknown> = {
      name: name.trim(),
      type,
      baseUrl: baseUrl.trim() || null,
      useResponses: type === 'openai' ? useResponses : false,
      useVertex: type === 'gemini' ? useVertex : false,
      vertexProject: vertexProject.trim() || null,
      vertexLocation: vertexLocation.trim() || null,
      extraHeaders: pairsToObject(headers),
    };
    if (apiKey) body.apiKey = apiKey;
    if (vertexSaJson.trim()) {
      // Validate here, with a message that says what's wrong — the server
      // would only answer with a generic 400.
      try {
        body.vertexSaJson = JSON.stringify(JSON.parse(vertexSaJson));
      } catch {
        toast('Service Account JSON 不是有效的 JSON,请检查是否完整复制(或直接上传文件)', 'err');
        return;
      }
    }
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/admin/providers/${provider.id}`, body);
      else await api.post('/api/admin/providers', body);
      toast(isEdit ? '已保存' : '已添加 Provider', 'ok');
      await onSaved();
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function clearKey() {
    if (!provider) return;
    try {
      await api.patch(`/api/admin/providers/${provider.id}`, { apiKey: '' });
      setHasKey(false); setApiKey('');
      toast('已清除 API Key', 'ok');
      await onSaved();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function clearSaJson() {
    if (!provider) return;
    try {
      await api.patch(`/api/admin/providers/${provider.id}`, { vertexSaJson: '' });
      setHasVertexSa(false); setVertexSaJson('');
      toast('已清除 Service Account JSON', 'ok');
      await onSaved();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? '编辑 Provider' : '添加 Provider'} wide>
      <div className="space-y-4">
        <Field label="名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 OpenAI 官方" autoFocus maxLength={64} />
        </Field>
        <Field label="类型">
          <Select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Google Gemini</option>
          </Select>
        </Field>
        <Field label="API 地址" hint="留空使用官方地址,可填任意兼容网关">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_URLS[type]} />
        </Field>
        {!vertexMode && (
          <Field label="API Key">
            <div className="flex items-center gap-2">
              <Input
                type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                placeholder={isEdit && hasKey ? '●●●●●●(已保存,留空保持不变)' : 'sk-…'}
              />
              {isEdit && hasKey && (
                <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={clearKey}>清除 Key</Button>
              )}
            </div>
          </Field>
        )}

        {type === 'openai' && (
          <ToggleRow
            label="使用 Responses API" desc="新一代接口,支持推理摘要,仅官方及兼容网关支持"
            checked={useResponses} onChange={setUseResponses}
          />
        )}

        {type === 'gemini' && (
          <>
            <ToggleRow
              label="使用 Vertex AI" desc="使用服务账号鉴权,无需 API Key"
              checked={useVertex} onChange={setUseVertex}
            />
            {useVertex && (
              <div className="space-y-4 rounded-lg border border-line bg-bg2/30 p-3">
                <Field label="Service Account JSON" hint="可直接上传 .json 文件,或粘贴完整内容">
                  <Textarea
                    rows={4} value={vertexSaJson}
                    onChange={(e) => setVertexSaJson(e.target.value)}
                    onBlur={() => { if (vertexSaJson.trim()) applySaJson(vertexSaJson); }}
                    className="font-mono text-xs"
                    placeholder={isEdit && hasVertexSa ? '●●●●●●(已保存,留空保持不变)' : '{ "type": "service_account", … }'}
                  />
                  <div className="mt-1.5 flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => saFileRef.current?.click()}>
                      <Upload size={13} />上传 JSON 文件
                    </Button>
                    {isEdit && hasVertexSa && (
                      <Button variant="outline" size="sm" onClick={clearSaJson}>清除已保存的 JSON</Button>
                    )}
                  </div>
                  <input ref={saFileRef} type="file" accept=".json,application/json" hidden onChange={pickSaFile} />
                </Field>
                <Field label="Vertex 项目 ID" hint="留空自动使用 JSON 中的 project_id">
                  <Input value={vertexProject} onChange={(e) => setVertexProject(e.target.value)} placeholder="留空自动读取" />
                </Field>
                <Field label="Vertex 区域" hint="留空使用 global">
                  <Input value={vertexLocation} onChange={(e) => setVertexLocation(e.target.value)} placeholder="global" />
                </Field>
              </div>
            )}
          </>
        )}

        <Field label="自定义 Headers">
          <KeyValueEditor pairs={headers} onChange={setHeaders} keyPlaceholder="Header 名称" valuePlaceholder="Header 值" />
        </Field>

        <ModalActions>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{isEdit ? '保存更改' : '添加 Provider'}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ---------- fetch-models picker modal ----------
function FetchModelsModal({ provider, models, onClose, onDone }: {
  provider: AdminProvider;
  models: { id: string; name?: string }[];
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const existing = useMemo(() => new Set((provider.models ?? []).map((m) => m.modelId)), [provider]);
  const candidates = useMemo(() => models.filter((m) => !existing.has(m.id)), [models, existing]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q));
  }, [candidates, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function confirm() {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      const ids = [...selected];
      await api.post('/api/admin/models', { providerId: provider.id, models: ids.map((id) => ({ modelId: id })) });
      toast(`已添加 ${ids.length} 个模型`, 'ok');
      await onDone();
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="选择要添加的模型" wide>
      <div className="space-y-3">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型…" autoFocus />
        <div className="flex items-center gap-2 text-xs text-tx3">
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set(filtered.map((m) => m.id)))}>全选</Button>
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>清空</Button>
          <span className="ml-auto tabular-nums">共 {candidates.length} 个可添加,已选 {selected.size} 个</span>
        </div>
        <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {filtered.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-bg2">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--color-accs)]" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="font-mono text-xs text-tx">{m.id}</span>
              {m.name && m.name !== m.id && <span className="min-w-0 truncate text-xs text-tx3">{m.name}</span>}
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-tx3">
              {candidates.length === 0 ? '拉取到的模型均已添加' : '没有匹配的模型'}
            </p>
          )}
        </div>
        <ModalActions>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || selected.size === 0} onClick={confirm}>
            {busy && <Spinner className="h-3.5 w-3.5" />}确认添加
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

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

// ---------- model row ----------
function ModelRow({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(model.displayName ?? '');
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

  async function saveName() {
    setEditingName(false);
    const v = nameVal.trim();
    if (v === (model.displayName ?? '')) return;
    await patch({ displayName: v || null }, '已更新显示名');
  }

  async function remove() {
    if (!(await confirmDialog('删除模型', `确定删除模型「${model.modelId}」?`))) return;
    setBusy(true);
    try {
      await api.del(`/api/admin/models/${model.id}`);
      await reload();
      toast('已删除模型', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); setBusy(false); }
  }

  return (
    <tr className="group transition-colors hover:bg-bg2/60">
      <Td className="max-w-[220px] truncate font-mono text-tx">{model.modelId}</Td>
      <Td>
        {editingName ? (
          <div className="flex items-center gap-1">
            <div className="w-40">
              <Input
                value={nameVal} onChange={(e) => setNameVal(e.target.value)} autoFocus
                className="py-1 text-xs"
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
              />
            </div>
            <Button variant="ghost" size="iconXs" title="保存" onClick={saveName}>
              <Check size={13} className="text-ok" />
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className={model.displayName ? '' : 'text-tx3'}>{model.displayName || '—'}</span>
            <Button variant="ghost" size="iconXs" title="编辑显示名"
              onClick={() => { setNameVal(model.displayName ?? ''); setEditingName(true); }}>
              <Pencil size={12} />
            </Button>
          </span>
        )}
      </Td>
      <Td className="text-center"><Toggle checked={model.vision} disabled={busy} onChange={(v) => patch({ vision: v })} /></Td>
      <Td className="text-center"><Toggle checked={model.tools} disabled={busy} onChange={(v) => patch({ tools: v })} /></Td>
      <Td className="text-center"><Toggle checked={model.imageGen} disabled={busy} onChange={(v) => patch({ imageGen: v })} /></Td>
      <Td><ReasoningCell model={model} reload={reload} /></Td>
      <Td><AccessCell model={model} reload={reload} /></Td>
      <Td className="text-center">
        <Button variant="ghost" size="iconXs"
          title={model.isDefault ? '当前默认模型' : '设为默认'} disabled={busy || model.isDefault}
          onClick={() => patch({ isDefault: true }, '已设为默认')}>
          <Star size={14} className={model.isDefault ? 'text-acc' : ''} fill={model.isDefault ? 'currentColor' : 'none'} />
        </Button>
      </Td>
      <Td className="text-center"><Toggle checked={model.enabled} disabled={busy} onChange={(v) => patch({ enabled: v })} /></Td>
      <Td className="text-right">
        <Button variant="dangerGhost" size="iconXs" title="删除" disabled={busy} onClick={remove}>
          <Trash2 size={13} />
        </Button>
      </Td>
    </tr>
  );
}

// ---------- provider card ----------
// ---------- provider avatar ----------
const AVATAR_MIMES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AVATAR_MAX_BYTES = 128 * 1024;

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/** Click the tile to replace the mark; the ✕ restores the built-in one. */
function ProviderAvatarPicker({ provider, reload }: { provider: AdminProvider; reload(): Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function save(avatar: string | null) {
    setBusy(true);
    try {
      await api.put(`/api/admin/providers/${provider.id}/avatar`, { avatar });
      toast(avatar ? '头像已更新' : '已恢复默认头像', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!AVATAR_MIMES.includes(file.type)) { toast('仅支持 SVG / PNG / JPEG / WebP / GIF', 'err'); return; }
    if (file.size > AVATAR_MAX_BYTES) { toast('头像不能超过 128 KB', 'err'); return; }
    try {
      await save(await readAsDataUri(file));
    } catch (err) { toast(errMsg(err), 'err'); }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title="点击上传自定义头像"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="cursor-pointer rounded-lg transition-opacity hover:opacity-70 disabled:opacity-40"
      >
        {busy
          ? <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line2 bg-bg2 text-tx3"><Spinner className="h-3.5 w-3.5" /></span>
          : <ProviderAvatar name={provider.name} type={provider.type} baseUrl={provider.baseUrl}
              avatarUrl={provider.avatarUrl} size={32} />}
      </button>
      {provider.avatarUrl && !busy && (
        <button
          type="button"
          title="恢复默认头像"
          onClick={() => save(null)}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-line bg-bg1 text-tx3 shadow-sm transition-colors hover:border-err/50 hover:text-err"
        >
          <X size={9} />
        </button>
      )}
      <input ref={fileRef} type="file" hidden accept={AVATAR_MIMES.join(',')} onChange={pick} />
    </div>
  );
}

function ProviderCard({ provider, reload, onEdit }: {
  provider: AdminProvider; reload(): Promise<void>; onEdit(): void;
}) {
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<{ id: string; name?: string }[] | null>(null);
  const [manualId, setManualId] = useState('');
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState(false);
  const models = provider.models ?? [];
  // Vertex authenticates with a service account, so "no API key" is its
  // normal, healthy state — judge it by the credential it actually uses.
  const usesVertex = provider.type === 'gemini' && provider.useVertex;
  const hasCred = usesVertex ? provider.hasVertexSa : provider.hasKey;

  async function setEnabled(v: boolean) {
    if (toggling) return;
    setToggling(true);
    try {
      await api.patch(`/api/admin/providers/${provider.id}`, { enabled: v });
      toast(v ? '已启用' : '已禁用', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setToggling(false); }
  }

  async function test() {
    if (testing) return;
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; models?: { id: string; name?: string }[]; error?: string }>(
        `/api/admin/providers/${provider.id}/test`,
      );
      if (r.ok) toast(`连接成功,发现 ${Array.isArray(r.models) ? r.models.length : 0} 个模型`, 'ok');
      else toast(r.error || '连接失败', 'err');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setTesting(false); }
  }

  async function remove() {
    if (!(await confirmDialog('删除 Provider', `确定删除「${provider.name}」?其下所有模型将一并删除。`))) return;
    try {
      await api.del(`/api/admin/providers/${provider.id}`);
      toast('已删除 Provider', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function fetchModels() {
    if (fetching) return;
    setFetching(true);
    try {
      const r = await api.post<{ ok: boolean; models?: { id: string; name?: string }[]; error?: string }>(
        `/api/admin/providers/${provider.id}/fetch-models`,
      );
      if (r.ok) setFetched(Array.isArray(r.models) ? r.models : []);
      else toast(r.error || '拉取失败', 'err');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setFetching(false); }
  }

  async function addManual() {
    const id = manualId.trim();
    if (!id || adding) return;
    if (models.some((m) => m.modelId === id)) { toast('该模型已存在', 'err'); return; }
    setAdding(true);
    try {
      await api.post('/api/admin/models', { providerId: provider.id, models: [{ modelId: id }] });
      toast(`已添加 ${id}`, 'ok');
      setManualId('');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setAdding(false); }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-line px-4 py-3">
        <ProviderAvatarPicker provider={provider} reload={reload} />
        <StatusDot tone={!provider.enabled ? 'idle' : hasCred ? 'ok' : 'warn'} />
        <span className="text-[13px] font-semibold text-tx">{provider.name}</span>
        <Badge>{TYPE_LABELS[provider.type]}</Badge>
        {usesVertex && <Badge>Vertex</Badge>}
        <span className="min-w-0 max-w-[16rem] flex-1 truncate font-mono text-[11px] text-tx3" title={provider.baseUrl || DEFAULT_URLS[provider.type]}>
          {provider.baseUrl || DEFAULT_URLS[provider.type]}
        </span>
        <Badge tone={hasCred ? 'ok' : 'err'}>
          {usesVertex ? (hasCred ? '已配置凭证' : '未配置凭证') : (hasCred ? '已配置 Key' : '未配置 Key')}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Toggle checked={provider.enabled} disabled={toggling} onChange={setEnabled} />
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing ? <Spinner className="h-3.5 w-3.5" /> : <FlaskConical size={13} />}测试
          </Button>
          <Button variant="ghost" size="iconSm" title="编辑" onClick={onEdit}><Pencil size={14} /></Button>
          <Button variant="dangerGhost" size="iconSm" title="删除" onClick={remove}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchModels} disabled={fetching}>
            {fetching ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />}拉取模型列表
          </Button>
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); addManual(); }}>
            <div className="w-52">
              <Input value={manualId} onChange={(e) => setManualId(e.target.value)}
                placeholder="手动输入模型 ID" uiSize="sm" className="text-xs" />
            </div>
            <Button variant="outline" size="sm" type="submit" disabled={adding || !manualId.trim()}>
              {adding ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={13} />}手动添加
            </Button>
          </form>
        </div>

        {models.length === 0 ? (
          <p className="rounded-md border border-dashed border-line2 px-3 py-4 text-center text-xs text-tx3">
            尚未添加模型 — 点击「拉取模型列表」或手动输入模型 ID
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <Th>模型 ID</Th>
                  <Th>显示名</Th>
                  <Th className="text-center">视觉</Th>
                  <Th className="text-center">工具</Th>
                  <Th className="text-center">绘图</Th>
                  <Th>推理档位</Th>
                  <Th>可见性</Th>
                  <Th className="text-center">默认</Th>
                  <Th className="text-center">启用</Th>
                  <Th className="text-right">删除</Th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => <ModelRow key={m.id} model={m} reload={reload} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {fetched !== null && (
        <FetchModelsModal provider={provider} models={fetched} onClose={() => setFetched(null)} onDone={reload} />
      )}
    </div>
  );
}

// ---------- page ----------
export default function Providers() {
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProvider | null>(null);

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

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight text-tx">模型服务</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-tx3">
            管理 AI 提供商及其模型,启用后即可在对话与绘图中选用。
          </p>
        </div>
        <Button variant="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus size={15} />添加 Provider
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-line bg-bg1 shadow-xs">
          <EmptyState
            icon={<Server size={22} />}
            title="还没有配置模型服务"
            hint="接入 OpenAI 兼容、Anthropic 或 Google Gemini 服务后,即可在对话中选择模型。"
            action={(
              <Button variant="primary" size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus size={14} />添加 Provider
              </Button>
            )}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} reload={load}
              onEdit={() => { setEditing(p); setFormOpen(true); }} />
          ))}
        </div>
      )}

      {formOpen && (
        <ProviderModal
          key={editing?.id ?? 'new'}
          provider={editing}
          onClose={() => setFormOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
