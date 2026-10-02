import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import {
  getAgentSettings,
  policyAllows,
  userWantsAgentTools,
} from './agent-settings.js';
import { canUseModel } from './model-access.js';
import { callWorkspaceTool, isWorkspaceTool } from './workspace.js';

/** Shared by API turns and CatBridge. Identity is supplied by the admitted
 * server run; arguments never choose a user, chat or filesystem root. */
export async function dispatchWorkspaceTool(
  context: {
    userId: string;
    chatId: string;
    modelId: string;
    signal: AbortSignal;
    allowedNames: Set<string>;
  },
  name: string,
  args: string,
) {
  context.signal.throwIfAborted();
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, context.userId))
    .get();
  const chat = db
    .select()
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.id, context.chatId),
        eq(schema.chats.userId, context.userId),
      ),
    )
    .get();
  const model = db
    .select()
    .from(schema.models)
    .where(eq(schema.models.id, context.modelId))
    .get();
  const provider =
    model &&
    db
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.id, model.providerId))
      .get();
  if (
    !user ||
    user.disabled ||
    !chat ||
    !model?.enabled ||
    !model.tools ||
    !provider?.enabled ||
    !canUseModel(user, model.id) ||
    !userWantsAgentTools(user.settings) ||
    !policyAllows(getAgentSettings().workspace, user) ||
    !context.allowedNames.has(name) ||
    !isWorkspaceTool(name)
  )
    return { result: '工作区工具未授权或权限已撤销', isError: true };
  return callWorkspaceTool(context.chatId, name, args);
}
