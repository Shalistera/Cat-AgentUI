// Explicit 429 retry/cancel semantics and the real chat/image routes.
// Temporary DB, loopback mock Gemini endpoint; no provider credentials needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchRetry } from '../server/dist/providers/sse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-retry-'));
const secret = 'sk-retry-regression-private-key';
const counts = new Map();
let recovered = false;
let app;
let appLogs = '';
let base;
let admin;

async function transportChecks() {
  let calls = 0;
  try {
    for (const retryAfter of ['60', new Date(Date.now() + 120_000).toUTCString()]) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } }); };
      assert.equal((await fetchRetry('http://test', {})).status, 429);
      assert.equal(calls, 1, 'never retry before a Retry-After that exceeds the wait budget');
    }
    for (const status of [400, 401, 403, 500]) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{}', { status }); };
      assert.equal((await fetchRetry('http://test', {})).status, status);
      assert.equal(calls, 1, 'first version only retries explicit 429 responses');
    }
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '10' } }); };
    const abort = new AbortController();
    await assert.rejects(fetchRetry('http://test', { signal: abort.signal }, (state) => {
      if (state) { assert.equal(state.delayMs, 10_000); abort.abort(); }
    }), { name: 'AbortError' });
    assert.equal(calls, 1, 'cancelled backoff never sends a second request');

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    };
    await assert.rejects(fetchRetry('http://test', {}));
    assert.equal(calls, 1, 'ambiguous mid-flight network errors are not replayed');
  } finally { globalThis.fetch = realFetch; }
}

const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume request */ }
  const model = /models\/([^:]+):/.exec(req.url)?.[1] ?? 'unknown';
  const n = (counts.get(model) ?? 0) + 1;
  counts.set(model, n);
  const busy = model.includes('cancel') || (model === 'retry-exhaust' && !recovered)
    || (model === 'retry-tool' && n === 2)
    || (model.includes('success') && n <= 2);
  if (busy) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `quota exhausted; api_key=${secret}` } }));
    return;
  }
  if (model === 'retry-tool' && n === 1) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'workspace_list', args: {} } }] }, finishReason: 'STOP' }] })}\n\n`);
    return;
  }
  if (model.startsWith('image-')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
      mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    } }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'PRESERVED OUTPUT' }] } }] })}\n\n`);
  if (model === 'retry-partial') {
    setTimeout(() => res.destroy(), 150);
    return;
  }
  res.end(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } })}\n\n`);
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function request(method, url, body, cookie = admin) {
  const res = await fetch(base + url, {
    method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function poll(fn) {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error('poll timed out');
}
function events(text) {
  return [...text.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
}

try {
  await transportChecks();
  const upstreamPort = await listen(upstream);
  const portProbe = http.createServer();
  const port = await listen(portProbe);
  await new Promise((r) => portProbe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, SECRET_KEY: 'retry-test-database-secret', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (s) => { appLogs += s; }); app.stderr.on('data', (s) => { appLogs += s; });
  await poll(async () => {
    if (app.exitCode !== null) throw new Error(appLogs);
    return fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
  });
  const registered = await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' });
  assert.equal(registered.status, 200); admin = registered.cookie;
  await request('PUT', '/api/admin/settings', { followupEnabled: false });
  const provider = await request('POST', '/api/admin/providers', { name: 'retry mock', type: 'gemini', apiKey: secret, baseUrl: `http://127.0.0.1:${upstreamPort}` });
  assert.equal(provider.status, 200);
  const names = ['retry-success', 'retry-exhaust', 'retry-cancel', 'retry-partial', 'retry-tool', 'image-success', 'image-cancel'];
  await request('POST', '/api/admin/models', { providerId: provider.json.id, models: names.map((modelId) => ({ modelId, displayName: modelId, vision: true, tools: modelId === 'retry-tool', imageGen: modelId.startsWith('image-') })) });
  const providers = await request('GET', '/api/admin/providers');
  const models = Object.fromEntries(providers.json.find((p) => p.id === provider.json.id).models.map((m) => [m.modelId, m.id]));
  const form = new FormData(); form.append('file', new Blob(['keep this attachment'], { type: 'text/plain' }), 'keep.txt');
  const uploaded = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie: admin, 'x-csrf': '1' }, body: form });
  const uploadId = (await uploaded.json()).id;

  async function turn(name, signal) {
    const chat = await request('POST', '/api/chats', { modelId: models[name] });
    const id = chat.json.chat.id;
    await request('PATCH', `/api/chats/${id}`, { title: 'Retry regression' });
    const res = await fetch(`${base}/api/chats/${id}/stream`, {
      method: 'POST', headers: { cookie: admin, 'x-csrf': '1', 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ modelId: models[name], content: [{ type: 'text', text: name }, { type: 'file', uploadId }] }),
    });
    assert.equal(res.status, 200);
    return { id, res };
  }
  const success = await turn('retry-success');
  const successEvents = events(await success.res.text());
  assert.equal(counts.get('retry-success'), 3);
  assert.equal(successEvents.filter((e) => e.type === 'retry' && e.data?.delayMs > 0).length, 2);
  assert(successEvents.some((e) => e.type === 'delta'));
  assert.equal(successEvents.find((e) => e.type === 'done').data.status, 'done');
  const successfulChat = (await request('GET', `/api/chats/${success.id}`)).json;
  assert.equal(successfulChat.messages.length, 2, 'automatic retries keep one user message and one reply');
  console.log('Passed: 429 recovery and a single saved reply.');

  const exhausted = await turn('retry-exhaust');
  const exhaustedText = await exhausted.res.text();
  assert.equal(counts.get('retry-exhaust'), 4, 'initial request plus three retries');
  assert(!exhaustedText.includes(secret) && !exhaustedText.includes('429'), 'no raw provider errors in user stream');
  const failed = (await request('GET', `/api/chats/${exhausted.id}`)).json.messages;
  assert.equal(failed.length, 2);
  assert(failed[0].parts.some((p) => p.uploadId === uploadId));
  assert.equal(failed[1].errorCode, 'provider_busy', 'friendly error state survives reload');
  recovered = true;
  const retry = await fetch(`${base}/api/chats/${exhausted.id}/stream`, {
    method: 'POST', headers: { cookie: admin, 'x-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ regenerateMessageId: failed[1].id, modelId: models['retry-exhaust'] }),
  });
  assert(events(await retry.text()).some((e) => e.type === 'done' && e.data.status === 'done'));
  const retried = (await request('GET', `/api/chats/${exhausted.id}`)).json.messages;
  assert.equal(retried.filter((m) => m.role === 'user').length, 1, 'manual retry retains the original question/attachments');

  const abort = new AbortController();
  const cancelled = await turn('retry-cancel', abort.signal);
  const reader = cancelled.res.body.getReader(); let streamed = '';
  while (!streamed.includes('event: retry')) { const chunk = await reader.read(); streamed += new TextDecoder().decode(chunk.value); }
  abort.abort(); await reader.cancel().catch(() => {});
  await poll(async () => (await request('GET', `/api/chats/${cancelled.id}`)).json.messages.some((m) => m.status === 'stopped'));
  await sleep(2200);
  assert.equal(counts.get('retry-cancel'), 1, 'cancel prevents further upstream attempts');
  const partial = await turn('retry-partial');
  const partialEvents = events(await partial.res.text());
  assert(partialEvents.some((e) => e.type === 'delta' && e.data.text.includes('PRESERVED OUTPUT')));
  assert.equal(counts.get('retry-partial'), 1, 'partial output is never replayed');
  const tool = await turn('retry-tool');
  const toolEvents = events(await tool.res.text());
  assert.equal(toolEvents.filter((e) => e.type === 'tool_call').length, 1, '429 after a tool does not replay that tool');
  assert.equal(toolEvents.filter((e) => e.type === 'tool_result').length, 1);
  assert(toolEvents.some((e) => e.type === 'retry' && e.data?.delayMs > 0));
  assert.equal(toolEvents.find((e) => e.type === 'done').data.status, 'done');
  assert.equal(toolEvents.find((e) => e.type === 'tool_result').data.isError, false);
  console.log('Passed: exhausted budget, retained attachment, manual retry, cancellation and partial-stream protection.');

  const image = await request('POST', '/api/images/generate', { modelId: models['image-success'], prompt: 'retry image', n: 1 });
  const imageId = image.json.jobId;
  await poll(async () => (await request('GET', `/api/images/jobs/${imageId}`)).json.retry);
  const completed = await poll(async () => { const r = (await request('GET', `/api/images/jobs/${imageId}`)).json; return r.status !== 'running' && r; });
  assert.equal(completed.status, 'done'); assert.equal(completed.images.length, 1); assert.equal(counts.get('image-success'), 3);
  const cancelImage = await request('POST', '/api/images/generate', { modelId: models['image-cancel'], prompt: 'cancel image' });
  const cancelId = cancelImage.json.jobId;
  await poll(async () => (await request('GET', `/api/images/jobs/${cancelId}`)).json.retry);
  await request('POST', '/api/admin/users', { username: 'otheradmin', password: 'password-123', role: 'admin' });
  const other = await request('POST', '/api/auth/login', { username: 'otheradmin', password: 'password-123' });
  assert.equal((await request('POST', `/api/images/jobs/${cancelId}/cancel`, {}, other.cookie)).status, 404, 'cannot cancel another user job');
  assert.equal((await request('POST', `/api/images/jobs/${cancelId}/cancel`, {})).status, 200);
  await poll(async () => (await request('GET', `/api/images/jobs/${cancelId}`)).json.status === 'stopped');
  await sleep(2200); assert.equal(counts.get('image-cancel'), 1);
  assert(!appLogs.includes(secret), 'provider diagnostics are redacted');
  console.log('Passed: image retry progress/success/cancel, owner checks, Retry-After budget, nonretryable errors and redacted diagnostics.');
} finally {
  globalThis.fetch = realFetch;
  if (app && app.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => app.kill('SIGKILL'), 2000);
      app.once('exit', () => { clearTimeout(timer); resolve(); }); app.kill('SIGTERM');
    });
  }
  upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
