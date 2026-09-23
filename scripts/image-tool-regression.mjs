// Real chat/agent/image routes against a loopback Gemini stub and a temporary
// database. No real image service or credentials are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-image-tool-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const plans = new Map();
const offered = [];
const imageRequests = [];
let behavior = 'success';
let beforeTool;
let app;
let appLogs = '';
let base;
let admin;
let sql;
let sequence = 0;
let appPort;
let models;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw || '{}');
  const model = /models\/([^:]+):/.exec(req.url)?.[1];
  if (model === 'chat-model') {
    const parts = (body.contents ?? []).flatMap((c) => c.parts ?? []);
    const marker = parts.map((p) => p.text ?? '').join('\n').match(/CASE:\d+/)?.[0];
    const done = parts.some((p) => p.functionResponse?.name === 'generate_image');
    const defs = (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
    offered.push(defs);
    if (!done && beforeTool) { const hook = beforeTool; beforeTool = null; await hook(); }
    const output = done ? [{ text: '图片工具调用结束。' }]
      : (plans.get(marker) ?? []).map((args) => ({ functionCall: { name: 'generate_image', args } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: output.length ? output : [{ text: '没有调用工具。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`);
  }
  imageRequests.push({ model, body });
  const mode = behavior;
  if (mode === 'delay') await sleep(1500);
  if (res.destroyed) return;
  if (mode === 'fail') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid image request' } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ candidates: [{ content: { parts: mode === 'text' ? [{ text: '请补充画面描述。' }] : [{ inlineData: { mimeType: 'image/png', data: png } }] } }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 7, totalTokenCount: 10 } }));
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function poll(fn) {
  for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await sleep(50); }
  throw new Error(`Timed out. ${appLogs.slice(-3000)}`);
}
async function request(method, url, body, cookie = admin) {
  const res = await fetch(base + url, { method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function startApp() {
  appLogs = '';
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, SECRET_KEY: 'image-tool-test-secret', HOST: '127.0.0.1', PORT: String(appPort), COOKIE_SECURE: 'false', MAX_CHAT_CONCURRENCY_PER_USER: '4', CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (s) => { appLogs += s; }); app.stderr.on('data', (s) => { appLogs += s; });
  await poll(async () => { if (app.exitCode !== null) throw new Error(appLogs); return fetch(base + '/api/health').then((r) => r.ok).catch(() => false); });
}
async function stopApp() {
  if (!app || app.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => app.kill('SIGKILL'), 2000);
    app.once('exit', () => { clearTimeout(timer); resolve(); }); app.kill('SIGTERM');
  });
}
async function settings(patch) {
  const r = await request('PUT', '/api/admin/agent', { imageGeneration: patch });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.settings.imageGeneration;
}
async function turn(cookie, args = [{ prompt: '画一只小猫' }], options = {}) {
  const marker = `CASE:${++sequence}`; plans.set(marker, args);
  const c = await request('POST', '/api/chats', { modelId: models['chat-model'] }, cookie);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const id = c.json.chat.id;
  await request('PATCH', `/api/chats/${id}`, { title: marker }, cookie);
  const res = await fetch(`${base}/api/chats/${id}/stream`, {
    method: 'POST', headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' }, signal: options.signal,
    body: JSON.stringify({ modelId: options.modelId ?? models['chat-model'], content: [{ type: 'text', text: marker }] }),
  });
  if (options.raw) return { id, res };
  assert.equal(res.status, 200, await (res.ok ? Promise.resolve('') : res.text()));
  const events = [...(await res.text()).matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  return { id, events, images: events.filter((e) => e.type === 'image'), results: events.filter((e) => e.type === 'tool_result').map((e) => e.data) };
}
function moveUsageToYesterday(userId) { sql.prepare("UPDATE usage_log SET day='2000-01-01' WHERE user_id=? AND kind='image_tool'").run(userId); }
function toolRows(userId) { return sql.prepare("SELECT * FROM usage_log WHERE user_id=? AND kind='image_tool' ORDER BY created_at").all(userId); }
function expectError(r, pattern) { assert(r.results.some((p) => p.isError && pattern.test(p.result)), JSON.stringify(r)); assert.equal(r.images.length, 0); }

try {
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(); appPort = await listen(probe); await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${appPort}`;
  await startApp();
  admin = (await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' })).cookie;
  await request('PUT', '/api/admin/settings', { followupEnabled: false });
  const provider = (await request('POST', '/api/admin/providers', { name: 'image-tool stub', type: 'gemini', apiKey: 'mock-key-only', baseUrl: `http://127.0.0.1:${upstreamPort}` })).json;
  await request('POST', '/api/admin/models', { providerId: provider.id, models: ['chat-model', 'image-a', 'image-b', 'image-unlisted'].map((modelId) => ({ modelId, displayName: modelId, imageGen: modelId.startsWith('image'), tools: modelId === 'chat-model', vision: false })) });
  models = Object.fromEntries((await request('GET', '/api/admin/providers')).json.find((p) => p.id === provider.id).models.map((m) => [m.modelId, m.id]));
  for (const name of ['image-a', 'image-b', 'image-unlisted']) await request('PATCH', `/api/admin/models/${models[name]}`, { accessMode: 'restricted', allowedUserIds: [] });
  const people = [];
  for (const username of ['alice', 'bob']) {
    const created = await request('POST', '/api/admin/users', { username, password: 'password-123', role: 'user', allowImages: false, allowImageModels: false });
    const login = await request('POST', '/api/auth/login', { username, password: 'password-123' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    people.push({ ...login.json.user, cookie: login.cookie });
  }
  const [alice, bob] = people;
  sql = new Database(path.join(dataDir, 'cat-agentui.db'));
  assert.equal((await request('GET', '/api/admin/agent')).json.settings.imageGeneration.enabled, false);
  assert.equal((await request('PUT', '/api/admin/agent', { imageGeneration: { enabled: true } })).status, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { imageGeneration: { modelIds: [models['chat-model']] } })).status, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { imageGeneration: { enabled: true } }, alice.cookie)).status, 403);
  await request('PUT', '/api/admin/agent', { workspace: { enabled: false } });
  await settings({ enabled: true, modelIds: [models['image-a'], models['image-b']], dailyLimit: 2, maxPerTurn: 2 });
  assert((await request('GET', '/api/models', undefined, alice.cookie)).json.every((m) => !m.imageGen), 'tool grant does not expose hidden models');
  assert.equal((await request('GET', '/api/agent/capabilities', undefined, alice.cookie)).json.imageGeneration, true);
  const direct = await turn(alice.cookie, [], { raw: true, modelId: models['image-a'] });
  assert.equal(direct.res.status, 403); await direct.res.text();
  assert.equal((await request('POST', '/api/images/generate', { modelId: models['image-a'], prompt: 'direct forbidden' }, alice.cookie)).status, 403);

  const first = await turn(alice.cookie);
  assert.equal(first.images.length, 1); assert.equal(first.results[0].isError, false);
  const saved = (await request('GET', `/api/chats/${first.id}`, undefined, alice.cookie)).json.messages.at(-1);
  assert(saved.parts.some((p) => p.type === 'image' && p.imageId === first.images[0].data.imageId), 'generated image survives reload');
  const imageUrl = `/api/images/${first.images[0].data.imageId}/file`;
  assert.equal((await fetch(base + imageUrl, { headers: { cookie: alice.cookie } })).status, 200);
  assert.equal((await fetch(base + imageUrl, { headers: { cookie: bob.cookie } })).status, 404);
  const second = await turn(alice.cookie, [{ prompt: '另一张', model_id: models['image-b'] }]);
  assert.equal(second.images.length, 1);
  const offeredIds = offered.flat().find((d) => d.name === 'generate_image').parameters.properties.model_id.enum;
  assert.deepEqual(offeredIds, [models['image-a'], models['image-b']]);
  assert.deepEqual(imageRequests.slice(0, 2).map((r) => r.model), ['image-a', 'image-b']);
  assert.equal(toolRows(alice.id).length, 2); assert.equal(toolRows(alice.id).reduce((n, r) => n + r.images, 0), 2);
  assert.equal(toolRows(alice.id).reduce((n, r) => n + r.total_tokens, 0), 20);
  const count = imageRequests.length;
  expectError(await turn(alice.cookie), /今日调用次数已达上限/);
  assert.equal(imageRequests.length, count);
  await stopApp(); await startApp();
  expectError(await turn(alice.cookie, [{ prompt: '换模型也不行', model_id: models['image-b'] }]), /今日调用次数已达上限/);
  console.log('PASS: hidden models callable only through explicit tool grant; images persist and remain private; cross-model daily cap survives restart.');

  assert.equal((await turn(bob.cookie)).images.length, 1, 'daily budget is per user');
  behavior = 'delay';
  const concurrent = await Promise.all([turn(bob.cookie, [{ prompt: 'parallel A', model_id: models['image-a'] }]), turn(bob.cookie, [{ prompt: 'parallel B', model_id: models['image-b'] }])]);
  assert.equal(concurrent.reduce((n, r) => n + r.images.length, 0), 1, 'last daily slot cannot be spent twice');
  assert(concurrent.some((r) => r.results.some((p) => /今日调用次数已达上限/.test(p.result))));
  assert(concurrent.every((r) => r.events.some((e) => e.type === 'done' && e.data.status === 'done')), 'image tool does not trip text-provider idle timeout');
  behavior = 'success';
  for (let i = 0; i < 3; i++) assert.equal((await turn(admin)).images.length, 1, 'admin exempt from daily cap');
  moveUsageToYesterday(alice.id);
  assert.equal((await turn(alice.cookie)).images.length, 1, 'new server day has fresh quota');
  console.log('PASS: user isolation, concurrent last-slot reservation, long-running image call and administrator exemption.');

  let before = toolRows(alice.id).length;
  expectError(await turn(alice.cookie, [{ prompt: 'unauthorized model', model_id: models['image-unlisted'] }]), /可用列表/);
  expectError(await turn(alice.cookie, [{ prompt: '' }]), /参数无效/);
  assert.equal(toolRows(alice.id).length, before, 'invalid/rejected requests do not consume daily quota');
  await settings({ accessMode: 'restricted', allowedUserIds: [bob.id] });
  expectError(await turn(alice.cookie), /当前不可用/);
  await settings({ accessMode: 'shared', dailyLimit: 0, maxPerTurn: 1 });
  const burst = await turn(alice.cookie, [{ prompt: 'first' }, { prompt: 'second' }]);
  assert.equal(burst.images.length, 1); assert(burst.results[1].isError && /本轮/.test(burst.results[1].result));
  assert.equal((await request('PATCH', '/api/auth/profile', { settings: { agentTools: false } }, alice.cookie)).status, 200);
  expectError(await turn(alice.cookie), /当前不可用/);
  assert.equal((await request('PATCH', '/api/auth/profile', { settings: { agentTools: true } }, alice.cookie)).status, 200);
  beforeTool = () => settings({ enabled: false });
  expectError(await turn(alice.cookie), /未开放/);
  await settings({ enabled: true });
  await request('PATCH', `/api/admin/models/${models['image-a']}`, { limitRequests: 1 });
  expectError(await turn(alice.cookie), /使用次数已达上限/);
  await request('PATCH', `/api/admin/models/${models['image-a']}`, { limitRequests: 0, enabled: false });
  expectError(await turn(alice.cookie, [{ prompt: 'disabled', model_id: models['image-a'] }]), /可用列表/);
  await request('PATCH', `/api/admin/models/${models['image-a']}`, { enabled: true });
  console.log('PASS: allowlist, per-turn ceiling, personal/admin switches, execution-time revocation and model limits.');

  await settings({ dailyLimit: 1 }); moveUsageToYesterday(alice.id);
  behavior = 'fail'; before = toolRows(alice.id).length;
  expectError(await turn(alice.cookie), /图片生成失败/);
  assert.equal(toolRows(alice.id).length, before + 1, 'attempted upstream failure counts once');
  expectError(await turn(alice.cookie), /今日调用次数已达上限/);
  moveUsageToYesterday(alice.id); behavior = 'text';
  expectError(await turn(alice.cookie), /未生成图片/);
  moveUsageToYesterday(alice.id); behavior = 'delay';
  const controller = new AbortController(); const seen = imageRequests.length;
  const cancelled = await turn(alice.cookie, undefined, { raw: true, signal: controller.signal });
  await poll(() => imageRequests.length > seen); controller.abort(); await cancelled.res.body.cancel().catch(() => {});
  await poll(async () => (await request('GET', `/api/chats/${cancelled.id}`, undefined, alice.cookie)).json.messages.some((m) => m.status === 'stopped'));
  behavior = 'success'; expectError(await turn(alice.cookie), /今日调用次数已达上限/);
  moveUsageToYesterday(alice.id); assert.equal((await turn(alice.cookie)).images.length, 1, 'cancel releases image admission/storage');
  console.log('PASS: upstream failure, text-only response, cancellation accounting and lease cleanup.');
} finally {
  await stopApp(); sql?.close(); upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
