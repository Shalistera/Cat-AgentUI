// Backup-line failover semantics: priority order, no round-robin, breaker
// opens after N consecutive pre-output failures, single probe after cooldown,
// request-shaped errors and mid-stream failures never switch lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFailover, resetLineHealth, lineStatus, rewriteModel } from '../server/dist/providers/failover.js';
import { ProviderHttpError } from '../server/dist/providers/sse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const netErr = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
const httpErr = (status) => new ProviderHttpError(`HTTP ${status}`, status);

function line(id, name, extra = {}) {
  return {
    id: 'prov', type: 'openai', baseUrl: `http://${id}`, apiKey: 'k', useResponses: false, useVertex: false,
    vertexProject: null, vertexLocation: null, vertexSaJson: null, extraHeaders: {},
    endpointId: id === 'primary' ? undefined : id, endpointName: name, ...extra,
  };
}
function cfg(opts = {}) {
  const primary = line('primary', '主线路');
  primary.fallbacks = [line('b1', 'LiteLLM', { stripModelPrefix: 'openai/', addModelPrefix: '' }), line('b2', '第三')];
  primary.failoverThreshold = opts.threshold ?? 2;
  primary.failoverCooldownMs = opts.cooldownMs ?? 300;
  return primary;
}

/** A fake vendor adapter whose behaviour per line is scripted. */
function fake(script) {
  const calls = [];
  return {
    calls,
    adapter: withFailover({
      async *streamChat(c, req) {
        const key = c.endpointId ?? 'primary';
        calls.push({ key, model: req.model });
        const step = script[key]?.shift() ?? 'ok';
        if (step === 'ok') { await sleep(20); yield { type: 'text', text: `${key}-hi` }; yield { type: 'stop', reason: 'stop' }; return; }
        if (step === 'mid') { yield { type: 'text', text: 'partial' }; throw httpErr(500); }
        if (step === 'empty') return;
        throw step;
      },
      async listModels() { return []; },
      async generateImages(c, req) {
        const key = c.endpointId ?? 'primary';
        calls.push({ key, model: req.model });
        const step = script[key]?.shift() ?? 'ok';
        if (step === 'ok') return { images: [{ mime: 'image/png', dataBase64: key }] };
        throw step;
      },
    }),
  };
}

async function collect(gen) { const out = []; for await (const ev of gen) out.push(ev); return out; }
const req = (extra = {}) => ({ model: 'openai/gpt-4o', messages: [], signal: new AbortController().signal, ...extra });

// 1. pre-output failure on the primary → the next line answers, model rewritten, notice sent
{
  resetLineHealth();
  const { adapter, calls } = fake({ primary: [httpErr(502)] });
  const notices = [];
  const out = await collect(adapter.streamChat(cfg(), req({ onFailover: (i) => notices.push(i) })));
  assert.deepEqual(calls, [{ key: 'primary', model: 'openai/gpt-4o' }, { key: 'b1', model: 'gpt-4o' }]);
  assert.equal(out[0].text, 'b1-hi');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].from, '主线路'); assert.equal(notices[0].to, 'LiteLLM'); assert.match(notices[0].reason, /502/);
  assert.equal(lineStatus('prov:primary').failures, 1);
  assert.equal(lineStatus('b1').served, 1);
}

// 2. request-shaped errors (400) never switch lines and do not count
{
  resetLineHealth();
  const { adapter, calls } = fake({ primary: [httpErr(400)] });
  await assert.rejects(collect(adapter.streamChat(cfg(), req())), { status: 400 });
  assert.equal(calls.length, 1);
  assert.equal(lineStatus('prov:primary').failures, 0);
}

// 3. a failure after output started belongs to the request, not the line
{
  resetLineHealth();
  const { adapter, calls } = fake({ primary: ['mid'] });
  await assert.rejects(collect(adapter.streamChat(cfg(), req())), { status: 500 });
  assert.equal(calls.length, 1, 'no replay of a partially streamed answer');
  assert.equal(lineStatus('prov:primary').failures, 0);
}

// 4. breaker: threshold failures open the primary, later requests skip it,
//    a single probe after the cooldown closes it again on success
{
  resetLineHealth();
  const { adapter, calls } = fake({ primary: [netErr(), netErr(), 'ok'] });
  await collect(adapter.streamChat(cfg(), req()));
  await collect(adapter.streamChat(cfg(), req()));
  assert.equal(lineStatus('prov:primary').state, 'open');
  calls.length = 0;
  await collect(adapter.streamChat(cfg(), req()));
  assert.deepEqual(calls.map((c) => c.key), ['b1'], 'an open breaker is skipped without a request');
  assert.equal(lineStatus('b1').tookOver, 3);
  await sleep(350);
  calls.length = 0;
  // Two concurrent requests after cooldown: only one probes, the other goes to the backup.
  const probe = collect(adapter.streamChat(cfg(), req()));
  await sleep(5);
  assert.equal(lineStatus('prov:primary').state, 'probing');
  const other = collect(adapter.streamChat(cfg(), req()));
  await Promise.all([probe, other]);
  assert.deepEqual(calls.map((c) => c.key).sort(), ['b1', 'primary']);
  assert.equal(lineStatus('prov:primary').state, 'ok');
  assert.equal(lineStatus('prov:primary').failures, 0);
  calls.length = 0;
  await collect(adapter.streamChat(cfg(), req()));
  assert.deepEqual(calls.map((c) => c.key), ['primary'], 'recovered primary gets traffic again');
}

// 5. a failed probe reopens for a full cooldown
{
  resetLineHealth();
  const { adapter } = fake({ primary: [netErr(), netErr(), netErr()] });
  await collect(adapter.streamChat(cfg(), req()));
  await collect(adapter.streamChat(cfg(), req()));
  await sleep(350);
  await collect(adapter.streamChat(cfg(), req()));
  assert.equal(lineStatus('prov:primary').state, 'open');
}

// 6. every line failing surfaces the last error; all breakers open still attempts
{
  resetLineHealth();
  const { adapter, calls } = fake({ primary: [httpErr(503)], b1: [httpErr(401)], b2: [netErr()] });
  await assert.rejects(collect(adapter.streamChat(cfg(), req())), (e) => e instanceof TypeError);
  assert.deepEqual(calls.map((c) => c.key), ['primary', 'b1', 'b2']);
  resetLineHealth();
  const all = fake({ primary: [httpErr(500), httpErr(500), 'ok'], b1: [httpErr(500), httpErr(500)], b2: [httpErr(500), httpErr(500)] });
  await assert.rejects(collect(all.adapter.streamChat(cfg(), req())));
  await assert.rejects(collect(all.adapter.streamChat(cfg(), req())));
  for (const k of ['prov:primary', 'b1', 'b2']) assert.equal(lineStatus(k).state, 'open');
  all.calls.length = 0;
  await collect(all.adapter.streamChat(cfg(), req()));
  assert.deepEqual(all.calls.map((c) => c.key), ['primary'], 'with everything open, try in order rather than fail flat');
}

// 7. a cancelled request never switches lines
{
  resetLineHealth();
  const ac = new AbortController();
  const { adapter, calls } = fake({ primary: [Object.assign(new Error('aborted'), { name: 'AbortError' })] });
  ac.abort();
  await assert.rejects(collect(adapter.streamChat(cfg(), req({ signal: ac.signal }))));
  assert.equal(calls.length, 1);
  assert.equal(lineStatus('prov:primary').failures, 0);
}

// 8. image generation fails over the same way; an empty-but-OK stream counts as healthy
{
  resetLineHealth();
  const { adapter, calls } = fake({ primary: [httpErr(529)] });
  const r = await adapter.generateImages(cfg(), req({ prompt: 'x' }));
  assert.equal(r.images[0].dataBase64, 'b1');
  assert.deepEqual(calls.map((c) => c.key), ['primary', 'b1']);
  resetLineHealth();
  const e = fake({ primary: ['empty'] });
  assert.deepEqual(await collect(e.adapter.streamChat(cfg(), req())), []);
  assert.equal(lineStatus('prov:primary').served, 1);
}

// 9. no backups configured: errors pass through untouched, nothing is counted
{
  resetLineHealth();
  const { adapter } = fake({ primary: [httpErr(500)] });
  await assert.rejects(collect(adapter.streamChat(line('primary', '主线路'), req())), { status: 500 });
  assert.equal(lineStatus('prov:primary').failures, 0);
}

assert.equal(rewriteModel({ stripModelPrefix: 'openai/', addModelPrefix: 'azure/' }, 'openai/gpt-4o'), 'azure/gpt-4o');
assert.equal(rewriteModel({ stripModelPrefix: 'openai/' }, 'gpt-4o'), 'gpt-4o');

console.log('Passed: failover unit semantics.');

// ---- end to end: the real app, two mock OpenAI-compatible gateways ----
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-failover-'));
const backupSecret = 'sk-backup-line-private-key-9f8e7d';
const seen = { primary: [], backup: [] };
let primaryMode = 'down'; // 'down' → 500, 'up' → answers

function gateway(name) {
  return http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url.endsWith('/models')) {
      if (name === 'backup' && req.headers.authorization !== `Bearer ${backupSecret}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'openai/gpt-x' }] }));
      return;
    }
    const model = JSON.parse(body).model;
    seen[name].push(model);
    if (name === 'primary' && primaryMode === 'down') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `answer from ${name}` } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
let base; let admin; let app; let appLogs = '';
async function request(method, url, body) {
  const res = await fetch(base + url, {
    method, headers: { 'x-csrf': '1', ...(admin ? { cookie: admin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function poll(fn) {
  for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error('poll timed out');
}
const events = (text) => [...text.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));

const primaryServer = gateway('primary'); const backupServer = gateway('backup');
try {
  const primaryPort = await listen(primaryServer); const backupPort = await listen(backupServer);
  const probe = http.createServer(); const port = await listen(probe); await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, SECRET_KEY: 'failover-test-database-secret', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (s) => { appLogs += s; }); app.stderr.on('data', (s) => { appLogs += s; });
  await poll(async () => {
    if (app.exitCode !== null) throw new Error(appLogs);
    return fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
  });
  const reg = await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' });
  assert.equal(reg.status, 200); admin = reg.cookie;
  await request('PUT', '/api/admin/settings', { followupEnabled: false });

  const provider = (await request('POST', '/api/admin/providers', { name: 'openai', type: 'openai', apiKey: 'sk-primary', baseUrl: `http://127.0.0.1:${primaryPort}/v1` })).json;
  await request('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'openai/gpt-x', tools: false }] });
  await request('PATCH', `/api/admin/providers/${provider.id}`, { failoverThreshold: 2, failoverCooldownSeconds: 5 });

  // Backup line with a wrong key first: the per-line test must report it, and the key must never leak.
  const ep = (await request('POST', `/api/admin/providers/${provider.id}/endpoints`, {
    name: 'LiteLLM', baseUrl: `http://127.0.0.1:${backupPort}/v1`, apiKey: 'sk-wrong-key-1234567', stripModelPrefix: 'openai/',
  })).json;
  assert.equal(ep.hasKey, true); assert.equal(ep.priority, 0);
  const badTest = (await request('POST', `/api/admin/provider-endpoints/${ep.id}/test`)).json;
  assert.equal(badTest.ok, false); assert(!badTest.error.includes('sk-wrong-key-1234567'), 'line key redacted from test errors');
  await request('PATCH', `/api/admin/provider-endpoints/${ep.id}`, { apiKey: backupSecret });
  const goodTest = (await request('POST', `/api/admin/provider-endpoints/${ep.id}/test`)).json;
  assert.equal(goodTest.ok, true);
  const second = (await request('POST', `/api/admin/providers/${provider.id}/endpoints`, { name: '第三', baseUrl: `http://127.0.0.1:${backupPort}/v1`, apiKey: backupSecret, enabled: false })).json;
  assert.equal(second.priority, 1);
  await request('PUT', `/api/admin/providers/${provider.id}/endpoints/order`, { ids: [second.id, ep.id] });
  let listed = (await request('GET', '/api/admin/providers')).json.find((p) => p.id === provider.id);
  assert.deepEqual(listed.endpoints.map((e) => e.name), ['第三', 'LiteLLM'], 'priority order persisted');
  assert.equal(listed.failoverThreshold, 2);
  assert.equal(listed.health.state, 'ok');

  const modelDbId = listed.models[0].id;
  async function turn() {
    const chat = (await request('POST', '/api/chats', { modelId: modelDbId })).json.chat;
    await request('PATCH', `/api/chats/${chat.id}`, { title: 'Failover regression' }); // no auto-title request
    const res = await fetch(`${base}/api/chats/${chat.id}/stream`, {
      method: 'POST', headers: { cookie: admin, 'x-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: modelDbId, content: [{ type: 'text', text: 'hello' }] }),
    });
    assert.equal(res.status, 200);
    return events(await res.text());
  }
  // Primary down: the same request is answered by the backup, with the prefix stripped, and the user is told.
  let evs = await turn();
  assert.equal(evs.find((e) => e.type === 'done').data.status, 'done');
  assert(evs.some((e) => e.type === 'delta' && e.data.text.includes('answer from backup')));
  const notice = evs.find((e) => e.type === 'notice' && /切换到/.test(e.data.message));
  assert(notice, 'user sees a failover notice'); assert(!notice.data.message.includes('exploded'), 'notice carries the status, not the raw body');
  assert.deepEqual(seen.primary, ['openai/gpt-x']); assert.deepEqual(seen.backup, ['gpt-x']);
  assert(!(await request('GET', '/api/admin/providers')).json.some((p) => JSON.stringify(p).includes(backupSecret)), 'no secret in admin listing');

  evs = await turn();
  listed = (await request('GET', '/api/admin/providers')).json.find((p) => p.id === provider.id);
  assert.equal(listed.health.state, 'open', 'two consecutive failures open the primary breaker');
  assert.equal(listed.health.failures, 2); assert.match(listed.health.lastError, /500/);
  assert.equal(listed.endpoints.find((e) => e.id === ep.id).health.tookOver, 2);
  evs = await turn();
  assert.equal(seen.primary.length, 2, 'open breaker: primary not even asked');
  assert(!evs.some((e) => e.type === 'notice' && /切换到/.test(e.data.message)), 'no notice when the switch happened earlier');
  assert(evs.some((e) => e.type === 'delta' && e.data.text.includes('answer from backup')));

  // Operator fixed the primary and resets by hand: traffic returns to it at once.
  primaryMode = 'up';
  await request('POST', `/api/admin/providers/${provider.id}/health/reset`);
  evs = await turn();
  assert(evs.some((e) => e.type === 'delta' && e.data.text.includes('answer from primary')));
  assert.equal(seen.primary.length, 3);
  listed = (await request('GET', '/api/admin/providers')).json.find((p) => p.id === provider.id);
  assert.equal(listed.health.state, 'ok'); assert.equal(listed.health.served, 1);

  // Deleting the line leaves the provider working on its own.
  await request('DELETE', `/api/admin/provider-endpoints/${ep.id}`);
  await request('DELETE', `/api/admin/provider-endpoints/${second.id}`);
  primaryMode = 'down';
  evs = await turn();
  assert.equal(evs.find((e) => e.type === 'done').data.status, 'error');
  assert(!appLogs.includes(backupSecret) && !appLogs.includes('sk-wrong-key'), 'no line secrets in server logs');
  console.log('Passed: admin API, per-line test with redaction, in-request failover with notice and model rewrite, breaker open/reset, deletion.');
  console.log('provider-failover regression: OK');
} finally {
  app?.kill();
  primaryServer.close(); backupServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
