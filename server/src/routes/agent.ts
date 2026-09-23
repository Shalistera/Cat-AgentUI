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
    };
  });

  app.put('/api/admin/agent', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({
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
        if (rows.length !== ids.length || rows.some((r) => !r.imageGen || !getAdapter(r.providerType).generateImages)) {
          return reply.code(400).send({ error: '图片生成工具只能选择仍然存在且支持图片生成的模型' });
        }
      }
    }
    return { settings: saveAgentSettings(body.data) };
  });
}
