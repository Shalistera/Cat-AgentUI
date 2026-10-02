import path from 'node:path';
import fs from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config, repoRoot } from './config.js';
import { rawDb, runMigrations } from './db/index.js';
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
import { eventRoutes } from './routes/events.js';
import { searchRoutes } from './routes/search.js';
import { ocrRoutes } from './routes/ocr.js';
import { translateRoutes } from './routes/translate.js';
import { initKnowledgeIndex } from './knowledge.js';
import { workspaceRoutes } from './routes/workspace.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { skillRoutes } from './routes/skills.js';
import { agentRoutes } from './routes/agent.js';
import { reconcileSkills } from './skills.js';
import { probeSandboxEnv } from './sandbox/env.js';
import { warmPackagesCache } from './sandbox/venv.js';
import { sweepOrphanWorkspaces } from './workspace.js';
import { startRetentionSweeper } from './retention.js';
import { startBackupScheduler } from './backup.js';
import { reconcileStorageMetadata } from './storage.js';
import { PasswordQueueFullError } from './crypto.js';
import {
  allConfiguredSecretValues, migrateLegacyProviderHeaders, redactSensitiveText,
  scrubPersistedSecretEchoes,
} from './secrets.js';

// Slow image gateways can sit for many minutes before sending response
// headers; undici's default 300s headersTimeout would abort those upstream
// calls no matter what AbortSignal the route passes. Long thinking pauses in
// reasoning-model streams hit the same wall via bodyTimeout.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

async function main() {
  runMigrations();
  // A reply still marked 'streaming' after a restart was cut off by the crash
  // or restart itself; mark it so the UI can say so and offer 重新生成.
  rawDb.prepare("UPDATE messages SET status = 'error', error = ? WHERE status = 'streaming'")
    .run('服务重启,回复中断');
  const secretsMigrated = migrateLegacyProviderHeaders();
  const secretEchoesScrubbed = scrubPersistedSecretEchoes();
  if (secretsMigrated || secretEchoesScrubbed) {
    // No request can be in flight yet. Merge the sanitized pages and discard
    // old WAL frames that may still contain a pre-redaction plaintext value.
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
  }
  initKnowledgeIndex();
  await reconcileStorageMetadata();
  sweepOrphanWorkspaces();
  reconcileSkills();
  // Host probes take a few seconds; run them off the startup path so the
  // first chat turn already knows whether run_command can be offered.
  probeSandboxEnv().then(() => warmPackagesCache()).catch(() => { /* reported on the admin page */ });

  const app = Fastify({
    logger: {
      level: 'warn',
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.cookie', "req.headers['x-api-key']",
          "res.headers['set-cookie']",
        ],
        censor: '[敏感信息已隐藏]',
      },
    },
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
    if (err.message === 'no-images-access') return reply.code(403).send({ error: '没有绘图工坊访问权限,请联系管理员开通' });
    if (err instanceof PasswordQueueFullError) return reply.code(503).send({ error: err.message });
    const secretValues = allConfiguredSecretValues();
    const safeMessage = redactSensitiveText(err.message, secretValues);
    const safeStack = err.stack ? redactSensitiveText(err.stack, secretValues) : undefined;
    req.log.error({ err: { name: err.name, message: safeMessage, stack: safeStack } });
    reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500)
      .send({ error: err.statusCode === 413 ? '请求体过大' : '服务器内部错误' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Credentials are only accepted on admin/auth requests and are never echoed;
  // explicitly forbid browser/proxy caches from retaining those responses.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/admin/') || req.url.startsWith('/api/auth/')) {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
    }
    return payload;
  });

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
  await app.register(eventRoutes);
  await app.register(searchRoutes);
  await app.register(ocrRoutes);
  await app.register(translateRoutes);
  await app.register(workspaceRoutes);
  await app.register(sandboxRoutes);
  await app.register(skillRoutes);
  await app.register(agentRoutes);

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
  startBackupScheduler();

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      try { await app.close(); } finally { process.exit(0); }
    });
  }
}

main().catch((e) => {
  const raw = e instanceof Error ? (e.stack || e.message) : String(e);
  console.error('启动失败:', redactSensitiveText(raw, [config.secretKey]));
  process.exit(1);
});
