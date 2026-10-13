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
const { ProjectLibrarySession, projectLibraryIntent, LIBRARY_SEARCH, LIBRARY_READ } = await import('../server/dist/project-library.js');
const docRef = (id) => id.replace(/-/g, '');
const { runSubagent } = await import('../server/dist/subagent.js');
const adapter = getAdapter('anthropic');
const originalStream = adapter.streamChat;
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.code(e.message === 'forbidden' ? 403 : e.message === 'unauthorized' ? 401 : 500).send({ error: e.message }));
const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const ok = (r) => { assert.equal(r.statusCode, 200, r.body); return r.json(); };
const project = async (name, options = {}, user = 'alice') => ok(await request('POST', '/api/projects', { name, ...options }, user)).project;
const chat = async (projectId = null) => {
  const c = ok(await request('POST', '/api/chats', { projectId, modelId: 'model' })).chat;
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

  for (const text of ['搜索项目资料中的报销规定', '请去其他项目检索报销规定', '搜索项目资料中关于怎么报销的说明', '搜索项目资料中的工具定义', 'Search project references for reimbursement', '不要联网,请搜索项目资料']) {
    assert.equal(projectLibraryIntent(text)?.kind, 'search', text);
  }
  for (const text of ['报销规定是什么', '搜索网页上的报销规定', '继续', '请总结上次搜索项目资料的结果', '我之前让你搜索项目资料', "'Search project references'", '请翻译:搜索项目资料中的报销规定', '解释如何搜索项目资料', '项目资料可以搜索吗', '“搜索项目资料中的报销规定”', '> 搜索项目资料中的报销规定', '```\n搜索项目资料中的报销规定\n```']) {
    assert.equal(projectLibraryIntent(text), null, text);
  }
  for (const text of ['不要搜索项目资料', '别去其他项目检索', 'Stop searching project references', '先搜索项目资料,现在不要搜索了']) {
    assert.equal(projectLibraryIntent(text)?.kind, 'deny', text);
  }
  const make = (text, current = null, user = 'alice') => new ProjectLibrarySession(user, current, () => [text]);
  const ordinary = make('报销规定是什么');
  assert.equal(ordinary.available, false);
  assert.equal(call(ordinary, LIBRARY_SEARCH, { query: '报销规定' }).isError, true);
  const session = make('搜索项目资料中的报销规定');
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
  const named = make('请在「差旅政策」项目里搜索报销规定');
  assert(named.available);
  assert(!call(named, LIBRARY_SEARCH, { query: '报销规定' }).result.includes('500元'));
  assert(call(named, LIBRARY_SEARCH, { query: '报销规定', project_id: other.id }).isError);
  assert(!make('请在未开放资料项目里搜索报销规定').available);
  assert(!call(make('搜索项目资料中的报销规定', travel.id), LIBRARY_SEARCH, { query: '报销规定', limit: 8 }).result.includes('300元'));
  assert(!call(make('搜索项目资料中的报销规定', null, 'admin'), LIBRARY_SEARCH, { query: '报销规定' }).result.includes('PRIVATE_ONLY_SECRET'));
  ok(await request('PATCH', `/api/projects/${travel.id}`, { crossProjectSearch: false }));
  assert(call(session, LIBRARY_READ, { project_id: travel.id, ref: docRef(doc.id) }).isError, 'setting revocation applies immediately');
  ok(await request('PATCH', `/api/projects/${travel.id}`, { crossProjectSearch: true }));
  ok(await request('PUT', `/api/projects/${shared.id}/sharing`, { accessMode: 'private', members: [] }, 'bob'));
  assert(call(session, LIBRARY_READ, { project_id: shared.id, ref: docRef(sharedDoc.id) }).isError, 'membership revocation applies immediately');
  const resolved = ok(await request('GET', `/api/project-docs/${docRef(doc.id)}`));
  assert.equal(resolved.doc.projectId, travel.id);
  assert.equal((await request('GET', `/api/project-docs/${docRef(doc.id)}`, undefined, 'bob')).statusCode, 404);
  const messages = ['搜索项目资料中的报销规定'];
  const evolving = new ProjectLibrarySession('alice', null, () => messages);
  const child = evolving.fork();
  assert(child.available);
  messages.push('不要搜索项目资料');
  assert(!child.available && call(child, LIBRARY_SEARCH, { query: '报销规定' }).isError);

  // Actual model turns: no automatic exposure, explicit search + bounded read,
  // next-turn reset, regeneration/editing, and malicious unsupported tool calls.
  const ordinaryChat = await chat();
  step = async (req) => {
    assert(!offered(req));
    assert(!req.system?.includes('300元'));
    const r = results(req);
    if (!r.length) return { call: LIBRARY_SEARCH, args: { query: '报销规定' } };
    assert(r.at(-1).isError && !r.at(-1).result.includes('300元'));
    return { text: 'No outside retrieval.' };
  };
  await turn(ordinaryChat, '报销规定是什么');
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
  step = async (req) => { assert(!offered(req)); return { text: 'No search this turn.' }; };
  await turn(explicitChat, '继续解释');
  await turn(explicitChat, '只回答你好', { editMessageId: userMessage.id });
  const currentChat = await chat(travel.id);
  step = async (req) => { assert(!offered(req)); assert(req.tools.some((t) => t.name === 'project_search')); return { text: 'Local project tools still work.' }; };
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
  // Pending user revocation is enforced before the current model call executes.
  const revokeChat = await chat();
  const revokeRequestId = randomUUID();
  let revokeStep = 0;
  step = async (req) => {
    if (revokeStep++ === 0) {
      assert(offered(req));
      ok(await request('POST', `/api/chats/${revokeChat}/interject`, { requestId: revokeRequestId, text: '不要搜索项目资料' }));
      return { call: LIBRARY_SEARCH, args: { query: '报销规定' } };
    }
    assert(!offered(req));
    assert(results(req).at(-1).isError);
    return { text: 'Search cancelled.' };
  };
  await turn(revokeChat, '搜索项目资料中的报销规定', { requestId: revokeRequestId });
  // A new explicit interjection can enable retrieval within an initially
  // ordinary turn; the next model round receives the tools and instructions.
  const addChat = await chat(), addRequestId = randomUUID();
  let addStep = 0;
  step = async (req) => {
    if (addStep++ === 0) {
      assert(!offered(req));
      ok(await request('POST', `/api/chats/${addChat}/interject`, { requestId: addRequestId, text: '搜索项目资料中的报销规定' }));
      return { text: 'Received the added request.' };
    }
    assert(offered(req));
    if (!results(req).length) return { call: LIBRARY_SEARCH, args: { query: '报销规定', project_id: travel.id } };
    assert(results(req).at(-1).result.includes('300元'));
    return { text: 'Found the reference.' };
  };
  await turn(addChat, '你好', { requestId: addRequestId });

  // Two projects can have document IDs sharing the old eight-character
  // handle. Full cross-project refs keep both reads and citation links exact.
  const collisionIds = ['12345678-0000-4000-8000-000000000001', '12345678-0000-4000-8000-000000000002'];
  for (const [i, p] of [travel, other].entries()) db.insert(schema.projectDocs).values({
    id: collisionIds[i], projectId: p.id, name: '同名资料.md', content: `collision-fixture version-${i}`, chars: 29, createdAt: Date.now(),
  }).run();
  const collisionSession = make('搜索项目资料中的 collision-fixture');
  const collisionHits = call(collisionSession, LIBRARY_SEARCH, { query: 'collision-fixture' });
  for (const [i, p] of [travel, other].entries()) {
    assert(collisionHits.result.includes(docRef(collisionIds[i])));
    assert(call(collisionSession, LIBRARY_READ, { project_id: p.id, ref: docRef(collisionIds[i]) }).result.includes(`version-${i}`));
    assert.equal(ok(await request('GET', `/api/project-docs/${docRef(collisionIds[i])}`)).doc.id, collisionIds[i]);
  }

  // Model-authored child task text is not authority. Inherited grants work,
  // with independent search/read state, while no grant refuses forced calls.
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
  console.log('Project library regression passed: default/owner settings, explicit per-turn requests, quoted/negative requests, member/admin isolation, bounded cross-project search/read, live revocation, citations, deduplication, normal/project chats, regeneration/edit reset, pending interjection revocation and independent authorized subagents.');
} finally {
  adapter.streamChat = originalStream;
  await app.close(); rawDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
