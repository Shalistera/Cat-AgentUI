// 追加: messages sent into a reply while it is being generated. Drives the
// built server against local stubs that hold each round open until the test
// says so — an Anthropic-format one the server is told forwards the official
// API (INTERJECTION_ANTHROPIC_HOSTS), and an OpenAI-compatible one that must
// not get 追加 at all. Checks which models offer it, where every 追加 reaches
// the model: after a tool round (a text block after the tool results), after
// the model's last words (one more round in the same reply), several at once,
// taken back, refused once the reply is over — and that the next turn replays
// them at the same points. Never calls a real model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-interjection-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { interjectionPrompt, interjectionSupported, MAX_INTERJECTIONS } = await import(`${root}/server/dist/interjection.js`);

// Text blocks of an Anthropic message (OpenAI messages carry a string).
const userText = (m) => (typeof m.content === 'string' ? m.content : m.content?.map((c) => (c.type === 'text' ? c.text : '')).join(''));
const blockTypes = (m) => (typeof m.content === 'string' ? ['text'] : m.content.map((c) => c.type));

// ---- which providers offer 追加 ----
assert.equal(interjectionSupported('claude-code', []), true);
assert.equal(interjectionSupported('anthropic', [null]), true, 'no base URL: the official API');
assert.equal(interjectionSupported('anthropic', ['https://api.anthropic.com/v1']), true);
assert.equal(interjectionSupported('anthropic', ['https://relay.example.com']), false, 'a gateway is not assumed to forward it unchanged');
assert.equal(interjectionSupported('anthropic', ['https://relay.example.com'], ['relay.example.com']), true, 'unless the operator lists it');
assert.equal(interjectionSupported('anthropic', [null, 'https://relay.example.com']), false, 'every line has to take it');
for (const type of ['openai', 'gemini', 'novelai']) assert.equal(interjectionSupported(type, [null]), false, type);

// ---- upstream stubs: each main-chat round waits for the test to release it ----
const rounds = [];
const roundWaiters = [];
function nextRound() {
  return new Promise((resolve) => {
    const ready = rounds.find((r) => !r.claimed);
    if (ready) { ready.claimed = true; resolve(ready); } else roundWaiters.push(resolve);
  });
}
let toolSeq = 0;
function anthropicRound(res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
  let index = 0;
  return {
    kind: 'anthropic',
    messages: body.messages,
    text(t) {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
      send({ type: 'content_block_stop', index });
      index++;
    },
    call(name, args) {
      send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${++toolSeq}`, name, input: {} } });
      send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
      send({ type: 'content_block_stop', index });
      index++;
      this.finish('tool_use');
    },
    finish(reason = 'end_turn') {
      send({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } });
      send({ type: 'message_stop' });
      res.end();
    },
    /** The connection drops mid-reply: no stop reason, no message_stop. */
    cut() { res.end(); },
  };
}
function openaiRound(res, body) {
  const base = { id: 'cmpl', object: 'chat.completion.chunk', created: 0, model: body.model };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
  return {
    kind: 'openai',
    messages: body.messages.filter((m) => m.role !== 'system'),
    text(t) { send({ choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] }); },
    finish() {
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    },
  };
}
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const anthropic = req.url.includes('/v1/messages');
  if (!anthropic && !req.url.includes('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  const body = JSON.parse(raw);
  const round = anthropic ? anthropicRound(res, body) : openaiRound(res, body);
  // A continuation after a dropped round runs without tools, like a title.
  const continuing = userText(body.messages.at(-1) ?? {})?.includes('传输中断');
  if (!body.tools?.length && !continuing) { round.text('标题'); return round.finish(); } // title / suggestions
  rounds.push(round);
  const waiter = roundWaiters.shift();
  if (waiter) { round.claimed = true; waiter(round); }
});

// ---- server ----
let app;
let logs = '';
let cookie;
let base;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/** POST /stream and read its SSE events as they come. */
async function openStream(chatId, payload) {
  const res = await fetch(`${base}/api/chats/${chatId}/stream`, {
    method: 'POST', headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  const events = [];
  const waiters = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    let buf = '';
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const name = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!name || !data) continue;
        events.push({ name, data: JSON.parse(data) });
        for (const w of [...waiters]) if (w.test(events.at(-1))) { waiters.splice(waiters.indexOf(w), 1); w.resolve(events.at(-1)); }
      }
    }
  })();
  return {
    events, done,
    waitFor(name, pred = () => true) {
      const hit = events.find((e) => e.name === name && pred(e.data));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no '${name}' event\n${logs.slice(-1500)}`)), 10_000);
        waiters.push({ test: (e) => e.name === name && pred(e.data), resolve: (e) => { clearTimeout(timer); resolve(e); } });
      });
    },
  };
}

try {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env: {
    ...process.env, DATA_DIR: dataDir, SECRET_KEY: 'interjection-test-only', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false',
    INTERJECTION_ANTHROPIC_HOSTS: '127.0.0.1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => { logs += d; }); app.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 200; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break; await sleep(50); }

  await api('POST', '/api/auth/register', { username: 'admin', password: 'interjection-test-password' });
  await api('PUT', '/api/admin/settings', { followupEnabled: false });
  const stubPort = upstream.address().port;
  const addProvider = async (name, type, baseUrl, modelId) => {
    const p = (await api('POST', '/api/admin/providers', { name, type, apiKey: 'k', baseUrl })).data;
    await api('POST', '/api/admin/models', { providerId: p.id, models: [{ modelId, tools: true }] });
    return p;
  };
  const claude = await addProvider('claude', 'anthropic', `http://127.0.0.1:${stubPort}`, 'claude-opus-5-5');
  const relay = await addProvider('relay', 'anthropic', `http://localhost:${stubPort}`, 'claude-sonnet-5-5');
  const gpt = await addProvider('gpt', 'openai', `http://127.0.0.1:${stubPort}/v1`, 'gpt-4o-mini');
  const providers = (await api('GET', '/api/admin/providers')).data;
  const modelOf = (p) => providers.find((x) => x.id === p.id).models[0].id;
  const [modelId, relayModelId, gptModelId] = [modelOf(claude), modelOf(relay), modelOf(gpt)];

  // The model list tells the tab where a send during a reply goes.
  const offered = async () => Object.fromEntries((await api('GET', '/api/models')).data.map((m) => [m.id, m.interjection]));
  assert.deepEqual(await offered(), { [modelId]: true, [relayModelId]: false, [gptModelId]: false });
  // A backup line on an unlisted host takes it away: a reply may go there.
  const backup = (await api('POST', `/api/admin/providers/${claude.id}/endpoints`, { name: 'relay', baseUrl: 'https://relay.example.com', apiKey: 'k' })).data;
  assert.equal((await offered())[modelId], false);
  await api('DELETE', `/api/admin/provider-endpoints/${backup.id}`);
  assert.equal((await offered())[modelId], true);

  const chatId = (await api('POST', '/api/chats', { modelId })).data.chat.id;
  await api('PATCH', `/api/chats/${chatId}`, { title: 'interjection test' });
  const interject = (ids, text) => api('POST', `/api/chats/${chatId}/interject`, { ...ids, text });

  // ---- turn 1 ----
  const turn1 = randomUUID();
  const stream = await openStream(chatId, { requestId: turn1, content: [{ type: 'text', text: '查一下工作区' }] });
  const meta = (await stream.waitFor('meta')).data;
  const ids = { requestId: turn1 };

  // Round 1 is held open; a 追加 sent now waits for the tool round to finish.
  const r1 = await nextRound();
  assert.equal(r1.kind, 'anthropic');
  assert.equal(r1.messages.length, 1);
  let posted = await interject(ids, '顺便用表格列出来');
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  const first = posted.data.interjection;
  assert.equal(first.text, '顺便用表格列出来');
  const state = (await api('GET', `/api/chats/${chatId}/stream-state?requestId=${turn1}`)).data;
  assert.deepEqual(state.activeTurn.interjections, [first], 'a reconnecting tab sees what is still waiting');
  r1.call('workspace_list', {});

  // Round 2: the tool result, then the 追加 as a text block after it — the
  // user turn that carries the results.
  const r2 = await nextRound();
  const firstSse = (await stream.waitFor('interjection')).data;
  assert.deepEqual(firstSse, { type: 'interjection', id: first.id, text: first.text });
  assert.deepEqual(r2.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(blockTypes(r2.messages[2]), ['tool_result', 'text'], 'results first, then the 追加');
  assert.equal(userText(r2.messages[2]), interjectionPrompt('顺便用表格列出来'));
  assert(userText(r2.messages[2]).includes('不是另起一轮对话'));

  // The model writes its last words; a 追加 arriving meanwhile gets one more
  // round in the same reply.
  r2.text('工作区是空的。');
  await stream.waitFor('delta', (d) => d.text.includes('工作区是空的'));
  posted = await interject({ messageId: meta.messageId }, '再用英文说一遍');
  assert.equal(posted.status, 200, 'the message id identifies the turn as well');
  r2.finish();

  const r3 = await nextRound();
  assert.deepEqual(r3.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(userText(r3.messages[3]), '工作区是空的。');
  assert.equal(userText(r3.messages[4]), interjectionPrompt('再用英文说一遍'));

  // Taken back before the model read it: never delivered.
  r3.text('The workspace is empty.');
  const third = (await interject(ids, '算了不用了')).data.interjection;
  assert.deepEqual((await api('DELETE', `/api/chats/${chatId}/interject/${third.id}`)).data, { removed: true });
  assert.deepEqual((await api('DELETE', `/api/chats/${chatId}/interject/${third.id}`)).data, { removed: false });

  // At most MAX per reply, counting those already delivered.
  const batch = [];
  for (let i = 0; i < MAX_INTERJECTIONS - 2; i++) {
    const r = await interject(ids, `补充 ${i + 1}`);
    assert.equal(r.status, 200);
    batch.push(r.data.interjection);
  }
  const over = await interject(ids, '一条太多');
  assert.equal(over.status, 409);
  assert.equal(over.data.code, 'interjection_limit');
  r3.finish();

  // Several waiting at once arrive together, in order, as one user turn.
  const r4 = await nextRound();
  const tail = r4.messages.at(-1);
  assert.equal(tail.role, 'user');
  assert.deepEqual(tail.content.filter((c) => c.type === 'text').map((c) => c.text), batch.map((b) => interjectionPrompt(b.text)));
  assert.equal(userText(r4.messages.at(-2)), 'The workspace is empty.');
  r4.text('好的。');
  r4.finish();

  const done = (await stream.waitFor('done')).data;
  assert.equal(done.status, 'done');
  await stream.done;
  const late = await interject(ids, '来晚了');
  assert.equal(late.status, 409);
  assert.equal(late.data.code, 'turn_ended', 'a finished reply takes no more');

  const saved = (await api('GET', `/api/chats/${chatId}`)).data.messages.find((m) => m.id === meta.messageId);
  const kinds = saved.parts.map((p) => (p.type === 'interjection' ? `+${p.text}` : p.type === 'text' ? p.text : p.type));
  assert.deepEqual(kinds, [
    'tool_call', 'tool_result', '+顺便用表格列出来', '工作区是空的。', '+再用英文说一遍', 'The workspace is empty.',
    ...batch.map((b) => `+${b.text}`), '好的。',
  ]);
  assert.equal(saved.parts.find((p) => p.type === 'interjection').id, first.id);
  assert(!kinds.includes('+算了不用了'));

  // ---- turn 2: history replays every 追加 where it was read ----
  const stream2 = await openStream(chatId, { requestId: randomUUID(), content: [{ type: 'text', text: '谢谢' }] });
  const t2 = await nextRound();
  assert.deepEqual(t2.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(userText(t2.messages[2]), userText(r2.messages[2]), 'replayed byte for byte, so cached prefixes hold');
  assert.equal(userText(t2.messages.at(-1)), '谢谢');
  t2.text('不客气。');
  t2.finish();
  await stream2.done;

  const md = await fetch(`${base}/api/chats/${chatId}/export`, { headers: { cookie } }).then((r) => r.text());
  assert(md.includes('> **用户追加:** 顺便用表格列出来'), md.slice(0, 800));
  const found = (await api('GET', `/api/search?q=${encodeURIComponent('再用英文说一遍')}`)).data;
  assert(JSON.stringify(found).includes(chatId), 'search finds a chat by its 追加');

  // ---- a round cut off after a 追加 is resumed after it, never before ----
  const chat2 = (await api('POST', '/api/chats', { modelId })).data.chat.id;
  await api('PATCH', `/api/chats/${chat2}`, { title: 'continuation after interjection' });
  const turn3 = randomUUID();
  const stream3 = await openStream(chat2, { requestId: turn3, content: [{ type: 'text', text: '介绍一下猫' }] });
  await stream3.waitFor('meta');
  const c1 = await nextRound();
  c1.text('猫是小型哺乳动物。');
  await stream3.waitFor('delta', (d) => d.text.includes('猫是'));
  assert.equal((await api('POST', `/api/chats/${chat2}/interject`, { requestId: turn3, text: '再用英文总结' })).status, 200);
  c1.finish();
  const c2 = await nextRound();
  c2.text('In short, cats are');
  await stream3.waitFor('delta', (d) => d.text.includes('In short'));
  c2.cut();
  const c3 = await nextRound();
  assert(userText(c3.messages.at(-1)).includes('传输中断'), 'the dropped round is continued');
  assert.deepEqual(c3.messages.slice(-3).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(userText(c3.messages.at(-3)), interjectionPrompt('再用英文总结'));
  assert.equal(userText(c3.messages.at(-2)), 'In short, cats are', 'only the text after the 追加 is the part being continued');
  c3.text(' small mammals.');
  c3.finish();
  assert.equal((await stream3.waitFor('done')).data.status, 'done');
  await stream3.done;
  const reply3 = (await api('GET', `/api/chats/${chat2}`)).data.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(reply3.parts.filter((p) => p.type === 'text' || p.type === 'interjection').map((p) => `${p.type}:${p.text}`),
    ['text:猫是小型哺乳动物。', 'interjection:再用英文总结', 'text:In short, cats are small mammals.']);

  // ---- a model that does not take 追加: the tab queues instead ----
  const chat3 = (await api('POST', '/api/chats', { modelId: gptModelId })).data.chat.id;
  await api('PATCH', `/api/chats/${chat3}`, { title: 'no interjection' });
  const turn4 = randomUUID();
  const stream4 = await openStream(chat3, { requestId: turn4, content: [{ type: 'text', text: '你好' }] });
  await stream4.waitFor('meta');
  const g1 = await nextRound();
  assert.equal(g1.kind, 'openai');
  const refused = await api('POST', `/api/chats/${chat3}/interject`, { requestId: turn4, text: '顺便说一下' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'interjection_unsupported');
  g1.text('你好!');
  g1.finish();
  assert.equal((await stream4.waitFor('done')).data.status, 'done');
  await stream4.done;

  console.log('Interjection regression passed: offered on Claude Code and the Anthropic API only (gateways and backup lines included), delivery after a tool round and after the last words, stream-state, take-back, per-reply limit, batch order, refusal after the reply and on other vendors, replay in history, export and search, continuation after a 追加.');
} catch (err) {
  console.error(err);
  if (logs) console.error(`--- server log ---\n${logs.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await new Promise((r) => { app.once('exit', r); setTimeout(r, 2000).unref(); }); }
  upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
