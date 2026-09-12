// 技能 admin surface: CRUD on SKILL.md, supporting files, zip import/export,
// enable + access, and a sample pair to get started.
import type { FastifyInstance, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  SKILL_FILE, SkillError, deleteSkill, deleteSkillFile, exportSkillZip, getSkill, importSampleSkills, importSkillZip,
  listSkillFiles, listSkills, readSkillFileText, saveSkillMd, skillsFor, updateSkillMeta, withSkillsLock, writeSkillFile,
} from '../skills.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof SkillError) return reply.code(err.statusCode).send({ error: err.message });
  throw err;
}

async function readAll(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = c as Buffer;
    n += b.length;
    if (n > cap) throw new SkillError('文件过大', 413);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function skillRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

  // What the composer can show a person: names + descriptions of skills they may use.
  app.get('/api/skills', async (req, reply) => {
    requireAuth(req, reply);
    return { skills: skillsFor(req.user!).map((r) => ({ slug: r.slug, description: r.description })) };
  });

  app.get('/api/admin/skills', async (req, reply) => {
    requireAdmin(req, reply);
    return { skills: listSkills() };
  });

  app.get('/api/admin/skills/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const s = getSkill(id);
    if (!s) return reply.code(404).send({ error: '技能不存在' });
    try {
      return { skill: s, files: listSkillFiles(s.slug).files, skillMd: readSkillFileText(s.slug, SKILL_FILE) };
    } catch (err) { return sendError(reply, err); }
  });

  app.post('/api/admin/skills', async (req, reply) => {
    requireAdmin(req, reply);
    const body = z.object({ skillMd: z.string().min(1).max(60_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try { return { skill: await saveSkillMd(body.data.skillMd) }; } catch (err) { return sendError(reply, err); }
  });

  app.post('/api/admin/skills/samples', async (req, reply) => {
    requireAdmin(req, reply);
    try { return { skills: await importSampleSkills() }; } catch (err) { return sendError(reply, err); }
  });

  app.post('/api/admin/skills/import', async (req, reply) => {
    requireAdmin(req, reply);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    const replaceField = file.fields.replace;
    const replace = !!replaceField && 'value' in replaceField && replaceField.value === '1';
    try {
      const buf = await readAll(file.file, 64 * 1024 * 1024);
      return { skill: await importSkillZip(buf, replace) };
    } catch (err) { return sendError(reply, err); }
  });

  app.patch('/api/admin/skills/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      skillMd: z.string().min(1).max(60_000).optional(),
      enabled: z.boolean().optional(),
      accessMode: z.enum(['shared', 'restricted']).optional(),
      allowedUserIds: z.array(z.string().max(64)).max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      if (body.data.skillMd !== undefined) await saveSkillMd(body.data.skillMd, id);
      const { skillMd: _md, ...meta } = body.data;
      return { skill: Object.keys(meta).length ? updateSkillMeta(id, meta) : getSkill(id) };
    } catch (err) { return sendError(reply, err); }
  });

  app.delete('/api/admin/skills/:id', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    try { await deleteSkill(id); return { ok: true }; } catch (err) { return sendError(reply, err); }
  });

  app.get('/api/admin/skills/:id/export', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const s = getSkill(id);
    if (!s) return reply.code(404).send({ error: '技能不存在' });
    const buf = await exportSkillZip(s.slug);
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${s.slug}.zip`)}`);
    return reply.send(buf);
  });

  // ---- files inside a skill ----
  app.get('/api/admin/skills/:id/file', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().min(1).max(300) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: '参数错误' });
    const s = getSkill(id);
    if (!s) return reply.code(404).send({ error: '技能不存在' });
    try { return { text: readSkillFileText(s.slug, q.data.path) }; } catch (err) { return sendError(reply, err); }
  });

  app.put('/api/admin/skills/:id/file', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({ path: z.string().min(1).max(300), content: z.string().max(8 * 1024 * 1024) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const s = getSkill(id);
    if (!s) return reply.code(404).send({ error: '技能不存在' });
    try {
      if (body.data.path === SKILL_FILE) return { skill: await saveSkillMd(body.data.content, id) };
      await withSkillsLock(() => {
        const cur = getSkill(id);
        if (!cur) throw new SkillError('技能不存在', 404);
        writeSkillFile(cur.slug, body.data.path, body.data.content);
      });
      return { ok: true };
    } catch (err) { return sendError(reply, err); }
  });

  app.post('/api/admin/skills/:id/upload', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const s = getSkill(id);
    if (!s) return reply.code(404).send({ error: '技能不存在' });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    const dirField = file.fields.dir;
    const dir = dirField && 'value' in dirField && typeof dirField.value === 'string' ? dirField.value.replace(/\/+$/, '') : '';
    const name = String(file.filename || '').split(/[\\/]/).pop() || '';
    try {
      const buf = await readAll(file.file, 8 * 1024 * 1024);
      const rel = `${dir ? `${dir}/` : ''}${name}`;
      if (rel === SKILL_FILE) { await saveSkillMd(buf.toString('utf8'), id); return { ok: true, path: rel }; }
      const r = await withSkillsLock(() => {
        const cur = getSkill(id);
        if (!cur) throw new SkillError('技能不存在', 404);
        return writeSkillFile(cur.slug, rel, buf);
      });
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) { return sendError(reply, err); }
  });

  app.delete('/api/admin/skills/:id/file', async (req, reply) => {
    requireAdmin(req, reply);
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().min(1).max(300) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: '参数错误' });
    const s = getSkill(id);
    if (!s) return reply.code(404).send({ error: '技能不存在' });
    try {
      await withSkillsLock(() => {
        const cur = getSkill(id);
        if (!cur) throw new SkillError('技能不存在', 404);
        deleteSkillFile(cur.slug, q.data.path);
      });
      return { ok: true };
    } catch (err) { return sendError(reply, err); }
  });
}
