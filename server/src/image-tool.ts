// Image generation as a capability of a normal chat. The admin's explicit
// tool allowlist grants use here without exposing models in the direct picker.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema, today } from './db/index.js';
import { getAgentSettings, policyAllows, userWantsAgentTools, type AgentUser } from './agent-settings.js';
import { config } from './config.js';
import { getAdapter, toRuntimeConfig } from './providers/index.js';
import { tryAcquireImageJob } from './admission.js';
import { checkModelLimit, checkQuota, modelLimitReason, quotaBlockMessage } from './quota.js';
import { quotaErrorMessage, tryReserveStorage } from './storage.js';
import { saveGeneratedImage } from './routes/images.js';
import { recordUsage } from './usage.js';
import { allConfiguredSecretValues, redactSensitiveText } from './secrets.js';
import type { MessagePart, ProviderFailover, ProviderRetry, ToolDef, UsageInfo } from './types.js';

export const GENERATE_IMAGE_TOOL = 'generate_image';
type ImageToolUser = AgentUser & { settings?: string };
type ImagePart = Extract<MessagePart, { type: 'image' }>;

export function imageToolModelsFor(user: ImageToolUser) {
  const settings = getAgentSettings().imageGeneration;
  if (!userWantsAgentTools(user.settings) || !policyAllows(settings, user) || !settings.modelIds.length) return [];
  const rows = db.select({ model: schema.models, provider: schema.providers }).from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(and(inArray(schema.models.id, settings.modelIds), eq(schema.models.imageGen, 1),
      eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1))).all();
  return settings.modelIds.flatMap((id) => {
    const row = rows.find((r) => r.model.id === id);
    return row && getAdapter(row.provider.type).generateImages ? [row] : [];
  });
}

export function imageToolDefinition(models: ReturnType<typeof imageToolModelsFor>): ToolDef {
  return {
    name: GENERATE_IMAGE_TOOL,
    description: '根据完整的画面描述生成一张图片,直接展示在当前对话中。适用于插画、海报、封面、概念图等实际图片创作;每次调用生成一张。模型只能从管理员为本工具配置的列表中选择。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整的图片要求,包含主体、构图、风格、画面文字等。本工具不接收对话历史,请把必要上下文写在这里。' },
        model_id: { type: 'string', enum: models.map((r) => r.model.id), description: '图片模型 ID,省略则使用列表中的第一个模型。' },
        size: { type: 'string', description: '可选的图片尺寸,如 1024x1024;不确定模型支持的尺寸时省略。' },
        quality: { type: 'string', description: '可选的图片质量参数;不确定模型支持的取值时省略。' },
      },
      required: ['prompt'], additionalProperties: false,
    },
  };
}

export function buildImageToolPrompt(models: ReturnType<typeof imageToolModelsFor>): string {
  return [
    '[图片生成]',
    '你可以调用 generate_image 生成图片,无需用户切换当前聊天模型。用户要求画图、配图或制作图片时,按需求直接调用;不要只交付绘图提示词或假装图片已经生成。普通文字任务不必生成图片。此工具由管理员单独授权,不依赖工作区、命令执行、绘图工坊入口或图片模型在用户模型列表中的可见权限。',
    '这是一项文生图工具,不会自动读取聊天历史或参考图片,不要声称已经按上传图片做了精确编辑。把需要的画面内容、风格、文字等写进 prompt。每次生成一张,不要为了重试同一需求无理由重复调用。',
    `可用的图片模型(第一个为默认):\n${models.map(({ model }) => `- ${JSON.stringify(model.id)}: ${JSON.stringify(model.displayName || model.modelId)}${model.description ? ` — ${JSON.stringify(model.description)}` : ''}`).join('\n')}`,
    '调用成功后图片会自动显示在对话里;简短说明结果即可,不要再重复嵌入同一图片。需要提供链接时直接使用工具返回的图片地址。工具失败或只返回文字时如实说明,不能声称已出图。',
  ].join('\n');
}

const argsSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  model_id: z.string().min(1).max(64).optional(),
  size: z.string().max(20).optional(),
  quality: z.string().max(20).optional(),
}).strict();

export async function callImageTool(ctx: {
  userId: string; chatId: string; messageId: string; attempt: number; signal: AbortSignal;
  onRetry?: (retry: ProviderRetry | null) => void;
  onFailover?: (info: ProviderFailover) => void;
}, argsJson: string): Promise<{ result: string; isError: boolean; images: ImagePart[] }> {
  const fail = (result: string) => ({ result, isError: true, images: [] });
  let input: unknown;
  try { input = JSON.parse(argsJson); } catch { return fail('图片生成参数不是有效的 JSON'); }
  const parsed = argsSchema.safeParse(input);
  if (!parsed.success) return fail('图片生成参数无效:请提供 1–8000 字的 prompt 和可选的 model_id、size、quality');

  // Re-read grants at execution time: tools in the prompt are only a snapshot.
  const user = db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).get();
  if (!user || user.disabled) return fail('当前账号不可用');
  const chat = db.select({ id: schema.chats.id }).from(schema.chats)
    .where(and(eq(schema.chats.id, ctx.chatId), eq(schema.chats.userId, user.id))).get();
  if (!chat) return fail('对话不存在或无权访问');
  const candidates = imageToolModelsFor(user);
  const picked = parsed.data.model_id ? candidates.find((r) => r.model.id === parsed.data.model_id) : candidates[0];
  if (!picked) return fail('图片生成工具未开放,或所选图片模型不在管理员配置的可用列表中');
  if (ctx.attempt > getAgentSettings().imageGeneration.maxPerTurn) return fail('本轮已达到图片生成调用次数上限');
  const { model, provider } = picked;
  // Deliberately no canUseModel/imageModelsAllowed/imageWorkshopAllowed here:
  // the tool's explicit policy is the authorization. Cost limits still apply.
  const quota = checkQuota(user.id);
  if (!quota.ok) return fail(quotaBlockMessage(quota));
  const limit = checkModelLimit(user, model);
  if (!limit.ok) return fail(modelLimitReason(model, limit));
  const admission = tryAcquireImageJob(user.id, model.id);
  if (!admission.ok) return fail(admission.reason === 'model-busy' ? '该图片模型正在生成中,请等待完成' : '图片生成并发数已达上限');
  const reserved = tryReserveStorage(user.id, 'image', config.maxGeneratedImageBytes);
  if (!reserved.ok) { admission.lease.release(); return fail(quotaErrorMessage('image', reserved.reason)); }

  const t0 = Date.now();
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]);
  const secrets = allConfiguredSecretValues();
  let usage: UsageInfo | undefined;
  let usageId: string | null = null;
  const images: ImagePart[] = [];
  try {
    signal.throwIfAborted();
    const cfg = toRuntimeConfig(provider);
    // Reserve a durable usage row before provider I/O. Checking and inserting
    // in one transaction makes the daily cap survive restarts and concurrent
    // requests to different image models. Provider retries share this one row.
    const dailyLimit = getAgentSettings().imageGeneration.dailyLimit;
    usageId = db.transaction((tx) => {
      if (user.role !== 'admin' && dailyLimit > 0) {
        const used = tx.select({ n: sql<number>`count(*)` }).from(schema.usageLog)
          .where(and(eq(schema.usageLog.userId, user.id), eq(schema.usageLog.kind, 'image_tool'), eq(schema.usageLog.day, today()))).get()?.n ?? 0;
        if (used >= dailyLimit) return null;
      }
      return recordUsage({ userId: user.id, chatId: ctx.chatId, messageId: ctx.messageId,
        providerId: provider.id, providerType: provider.type, model: model.modelId, kind: 'image_tool' });
    });
    if (!usageId) return fail(`图片生成工具今日调用次数已达上限(${dailyLimit} 次),按服务器时间次日 0 点恢复`);
    const generated = await getAdapter(provider.type).generateImages!(cfg, {
      model: model.modelId, prompt: parsed.data.prompt, size: parsed.data.size, quality: parsed.data.quality,
      n: 1, signal, onRetry: ctx.onRetry, onFailover: ctx.onFailover,
    });
    usage = generated.images[0]?.usage ?? generated.usage;
    signal.throwIfAborted();
    if (!generated.images.length) return fail(generated.text ? `未生成图片,图片模型回复:${redactSensitiveText(generated.text, secrets)}` : '图片模型未返回图片');
    const img = generated.images[0];
    const saved = await saveGeneratedImage({
      userId: user.id, providerId: provider.id, model: model.modelId,
      prompt: parsed.data.prompt, size: parsed.data.size ?? null, durationMs: Date.now() - t0, img, source: 'chat',
    });
    images.push({ type: 'image', imageId: saved.id, mime: img.mime });
    return { result: `已生成 1 张图片,已在当前对话中展示。图片地址:/api/images/${saved.id}/file${generated.text ? `\n图片模型说明:${redactSensitiveText(generated.text, secrets)}` : ''}`, isError: false, images };
  } catch (err) {
    const message = ctx.signal.aborted ? '图片生成已停止'
      : signal.aborted ? '图片生成超时(超过 5 分钟)'
      : `图片生成失败:${redactSensitiveText(err instanceof Error ? err.message : String(err), secrets)}`;
    return fail(message);
  } finally {
    reserved.reservation.release();
    admission.lease.release();
    if (usageId) db.update(schema.usageLog).set({
      images: images.length, promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? ((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)), durationMs: Date.now() - t0,
    }).where(eq(schema.usageLog.id, usageId)).run();
  }
}
