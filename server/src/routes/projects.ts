import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { PROJECT_TOOL_DEFS, indexDoc, removeDocIndex, removeProjectIndex } from '../knowledge.js';
import type { ToolDef } from '../types.js';

// Retrieval (knowledge.ts) means the caps are storage hygiene, not a context
// budget — only corpora at or below PROJECT_INJECT_CHARS ride along whole.
export const PROJECT_LIMITS = {
  maxDocs: 50,
  maxDocChars: 300_000,
  maxTotalChars: 2_000_000,
  maxInstructionsChars: 20_000,
};

/** Corpus size at or below which docs are injected verbatim: below it a tool
    round-trip costs more than just shipping the text; above it the model gets
    a manifest plus search/read tools and pulls only what the turn needs. */
export const PROJECT_INJECT_CHARS = 6_000;

/** When the corpus is over budget but the model can't call tools, inject at
    most this much before cutting off — never the whole 2M-char allowance. */
const NO_TOOLS_INJECT_CAP = 100_000;

function ownedProject(id: string, userId: string) {
  return db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.userId, userId))).get();
}

function docMeta(d: typeof schema.projectDocs.$inferSelect) {
  return { id: d.id, name: d.name, chars: d.chars, createdAt: d.createdAt };
}

function projectDto(p: typeof schema.projects.$inferSelect) {
  return {
    id: p.id, name: p.name, description: p.description,
    instructions: p.instructions, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

function totalChars(projectId: string): number {
  const row = db.select({ sum: sql<number | null>`sum(${schema.projectDocs.chars})` })
    .from(schema.projectDocs).where(eq(schema.projectDocs.projectId, projectId)).get();
  return row?.sum ?? 0;
}

/** What a project contributes to a chat turn: a system-prompt block, plus the
    retrieval tools when the corpus is too big to inject whole. */
export function buildProjectPrompt(projectId: string, userId: string, canUseTools: boolean):
  { block: string | null; tools: ToolDef[] | null } {
  const p = ownedProject(projectId, userId);
  if (!p) return { block: null, tools: null };
  const docs = db.select().from(schema.projectDocs)
    .where(eq(schema.projectDocs.projectId, projectId))
    .orderBy(asc(schema.projectDocs.createdAt)).all();

  const blocks: string[] = [];
  let tools: ToolDef[] | null = null;
  if (p.instructions?.trim()) blocks.push(`[项目指令]\n${p.instructions.trim()}`);

  const total = docs.reduce((n, d) => n + d.chars, 0);
  if (docs.length && (total <= PROJECT_INJECT_CHARS || !canUseTools)) {
    const included: string[] = [];
    let used = 0;
    for (const d of docs) {
      if (!canUseTools && used + d.chars > NO_TOOLS_INJECT_CAP) break;
      included.push(`<document name=${JSON.stringify(d.name)}>\n${d.content}\n</document>`);
      used += d.chars;
    }
    const omitted = docs.length - included.length;
    blocks.push(
      `[项目资料]\n以下是本项目的参考文档。回答与项目相关的问题时,优先依据这些资料;资料没有覆盖的内容,如实说明。\n\n${included.join('\n\n')}`
      + (omitted > 0 ? `\n\n(资料过多,另有 ${omitted} 个文档未能载入)` : ''),
    );
  } else if (docs.length) {
    const manifest = docs.map((d) => {
      const preview = d.content.slice(0, 80).replace(/\s+/g, ' ').trim();
      return `- ${d.name}(${d.chars.toLocaleString()} 字符)${preview ? `:${preview}…` : ''}`;
    }).join('\n');
    blocks.push(
      `[项目资料清单]\n本项目挂载了以下参考文档(仅清单,内容未载入)。当问题可能与它们相关时,先用 project_search 检索片段,需要完整上下文再用 project_read_doc 读取原文;引用资料回答时注明文档名。与资料无关的问题不必调用。\n${manifest}`,
    );
    tools = PROJECT_TOOL_DEFS;
  }
  return { block: blocks.length ? blocks.join('\n\n') : null, tools };
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req, reply) => {
    requireAuth(req, reply);
    const rows = db.select().from(schema.projects)
      .where(eq(schema.projects.userId, req.user!.id))
      .orderBy(desc(schema.projects.updatedAt)).all();
    const counts = new Map<string, { docs: number; chars: number }>();
    for (const d of db.select({
      projectId: schema.projectDocs.projectId,
      docs: sql<number>`count(*)`,
      chars: sql<number>`sum(${schema.projectDocs.chars})`,
    }).from(schema.projectDocs).groupBy(schema.projectDocs.projectId).all()) {
      counts.set(d.projectId, { docs: d.docs, chars: d.chars ?? 0 });
    }
    return {
      projects: rows.map((p) => ({
        ...projectDto(p),
        docCount: counts.get(p.id)?.docs ?? 0,
        totalChars: counts.get(p.id)?.chars ?? 0,
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
    return { project: { ...projectDto(p), docCount: 0, totalChars: 0 } };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const p = ownedProject(id, req.user!.id);
    if (!p) return reply.code(404).send({ error: '项目不存在' });
    const docs = db.select().from(schema.projectDocs)
      .where(eq(schema.projectDocs.projectId, id))
      .orderBy(asc(schema.projectDocs.createdAt)).all();
    const chats = db.select().from(schema.chats)
      .where(and(eq(schema.chats.userId, req.user!.id), eq(schema.chats.projectId, id)))
      .orderBy(desc(schema.chats.updatedAt)).all();
    return {
      project: projectDto(p),
      docs: docs.map(docMeta),
      limits: { ...PROJECT_LIMITS, injectChars: PROJECT_INJECT_CHARS },
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
    const p = ownedProject(id, req.user!.id);
    if (!p) return reply.code(404).send({ error: '项目不存在' });
    const d = body.data;
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (d.name !== undefined) patch.name = d.name;
    if (d.description !== undefined) patch.description = d.description;
    if (d.instructions !== undefined) patch.instructions = d.instructions;
    db.update(schema.projects).set(patch).where(eq(schema.projects.id, id)).run();
    const updated = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
    return { project: projectDto(updated) };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const p = ownedProject(id, req.user!.id);
    if (!p) return reply.code(404).send({ error: '项目不存在' });
    // Chats survive their project; they just fall back to plain chats.
    db.update(schema.chats).set({ projectId: null })
      .where(and(eq(schema.chats.projectId, id), eq(schema.chats.userId, req.user!.id))).run();
    db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    removeProjectIndex(id);
    return { ok: true };
  });

  // Documents arrive as JSON {name, content} — the client reads the file as
  // text (FileReader), which keeps the server free of format parsing and makes
  // "text only, no OCR" a structural guarantee rather than a validation rule.
  app.post('/api/projects/:id/docs', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const p = ownedProject(id, req.user!.id);
    if (!p) return reply.code(404).send({ error: '项目不存在' });
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
    indexDoc(docId, id, body.data.name, body.data.content);
    db.update(schema.projects).set({ updatedAt: now() }).where(eq(schema.projects.id, id)).run();
    const doc = db.select().from(schema.projectDocs).where(eq(schema.projectDocs.id, docId)).get()!;
    return { doc: docMeta(doc) };
  });

  app.get('/api/projects/:id/docs/:docId', async (req, reply) => {
    requireAuth(req, reply);
    const { id, docId } = req.params as { id: string; docId: string };
    if (!ownedProject(id, req.user!.id)) return reply.code(404).send({ error: '项目不存在' });
    const doc = db.select().from(schema.projectDocs)
      .where(and(eq(schema.projectDocs.id, docId), eq(schema.projectDocs.projectId, id))).get();
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    return { doc: { ...docMeta(doc), content: doc.content } };
  });

  app.delete('/api/projects/:id/docs/:docId', async (req, reply) => {
    requireAuth(req, reply);
    const { id, docId } = req.params as { id: string; docId: string };
    if (!ownedProject(id, req.user!.id)) return reply.code(404).send({ error: '项目不存在' });
    const doc = db.select().from(schema.projectDocs)
      .where(and(eq(schema.projectDocs.id, docId), eq(schema.projectDocs.projectId, id))).get();
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    db.delete(schema.projectDocs).where(eq(schema.projectDocs.id, docId)).run();
    removeDocIndex(docId);
    db.update(schema.projects).set({ updatedAt: now() }).where(eq(schema.projects.id, id)).run();
    return { ok: true };
  });
}
