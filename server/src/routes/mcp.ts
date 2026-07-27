import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId, encryptSecret, decryptSecret } from '../crypto.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { invalidateServer, testServer } from '../mcp/manager.js';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// SECURITY: env / headers hold credentials (bearer tokens, API keys). They are
// stored AES-256-GCM encrypted (like provider API keys) and are write-only:
// responses expose hasEnv/hasHeaders plus key names — never the values.
function encryptRecord(rec: Record<string, string>): string | null {
  return Object.keys(rec).length ? encryptSecret(JSON.stringify(rec)) : null;
}

/** Key names only (values never leave the server). Decryption failure → []. */
function secretKeys(enc: string | null): string[] {
  if (!enc) return [];
  try {
    const rec = JSON.parse(decryptSecret(enc)) as Record<string, string>;
    return Object.keys(rec);
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
});

type ServerRow = typeof schema.mcpServers.$inferSelect;

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
    const rows = db.select().from(schema.mcpServers).all();
    return rows.map((r) => {
      const tools = parseJson<{ name: string; description: string }[]>(r.toolsCache, []);
      return {
        id: r.id,
        name: r.name,
        transport: r.transport,
        enabled: Boolean(r.enabled),
        lastStatus: r.lastStatus,
        toolCount: tools.length,
        tools,
      };
    });
  });

  // Admin: full config, except secrets — env/headers values are never returned,
  // only hasEnv/hasHeaders and the key names.
  app.get('/api/admin/mcp', async (req, reply) => {
    requireAdmin(req, reply);
    const rows = db.select().from(schema.mcpServers).all();
    return rows.map((r) => ({
      id: r.id,
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
      lastStatus: r.lastStatus,
      lastError: r.lastError,
      toolsCache: parseJson<{ name: string; description: string }[]>(r.toolsCache, []),
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
      envEnc: encryptRecord(d.env ?? {}),
      url: d.url ?? null,
      headersEnc: encryptRecord(d.headers ?? {}),
      enabled: (d.enabled ?? true) ? 1 : 0,
      createdAt: now(),
    }).run();
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
    if (d.env !== undefined) patch.envEnc = encryptRecord(d.env);
    if (d.url !== undefined) patch.url = d.url;
    if (d.headers !== undefined) patch.headersEnc = encryptRecord(d.headers);
    if (d.enabled !== undefined) patch.enabled = d.enabled ? 1 : 0;

    if (Object.keys(patch).length) {
      db.update(schema.mcpServers).set(patch).where(eq(schema.mcpServers.id, id)).run();
    }
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
    return { ok: true };
  });

  app.post('/api/admin/mcp/:id/test', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const row = getServerRow(id);
    if (!row) return reply.code(404).send({ error: 'MCP 服务器不存在' });
    return testServer(id); // 200 even when ok:false — the payload carries the error
  });
}
