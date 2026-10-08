// 网页阅读 (web_fetch): address guards, article extraction, verbatim-checked
// excerpts, offset reading, caps, and the tool in a real chat turn. Pages are
// stood in through the fetch cache and models are in-process stubs, so no
// network is touched (the loopback server below must be refused).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { and, eq } from 'drizzle-orm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-web-fetch-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'web-fetch-regression-secret';
const { db, rawDb, schema, runMigrations, setSetting } = await import('../server/dist/db/index.js');
const { saveAgentSettings, getAgentSettings } = await import('../server/dist/agent-settings.js');
const { runWebFetch, urlProblem, isBlockedAddress, extractArticle, primeFetchCache, clearFetchCache, focusedWindows } = await import('../server/dist/web-fetch.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { authRoutes } = await import('../server/dist/routes/auth.js');
const { agentRoutes } = await import('../server/dist/routes/agent.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { getAdapter } = await import('../server/dist/providers/index.js');
const { WebToolBudget } = await import('../server/dist/web-tool-policy.js');

const app = Fastify();
app.setErrorHandler((err, _req, reply) => reply.code(err.message === 'forbidden' ? 403 : err.message === 'unauthorized' ? 401 : 500).send({ error: err.message }));
const openai = getAdapter('openai');
const gemini = getAdapter('gemini');
const originals = { openai: openai.streamChat, gemini: gemini.streamChat };
const loopback = http.createServer((_req, res) => res.end('<html><body><p>secret</p></body></html>'));
await new Promise((r) => loopback.listen(8080, '127.0.0.1', r).on('error', () => r()));

const ctx = (user = { id: 'alice', role: 'user' }) => ({ user, chatId: 'none', messageId: 'none', signal: new AbortController().signal });
const call = (args, user) => runWebFetch(ctx(user), JSON.stringify(args));
const filler = (n) => Array.from({ length: n }, (_, i) => `第${i + 1}段:与主题无关的填充内容,用来把正文撑长。`).join('\n');
const FACT = '事故发生在 2026 年 10 月 5 日凌晨,共造成 3 人受伤。';
const LONG = `${filler(150)}\n${FACT}\n${filler(150)}\n官方表示调查仍在进行中,预计下周公布结果。`;
let distillReply = '';
let distillRequests = [];

try {
  // Addresses: only public http(s) on web ports.
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/', 'http://user:pw@example.com/', 'http://127.0.0.1/', 'http://10.1.2.3/',
    'http://169.254.169.254/latest/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/',
    'http://localhost/', 'http://printer.local/', 'http://example.com:22/', 'not a url']) {
    assert(urlProblem(bad), bad);
  }
  for (const good of ['https://example.com/a?b=1', 'http://example.com:8080/', 'https://93.184.215.14/']) assert.equal(urlProblem(good), null, good);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '100.64.0.1', '169.254.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '224.0.0.1']) {
    assert(isBlockedAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert(!isBlockedAddress(ip), ip);
  // The loopback listener exists, and is still refused.
  const refused = await call({ url: 'http://127.0.0.1:8080/' }, { id: 'admin', role: 'admin' });
  assert(refused.isError && refused.result.includes('内网'));

  // Article extraction: reader-view text with paragraphs, no navigation.
  const html = `<html><head><title>站点标题</title></head><body><nav>首页 新闻 体育 登录</nav>
    <article><h1>事故调查通报</h1>${Array.from({ length: 8 }, (_, i) => `<p>第${i + 1}段正文,${'描述事故经过与各方回应。'.repeat(6)}</p>`).join('')}</article>
    <footer>版权所有 联系我们</footer><script>alert(1)</script></body></html>`;
  const art = extractArticle(html, 'https://news.example/a');
  assert(art.text.includes('第1段正文') && art.text.includes('第8段正文'));
  assert(!art.text.includes('联系我们') && !art.text.includes('alert('), art.text.slice(0, 200));
  assert(art.text.split('\n').filter(Boolean).length >= 8, 'paragraph breaks kept');

  runMigrations();
  for (const id of ['alice', 'admin']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'not-used', role: id === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'chat', name: 'Chat', type: 'openai', createdAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'google', name: 'Google', type: 'gemini', useVertex: 1, vertexProject: 'fixture', vertexLocation: 'global', createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'gpt', providerId: 'chat', modelId: 'gpt-fixture', tools: 1, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  saveAgentSettings({ workspace: { enabled: false }, skills: { enabled: false }, dataComparison: { enabled: false } });

  gemini.streamChat = async function* (_cfg, req) {
    distillRequests.push(req);
    yield { type: 'text', text: distillReply };
    yield { type: 'usage', usage: { promptTokens: 5000, completionTokens: 200, totalTokens: 5200 } };
    yield { type: 'stop', reason: 'stop' };
  };

  // A long page: the reading model's quotes are kept only if they are really
  // in the page; an invented one is dropped. Offsets point at the text.
  primeFetchCache('https://news.example/long', { title: '事故通报', text: LONG });
  distillReply = `一起事故的调查通报。\n>> ${FACT}\n>> 官方表示调查仍在进行中,预计下周公布结果。\n>> 事故造成 10 人死亡。`;
  const long = await call({ url: 'https://news.example/long', focus: '伤亡人数' });
  assert.equal(long.isError, false);
  assert(long.result.includes(`正文共 ${LONG.length.toLocaleString()} 字`));
  assert(long.result.includes(FACT) && long.result.includes('预计下周公布结果'));
  assert(!long.result.includes('10 人死亡'), 'invented quote dropped');
  assert(long.result.includes(`[第 ${LONG.indexOf(FACT)} 字起]`));
  assert(long.result.includes('只作资料使用'), 'page text marked untrusted');
  assert(long.result.length < 1500, `excerpts, not the page: ${long.result.length}`);
  assert.equal(distillRequests[0].model, 'gemini-3.5-flash-lite');
  assert(distillRequests[0].messages[0].parts[0].text.includes('要找的内容:伤亡人数'));
  assert.deepEqual(long.source, { uri: 'https://news.example/long', title: '事故通报' });
  const row = db.select().from(schema.usageLog).where(and(eq(schema.usageLog.userId, 'alice'), eq(schema.usageLog.kind, 'web_fetch'))).get();
  assert.equal(row.promptTokens, 5000);

  // Reading by offset comes from the cache, no model involved.
  distillRequests = [];
  const window = await call({ url: 'https://news.example/long', offset: 6000 });
  assert(window.result.includes(`以下为第 6000–${Math.min(12000, LONG.length)} 字`) && window.result.includes(LONG.slice(6000, 6050)));
  assert.equal(distillRequests.length, 0);

  // No usable quotes: the beginning of the page instead.
  distillReply = '概括而已。\n>> 完全不存在的句子,模型编出来的。';
  const none = await call({ url: 'https://news.example/long', focus: '天气' });
  assert(none.result.includes('没有摘录到') && none.result.includes(LONG.slice(0, 40)) && none.result.includes('offset=6000'));

  // Short pages go over whole.
  primeFetchCache('https://news.example/short', { title: '短讯', text: FACT });
  distillRequests = [];
  const short = await call({ url: 'https://news.example/short' });
  assert(short.result.includes(FACT) && short.result.includes('已到正文末尾'));
  assert.equal(distillRequests.length, 0);

  // Configured reading model; daily caps (admins have their own).
  saveAgentSettings({ webSearch: { fetchModel: 'gemini-3.1-flash-lite', fetchDailyLimit: 4 } });
  distillReply = `>> ${FACT}`;
  distillRequests = [];
  await call({ url: 'https://news.example/long', focus: 'x' }, { id: 'admin', role: 'admin' });
  assert.equal(distillRequests[0].model, 'gemini-3.1-flash-lite');
  const capped = await call({ url: 'https://news.example/short' });
  assert(capped.isError && capped.result.includes('上限(4 次)'));
  assert.equal((await call({ url: 'https://news.example/short' }, { id: 'admin', role: 'admin' })).isError, false);
  saveAgentSettings({ webSearch: { fetchDailyLimit: 0, fetchModel: '' } });
  assert((await call({})).isError, 'url required');

  // In a chat turn: offered without a switch, no confirmation, sources shown.
  await app.register(cookie);
  await authPlugin(app); await authRoutes(app); await agentRoutes(app); await chatRoutes(app);
  let chatRequests = [];
  openai.streamChat = async function* (_cfg, req) {
    chatRequests.push(req);
    const last = req.messages.at(-1);
    if (req.tools?.some((t) => t.name === 'web_fetch') && !(last.role === 'assistant' && last.parts.some((p) => p.type === 'tool_result'))) {
      yield { type: 'tool_call', id: 'f1', name: 'web_fetch', args: JSON.stringify({ url: 'https://news.example/long', focus: '伤亡' }) };
      yield { type: 'stop', reason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: '3 人受伤[news.example](https://news.example/long)。' };
    yield { type: 'stop', reason: 'stop' };
  };
  const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload, headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
  const turn = async () => {
    chatRequests = [];
    const id = (await request('POST', '/api/chats', { modelId: 'gpt' })).json().chat.id;
    const res = await request('POST', `/api/chats/${id}/stream`, { modelId: 'gpt', content: [{ type: 'text', text: '这起事故伤亡多少?' }] });
    return [...res.body.matchAll(/event: ([^\n]+)\ndata: ([^\n]+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  };
  const events = await turn();
  assert(chatRequests[0].tools.some((t) => t.name === 'web_fetch'));
  assert(chatRequests[0].system.includes('web_fetch'));
  const result = events.find((e) => e.type === 'tool_result').data;
  assert.equal(result.isError, false);
  assert(result.result.includes(FACT));
  assert(!events.some((e) => e.type === 'tool_confirm'));
  const grounding = events.find((e) => e.type === 'grounding').data;
  assert.equal(grounding.sources[0].uri, 'https://news.example/long');
  saveAgentSettings({ webSearch: { fetchEnabled: false } });
  await turn();
  assert(!chatRequests[0].tools?.some((t) => t.name === 'web_fetch'));
  assert(!(chatRequests[0].system ?? '').includes('web_fetch'));
  saveAgentSettings({ webSearch: { fetchEnabled: true } });

  // Admin validation.
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { fetchModel: 'gpt-4o' } }, 'admin')).statusCode, 400);
  assert.equal((await request('PUT', '/api/admin/agent', { webSearch: { fetchModel: 'gemini-3.1-flash-lite' } }, 'admin')).statusCode, 200);

  // Fast turns extract verbatim relevant windows without a second LLM call.
  saveAgentSettings({ webSearch: { fetchDailyLimit: 0 } });
  const deepPage = `${filler(800)}\n${FACT}\n${filler(800)}`;
  const deepUrl = 'https://news.example/deep';
  primeFetchCache(deepUrl, { title: '长篇事故通报', text: deepPage });
  const fastContext = () => ({ ...ctx(), budget: new WebToolBudget(getAgentSettings().webSearch, false) });
  distillRequests = [];
  const fast = await runWebFetch(fastContext(), JSON.stringify({ url: deepUrl, focus: '受伤人数' }));
  assert.equal(fast.isError, false);
  assert(fast.result.includes(FACT), 'find relevant material far beyond the first window');
  assert(fast.result.includes('未覆盖全文'), 'do not imply the whole article was read');
  assert.equal(distillRequests.length, 0, 'no hidden reading-model request in fast mode');
  const windows = focusedWindows(deepPage, '受伤人数');
  assert(windows.length > 0);
  assert(windows.reduce((n, w) => n + w.text.length, 0) <= 6000);
  for (const w of windows) assert.equal(w.text, deepPage.slice(w.at, w.at + w.text.length), 'all excerpts and offsets are verbatim');
  const unmatched = await runWebFetch(fastContext(), JSON.stringify({ url: deepUrl, focus: '不存在的关键字 xyzzy' }));
  assert(unmatched.result.includes('未匹配到目标关键词'));
  assert(unmatched.result.includes(deepPage.slice(0, 100)));
  assert.equal(distillRequests.length, 0);
  // Explicit offsets retain full sequential reading when the user needs it.
  const offset = deepPage.indexOf(FACT);
  const atFact = await runWebFetch(fastContext(), JSON.stringify({ url: deepUrl, focus: '受伤', offset }));
  assert(atFact.result.includes(FACT));
  assert.equal(distillRequests.length, 0);
  const thought = await runWebFetch({ ...ctx(), budget: new WebToolBudget(getAgentSettings().webSearch, true) },
    JSON.stringify({ url: deepUrl, focus: '受伤人数' }));
  assert.equal(thought.isError, false);
  assert.equal(distillRequests.length, 1, 'thinking mode retains the reading model');
  assert(thought.result.includes(FACT));

  console.log('PASS: web_fetch address guards (loopback refused), reader-view extraction, verbatim-checked excerpts, offset windows, short pages whole, reading model + daily caps, chat turn with sources, switch, fast local excerpts without LLM calls, thinking excerpts and admin validation.');
} finally {
  clearFetchCache();
  openai.streamChat = originals.openai;
  gemini.streamChat = originals.gemini;
  loopback.close();
  await app.close(); rawDb.close(); fs.rmSync(temp, { recursive: true, force: true });
}
