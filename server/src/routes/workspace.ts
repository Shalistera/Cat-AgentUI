// 工作区 HTTP surface — the browser side of the per-chat file directory:
// listing for the panel, preview/download, drag-and-drop upload, delete,
// rename, and "copy this chat attachment into the workspace".
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import {
  WorkspaceError, deleteWorkspacePath, extOf, isTextPath, listWorkspace, readWorkspaceText,
  renameWorkspacePath, resolveSafe, workspaceRoot, writeWorkspaceFile,
} from '../workspace.js';

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', css: 'text/css',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

function mimeFor(rel: string): string {
  const ext = extOf(rel);
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return isTextPath(rel) ? 'text/plain' : 'application/octet-stream';
}

function ownChat(req: FastifyRequest, reply: FastifyReply, chatId: string) {
  const c = db.select({ id: schema.chats.id, workspace: schema.chats.workspace }).from(schema.chats)
    .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, req.user!.id))).get();
  if (!c) { reply.code(404).send({ error: '对话不存在' }); return null; }
  return c;
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof WorkspaceError) return reply.code(err.statusCode).send({ error: err.message });
  throw err;
}

function touchChat(chatId: string) {
  db.update(schema.chats).set({ updatedAt: now() }).where(eq(schema.chats.id, chatId)).run();
}

const pathQuery = z.object({ path: z.string().min(1).max(300) });

export async function workspaceRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: config.maxWorkspaceFileBytes, files: 1 } });

  app.get('/api/chats/:id/workspace', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = ownChat(req, reply, id);
    if (!c) return;
    const listing = listWorkspace(id, config.maxWorkspaceFiles);
    return {
      enabled: !!c.workspace,
      files: listing.files,
      bytes: listing.bytes,
      limits: { bytes: config.maxWorkspaceBytes, files: config.maxWorkspaceFiles, fileBytes: config.maxWorkspaceFileBytes },
    };
  });

  // ?path=a/b.md            raw bytes (inline; ?download=1 forces attachment)
  // ?path=a/b.docx&text=1   text rendition (docx → plain text) for the previewer
  app.get('/api/chats/:id/workspace/file', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    const q = pathQuery.extend({ download: z.string().optional(), text: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: '参数错误' });
    try {
      if (q.data.text) {
        const text = await readWorkspaceText(id, q.data.path);
        return { text };
      }
      const { abs, rel } = resolveSafe(id, q.data.path);
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { return reply.code(404).send({ error: '文件不存在' }); }
      if (!st.isFile()) return reply.code(404).send({ error: '文件不存在' });
      const mime = mimeFor(rel);
      const name = rel.split('/').pop()!;
      // HTML/SVG are never served inline from our origin: a model-written page
      // would otherwise run with the panel's cookies. The panel previews them
      // in a sandboxed iframe from the text endpoint instead.
      const forceDownload = !!q.data.download || mime === 'text/html' || mime === 'image/svg+xml';
      reply.header('content-type', mime.startsWith('text/') || mime === 'application/json' ? `${mime}; charset=utf-8` : mime);
      reply.header('content-disposition', `${forceDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'private, no-store');
      reply.header('content-length', String(st.size));
      return reply.send(fs.createReadStream(abs));
    } catch (err) { return sendError(reply, err); }
  });

  // Browser-side text save (the panel's editor).
  app.put('/api/chats/:id/workspace/file', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    const body = pathQuery.extend({ content: z.string().max(config.maxWorkspaceFileBytes) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = writeWorkspaceFile(id, body.data.path, body.data.content);
      touchChat(id);
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) { return sendError(reply, err); }
  });

  // multipart: one `file` field; optional `dir` field puts it under a folder.
  app.post('/api/chats/:id/workspace/upload', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    const dirField = file.fields.dir;
    const dir = dirField && 'value' in dirField && typeof dirField.value === 'string' ? dirField.value : '';
    const origName = String(file.filename || '').split(/[\\/]/).pop() || '';
    const rel = `${dir ? `${dir.replace(/\/+$/, '')}/` : ''}${origName}`;
    let target: { abs: string; rel: string };
    try { target = resolveSafe(id, rel); } catch (err) { file.file.resume(); return sendError(reply, err); }

    // Stage next to the destination, then hand the bytes to writeWorkspaceFile
    // so the size/count budget is enforced by one code path.
    fs.mkdirSync(workspaceRoot(id), { recursive: true, mode: 0o700 });
    const staging = path.join(workspaceRoot(id), `.upload-${process.pid}-${Date.now()}.part`);
    try {
      await pipeline(file.file, fs.createWriteStream(staging, { mode: 0o600 }));
      if (file.file.truncated) {
        return reply.code(413).send({ error: `单个文件不能超过 ${Math.round(config.maxWorkspaceFileBytes / 1048576)} MB` });
      }
      const data = fs.readFileSync(staging);
      const r = writeWorkspaceFile(id, target.rel, data);
      touchChat(id);
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) {
      return sendError(reply, err);
    } finally {
      try { fs.unlinkSync(staging); } catch { /* already moved or never written */ }
    }
  });

  // Copy one of the person's chat attachments (uploads row) into the workspace.
  app.post('/api/chats/:id/workspace/from-upload', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    const body = z.object({ uploadId: z.string().min(1).max(64), path: z.string().max(300).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const row = db.select().from(schema.uploads)
      .where(and(eq(schema.uploads.id, body.data.uploadId), eq(schema.uploads.userId, req.user!.id))).get();
    if (!row) return reply.code(404).send({ error: '附件不存在' });
    const src = path.join(config.dataDir, 'uploads', row.filename);
    if (!fs.existsSync(src)) return reply.code(404).send({ error: '附件文件已不存在' });
    const fallbackName = row.origName?.split(/[\\/]/).pop() || `${row.id}.${extOf(row.filename) || 'bin'}`;
    try {
      // Documents that only exist as extracted text (Open WebUI imports of
      // PDF/xlsx…) go in as .txt so the model can actually read them.
      if (row.extractedText && !isTextPath(fallbackName) && extOf(fallbackName) !== 'docx') {
        const name = body.data.path || `${fallbackName.replace(/\.[^.]+$/, '')}.txt`;
        const r = writeWorkspaceFile(id, name, row.extractedText);
        touchChat(id);
        return { ok: true, path: r.rel, size: r.size };
      }
      const r = writeWorkspaceFile(id, body.data.path || fallbackName, fs.readFileSync(src));
      touchChat(id);
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) { return sendError(reply, err); }
  });

  app.post('/api/chats/:id/workspace/rename', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    const body = z.object({ from: z.string().min(1).max(300), to: z.string().min(1).max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = renameWorkspacePath(id, body.data.from, body.data.to);
      touchChat(id);
      return { ok: true, ...r };
    } catch (err) { return sendError(reply, err); }
  });

  app.delete('/api/chats/:id/workspace/file', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    const q = pathQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = deleteWorkspacePath(id, q.data.path);
      touchChat(id);
      return { ok: true, ...r };
    } catch (err) { return sendError(reply, err); }
  });
}
