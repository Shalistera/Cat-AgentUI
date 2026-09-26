// Temporary SQLite + real Fastify routes, with an in-process model stub.
// No credentials, network, real users or generated HTML are involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { lineDomain, linePath, nearestXIndex, validLineComparison } from '../web/src/chartGeometry.ts';
import { comparisonScale } from '../web/src/components/ComparisonChart.tsx';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-comparison-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'comparison-regression-secret';
const { db, rawDb, schema, runMigrations, setSetting } = await import('../server/dist/db/index.js');
const { callCompareData, parseComparison, COMPARE_DATA_DEF } = await import('../server/dist/data-comparison.js');
const { saveAgentSettings } = await import('../server/dist/agent-settings.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { authRoutes } = await import('../server/dist/routes/auth.js');
const { agentRoutes } = await import('../server/dist/routes/agent.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { getAdapter } = await import('../server/dist/providers/index.js');
const app = Fastify();
app.setErrorHandler((err, _req, reply) => reply.code(err.message === 'forbidden' ? 403 : err.message === 'unauthorized' ? 401 : 500).send({ error: err.message }));
const adapter = getAdapter('gemini');
const originalStream = adapter.streamChat;
let plans = [];
let offered = [];
let beforeTool;
let latestPrompt;
const sample = { title: '方案净收益对比', unit: '万元', source: '用户提供的同年度数据', items: [
  { label: '甲', value: -20 }, { label: '乙', value: 0 }, { label: '丙', value: 80 },
] };
const lineSample = { title: '多方案输出曲线', unit: '相对值', source: '测试用演示数据', chart: 'line', xLabel: '时间',
  x: [6, 8, 8.5, 12, 24], xLabels: ['6:00', '8:00', '8:30', '12:00', '24:00'],
  series: [{ label: '方案 A', values: [0, 0.5, 1, 2, 0.5] }, { label: '方案 B', values: [0, 0.6, null, 1.8, 0.4] }],
};
const asArgs = (value = sample) => JSON.stringify(value);
const context = { userId: 'alice', chatId: 'owned', attempt: 1 };
const userSettings = (settings) => db.update(schema.users).set({ settings: JSON.stringify(settings) }).where(eq(schema.users.id, 'alice')).run();
const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
async function turn(calls = [sample], modelId = 'model') {
  plans = calls; offered = [];
  const created = await request('POST', '/api/chats', { modelId });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().chat.id;
  await request('PATCH', `/api/chats/${id}`, { title: '图表测试' });
  const res = await request('POST', `/api/chats/${id}/stream`, { modelId, content: [{ type: 'text', text: '比较甲、乙、丙的净收益' }] });
  assert.equal(res.statusCode, 200, res.body);
  const events = [...res.body.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  return { id, events, charts: events.filter((e) => e.type === 'data_comparison'), results: events.filter((e) => e.type === 'tool_result').map((e) => e.data) };
}

try {
  // Upgrade cleanup is surgical and idempotent, even with malformed legacy JSON.
  const legacy = new Database(':memory:');
  legacy.exec('CREATE TABLE users (settings TEXT NOT NULL)');
  const insert = legacy.prepare('INSERT INTO users VALUES (?)');
  for (const value of [JSON.stringify({ canvasAnswers: true, showThoughtSignatures: false, theme: 'dark', agentTools: false, customInstructions: '保留' }),
    '{"canvasAnswers":null,"theme":"light"}', '{"canvasAnswers":false}', '{}', 'broken-json', 'null', '[]']) insert.run(value);
  const migration = fs.readFileSync(new URL('../server/drizzle/0035_retire_experimental_settings.sql', import.meta.url), 'utf8');
  legacy.exec(migration);
  let rows = legacy.prepare('SELECT settings FROM users').all().map((r) => r.settings);
  assert.deepEqual(JSON.parse(rows[0]), { theme: 'dark', agentTools: false, customInstructions: '保留' });
  assert.deepEqual(JSON.parse(rows[1]), { theme: 'light' });
  assert.deepEqual(JSON.parse(rows[2]), {});
  assert.deepEqual(rows.slice(3), ['{}', 'broken-json', 'null', '[]']);
  legacy.exec(migration);
  assert.deepEqual(legacy.prepare('SELECT settings FROM users').all().map((r) => r.settings), rows);
  legacy.close();

  runMigrations();
  for (const id of ['alice', 'bob', 'admin']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'not-used', role: id === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).run();
  }
  db.insert(schema.chats).values({ id: 'owned', userId: 'alice', createdAt: Date.now(), updatedAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'provider', name: 'Fixture', type: 'gemini', createdAt: Date.now() }).run();
  for (const [id, tools] of [['model', 1], ['plain', 0]]) db.insert(schema.models).values({ id, providerId: 'provider', modelId: id, tools, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  saveAgentSettings({ workspace: { enabled: false }, skills: { enabled: false } });

  for (const invalid of [null, {}, { ...sample, items: [sample.items[0]] }, { ...sample, unit: '' }, { ...sample, source: '' },
    { ...sample, items: Array.from({ length: 13 }, (_, i) => ({ label: String(i), value: i })) },
    { ...sample, items: [{ label: 'A', value: 1 }, { label: ' a ', value: 2 }] },
    { ...sample, items: [{ label: 'A', value: '1' }, { label: 'B', value: 2 }] },
    { ...sample, items: [{ label: 'A', value: 1e16 }, { label: 'B', value: 2 }] },
    { ...sample, html: '<script>alert(1)</script>' }]) assert.equal(parseComparison(JSON.stringify(invalid)), null);
  assert.equal(parseComparison('{"items":[{"label":"A","value":1e999}]}'), null);
  assert.deepEqual(parseComparison(asArgs(lineSample)), lineSample);
  for (const invalid of [
    { ...lineSample, chart: 'pie' }, { ...lineSample, chart: undefined }, { ...lineSample, items: sample.items },
    { ...lineSample, x: [6, 8, 8, 12, 24] }, { ...lineSample, x: [6, 8, 7, 12, 24] },
    { ...lineSample, x: [6, 8, Infinity, 12, 24] }, { ...lineSample, xLabels: ['6:00'] },
    { ...lineSample, series: [{ label: 'a', values: [0, 1] }] },
    { ...lineSample, series: [{ label: 'a', values: [null, null, 1, null, null] }] },
    { ...lineSample, series: [{ label: 'a', values: [0, 1, 2, 3, 4] }, { label: ' A ', values: [0, 1, 2, 3, 4] }] },
    { ...lineSample, series: Array.from({ length: 7 }, (_, i) => ({ label: String(i), values: [0, 1, 2, 3, 4] })) },
    { ...lineSample, xLabels: undefined, x: Array.from({ length: 120 }, (_, i) => i), series: Array.from({ length: 6 }, (_, i) => ({ label: String(i), values: Array(120).fill(0) })) },
  ]) assert.equal(parseComparison(asArgs(invalid)), null, JSON.stringify(invalid));
  const maximumLine = { ...lineSample, xLabels: undefined, x: Array.from({ length: 120 }, (_, i) => i),
    series: Array.from({ length: 5 }, (_, i) => ({ label: String(i), values: Array(120).fill(0) })) };
  assert(parseComparison(asArgs(maximumLine)));
  assert(validLineComparison(lineSample));
  assert(!validLineComparison({ ...lineSample, x: [6, 6] }));
  assert(!validLineComparison({ ...lineSample, series: [null] }));
  for (const values of [[0, 0], [-2, -1], [-2, 3], [1e-12, 2e-12], [5e-324, 1e-323]]) {
    const domain = lineDomain(values);
    assert(domain.min <= Math.min(...values) && domain.max >= Math.max(...values));
    assert(domain.ticks.every(Number.isFinite));
    assert(values.every((v) => Number.isFinite(domain.ratio(v)) && domain.ratio(v) >= 0 && domain.ratio(v) <= 1));
  }
  assert.equal(nearestXIndex([0, 1, 10], 4), 1, 'select by coordinate rather than evenly spaced index');
  assert.equal(nearestXIndex([0, 1, 10], 8), 2);
  assert.equal(linePath([0, 1, 10, 11], [0, null, 1, 2], (v) => v, (v) => v), 'M0.00,0.00  M10.00,1.00 L11.00,2.00');
  const lines = callCompareData(context, asArgs(lineSample));
  assert.deepEqual(lines.comparison, { type: 'data_comparison', ...lineSample });
  assert.deepEqual(JSON.parse(lines.result).series[0], { label: '方案 A', min: 0, max: 2, range: 2, peakX: 12 });
  // Verify the actual provider wire schema: nullable JSON unions become Gemini's nullable flag.
  const { geminiAdapter } = await import('../server/dist/providers/gemini.js');
  const providerFetch = globalThis.fetch;
  try {
    let sent;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    for await (const _ev of geminiAdapter.streamChat({ id: 'test', type: 'gemini', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {}, useVertex: false },
      { model: 'fixture', messages: [{ role: 'user', parts: [{ type: 'text', text: 'test' }] }], tools: [COMPARE_DATA_DEF], signal: new AbortController().signal })) { /* drain */ }
    assert.deepEqual(sent.tools[0].functionDeclarations[0].parameters.properties.series.items.properties.values.items, { type: 'number', nullable: true });
  } finally { globalThis.fetch = providerFetch; }
  const compared = callCompareData(context, asArgs());
  assert.equal(compared.isError, false);
  assert.deepEqual(compared.comparison, { type: 'data_comparison', ...sample });
  assert.equal(JSON.parse(compared.result).range, 100);
  assert.equal(callCompareData({ ...context, attempt: 2 }, asArgs()).isError, true);
  assert.equal(callCompareData({ ...context, userId: 'bob' }, asArgs()).isError, true);
  saveAgentSettings({ dataComparison: { accessMode: 'restricted', allowedUserIds: ['bob'] } });
  assert.equal(callCompareData(context, asArgs()).isError, true);
  saveAgentSettings({ dataComparison: { accessMode: 'shared' } });
  userSettings({ agentTools: false });
  assert.equal(callCompareData(context, asArgs()).isError, true);
  userSettings({});
  for (const values of [[-20, 0, 80], [-3, -1], [0, 0], [2, 8], [1e-12, 2e-12]]) {
    const scale = comparisonScale(values);
    assert(scale.min <= 0 && scale.max >= 0);
    for (const value of [...values, 0]) assert(Number.isFinite(scale.position(value)) && scale.position(value) >= 0 && scale.position(value) <= 100);
  }
  assert.equal(comparisonScale([-20, 0, 80]).position(0), 20);

  await app.register(cookie);
  await authPlugin(app); await authRoutes(app); await agentRoutes(app); await chatRoutes(app);
  adapter.streamChat = async function* (_cfg, req) {
    latestPrompt = req.system;
    offered.push(req.tools ?? []);
    const done = req.messages.some((m) => m.parts.some((p) => p.type === 'tool_result' && p.name === 'compare_data'));
    if (!done && plans.length) {
      if (beforeTool) { const hook = beforeTool; beforeTool = null; hook(); }
      for (let i = 0; i < plans.length; i++) yield { type: 'tool_call', id: `compare-${i}`, name: 'compare_data', args: asArgs(plans[i]) };
      yield { type: 'stop', reason: 'tool_calls' };
    } else { yield { type: 'text', text: '丙的净收益最高。' }; yield { type: 'stop', reason: 'stop' }; }
  };
  const profile = await request('PATCH', '/api/auth/profile', { settings: { canvasAnswers: true, showThoughtSignatures: true, theme: 'dark' } });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.deepEqual(profile.json().user.settings, { theme: 'dark' });
  assert.deepEqual(JSON.parse(rawDb.prepare('SELECT settings FROM users WHERE id=?').get('alice').settings), { theme: 'dark' });
  assert.equal((await request('GET', '/api/agent/capabilities')).json().dataComparison, true);
  assert.equal((await request('PUT', '/api/admin/agent', { dataComparison: { enabled: false } })).statusCode, 403);
  const adminSettings = await request('PUT', '/api/admin/agent', { dataComparison: { accessMode: 'restricted', allowedUserIds: ['alice'] } }, 'admin');
  assert.equal(adminSettings.statusCode, 200, adminSettings.body);
  assert.equal((await request('GET', '/api/agent/capabilities', undefined, 'bob')).json().dataComparison, false);

  const normal = await turn();
  assert.equal(normal.charts.length, 1, JSON.stringify(normal));
  assert(offered[0].some((t) => t.name === 'compare_data'));
  assert(!latestPrompt?.includes('互动画布'));
  assert(latestPrompt?.includes('数据足够后优先出图') && latestPrompt.includes('不能编造成完整时间曲线'));
  saveAgentSettings({ workspace: { enabled: true } });
  const withWorkspace = await turn();
  assert.equal(withWorkspace.charts.length, 1);
  assert(!latestPrompt.includes('生成 PDF/图表这类必须执行'));
  assert(latestPrompt.includes('此工具不依赖工作区、命令执行或沙盒'));
  saveAgentSettings({ workspace: { enabled: false } });
  assert.deepEqual(normal.charts[0].data, { type: 'data_comparison', ...sample });
  const saved = (await request('GET', `/api/chats/${normal.id}`)).json();
  assert(saved.messages.some((m) => m.parts.some((p) => p.type === 'data_comparison' && p.items.length === 3)));
  const exported = await request('GET', `/api/chats/${normal.id}/export?format=md`);
  assert.equal(exported.statusCode, 200, exported.body);
  assert(exported.body.includes('| 甲 | -20 |') && exported.body.includes(sample.source));
  const lineTurn = await turn([lineSample]);
  assert.equal(lineTurn.charts.length, 1);
  assert.deepEqual(lineTurn.charts[0].data, { type: 'data_comparison', ...lineSample });
  const savedLine = (await request('GET', `/api/chats/${lineTurn.id}`)).json();
  assert(savedLine.messages.some((m) => m.parts.some((p) => p.type === 'data_comparison' && p.chart === 'line' && p.series[1].values[2] === null)));
  const lineExport = await request('GET', `/api/chats/${lineTurn.id}/export?format=md`);
  assert(lineExport.body.includes('| 8:30 | 1 | — |') && lineExport.body.includes('方案 A (相对值)'));
  const mixed = await turn([lineSample, sample]);
  assert.equal(mixed.charts.length, 1); assert(mixed.results[1].isError, 'line and bar share one per-turn limit');
  const twice = await turn([sample, sample]);
  assert.equal(twice.charts.length, 1); assert(twice.results[1].isError);
  const invalidTurn = await turn([{ ...sample, items: [] }]);
  assert.equal(invalidTurn.charts.length, 0); assert(invalidTurn.results[0].isError);
  userSettings({ agentTools: false });
  const off = await turn(); assert.equal(off.charts.length, 0); assert(off.results[0].isError);
  assert(!latestPrompt?.includes('[图表对比]'));
  assert(!offered[0].some((t) => t.name === 'compare_data'));
  userSettings({});
  const plain = await turn([sample], 'plain'); assert.equal(plain.charts.length, 0);
  assert(!offered[0].some((t) => t.name === 'compare_data'));
  beforeTool = () => saveAgentSettings({ dataComparison: { enabled: false } });
  const revoked = await turn(); assert.equal(revoked.charts.length, 0); assert(revoked.results[0].isError);
  assert.equal((await request('GET', '/api/agent/capabilities')).json().dataComparison, false);
  saveAgentSettings({ dataComparison: { enabled: true } });
  const text = await turn([]); assert.equal(text.charts.length, 0);
  // Browser dispatches the persisted chart part without another model request.
  const { streamChat } = await import('../web/src/api.ts');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(`event: data_comparison\ndata: ${JSON.stringify(normal.charts[0].data)}\n\nevent: done\ndata: {"status":"done"}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    let received;
    await streamChat('fixture', {}, { onDataComparison: (part) => { received = part; } }, new AbortController().signal);
    assert.deepEqual(received, normal.charts[0].data);
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: multiline/gaps/irregular axes/Gemini schema, retirement migration/profile cleanup, numeric validation/scales, ACL/revocation, per-turn cap, SSE, persistence, Markdown export and text-only fallback.');
} finally {
  adapter.streamChat = originalStream;
  await app.close(); rawDb.close(); fs.rmSync(temp, { recursive: true, force: true });
}
