// Agent 能力 settings (admin) and the per-user capability flags the composer
// uses to decide which buttons to show.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getAgentSettings, policyAllows, saveAgentSettings, userWantsAgentTools } from '../agent-settings.js';
import { convertAvailableFor, sandboxAvailableFor } from '../sandbox/tool.js';
import { getSandboxSettings } from '../sandbox/settings.js';
import { skillsFor } from '../skills.js';
import { imageToolModelsFor } from '../image-tool.js';
import { monthlySearchQueries, searchProvider } from '../web-search.js';
import { FETCH_PROVIDER_TYPES } from '../web-fetch.js';
import { getSearchServerId } from './mcp.js';
import { db, schema } from '../db/index.js';
import { eq, inArray } from 'drizzle-orm';
import { getAdapter } from '../providers/index.js';

const policySchema = z.object({
  enabled: z.boolean().optional(),
  accessMode: z.enum(['shared', 'restricted']).optional(),
  allowedUserIds: z.array(z.string().max(64)).max(500).optional(),
});

export async function agentRoutes(app: FastifyInstance) {
  app.get('/api/agent/capabilities', async (req, reply) => {
    requireAuth(req, reply);
    const user = req.user!;
    const a = getAgentSettings();
    const on = userWantsAgentTools(user.settings);
    const workspace = on && policyAllows(a.workspace, user);
    return {
      agentTools: on,
      dataComparison: on && policyAllows(a.dataComparison, user),
      workspace,
      sandbox: workspace && sandboxAvailableFor(user),
      convert: workspace && convertAvailableFor(user),
      sandboxConfirm: getSandboxSettings().confirm,
      skills: on && policyAllows(a.skills, user) ? skillsFor(user).length : 0,
      subagent: on && policyAllows(a.subagent, user),
      imageGeneration: imageToolModelsFor(user).length > 0,
    };
  });

  app.get('/api/admin/agent', async (req, reply) => {
    requireAdmin(req, reply);
    return {
      settings: getAgentSettings(),
      limits: {
        workspaceBytes: config.maxWorkspaceBytes, workspaceFileBytes: config.maxWorkspaceFileBytes, workspaceFiles: config.maxWorkspaceFiles,
        toolIterations: config.maxToolIterations,
      },
      webSearch: {
        monthQueries: monthlySearchQueries(),
        activeProviderId: searchProvider()?.id ?? null,
        fallbackMcp: (() => {
          const id = getSearchServerId();
          const row = id ? db.select({ name: schema.mcpServers.name, enabled: schema.mcpServers.enabled }).from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get() : undefined;
          return row ? { name: row.name, enabled: !!row.enabled } : null;
        })(),
        providers: db.select({ id: schema.providers.id, name: schema.providers.name, enabled: schema.providers.enabled, useVertex: schema.providers.useVertex })
          .from(schema.providers).where(eq(schema.providers.type, 'gemini')).all()
          .map((p) => ({ id: p.id, name: p.name, enabled: !!p.enabled, vertex: !!p.useVertex })),
        fetchProviders: db.select({ id: schema.providers.id, name: schema.providers.name, type: schema.providers.type, enabled: schema.providers.enabled })
          .from(schema.providers).where(inArray(schema.providers.type, FETCH_PROVIDER_TYPES)).all()
          .map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: !!p.enabled })),
      },
    };
  });

  app.put('/api/admin/agent', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({
      dataComparison: policySchema.optional(),
      workspace: policySchema.optional(),
      skills: policySchema.optional(),
      imageGeneration: policySchema.extend({
        modelIds: z.array(z.string().min(1).max(64)).max(50).optional(),
        maxPerTurn: z.number().int().min(1).max(10).optional(),
        dailyLimit: z.number().int().min(0).max(10000).optional(),
      }).optional(),
      subagent: policySchema.extend({
        modelId: z.string().max(64).optional(),
        maxPerTurn: z.number().int().optional(),
        maxIterations: z.number().int().optional(),
        timeoutSec: z.number().int().optional(),
        maxResultChars: z.number().int().optional(),
        allowSandbox: z.boolean().optional(),
      }).optional(),
      webSearch: policySchema.extend({
        providerId: z.string().max(64).optional(),
        model: z.string().max(128).optional(),
        fallbackProviderId: z.string().max(64).optional(),
        fallbackModel: z.string().max(128).optional(),
        mcpFallback: z.boolean().optional(),
        allowVertexAgentTools: z.boolean().optional(),
        maxPerTurn: z.number().int().min(0).max(20).optional(),
        fetchMaxPerTurn: z.number().int().min(0).max(20).optional(),
        fastMaxPerTurn: z.number().int().min(0).max(20).optional(),
        fastFetchMaxPerTurn: z.number().int().min(0).max(20).optional(),
        monthlyLimit: z.number().int().min(0).max(10_000_000).optional(),
        dailyLimit: z.number().int().min(0).max(100_000).optional(),
        adminDailyLimit: z.number().int().min(0).max(100_000).optional(),
        fetchEnabled: z.boolean().optional(),
        fetchProviderId: z.string().max(64).optional(),
        fetchModel: z.string().max(128).optional(),
        fetchDailyLimit: z.number().int().min(0).max(100_000).optional(),
        fetchAdminDailyLimit: z.number().int().min(0).max(100_000).optional(),
      }).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    if (body.data.imageGeneration) {
      const images = { ...getAgentSettings().imageGeneration, ...body.data.imageGeneration };
      if (images.enabled && !images.modelIds.length) return reply.code(400).send({ error: '请为图片生成工具至少选择一个图片模型' });
      if (body.data.imageGeneration.modelIds?.length) {
        const ids = [...new Set(body.data.imageGeneration.modelIds)];
        const rows = db.select({ id: schema.models.id, imageGen: schema.models.imageGen, providerType: schema.providers.type })
          .from(schema.models).innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
          .where(inArray(schema.models.id, ids)).all();
        if (rows.length !== ids.length || rows.some((r) => r.providerType === 'novelai' || !r.imageGen || !getAdapter(r.providerType).generateImages)) {
          return reply.code(400).send({ error: '图片生成工具只能选择仍然存在且支持图片生成的模型' });
        }
      }
    }
    for (const id of [body.data.webSearch?.providerId, body.data.webSearch?.fallbackProviderId]) {
      if (!id) continue;
      const row = db.select({ type: schema.providers.type }).from(schema.providers).where(eq(schema.providers.id, id)).get();
      if (row?.type !== 'gemini') return reply.code(400).send({ error: '联网搜索只能选择 Gemini 服务商' });
    }
    const geminiId = /^gemini-[\w.-]+$/i;
    if (body.data.webSearch?.model !== undefined && !geminiId.test(body.data.webSearch.model.trim())) {
      return reply.code(400).send({ error: '搜索模型请填写 Gemini 模型 ID,例如 gemini-3.5-flash-lite' });
    }
    if (body.data.webSearch?.fetchProviderId !== undefined || body.data.webSearch?.fetchModel !== undefined) {
      // Judged together: a model ID only means something on its provider.
      const ws = { ...getAgentSettings().webSearch, ...body.data.webSearch };
      const fetchModel = ws.fetchModel.trim();
      const type = ws.fetchProviderId
        ? db.select({ type: schema.providers.type }).from(schema.providers).where(eq(schema.providers.id, ws.fetchProviderId)).get()?.type
        : 'gemini';
      if (!type || !FETCH_PROVIDER_TYPES.includes(type)) {
        return reply.code(400).send({ error: '读网页的服务商只能选择 Gemini、Anthropic 或 OpenAI 兼容服务商' });
      }
      if (type === 'gemini' && fetchModel && !geminiId.test(fetchModel)) {
        return reply.code(400).send({ error: '读网页的模型请填写 Gemini 模型 ID;留空表示与搜索模型相同' });
      }
      if (type !== 'gemini' && !fetchModel) {
        return reply.code(400).send({ error: '选择非 Gemini 服务商读网页时,请填写读网页的模型 ID,例如 claude-haiku-5-5' });
      }
    }
    if (body.data.webSearch?.fallbackModel && !geminiId.test(body.data.webSearch.fallbackModel.trim())) {
      return reply.code(400).send({ error: '备用搜索模型请填写 Gemini 模型 ID,例如 gemini-3.1-flash-lite;留空表示不用' });
    }
    return { settings: saveAgentSettings(body.data) };
  });
}
