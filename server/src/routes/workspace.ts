// 工作区 HTTP surface — the browser side of the per-chat file directory:
// listing for the panel, preview/download, drag-and-drop upload, delete,
// rename, folders and batch move/delete/zip, and "copy this chat attachment
// into the workspace".
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getAgentSettings, policyAllows, userWantsAgentTools } from '../agent-settings.js';
import {
  WorkspaceError, deleteWorkspacePath, deleteWorkspacePaths, extOf, isTextPath, listWorkspace, makeWorkspaceDir,
  moveWorkspacePaths, openRegular, readWorkspaceText, renameWorkspacePath, resolveSafe, writeWorkspaceFile,
  zipWorkspacePaths,
} from '../workspace.js';

import { withWorkspaceScope, workspaceScope } from '../workspace-scope.js';

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

// Pin ownership and storage through async uploads; a stale editor cannot save
// into a different directory after the project setting or chat membership changes.
function scoped(handler: (req: FastifyRequest, reply: FastifyReply, id: string) => Promise<unknown>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    if (!ownChat(req, reply, id)) return;
    return withWorkspaceScope(id, () => {
      const expected = (req.query as { scope?: string }).scope;
      if (expected !== undefined && expected !== workspaceScope(id).key) {
        return reply.code(409).send({ error: '工作区已切换,请刷新文件列表后重试' });
      }
      return handler(req, reply, id);
    });
  };
}

const pathQuery = z.object({ path: z.string().min(1).max(300) });
const pathList = z.array(z.string().min(1).max(300)).min(1).max(1000);

export async function workspaceRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: config.maxWorkspaceFileBytes, files: 1 } });

  app.get('/api/chats/:id/workspace', scoped(async (req, reply, id) => {
    // An import can preserve more old files than the current quota permits.
    // Keep all of them reachable so the user can download or clean them up.
    const listing = listWorkspace(id);
    return {
      enabled: userWantsAgentTools(req.user!.settings) && policyAllows(getAgentSettings().workspace, req.user!),
      scope: workspaceScope(id).kind, scopeKey: workspaceScope(id).key,
      files: listing.files,
      dirs: listing.dirs,
      bytes: listing.bytes,
      limits: { bytes: config.maxWorkspaceBytes, files: config.maxWorkspaceFiles, fileBytes: config.maxWorkspaceFileBytes },
    };
  }));

  // ?path=a/b.md            raw bytes (inline; ?download=1 forces attachment)
  // ?path=a/b.docx&text=1   text rendition (docx → plain text) for the previewer
  app.get('/api/chats/:id/workspace/file', scoped(async (req, reply, id) => {
    const q = pathQuery.extend({ download: z.string().optional(), text: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: '参数错误' });
    try {
      if (q.data.text) {
        const text = await readWorkspaceText(id, q.data.path);
        return { text };
      }
      // open-then-verify (see workspace.ts openRegular): the stream reads
      // from the descriptor we proved is inside the workspace, never from a
      // path that could be re-pointed underneath us.
      const { fd, rel, size } = openRegular(id, q.data.path);
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
      reply.header('content-length', String(size));
      return reply.send(fs.createReadStream('', { fd, autoClose: true }));
    } catch (err) { return sendError(reply, err); }
  }));

  // Browser-side text save (the panel's editor).
  app.put('/api/chats/:id/workspace/file', scoped(async (req, reply, id) => {
    const body = pathQuery.extend({ content: z.string().max(config.maxWorkspaceFileBytes) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = await writeWorkspaceFile(id, body.data.path, body.data.content);
      touchChat(id);
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) { return sendError(reply, err); }
  }));

  // multipart: one `file` field; optional `dir` field puts it under a folder.
  app.post('/api/chats/:id/workspace/upload', scoped(async (req, reply, id) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    const dirField = file.fields.dir;
    const dir = dirField && 'value' in dirField && typeof dirField.value === 'string' ? dirField.value : '';
    const origName = String(file.filename || '').split(/[\\/]/).pop() || '';
    const rel = `${dir ? `${dir.replace(/\/+$/, '')}/` : ''}${origName}`;
    let target: { abs: string; rel: string };
    try { target = resolveSafe(id, rel); } catch (err) { file.file.resume(); return sendError(reply, err); }

    // Stage OUTSIDE the workspace (nothing attacker-controlled sits on that
    // path), then hand the bytes to writeWorkspaceFile so the budget and the
    // descriptor-anchored write are enforced by one code path.
    const staging = path.join(os.tmpdir(), `caui-upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
    try {
      await pipeline(file.file, fs.createWriteStream(staging, { flags: 'wx', mode: 0o600 }));
      if (file.file.truncated) {
        return reply.code(413).send({ error: `单个文件不能超过 ${Math.round(config.maxWorkspaceFileBytes / 1048576)} MB` });
      }
      const data = fs.readFileSync(staging);
      const r = await writeWorkspaceFile(id, target.rel, data);
      touchChat(id);
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) {
      return sendError(reply, err);
    } finally {
      try { fs.unlinkSync(staging); } catch { /* already moved or never written */ }
    }
  }));

  // Copy one of the person's chat attachments (uploads row) into the workspace.
  app.post('/api/chats/:id/workspace/from-upload', scoped(async (req, reply, id) => {
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
        const r = await writeWorkspaceFile(id, name, row.extractedText);
        touchChat(id);
        return { ok: true, path: r.rel, size: r.size };
      }
      const r = await writeWorkspaceFile(id, body.data.path || fallbackName, fs.readFileSync(src));
      touchChat(id);
      return { ok: true, path: r.rel, size: r.size };
    } catch (err) { return sendError(reply, err); }
  }));

  app.post('/api/chats/:id/workspace/rename', scoped(async (req, reply, id) => {
    const body = z.object({ from: z.string().min(1).max(300), to: z.string().min(1).max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = await renameWorkspacePath(id, body.data.from, body.data.to);
      touchChat(id);
      return { ok: true, ...r };
    } catch (err) { return sendError(reply, err); }
  }));

  app.post('/api/chats/:id/workspace/mkdir', scoped(async (req, reply, id) => {
    const body = pathQuery.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = await makeWorkspaceDir(id, body.data.path);
      touchChat(id);
      return { ok: true, path: r.rel };
    } catch (err) { return sendError(reply, err); }
  }));

  // Batch operations report per-entry failures instead of stopping halfway.
  app.post('/api/chats/:id/workspace/move', scoped(async (req, reply, id) => {
    const body = z.object({ paths: pathList, to: z.string().max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = await moveWorkspacePaths(id, body.data.paths, body.data.to);
      if (r.moved.length) touchChat(id);
      return { ok: true, ...r };
    } catch (err) { return sendError(reply, err); }
  }));

  app.post('/api/chats/:id/workspace/delete', scoped(async (req, reply, id) => {
    const body = z.object({ paths: pathList }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = await deleteWorkspacePaths(id, body.data.paths);
      if (r.deleted.length) touchChat(id);
      return { ok: true, ...r };
    } catch (err) { return sendError(reply, err); }
  }));

  app.post('/api/chats/:id/workspace/zip', scoped(async (req, reply, id) => {
    const body = z.object({ paths: pathList }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const buf = await zipWorkspacePaths(id, body.data.paths);
      reply.header('content-type', 'application/zip');
      reply.header('content-disposition', 'attachment; filename="workspace.zip"');
      reply.header('cache-control', 'private, no-store');
      return reply.send(buf);
    } catch (err) { return sendError(reply, err); }
  }));

  app.delete('/api/chats/:id/workspace/file', scoped(async (req, reply, id) => {
    const q = pathQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: '参数错误' });
    try {
      const r = await deleteWorkspacePath(id, q.data.path);
      touchChat(id);
      return { ok: true, ...r };
    } catch (err) { return sendError(reply, err); }
  }));
}
