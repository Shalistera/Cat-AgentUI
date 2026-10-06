// 上下文压缩: a branch that outgrows the model's history budget is folded
// into a summary instead of dropped, the summary is reused (stable prefix)
// until the verbatim part outgrows the budget again, and deleting a message
// clears it. Built server + a local OpenAI-compatible stub; MAX_CONTEXT_TEXT_CHARS
// is lowered so a handful of turns is enough. Never calls a real model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-compaction-'));
process.env.DATA_DIR = path.join(data, 'module');
process.env.SECRET_KEY = 'compaction-test-only';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let logs = '';

try {
  // ---------- budgets & planning (module level) ----------
  process.env.MAX_CONTEXT_TEXT_CHARS = '2000000';
  const { historyBudget, planHistory, summaryTargetChars } = await import(`${root}/server/dist/compaction.js`);
  assert.equal(historyBudget('claude-opus-5-5').textChars, 500_000);
  assert.equal(historyBudget('gpt-5').textChars, 200_000);
  assert.equal(historyBudget('claude-haiku-4-5').textChars, 100_000);
  assert.equal(historyBudget('gpt-4o').textChars, 64_000);
  const b = { textChars: 10_000, messages: 400 };
  const turns = (n, cost) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', cost }));
  assert.deepEqual(planHistory(turns(9, 900), null, b), { start: 0, summary: null, compact: null }, 'fits: nothing to do');
  const over = planHistory(turns(15, 900), null, b);
  assert(over.compact && over.compact.from === 0 && over.start === over.compact.to + 1);
  assert.equal(turns(15, 900)[over.start].role, 'user', 'verbatim part starts on a user message');
  assert(15 - over.start <= Math.floor((b.textChars * 0.55 - summaryTargetChars(b)) / 900) + 1);
  const sum = { row: { summary: 'x'.repeat(500), covered: 6 }, index: 5 };
  assert.deepEqual(planHistory(turns(11, 900), sum, b), { start: 6, summary: sum.row, compact: null }, 'summary + rest fits');
  assert.equal(planHistory(turns(19, 900), sum, b).compact.from, 6, 'next fold starts after the summary');
  assert.equal(planHistory(turns(1, 50_000), null, b).compact, null, 'one huge message: nothing older to fold');

  // ---------- end to end ----------
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url.includes('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    const body = JSON.parse(raw);
    const system = body.messages.filter((m) => m.role === 'system').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const users = body.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''));
    const compacting = system.includes('负责压缩一段很长的对话');
    const titling = !compacting && body.messages.length <= 2 && /标题|title/i.test(system + users.join(''));
    requests.push({ compacting, titling, users, system });
    const base = { id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (text) => {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (compacting) return say(`摘要:用户先后问了第1到第${(users[0].match(/第(\d+)轮/g) ?? []).length}轮的问题。`);
    // The question is the last thing in the last user message (a summary may lead it).
    const n = [...(users.at(-1) ?? '').matchAll(/第(\d+)轮的问题/g)].at(-1)?.[1] ?? '?';
    say(`第${n}轮的回答:${'答'.repeat(1500)}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  // A 12K-character budget: about four turns of ~3,000 characters before folding.
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env: { ...process.env, DATA_DIR: path.join(data, 'server'), MAX_CONTEXT_TEXT_CHARS: '12000', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => { logs += d; }); app.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 200; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break; await sleep(50); }
  let cookie;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
  await api('POST', '/api/auth/register', { username: 'compactadmin', password: 'compaction-test-password' });
  const provider = (await api('POST', '/api/admin/providers', { name: 'stub', type: 'openai', apiKey: 'k', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })).data;
  await api('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'gpt-4o' }] });
  const modelId = (await api('GET', '/api/admin/providers')).data.find((p) => p.id === provider.id).models[0].id;
  const chat = (await api('POST', '/api/chats', { modelId })).data.chat.id;
  const turn = async (n) => {
    const before = requests.length;
    const r = await fetch(`${base}/api/chats/${chat}/stream`, { method: 'POST', headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ content: [{ type: 'text', text: `第${n}轮的问题:${'问'.repeat(1400)}` }] }) });
    const events = await r.text();
    assert(events.includes(`第${n}轮的回答`), events.slice(-500));
    await sleep(150); // title / follow-up requests settle
    return { events, made: requests.slice(before).filter((q) => !q.titling) };
  };

  let compactedAt = 0;
  for (let n = 1; n <= 8 && !compactedAt; n++) {
    const { events, made } = await turn(n);
    const main = made.find((q) => !q.compacting && q.users.at(-1).includes(`第${n}轮的问题`));
    assert(main, `turn ${n} reached the model`);
    if (made.some((q) => q.compacting)) {
      compactedAt = n;
      assert(events.includes('event: context_summary') && events.includes('"state":"done"'), 'live marker');
      assert(main.users[0].startsWith('[早前对话摘要]'), 'the summary leads the replayed history');
      assert(!main.users.some((u) => u.includes('第1轮的问题')), 'folded turns are not replayed verbatim');
      assert(main.users.at(-1).includes(`第${n}轮的问题`));
    } else {
      assert(main.users[0].includes('第1轮的问题'), `turn ${n}: everything still replayed`);
    }
  }
  assert(compactedAt >= 3, `compaction happened at turn ${compactedAt}`);

  // Stable prefix: the next turn reuses the stored summary instead of writing another.
  const next = await turn(compactedAt + 1);
  assert(!next.made.some((q) => q.compacting), 'no second summary right away');
  const nextMain = next.made.find((q) => !q.compacting);
  assert(nextMain.users[0].startsWith('[早前对话摘要]'));
  // The reply that compacted carries the marker (with the summary text) after a reload.
  const saved = (await api('GET', `/api/chats/${chat}`)).data;
  const marker = saved.messages.flatMap((m) => m.parts).find((p) => p.type === 'context_summary');
  assert(marker && marker.state === 'done' && marker.text.startsWith('摘要') && marker.covered >= 2, JSON.stringify(marker));
  // Markdown export mentions it.
  const md = await (await fetch(`${base}/api/chats/${chat}/export?format=md`, { headers: { cookie } })).text();
  assert(md.includes('较早的对话已压缩成摘要'), md.slice(0, 300));

  // Deleting a message clears summaries: the next long turn writes a fresh one.
  const firstUser = saved.messages.find((m) => m.role === 'user');
  assert.equal((await api('DELETE', `/api/chats/${chat}/messages/${firstUser.id}`)).status, 200);
  const after = await turn(compactedAt + 2);
  assert(after.made.some((q) => q.compacting), 'summary rebuilt after a deletion');
  assert(!after.made.find((q) => !q.compacting).users.join('').includes('第1轮的问题'));
  console.log(`Compaction regression passed: model-sized budgets, planning, fold at turn ${compactedAt}, summary reuse, marker + export, invalidation on delete.`);
} catch (err) {
  console.error(err);
  if (logs) console.error(`--- server log ---\n${logs.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await new Promise((r) => { app.once('exit', r); setTimeout(r, 2000).unref(); }); }
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
