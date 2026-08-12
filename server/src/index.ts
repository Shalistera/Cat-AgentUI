import path from 'node:path';
import fs from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config, repoRoot } from './config.js';
import { runMigrations } from './db/index.js';
import { authPlugin } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chats.js';
import { providerRoutes } from './routes/providers.js';
import { adminRoutes } from './routes/admin.js';
import { imageRoutes } from './routes/images.js';
import { pptRoutes } from './routes/ppt.js';
import { uploadRoutes } from './routes/uploads.js';
import { mcpRoutes } from './routes/mcp.js';
import { importRoutes } from './routes/import.js';
import { projectRoutes } from './routes/projects.js';
import { initKnowledgeIndex } from './knowledge.js';
import { startRetentionSweeper } from './retention.js';
import { reconcileStorageMetadata } from './storage.js';
import { PasswordQueueFullError } from './crypto.js';

// Slow image gateways can sit for many minutes before sending response
// headers; undici's default 300s headersTimeout would abort those upstream
// calls no matter what AbortSignal the route passes. Long thinking pauses in
// reasoning-model streams hit the same wall via bodyTimeout.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

async function main() {
  runMigrations();
  initKnowledgeIndex();
  await reconcileStorageMetadata();

  const app = Fastify({
    logger: { level: 'warn' },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  // NOTE: called directly (not app.register) so the auth hook applies at root
  // scope and is inherited by every route plugin — register() would encapsulate it.
  await authPlugin(app);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (reply.sent) return;
    if (err.message === 'unauthorized') return reply.code(401).send({ error: '请先登录' });
    if (err.message === 'forbidden') return reply.code(403).send({ error: '需要管理员权限' });
    if (err instanceof PasswordQueueFullError) return reply.code(503).send({ error: err.message });
    req.log.error(err);
    reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500)
      .send({ error: err.statusCode === 413 ? '请求体过大' : '服务器内部错误' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(chatRoutes);
  await app.register(providerRoutes);
  await app.register(adminRoutes);
  await app.register(imageRoutes);
  await app.register(pptRoutes);
  await app.register(uploadRoutes);
  await app.register(mcpRoutes);
  await app.register(importRoutes);
  await app.register(projectRoutes);

  // static SPA
  const webDist = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders(reply, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not Found' });
    } else if (fs.existsSync(path.join(webDist, 'index.html'))) {
      reply.type('text/html').header('cache-control', 'no-cache');
      reply.send(fs.createReadStream(path.join(webDist, 'index.html')));
    } else {
      reply.code(404).send('web/dist 尚未构建');
    }
  });

  await app.listen({ port: config.port, host: config.host });
  console.log(`🐈‍⬛ Cat-AgentUI listening on http://${config.host}:${config.port}`);
  startRetentionSweeper();

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      try { await app.close(); } finally { process.exit(0); }
    });
  }
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
