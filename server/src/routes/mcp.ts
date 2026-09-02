import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema, now, getSetting, setSetting } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth, requireAdmin } from '../auth.js';
import {
  allConfiguredSecretValues, decryptSecretRecord, encryptSecretRecord, redactSensitiveText,
} from '../secrets.js';
import { invalidateServer, testServer } from '../mcp/manager.js';
import { installPreset, presetStatuses } from '../mcp/presets.js';
import {
  accessibleMcpServers, accessUserIds, replaceMcpAccess,
} from '../mcp/access.js';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// SECURITY: env / headers hold credentials (bearer tokens, API keys). They are
// stored AES-256-GCM encrypted (like provider API keys) and are write-only:
// responses expose hasEnv/hasHeaders plus key names — never the values.
/** Key names only (values never leave the server). Decryption failure → []. */
function secretKeys(enc: string | null): string[] {
  if (!enc) return [];
  try {
    return Object.keys(decryptSecretRecord(enc));
  } catch {
    return [];
  }
}

const serverBodySchema = z.object({
  name: z.string().min(1).max(64),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().min(1).max(1024).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  accessMode: z.enum(['shared', 'restricted']).optional(),
  confirmCalls: z.boolean().optional(),
  allowedUserIds: z.array(z.string().max(64)).max(500).optional(),
});

type ServerRow = typeof schema.mcpServers.$inferSelect;

// The admin designates ONE server as the web-search provider. The composer
// shows it as a dedicated 联网搜索 toggle instead of an entry in the generic
// tools menu, and chats.ts adds a system hint so the model searches on demand.
export const SEARCH_SETTING_KEY = 'searchMcpServerId';

export function getSearchServerId(): string | null {
  return getSetting<string | null>(SEARCH_SETTING_KEY, null);
}

function getServerRow(id: string): ServerRow | undefined {
  return db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get();
}

/** Validate transport-specific required fields against the merged (row + patch) view. */
function transportFieldError(transport: string, command: string | null | undefined, url: string | null | undefined): string | null {
  if (transport === 'stdio' && !command) return 'stdio 服务器必须填写启动命令(command)';
  if ((transport === 'http' || transport === 'sse') && !url) return 'http/sse 服务器必须填写 URL';
  return null;
}

export async function mcpRoutes(app: FastifyInstance) {
  // Regular users: safe listing only — no command/args/env/url/headers leakage.
  app.get('/api/mcp/servers', async (req, reply) => {
    requireAuth(req, reply);
    const searchId = getSearchServerId();
    const secretValues = allConfiguredSecretValues();
    const rows = accessibleMcpServers(req.user!);
    return rows.map((r) => {
      const tools = parseJson<{ name: string; description: string }[]>(r.toolsCache, [])
        .map((tool) => ({
          name: redactSensitiveText(tool.name, secretValues),
          description: redactSensitiveText(tool.description, secretValues),
        }));
      return {
        id: r.id,
        name: r.name,
        transport: r.transport,
        enabled: Boolean(r.enabled),
        lastStatus: r.lastStatus,
        toolCount: tools.length,
        tools,
        isSearch: r.id === searchId,
        confirmCalls: Boolean(r.confirmCalls),
      };
    });
  });

  // Admin: full config, except secrets — env/headers values are never returned,
  // only hasEnv/hasHeaders and the key names.
  app.get('/api/admin/mcp', async (req, reply) => {
    requireAdmin(req, reply);
    const searchId = getSearchServerId();
    const secretValues = allConfiguredSecretValues();
    const rows = db.select().from(schema.mcpServers).all();
    return rows.map((r) => ({
      id: r.id,
      isSearch: r.id === searchId,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: parseJson<string[]>(r.args, []),
      url: r.url,
      hasEnv: !!r.envEnc,
      hasHeaders: !!r.headersEnc,
      envKeys: secretKeys(r.envEnc),
      headerKeys: secretKeys(r.headersEnc),
      enabled: Boolean(r.enabled),
      accessMode: r.accessMode,
      confirmCalls: Boolean(r.confirmCalls),
      lastStatus: r.lastStatus,
      lastError: r.lastError ? redactSensitiveText(r.lastError, secretValues) : null,
      toolsCache: parseJson<{ name: string; description: string }[]>(r.toolsCache, [])
        .map((tool) => ({
          name: redactSensitiveText(tool.name, secretValues),
          description: redactSensitiveText(tool.description, secretValues),
        })),
      allowedUserIds: accessUserIds(r.id),
      createdAt: r.createdAt,
    }));
  });

  app.post('/api/admin/mcp', async (req, reply) => {
    requireAdmin(req, reply);
    const body = serverBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误:请检查名称(1-64位)、传输类型及 URL 格式' });
    const d = body.data;
    const fieldError = transportFieldError(d.transport, d.command, d.url);
    if (fieldError) return reply.code(400).send({ error: fieldError });

    const id = newId();
    db.insert(schema.mcpServers).values({
      id,
      name: d.name,
      transport: d.transport,
      command: d.command ?? null,
      args: JSON.stringify(d.args ?? []),
      envEnc: encryptSecretRecord(d.env ?? {}),
      url: d.url ?? null,
      headersEnc: encryptSecretRecord(d.headers ?? {}),
      enabled: (d.enabled ?? true) ? 1 : 0,
      accessMode: d.accessMode ?? 'shared',
      confirmCalls: d.confirmCalls ? 1 : 0,
      createdAt: now(),
    }).run();
    replaceMcpAccess(id, d.allowedUserIds ?? []);
    return { id };
  });

  app.patch('/api/admin/mcp/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getServerRow(id);
    if (!row) return reply.code(404).send({ error: 'MCP 服务器不存在' });

    const body = serverBodySchema.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误:请检查名称(1-64位)、传输类型及 URL 格式' });
    const d = body.data;

    const transport = d.transport ?? row.transport;
    const command = d.command !== undefined ? d.command : row.command;
    const url = d.url !== undefined ? d.url : row.url;
    const fieldError = transportFieldError(transport, command, url);
    if (fieldError) return reply.code(400).send({ error: fieldError });

    const patch: Record<string, unknown> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.transport !== undefined) patch.transport = d.transport;
    if (d.command !== undefined) patch.command = d.command;
    if (d.args !== undefined) patch.args = JSON.stringify(d.args);
    // Secrets: undefined = keep, empty object = clear, otherwise encrypt and replace.
    if (d.env !== undefined) patch.envEnc = encryptSecretRecord(d.env);
    if (d.url !== undefined) patch.url = d.url;
    if (d.headers !== undefined) patch.headersEnc = encryptSecretRecord(d.headers);
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;
    if (d.accessMode !== undefined) patch.accessMode = d.accessMode;
    if (d.confirmCalls !== undefined) patch.confirmCalls = d.confirmCalls ? 1 : 0;

    if (Object.keys(patch).length) {
      db.update(schema.mcpServers).set(patch).where(eq(schema.mcpServers.id, id)).run();
    }
    if (d.allowedUserIds !== undefined) replaceMcpAccess(id, d.allowedUserIds);
    await invalidateServer(id);
    return { ok: true };
  });

  app.delete('/api/admin/mcp/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getServerRow(id);
    if (!row) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    await invalidateServer(id);
    db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id)).run();
    if (getSearchServerId() === id) setSetting(SEARCH_SETTING_KEY, null);
    return { ok: true };
  });

  // Designate (or clear) the web-search server.
  app.put('/api/admin/mcp/search', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({ serverId: z.string().max(64).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const { serverId } = body.data;
    if (serverId !== null && !getServerRow(serverId)) {
      return reply.code(404).send({ error: 'MCP 服务器不存在' });
    }
    setSetting(SEARCH_SETTING_KEY, serverId);
    return { ok: true };
  });

  // One-click presets: install a known npm MCP server locally and wire it up.
  app.get('/api/admin/mcp/presets', async (req, reply) => {
    requireAdmin(req, reply);
    return presetStatuses();
  });

  app.post('/api/admin/mcp/presets/:presetId/install', async (req, reply) => {
    requireAdmin(req, reply);
    const { presetId } = req.params as { presetId: string };
    const body = z.object({
      apiKey: z.string().trim().min(1).max(512).optional(),
      reinstall: z.boolean().optional(),
      setAsSearch: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      return await installPreset(presetId, body.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(message === '未知的预设' ? 404 : 500).send({ error: message });
    }
  });

  app.post('/api/admin/mcp/:id/test', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getServerRow(id);
    if (!row) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    return testServer(id); // 200 even when ok:false — the payload carries the error
  });
}
