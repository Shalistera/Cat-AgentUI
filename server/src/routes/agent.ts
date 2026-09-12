// Agent 能力 settings (admin) and the per-user capability flags the composer
// uses to decide which buttons to show.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getAgentSettings, policyAllows, saveAgentSettings, userWantsAgentTools } from '../agent-settings.js';
import { sandboxAvailableFor } from '../sandbox/tool.js';
import { getSandboxSettings } from '../sandbox/settings.js';
import { skillsFor } from '../skills.js';

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
      sandboxConfirm: getSandboxSettings().confirm,
      skills: on && policyAllows(a.skills, user) ? skillsFor(user).length : 0,
      subagent: on && policyAllows(a.subagent, user),
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
    return { settings: saveAgentSettings(body.data) };
  });
}
