// A project workspace belongs to one user. Chat ids remain the public API;
// storage and locking resolve to the same scope on the server.
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema } from './db/index.js';
import { projectAccess } from './project-access.js';

export class WorkspaceError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function validId(id: string): string {
  if (!WORKSPACE_ID_RE.test(id)) throw new WorkspaceError('无效的工作区', 400);
  return id;
}

export interface WorkspaceScope {
  kind: 'chat' | 'project';
  key: string;
  root: string;
  projectId: string | null;
  userId: string | null;
}

export function privateWorkspaceRoot(chatId: string): string {
  return path.join(config.dataDir, 'workspaces', validId(chatId));
}

export function projectWorkspaceRoot(projectId: string, userId?: string): string {
  const root = path.join(config.dataDir, 'project-workspaces', validId(projectId));
  return userId === undefined ? root : path.join(root, validId(userId));
}

const scopes = new AsyncLocalStorage<Map<string, WorkspaceScope>>();

export function workspaceScope(chatId: string): WorkspaceScope {
  const pinned = scopes.getStore()?.get(chatId);
  if (pinned) return pinned;
  const root = privateWorkspaceRoot(chatId);
  const chat = db.select({ projectId: schema.chats.projectId, userId: schema.chats.userId })
    .from(schema.chats).where(eq(schema.chats.id, chatId)).get();
  const access = chat?.projectId ? projectAccess(chat.projectId, chat.userId) : null;
  if (chat && access?.project.sharedWorkspace) {
    return { kind: 'project', key: `project:${access.project.id}:${chat.userId}`,
      root: projectWorkspaceRoot(access.project.id, chat.userId), projectId: access.project.id, userId: chat.userId };
  }
  return { kind: 'chat', key: `chat:${chatId}`, root, projectId: null, userId: chat?.userId ?? null };
}

/** Pin the directory through awaits, including a queued lock, upload or sandbox
 * run. Changing the project setting affects subsequent operations. */
export async function withWorkspaceScope<T>(chatId: string, fn: () => T | Promise<T>): Promise<T> {
  if (scopes.getStore()?.has(chatId)) return fn();
  const scope = workspaceScope(chatId);
  const pinned = new Map(scopes.getStore());
  pinned.set(chatId, scope);
  return scopes.run(pinned, async () => {
    if (scope.kind === 'project') {
      // Lazy preparation also repairs projects enabled by an older release,
      // and imports a chat moved into the project without a server restart.
      const { importProjectWorkspace } = await import('./workspace.js');
      await importProjectWorkspace(chatId, scope);
    }
    return fn();
  });
}
