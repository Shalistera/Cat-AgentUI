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
const { saveAgentSettings } = await import('../server/dist/agent-settings.js');
const { monthlySearchQueries, resetSearchCooldowns, runWebSearch } = await import('../server/dist/web-search.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { authRoutes } = await import('../server/dist/routes/auth.js');
const { agentRoutes } = await import('../server/dist/routes/agent.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { getAdapter } = await import('../server/dist/providers/index.js');
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
async function turn(modelId = 'gpt', user = 'alice') {
  chatRequests = []; searchRequests = [];
  const created = await request('POST', '/api/chats', { modelId }, user);
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().chat.id;
  const res = await request('POST', `/api/chats/${id}/stream`, { modelId, content: [{ type: 'text', text: 'Node.js 最新 LTS 是哪个版本?' }] }, user);
  assert.equal(res.statusCode, 200, res.body);
  const events = [...res.body.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  return { events, results: events.filter((e) => e.type === 'tool_result').map((e) => e.data), grounding: events.find((e) => e.type === 'grounding')?.data };
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
  assert(chatRequests[0].system.includes(`今天是 ${today()}`) && chatRequests[0].system.includes('联网搜索'));
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
  assert(!(chatRequests[0].system ?? '').includes('联网搜索'));
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

  // Grounded without sources and no MCP: one more try on the same line.
  resetSearchCooldowns();
  let attempts = 0;
  gemini.streamChat = async function* () {
    attempts++;
    yield { type: 'text', text: '- 要点' };
    yield { type: 'grounding', grounding: { queries: ['q'], sources: attempts === 1 ? [] : [SOURCE] } };
    yield { type: 'stop', reason: 'stop' };
  };
  const retried = await runWebSearch(ctx(admin), JSON.stringify({ query: 'x' }));
  assert.equal(attempts, 2);
  assert.equal(retried.sources[0].uri, SOURCE.uri);
  assert(retried.result.includes(`[1] nodejs.org — ${SOURCE.uri}`));

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
  // Google answers without sources: the MCP's links ride along, labelled as such.
  saveAgentSettings({ webSearch: { monthlyLimit: 0 } });
  resetSearchCooldowns();
  gemini.streamChat = async function* () {
    yield { type: 'text', text: '- 无来源的要点' };
    yield { type: 'grounding', grounding: { queries: ['q'], sources: [] } };
    yield { type: 'stop', reason: 'stop' };
  };
  const patched = await runWebSearch(ctx(admin), JSON.stringify({ query: '黑猫' }));
  assert.equal(patched.label, 'Google 搜索');
  assert(patched.result.includes('Google 这次没有返回来源链接') && patched.result.includes('https://example.com/cat-news'));
  assert.equal(patched.sources[0].uri, 'https://example.com/cat-news');
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
  assert.equal(status.monthQueries, 11);
  assert.deepEqual(status.fallbackMcp, { name: 'Mock Brave', enabled: true });
  assert.deepEqual(status.providers.map((p) => p.id), ['google']);

  console.log('PASS: web_search offered without a switch, Google-grounded search model, sources + grounding part, native Gemini preserved, 智能工具/policy/month/day gates (admin cap too), fallback model + cooldown + MCP last resort, failures as tool errors, admin validation.');
} finally {
  openai.streamChat = originals.openai;
  gemini.streamChat = originals.gemini;
  await app.close(); rawDb.close(); fs.rmSync(temp, { recursive: true, force: true });
}
process.exit(0); // the mock MCP child would keep the loop alive
