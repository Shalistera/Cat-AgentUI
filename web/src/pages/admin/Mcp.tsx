import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, ExternalLink, Globe, Pencil, Plus, PlugZap, Server, Trash2 } from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, Select, Spinner, Textarea,
  StatusDot, Toggle, ToggleRow, confirmDialog, toast,
} from '../../components/ui';
import { KeyValueEditor, pairsToObject, type KVPair } from '../../components/KeyValueEditor';
import type { AdminMcpServer, AdminUser, McpPresetStatus } from '../../types';

type Transport = AdminMcpServer['transport'];
type AccessMode = AdminMcpServer['accessMode'];

const TRANSPORT_LABELS: Record<Transport, string> = {
  stdio: 'Stdio(本地命令)',
  http: 'Streamable HTTP',
  sse: 'SSE',
};

// ---------- create / edit modal ----------
function McpModal({ server, users, onClose, onSaved }: {
  server: AdminMcpServer | null; users: AdminUser[]; onClose(): void; onSaved(): Promise<void>;
}) {
  const isEdit = server !== null;
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<Transport>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [argsText, setArgsText] = useState((server?.args ?? []).join('\n'));
  // 安全:后端不会返回已保存的 env/headers 值,编辑时编辑器始终从空开始。
  const [envPairs, setEnvPairs] = useState<KVPair[]>([]);
  const [url, setUrl] = useState(server?.url ?? '');
  const [headerPairs, setHeaderPairs] = useState<KVPair[]>([]);
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [accessMode, setAccessMode] = useState<AccessMode>(server?.accessMode ?? 'shared');
  const [confirmCalls, setConfirmCalls] = useState(server?.confirmCalls ?? false);
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>(server?.allowedUserIds ?? []);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (!name.trim()) { toast('请填写名称', 'err'); return; }
    if (transport === 'stdio' && !command.trim()) { toast('请填写命令', 'err'); return; }
    if (transport !== 'stdio' && !url.trim()) { toast('请填写 URL', 'err'); return; }
    const body: Record<string, unknown> = {
      name: name.trim(),
      transport,
      enabled,
      accessMode,
      confirmCalls,
      allowedUserIds,
    };
    if (transport === 'stdio') {
      body.command = command.trim();
      body.args = argsText.split('\n').map((s) => s.trim()).filter(Boolean);
      // env 为敏感信息:仅在实际填写时提交(整体覆盖);编辑时留空 = 保持原值。
      const env = pairsToObject(envPairs);
      if (!isEdit || Object.keys(env).length > 0) body.env = env;
    } else {
      body.url = url.trim();
      body.args = [];
      const headers = pairsToObject(headerPairs);
      if (!isEdit || Object.keys(headers).length > 0) body.headers = headers;
    }
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/admin/mcp/${server.id}`, body);
      else await api.post('/api/admin/mcp', body);
      toast(isEdit ? '已保存' : '已添加服务器', 'ok');
      await onSaved();
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'} wide>
      <div className="space-y-4">
        <Field label="名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 文件系统" autoFocus maxLength={64} />
        </Field>
        <Field label="传输方式">
          <Select value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
            <option value="stdio">Stdio(本地命令)</option>
            <option value="http">Streamable HTTP</option>
            <option value="sse">SSE</option>
          </Select>
        </Field>

        {transport === 'stdio' ? (
          <>
            <Field label="命令">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="如 npx / uvx / 绝对路径" />
            </Field>
            <Field label="参数" hint="每行一个参数">
              <Textarea rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)}
                className="font-mono text-xs" placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/data'} />
            </Field>
            <Field label="环境变量" hint={isEdit ? '留空则保持不变;填写后将整体覆盖' : undefined}>
              <div className="space-y-2">
                {isEdit && (server.envKeys?.length ?? 0) > 0 && (
                  <div className="text-[11px] text-tx3">已配置:{server.envKeys.join('、')}(值不回显)</div>
                )}
                <KeyValueEditor pairs={envPairs} onChange={setEnvPairs} keyPlaceholder="变量名" valuePlaceholder="值" valueType="password" />
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers" hint={isEdit ? '留空则保持不变;填写后将整体覆盖' : undefined}>
              <div className="space-y-2">
                {isEdit && (server.headerKeys?.length ?? 0) > 0 && (
                  <div className="text-[11px] text-tx3">已配置:{server.headerKeys.join('、')}(值不回显)</div>
                )}
                <KeyValueEditor pairs={headerPairs} onChange={setHeaderPairs} keyPlaceholder="Header 名称" valuePlaceholder="Header 值" valueType="password" />
              </div>
            </Field>
          </>
        )}

        <ToggleRow
          label="启用该服务器" desc="禁用后不会出现在对话的工具菜单里"
          checked={enabled} onChange={setEnabled}
        />

        <ToggleRow
          label="调用前需用户确认"
          desc="模型每次想调用该服务器的工具时先暂停,由用户在对话里点「允许」或「拒绝」。写文件、执行命令等有副作用的服务器建议开启"
          checked={confirmCalls} onChange={setConfirmCalls}
        />

        <Field label="访问范围" hint="搜索等基础工具建议共享;文件、命令和内部系统建议限制用户">
          <Select value={accessMode} onChange={(e) => setAccessMode(e.target.value as AccessMode)}>
            <option value="shared">所有登录用户</option>
            <option value="restricted">仅指定普通用户</option>
          </Select>
        </Field>

        {accessMode === 'restricted' && (
          <Field label="指定普通用户" hint="管理员始终可用;只有勾选用户才能看到和调用该服务器">
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
                    checked={allowedUserIds.includes(u.id)}
                    onChange={(checked) => setAllowedUserIds(checked
                      ? [...allowedUserIds, u.id]
                      : allowedUserIds.filter((id) => id !== u.id))}
                  />
                </div>
              ))}
            </div>
          </Field>
        )}

        <ModalActions>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{isEdit ? '保存更改' : '添加服务器'}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ---------- server card ----------
function ServerCard({ server, reload, onEdit }: {
  server: AdminMcpServer; reload(): Promise<void>; onEdit(): void;
}) {
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const tools = server.toolsCache ?? [];

  const summary = server.transport === 'stdio'
    ? [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ')
    : server.url ?? '';

  async function setEnabled(v: boolean) {
    if (toggling) return;
    setToggling(true);
    try {
      await api.patch(`/api/admin/mcp/${server.id}`, { enabled: v });
      toast(v ? '已启用' : '已禁用', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setToggling(false); }
  }

  async function test() {
    if (testing) return;
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; tools?: unknown[]; error?: string }>(`/api/admin/mcp/${server.id}/test`);
      if (r.ok) toast(`连接成功,发现 ${Array.isArray(r.tools) ? r.tools.length : 0} 个工具`, 'ok');
      else toast(r.error || '连接失败', 'err');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setTesting(false);
      await reload();
    }
  }

  async function setSearch(v: boolean) {
    try {
      await api.put('/api/admin/mcp/search', { serverId: v ? server.id : null });
      toast(v ? '已设为备用搜索源:Google 搜索不可用或本月额度用完时改用它' : '已取消备用搜索源', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function remove() {
    if (!(await confirmDialog('删除服务器', `确定删除「${server.name}」?`))) return;
    try {
      await api.del(`/api/admin/mcp/${server.id}`);
      toast('已删除服务器', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-bg1 p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <StatusDot tone={server.lastStatus === 'ok' ? 'ok' : server.lastStatus === 'error' ? 'err' : 'idle'} />
        <span className="text-[13px] font-semibold text-tx">{server.name}</span>
        <Badge>{TRANSPORT_LABELS[server.transport]}</Badge>
        <Badge tone={server.lastStatus === 'ok' ? 'ok' : server.lastStatus === 'error' ? 'err' : 'default'}>
          {server.lastStatus === 'ok' ? '连接正常' : server.lastStatus === 'error' ? '连接异常' : '未测试'}
        </Badge>
        <Badge tone={server.accessMode === 'shared' ? 'acc' : 'default'}>
          {server.accessMode === 'shared' ? '全员共享' : `指定用户 ${server.allowedUserIds.length}`}
        </Badge>
        {server.confirmCalls && <Badge tone="warn">调用前确认</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={server.isSearch ? 'primary' : 'ghost'} size="sm"
            title={server.isSearch
              ? '当前的备用搜索源,点击取消'
              : '设为备用搜索源:没有可用的 Gemini 服务商或本月 Google 搜索额度用完时,模型改用该服务器搜索(Agent 能力 → 联网搜索)'}
            onClick={() => setSearch(!server.isSearch)}
          >
            <Globe size={13} />{server.isSearch ? '搜索源' : '设为搜索源'}
          </Button>
          <Toggle checked={server.enabled} disabled={toggling} onChange={setEnabled} />
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing ? <Spinner className="h-3.5 w-3.5" /> : <PlugZap size={13} />}测试连接
          </Button>
          <Button variant="ghost" size="iconSm" title="编辑" onClick={onEdit}><Pencil size={14} /></Button>
          <Button variant="dangerGhost" size="iconSm" title="删除" onClick={remove}>
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      {summary && (
        <div className="truncate rounded-md border border-line bg-bg2/50 px-2.5 py-1.5 font-mono text-[11px] text-tx2" title={summary}>
          {summary}
        </div>
      )}
      {server.lastError && (
        <div className="rounded-md border border-err/30 bg-err/10 px-2.5 py-1.5 text-xs leading-relaxed text-err">
          {server.lastError}
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <button
            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-tx2 transition-colors hover:text-tx"
            onClick={() => setToolsOpen(!toolsOpen)}>
            {toolsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {tools.length} 个工具
          </button>
          {toolsOpen && (
            <div className="mt-2 divide-y divide-line rounded-md border border-line">
              {tools.map((t) => (
                <div key={t.name} className="flex min-w-0 items-baseline gap-2 px-2.5 py-1.5">
                  <span className="shrink-0 font-mono text-xs text-tx">{t.name}</span>
                  <span className="min-w-0 truncate text-xs text-tx3">{t.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- one-click presets ----------
function PresetCard({ preset, servers, reload }: {
  preset: McpPresetStatus; servers: AdminMcpServer[]; reload(): Promise<void>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const linked = preset.serverId ? servers.find((s) => s.id === preset.serverId) ?? null : null;
  const deployed = !!linked;

  async function run(reinstall: boolean) {
    if (busy) return;
    const key = apiKey.trim();
    if (!deployed && !key) { toast('请先填写 API Key', 'err'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ serverId: string; version: string; test: { ok: boolean; tools?: unknown[]; error?: string } }>(
        `/api/admin/mcp/presets/${preset.id}/install`,
        { apiKey: key || undefined, reinstall },
      );
      if (r.test.ok) {
        toast(`${preset.name} v${r.version} 已就绪,发现 ${r.test.tools?.length ?? 0} 个工具`, 'ok');
      } else {
        toast(`已安装 v${r.version},但连接失败:${r.test.error ?? '未知错误'}`, 'err');
      }
      setApiKey('');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-acc/40 bg-acc/5 p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Globe size={14} className="text-acc" />
        <span className="text-[13px] font-semibold text-tx">一键部署 {preset.name}</span>
        {preset.installedVersion && <Badge mono>v{preset.installedVersion}</Badge>}
        {deployed
          ? <Badge tone={linked.lastStatus === 'ok' ? 'ok' : linked.lastStatus === 'error' ? 'err' : 'default'}>
            {linked.lastStatus === 'ok' ? '已部署 · 连接正常' : linked.lastStatus === 'error' ? '已部署 · 连接异常' : '已部署'}
          </Badge>
          : <Badge>未部署</Badge>}
        <a href={preset.keyUrl} target="_blank" rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs text-acc hover:underline">
          获取 API Key <ExternalLink size={11} />
        </a>
      </div>
      <p className="text-xs leading-relaxed text-tx3">
        {preset.description} 服务器包会下载到本机数据目录,启动时不依赖网络;API Key 加密保存,不回显。
        {preset.search && !deployed && ' 部署后会自动设为备用搜索源。'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password" uiSize="sm" className="min-w-0 flex-1 font-mono"
          value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={deployed ? `更换 ${preset.apiKeyEnv}(留空则保持不变)` : preset.apiKeyEnv}
          autoComplete="off"
        />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => run(false)}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />}
          {deployed ? (apiKey.trim() ? '更新 Key 并重连' : '重新连接') : '下载并部署'}
        </Button>
        {deployed && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(true)} title="重新执行 npm install 升级到最新版本">
            升级到最新版
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- page ----------
export default function Mcp() {
  const [servers, setServers] = useState<AdminMcpServer[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [presets, setPresets] = useState<McpPresetStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminMcpServer | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, allUsers, presetList] = await Promise.all([
        api.get<AdminMcpServer[] | { servers?: AdminMcpServer[] }>('/api/admin/mcp'),
        api.get<AdminUser[]>('/api/admin/users'),
        api.get<McpPresetStatus[]>('/api/admin/mcp/presets'),
      ]);
      setServers(Array.isArray(r) ? r : r.servers ?? []);
      setUsers(allUsers.filter((u) => u.role === 'user'));
      setPresets(presetList);
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
          <h1 className="text-base font-semibold tracking-tight text-tx">MCP 服务器</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-tx3">
            搜索等基础工具可设为全员共享;敏感工具可限制到指定用户。
          </p>
        </div>
        <Button variant="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus size={15} />添加服务器
        </Button>
      </div>

      {!loading && presets.map((p) => (
        <PresetCard key={p.id} preset={p} servers={servers} reload={load} />
      ))}

      {loading ? (
        <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
      ) : servers.length === 0 ? (
        <div className="rounded-xl border border-line bg-bg1 shadow-xs">
          <EmptyState
            icon={<Server size={22} />}
            title="还没有 MCP 服务器"
            hint="接入 Stdio、Streamable HTTP 或 SSE 方式的 MCP 服务,即可在对话中调用其工具。"
            action={(
              <Button variant="primary" size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus size={14} />添加服务器
              </Button>
            )}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} reload={load}
              onEdit={() => { setEditing(s); setFormOpen(true); }} />
          ))}
        </div>
      )}

      {formOpen && (
        <McpModal
          key={editing?.id ?? 'new'}
          server={editing}
          users={users}
          onClose={() => setFormOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
