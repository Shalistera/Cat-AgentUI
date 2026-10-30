// 翻译工坊 A/B 对比: real admin/translation routes + temporary SQLite + an
// in-process provider. No paid requests or writes to the running app's data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-translate-ab-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'translate-ab-regression-secret';
const { db, rawDb, schema, runMigrations, setSetting, getSetting } = await import('../server/dist/db/index.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { adminRoutes } = await import('../server/dist/routes/admin.js');
const { translateRoutes } = await import('../server/dist/routes/translate.js');
const { getAdapter } = await import('../server/dist/providers/index.js');
const app = Fastify();
app.setErrorHandler((err, _req, reply) => reply.code(err.message === 'forbidden' ? 403 : err.message === 'unauthorized' ? 401 : 500).send({ error: err.message }));
const adapter = getAdapter('openai');
const originalStream = adapter.streamChat;
let calls = [];
let failModel = null;
adapter.streamChat = async function* (_cfg, request) {
  calls.push({ model: request.model, reasoning: request.reasoning });
  if (failModel === request.model) throw new Error('fixture unavailable');
  yield { type: 'text', text: `译文-${request.model}` };
  yield { type: 'usage', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } };
};
const request = (method, url, payload, user = 'admin') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const save = (payload, user) => request('PUT', '/api/admin/settings', payload, user);
const entry = (modelId, mode, reasoningEffort = null) => ({ modelId, mode, reasoningEffort });
const abSettings = (patch = {}) => ({ enabled: true, rate: 100, a: entry('a', 'fast'), b: entry('b', 'think', 'xhigh'), ...patch });

function events(body) {
  return body.split('\n\n').filter((b) => b.startsWith('event:')).map((block) => {
    const [ev, data] = block.split('\n');
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
  });
}
async function translate(user = 'alice') {
  calls = [];
  const res = await request('POST', '/api/translate/stream', { text: 'hello world', source: 'en', target: 'zh-CN', mode: 'default', scene: '轻松口语' }, user);
  assert.equal(res.statusCode, 200, res.body);
  return events(res.body);
}
const trial = (id) => db.select().from(schema.translateAbTrials).where(eq(schema.translateAbTrials.id, id)).get();
const trialCount = () => db.select().from(schema.translateAbTrials).all().length;
const vote = (id, choice, user = 'alice') => request('POST', `/api/translate/ab/${id}/vote`, { choice }, user);

try {
  runMigrations();
  for (const id of ['admin', 'alice', 'bob']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'unused', role: id === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'p', name: 'Fixture', type: 'openai', createdAt: Date.now() }).run();
  for (const [id, modelId, extra] of [
    ['a', 'gpt-5-a', {}], ['b', 'gpt-5-b', { displayName: 'Model B', reasoningMode: 'custom', reasoningLevels: JSON.stringify([
      { value: 'low', label: '低' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '极高' },
    ]) }], ['plain', 'gpt-4o', {}], ['image', 'image', { imageGen: 1 }],
  ]) db.insert(schema.models).values({ id, providerId: 'p', modelId, ...extra, createdAt: Date.now() }).run();
  await app.register(cookie);
  await authPlugin(app);
  await adminRoutes(app);
  await translateRoutes(app);
  setSetting('translate_default_models', [entry('plain', 'fast')]);

  // ---- settings: defaults, validation, admin-only ----
  assert.deepEqual((await request('GET', '/api/admin/settings')).json().translateAb, { enabled: false, rate: 20, a: null, b: null });
  setSetting('brand', 'Before');
  for (const invalid of [
    abSettings({ b: null }), // enabled without both slots
    abSettings({ b: entry('a', 'think') }), // same model twice
    abSettings({ b: entry('image', 'fast') }), // not a text model
    abSettings({ b: entry('missing', 'fast') }),
    abSettings({ b: entry('plain', 'think', 'high') }), // no such tier
    abSettings({ rate: 0 }), abSettings({ rate: 101 }), abSettings({ rate: 12.5 }),
  ]) {
    const res = await save({ brand: 'After', translateAb: invalid });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(getSetting('brand', ''), 'Before', 'a rejected A/B config saves nothing');
  }
  assert.equal((await save({ translateAb: abSettings() }, 'alice')).statusCode, 403);
  assert.equal((await request('GET', '/api/admin/translate-ab/summary', undefined, 'alice')).statusCode, 403);
  assert.equal((await request('GET', '/api/admin/translate-ab/trials', undefined, 'alice')).statusCode, 403);
  assert.equal((await request('DELETE', '/api/admin/translate-ab/trials', undefined, 'alice')).statusCode, 403);
  // Disabled with an empty slot is a valid draft.
  let res = await save({ translateAb: { enabled: false, rate: 35, a: entry('a', 'fast'), b: null } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().translateAb, { enabled: false, rate: 35, a: entry('a', 'fast'), b: null });

  // ---- off: the ordinary chain, no A/B events ----
  let ev = await translate();
  assert.ok(!ev.some((e) => e.event === 'ab'));
  assert.deepEqual(calls.map((c) => c.model), ['gpt-4o']);

  // ---- on at 100%: both models, each with its own preset, shown blind ----
  res = await save({ translateAb: abSettings() });
  assert.equal(res.statusCode, 200, res.body);
  const sides = new Set();
  for (let i = 0; i < 24; i++) {
    ev = await translate();
    assert.equal(ev.find((e) => e.event === 'done').data.status, 'done');
    assert.ok(ev.some((e) => e.event === 'ab'));
    assert.deepEqual(calls.map((c) => c.model).sort(), ['gpt-5-a', 'gpt-5-b']);
    assert.deepEqual(calls.find((c) => c.model === 'gpt-5-a').reasoning, { level: 'off', ratio: 0 });
    assert.deepEqual(calls.find((c) => c.model === 'gpt-5-b').reasoning, { level: 'xhigh', ratio: 1 });
    const id = ev.find((e) => e.event === 'ab-ready').data.id;
    const row = trial(id);
    const firstText = ev.filter((e) => e.event === 'delta' && e.data.side === 0).map((e) => e.data.text).join('');
    assert.equal(firstText, row.swapped ? '译文-gpt-5-b' : '译文-gpt-5-a', 'side 0 is model b exactly when swapped');
    assert.equal(ev.filter((e) => e.event === 'usage').length, 2);
    for (const e of ev.filter((x) => x.event !== 'delta')) {
      assert.ok(!/gpt-5|Fixture/.test(JSON.stringify(e.data)), 'model identities never reach the page');
    }
    sides.add(row.swapped);
  }
  assert.deepEqual([...sides].sort(), [0, 1], 'both display orders occur');

  // The row exists before any vote, without the texts.
  ev = await translate();
  let id = ev.find((e) => e.event === 'ab-ready').data.id;
  let row = trial(id);
  assert.equal(row.vote, null);
  assert.equal(row.sourceText, null);
  assert.equal(row.outputA, null);
  assert.equal(row.labelB, 'Model B · Fixture');
  assert.equal(row.reasoningA, 'off');
  assert.equal(row.reasoningB, 'xhigh');
  assert.equal(row.tokensA, 8);
  assert.equal(row.sourceChars, 11);

  // ---- voting: positions map back to models; once; owner only ----
  assert.equal((await vote(id, 'first', 'bob')).statusCode, 404, 'someone else cannot vote');
  assert.equal((await vote(id, 'left')).statusCode, 400);
  res = await vote(id, 'first');
  assert.equal(res.statusCode, 200, res.body);
  row = trial(id);
  assert.equal(row.vote, row.swapped ? 'b' : 'a');
  assert.equal(row.sourceText, 'hello world');
  assert.equal(row.outputA, '译文-gpt-5-a');
  assert.equal(row.outputB, '译文-gpt-5-b');
  assert.equal(row.scene, '轻松口语');
  assert.ok(row.votedAt);
  assert.equal((await vote(id, 'second')).statusCode, 409);
  assert.equal(trial(id).vote, row.vote, 'a second vote changes nothing');

  ev = await translate();
  const second = ev.find((e) => e.event === 'ab-ready').data.id;
  assert.equal((await vote(second, 'second')).statusCode, 200);
  assert.equal(trial(second).vote, trial(second).swapped ? 'a' : 'b');
  ev = await translate();
  const tie = ev.find((e) => e.event === 'ab-ready').data.id;
  assert.equal((await vote(tie, 'tie')).statusCode, 200);
  assert.equal(trial(tie).vote, 'tie');

  // ---- admin: summary, list, detail ----
  const shown = trialCount();
  let summary = (await request('GET', '/api/admin/translate-ab/summary')).json().pairs;
  assert.equal(summary.length, 1);
  const pair = summary[0];
  assert.equal(pair.modelA, 'a');
  assert.equal(pair.modelB, 'b');
  assert.equal(pair.labelA, 'gpt-5-a · Fixture');
  assert.equal(pair.shown, shown);
  assert.equal(pair.voted, 3);
  assert.equal(pair.winsA + pair.winsB + pair.ties, 3);
  assert.equal(pair.ties, 1);
  assert.equal(pair.firstPicked, 1, 'the first-position pick counts once, whichever model it was');
  assert.equal(pair.avgTokensA, 8);
  let list = (await request('GET', '/api/admin/translate-ab/trials')).json();
  assert.equal(list.total, 3, 'voted only by default');
  assert.deepEqual(list.items.map((r) => r.id), [tie, second, id]);
  assert.equal(list.items[0].user.username, 'alice');
  assert.equal(list.items[0].preview, 'hello world');
  assert.equal((await request('GET', '/api/admin/translate-ab/trials?voted=0')).json().total, shown);
  assert.equal((await request('GET', '/api/admin/translate-ab/trials?a=a&b=plain')).json().total, 0);
  const detail = (await request('GET', `/api/admin/translate-ab/trials/${id}`)).json();
  assert.equal(detail.outputB, '译文-gpt-5-b');
  assert.equal(detail.user.username, 'alice');
  assert.equal((await request('GET', '/api/admin/translate-ab/trials/nope')).statusCode, 404);

  // ---- one side failing: the survivor becomes an ordinary translation ----
  const before = trialCount();
  failModel = 'gpt-5-b';
  ev = await translate();
  const voidEv = ev.find((e) => e.event === 'ab-void');
  assert.ok(voidEv);
  const kept = ev.filter((e) => e.event === 'delta' && e.data.side === voidEv.data.keep).map((e) => e.data.text).join('');
  assert.equal(kept, '译文-gpt-5-a');
  assert.ok(!ev.some((e) => e.event === 'ab-ready'));
  assert.ok(!ev.some((e) => e.event === 'error'));
  assert.equal(ev.find((e) => e.event === 'done').data.status, 'done');
  assert.equal(trialCount(), before, 'a void comparison is not recorded');
  // Both failing is an error.
  failModel = null;
  const failBoth = adapter.streamChat;
  adapter.streamChat = async function* () { throw new Error('fixture down'); };
  ev = await translate();
  assert.equal(ev.find((e) => e.event === 'done').data.status, 'error');
  assert.match(ev.find((e) => e.event === 'error').data.message, /fixture down/);
  adapter.streamChat = failBoth;

  // ---- a model this person can't use right now: ordinary translation ----
  db.update(schema.models).set({ limitRequests: 1 }).where(eq(schema.models.id, 'b')).run();
  ev = await translate();
  assert.ok(!ev.some((e) => e.event === 'ab'));
  assert.deepEqual(calls.map((c) => c.model), ['gpt-4o']);
  ev = await translate('admin'); // admins are exempt from limits
  assert.ok(ev.some((e) => e.event === 'ab'));
  db.update(schema.models).set({ limitRequests: null }).where(eq(schema.models.id, 'b')).run();
  db.update(schema.models).set({ enabled: 0 }).where(eq(schema.models.id, 'a')).run();
  ev = await translate();
  assert.ok(!ev.some((e) => e.event === 'ab'), 'a disabled slot turns A/B off');
  db.update(schema.models).set({ enabled: 1 }).where(eq(schema.models.id, 'a')).run();

  // ---- held texts: a few per person; an evicted comparison still takes a vote ----
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push((await translate()).find((e) => e.event === 'ab-ready').data.id);
  assert.equal((await vote(burst[0], 'tie')).statusCode, 200);
  assert.equal(trial(burst[0]).vote, 'tie');
  assert.equal(trial(burst[0]).sourceText, null, 'oldest of four was evicted');
  assert.equal((await vote(burst[1], 'tie')).statusCode, 200);
  assert.equal(trial(burst[1]).sourceText, 'hello world', 'the latest three are kept');

  // ---- clearing ----
  ev = await translate();
  const late = ev.find((e) => e.event === 'ab-ready').data.id;
  assert.equal((await request('DELETE', '/api/admin/translate-ab/trials?a=a')).statusCode, 400, 'half a pair never means all');
  assert.ok(trial(late));
  res = await request('DELETE', '/api/admin/translate-ab/trials?a=x&b=y');
  assert.equal(res.json().deleted, 0, 'clearing another pair leaves this one');
  assert.ok(trial(late));
  const all = trialCount();
  res = await request('DELETE', '/api/admin/translate-ab/trials?a=a&b=b');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deleted, all);
  assert.equal(trialCount(), 0);
  assert.equal((await vote(late, 'first')).statusCode, 404, 'a cleared comparison cannot be voted on');
  summary = (await request('GET', '/api/admin/translate-ab/summary')).json().pairs;
  assert.deepEqual(summary, []);

  // Rate is honored: 1% over many runs stays rare (seeded by Math.random).
  assert.equal((await save({ translateAb: abSettings({ rate: 1 }) })).statusCode, 200);
  const realRandom = Math.random;
  Math.random = () => 0.5;
  ev = await translate();
  assert.ok(!ev.some((e) => e.event === 'ab'), '50 ≥ 1: not chosen');
  Math.random = () => 0.005;
  ev = await translate();
  assert.ok(ev.some((e) => e.event === 'ab'), '0.5 < 1: chosen');
  Math.random = realRandom;

  console.log('PASS: A/B settings validation, blind random order, per-model presets, owner-only single vote, texts kept only on vote, void/fallback, model limits, admin summary/list/detail/clear and rate.');
} finally {
  adapter.streamChat = originalStream;
  await app.close();
  rawDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
