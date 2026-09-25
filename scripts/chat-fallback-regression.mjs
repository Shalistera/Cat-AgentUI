import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-fallback-'));
const calls = new Map();
let app, base, admin, logs = '';
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume */ }
  const model = /models\/([^:]+):/.exec(req.url)?.[1];
  calls.set(model, (calls.get(model) ?? 0) + 1);
  if (model === 'tool-busy' && calls.get(model) === 1) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'workspace_list', args: {} } }] }, finishReason: 'STOP' }] })}\n\n`);
  } else if (model !== 'backup-ok') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"model busy"}}');
  } else {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Answer from configured backup' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } })}\n\n`);
  }
});
async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; }
async function request(method, url, body, cookie = admin) {
  const res = await fetch(base + url, { method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const events = (text) => [...text.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
async function turn(chatId, body, cookie = admin) {
  const res = await fetch(`${base}/api/chats/${chatId}/stream`, { method: 'POST', headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, events: events(text), text };
}
async function newChat(modelId) {
  const id = (await request('POST', '/api/chats', { modelId })).data.chat.id;
  await request('PATCH', `/api/chats/${id}`, { title: 'Fallback regression' });
  return id;
}
try {
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(); const port = await listen(probe); await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env: {
    ...process.env, DATA_DIR: dataDir, SECRET_KEY: 'test-configured-model-fallback', HOST: '127.0.0.1', PORT: String(port),
    COOKIE_SECURE: 'false', PROVIDER_RETRY_MAX_WAIT_SECONDS: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => { logs += d; }); app.stderr.on('data', (d) => { logs += d; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/api/health').then((r) => r.ok).catch(() => false)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(ready, logs);
  admin = (await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' })).cookie;
  await request('PUT', '/api/admin/settings', { followupEnabled: false });
  const provider = (await request('POST', '/api/admin/providers', { name: 'Fallback mock', type: 'gemini', baseUrl: `http://127.0.0.1:${upstreamPort}` })).data;
  const names = ['primary-busy', 'backup-ok', 'backup-busy', 'tool-busy'];
  await request('POST', '/api/admin/models', { providerId: provider.id, models: names.map((modelId) => ({ modelId, displayName: modelId, vision: true, tools: true })) });
  const models = Object.fromEntries((await request('GET', '/api/admin/providers')).data[0].models.map((m) => [m.modelId, m.id]));
  const setFallback = (source, target) => request('PATCH', `/api/admin/models/${models[source]}`, { fallbackModelId: target ? models[target] : null });
  assert.equal((await setFallback('primary-busy', 'backup-ok')).data.fallbackModelId, models['backup-ok']);
  assert.equal((await setFallback('primary-busy', 'primary-busy')).status, 400);
  assert.equal((await request('GET', '/api/models')).data.find((m) => m.id === models['primary-busy']).fallbackModelId, models['backup-ok']);
  const chat = await newChat(models['primary-busy']);
  const first = await turn(chat, { modelId: models['primary-busy'], fallbackModelId: models['backup-ok'], content: [{ type: 'text', text: 'keep this question' }] });
  assert.equal(calls.get('primary-busy'), 1);
  const failedId = first.events.find((e) => e.type === 'meta').data.messageId;
  assert(first.events.some((e) => e.type === 'error' && e.data.code === 'provider_busy'));
  const fallback = await turn(chat, { regenerateMessageId: failedId, modelId: models['backup-ok'], automaticFallback: true });
  assert.equal(fallback.status, 200);
  assert(fallback.events.some((e) => e.type === 'model_selected' && e.data.modelId === models['backup-ok']));
  const saved = (await request('GET', `/api/chats/${chat}`)).data;
  assert.equal(saved.chat.modelId, models['backup-ok'], 'only successful fallback becomes the chat model');
  assert.equal(saved.messages.filter((m) => m.role === 'user').length, 1, 'same original question is reused');
  assert(saved.messages.at(-1).parts.some((p) => p.type === 'model_fallback' && p.adopted && p.fromModelId === models['primary-busy']));
  const followup = await turn(chat, { content: [{ type: 'text', text: 'continue with the backup' }] });
  assert(followup.events.some((e) => e.type === 'meta' && e.data.model === 'backup-ok'));
  assert.equal(calls.get('primary-busy'), 1, 'next turn does not hit the busy original again');
  const beforeDuplicate = calls.get('backup-ok');
  const duplicate = await turn(chat, { regenerateMessageId: failedId, modelId: models['backup-ok'], automaticFallback: true });
  assert.equal(duplicate.status, 409, 'the same failed reply can only automatically fall back once across tabs/reloads');
  assert.equal(calls.get('backup-ok'), beforeDuplicate);
  await request('PATCH', `/api/chats/${chat}`, { modelId: models['primary-busy'] });
  assert.equal((await request('GET', `/api/chats/${chat}`)).data.chat.modelId, models['primary-busy'], 'original model can be restored');

  await setFallback('primary-busy', 'backup-busy');
  await setFallback('backup-busy', 'primary-busy'); // even a configured cycle must stop after one automatic attempt
  const failingChat = await newChat(models['primary-busy']);
  const f = await turn(failingChat, { fallbackModelId: models['backup-busy'], content: [{ type: 'text', text: 'fail safely' }] });
  const fId = f.events.find((e) => e.type === 'meta').data.messageId;
  const b = await turn(failingChat, { regenerateMessageId: fId, modelId: models['backup-busy'], automaticFallback: true });
  assert(b.events.some((e) => e.type === 'done' && e.data.status === 'error'));
  assert(!b.events.some((e) => e.type === 'model_selected'));
  assert.equal((await request('GET', `/api/chats/${failingChat}`)).data.chat.modelId, models['primary-busy']);
  const bId = b.events.find((e) => e.type === 'meta').data.messageId;
  assert.equal((await turn(failingChat, { regenerateMessageId: bId, modelId: models['primary-busy'], automaticFallback: true })).status, 400, 'no automatic fallback chain');

  await setFallback('tool-busy', 'backup-ok');
  const toolChat = await newChat(models['tool-busy']);
  const tool = await turn(toolChat, { fallbackModelId: models['backup-ok'], content: [{ type: 'text', text: 'tool turn' }] });
  assert(tool.events.some((e) => e.type === 'tool_call'));
  const toolId = tool.events.find((e) => e.type === 'meta').data.messageId;
  assert.equal((await turn(toolChat, { regenerateMessageId: toolId, modelId: models['backup-ok'], automaticFallback: true })).status, 400, 'executed tools cannot be automatically replayed');

  await request('POST', '/api/admin/users', { username: 'alice', password: 'password-123', role: 'user' });
  const alice = (await request('POST', '/api/auth/login', { username: 'alice', password: 'password-123' }, '')).cookie;
  assert(alice);
  await setFallback('primary-busy', 'backup-ok');
  await request('PATCH', `/api/admin/models/${models['backup-ok']}`, { accessMode: 'restricted', allowedUserIds: [] });
  const visible = (await request('GET', '/api/models', undefined, alice)).data;
  assert.equal(visible.find((m) => m.id === models['primary-busy']).fallbackModelId, null, 'restricted fallback is never exposed to an unauthorized user');
  assert.equal((await request('PATCH', `/api/admin/models/${models['primary-busy']}`, { fallbackModelId: null }, alice)).status, 403);
  assert.equal((await setFallback('primary-busy', null)).data.fallbackModelId, null, 'automatic fallback can be disabled');
  console.log('Passed: configurable fallback, same-provider target, sticky success, failure rollback, original-question reuse, no tool replay/loop, disable and permission isolation.');
} finally {
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); setTimeout(() => app.kill('SIGKILL'), 2000).unref(); });
  upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
