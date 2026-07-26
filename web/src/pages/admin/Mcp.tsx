import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, PlugZap, Server, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, Toggle,
  confirmDialog, toast,
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

function objectToPairs(obj: Record<string, string> | null | undefined): KVPair[] {
  return Object.entries(obj ?? {}).map(([k, v]) => ({ k, v }));
}

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
      <Button variant="ghost" size="sm" onClick={() => onChange([...pairs, { k: '', v: '' }])}>
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
  const [envPairs, setEnvPairs] = useState<KVPair[]>(objectToPairs(server?.env));
  const [url, setUrl] = useState(server?.url ?? '');
  const [headerPairs, setHeaderPairs] = useState<KVPair[]>(objectToPairs(server?.headers));
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
      ...(transport === 'stdio'
        ? {
            command: command.trim(),
            args: argsText.split('\n').map((s) => s.trim()).filter(Boolean),
            env: pairsToObject(envPairs),
            url: null,
            headers: {},
          }
        : {
            url: url.trim(),
            headers: pairsToObject(headerPairs),
            command: null,
            args: [],
            env: {},
          }),
    };
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
            <Field label="环境变量">
              <KeyValueEditor pairs={envPairs} onChange={setEnvPairs} keyPlaceholder="变量名" valuePlaceholder="值" />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers">
              <KeyValueEditor pairs={headerPairs} onChange={setHeaderPairs} keyPlaceholder="Header 名称" valuePlaceholder="Header 值" />
            </Field>
          </>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg2/50 px-3 py-2.5">
          <div className="text-xs font-medium">启用</div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{isEdit ? '保存' : '添加'}
          </Button>
        </div>
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

  async function remove() {
    if (!(await confirmDialog('删除服务器', `确定删除「${server.name}」?`))) return;
    try {
      await api.del(`/api/admin/mcp/${server.id}`);
      toast('已删除服务器', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <div className="space-y-2 rounded-2xl border border-line bg-bg1 p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="font-medium">{server.name}</span>
        <Badge tone="acc">{TRANSPORT_LABELS[server.transport]}</Badge>
        <Badge tone={server.lastStatus === 'ok' ? 'ok' : server.lastStatus === 'error' ? 'err' : 'default'}>
          {server.lastStatus === 'ok' ? '正常' : server.lastStatus === 'error' ? '异常' : '未测试'}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Toggle checked={server.enabled} onChange={setEnabled} />
          <Button variant="ghost" size="sm" onClick={test} disabled={testing}>
            {testing ? <Spinner className="h-3.5 w-3.5" /> : <PlugZap size={13} />}测试连接
          </Button>
          <Button variant="ghost" size="icon" title="编辑" onClick={onEdit}><Pencil size={14} /></Button>
          <Button variant="ghost" size="icon" title="删除" onClick={remove}><Trash2 size={14} /></Button>
        </div>
      </div>

      {summary && <div className="truncate font-mono text-xs text-tx3" title={summary}>{summary}</div>}
      {server.lastError && <div className="text-xs text-err">{server.lastError}</div>}

      {tools.length > 0 && (
        <div>
          <button
            className="flex cursor-pointer items-center gap-1 text-xs text-tx2 transition-colors hover:text-tx"
            onClick={() => setToolsOpen(!toolsOpen)}>
            {toolsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {tools.length} 个工具
          </button>
          {toolsOpen && (
            <div className="mt-2 space-y-1 rounded-lg border border-line bg-bg2/40 p-2.5">
              {tools.map((t) => (
                <div key={t.name} className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-xs">{t.name}</span>
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
        <p className="min-w-0 text-sm text-tx2">MCP 服务器为对话提供工具能力,在对话输入框的工具菜单中启用。</p>
        <Button variant="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus size={15} />添加服务器
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner className="h-6 w-6" /></div>
      ) : servers.length === 0 ? (
        <EmptyState
          icon={<Server size={32} />}
          title="还没有 MCP 服务器"
          hint="点击「添加服务器」接入 Stdio、Streamable HTTP 或 SSE 方式的 MCP 服务"
        />
      ) : (
        <div className="space-y-4">
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
