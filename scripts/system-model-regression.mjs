// System-only models: real routes, temporary database, in-process fake models.
// No requests to real providers or changes to the running application's data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-system-model-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'system-model-regression';
process.env.MAX_CONTEXT_TEXT_CHARS = '12000';
const { db, rawDb, schema, runMigrations, setSetting } = await import('../server/dist/db/index.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { canUseModel, canUseSystemModel } = await import('../server/dist/model-access.js');
const { providerRoutes } = await import('../server/dist/routes/providers.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { adminRoutes } = await import('../server/dist/routes/admin.js');
const { translateRoutes } = await import('../server/dist/routes/translate.js');
const { pptRoutes } = await import('../server/dist/routes/ppt.js');
const { imageRoutes } = await import('../server/dist/routes/images.js');
const { ocrRoutes } = await import('../server/dist/routes/ocr.js');
const { agentRoutes } = await import('../server/dist/routes/agent.js');
const { imageToolModelsFor } = await import('../server/dist/image-tool.js');
const { getAdapter } = await import('../server/dist/providers/index.js');
const { ProviderBusyError } = await import('../server/dist/providers/sse.js');

const app = Fastify();
app.setErrorHandler((err, _req, reply) => reply.code(err.message === 'forbidden' ? 403 : err.message === 'unauthorized' ? 401 : 500).send({ error: err.message }));
const adapter = getAdapter('openai');
const originalStream = adapter.streamChat;
const calls = [];
let systemFails = false;
adapter.streamChat = async function* (cfg, req) {
  calls.push({ provider: cfg.id, model: req.model, system: req.system ?? '', messages: req.messages });
  if (req.model === 'primary-busy' || (systemFails && req.model === 'internal-helper')) throw new ProviderBusyError('Fixture', 429, 'busy');
  const lastUser = req.messages.filter((m) => m.role === 'user').at(-1)?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') ?? '';
  const summarized = req.system?.includes('负责压缩一段很长的对话');
  const child = req.system?.includes('你是一个子代理');
  if (!child && lastUser.includes('DELEGATE') && !req.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))) {
    yield { type: 'tool_call', id: 'delegate-call', name: 'spawn_subagent', args: JSON.stringify({ task: 'Return a short conclusion.' }) };
    yield { type: 'stop', reason: 'tool_calls' };
    return;
  }
  const text = summarized ? '摘要:保留用户要求和已确认的事实。' : child ? 'Delegated conclusion'
    : req.maxTokens === 500 ? (lastUser.includes('标题') ? 'Fixture title' : '["Question one?","Question two?","Question three?"]')
    : `Answer from ${req.model}: ${'答'.repeat(1500)}`;
  yield { type: 'text', text };
  yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  yield { type: 'stop', reason: 'stop' };
};
const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const admin = (method, url, payload) => request(method, url, payload, 'admin');
const events = (r) => [...r.body.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
const newChat = async (modelId = 'normal', title = 'Fixture') => {
  const r = await request('POST', '/api/chats', { modelId });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().chat.id;
  if (title) assert.equal((await request('PATCH', `/api/chats/${id}`, { title })).statusCode, 200);
  return id;
};
const turn = (id, payload = { content: [{ type: 'text', text: 'Question' }] }, user) => request('POST', `/api/chats/${id}/stream`, payload, user);
const alice = { id: 'alice', role: 'user' };

try {
  runMigrations();
  for (const id of ['admin', 'alice', 'bob']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'unused', role: id === 'admin' ? 'admin' : 'user',
      allowImages: 1, allowImageModels: 1, settings: JSON.stringify({ favoriteModels: ['system'], modelOrder: ['system'] }), createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'p', name: 'Fixture', type: 'openai', createdAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'g', name: 'Gemini fixture', type: 'gemini', createdAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'local', name: 'Subscription', type: 'claude-code', createdAt: Date.now() }).run();
  for (const [id, modelId, extra] of [
    ['normal', 'normal', { sortOrder: -2 }], ['primary', 'primary-busy', { sortOrder: -1 }],
    ['system', 'internal-helper', { accessMode: 'system', isDefault: 1, sortOrder: -3 }],
    ['other-system', 'other-internal', { accessMode: 'system' }],
    ['locked', 'restricted-helper', { accessMode: 'restricted' }],
    ['system-image', 'internal-image', { accessMode: 'system', imageGen: 1 }],
    ['system-ocr', 'internal-ocr', { providerId: 'g', accessMode: 'system', vision: 1 }],
    ['visible-image', 'visible-image', { imageGen: 1 }],
    ['local-system', 'claude-local', { providerId: 'local', accessMode: 'system' }],
  ]) db.insert(schema.models).values({ id, providerId: 'p', modelId, ...extra, createdAt: Date.now() }).run();
  db.insert(schema.modelAccess).values({ modelId: 'system', userId: 'alice', createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  await app.register(cookie);
  await authPlugin(app);
  for (const register of [providerRoutes, chatRoutes, adminRoutes, translateRoutes, pptRoutes, imageRoutes, ocrRoutes, agentRoutes]) await register(app);

  assert(!canUseModel(alice, 'system'), 'old grants cannot make a system-only model directly usable');
  assert(canUseSystemModel(alice, 'system'));
  assert(!canUseSystemModel(alice, 'locked'));
  assert(!canUseSystemModel(alice, 'local-system'), 'subscription-only providers retain their separate restriction');
  for (const url of ['/api/models', '/api/ppt/models', '/api/images/models']) {
    const userList = (await request('GET', url)).json();
    assert(!userList.some((m) => ['system', 'other-system', 'system-image', 'system-ocr', 'local-system'].includes(m.id)), url);
    const adminList = (await admin('GET', url)).json();
    assert(adminList.some((m) => m.id === (url.includes('/images/') ? 'system-image' : 'system')), url);
  }
  assert.equal((await admin('GET', '/api/models')).json().find((m) => m.id === 'system').accessMode, 'system');
  assert.equal((await admin('PATCH', '/api/admin/models/system', { accessMode: 'system', allowedUserIds: ['alice'] })).json().accessMode, 'system');
  assert.equal((await request('PATCH', '/api/admin/models/system', { accessMode: 'shared' })).statusCode, 403);

  const direct = await newChat();
  const beforeDirect = calls.length;
  assert.equal((await request('POST', '/api/chats', { modelId: 'system' })).statusCode, 403);
  assert.equal((await request('PATCH', `/api/chats/${direct}`, { modelId: 'system' })).statusCode, 403);
  assert.equal((await turn(direct, { modelId: 'system', content: [{ type: 'text', text: 'forged direct call' }] })).statusCode, 403);
  assert.equal((await turn(direct, { modelId: 'system', automaticFallback: true })).statusCode, 400);
  assert.equal((await request('POST', '/api/ppt/generate', { modelId: 'system', topic: 'Example' })).statusCode, 403);
  assert.equal((await request('POST', '/api/ocr/stream', { modelId: 'system-ocr', uploadIds: ['missing'], format: 'text' })).statusCode, 403);
  assert.equal((await request('POST', '/api/images/generate', { modelId: 'system-image', prompt: 'Example' })).statusCode, 403);
  assert.equal(calls.length, beforeDirect, 'direct access is denied before provider work');
  const defaultChat = await newChat(null);
  assert(events(await turn(defaultChat)).some((e) => e.type === 'meta' && e.data.model === 'normal'), 'hidden global defaults do not become a user chat default');

  // Hidden automatic recovery: the client sends only the failed message id.
  assert.equal((await admin('PATCH', '/api/admin/models/primary', { fallbackModelId: 'system' })).statusCode, 200);
  const source = (await request('GET', '/api/models')).json().find((m) => m.id === 'primary');
  assert.equal(source.fallbackModelId, null);
  assert.equal(source.systemFallbackAvailable, true);
  const chat = await newChat('primary');
  const requestId = randomUUID();
  const first = await turn(chat, { requestId, allowSystemFallback: true, content: [{ type: 'text', text: 'Keep this original question' }] });
  const firstEvents = events(first);
  const failedId = firstEvents.find((e) => e.type === 'meta').data.messageId;
  assert(firstEvents.some((e) => e.type === 'error' && e.data.code === 'provider_busy'));
  const receipt = (await request('GET', `/api/chats/${chat}/stream-state?requestId=${requestId}`)).json();
  assert.equal(receipt.fallbackModelId, null);
  assert.equal(receipt.systemFallbackAvailable, true, 'reconnects retain the opaque recovery option');
  assert.equal((await turn(chat, { regenerateMessageId: failedId, modelId: 'other-system', automaticFallback: true })).statusCode, 400);
  assert.equal((await turn(chat, { regenerateMessageId: failedId, automaticFallback: true, content: [{ type: 'text', text: 'substitute question' }] })).statusCode, 400);
  assert.equal((await turn(chat, { regenerateMessageId: failedId, automaticFallback: true }, 'bob')).statusCode, 404);
  const recovered = await turn(chat, { regenerateMessageId: failedId, automaticFallback: true });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.match(recovered.body, /Answer from internal-helper/);
  assert(!events(recovered).some((e) => e.type === 'model_selected'));
  const saved = (await request('GET', `/api/chats/${chat}`)).json();
  assert.equal(saved.chat.modelId, 'primary');
  assert.equal(saved.messages.filter((m) => m.role === 'user').length, 1);
  assert(saved.messages.some((m) => m.parts.some((p) => p.type === 'model_fallback' && p.toModelId === 'system' && !p.adopted)));
  assert.equal((await turn(chat, { regenerateMessageId: failedId, automaticFallback: true })).statusCode, 409);
  assert.equal((await turn(chat, { modelId: 'system', content: [{ type: 'text', text: 'direct continuation' }] })).statusCode, 403);

  const failedChat = await newChat('primary');
  const failed = events(await turn(failedChat, { allowSystemFallback: true, content: [{ type: 'text', text: 'second question' }] })).find((e) => e.type === 'meta').data.messageId;
  systemFails = true;
  const failedBackup = events(await turn(failedChat, { regenerateMessageId: failed, automaticFallback: true })).find((e) => e.type === 'meta').data.messageId;
  assert.equal((await turn(failedChat, { regenerateMessageId: failedBackup, automaticFallback: true })).statusCode, 400, 'no automatic fallback chain');
  systemFails = false;
  await admin('PATCH', '/api/admin/models/system', { enabled: false });
  assert.equal((await request('GET', '/api/models')).json().find((m) => m.id === 'primary').systemFallbackAvailable, false);
  assert.equal((await turn(failedChat, { regenerateMessageId: failed, automaticFallback: true })).statusCode, 400);
  await admin('PATCH', '/api/admin/models/system', { enabled: true });

  await admin('PATCH', '/api/admin/models/system', { limitPeriod: 'day', limitRequests: 1 });
  assert.equal((await request('GET', '/api/models')).json().find((m) => m.id === 'primary').systemFallbackAvailable, false);
  const limitedChat = await newChat('primary');
  const limitedFailure = events(await turn(limitedChat)).find((e) => e.type === 'meta').data.messageId;
  const beforeLimited = calls.length;
  assert.equal((await turn(limitedChat, { regenerateMessageId: limitedFailure, automaticFallback: true })).statusCode, 429);
  assert.equal(calls.length, beforeLimited, 'hidden recovery targets still enforce their usage limit');
  await admin('PATCH', '/api/admin/models/system', { limitRequests: null });

  // Quota fallback is a separate admin-authorized system call.
  assert.equal((await admin('PUT', '/api/admin/settings', { quotaAction: 'downgrade', quotaFallbackModelId: 'system' })).statusCode, 200);
  db.update(schema.users).set({ monthlyTokenQuota: 1 }).where(eq(schema.users.id, 'alice')).run();
  const quotaChat = await newChat();
  assert.match((await turn(quotaChat)).body, /Answer from internal-helper/);
  assert.equal((await request('GET', `/api/chats/${quotaChat}`)).json().chat.modelId, 'normal');
  await admin('PUT', '/api/admin/settings', { quotaFallbackModelId: 'locked' });
  assert.equal((await turn(quotaChat)).statusCode, 429, 'quota fallback cannot bypass restricted-model grants');
  db.update(schema.users).set({ monthlyTokenQuota: null }).where(eq(schema.users.id, 'alice')).run();
  await admin('PUT', '/api/admin/settings', { quotaAction: 'block' });

  // Every task picker can retain a system-only target; task execution can use it.
  const settings = await admin('PUT', '/api/admin/settings', {
    titleModelId: 'system', followupModelId: 'system', followupEnabled: true,
    compactionModelId: 'system', compactionFallbackToChat: false,
    translateDefaultModels: [{ modelId: 'system', mode: 'fast' }],
    translateFastModels: [{ modelId: 'system', mode: 'fast' }],
  });
  assert.equal(settings.statusCode, 200, settings.body);
  assert.equal(settings.json().compactionModelId, 'system');
  const taskChat = await newChat('normal', '');
  assert.equal((await turn(taskChat)).statusCode, 200);
  const kinds = rawDb.prepare('SELECT kind, model FROM usage_log WHERE chat_id = ?').all(taskChat);
  for (const kind of ['title', 'followup']) assert(kinds.some((u) => u.kind === kind && u.model === 'internal-helper'), kind);
  const translated = await request('POST', '/api/translate/stream', { text: 'Translate this', source: 'en', target: 'zh-CN', mode: 'fast' });
  assert.match(translated.body, /Answer from internal-helper/);
  await admin('PUT', '/api/admin/settings', { followupEnabled: false });
  const longChat = await newChat();
  let compacted = false;
  for (let i = 0; i < 7 && !compacted; i++) {
    const result = await turn(longChat, { content: [{ type: 'text', text: `Turn ${i} ${'问'.repeat(1400)}` }] });
    compacted = events(result).some((e) => e.type === 'context_summary' && e.data.state === 'done');
  }
  assert(compacted);
  assert.equal(rawDb.prepare('SELECT model FROM chat_summaries WHERE chat_id = ?').get(longChat).model, 'internal-helper');
  assert.equal((await admin('PUT', '/api/admin/agent', {
    subagent: { enabled: true, modelId: 'system' }, imageGeneration: { enabled: true, modelIds: ['system-image'] },
  })).statusCode, 200);
  assert(imageToolModelsFor(alice).some((r) => r.model.id === 'system-image'));
  const delegated = await newChat();
  const sub = await turn(delegated, { content: [{ type: 'text', text: 'DELEGATE' }] });
  assert.equal(sub.statusCode, 200, sub.body);
  assert(rawDb.prepare("SELECT model FROM usage_log WHERE chat_id = ? AND kind = 'subagent'").all(delegated).some((r) => r.model === 'internal-helper'));
  assert(!(await request('GET', '/api/models')).json().some((m) => m.id === 'system'), 'system use never grants direct visibility');
  console.log('System model regression passed: hidden catalogs + stale grants, direct API denial, opaque fallback + recovery, no adoption/loops, quota fallback, admin task settings, title/follow-up/translation/compaction/subagent/image-tool access.');
} finally {
  adapter.streamChat = originalStream;
  await app.close();
  rawDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
