import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { invalidateServer, testServer } from '../mcp/manager.js';

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
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

  // Admin: full rows with JSON fields parsed.
  app.get('/api/admin/mcp', async (req, reply) => {
    requireAdmin(req, reply);
    const rows = db.select().from(schema.mcpServers).all();
    return rows.map((r) => ({
      ...r,
      enabled: Boolean(r.enabled),
      args: parseJson<string[]>(r.args, []),
      env: parseJson<Record<string, string>>(r.env, {}),
      headers: parseJson<Record<string, string>>(r.headers, {}),
      toolsCache: parseJson<{ name: string; description: string }[]>(r.toolsCache, []),
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
      env: JSON.stringify(d.env ?? {}),
      url: d.url ?? null,
      headers: JSON.stringify(d.headers ?? {}),
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
    if (d.env !== undefined) patch.env = JSON.stringify(d.env);
    if (d.url !== undefined) patch.url = d.url;
    if (d.headers !== undefined) patch.headers = JSON.stringify(d.headers);
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
