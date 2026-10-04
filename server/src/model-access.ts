import { and, eq, inArray } from 'drizzle-orm';
import { db, now, schema } from './db/index.js';

export interface ModelAccessUser {
  id: string;
  role: string;
}

/** Direct image-model access. Agent image generation has a separate explicit grant. */
export function imageModelsAllowed(user: { role: string; allowImageModels: number }): boolean {
  return user.role === 'admin' || !!user.allowImageModels;
}

/** 绘图工坊访问权限 — gates the /api/images feature surface. */
export function imageWorkshopAllowed(user: { role: string; allowImages: number }): boolean {
  return user.role === 'admin' || !!user.allowImages;
}

/** Provider types that run on the operator's own subscription (本地 Claude
 * Code): admins only, whatever a model's access mode or grants say. */
const ADMIN_ONLY_PROVIDER_TYPES = ['claude-code'];

export function providerAllowed(user: { role: string }, providerType: string): boolean {
  return user.role === 'admin' || !ADMIN_ONLY_PROVIDER_TYPES.includes(providerType);
}

/** Model db-ids served by an admin-only provider. */
export function adminOnlyModelIds(): Set<string> {
  return new Set(db.select({ id: schema.models.id }).from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(inArray(schema.providers.type, ADMIN_ONLY_PROVIDER_TYPES)).all()
    .map((r) => r.id));
}

/** Model db-ids explicitly granted to this user. */
export function grantedModelIds(userId: string): Set<string> {
  return new Set(db.select({ modelId: schema.modelAccess.modelId })
    .from(schema.modelAccess)
    .where(eq(schema.modelAccess.userId, userId)).all()
    .map((r) => r.modelId));
}

/** Re-check at the point of use: shared models pass, restricted ones need a grant. */
export function canUseModel(user: ModelAccessUser, modelDbId: string): boolean {
  if (user.role === 'admin') return true;
  const row = db.select({ accessMode: schema.models.accessMode, providerType: schema.providers.type })
    .from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(eq(schema.models.id, modelDbId)).get();
  if (!row || !providerAllowed(user, row.providerType)) return false;
  if (row.accessMode === 'shared') return true;
  return !!db.select({ userId: schema.modelAccess.userId })
    .from(schema.modelAccess)
    .where(and(
      eq(schema.modelAccess.modelId, modelDbId),
      eq(schema.modelAccess.userId, user.id),
    )).get();
}

/**
 * Filter for model list queries: keeps rows a user may see. Rows must carry
 * the model's db id and accessMode.
 */
export function accessibleOnly<T extends { id: string; accessMode: string }>(
  rows: T[], user: ModelAccessUser,
): T[] {
  if (user.role === 'admin') return rows;
  const granted = grantedModelIds(user.id);
  const adminOnly = adminOnlyModelIds();
  return rows.filter((r) => !adminOnly.has(r.id) && (r.accessMode === 'shared' || granted.has(r.id)));
}

export function accessUserIds(modelDbId: string): string[] {
  return db.select({ userId: schema.modelAccess.userId })
    .from(schema.modelAccess)
    .where(eq(schema.modelAccess.modelId, modelDbId)).all()
    .map((r) => r.userId);
}

/** Replace the ordinary-user grant set. Admin access is implicit, not stored. */
export function replaceModelAccess(modelDbId: string, requestedUserIds: string[]): void {
  const wanted = [...new Set(requestedUserIds)];
  const valid = new Set(db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.role, 'user')).all().map((u) => u.id));
  const userIds = wanted.filter((id) => valid.has(id));

  db.transaction((tx) => {
    tx.delete(schema.modelAccess)
      .where(eq(schema.modelAccess.modelId, modelDbId)).run();
    if (userIds.length) {
      tx.insert(schema.modelAccess).values(userIds.map((userId) => ({
        modelId: modelDbId, userId, createdAt: now(),
      }))).run();
    }
  });
}
