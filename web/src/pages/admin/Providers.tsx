import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check, ChevronDown, Download, FlaskConical, Pencil, Plus, Server, Trash2, Upload, X,
} from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, Select, Spinner,
  StatusDot, Td, Textarea, Th, Toggle, ToggleRow, confirmDialog, toast,
} from '../../components/ui';
import { KeyValueEditor, pairsToObject, type KVPair } from '../../components/KeyValueEditor';
import { ProviderAvatar } from '../../components/ModelAvatar';
import type { AdminModel, AdminProvider } from '../../types';
import { DEFAULT_URLS, TYPE_LABELS, type ProviderType } from './provider-common';

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
  // Saved header values are write-only. Blank values on existing key rows mean
  // "keep", while typing replaces that key and deleting the row removes it.
  const [headers, setHeaders] = useState<KVPair[]>(
    (provider?.extraHeaderKeys ?? []).map((k) => ({ k, v: '' })),
  );
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
    };
    const existingHeaderKeys = new Set(provider?.extraHeaderKeys ?? []);
    // A blank existing row means "keep"; a newly-added blank row remains a
    // real empty-valued header, matching the panel's behavior before values
    // became write-only.
    const headerValues = pairsToObject(headers.filter(
      (p) => p.v.length > 0 || !existingHeaderKeys.has(p.k),
    ));
    body.extraHeaders = headerValues;
    if (isEdit) {
      body.preserveExtraHeaderKeys = headers
        .filter((p) => existingHeaderKeys.has(p.k) && p.v.length === 0)
        .map((p) => p.k);
    }
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
        <Field label="API 地址" hint="留空使用官方地址;可填任意兼容网关,写到 /v1 或整条接口地址都能识别">
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

        <Field label="自定义 Headers" hint={isEdit ? '已保存值不回显;留空保持,填写替换,删除行即移除' : undefined}>
          <KeyValueEditor pairs={headers} onChange={setHeaders} keyPlaceholder="Header 名称"
            valuePlaceholder={isEdit ? '留空保持原值' : 'Header 值'} valueType="password" />
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

// ---------- model row (roster only: display name, enable, delete) ----------
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
      <Td className="max-w-[280px] truncate font-mono text-tx">{model.modelId}</Td>
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
      <Td className="text-center"><Toggle checked={model.enabled} disabled={busy} onChange={(v) => patch({ enabled: v }, v ? '已启用' : '已停用')} /></Td>
      <Td className="text-right">
        <Button variant="dangerGhost" size="iconXs" title="删除" disabled={busy} onClick={remove}>
          <Trash2 size={13} />
        </Button>
      </Td>
    </tr>
  );
}

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

// ---------- provider card (collapsed by default) ----------
function ProviderCard({ provider, reload, onEdit }: {
  provider: AdminProvider; reload(): Promise<void>; onEdit(): void;
}) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<{ id: string; name?: string }[] | null>(null);
  const [manualId, setManualId] = useState('');
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState(false);
  const models = provider.models ?? [];
  const enabledCount = models.filter((m) => m.enabled).length;
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
      {/* Whole header toggles the fold; the interactive bits stop propagation. */}
      <div
        className={`flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 transition-colors hover:bg-bg2/40 ${open ? 'border-b border-line' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={15} className={`shrink-0 text-tx3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div onClick={(e) => e.stopPropagation()}>
          <ProviderAvatarPicker provider={provider} reload={reload} />
        </div>
        <StatusDot tone={!provider.enabled ? 'idle' : hasCred ? 'ok' : 'warn'} />
        <span className="text-[13px] font-semibold text-tx">{provider.name}</span>
        <Badge>{TYPE_LABELS[provider.type]}</Badge>
        {usesVertex && <Badge>Vertex</Badge>}
        {/* Phones keep only name/type/toggle in the header — the status dot
            already encodes the credential state the hidden badge spells out. */}
        <span className="hidden min-w-0 max-w-[16rem] flex-1 truncate font-mono text-[11px] text-tx3 md:block" title={provider.baseUrl || DEFAULT_URLS[provider.type]}>
          {provider.baseUrl || DEFAULT_URLS[provider.type]}
        </span>
        <span className="hidden text-[11px] tabular-nums text-tx3 sm:inline">{models.length} 个模型 · {enabledCount} 已启用</span>
        <span className="hidden sm:contents">
          <Badge tone={hasCred ? 'ok' : 'err'}>
            {usesVertex ? (hasCred ? '已配置凭证' : '未配置凭证') : (hasCred ? '已配置 Key' : '未配置 Key')}
          </Badge>
        </span>
        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Toggle checked={provider.enabled} disabled={toggling} onChange={setEnabled} />
        </div>
      </div>

      {open && (
        <div className="space-y-3 px-4 py-3">
          {/* Two deliberate rows at every width — a single flex-wrap row used
              to shatter into three ragged lines on phones. */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={fetchModels} disabled={fetching}>
                {fetching ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />}拉取模型列表
              </Button>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={test} disabled={testing}>
                  {testing ? <Spinner className="h-3.5 w-3.5" /> : <FlaskConical size={13} />}测试
                </Button>
                <Button variant="ghost" size="iconSm" title="编辑" onClick={onEdit}><Pencil size={14} /></Button>
                <Button variant="dangerGhost" size="iconSm" title="删除" onClick={remove}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); addManual(); }}>
              <div className="min-w-0 flex-1 sm:max-w-[16rem]">
                <Input value={manualId} onChange={(e) => setManualId(e.target.value)}
                  placeholder="手动输入模型 ID" uiSize="sm" className="text-xs" />
              </div>
              <Button variant="outline" size="sm" type="submit" className="shrink-0" disabled={adding || !manualId.trim()}>
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

          <p className="text-[11px] leading-relaxed text-tx3">
            视觉/工具/推理等能力与可见性在
            <Link to="/admin/models" className="mx-0.5 text-acc hover:underline">模型设置</Link>
            配置;选择器中的显示顺序在
            <Link to="/admin/model-order" className="mx-0.5 text-acc hover:underline">模型排序</Link>
            调整。
          </p>
        </div>
      )}

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
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight text-tx">模型服务</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-tx3">
            管理 AI 提供商接入。点击卡片展开模型列表,在这里添加模型、设置显示名与启用状态。
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
