import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Globe, Pencil, Plus, PlugZap, Server, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, Select, Spinner, Textarea,
  StatusDot, Toggle, confirmDialog, toast,
} from '../../components/ui';
import type { AdminMcpServer } from '../../types';

type Transport = AdminMcpServer['transport'];

const TRANSPORT_LABELS: Record<Transport, string> = {
  stdio: 'Stdio(本地命令)',
  http: 'Streamable HTTP',
  sse: 'SSE',
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

// ---------- key-value editor ----------
interface KVPair { k: string; v: string }

function pairsToObject(pairs: KVPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const k = p.k.trim();
    if (k) out[k] = p.v;
  }
  return out;
}

function KeyValueEditor({ pairs, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value' }: {
  pairs: KVPair[]; onChange(pairs: KVPair[]): void; keyPlaceholder?: string; valuePlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            placeholder={keyPlaceholder} value={p.k}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <Input
            placeholder={valuePlaceholder} value={p.v}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <Button variant="ghost" size="icon" title="删除此行" className="shrink-0"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...pairs, { k: '', v: '' }])}>
        <Plus size={13} />添加一行
      </Button>
    </div>
  );
}

// ---------- create / edit modal ----------
function McpModal({ server, onClose, onSaved }: {
  server: AdminMcpServer | null; onClose(): void; onSaved(): Promise<void>;
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
                <KeyValueEditor pairs={envPairs} onChange={setEnvPairs} keyPlaceholder="变量名" valuePlaceholder="值" />
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
                <KeyValueEditor pairs={headerPairs} onChange={setHeaderPairs} keyPlaceholder="Header 名称" valuePlaceholder="Header 值" />
              </div>
            </Field>
          </>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg0 px-3.5 py-3">
          <div>
            <div className="text-[13px] font-medium text-tx">启用该服务器</div>
            <div className="mt-0.5 text-xs text-tx3">禁用后不会出现在对话的工具菜单里</div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

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
  const [toolsOpen, setToolsOpen] = useState(false);
  const tools = server.toolsCache ?? [];

  const summary = server.transport === 'stdio'
    ? [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ')
    : server.url ?? '';

  async function setEnabled(v: boolean) {
    try {
      await api.patch(`/api/admin/mcp/${server.id}`, { enabled: v });
      toast(v ? '已启用' : '已禁用', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
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
      toast(v ? '已设为联网搜索源,输入框会出现「联网」开关' : '已取消联网搜索源', 'ok');
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
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={server.isSearch ? 'primary' : 'ghost'} size="sm"
            title={server.isSearch
              ? '当前的联网搜索源,点击取消'
              : '设为联网搜索源:用户输入框会出现「联网」开关,模型按需调用该服务器搜索'}
            onClick={() => setSearch(!server.isSearch)}
          >
            <Globe size={13} />{server.isSearch ? '搜索源' : '设为搜索源'}
          </Button>
          <Toggle checked={server.enabled} onChange={setEnabled} />
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing ? <Spinner className="h-3.5 w-3.5" /> : <PlugZap size={13} />}测试连接
          </Button>
          <Button variant="ghost" size="iconSm" title="编辑" onClick={onEdit}><Pencil size={14} /></Button>
          <Button variant="ghost" size="iconSm" className="hover:!bg-err/10 hover:!text-err" title="删除" onClick={remove}>
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
        <div className="rounded-md border border-err/30 bg-err/8 px-2.5 py-1.5 text-xs leading-relaxed text-err">
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

// ---------- page ----------
export default function Mcp() {
  const [servers, setServers] = useState<AdminMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminMcpServer | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<AdminMcpServer[] | { servers?: AdminMcpServer[] }>('/api/admin/mcp');
      setServers(Array.isArray(r) ? r : r.servers ?? []);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight text-tx">MCP 服务器</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-tx3">
            为对话提供外部工具能力,在输入框的「工具」菜单中按对话启用。
          </p>
        </div>
        <Button variant="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus size={15} />添加服务器
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner className="h-6 w-6" /></div>
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
          onClose={() => setFormOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
