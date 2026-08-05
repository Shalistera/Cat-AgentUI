import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { config } from '../config.js';
import { requireAdmin } from '../auth.js';
import { importOpenwebui } from '../openwebui-import.js';
import { newId } from '../crypto.js';

// webui.db files grow well past the site-wide upload cap; this scope gets its
// own multipart registration so the big limit stays confined to admin imports.
const MAX_DB_BYTES = 4 * 1024 * 1024 * 1024;

export async function importRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: MAX_DB_BYTES, files: 1 } });

  // Import users + chat history from an uploaded Open WebUI webui.db.
  // Multipart fields: file (webui.db) · dryRun ('1') · skipArchived ('1')
  //                 · dataDir (server-side path to Open WebUI's data dir, optional)
  app.post('/api/admin/import/openwebui', async (req, reply) => {
    requireAdmin(req, reply);

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: '未收到 webui.db 文件' });

    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const fieldStr = (name: string): string => {
      const v = fields[name]?.value;
      return typeof v === 'string' ? v : '';
    };
    const dryRun = fieldStr('dryRun') === '1';
    const skipArchived = fieldStr('skipArchived') === '1';
    const dataDir = fieldStr('dataDir').trim();

    if (dataDir && !fs.existsSync(dataDir)) {
      // fail before the (possibly long) upload sits around half-consumed
      file.file.resume();
      return reply.code(400).send({ error: `服务器上找不到附件目录: ${dataDir}` });
    }

    const tmpPath = path.join(config.dataDir, `owui-import-${newId()}.db.tmp`);
    try {
      await pipeline(file.file, fs.createWriteStream(tmpPath));
      if (file.file.truncated) {
        return reply.code(413).send({ error: '文件过大' });
      }
      // Synchronous by design (better-sqlite3): the server pauses for the few
      // seconds the import runs — acceptable for an admin-only maintenance op.
      const report = importOpenwebui({
        dbPath: tmpPath,
        dataDir: dataDir || null,
        dryRun,
        skipArchived,
      });
      return { report };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : '导入失败' });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });
}
