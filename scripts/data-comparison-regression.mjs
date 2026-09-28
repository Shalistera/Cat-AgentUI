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
const { callCompareData, parseComparison, COMPARE_DATA_DEF, comparisonPresentationHint, comparisonPresentationIntent, comparisonToolDefinition } = await import('../server/dist/data-comparison.js');
const { buildSandboxPrompt } = await import('../server/dist/sandbox/tool.js');
const { buildSkillsPrompt } = await import('../server/dist/skills.js');
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
let plannedRounds;
let offered = [];
let beforeTool;
let latestPrompt;
let upstreamRequests = [];
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
async function turn(calls = [sample], modelId = 'model', options = {}) {
  plans = calls; offered = []; upstreamRequests = [];
  plannedRounds = options.rounds ? [...options.rounds] : undefined;
  const created = await request('POST', '/api/chats', { modelId });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().chat.id;
  await request('PATCH', `/api/chats/${id}`, { title: '图表测试', ...(options.webSearch ? { webSearch: true } : {}) });
  const res = await request('POST', `/api/chats/${id}/stream`, { modelId, content: [{ type: 'text', text: options.text ?? '比较甲、乙、丙的净收益' }] });
  assert.equal(res.statusCode, 200, res.body);
  const events = [...res.body.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  return { id, events, charts: events.filter((e) => e.type === 'data_comparison'), results: events.filter((e) => e.type === 'tool_result').map((e) => e.data) };
}

try {
  const reportedPrompt = '去网上调查一下专注达的药动力信息，对比一下速效利他林的吸收信息，给我展示出来两种哌甲酯的区别，用时间段来展示吧。';
  for (const text of [reportedPrompt, '按时间对比两条产线的产量', '对比去年和今年的销量，用折线图显示',
    '给我画个柱状图', 'Show a graph of these values', 'Compare these two series over time',
    '不要长篇大论，给我画个对比图', '不需要文字，用图表展示', '不要写代码，直接用图表展示']) {
    assert(comparisonPresentationHint(text), text);
  }
  for (const text of ['你好', '今天有什么新闻', '比较两个方案的优缺点', '什么是折线图',
    '按时间对比两个方案，但不要画图', '请用文字介绍两者区别，只要文字',
    '对比两个方案，别给我生成图表', '按时间对比两者，不用折线图', 'Compare these two series over time, text only',
    '按时间展示这两组数据，仅用表格',
    '请翻译这句话：对比两种方案，用时间段展示', '帮我写一个生成折线图的函数',
    '为什么没有选用多曲线折线图？我在调试，不要重新调用。', '分析图表工具的提示词，为什么用柱状图展示了峰值',
    '他回复“给我画个柱状图”是什么意思', '解释 `用图表展示两者区别` 这句话',
    '> 对比两者，用时间段展示\n解释这段引用', '```\n对比两者，用时间段展示\n```',
    '~~~text\n对比两者，用时间段展示\n~~~']) {
    assert.equal(comparisonPresentationHint(text), null, text);
  }
  assert.equal(comparisonPresentationIntent(reportedPrompt)?.chart, 'line');
  assert.equal(comparisonPresentationIntent('展示一天内两种方案的变化对比')?.chart, 'line');
  assert.equal(comparisonPresentationIntent('给我画多曲线折线对比图')?.chart, 'line');
  assert.equal(comparisonPresentationIntent('按时间对比两家店的销量，但用柱状图展示')?.chart, 'bar');
  assert.equal(comparisonPresentationIntent('Show a graph of these values')?.chart, undefined);
  assert.equal(comparisonPresentationIntent('展示折线图和柱状图的区别')?.chart, undefined);
  const lineDef = comparisonToolDefinition('line');
  const barDef = comparisonToolDefinition('bar');
  assert.equal(lineDef.parameters.properties.items, undefined);
  assert.deepEqual(lineDef.parameters.properties.chart.enum, ['line']);
  assert(lineDef.parameters.required.includes('series') && lineDef.parameters.required.includes('x'));
  assert.equal(barDef.parameters.properties.series, undefined);
  assert.deepEqual(barDef.parameters.properties.chart.enum, ['bar']);
  assert.equal(comparisonToolDefinition(), COMPARE_DATA_DEF, 'unclassified tasks retain both chart types');
  const lineExample = lineDef.description.split('\n').find((line) => line.includes(' {'));
  assert.equal(parseComparison(lineExample.slice(lineExample.indexOf('{'))).series.length, 2, 'show a working multi-curve example');
  assert(buildSkillsPrompt([], true, true).includes('直接用 compare_data'));
  assert(!buildSkillsPrompt([], true).includes('compare_data'), 'subagents without the chart tool retain their own workflow');
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
  assert(buildSandboxPrompt(true).includes('多条曲线不是改用 Python 绘图的理由'));
  assert(buildSandboxPrompt(true).includes('ModuleNotFoundError'));
  assert(!buildSandboxPrompt(false).includes('compare_data'), 'do not advertise a disabled chart tool');
  for (const id of ['alice', 'bob', 'admin']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'not-used', role: id === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).run();
  }
  db.insert(schema.chats).values({ id: 'owned', userId: 'alice', createdAt: Date.now(), updatedAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'provider', name: 'Fixture', type: 'gemini', createdAt: Date.now() }).run();
  for (const [id, tools] of [['model', 1], ['plain', 0], ['native', 1]]) db.insert(schema.models).values({ id, providerId: 'provider', modelId: id === 'native' ? 'gemini-3.8-flash' : id, tools, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  saveAgentSettings({ workspace: { enabled: false }, skills: { enabled: false } });

  for (const invalid of [null, {}, { ...sample, items: [sample.items[0]] }, { ...sample, unit: '' }, { ...sample, source: '' },
    { ...sample, items: Array.from({ length: 13 }, (_, i) => ({ label: String(i), value: i })) },
    { ...sample, items: [{ label: 'A', value: 1 }, { label: ' a ', value: 2 }] },
    ...['', ' ', true, null, '1 美元', '1,234', '1e999'].map((value) => ({ ...sample, items: [{ label: 'A', value }, { label: 'B', value: 2 }] })),
    { ...sample, items: [{ label: 'A', value: 1e16 }, { label: 'B', value: 2 }] },
    { ...sample, html: '<script>alert(1)</script>' }]) assert.equal(parseComparison(JSON.stringify(invalid)), null);
  assert.equal(parseComparison('{"items":[{"label":"A","value":1e999}]}'), null);
  assert.deepEqual(parseComparison(asArgs(lineSample)), lineSample);
  for (const invalid of [
    { ...lineSample, chart: 'pie' }, { ...lineSample, chart: undefined, items: sample.items },
    { ...lineSample, x: [6, 8, 8, 12, 24] }, { ...lineSample, x: [6, 8, 7, 12, 24] },
    { ...lineSample, x: [6, 8, Infinity, 12, 24] }, { ...lineSample, xLabels: ['6:00'] },
    { ...lineSample, series: [{ label: 'a', values: [0, 1] }] },
    { ...lineSample, series: [{ label: 'a', values: [null, null, 1, null, null] }] },
    { ...lineSample, series: [{ label: 'a', values: [0, 1, 2, 3, 4] }, { label: ' A ', values: [0, 1, 2, 3, 4] }] },
    { ...lineSample, series: Array.from({ length: 7 }, (_, i) => ({ label: String(i), values: [0, 1, 2, 3, 4] })) },
    { ...lineSample, xLabels: undefined, x: Array.from({ length: 120 }, (_, i) => i), series: Array.from({ length: 6 }, (_, i) => ({ label: String(i), values: Array(120).fill(0) })) },
  ]) assert.equal(parseComparison(asArgs(invalid)), null, JSON.stringify(invalid));
  // The two reported failures: full line+bar fields and placeholder line
  // fields on a bar request. Inactive fields never reach the rendered data.
  assert.deepEqual(parseComparison(asArgs({ ...lineSample, items: sample.items })), lineSample);
  assert.deepEqual(parseComparison(asArgs({ ...sample, chart: 'bar', x: [0], xLabels: [], xLabel: '', series: [] })), { ...sample, chart: 'bar' });
  assert.deepEqual(parseComparison(asArgs({ ...sample, chart: null, x: null, xLabels: null, xLabel: null, series: null })), sample);
  assert.deepEqual(parseComparison(asArgs({ ...lineSample, chart: undefined, items: null })), lineSample);
  const { xLabels: _labels, ...lineWithoutLabels } = lineSample;
  assert.deepEqual(parseComparison(asArgs({ ...lineSample, chart: ' LINE ', xLabels: null })), lineWithoutLabels);
  const numericStrings = { ...lineSample, x: lineSample.x.map(String), series: lineSample.series.map((s) => ({ ...s, values: s.values.map((v) => v === null ? null : String(v)) })) };
  assert.deepEqual(parseComparison(asArgs(numericStrings)), lineSample);
  assert.equal(parseComparison(asArgs({ ...sample, items: [{ label: 'A', value: '224.58' }, { label: 'B', value: '225.07' }] })).items[0].value, 224.58);
  const longerSource = 'https://example.com/quotes?context=' + 'a'.repeat(220);
  assert.equal(parseComparison(asArgs({ ...sample, source: longerSource })).source, longerSource);
  assert.equal(parseComparison(asArgs({ ...sample, source: 'a'.repeat(1001) })), null);
  for (const example of COMPARE_DATA_DEF.description.split('\n').filter((line) => line.includes(' {'))) {
    assert(parseComparison(example.slice(example.indexOf('{'))), 'every advertised example must be accepted');
  }
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
  const { openaiAdapter } = await import('../server/dist/providers/openai.js');
  const { anthropicAdapter } = await import('../server/dist/providers/anthropic.js');
  const providerFetch = globalThis.fetch;
  try {
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      const event = url.endsWith('/responses') ? { type: 'response.completed', response: { status: 'completed' } }
        : url.endsWith('/chat/completions') ? { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
        : url.endsWith('/messages') ? { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
        : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    for await (const _ev of geminiAdapter.streamChat({ id: 'test', type: 'gemini', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {}, useVertex: false },
      { model: 'fixture', messages: [{ role: 'user', parts: [{ type: 'text', text: 'test' }] }], tools: [COMPARE_DATA_DEF], signal: new AbortController().signal })) { /* drain */ }
    assert.deepEqual(sent.tools[0].functionDeclarations[0].parameters.properties.series.items.properties.values.items, { type: 'number', nullable: true });
    assert.deepEqual(sent.tools[0].functionDeclarations[0].parameters.properties.chart.enum, ['bar', 'line'], 'Gemini enum values remain strings');
    assert.equal(sent.tools[0].functionDeclarations[0].parameters.properties.items.nullable, true);
    assert.deepEqual(sent.tools[0].functionDeclarations[0].parameters.required, ['title', 'unit', 'source']);
    const req = { model: 'fixture', messages: [{ role: 'user', parts: [{ type: 'text', text: 'chart test' }] }], tools: [COMPARE_DATA_DEF], signal: new AbortController().signal };
    const cfg = { id: 'fixture', type: 'openai', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {} };
    for (const useResponses of [true, false]) {
      for await (const _ev of openaiAdapter.streamChat({ ...cfg, useResponses }, req)) { /* drain */ }
      const tool = useResponses ? sent.tools[0] : sent.tools[0].function;
      if (useResponses) assert.equal(tool.strict, false, 'Responses must not promote optional chart fields to required');
      assert.deepEqual(tool.parameters, COMPARE_DATA_DEF.parameters, 'preserve optional fields on Responses and Chat Completions');
    }
    for await (const _ev of anthropicAdapter.streamChat({ ...cfg, type: 'anthropic' }, req)) { /* drain */ }
    assert.deepEqual(sent.tools[0].input_schema, COMPARE_DATA_DEF.parameters);
  } finally { globalThis.fetch = providerFetch; }
  const compared = callCompareData(context, asArgs());
  assert.equal(compared.isError, false);
  assert.deepEqual(compared.comparison, { type: 'data_comparison', ...sample });
  assert.equal(JSON.parse(compared.result).range, 100);
  assert.equal(callCompareData({ ...context, attempt: 2, alreadyRendered: true }, asArgs()).isError, true);
  assert.equal(callCompareData({ ...context, attempt: 3 }, asArgs()).isError, true);
  const wrongTarget = callCompareData({ ...context, chartTarget: 'line' }, asArgs(sample));
  assert(wrongTarget.isError && !wrongTarget.comparison && wrongTarget.result.includes('不能用峰值或总量柱状图替代'));
  assert(!callCompareData({ ...context, chartTarget: 'line', attempt: 2 }, asArgs(lineSample)).isError);
  assert(callCompareData({ ...context, chartTarget: 'bar' }, asArgs(lineSample)).isError);
  const missingUnit = callCompareData(context, asArgs({ ...sample, unit: '' }));
  assert(missingUnit.isError && missingUnit.result.includes('unit:') && missingUnit.result.includes('重试一次'));
  const mismatched = { ...lineSample, series: [{ label: 'A', values: [10, 12] }] };
  assert.match(callCompareData(context, asArgs(mismatched)).result, /series\[0\]\.values:.*5 项/);
  assert.match(callCompareData(context, asArgs({ ...lineSample, x: [6, 8, 7, 12, 24] })).result, /x\[2\]:.*必须大于/);
  assert.match(callCompareData(context, asArgs({ ...lineSample, x: ['09-24', '09-25'] })).result, /x\[0\]:.*xLabels/);
  assert(!callCompareData({ ...context, attempt: 2 }, asArgs(mismatched)).result.includes('重试一次'));
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
    upstreamRequests.push(req);
    offered.push(req.tools ?? []);
    const done = req.messages.some((m) => m.parts.some((p) => p.type === 'tool_result' && p.name === 'compare_data'));
    const roundCalls = plannedRounds ? plannedRounds.shift() ?? [] : !done ? plans : [];
    if (roundCalls.length) {
      if (beforeTool) { const hook = beforeTool; beforeTool = null; hook(); }
      for (let i = 0; i < roundCalls.length; i++) yield { type: 'tool_call', id: `compare-${upstreamRequests.length}-${i}`, name: 'compare_data', args: asArgs(roundCalls[i]) };
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

  // The reported wording receives a per-turn intent hint without changing
  // Vertex native grounding or the set of agent tools.
  db.update(schema.providers).set({ useVertex: 1, vertexProject: 'fixture', vertexLocation: 'global' }).where(eq(schema.providers.id, 'provider')).run();
  const native = await turn([lineSample], 'native', { text: reportedPrompt, webSearch: true });
  assert.equal(native.charts.length, 1);
  assert(latestPrompt.includes('[本轮图表意图]') && latestPrompt.includes('优先绘制时间曲线'));
  assert(upstreamRequests.every((r) => r.webSearch === true));
  assert(upstreamRequests.every((r) => !r.tools.some((t) => t.name === 'google_search')));
  assert(upstreamRequests[0].tools.some((t) => t.name === 'compare_data'));
  assert.deepEqual(upstreamRequests[0].tools.find((t) => t.name === 'compare_data').parameters.properties.chart.enum, ['line']);
  assert(!upstreamRequests[1].tools.some((t) => t.name === 'compare_data'), 'hide the chart tool after successful rendering');
  assert(upstreamRequests[0].messages.at(-1).parts.some((p) => p.text === reportedPrompt), 'original user text is unchanged');
  assert.equal(upstreamRequests.length, 2, 'normal tool call and answer, no classifier or repair model calls');
  const target = native.events.find((e) => e.type === 'meta').data.messageId;
  await request('POST', `/api/chats/${native.id}/stream`, { modelId: 'native', regenerateMessageId: target });
  assert(latestPrompt.includes('[本轮图表意图]'), 'regeneration uses the selected user message');
  await request('POST', `/api/chats/${native.id}/stream`, { modelId: 'native', content: [{ type: 'text', text: '现在只要文字，不要画图' }] });
  assert(!latestPrompt.includes('[本轮图表意图]'), 'prior chart requests do not force later turns');
  db.update(schema.providers).set({ useVertex: 0 }).where(eq(schema.providers.id, 'provider')).run();
  const normal = await turn();
  assert.equal(normal.charts.length, 1, JSON.stringify(normal));
  assert(offered[0].some((t) => t.name === 'compare_data'));
  assert(!latestPrompt?.includes('互动画布'));
  assert(!latestPrompt?.includes('[本轮图表意图]'), 'ordinary comparisons retain the default behavior');
  assert(latestPrompt?.includes('数据足够后优先出图') && latestPrompt.includes('不能编造成完整时间曲线'));
  saveAgentSettings({ workspace: { enabled: true } });
  const withWorkspace = await turn();
  assert.equal(withWorkspace.charts.length, 1);
  assert(!latestPrompt.includes('生成 PDF/图表这类必须执行'));
  assert(latestPrompt.includes('不依赖工作区、命令执行或沙盒'));
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
  const tolerantLine = await turn([{ ...lineSample, items: sample.items }]);
  assert.deepEqual(tolerantLine.charts[0].data, { type: 'data_comparison', ...lineSample });
  assert.equal(upstreamRequests.length, 2, 'inactive fields are normalized without a repair round');
  const tolerantBar = await turn([{ ...sample, chart: 'bar', xLabel: '', x: [0], xLabels: [], series: [] }]);
  assert.deepEqual(tolerantBar.charts[0].data, { type: 'data_comparison', ...sample, chart: 'bar' });
  assert.equal(upstreamRequests.length, 2);
  const goalRepair = await turn([], 'model', { text: reportedPrompt, rounds: [[sample], [lineSample]] });
  assert(goalRepair.results[0].isError && !goalRepair.results[1].isError);
  assert.deepEqual(goalRepair.charts.map((c) => c.data.chart), ['line'], 'never display a substitute bar chart for a time-series request');
  assert.equal(upstreamRequests.length, 3);
  const noSeries = await turn([sample], 'model', { text: reportedPrompt });
  assert.equal(noSeries.charts.length, 0, 'missing time data does not silently degrade into a summary chart');
  const explicitBar = await turn([sample], 'model', { text: '按时间对比两家店的销量，用柱状图展示' });
  assert.equal(explicitBar.charts.length, 1, 'honor an explicit bar preference despite temporal wording');
  const mixed = await turn([lineSample, sample]);
  assert.equal(mixed.charts.length, 1); assert(mixed.results[1].isError, 'line and bar share one per-turn limit');
  const twice = await turn([sample, sample]);
  assert.equal(twice.charts.length, 1); assert(twice.results[1].isError);
  const invalidTurn = await turn([{ ...sample, items: [] }]);
  assert.equal(invalidTurn.charts.length, 0); assert(invalidTurn.results[0].isError);
  const fixed = await turn([], 'model', { rounds: [[mismatched], [lineSample]] });
  assert.equal(fixed.charts.length, 1); assert.deepEqual(fixed.charts[0].data, { type: 'data_comparison', ...lineSample });
  assert(fixed.results[0].isError && !fixed.results[1].isError);
  assert.equal(upstreamRequests.length, 3, 'one failed attempt, one correction, then conclusion');
  assert(offered[1].some((t) => t.name === 'compare_data'));
  assert(!offered[2].some((t) => t.name === 'compare_data'));
  const exhausted = await turn([], 'model', { rounds: [[mismatched], [mismatched]] });
  assert.equal(exhausted.charts.length, 0);
  assert(exhausted.results[1].result.includes('修正次数已用完'));
  assert(!offered[2].some((t) => t.name === 'compare_data'), 'hide after two failed attempts');
  const forcedThird = await turn([mismatched, mismatched, lineSample]);
  assert.equal(forcedThird.charts.length, 0); assert(forcedThird.results[2].isError, 'runtime cap still applies if model ignores tool availability');
  userSettings({ agentTools: false });
  const off = await turn([sample], 'model', { text: reportedPrompt }); assert.equal(off.charts.length, 0); assert(off.results[0].isError);
  assert(!latestPrompt?.includes('[图表对比]') && !latestPrompt?.includes('[本轮图表意图]'));
  assert(!offered[0].some((t) => t.name === 'compare_data'));
  userSettings({});
  const plain = await turn([sample], 'plain', { text: reportedPrompt }); assert.equal(plain.charts.length, 0);
  assert(!latestPrompt?.includes('[本轮图表意图]'));
  assert(!offered[0].some((t) => t.name === 'compare_data'));
  beforeTool = () => saveAgentSettings({ dataComparison: { enabled: false } });
  const revoked = await turn(); assert.equal(revoked.charts.length, 0); assert(revoked.results[0].isError);
  assert.equal((await request('GET', '/api/agent/capabilities')).json().dataComparison, false);
  saveAgentSettings({ dataComparison: { enabled: true } });
  const text = await turn([], 'model', { text: reportedPrompt }); assert.equal(text.charts.length, 0);
  assert.equal(upstreamRequests.length, 1, 'a text-only response does not trigger a hidden chart repair request');
  // Browser dispatches the persisted chart part without another model request.
  const { streamChat } = await import('../web/src/api.ts');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(`event: data_comparison\ndata: ${JSON.stringify(normal.charts[0].data)}\n\nevent: done\ndata: {"status":"done"}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    let received;
    await streamChat('fixture', {}, { onDataComparison: (part) => { received = part; } }, new AbortController().signal);
    assert.deepEqual(received, normal.charts[0].data);
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: chart-target schema/runtime guard and bounded correction, multi-curve examples and sandbox routing, mixed-field normalization, provider schemas/native search preservation, validation/ACL/one-chart cap, SSE/persistence/export and text-only fallback.');
} finally {
  adapter.streamChat = originalStream;
  await app.close(); rawDb.close(); fs.rmSync(temp, { recursive: true, force: true });
}
