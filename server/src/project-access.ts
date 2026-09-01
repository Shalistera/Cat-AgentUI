import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db, now, schema } from './db/index.js';

export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type ProjectAccessMode = 'private' | 'shared' | 'restricted';
export type MemberRole = 'editor' | 'viewer';

type ProjectRow = typeof schema.projects.$inferSelect;

export interface ProjectAccess {
  project: ProjectRow;
  role: ProjectRole;
}

/**
 * Resolve what `userId` may do with a project, or null when the project is
 * invisible to them. Owner > explicit member grant > 'shared' read access.
 * Admins are deliberately NOT special-cased: sharing is the owner's call.
 */
export function projectAccess(projectId: string, userId: string): ProjectAccess | null {
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return null;
  if (project.userId === userId) return { project, role: 'owner' };
  const member = db.select({ role: schema.projectMembers.role }).from(schema.projectMembers)
    .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, userId))).get();
  if (member) return { project, role: member.role === 'editor' ? 'editor' : 'viewer' };
  if (project.accessMode === 'shared') return { project, role: 'viewer' };
  return null;
}

export function canUseProject(projectId: string, userId: string): boolean {
  return projectAccess(projectId, userId) !== null;
}

export function canEditProject(role: ProjectRole): boolean {
  return role === 'owner' || role === 'editor';
}

/** Every project the user owns or has been let into, newest activity first. */
export function accessibleProjects(userId: string): { project: ProjectRow; role: ProjectRole }[] {
  const rows = db.select({ project: schema.projects, memberRole: schema.projectMembers.role })
    .from(schema.projects)
    .leftJoin(schema.projectMembers, and(
      eq(schema.projectMembers.projectId, schema.projects.id),
      eq(schema.projectMembers.userId, userId),
    ))
    .where(or(
      eq(schema.projects.userId, userId),
      eq(schema.projects.accessMode, 'shared'),
      eq(schema.projectMembers.userId, userId),
    ))
    .orderBy(desc(schema.projects.updatedAt)).all();
  return rows.map((r) => ({
    project: r.project,
    role: r.project.userId === userId ? 'owner'
      : r.memberRole === 'editor' ? 'editor' : 'viewer',
  }));
}

export interface ProjectMemberDto {
  userId: string;
  username: string;
  displayName: string | null;
  role: MemberRole;
}

export function projectMembers(projectId: string): ProjectMemberDto[] {
  return db.select({
    userId: schema.projectMembers.userId,
    username: schema.users.username,
    displayName: schema.users.displayName,
    role: schema.projectMembers.role,
  }).from(schema.projectMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.projectMembers.userId))
    .where(eq(schema.projectMembers.projectId, projectId))
    .orderBy(schema.projectMembers.createdAt).all()
    .map((r) => ({ ...r, role: r.role === 'editor' ? 'editor' : 'viewer' }));
}

export function projectMemberCounts(projectIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!projectIds.length) return out;
  for (const r of db.select({ projectId: schema.projectMembers.projectId, n: sql<number>`count(*)` })
    .from(schema.projectMembers)
    .where(inArray(schema.projectMembers.projectId, projectIds))
    .groupBy(schema.projectMembers.projectId).all()) {
    out.set(r.projectId, r.n);
  }
  return out;
}

/**
 * Replace the grant set. The owner is never a member of their own project,
 * and ids that don't belong to a live account are dropped rather than failing
 * the whole save (a picker can lag behind a deletion).
 */
export function replaceProjectMembers(
  projectId: string, ownerId: string, wanted: { userId: string; role: MemberRole }[],
): void {
  const seen = new Set<string>();
  const unique = wanted.filter((m) => {
    if (m.userId === ownerId || seen.has(m.userId)) return false;
    seen.add(m.userId);
    return true;
  });
  const valid = new Set(db.select({ id: schema.users.id }).from(schema.users)
    .where(eq(schema.users.disabled, 0)).all().map((u) => u.id));
  const members = unique.filter((m) => valid.has(m.userId));
  db.transaction((tx) => {
    tx.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, projectId)).run();
    if (members.length) {
      tx.insert(schema.projectMembers).values(members.map((m) => ({
        projectId, userId: m.userId, role: m.role, createdAt: now(),
      }))).run();
    }
  });
}

/** Accounts a project can be shared with — everyone who can log in, minus me. */
export function userDirectory(excludeUserId: string): { id: string; username: string; displayName: string | null; role: string }[] {
  return db.select({
    id: schema.users.id, username: schema.users.username,
    displayName: schema.users.displayName, role: schema.users.role,
  }).from(schema.users)
    .where(eq(schema.users.disabled, 0))
    .orderBy(schema.users.username).all()
    .filter((u) => u.id !== excludeUserId);
}
