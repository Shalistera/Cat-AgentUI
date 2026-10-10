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
let auditDb;
let logs = '';

try {
  // ---------- budgets & planning (module level) ----------
  process.env.MAX_CONTEXT_TEXT_CHARS = '2000000';
  const { historyBudget, planHistory, summaryTargetChars, writeSummary } = await import(`${root}/server/dist/compaction.js`);
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

  // A small summarizer must receive every part of a large-model transcript,
  // while keeping each request inside its own context budget.
  const batches = [];
  const reported = [];
  let checked = 0;
  const stubAdapter = {
    async *streamChat(_cfg, req) {
      const prompt = req.messages[0].parts[0].text;
      assert(req.system.length + prompt.length <= 64_000, 'summary input exceeds the selected model budget');
      assert.equal(req.reasoning.level, 'off');
      const excerpt = prompt.split('[需要压缩的对话]\n')[1].split('\n\n请写一份新的完整摘要')[0];
      batches.push(excerpt);
      if (batches.length > 1) assert(prompt.includes(`摘要-${batches.length - 1}`), 'rolling summary carries earlier batches');
      yield { type: 'text', text: `摘要-${batches.length}` };
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      yield { type: 'stop', reason: 'stop' };
    },
  };
  const oldSummary = '旧事实'.repeat(20_000);
  const longText = `START-${'正文'.repeat(42_000)}-MIDDLE-${'内容'.repeat(35_000)}-END`;
  const unitDeps = { adapter: stubAdapter, cfg: {}, model: 'summary-small', signal: new AbortController().signal,
    beforeRequest: () => { checked++; }, onUsage: (u) => reported.push(u) };
  const folded = await writeSummary(unitDeps, oldSummary, [{ role: 'user', parts: [{ type: 'text', text: longText }] }], 24_000);
  assert(batches.length > 2);
  assert.equal(batches.join(''), `[较早的对话摘要]\n${oldSummary}\n\n【用户】\n${longText}`, 'no transcript prefix, middle or tail is dropped');
  assert.equal(folded, `摘要-${batches.length}`);
  assert.equal(reported.length, batches.length);
  assert.equal(checked, batches.length, 'recheck limits before each batch');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(writeSummary({ ...unitDeps, signal: aborted.signal }, null, [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }], 3_000));
  assert.equal(checked, batches.length, 'cancelled jobs do not start another request');
  const failedUsage = [];
  await assert.rejects(writeSummary({ ...unitDeps, onUsage: (u) => failedUsage.push(u), adapter: {
    async *streamChat() {
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } };
      yield { type: 'text', text: '不完整的摘要' };
      yield { type: 'usage', usage: { totalTokens: 7 } };
      yield { type: 'stop', reason: 'length' };
    },
  } }, null, [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }], 3_000), /未完整返回/);
  assert.equal(failedUsage[0].totalTokens, 22, 'provider-line attempts and failed requests are all accounted for');

  // ---------- end to end ----------
  const requests = [];
  let summarizerFails = false;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url.includes('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    const body = JSON.parse(raw);
    const system = body.messages.filter((m) => m.role === 'system').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const users = body.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''));
    const compacting = system.includes('负责压缩一段很长的对话');
    const titling = !compacting && body.messages.length <= 2 && /标题|title/i.test(system + users.join(''));
    requests.push({ compacting, titling, users, system, model: body.model, url: req.url });
    if (compacting && body.model === 'summary-small' && summarizerFails) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'forced summarizer failure' } }));
    }
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
  const defaults = (await api('GET', '/api/admin/settings')).data;
  assert.equal(defaults.compactionModelId, null);
  assert.equal(defaults.compactionFallbackToChat, false);
  const provider = (await api('POST', '/api/admin/providers', { name: 'stub', type: 'openai', apiKey: 'k', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })).data;
  await api('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'gpt-4o' }] });
  const modelId = (await api('GET', '/api/admin/providers')).data.find((p) => p.id === provider.id).models[0].id;
  const chat = (await api('POST', '/api/chats', { modelId })).data.chat.id;
  const turn = async (n, chatId = chat) => {
    const before = requests.length;
    const r = await fetch(`${base}/api/chats/${chatId}/stream`, { method: 'POST', headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ content: [{ type: 'text', text: `第${n}轮的问题:${'问'.repeat(1400)}` }] }) });
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

  // Dedicated model configuration, actual provider/model accounting, and
  // opt-in fallback. Each scenario reaches compaction through the real route.
  const summaryProvider = (await api('POST', '/api/admin/providers', { name: 'summarizer', type: 'openai', apiKey: 'summary-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/summary/v1` })).data;
  await api('POST', '/api/admin/models', { providerId: summaryProvider.id, models: [{ modelId: 'summary-small' }, { modelId: 'summary-image', imageGen: true }] });
  const summaryModels = (await api('GET', '/api/admin/providers')).data.find((p) => p.id === summaryProvider.id).models;
  const summaryId = summaryModels.find((m) => m.modelId === 'summary-small').id;
  const imageId = summaryModels.find((m) => m.modelId === 'summary-image').id;
  assert.equal((await api('PUT', '/api/admin/settings', { compactionModelId: 'missing', brand: 'must-not-save' })).status, 400);
  assert.equal((await api('GET', '/api/admin/settings')).data.brand, defaults.brand);
  assert.equal((await api('PUT', '/api/admin/settings', { compactionModelId: imageId })).status, 400);
  const configured = await api('PUT', '/api/admin/settings', { compactionModelId: summaryId, compactionFallbackToChat: false, followupEnabled: false });
  assert.equal(configured.status, 200);
  assert.equal((await api('GET', '/api/admin/settings')).data.compactionModelId, summaryId);
  const { default: Database } = await import('better-sqlite3');
  auditDb = new Database(path.join(data, 'server', 'cat-agentui.db'), { readonly: true });
  const compactNewChat = async () => {
    const id = (await api('POST', '/api/chats', { modelId })).data.chat.id;
    for (let n = 1; n <= 8; n++) {
      const result = await turn(n, id);
      if (result.events.includes('event: context_summary')) return { ...result, id };
    }
    assert.fail('compaction did not run');
  };
  const summaryOf = (id) => auditDb.prepare('SELECT model, summary FROM chat_summaries WHERE chat_id = ?').get(id);
  const usageOf = (id) => auditDb.prepare("SELECT provider_id, model, total_tokens FROM usage_log WHERE chat_id = ? AND kind = 'compaction'").all(id);
  const dedicated = await compactNewChat();
  assert(dedicated.events.includes('"state":"done"'));
  assert(dedicated.made.filter((q) => q.compacting).every((q) => q.model === 'summary-small' && q.url.startsWith('/summary/')));
  assert.equal(summaryOf(dedicated.id).model, 'summary-small');
  assert(usageOf(dedicated.id).length > 0 && usageOf(dedicated.id).every((u) => u.provider_id === summaryProvider.id && u.model === 'summary-small' && u.total_tokens === 15));
  assert.equal((await api('GET', `/api/chats/${dedicated.id}`)).data.chat.modelId, modelId, 'summarization does not switch the conversation model');

  summarizerFails = true;
  const noFallback = await compactNewChat();
  assert(noFallback.events.includes('"state":"failed"'));
  assert(noFallback.made.filter((q) => q.compacting).every((q) => q.model === 'summary-small'), 'no unapproved expensive fallback');
  assert.equal(summaryOf(noFallback.id), undefined, 'failed summaries are never saved');
  assert.equal((await api('PUT', '/api/admin/settings', { compactionFallbackToChat: true })).status, 200);
  const fallback = await compactNewChat();
  assert(fallback.events.includes('"state":"done"') && fallback.events.includes('正在改用当前对话模型'));
  assert.deepEqual(fallback.made.filter((q) => q.compacting).map((q) => q.model), ['summary-small', 'gpt-4o']);
  assert.equal(summaryOf(fallback.id).model, 'gpt-4o');
  assert(usageOf(fallback.id).some((u) => u.provider_id === summaryProvider.id));
  assert(usageOf(fallback.id).some((u) => u.provider_id === provider.id && u.total_tokens === 15));
  summarizerFails = false;

  await api('PUT', '/api/admin/settings', { compactionFallbackToChat: false });
  await api('PATCH', `/api/admin/models/${summaryId}`, { enabled: false });
  assert.equal((await api('PUT', '/api/admin/settings', { compactionModelId: summaryId })).status, 400);
  const disabled = await compactNewChat();
  assert(disabled.events.includes('"state":"failed"') && !disabled.made.some((q) => q.compacting));
  await api('PATCH', `/api/admin/models/${summaryId}`, { enabled: true, accessMode: 'restricted', allowedUserIds: [] });

  // A globally selected helper cannot bypass user grants or model allowances.
  const normalUser = (await api('POST', '/api/admin/users', { username: 'compactuser', password: 'compaction-test-password', role: 'user' })).data.user;
  const adminCookie = cookie;
  cookie = undefined;
  await api('POST', '/api/auth/login', { username: 'compactuser', password: 'compaction-test-password' });
  const userCookie = cookie;
  assert.equal((await api('PUT', '/api/admin/settings', { compactionModelId: null })).status, 403);
  const forbidden = await compactNewChat();
  assert(forbidden.events.includes('"state":"failed"') && !forbidden.made.some((q) => q.compacting));
  cookie = adminCookie;
  assert.equal((await api('PATCH', `/api/admin/models/${summaryId}`, { allowedUserIds: [normalUser.id], limitRequests: 1 })).status, 200);
  cookie = userCookie;
  const allowed = await compactNewChat();
  assert(allowed.events.includes('"state":"done"'));
  assert.equal(summaryOf(allowed.id).model, 'summary-small');
  const limited = await compactNewChat();
  assert(limited.events.includes('"state":"failed"') && !limited.made.some((q) => q.compacting));
  cookie = adminCookie;
  const cleared = await api('PUT', '/api/admin/settings', { compactionModelId: null });
  assert.equal(cleared.data.compactionModelId, null);
  const restored = await compactNewChat();
  assert.equal(summaryOf(restored.id).model, 'gpt-4o');
  console.log(`Compaction regression passed: fold at turn ${compactedAt}, summary reuse, dedicated model + accounting, opt-in fallback, grants + quotas, ${batches.length} bounded batches without lost source text, cancellation and incomplete-summary rejection.`);
} catch (err) {
  console.error(err);
  if (logs) console.error(`--- server log ---\n${logs.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await new Promise((r) => { app.once('exit', r); setTimeout(r, 2000).unref(); }); }
  auditDb?.close();
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
