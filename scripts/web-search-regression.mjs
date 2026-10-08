// Temporary SQLite + real Fastify routes, with in-process model stubs: an
// OpenAI-type chat model that calls web_search, and the Gemini search model
// answering with grounding. No credentials or network are involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { and, eq } from 'drizzle-orm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-web-search-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'web-search-regression-secret';
const { db, rawDb, schema, runMigrations, setSetting, today } = await import('../server/dist/db/index.js');
const { saveAgentSettings, getAgentSettings } = await import('../server/dist/agent-settings.js');
const { monthlySearchQueries, resetSearchCooldowns, runWebSearch } = await import('../server/dist/web-search.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { authRoutes } = await import('../server/dist/routes/auth.js');
const { agentRoutes } = await import('../server/dist/routes/agent.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { getAdapter } = await import('../server/dist/providers/index.js');
const { runSubagent } = await import('../server/dist/subagent.js');
const { WebToolBudget } = await import('../server/dist/web-tool-policy.js');
const { primeFetchCache, runWebFetch } = await import('../server/dist/web-fetch.js');
const { geminiAdapter } = await import('../server/dist/providers/gemini.js');

const app = Fastify();
app.setErrorHandler((err, _req, reply) => reply.code(err.message === 'forbidden' ? 403 : err.message === 'unauthorized' ? 401 : 500).send({ error: err.message }));
const openai = getAdapter('openai');
const gemini = getAdapter('gemini');
const originals = { openai: openai.streamChat, gemini: gemini.streamChat };
let chatRequests = [];
let searchRequests = [];
let callSearch = true;
const SOURCE = { uri: 'https://nodejs.org/en/about/previous-releases', title: 'nodejs.org' };

const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const userSettings = (settings) => db.update(schema.users).set({ settings: JSON.stringify(settings) }).where(eq(schema.users.id, 'alice')).run();
async function turn(modelId = 'gpt', user = 'alice', effort = null) {
  chatRequests = []; searchRequests = [];
  const created = await request('POST', '/api/chats', { modelId }, user);
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().chat.id;
  if (effort !== null) assert.equal((await request('PATCH', `/api/chats/${id}`, { reasoningEffort: effort }, user)).statusCode, 200);
  const res = await request('POST', `/api/chats/${id}/stream`, { modelId, content: [{ type: 'text', text: 'Node.js 最新 LTS 是哪个版本?' }] }, user);
  assert.equal(res.statusCode, 200, res.body);
  const events = [...res.body.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  return { id, events, results: events.filter((e) => e.type === 'tool_result').map((e) => e.data), grounding: events.find((e) => e.type === 'grounding')?.data };
}
const offeredSearch = () => chatRequests[0].tools?.some((t) => t.name === 'web_search') ?? false;

try {
  runMigrations();
  for (const id of ['alice', 'admin']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'not-used', role: id === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'chat', name: 'Chat', type: 'openai', createdAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'google', name: 'Google', type: 'gemini', useVertex: 1, vertexProject: 'fixture', vertexLocation: 'global', createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'gpt', providerId: 'chat', modelId: 'gpt-fixture', tools: 1, createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'gem', providerId: 'google', modelId: 'gemini-3.8-flash', tools: 1, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  saveAgentSettings({ workspace: { enabled: false }, skills: { enabled: false }, dataComparison: { enabled: false } });

  await app.register(cookie);
  await authPlugin(app); await authRoutes(app); await agentRoutes(app); await chatRoutes(app);

  openai.streamChat = async function* (_cfg, req) {
    chatRequests.push(req);
    const last = req.messages.at(-1);
    const answered = last.role === 'assistant' && last.parts.some((p) => p.type === 'tool_result');
    if (callSearch && !answered) {
      yield { type: 'tool_call', id: `s-${chatRequests.length}`, name: 'web_search', args: JSON.stringify({ query: 'Node.js LTS 2026' }) };
      yield { type: 'stop', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: `Node.js 24 是当前 LTS[nodejs.org](${SOURCE.uri})。` };
    yield { type: 'stop', reason: 'stop' };
  };
  gemini.streamChat = async function* (_cfg, req) {
    if (req.model !== 'gemini-3.5-flash-lite') {
      // the native Gemini chat turn
      chatRequests.push(req);
      yield { type: 'text', text: '原生搜索回答' };
      yield { type: 'stop', reason: 'stop' };
      return;
    }
    searchRequests.push(req);
    yield { type: 'text', text: '- Node.js 24 于 2025-10-28 进入 Active LTS' };
    yield { type: 'grounding', grounding: { queries: ['Node.js LTS', 'Node.js 24 LTS date'], sources: [SOURCE] } };
    yield { type: 'usage', usage: { promptTokens: 60, completionTokens: 300, totalTokens: 360 } };
    yield { type: 'stop', reason: 'stop' };
  };

  // Any tool-capable model gets web_search without a per-chat switch; the
  // search runs on the Gemini search model with Google grounding.
  const first = await turn();
  assert(offeredSearch(), 'web_search offered by default');
  assert(chatRequests[0].system.includes(`今天是 ${today()}`) && chatRequests[0].system.includes('web_search'));
  assert.equal(searchRequests.length, 1);
  assert.equal(searchRequests[0].webSearch, true);
  assert(searchRequests[0].system.includes(today()));
  assert.equal(searchRequests[0].messages[0].parts[0].text, 'Node.js LTS 2026');
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].isError, false);
  assert(first.results[0].result.includes('Node.js 24') && first.results[0].result.includes(`[1] nodejs.org — ${SOURCE.uri}`));
  assert(!first.events.some((e) => e.type === 'tool_confirm'), 'search never asks for confirmation');
  assert.equal(first.grounding.label, 'Google 搜索');
  assert.deepEqual(first.grounding.queries, ['Node.js LTS 2026']);
  assert.equal(first.grounding.sources[0].uri, SOURCE.uri);
  assert.equal(monthlySearchQueries(), 2, 'month counter follows the queries Google ran');
  const logged = db.select().from(schema.usageLog).where(and(eq(schema.usageLog.userId, 'alice'), eq(schema.usageLog.kind, 'web_search'))).all();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].model, 'gemini-3.5-flash-lite');
  assert.equal(logged[0].completionTokens, 300);

  // Vertex Gemini chat models keep native search instead of the tool.
  await turn('gem');
  assert.equal(chatRequests[0].webSearch, true);
  assert(!offeredSearch());
  assert(!chatRequests[0].tools?.some((t) => t.name === 'web_fetch'), 'Vertex defaults to no Agent page reader');

  // The person's 智能工具 switch and the admin policy both withhold it; a
  // remembered call gets a plain explanation instead of an MCP error.
  userSettings({ agentTools: false });
  await turn();
  assert(!offeredSearch());
  userSettings({});
  saveAgentSettings({ webSearch: { enabled: false } });
  const off = await turn();
  assert(!offeredSearch());
  assert(off.results[0].isError && off.results[0].result.includes('联网搜索当前不可用'));
  assert.equal(searchRequests.length, 0);
  saveAgentSettings({ webSearch: { enabled: true } });

  // Monthly allowance spent: the tool is no longer offered.
  saveAgentSettings({ webSearch: { monthlyLimit: 2 } });
  callSearch = false;
  await turn();
  assert(!offeredSearch());
  assert(!(chatRequests[0].system ?? '').includes('web_search'));
  saveAgentSettings({ webSearch: { monthlyLimit: 0, dailyLimit: 1 } });

  // Per-user daily cap (alice already searched once today); admins have
  // their own cap, unlimited by default.
  const ctx = (user) => ({ user, chatId: 'none', messageId: 'none', signal: new AbortController().signal });
  const admin = { id: 'admin', role: 'admin' };
  const capped = await runWebSearch(ctx({ id: 'alice', role: 'user' }), JSON.stringify({ query: 'x' }));
  assert(capped.isError && capped.result.includes('上限(1 次)'));
  assert.equal((await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }))).isError, false);
  assert((await runWebSearch(ctx(admin), '{}')).isError, 'query required');
  saveAgentSettings({ webSearch: { adminDailyLimit: 1 } });
  assert((await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }))).result.includes('上限(1 次)'));
  saveAgentSettings({ webSearch: { adminDailyLimit: 0, dailyLimit: 0 } });

  // Fallback chain: search model → fallback model → search MCP. A failed
  // line sits out its cooldown instead of costing a timeout every call.
  const searchStub = gemini.streamChat;
  const tried = [];
  let failing = new Set(['gemini-3.5-flash-lite']);
  gemini.streamChat = async function* (cfg, req) {
    tried.push(req.model);
    if (failing.has(req.model)) throw new Error(`${req.model} 503`);
    yield* searchStub.call(this, cfg, { ...req, model: 'gemini-3.5-flash-lite' });
  };
  const viaBackup = await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }));
  assert.equal(viaBackup.isError, false);
  assert.equal(viaBackup.label, 'Google 搜索');
  assert.deepEqual(tried, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  tried.length = 0;
  await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }));
  assert.deepEqual(tried, ['gemini-3.1-flash-lite'], 'failed primary skipped during cooldown');
  resetSearchCooldowns();

  // Everything Google down and no MCP: a plain tool error, not a thrown turn.
  failing = new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  const failed = await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }));
  assert(failed.isError && failed.result.includes('gemini-3.5-flash-lite 503') && failed.result.includes('gemini-3.1-flash-lite 503'));

  // A usable answer without citations must not trigger a hidden second search.
  resetSearchCooldowns();
  let attempts = 0;
  gemini.streamChat = async function* () {
    attempts++;
    yield { type: 'text', text: '- 要点' };
    yield { type: 'grounding', grounding: { queries: ['q'], sources: attempts === 1 ? [] : [SOURCE] } };
    yield { type: 'stop', reason: 'stop' };
  };
  const retried = await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }));
  assert.equal(attempts, 1);
  assert.deepEqual(retried.sources, []);
  assert(retried.result.includes('没有返回来源链接'));

  // The adapter keeps sources from an earlier chunk when a later grounding
  // chunk only repeats the queries.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    { candidates: [{ content: { parts: [{ text: 'a' }] }, groundingMetadata: { webSearchQueries: ['q1'], groundingChunks: [{ web: { uri: SOURCE.uri, title: 'nodejs.org' } }] } }] },
    { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['q1', 'q2'] } }] },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  let merged;
  try {
    for await (const ev of geminiAdapter.streamChat({ id: 't', type: 'gemini', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {}, useVertex: false },
      { model: 'gemini-3.5-flash-lite', webSearch: true, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], signal: new AbortController().signal })) {
      if (ev.type === 'grounding') merged = ev.grounding;
    }
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(merged.queries, ['q1', 'q2']);
  assert.equal(merged.sources[0].uri, SOURCE.uri);
  gemini.streamChat = async function* (cfg, req) {
    tried.push(req.model);
    if (failing.has(req.model)) throw new Error(`${req.model} 503`);
    yield* searchStub.call(this, cfg, { ...req, model: 'gemini-3.5-flash-lite' });
  };

  // With a designated search MCP, it answers last.
  db.insert(schema.mcpServers).values({ id: 'brave', name: 'Mock Brave', transport: 'stdio', command: process.execPath,
    args: JSON.stringify([path.join(path.dirname(new URL(import.meta.url).pathname), 'mock-mcp.mjs')]), createdAt: Date.now() }).run();
  setSetting('searchMcpServerId', 'brave');
  resetSearchCooldowns();
  tried.length = 0;
  const viaMcp = await runWebSearch(ctx(admin), JSON.stringify({ query: '黑猫' }));
  assert.equal(viaMcp.isError, false, viaMcp.result);
  assert.equal(viaMcp.label, 'Mock Brave');
  assert(viaMcp.result.includes('搜索「黑猫」的结果'));
  assert.deepEqual(viaMcp.sources, [{ uri: 'https://example.com/cat-news', title: '黑猫日报' }]);
  assert.deepEqual(tried, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  // Past the month's Google limit only the MCP is asked, and the tool stays offered.
  saveAgentSettings({ webSearch: { monthlyLimit: 1 } });
  tried.length = 0;
  assert.equal((await runWebSearch(ctx(admin), JSON.stringify({ query: '黑猫' }))).label, 'Mock Brave');
  assert.deepEqual(tried, []);
  // Missing citations also must not trigger an extra MCP lookup.
  saveAgentSettings({ webSearch: { monthlyLimit: 0 } });
  resetSearchCooldowns();
  gemini.streamChat = async function* () {
    yield { type: 'text', text: '- 无来源的要点' };
    yield { type: 'grounding', grounding: { queries: ['q'], sources: [] } };
    yield { type: 'stop', reason: 'stop' };
  };
  const patched = await runWebSearch(ctx(admin), JSON.stringify({ query: '黑猫' }));
  assert.equal(patched.label, 'Google 搜索');
  assert(patched.result.includes('本次搜索没有返回来源链接'));
  assert(!patched.result.includes('https://example.com/cat-news'));
  assert.deepEqual(patched.sources, []);
  saveAgentSettings({ webSearch: { monthlyLimit: 1 } });
  callSearch = true;
  gemini.streamChat = searchStub;
  const mcpTurn = await turn('gpt', 'admin');
  assert(offeredSearch());
  assert.equal(mcpTurn.results[0].isError, false);
  assert(!chatRequests[0].tools.some((t) => t.name.includes('search') && t.name !== 'web_search'), 'no raw MCP search tools');
  saveAgentSettings({ webSearch: { mcpFallback: false } });
  callSearch = false;
  await turn('gpt', 'admin');
  assert(!offeredSearch(), 'nothing left to search with');
  saveAgentSettings({ webSearch: { mcpFallback: true, monthlyLimit: 0 } });

  // Admin settings: validation and status.
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { model: 'gemini-3.1-flash-lite' } })).statusCode, 403);
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { providerId: 'chat' } }, 'admin')).statusCode, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { model: 'gpt-4o' } }, 'admin')).statusCode, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { fallbackModel: 'gpt-4o' } }, 'admin')).statusCode, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { fallbackProviderId: 'chat' } }, 'admin')).statusCode, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { fallbackModel: '' } }, 'admin')).json().settings.webSearch.fallbackModel, '');
  const saved = await request('PUT', '/api/admin/agent', { webSearch: { providerId: 'google', model: 'gemini-3.1-flash-lite' } }, 'admin');
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().settings.webSearch.model, 'gemini-3.1-flash-lite');
  const status = (await request('GET', '/api/admin/agent', undefined, 'admin')).json().webSearch;
  assert.equal(status.activeProviderId, 'google');
  assert.equal(status.monthQueries, 10);
  assert.deepEqual(status.fallbackMcp, { name: 'Mock Brave', enabled: true });
  assert.deepEqual(status.providers.map((p) => p.id), ['google']);

  // Per-turn defaults are backfilled for old installations and admin validated.
  assert.equal(getAgentSettings().webSearch.allowVertexAgentTools, false);
  assert.equal(getAgentSettings().webSearch.fastMaxPerTurn, 1);
  for (const field of ['maxPerTurn', 'fetchMaxPerTurn', 'fastMaxPerTurn', 'fastFetchMaxPerTurn']) {
    for (const value of [-1, 21, 1.5]) assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { [field]: value } }, 'admin')).statusCode, 400);
  }
  saveAgentSettings({ webSearch: { model: 'gemini-3.5-flash-lite', monthlyLimit: 0, dailyLimit: 0, adminDailyLimit: 0 } });
  for (const [id, modelId] of [['legacy', 'gemini-2.5-pro'], ['prefixed', 'google/gemini-3.8-flash']]) {
    db.insert(schema.models).values({ id, modelId, providerId: 'google', tools: 1, createdAt: Date.now() }).run();
    await turn(id);
    assert.equal(chatRequests[0].webSearch, true, modelId);
    assert(!chatRequests[0].tools?.some((t) => ['web_search', 'web_fetch'].includes(t.name)), modelId);
  }
  saveAgentSettings({ workspace: { enabled: true } });
  await turn('legacy');
  assert.equal(chatRequests[0].webSearch, false, '2.5 never mixes native search with functions');
  assert(!offeredSearch(), 'incompatible native search must not silently enable Agent search');
  const enabled = await request('PUT', '/api/admin/agent', { webSearch: { allowVertexAgentTools: true } }, 'admin');
  assert.equal(enabled.statusCode, 200);
  await turn('legacy');
  assert(offeredSearch() && chatRequests[0].tools.some((t) => t.name === 'web_fetch'), 'explicit opt-in restores the Agent fallback');
  await turn('gem');
  assert(chatRequests[0].webSearch && !offeredSearch());
  assert(chatRequests[0].tools.some((t) => t.name === 'web_fetch'), 'explicit opt-in restores the reader');
  saveAgentSettings({ workspace: { enabled: false }, webSearch: { allowVertexAgentTools: false } });

  // A Vertex model remembering hidden tools cannot execute them anyway.
  gemini.streamChat = async function* (cfg, req) {
    if (req.model === 'gemini-3.5-flash-lite') { yield* searchStub(cfg, req); return; }
    chatRequests.push(req);
    if (chatRequests.length === 1) {
      yield { type: 'tool_call', id: 'forbidden-search', name: 'web_search', args: '{"query":"q"}' };
      yield { type: 'tool_call', id: 'forbidden-fetch', name: 'web_fetch', args: '{"url":"https://example.com/"}' };
      yield { type: 'stop', reason: 'tool_calls' }; return;
    }
    yield { type: 'text', text: '用已有资料回答' };
    yield { type: 'stop', reason: 'stop' };
  };
  const forbidden = await turn('gem');
  assert(forbidden.results.every((r) => r.isError && r.result.includes('Vertex')));
  assert.equal(searchRequests.length, 0);
  gemini.streamChat = searchStub;

  const PAGE = 'https://news.example/fact';
  primeFetchCache(PAGE, { url: PAGE, title: 'Fact', text: 'Fixture fact. '.repeat(30) });
  let plans = [];
  openai.streamChat = async function* (_cfg, req) {
    chatRequests.push(req);
    const batch = plans.shift();
    if (batch) {
      for (const [i, call] of batch.entries()) yield { type: 'tool_call', id: `planned-${chatRequests.length}-${i}`, name: call[0], args: JSON.stringify(call[1]) };
      yield { type: 'stop', reason: 'tool_calls' }; return;
    }
    yield { type: 'text', text: '根据已有资料完成回答' };
    yield { type: 'stop', reason: 'stop' };
  };
  const searchCall = (query) => ['web_search', { query }];
  const fetchCall = (url = PAGE, extra = {}) => ['web_fetch', { url, ...extra }];
  const batch = [searchCall('first'), searchCall('second'), fetchCall(), fetchCall(PAGE, { offset: 0 })];
  for (const user of ['alice', 'admin']) {
    plans = [batch];
    const limited = await turn('gpt', user, 'off');
    assert.deepEqual(limited.results.map((r) => r.isError), [false, true, false, true]);
    assert.equal(searchRequests.length, 1);
    assert(limited.results[1].result.includes('本轮搜索已达上限'));
    assert(!chatRequests[1].tools.some((t) => ['web_search', 'web_fetch'].includes(t.name)), 'exhausted tools are removed');
  }
  // Thinking has its own allowance, without affecting the no-thinking defaults.
  db.update(schema.models).set({ reasoningMode: 'custom', reasoningLevels: '[{"value":"low"},{"value":"high"}]' }).where(eq(schema.models.id, 'gpt')).run();
  plans = [batch];
  const thinking = await turn('gpt', 'alice', 'high');
  assert(thinking.results.every((r) => !r.isError));
  assert.equal(searchRequests.length, 2);
  assert(!chatRequests[1].tools.some((t) => ['web_search', 'web_fetch'].includes(t.name)));

  // Repeat queries and fragment/focus variations use the existing result.
  plans = [[searchCall('Same   Query'), searchCall(' same query '), fetchCall(), fetchCall(`${PAGE}#details`, { focus: 'new wording' })]];
  const reused = await turn('gpt', 'alice', 'high');
  assert.equal(searchRequests.length, 1);
  assert(reused.results[1].result.includes('复用结果'));
  assert(reused.results[3].result.includes('复用结果'));
  assert.equal(db.select().from(schema.usageLog).where(and(eq(schema.usageLog.chatId, reused.id), eq(schema.usageLog.kind, 'web_fetch'))).all().length, 1);

  // Both tools can be disabled for fast turns without disabling thinking turns.
  saveAgentSettings({ webSearch: { fastMaxPerTurn: 0, fastFetchMaxPerTurn: 0 } });
  plans = [batch];
  const zero = await turn();
  assert(zero.results.every((r) => r.isError));
  assert.equal(searchRequests.length, 0);
  assert(!chatRequests[0].tools?.some((t) => ['web_search', 'web_fetch'].includes(t.name)));
  saveAgentSettings({ webSearch: { fastMaxPerTurn: 1, fastFetchMaxPerTurn: 1 } });

  // Reservations are synchronous even when multiple calls are scheduled together.
  const parallelBudget = new WebToolBudget(getAgentSettings().webSearch, false);
  const parallel = await Promise.all(['one', 'two'].map((query) => runWebSearch({ ...ctx(admin), budget: parallelBudget }, JSON.stringify({ query }))));
  assert.deepEqual(parallel.map((r) => r.isError), [false, true]);

  // Subagents share the parent's allowance; switching models cannot reset it.
  const sharedBudget = new WebToolBudget(getAgentSettings().webSearch, false);
  await runWebSearch({ ...ctx(admin), budget: sharedBudget }, '{"query":"parent"}');
  await runWebFetch({ ...ctx(admin), budget: sharedBudget }, JSON.stringify({ url: PAGE }));
  let subRequests = [];
  const subDeps = {
    user: admin, chatId: thinking.id, projectId: null, parentMessageId: 'sub-fixture',
    cfg: { id: 'fixture', type: 'openai', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {} },
    model: db.select().from(schema.models).where(eq(schema.models.id, 'gpt')).get(),
    provider: db.select().from(schema.providers).where(eq(schema.providers.id, 'chat')).get(),
    reasoning: { level: 'high', ratio: 1 }, secretValues: [], signal: new AbortController().signal,
    webToolBudget: sharedBudget, askConfirm: async () => new Map(), onProgress() {}, consumeOutput() {},
    adapter: { async *streamChat(_cfg, req) {
      subRequests.push(req);
      if (subRequests.length === 1) {
        yield { type: 'tool_call', id: 'sub-search', name: 'web_search', args: '{"query":"sub"}' };
        yield { type: 'tool_call', id: 'sub-fetch', name: 'web_fetch', args: JSON.stringify({ url: PAGE }) };
        yield { type: 'stop', reason: 'tool_calls' }; return;
      }
      yield { type: 'text', text: '已有资料的结论' }; yield { type: 'stop', reason: 'stop' };
    } },
  };
  const beforeSub = searchRequests.length;
  const sub = await runSubagent(subDeps, '查询事实');
  assert.equal(sub.stopped, 'done');
  assert.equal(searchRequests.length, beforeSub);
  assert(!subRequests[0].tools.some((t) => ['web_search', 'web_fetch'].includes(t.name)));
  assert(subRequests[1].messages.at(-1).parts.filter((p) => p.type === 'tool_result').every((r) => r.isError && r.result.includes('本轮')));
  // Native Vertex subagents retain native search and its citations, without Agent tools.
  subRequests = [];
  const vertexSub = await runSubagent({ ...subDeps,
    model: db.select().from(schema.models).where(eq(schema.models.id, 'gem')).get(),
    provider: db.select().from(schema.providers).where(eq(schema.providers.id, 'google')).get(),
    adapter: { async *streamChat(_cfg, req) {
      subRequests.push(req);
      yield { type: 'text', text: '原生搜索结论' };
      yield { type: 'grounding', grounding: { queries: ['q'], sources: [SOURCE] } };
      yield { type: 'stop', reason: 'stop' };
    } },
  }, '查询事实');
  assert.equal(subRequests[0].webSearch, true);
  assert(!subRequests[0].tools.some((t) => ['web_search', 'web_fetch'].includes(t.name)));
  assert(vertexSub.text.includes(SOURCE.uri));
  subRequests = [];
  await runSubagent({ ...subDeps, webToolBudget: new WebToolBudget(getAgentSettings().webSearch, true), allowAgentWebTools: false }, '查询事实');
  assert(!subRequests[0].tools.some((t) => ['web_search', 'web_fetch'].includes(t.name)), 'a different subagent model cannot bypass its Vertex parent policy');
  assert.equal(searchRequests.length, beforeSub);

  console.log('PASS: web_search offered without a switch, Google-grounded search model, sources + grounding part, native Gemini preserved, 智能工具/policy/month/day gates (admin cap too), fallback model + cooldown + MCP last resort, failures as tool errors, Vertex opt-in, per-turn caps, deduplication, shared subagent budgets and admin validation.');
} finally {
  openai.streamChat = originals.openai;
  gemini.streamChat = originals.gemini;
  await app.close(); rawDb.close(); fs.rmSync(temp, { recursive: true, force: true });
}
process.exit(0); // the mock MCP child would keep the loop alive
