// MCP connection manager — maintains live client connections to configured
// MCP servers, exposes namespaced tool listings and tool invocation.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { decryptSecret } from '../crypto.js';
import type { ToolDef } from '../types.js';
import { canUseMcpServer, type McpAccessUser } from './access.js';

type ServerRow = typeof schema.mcpServers.$inferSelect;

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_TOOLS_PER_TURN = 128;
const MAX_TOOL_DEFINITION_CHARS = 512_000;
const MAX_TOOL_ARGS_CHARS = 64_000;
const MAX_TOOL_RESULT_CHARS = 100_000;

// Connection scope is per user. Some MCP servers keep session state inside the
// transport/client; sharing one client between authorized users could leak that
// state even when ACL checks are otherwise correct.
const connections = new Map<string, { serverId: string; client: Client; connectedAt: number }>();
// Coalesce concurrent first-use attempts so a burst cannot spawn one stdio
// child (or remote connection) per request before the cache is populated.
const connecting = new Map<string, { serverId: string; promise: Promise<Client> }>();

interface ToolRoute { serverId: string; originalName: string }
export interface McpCapabilities {
  readonly routes: ReadonlyMap<string, ToolRoute>;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pickEnv(): Record<string, string> {
  const keys = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'NODE_PATH'];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Decrypt an encrypted env/headers blob. A decryption failure (e.g. rotated
 * SECRET_KEY) must surface as a normal per-server connection error — callers
 * of buildTransport catch and report it — never crash the process.
 */
function decryptRecord(enc: string | null, label: string): Record<string, string> {
  if (!enc) return {};
  let plain: string;
  try {
    plain = decryptSecret(enc);
  } catch {
    throw new Error(`无法解密该服务器的${label}(SECRET_KEY 可能已更换),请在管理后台重新填写并保存`);
  }
  return parseJson<Record<string, string>>(plain, {});
}

function buildTransport(row: ServerRow) {
  if (row.transport === 'stdio') {
    if (!row.command) throw new Error('stdio 服务器缺少启动命令(command)');
    return new StdioClientTransport({
      command: row.command,
      args: parseJson<string[]>(row.args, []),
      env: { ...pickEnv(), ...decryptRecord(row.envEnc, '环境变量') },
      stderr: 'ignore',
    });
  }
  if (!row.url) throw new Error('远程 MCP 服务器缺少 URL');
  const headers = decryptRecord(row.headersEnc, 'Headers');
  const opts = { requestInit: { headers } };
  if (row.transport === 'http') return new StreamableHTTPClientTransport(new URL(row.url), opts);
  if (row.transport === 'sse') return new SSEClientTransport(new URL(row.url), opts);
  throw new Error(`不支持的传输类型: ${row.transport}`);
}

// --- process exit cleanup (registered once, best-effort) ---
let exitHookRegistered = false;

function closeAllConnections() {
  for (const { client } of connections.values()) {
    try { void client.close().catch(() => { /* best effort */ }); } catch { /* ignore */ }
  }
  connections.clear();
}

function connectionKey(serverId: string, scopeId: string): string {
  return `${serverId}\u0000${scopeId}`;
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', closeAllConnections);
  process.once('SIGTERM', () => {
    closeAllConnections();
    // Preserve default terminate semantics unless the app has its own handler.
    if (process.listenerCount('SIGTERM') === 0) process.exit(143);
  });
}

async function connectClient(row: ServerRow): Promise<Client> {
  const transport = buildTransport(row);
  const client = new Client({ name: 'cat-agentui', version: '0.1.0' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport as any),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('连接 MCP 服务器超时(15 秒)')), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    try { await client.close(); } catch { /* ignore */ }
    try { await (transport as any).close?.(); } catch { /* ignore */ }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return client;
}

function getServerRow(serverId: string): ServerRow | undefined {
  return db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get();
}

/** Get a live cached client for a server, (re)connecting when needed. */
async function getClient(serverId: string, scopeId: string): Promise<Client> {
  const key = connectionKey(serverId, scopeId);
  const cached = connections.get(key);
  if (cached) return cached.client;

  const pending = connecting.get(key);
  if (pending) return pending.promise;

  const row = getServerRow(serverId);
  if (!row) throw new Error('MCP 服务器不存在');

  const promise = (async () => {
    const client = await connectClient(row);
    registerExitHook();
    // Auto-drop from cache when the underlying transport closes or errors,
    // so the next use reconnects.
    const drop = () => {
      const cur = connections.get(key);
      if (cur && cur.client === client) connections.delete(key);
    };
    client.onclose = drop;
    client.onerror = () => drop();
    connections.set(key, { serverId, client, connectedAt: now() });
    return client;
  })();
  connecting.set(key, { serverId, promise });
  try {
    return await promise;
  } finally {
    if (connecting.get(key)?.promise === promise) connecting.delete(key);
  }
}

async function dropConnections(serverId: string): Promise<void> {
  const matches = [...connections.entries()].filter(([, value]) => value.serverId === serverId);
  for (const [key] of matches) connections.delete(key);
  await Promise.all(matches.map(async ([, value]) => {
    try { await value.client.close(); } catch { /* ignore */ }
  }));
}

async function dropScopedConnection(serverId: string, scopeId: string): Promise<void> {
  const key = connectionKey(serverId, scopeId);
  const cached = connections.get(key);
  if (!cached) return;
  connections.delete(key);
  try { await cached.client.close(); } catch { /* ignore */ }
}

function namespacedToolName(
  serverName: string, serverId: string, toolName: string,
  routes: ReadonlyMap<string, ToolRoute>,
): string {
  let nsName = `${sanitize(serverName).slice(0, 24)}__${sanitize(toolName)}`.slice(0, 64);
  const existing = routes.get(nsName);
  if (existing && existing.serverId !== serverId) {
    // Two servers collide on the sanitized name — disambiguate with a short id suffix.
    const suffix = `_${sanitize(serverId).slice(0, 6)}`;
    nsName = `${nsName.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return nsName;
}

/**
 * List tools across the given servers (enabled rows only), namespaced per
 * server. Connection/listing failures are collected into `errors` instead of
 * throwing.
 */
export async function getToolsForServers(serverIds: string[], user: McpAccessUser): Promise<{
  tools: ToolDef[];
  errors: { serverId: string; name: string; error: string }[];
  capabilities: McpCapabilities;
}> {
  const tools: ToolDef[] = [];
  const errors: { serverId: string; name: string; error: string }[] = [];
  const routes = new Map<string, ToolRoute>();

  for (const serverId of new Set(serverIds)) {
    const row = getServerRow(serverId);
    if (!row || !canUseMcpServer(user, serverId)) continue;
    const toolStart = tools.length;
    try {
      const client = await getClient(serverId, user.id);
      const listed = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
      if (listed.tools.length > MAX_TOOLS_PER_TURN) {
        throw new Error(`工具数量超过 ${MAX_TOOLS_PER_TURN} 个限制`);
      }

      let definitionChars = 0;
      for (const tool of listed.tools) {
        definitionChars += tool.name.length + (tool.description?.length ?? 0)
          + JSON.stringify(tool.inputSchema ?? {}).length;
        if (definitionChars > MAX_TOOL_DEFINITION_CHARS) {
          throw new Error('工具定义总大小超过限制');
        }
        const nsName = namespacedToolName(row.name, serverId, tool.name, routes);
        routes.set(nsName, { serverId, originalName: tool.name });
        tools.push({
          name: nsName,
          description: tool.description ?? '',
          parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        });
      }
    } catch (err) {
      tools.length = toolStart;
      for (const [name, route] of routes) {
        if (route.serverId === serverId) routes.delete(name);
      }
      errors.push({ serverId, name: row.name, error: errMsg(err) });
      // The connection is likely dead — drop it so the next attempt reconnects.
      await dropScopedConnection(serverId, user.id);
    }
  }
  return { tools, errors, capabilities: { routes } };
}

/** Invoke a namespaced tool. Never throws — errors come back as isError results. */
export async function callTool(
  namespacedName: string,
  argsJson: string,
  capabilities: McpCapabilities,
  user: McpAccessUser,
  opts?: { timeoutMs?: number },
): Promise<{ result: string; isError: boolean }> {
  const route = capabilities.routes.get(namespacedName);
  if (!route) {
    return { result: `未找到工具「${namespacedName}」,对应的 MCP 服务器可能已断开、被禁用或已删除`, isError: true };
  }
  if (!canUseMcpServer(user, route.serverId)) {
    return { result: '当前账号已无权使用该 MCP 服务器,或服务器已被禁用', isError: true };
  }
  if (argsJson.length > MAX_TOOL_ARGS_CHARS) {
    return { result: '工具参数超过大小限制', isError: true };
  }

  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch { /* fall back to {} */ }

  try {
    const client = await getClient(route.serverId, user.id);
    const res = (await client.callTool(
      { name: route.originalName, arguments: args },
      undefined,
      { timeout: opts?.timeoutMs ?? CALL_TIMEOUT_MS },
    )) as any;

    const blocks: string[] = [];
    let resultChars = 0;
    const content = Array.isArray(res?.content) ? res.content : [];
    for (const block of content) {
      switch (block?.type) {
        case 'text':
          {
            const text = String(block.text ?? '');
            const remaining = Math.max(0, MAX_TOOL_RESULT_CHARS - resultChars);
            blocks.push(text.slice(0, remaining));
            resultChars += Math.min(text.length, remaining);
          }
          break;
        case 'image':
          blocks.push(`[image ${block.mimeType ?? 'unknown'}]`);
          break;
        case 'audio':
          blocks.push(`[audio ${block.mimeType ?? 'unknown'}]`);
          break;
        case 'resource':
          blocks.push(`[resource ${block.resource?.uri ?? ''}]`);
          break;
        case 'resource_link':
          blocks.push(`[resource ${block.uri ?? ''}]`);
          break;
        default:
          blocks.push(`[${String(block?.type ?? 'unknown')}]`);
      }
      if (resultChars >= MAX_TOOL_RESULT_CHARS) break;
    }
    let result = blocks.join('\n');
    if (result.length >= MAX_TOOL_RESULT_CHARS) result += '\n…(结果已截断)';
    return { result, isError: Boolean(res?.isError) };
  } catch (err) {
    return { result: errMsg(err), isError: true };
  }
}

/**
 * Force a fresh connection to a server, list its tools, and persist the
 * status/tool cache on the row. The fresh connection stays cached on success.
 */
export async function testServer(serverId: string): Promise<{
  ok: boolean;
  tools?: { name: string; description: string }[];
  error?: string;
}> {
  await dropConnections(serverId);
  const row = getServerRow(serverId);
  if (!row) return { ok: false, error: 'MCP 服务器不存在' };

  try {
    const client = await getClient(serverId, '__admin_test__');
    const listed = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
    if (listed.tools.length > MAX_TOOLS_PER_TURN) {
      throw new Error(`工具数量超过 ${MAX_TOOLS_PER_TURN} 个限制`);
    }
    const tools = listed.tools.map((t) => ({
      name: t.name.slice(0, 256), description: (t.description ?? '').slice(0, 4000),
    }));
    db.update(schema.mcpServers)
      .set({ lastStatus: 'ok', lastError: null, toolsCache: JSON.stringify(tools) })
      .where(eq(schema.mcpServers.id, serverId)).run();
    return { ok: true, tools };
  } catch (err) {
    const error = errMsg(err);
    db.update(schema.mcpServers)
      .set({ lastStatus: 'error', lastError: error })
      .where(eq(schema.mcpServers.id, serverId)).run();
    await dropConnections(serverId);
    return { ok: false, error };
  }
}

/** Close & drop any cached connection for a server (call after config edits/delete). */
export async function invalidateServer(serverId: string): Promise<void> {
  const pending = [...connecting.values()].filter((item) => item.serverId === serverId);
  for (const item of pending) {
    try { await item.promise; } catch { /* connection already failed */ }
  }
  await dropConnections(serverId);
}
