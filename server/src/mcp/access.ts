import { and, asc, eq, or } from 'drizzle-orm';
import { db, now, schema } from '../db/index.js';

export interface McpAccessUser {
  id: string;
  role: string;
}

type ServerRow = typeof schema.mcpServers.$inferSelect;

/** Admins see every server; regular users see shared and explicitly granted ones. */
export function accessibleMcpServers(user: McpAccessUser): ServerRow[] {
  if (user.role === 'admin') {
    return db.select().from(schema.mcpServers).orderBy(asc(schema.mcpServers.createdAt)).all();
  }
  return db.select({ server: schema.mcpServers })
    .from(schema.mcpServers)
    .leftJoin(schema.mcpServerAccess, and(
      eq(schema.mcpServerAccess.serverId, schema.mcpServers.id),
      eq(schema.mcpServerAccess.userId, user.id),
    ))
    .where(or(
      eq(schema.mcpServers.accessMode, 'shared'),
      eq(schema.mcpServerAccess.userId, user.id),
    ))
    .orderBy(asc(schema.mcpServers.createdAt)).all()
    .map((r) => r.server);
}

/** Re-check a capability at the point of use, including enabled state. */
export function canUseMcpServer(user: McpAccessUser, serverId: string): boolean {
  const server = db.select({
    enabled: schema.mcpServers.enabled,
    accessMode: schema.mcpServers.accessMode,
  })
    .from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get();
  if (!server?.enabled) return false;
  const account = db.select({ role: schema.users.role, disabled: schema.users.disabled })
    .from(schema.users).where(eq(schema.users.id, user.id)).get();
  if (!account || account.disabled) return false;
  if (account.role === 'admin') return true;
  if (server.accessMode === 'shared') return true;
  return !!db.select({ userId: schema.mcpServerAccess.userId })
    .from(schema.mcpServerAccess)
    .where(and(
      eq(schema.mcpServerAccess.serverId, serverId),
      eq(schema.mcpServerAccess.userId, user.id),
    )).get();
}

/** Validate and de-duplicate a chat's requested server list. */
export function validateMcpSelection(user: McpAccessUser, requested: string[]): {
  allowed: string[];
  denied: string[];
} {
  const unique = [...new Set(requested)];
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const id of unique) (canUseMcpServer(user, id) ? allowed : denied).push(id);
  return { allowed, denied };
}

export function accessUserIds(serverId: string): string[] {
  return db.select({ userId: schema.mcpServerAccess.userId })
    .from(schema.mcpServerAccess)
    .where(eq(schema.mcpServerAccess.serverId, serverId)).all()
    .map((r) => r.userId);
}

/** Replace the ordinary-user grant set. Admin access is implicit, not stored. */
export function replaceMcpAccess(serverId: string, requestedUserIds: string[]): void {
  const wanted = [...new Set(requestedUserIds)];
  const valid = new Set(db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.role, 'user')).all().map((u) => u.id));
  const userIds = wanted.filter((id) => valid.has(id));

  db.transaction((tx) => {
    tx.delete(schema.mcpServerAccess)
      .where(eq(schema.mcpServerAccess.serverId, serverId)).run();
    if (userIds.length) {
      tx.insert(schema.mcpServerAccess).values(userIds.map((userId) => ({
        serverId, userId, createdAt: now(),
      }))).run();
    }
  });
}
