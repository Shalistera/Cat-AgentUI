import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recoverChatStream, mergeStreamSnapshot } from '../web/src/streamRecovery.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-chat-recovery-'));
const realFetch = globalThis.fetch;
let app, base, cookie, logs = '', calls = 0;
const pending = [];
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume */ }
  calls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Beginning of original reply. ' }] } }] })}\n\n`);
  pending.push(res);
});
const finish = (res) => res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Final recovered answer.' }] }, finishReason: 'STOP' }] })}\n\n`);
async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; }
async function poll(fn) {
  for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await sleep(40); }
  throw new Error('poll timed out\n' + logs.slice(-2500));
}
async function request(method, url, body, auth = cookie) {
  const res = await realFetch(base + url, { method, headers: {
    'x-csrf': '1', ...(auth ? { cookie: auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function browserChecks() {
  const reply = { id: 'reply', parentId: 'question', role: 'assistant', parts: [], status: 'streaming' };
  const snapshots = [];
  let gets = 0;
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.method, undefined, 'recovery never repeats POST');
    assert(url.includes('requestId=original'));
    gets++;
    if (gets === 2) throw new TypeError('temporary connection loss');
    return Response.json({ active: gets < 4, activeTurn: null, userMessage: null,
      message: { ...reply, status: gets < 4 ? 'streaming' : 'done', parts: gets < 4 ? [] : [{ type: 'text', text: 'saved answer' }] } });
  };
  const state = await recoverChatStream('chat', { requestId: 'original' }, (s) => snapshots.push(s), new AbortController().signal, 1);
  assert.equal(gets, 4);
  assert(snapshots.slice(0, -1).every((s) => s.active && s.message.status === 'streaming'));
  assert.equal(state.message.status, 'done');
  const original = [{ ...reply, id: 'sibling', status: 'done' }, { ...reply, id: 'tmp-a' }];
  const once = mergeStreamSnapshot(original, state, true);
  const twice = mergeStreamSnapshot(once, state, true);
  assert.equal(twice.length, 2, 'repeated snapshots preserve siblings without duplicate output');
  assert.equal(twice[1].parts[0].text, 'saved answer');
  assert.equal(twice[1].recovering, false);
  globalThis.fetch = async () => Response.json({ active: true, activeTurn: null, message: reply });
  const stop = new AbortController();
  await assert.rejects(recoverChatStream('chat', {}, () => stop.abort(), stop.signal, 1), { name: 'AbortError' });
  globalThis.fetch = realFetch;
  console.log('Passed: browser recovery waits through empty streaming snapshots/network errors, never replays, and merges idempotently.');
}

try {
  await browserChecks();
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(); const port = await listen(probe); await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env: {
    ...process.env, DATA_DIR: dataDir, SECRET_KEY: 'chat-recovery-test-only', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => { logs += d; }); app.stderr.on('data', (d) => { logs += d; });
  await poll(() => realFetch(base + '/api/health').then((r) => r.ok).catch(() => false));
  cookie = (await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' })).cookie;
  await request('PUT', '/api/admin/settings', { followupEnabled: false });
  const provider = (await request('POST', '/api/admin/providers', { name: 'recovery mock', type: 'gemini', baseUrl: `http://127.0.0.1:${upstreamPort}` })).data;
  await request('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'recovery', displayName: 'recovery' }] });
  const modelId = (await request('GET', '/api/admin/providers')).data[0].models[0].id;
  const chatId = (await request('POST', '/api/chats', { modelId })).data.chat.id;
  await request('PATCH', `/api/chats/${chatId}`, { title: 'Recovery test' });
  async function start() {
    const requestId = randomUUID();
    const abort = new AbortController();
    const res = await realFetch(`${base}/api/chats/${chatId}/stream`, { method: 'POST', headers: {
      cookie, 'x-csrf': '1', 'content-type': 'application/json',
    }, body: JSON.stringify({ requestId, content: [{ type: 'text', text: 'one original question' }] }), signal: abort.signal });
    assert.equal(res.status, 200);
    const live = await poll(async () => {
      const state = (await request('GET', `/api/chats/${chatId}/stream-state?requestId=${requestId}`)).data;
      return state.active && state.message?.parts.some((p) => p.type === 'text') && state;
    });
    return { requestId, abort, res, live };
  }
  const first = await start();
  first.abort.abort();
  await sleep(80);
  const disconnected = (await request('GET', `/api/chats/${chatId}/stream-state?requestId=${first.requestId}`)).data;
  assert(disconnected.active && disconnected.message.status === 'streaming', 'browser transport loss must not finish or cancel generation');
  const reload = (await request('GET', `/api/chats/${chatId}`)).data;
  assert.equal(reload.activeTurn.requestId, first.requestId, 'reload discovers the original active request');
  assert(reload.messages.at(-1).parts.some((p) => p.type === 'text'), 'reload includes live partial output');
  assert.equal((await request('POST', `/api/chats/${chatId}/stream`, { requestId: first.requestId, content: [{ type: 'text', text: 'duplicate' }] })).status, 409);
  assert.equal(calls, 1, 'recovery and duplicate submission do not regenerate');

  // Exercise the browser's real polling code against the real server.
  globalThis.fetch = (url, opts) => realFetch(base + url, { ...opts, headers: { cookie } });
  const recovering = recoverChatStream(chatId, { requestId: first.requestId }, () => {}, new AbortController().signal, 20);
  finish(pending[0]);
  const completed = await recovering;
  globalThis.fetch = realFetch;
  assert.equal(completed.message.status, 'done');
  assert.equal(completed.message.finishReason, 'stop');
  assert(completed.message.parts.some((p) => p.type === 'text' && p.text.includes('Final recovered answer')));
  assert.equal(calls, 1);

  const second = await start();
  assert.equal(calls, 2, 'the next turn is accepted after real completion');
  assert.equal((await request('POST', `/api/chats/${chatId}/stop`, { requestId: first.requestId })).data.stopped, false, 'a stale stop cannot cancel a newer turn');
  assert.equal((await request('POST', '/api/admin/users', { username: 'other', password: 'password-456', role: 'user' })).status, 200);
  const other = (await request('POST', '/api/auth/login', { username: 'other', password: 'password-456' }, '')).cookie;
  assert(other, 'owner-isolation checks must use a distinct authenticated account');
  assert.equal((await request('GET', `/api/chats/${chatId}/stream-state`, undefined, other)).status, 404);
  assert.equal((await request('POST', `/api/chats/${chatId}/stop`, { requestId: second.requestId }, other)).status, 404);
  assert.equal((await request('POST', `/api/chats/${chatId}/stop`, { requestId: second.requestId })).data.stopped, true);
  await second.res.text();
  const stopped = await poll(async () => {
    const state = (await request('GET', `/api/chats/${chatId}/stream-state?requestId=${second.requestId}`)).data;
    return !state.active && state.message?.status === 'stopped' && state;
  });
  assert(stopped.message.parts.length);
  const third = await start();
  third.abort.abort(); // do not read meta/done; recover solely by request id
  finish(pending[2]);
  await poll(async () => (await request('GET', `/api/chats/${chatId}/stream-state?requestId=${third.requestId}`)).data.message?.status === 'done');
  assert.equal(calls, 3);
  console.log('Passed: disconnect/reload recovery, live snapshots, request receipts, explicit stop, owner isolation and no duplicate generations.');
} finally {
  globalThis.fetch = realFetch;
  if (app && app.exitCode === null) {
    await new Promise((r) => { app.once('exit', r); app.kill(); setTimeout(() => app.kill('SIGKILL'), 2000).unref(); });
  }
  upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
