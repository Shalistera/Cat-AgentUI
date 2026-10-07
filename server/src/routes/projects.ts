import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, rawDb, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { DOC_CITE_RULE, PROJECT_TOOL_DEFS, docRef, projectInjectBudget, removeProjectFiles } from '../knowledge.js';
import {
  accessibleProjects, canEditProject, projectAccess, projectMemberCounts, projectMembers,
  replaceProjectMembers, userDirectory, type ProjectRole,
} from '../project-access.js';
import type { ToolDef } from '../types.js';

// Retrieval (knowledge.ts) means the caps are storage hygiene, not a context
// budget: how much rides along whole is decided per turn by the model's size.
export const PROJECT_LIMITS = {
  maxDocs: 50,
  maxDocChars: 300_000,
  maxTotalChars: 2_000_000,
  maxInstructionsChars: 20_000,
};

/** A model that can't call tools can't fetch what is left out, so it gets at
    least this much — never the whole 2M-char allowance. */
const NO_TOOLS_INJECT_CAP = 100_000;

function docMeta(d: typeof schema.projectDocs.$inferSelect) {
  return { id: d.id, name: d.name, chars: d.chars, createdAt: d.createdAt };
}

function ownerOf(userId: string) {
  const u = db.select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  return u ?? { id: userId, username: '已删除用户', displayName: null };
}

function projectDto(p: typeof schema.projects.$inferSelect, role: ProjectRole) {
  return {
    id: p.id, name: p.name, description: p.description,
    instructions: p.instructions, createdAt: p.createdAt, updatedAt: p.updatedAt,
    accessMode: p.accessMode as 'private' | 'shared' | 'restricted',
    role,
    owner: ownerOf(p.userId),
  };
}

const NOT_FOUND = { error: '项目不存在' };
const NO_EDIT = { error: '你只有查看权限,不能修改这个项目' };

function totalChars(projectId: string): number {
  const row = db.select({ sum: sql<number | null>`sum(${schema.projectDocs.chars})` })
    .from(schema.projectDocs).where(eq(schema.projectDocs.projectId, projectId)).get();
  return row?.sum ?? 0;
}

/** One manifest line: size, the opening line and the first headings — enough
    for the model to judge whether a document is worth fetching. */
function manifestLine(d: { id: string; name: string; chars: number; content: string }): string {
  const lines = d.content.split('\n').map((l) => l.trim()).filter(Boolean);
  const opening = (lines[0] ?? '').replace(/^#+\s*/, '').slice(0, 60);
  const headings = lines.slice(1).filter((l) => /^#{1,3}\s/.test(l)).slice(0, 4)
    .map((l) => l.replace(/^#+\s*/, '').slice(0, 24));
  const hint = [opening, headings.length ? `目录:${headings.join(' / ')}` : ''].filter(Boolean).join(' | ');
  return `- ${d.name}(ref ${docRef(d.id)},${d.chars.toLocaleString()} 字符)${hint ? `:${hint}` : ''}`;
}

export interface ProjectTurnContext {
  /** System-prompt block (instructions, whole documents, manifest); null when there is nothing. */
  block: string | null;
  /** project_search / project_read_doc when some documents were left out. */
  tools: ToolDef[] | null;
  /** Documents the person may read in this project — gates the sandbox's /project mount. */
  docCount: number;
}

/** What a project contributes to a chat turn. As many whole documents as fit
    the model's budget ride along (smallest first, so the most of them fit);
    the rest are listed in a manifest the model searches and reads on demand. */
export function buildProjectPrompt(projectId: string, userId: string, opts: { canUseTools: boolean; modelId: string }): ProjectTurnContext {
  const p = projectAccess(projectId, userId)?.project;
  if (!p) return { block: null, tools: null, docCount: 0 };
  const docs = db.select().from(schema.projectDocs)
    .where(eq(schema.projectDocs.projectId, projectId))
    .orderBy(asc(schema.projectDocs.createdAt)).all();

  const blocks: string[] = [];
  if (p.instructions?.trim()) blocks.push(`[项目指令]\n${p.instructions.trim()}`);
  if (!docs.length) return { block: blocks.length ? blocks.join('\n\n') : null, tools: null, docCount: 0 };

  const budget = opts.canUseTools
    ? projectInjectBudget(opts.modelId)
    : Math.max(projectInjectBudget(opts.modelId), NO_TOOLS_INJECT_CAP);
  const whole = new Set<string>();
  let used = 0;
  for (const d of [...docs].sort((a, b) => a.chars - b.chars || a.createdAt - b.createdAt)) {
    if (used + d.chars > budget) break;
    whole.add(d.id);
    used += d.chars;
  }
  const loaded = docs.filter((d) => whole.has(d.id));
  const listed = docs.filter((d) => !whole.has(d.id));
  const documents = loaded.map((d) => `<document name=${JSON.stringify(d.name)} ref="${docRef(d.id)}">\n${d.content}\n</document>`).join('\n\n');

  let tools: ToolDef[] | null = null;
  if (!listed.length) {
    blocks.push(`[项目资料]\n以下是本项目的全部参考文档(已整篇载入)。回答与项目相关的问题时,优先依据这些资料;资料没有覆盖的内容,如实说明。${DOC_CITE_RULE}\n\n${documents}`);
  } else if (!opts.canUseTools) {
    blocks.push(`[项目资料]\n以下是本项目的部分参考文档。回答与项目相关的问题时,优先依据这些资料;资料没有覆盖的内容,如实说明。${DOC_CITE_RULE}\n\n${documents}`
      + `\n\n(资料过多,另有 ${listed.length} 个文档未能载入:${listed.map((d) => d.name).join('、')})`);
  } else {
    if (loaded.length) {
      blocks.push(`[项目资料]\n以下 ${loaded.length} 个文档已整篇载入。回答与项目相关的问题时,优先依据这些资料。${DOC_CITE_RULE}\n\n${documents}`);
    }
    blocks.push(
      `[项目资料清单]\n${loaded.length ? `另有 ${listed.length} 个文档` : `本项目的 ${listed.length} 个参考文档`}篇幅较大,只列出清单、内容未载入。问题可能涉及它们时,先用 project_search 检索(结果带文档名、ref 和字符位置),需要完整上下文再用 project_read_doc 从对应位置读取原文。与资料无关的问题不必调用。${loaded.length ? '引用格式同上。' : DOC_CITE_RULE}\n`
      + listed.map(manifestLine).join('\n'),
    );
    tools = PROJECT_TOOL_DEFS;
  }
  return { block: blocks.join('\n\n'), tools, docCount: docs.length };
}

/** The /project line for the sandbox block: only when run_command exists. */
export function projectFilesPrompt(docCount: number): string {
  return `本对话所属项目的 ${docCount} 个资料文件以只读方式挂载在沙盒的 /project/ 目录(文件名就是资料名,"/" 会换成 "_")。需要跨文档精确查找、统计或处理数据时直接用命令,例如 grep -rn "关键词" /project/、用 python3 读取 /project/ 下的 CSV;要修改或转换格式,先复制到工作区。`;
}

/** For the project page: what loads whole on an ordinary (~128K) model and on a 1M one. */
function injectLimits() {
  return {
    injectChars: projectInjectBudget(''),
    injectCharsMax: projectInjectBudget('claude-opus-5-5'),
  };
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req, reply) => {
    requireAuth(req, reply);
    const rows = accessibleProjects(req.user!.id);
    const memberCounts = projectMemberCounts(rows.map((r) => r.project.id));
    const counts = new Map<string, { docs: number; chars: number }>();
    for (const d of db.select({
      projectId: schema.projectDocs.projectId,
      docs: sql<number>`count(*)`,
      chars: sql<number>`sum(${schema.projectDocs.chars})`,
    }).from(schema.projectDocs).groupBy(schema.projectDocs.projectId).all()) {
      counts.set(d.projectId, { docs: d.docs, chars: d.chars ?? 0 });
    }
    return {
      projects: rows.map(({ project: p, role }) => ({
        ...projectDto(p, role),
        docCount: counts.get(p.id)?.docs ?? 0,
        totalChars: counts.get(p.id)?.chars ?? 0,
        memberCount: memberCounts.get(p.id) ?? 0,
      })),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(300).nullish(),
      instructions: z.string().max(PROJECT_LIMITS.maxInstructionsChars).nullish(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const id = newId();
    const t = now();
    db.insert(schema.projects).values({
      id, userId: req.user!.id, name: body.data.name,
      description: body.data.description ?? null,
      instructions: body.data.instructions ?? null,
      createdAt: t, updatedAt: t,
    }).run();
    const p = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    return { project: { ...projectDto(p, 'owner'), docCount: 0, totalChars: 0, memberCount: 0 } };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    const { project: p, role } = access;
    const docs = db.select().from(schema.projectDocs)
      .where(eq(schema.projectDocs.projectId, id))
      .orderBy(asc(schema.projectDocs.createdAt)).all();
    // Only MY chats — sharing a project shares its instructions and docs,
    // never anyone's conversations.
    const chats = db.select().from(schema.chats)
      .where(and(eq(schema.chats.userId, req.user!.id), eq(schema.chats.projectId, id)))
      .orderBy(desc(schema.chats.updatedAt)).all();
    return {
      project: projectDto(p, role),
      // The member roster is the owner's business; others just see the count.
      members: role === 'owner' ? projectMembers(id) : null,
      memberCount: projectMemberCounts([id]).get(id) ?? 0,
      docs: docs.map(docMeta),
      limits: { ...PROJECT_LIMITS, ...injectLimits() },
      chats: chats.map((c) => ({
        id: c.id, title: c.title, pinned: !!c.pinned, modelId: c.modelId,
        projectId: c.projectId, createdAt: c.createdAt, updatedAt: c.updatedAt,
      })),
    };
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(300).nullish(),
      instructions: z.string().max(PROJECT_LIMITS.maxInstructionsChars).nullish(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    const d = body.data;
    // Editors may rewrite the instructions; the project's identity is the owner's.
    if (!canEditProject(access.role)) return reply.code(403).send(NO_EDIT);
    if ((d.name !== undefined || d.description !== undefined) && access.role !== 'owner') {
      return reply.code(403).send({ error: '只有项目所有者可以修改名称与描述' });
    }
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (d.name !== undefined) patch.name = d.name;
    if (d.description !== undefined) patch.description = d.description;
    if (d.instructions !== undefined) patch.instructions = d.instructions;
    db.update(schema.projects).set(patch).where(eq(schema.projects.id, id)).run();
    const updated = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    return { project: projectDto(updated, access.role) };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    if (access.role !== 'owner') return reply.code(403).send({ error: '只有项目所有者可以删除项目' });
    // Chats survive their project — every member's, not just the owner's;
    // they just fall back to plain chats.
    db.update(schema.chats).set({ projectId: null }).where(eq(schema.chats.projectId, id)).run();
    db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    try { removeProjectFiles(id); } catch { /* swept at next startup */ }
    return { ok: true };
  });

  // --- sharing (owner only) ---
  const sharingSchema = z.object({
    accessMode: z.enum(['private', 'shared', 'restricted']),
    members: z.array(z.object({
      userId: z.string().min(1).max(64),
      role: z.enum(['viewer', 'editor']),
    })).max(200),
  });

  app.put('/api/projects/:id/sharing', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    if (access.role !== 'owner') return reply.code(403).send({ error: '只有项目所有者可以设置共享' });
    const body = sharingSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    db.update(schema.projects).set({ accessMode: body.data.accessMode, updatedAt: now() })
      .where(eq(schema.projects.id, id)).run();
    replaceProjectMembers(id, req.user!.id, body.data.members);
    const updated = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    const members = projectMembers(id);
    return { project: projectDto(updated, 'owner'), members, memberCount: members.length };
  });

  // Who can be invited: every enabled account except me. Names only — the
  // member picker needs nothing else, and regular users get no admin fields.
  app.get('/api/users/directory', async (req, reply) => {
    requireAuth(req, reply);
    return { users: userDirectory(req.user!.id) };
  });

  // Documents arrive as JSON {name, content} — the client reads the file as
  // text (FileReader), which keeps the server free of format parsing and makes
  // "text only, no OCR" a structural guarantee rather than a validation rule.
  app.post('/api/projects/:id/docs', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    if (!canEditProject(access.role)) return reply.code(403).send(NO_EDIT);
    const body = z.object({
      name: z.string().trim().min(1).max(200),
      content: z.string().min(1).max(PROJECT_LIMITS.maxDocChars),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: `参数错误:单个文档不能超过 ${PROJECT_LIMITS.maxDocChars.toLocaleString()} 字符` });
    }
    const docCount = db.select({ n: sql<number>`count(*)` })
      .from(schema.projectDocs).where(eq(schema.projectDocs.projectId, id)).get()?.n ?? 0;
    if (docCount >= PROJECT_LIMITS.maxDocs) {
      return reply.code(400).send({ error: `每个项目最多 ${PROJECT_LIMITS.maxDocs} 个文档` });
    }
    const chars = body.data.content.length;
    if (totalChars(id) + chars > PROJECT_LIMITS.maxTotalChars) {
      return reply.code(400).send({ error: `项目资料总量超出上限(${PROJECT_LIMITS.maxTotalChars.toLocaleString()} 字符),请删减后再上传` });
    }
    const docId = newId();
    db.insert(schema.projectDocs).values({
      id: docId, projectId: id, name: body.data.name,
      content: body.data.content, chars, createdAt: now(),
    }).run();
    db.update(schema.projects).set({ updatedAt: now() }).where(eq(schema.projects.id, id)).run();
    const doc = db.select().from(schema.projectDocs).where(eq(schema.projectDocs.id, docId)).get()!;
    return { doc: docMeta(doc) };
  });

  // A `doc:ref` citation in a reply → the document it names, among the
  // projects this person can open. Replies are rendered outside their chat
  // too (收藏, 工作区 previews), so the ref alone has to be enough.
  app.get('/api/project-docs/:ref', async (req, reply) => {
    requireAuth(req, reply);
    const { ref } = req.params as { ref: string };
    if (!/^[0-9a-f]{8}$/i.test(ref)) return reply.code(404).send({ error: '资料不存在' });
    const candidates = db.select({ id: schema.projectDocs.id, projectId: schema.projectDocs.projectId, name: schema.projectDocs.name })
      .from(schema.projectDocs).where(sql`replace(${schema.projectDocs.id}, '-', '') LIKE ${`${ref.toLowerCase()}%`}`).all();
    for (const d of candidates) {
      const access = projectAccess(d.projectId, req.user!.id);
      if (!access) continue;
      return {
        doc: { id: d.id, projectId: d.projectId, name: d.name },
        project: { id: access.project.id, name: access.project.name },
        canEdit: canEditProject(access.role),
        maxDocChars: PROJECT_LIMITS.maxDocChars,
      };
    }
    return reply.code(404).send({ error: '资料不存在,或你没有这个项目的访问权限' });
  });

  app.get('/api/projects/:id/docs/:docId', async (req, reply) => {
    requireAuth(req, reply);
    const { id, docId } = req.params as { id: string; docId: string };
    if (!projectAccess(id, req.user!.id)) return reply.code(404).send(NOT_FOUND);
    const doc = db.select().from(schema.projectDocs)
      .where(and(eq(schema.projectDocs.id, docId), eq(schema.projectDocs.projectId, id))).get();
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    return { doc: { ...docMeta(doc), content: doc.content } };
  });

  // Rename and/or rewrite a document in place.
  app.patch('/api/projects/:id/docs/:docId', async (req, reply) => {
    requireAuth(req, reply);
    const { id, docId } = req.params as { id: string; docId: string };
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    if (!canEditProject(access.role)) return reply.code(403).send(NO_EDIT);
    const body = z.object({
      name: z.string().trim().min(1).max(200).optional(),
      content: z.string().max(PROJECT_LIMITS.maxDocChars).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: `参数错误:单个文档不能超过 ${PROJECT_LIMITS.maxDocChars.toLocaleString()} 字符` });
    }
    const doc = db.select().from(schema.projectDocs)
      .where(and(eq(schema.projectDocs.id, docId), eq(schema.projectDocs.projectId, id))).get();
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    const name = body.data.name ?? doc.name;
    const content = body.data.content ?? doc.content;
    if (!content.trim()) return reply.code(400).send({ error: '文档内容不能为空' });
    if (totalChars(id) - doc.chars + content.length > PROJECT_LIMITS.maxTotalChars) {
      return reply.code(400).send({ error: `项目资料总量超出上限(${PROJECT_LIMITS.maxTotalChars.toLocaleString()} 字符),请删减后再保存` });
    }
    if (name !== doc.name || content !== doc.content) {
      rawDb.transaction(() => {
        db.update(schema.projectDocs).set({ name, content, chars: content.length })
          .where(eq(schema.projectDocs.id, docId)).run();
        db.update(schema.projects).set({ updatedAt: now() }).where(eq(schema.projects.id, id)).run();
      })();
    }
    const updated = db.select().from(schema.projectDocs).where(eq(schema.projectDocs.id, docId)).get()!;
    return { doc: { ...docMeta(updated), content: updated.content } };
  });

  app.delete('/api/projects/:id/docs/:docId', async (req, reply) => {
    requireAuth(req, reply);
    const { id, docId } = req.params as { id: string; docId: string };
    const access = projectAccess(id, req.user!.id);
    if (!access) return reply.code(404).send(NOT_FOUND);
    if (!canEditProject(access.role)) return reply.code(403).send(NO_EDIT);
    const doc = db.select().from(schema.projectDocs)
      .where(and(eq(schema.projectDocs.id, docId), eq(schema.projectDocs.projectId, id))).get();
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    db.delete(schema.projectDocs).where(eq(schema.projectDocs.id, docId)).run();
    db.update(schema.projects).set({ updatedAt: now() }).where(eq(schema.projects.id, id)).run();
    return { ok: true };
  });
}
