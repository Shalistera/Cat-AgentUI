// Real auth/routes + SQLite with a fake adapter; never calls a model provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-project-library-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'project-library-regression';
process.env.PROJECT_INJECT_MAX_CHARS = '0';
const { db, rawDb, schema, runMigrations, setSetting } = await import('../server/dist/db/index.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { projectRoutes } = await import('../server/dist/routes/projects.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { getAdapter, toRuntimeConfig } = await import('../server/dist/providers/index.js');
const { ProjectLibrarySession, LIBRARY_SEARCH, LIBRARY_READ } = await import('../server/dist/project-library.js');
const docRef = (id) => id.replace(/-/g, '');
const { runSubagent } = await import('../server/dist/subagent.js');
const adapter = getAdapter('anthropic');
const originalStream = adapter.streamChat;
const openaiAdapter = getAdapter('openai');
const originalOpenaiStream = openaiAdapter.streamChat;
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.code(e.message === 'forbidden' ? 403 : e.message === 'unauthorized' ? 401 : 500).send({ error: e.message }));
const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const ok = (r) => { assert.equal(r.statusCode, 200, r.body); return r.json(); };
const project = async (name, options = {}, user = 'alice') => ok(await request('POST', '/api/projects', { name, ...options }, user)).project;
const chat = async (projectId = null, modelId = 'model') => {
  const c = ok(await request('POST', '/api/chats', { projectId, modelId })).chat;
  ok(await request('PATCH', `/api/chats/${c.id}`, { title: 'Fixture' }));
  return c.id;
};
const addDoc = async (p, name, content, user = 'alice') => ok(await request('POST', `/api/projects/${p.id}/docs`, { name, content }, user)).doc;
const call = (session, name, args) => session.call(name, JSON.stringify(args));
const results = (req) => req.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result');
const offered = (req) => req.tools?.some((t) => t.name === LIBRARY_SEARCH) ?? false;
let step = async () => ({ text: 'Done' });
adapter.streamChat = async function* (_cfg, req) {
  const result = await step(req);
  if (result.call) {
    yield { type: 'tool_call', id: randomUUID(), name: result.call, args: JSON.stringify(result.args ?? {}) };
    yield { type: 'stop', reason: 'tool_calls' };
  } else {
    yield { type: 'text', text: result.text ?? 'Done' };
    yield { type: 'stop', reason: 'stop' };
  }
};
openaiAdapter.streamChat = adapter.streamChat;
const turn = async (id, text, extra = {}) => {
  const r = await request('POST', `/api/chats/${id}/stream`, { content: [{ type: 'text', text }], ...extra });
  assert.equal(r.statusCode, 200, r.body);
  assert(!r.body.includes('event: error'), r.body);
  return r;
};
try {
  runMigrations();
  for (const user of ['alice', 'bob', 'admin']) {
    db.insert(schema.users).values({ id: user, username: user, passwordHash: 'unused', role: user === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: user, tokenHash: sha256hex(`${user}-session`), createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'provider', type: 'anthropic', name: 'Fixture', createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'model', providerId: 'provider', modelId: 'fixture', tools: 1, createdAt: Date.now() }).run();
  db.insert(schema.providers).values({ id: 'openai-provider', type: 'openai', name: 'OpenAI fixture', createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'openai-model', providerId: 'openai-provider', modelId: 'fixture', tools: 1, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  await app.register(cookie);
  await authPlugin(app);
  await projectRoutes(app);
  await chatRoutes(app);
  const travel = await project('差旅政策');
  assert.equal(travel.crossProjectSearch, false);
  const other = await project('合同政策', { crossProjectSearch: true });
  const off = await project('未开放资料');
  const secret = await project('私密资料', { crossProjectSearch: true }, 'bob');
  const shared = await project('共享资料', { crossProjectSearch: true }, 'bob');
  const doc = await addDoc(travel, '费用.md', '报销规定:差旅费上限300元。\n' + '其余章节不需要整篇加载。'.repeat(2500));
  await addDoc(other, '费用.md', '报销规定:合同费用上限500元。');
  await addDoc(off, '不公开.md', '报销规定:OFF_ONLY_SECRET');
  await addDoc(secret, '私密.md', '报销规定:PRIVATE_ONLY_SECRET', 'bob');
  const sharedDoc = await addDoc(shared, '共享.md', '报销规定:SHARED_EVIDENCE', 'bob');
  ok(await request('PUT', `/api/projects/${shared.id}/sharing`, { accessMode: 'restricted', members: [{ userId: 'alice', role: 'viewer' }] }, 'bob'));
  assert.equal((await request('PATCH', `/api/projects/${shared.id}`, { crossProjectSearch: false })).statusCode, 403);
  assert.equal((await request('PATCH', `/api/projects/${travel.id}`, { crossProjectSearch: 'true' })).statusCode, 400);
  ok(await request('PATCH', `/api/projects/${travel.id}`, { crossProjectSearch: true }));

  const sourceCorrection = '并非联网搜索，他在本面板的某个项目内 是一个参考资料，';
  const panelSearch = '面板调用测试，我要求你看看你是否可以检索到辽金信交〔2025〕932 号的信息，它在一个项目内';
  const usageQuestion = '关于面板的使用方法中有没有搜索项目资料的方式？';
  // Tool availability is permission-based and independent of user wording.
  // Natural-language decisions belong to the model, not this regression stub.
  const make = (current = null, user = 'alice') => new ProjectLibrarySession(user, current);
  const session = make();
  assert(session.available);
  const unread = call(session, LIBRARY_READ, { project_id: travel.id, ref: docRef(doc.id) });
  assert(unread.isError, 'read requires a surfaced search hit');
  const found = call(session, LIBRARY_SEARCH, { query: '报销规定', limit: 8 });
  assert.equal(found.isError, false);
  assert(found.result.includes('300元') && found.result.includes('500元') && found.result.includes('SHARED_EVIDENCE'));
  assert(!found.result.includes('OFF_ONLY_SECRET') && !found.result.includes('PRIVATE_ONLY_SECRET'));
  assert(found.result.length < 12500, 'cross-project output stays bounded');
  const read = call(session, LIBRARY_READ, { project_id: travel.id, ref: docRef(doc.id), max_chars: 80 });
  assert(!read.isError && read.result.includes('300元') && read.result.length < 250);
  assert(call(session, LIBRARY_SEARCH, { query: '报销规定', limit: 8 }).result.includes('本轮已返回'));
  assert(!call(session.fork(), LIBRARY_SEARCH, { query: '报销规定', limit: 8 }).result.includes('本轮已返回'), 'child contexts retrieve independently');
  assert(call(session.fork(), LIBRARY_READ, { project_id: travel.id, ref: docRef(doc.id) }).isError);
  const named = make();
  assert(!call(named, LIBRARY_SEARCH, { query: '报销规定', project_name: '差旅政策' }).result.includes('500元'));
  assert(call(named, LIBRARY_SEARCH, { query: '报销规定', project_id: off.id }).isError);
  assert(call(named, LIBRARY_SEARCH, { query: '报销规定', project_name: '未开放资料' }).isError);
  assert(call(named, LIBRARY_SEARCH, { query: '报销规定', project_id: secret.id }).isError);
  assert(!call(make(travel.id), LIBRARY_SEARCH, { query: '报销规定', limit: 8 }).result.includes('300元'));
  assert(!call(make(null, 'admin'), LIBRARY_SEARCH, { query: '报销规定' }).result.includes('PRIVATE_ONLY_SECRET'));
  ok(await request('PATCH', `/api/projects/${travel.id}`, { crossProjectSearch: false }));
  assert(call(session, LIBRARY_READ, { project_id: travel.id, ref: docRef(doc.id) }).isError, 'setting revocation applies immediately');
  ok(await request('PATCH', `/api/projects/${travel.id}`, { crossProjectSearch: true }));
  ok(await request('PUT', `/api/projects/${shared.id}/sharing`, { accessMode: 'private', members: [] }, 'bob'));
  assert(call(session, LIBRARY_READ, { project_id: shared.id, ref: docRef(sharedDoc.id) }).isError, 'membership revocation applies immediately');
  const resolved = ok(await request('GET', `/api/project-docs/${docRef(doc.id)}`));
  assert.equal(resolved.doc.projectId, travel.id);
  assert.equal((await request('GET', `/api/project-docs/${docRef(doc.id)}`, undefined, 'bob')).statusCode, 404);
  let revision = '';
  const evolving = new ProjectLibrarySession('alice', null, () => revision);
  const child = evolving.fork();
  assert(child.available);
  revision = 'new-human-input';
  assert(!child.available && call(child, LIBRARY_SEARCH, { query: '报销规定' }).isError);
  assert(!evolving.available && call(evolving, LIBRARY_READ, { project_id: travel.id, ref: docRef(doc.id) }).isError);
  evolving.beginRound();
  assert(evolving.available && !child.available, 'the parent replans; existing child tasks retain their original input revision');
  assert(evolving.fork().available);

  // Ordinary turns receive tool descriptions and conditional usage guidance,
  // with no automatic document retrieval. The stub models a no-search reply.
  const ordinaryChat = await chat();
  step = async (req) => {
    assert(offered(req));
    assert(!req.system?.includes('300元') && !req.system?.includes('其余章节'));
    assert(req.system.includes('普通聊天、仅提到项目、询问功能用法'));
    assert(!results(req).length);
    return { text: 'No outside retrieval requested.' };
  };
  await turn(ordinaryChat, '你好');
  const explicitChat = await chat();
  let inspected = 0;
  step = async (req) => {
    assert(offered(req));
    assert(!req.system?.includes('300元') && !req.system?.includes('其余章节'));
    const r = results(req);
    if (!r.length) return { call: LIBRARY_SEARCH, args: { query: '报销规定', project_name: '差旅政策' } };
    if (r.length === 1) {
      assert(r[0].result.includes('300元'));
      return { call: LIBRARY_READ, args: { project_id: travel.id, ref: docRef(doc.id), max_chars: 80 } };
    }
    assert(r.at(-1).result.includes('300元')); inspected++;
    return { text: `上限300元[费用.md](doc:${docRef(doc.id)})` };
  };
  await turn(explicitChat, '搜索项目资料中的报销规定');
  assert.equal(inspected, 1);
  const before = ok(await request('GET', `/api/chats/${explicitChat}`));
  const answer = before.messages.findLast((m) => m.role === 'assistant');
  const userMessage = before.messages.findLast((m) => m.role === 'user');
  const regenerate = await request('POST', `/api/chats/${explicitChat}/stream`, { regenerateMessageId: answer.id });
  assert.equal(regenerate.statusCode, 200, regenerate.body);
  assert(!regenerate.body.includes('event: error'), regenerate.body);
  assert.equal(inspected, 2, 'regeneration uses its actual user parent');
  step = async (req) => { assert(offered(req)); return { text: 'No search needed for this follow-up.' }; };
  await turn(explicitChat, '继续解释');
  await turn(explicitChat, '只回答你好', { editMessageId: userMessage.id });

  // Both adapters get the same tools for colloquial requests and source
  // corrections. Execute real search/read calls against the fixture database;
  // this verifies wiring, not the language understanding of a live provider.
  await addDoc(travel, '辽金信交〔2025〕932号.md', '辽金信交〔2025〕932号:NOTICE_FIXTURE');
  const naturalRequests = [
    panelSearch,
    '我有个辽金信交〔2025〕932号资料在某个项目里，你连那个资料看了后一起总结',
    '项目里放过那份932号通知，帮我看看',
    '上次存的932号文件在一个项目里，结合那份材料一起分析下',
    'There is a 932 notice in one of my projects. Take a look and include it in the summary.',
  ];
  for (const modelId of ['model', 'openai-model']) {
    for (const text of naturalRequests) {
      const panelChat = await chat(null, modelId);
      let panelRound = 0;
      step = async (req) => {
        assert(offered(req), `${modelId}: ${text}`);
        assert(req.system.includes('独立于联网搜索和当前工作区'));
        assert(req.system.includes('无需固定关键词、句式或再次确认'));
        assert(!req.system.includes('NOTICE_FIXTURE'));
        if (panelRound++ === 0) return { call: LIBRARY_SEARCH, args: { query: '辽金信交 932' } };
        assert(results(req).at(-1).result.includes('NOTICE_FIXTURE'));
        if (panelRound === 2) {
          const ref = results(req).at(-1).result.match(/ref ([a-f0-9]{32})/)[1];
          return { call: LIBRARY_READ, args: { project_id: travel.id, ref, max_chars: 100 } };
        }
        return { text: 'Found and read the project reference.' };
      };
      await turn(panelChat, text);
      step = async (req) => { assert(offered(req)); return { text: 'Project source confirmed.' }; };
      await turn(panelChat, sourceCorrection);
      const correctionMessages = ok(await request('GET', `/api/chats/${panelChat}`)).messages;
      const correctionAnswer = correctionMessages.findLast((m) => m.role === 'assistant');
      const correctionUser = correctionMessages.findLast((m) => m.role === 'user');
      const correctionRegenerate = await request('POST', `/api/chats/${panelChat}/stream`, { regenerateMessageId: correctionAnswer.id });
      assert.equal(correctionRegenerate.statusCode, 200, correctionRegenerate.body);
      assert(!correctionRegenerate.body.includes('event: error'), correctionRegenerate.body);
      step = async (req) => {
        assert(offered(req));
        assert(req.system.includes('允许跨项目检索资料'));
        assert(!req.system.includes('NOTICE_FIXTURE'));
        return { text: 'Explain the project settings without retrieving documents.' };
      };
      await turn(panelChat, usageQuestion);
      await turn(panelChat, '继续解释', { editMessageId: correctionUser.id });
    }
  }
  const currentChat = await chat(travel.id);
  step = async (req) => { assert(offered(req)); assert(req.tools.some((t) => t.name === 'project_search')); return { text: 'Local project tools still work.' }; };
  await turn(currentChat, '介绍一下报销规定');
  step = async (req) => { assert(offered(req)); return { text: 'Other project references available.' }; };
  await turn(currentChat, '搜索其他项目的报销资料');
  step = async (req) => {
    assert(!offered(req));
    assert(!req.system?.includes('300元'));
    return { text: 'No library tools.' };
  };
  db.update(schema.models).set({ tools: 0 }).where(eq(schema.models.id, 'model')).run();
  await turn(ordinaryChat, '搜索项目资料中的报销规定');
  db.update(schema.models).set({ tools: 1 }).where(eq(schema.models.id, 'model')).run();
  db.update(schema.users).set({ settings: JSON.stringify({ agentTools: false }) }).where(eq(schema.users.id, 'alice')).run();
  await turn(ordinaryChat, '搜索项目资料中的报销规定');
  db.update(schema.users).set({ settings: '{}' }).where(eq(schema.users.id, 'alice')).run();
  // Any pending user input blocks an in-flight retrieval until the model has
  // received it. The stub then follows the user's cancellation.
  const revokeChat = await chat();
  const revokeRequestId = randomUUID();
  let revokeStep = 0;
  step = async (req) => {
    if (revokeStep++ === 0) {
      assert(offered(req));
      ok(await request('POST', `/api/chats/${revokeChat}/interject`, { requestId: revokeRequestId, text: '不要搜索项目资料' }));
      return { call: LIBRARY_SEARCH, args: { query: '报销规定' } };
    }
    assert(offered(req));
    assert(results(req).at(-1).isError);
    assert(req.messages.some((m) => m.interjection === '不要搜索项目资料'));
    return { text: 'Search cancelled.' };
  };
  await turn(revokeChat, '搜索项目资料中的报销规定', { requestId: revokeRequestId });
  step = async (req) => { assert(offered(req)); return { text: 'Use the latest human request to decide whether to retrieve.' }; };
  await turn(revokeChat, sourceCorrection);
  // A new request can use the already advertised tools after the latest
  // human input is delivered, without language-based capability filtering.
  const addChat = await chat(), addRequestId = randomUUID();
  let addStep = 0;
  step = async (req) => {
    if (addStep++ === 0) {
      assert(offered(req));
      ok(await request('POST', `/api/chats/${addChat}/interject`, { requestId: addRequestId, text: '搜索项目资料中的报销规定' }));
      return { text: 'Received the added request.' };
    }
    assert(offered(req));
    if (!results(req).length) return { call: LIBRARY_SEARCH, args: { query: '报销规定', project_id: travel.id } };
    assert(results(req).at(-1).result.includes('300元'));
    return { text: 'Found the reference.' };
  };
  await turn(addChat, '你好', { requestId: addRequestId });

  // With every accessible outside project switched off, neither descriptions
  // nor forced calls can expose documents. The prompt explains the setting.
  for (const p of [travel, other]) ok(await request('PATCH', `/api/projects/${p.id}`, { crossProjectSearch: false }));
  assert(!session.available && call(session, LIBRARY_SEARCH, { query: '报销规定' }).isError);
  const disabledChat = await chat();
  step = async (req) => {
    assert(!offered(req));
    assert(req.system.includes('当前没有可供本对话跨项目检索的已开放项目'));
    if (!results(req).length) return { call: LIBRARY_SEARCH, args: { query: '报销规定' } };
    assert(results(req).at(-1).isError && !results(req).at(-1).result.includes('300元'));
    return { text: 'Explain the project setting.' };
  };
  await turn(disabledChat, panelSearch);
  for (const p of [travel, other]) ok(await request('PATCH', `/api/projects/${p.id}`, { crossProjectSearch: true }));

  // Two projects can have document IDs sharing the old eight-character
  // handle. Full cross-project refs keep both reads and citation links exact.
  const collisionIds = ['12345678-0000-4000-8000-000000000001', '12345678-0000-4000-8000-000000000002'];
  for (const [i, p] of [travel, other].entries()) db.insert(schema.projectDocs).values({
    id: collisionIds[i], projectId: p.id, name: '同名资料.md', content: `collision-fixture version-${i}`, chars: 29, createdAt: Date.now(),
  }).run();
  const collisionSession = make();
  const collisionHits = call(collisionSession, LIBRARY_SEARCH, { query: 'collision-fixture' });
  for (const [i, p] of [travel, other].entries()) {
    assert(collisionHits.result.includes(docRef(collisionIds[i])));
    assert(call(collisionSession, LIBRARY_READ, { project_id: p.id, ref: docRef(collisionIds[i]) }).result.includes(`version-${i}`));
    assert.equal(ok(await request('GET', `/api/project-docs/${docRef(collisionIds[i])}`)).doc.id, collisionIds[i]);
  }

  // Child tasks inherit the parent's available library session, never obtain
  // a session from task text alone, and retrieve their own evidence.
  const user = db.select().from(schema.users).where(eq(schema.users.id, 'alice')).get();
  const provider = db.select().from(schema.providers).get(), model = db.select().from(schema.models).get();
  const deps = { user, chatId: ordinaryChat, projectId: null, parentMessageId: answer.id,
    adapter, cfg: toRuntimeConfig(provider), provider, model, secretValues: [], signal: new AbortController().signal,
    askConfirm: async () => new Map(), onProgress() {}, consumeOutput() {} };
  for (const allowed of [false, true]) {
    step = async (req) => {
      assert.equal(offered(req), allowed);
      const r = results(req);
      if (!r.length) return { call: LIBRARY_SEARCH, args: { query: '报销规定', project_name: '差旅政策' } };
      assert.equal(!!r.at(-1).isError, !allowed);
      return { text: r.at(-1).result };
    };
    const r = await runSubagent({ ...deps, projectLibrary: allowed ? session : undefined }, '搜索项目资料中的报销规定');
    assert.equal(r.stopped, 'done', r.error);
    assert.equal(r.text.includes('300元'), allowed);
  }
  console.log('Project library regression passed: owner settings, wording-independent tool availability on Anthropic/OpenAI paths, conditional retrieval guidance without automatic content injection, member/admin isolation, bounded search/read, live revocation, citations, deduplication, regeneration/editing, stale-call invalidation and independent subagents.');
} finally {
  adapter.streamChat = originalStream;
  openaiAdapter.streamChat = originalOpenaiStream;
  await app.close(); rawDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
