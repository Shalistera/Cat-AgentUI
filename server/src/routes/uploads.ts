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

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Read an upload back as base64 for feeding into adapters.
// Ownership is enforced: only the uploader may read it. Filename comes from
// the DB row (never user input), so no path traversal is possible.
export function readUploadBase64(uploadId: string, userId: string): { mime: string; dataBase64: string } | null {
  const row = db.select().from(schema.uploads).where(eq(schema.uploads.id, uploadId)).get();
  if (!row || row.userId !== userId) return null;
  try {
    const buf = fs.readFileSync(path.join(config.dataDir, 'uploads', row.filename));
    return { mime: row.mime, dataBase64: buf.toString('base64') };
  } catch {
    return null;
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 5 } });

  app.post('/api/uploads', async (req, reply) => {
    requireAuth(req, reply);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到文件' });
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) {
      return reply.code(400).send({ error: '仅支持 PNG / JPEG / WebP / GIF 图片' });
    }

    const id = newId();
    const ext = EXT_BY_MIME[file.mimetype] ?? 'png';
    const filename = `${id}.${ext}`;
    const dest = path.join(config.dataDir, 'uploads', filename);

    try {
      await pipeline(file.file, fs.createWriteStream(dest));
    } catch (err) {
      // Oversize files reject the stream (throwFileSizeLimit); clean up the partial file.
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      if (file.file.truncated || (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: '文件过大' });
      }
      throw err;
    }
    if (file.file.truncated) {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return reply.code(413).send({ error: '文件过大' });
    }

    const size = fs.statSync(dest).size;
    db.insert(schema.uploads).values({
      id,
      userId: req.user!.id,
      filename,
      origName: file.filename ? String(file.filename).slice(0, 300) : null,
      mime: file.mimetype,
      size,
      createdAt: now(),
    }).run();

    return { id, mime: file.mimetype, size };
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
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(filePath));
  });
}
