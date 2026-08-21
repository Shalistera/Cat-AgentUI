import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import {
  quotaErrorMessage, sniffUpload, tryReserveStorage, uploadIsReferenced,
} from '../storage.js';

export async function uploadRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 5 } });

  app.post('/api/uploads', async (req, reply) => {
    requireAuth(req, reply);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到文件' });

    const contentLength = Number(req.headers['content-length']);
    const reserveBytes = Number.isSafeInteger(contentLength) && contentLength > 0
      ? Math.min(contentLength, config.maxUploadBytes)
      : config.maxUploadBytes;
    const reserved = tryReserveStorage(req.user!.id, 'upload', reserveBytes);
    if (!reserved.ok) {
      file.file.resume();
      return reply.code(413).send({ error: quotaErrorMessage('upload', reserved.reason) });
    }

    const id = newId();
    // The trustworthy extension comes from content sniffing, which needs the
    // bytes on disk first — stage under a .part name, rename once classified.
    let filename = `${id}.part`;
    let dest = path.join(config.dataDir, 'uploads', filename);

    try {
      await pipeline(file.file, fs.createWriteStream(dest));
    } catch (err) {
      // Oversize files reject the stream (throwFileSizeLimit); clean up the partial file.
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      if (file.file.truncated || (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        reserved.reservation.release();
        return reply.code(413).send({ error: '文件过大' });
      }
      reserved.reservation.release();
      throw err;
    }
    try {
      if (file.file.truncated) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        return reply.code(413).send({ error: '文件过大' });
      }

      const size = fs.statSync(dest).size;
      const origName = file.filename ? String(file.filename).slice(0, 300) : null;
      const sniff = await sniffUpload(dest, origName);
      if (!sniff.ok) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        return reply.code(400).send({ error: sniff.error });
      }
      const finalName = `${id}.${sniff.ext}`;
      fs.renameSync(dest, path.join(config.dataDir, 'uploads', finalName));
      filename = finalName;
      dest = path.join(config.dataDir, 'uploads', finalName);

      try {
        db.insert(schema.uploads).values({
          id,
          userId: req.user!.id,
          filename,
          origName,
          mime: sniff.mime,
          size,
          createdAt: now(),
        }).run();
      } catch (err) {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        throw err;
      }

      return { id, mime: sniff.mime, size, name: origName };
    } finally {
      reserved.reservation.release();
    }
  });

  app.get('/api/uploads/:id/file', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get();
    if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    // Filename comes from the DB row, never from user path input.
    const filePath = path.join(config.dataDir, 'uploads', row.filename);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: '文件不存在' });
    reply.header('content-type', row.mime);
    if (row.origName) {
      // Keep the human filename on view/download without risking header injection.
      reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.origName)}`);
    }
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete('/api/uploads/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const row = db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get();
    if (!row || (row.userId !== req.user!.id && req.user!.role !== 'admin')) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    if (uploadIsReferenced(id)) {
      return reply.code(409).send({ error: '该附件已用于对话,不能删除' });
    }
    try { await fs.promises.unlink(path.join(config.dataDir, 'uploads', row.filename)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    db.delete(schema.uploads).where(eq(schema.uploads.id, id)).run();
    return { ok: true };
  });
}
