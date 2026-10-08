// Real admin/translation routes + temporary SQLite + an in-process provider.
// No paid requests or writes to the running application's data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-translate-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'translate-regression-secret';
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
let failFirst = false;
adapter.streamChat = async function* (_cfg, request) {
  calls.push({ model: request.model, reasoning: request.reasoning });
  if (failFirst && calls.length === 1) throw new Error('fixture unavailable');
  yield { type: 'text', text: '译文' };
};
const request = (method, url, payload, user = 'admin') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const save = (payload, user) => request('PUT', '/api/admin/settings', payload, user);
async function translate(mode, level = 2) {
  calls = [];
  const res = await request('POST', '/api/translate/stream', { text: 'text', source: 'en', target: 'zh-CN', mode, level }, 'alice');
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /译文/);
  assert.match(res.body, /"status":"done"/);
  return calls;
}
const entry = (modelId, mode, reasoningEffort = null) => ({ modelId, mode, reasoningEffort });

try {
  runMigrations();
  for (const id of ['admin', 'alice']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'unused', role: id === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: id, tokenHash: sha256hex(`${id}-session`), createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'p', name: 'Fixture', type: 'openai', createdAt: Date.now() }).run();
  for (const [id, modelId, extra] of [
    ['a', 'gpt-5-a', {}], ['b', 'gpt-5-b', { reasoningMode: 'custom', reasoningLevels: JSON.stringify([
      { value: 'low', label: '低' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '极高' },
    ]) }], ['plain', 'gpt-4o', {}], ['image', 'image', { imageGen: 1 }],
  ]) db.insert(schema.models).values({ id, providerId: 'p', modelId, ...extra, createdAt: Date.now() }).run();
  await app.register(cookie);
  await authPlugin(app);
  await adminRoutes(app);
  await translateRoutes(app);

  // Old settings retain their mode and user-intensity mapping without migration.
  setSetting('translate_fast_models', ['a']);
  setSetting('translate_think_models', ['b']);
  let view = (await request('GET', '/api/admin/settings')).json();
  assert.deepEqual(view.translateFastModels, [entry('a', 'fast')]);
  assert.deepEqual(view.translateThinkModels, [entry('b', 'think')]);
  assert.deepEqual(await translate('fast'), [{ model: 'gpt-5-a', reasoning: { level: 'off', ratio: 0 } }]);
  for (const [level, effort, ratio] of [[1, 'low', 0], [2, 'high', 0.5], [3, 'xhigh', 1]]) {
    assert.deepEqual(await translate('think', level), [{ model: 'gpt-5-b', reasoning: { level: effort, ratio } }]);
  }

  // Existing chains supply a default until the admin configures one.
  assert.deepEqual(view.translateDefaultModels, [entry('a', 'fast')]);
  assert.deepEqual(await translate('default'), [{ model: 'gpt-5-a', reasoning: { level: 'off', ratio: 0 } }]);

  // Admin presets apply only to the new default mode. Legacy overrides left
  // in explicit chains must never override a user's fast/think selection.
  const defaults = [entry('a', 'think', 'high'), entry('b', 'think', 'xhigh')];
  const fast = [...defaults];
  const think = [entry('a', 'fast'), entry('b', 'fast')];
  let res = await save({ translateDefaultModels: defaults, translateFastModels: fast, translateThinkModels: think });
  assert.equal(res.statusCode, 200, res.body);
  view = (await request('GET', '/api/admin/settings')).json();
  assert.deepEqual(view.translateDefaultModels, defaults);
  assert.deepEqual(view.translateFastModels, fast);
  assert.deepEqual(view.translateThinkModels, think);
  assert.deepEqual(view.translateFastModelIds, ['a', 'b']);
  assert.deepEqual(await translate('fast', 1), [{ model: 'gpt-5-a', reasoning: { level: 'off', ratio: 0 } }]);
  assert.deepEqual(await translate('think', 3), [{ model: 'gpt-5-a', reasoning: { level: 'high', ratio: 1 } }]);
  for (const level of [1, 3]) assert.deepEqual(await translate('default', level), [{ model: 'gpt-5-a', reasoning: { level: 'high', ratio: 1 } }]);
  assert.deepEqual(await translate(undefined), [{ model: 'gpt-5-a', reasoning: { level: 'high', ratio: 1 } }], 'omitting mode selects defaults');
  failFirst = true;
  assert.deepEqual(await translate('default', 1), [
    { model: 'gpt-5-a', reasoning: { level: 'high', ratio: 1 } },
    { model: 'gpt-5-b', reasoning: { level: 'xhigh', ratio: 1 } },
  ]);
  assert.deepEqual(await translate('fast', 3), [
    { model: 'gpt-5-a', reasoning: { level: 'off', ratio: 0 } },
    { model: 'gpt-5-b', reasoning: { level: 'off', ratio: 0 } },
  ]);
  assert.deepEqual(await translate('think', 1), [
    { model: 'gpt-5-a', reasoning: { level: 'minimal', ratio: 0 } },
    { model: 'gpt-5-b', reasoning: { level: 'low', ratio: 0 } },
  ]);
  failFirst = false;

  // Default fast and unspecified effort do not inherit the user's saved intensity.
  assert.equal((await save({ translateDefaultModels: [entry('a', 'fast')] })).statusCode, 200);
  assert.deepEqual(await translate('default', 3), [{ model: 'gpt-5-a', reasoning: { level: 'off', ratio: 0 } }]);
  assert.equal((await save({ translateDefaultModels: [entry('b', 'think')] })).statusCode, 200);
  for (const level of [1, 3]) assert.deepEqual(await translate('default', level), [{ model: 'gpt-5-b', reasoning: { level: 'high', ratio: 0.5 } }]);
  assert.equal((await save({ translateDefaultModels: [defaults[1], defaults[0]] })).statusCode, 200);

  // Legacy clients can reorder explicit chains without changing the default chain.
  res = await save({ translateFastModelIds: ['b', 'a'] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().translateFastModels, [fast[1], fast[0]]);
  assert.deepEqual(res.json().translateDefaultModels, [defaults[1], defaults[0]]);
  assert.deepEqual(await translate('fast', 1), [{ model: 'gpt-5-b', reasoning: { level: 'off', ratio: 0 } }]);

  // Invalid tiers/modes/models and excessive chains fail before any settings change.
  setSetting('brand', 'Before');
  const snapshot = getSetting('translate_fast_models', []);
  for (const invalid of [entry('a', 'think', 'xhigh'), entry('a', 'invalid'), entry('missing', 'fast'),
    entry('image', 'fast'), entry('plain', 'think', 'high'), entry('a', 'think', 'off')]) {
    res = await save({ brand: 'After', translateFastModels: [], translateDefaultModels: [invalid] });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(getSetting('brand', ''), 'Before');
    assert.deepEqual(getSetting('translate_fast_models', []), snapshot);
  }
  assert.equal((await save({ translateDefaultModels: Array(7).fill(entry('a', 'fast')) })).statusCode, 400);
  assert.equal((await save({ translateFastModels: [] }, 'alice')).statusCode, 403);

  // A later ladder edit must not send a stale tier to the provider.
  db.update(schema.models).set({ reasoningLevels: JSON.stringify([{ value: 'low' }, { value: 'high' }]) }).where(eq(schema.models.id, 'b')).run();
  assert.deepEqual(await translate('default', 1), [{ model: 'gpt-5-b', reasoning: { level: 'high', ratio: 1 } }]);
  db.update(schema.models).set({ enabled: 0 }).where(eq(schema.models.id, 'b')).run();
  assert.deepEqual(await translate('default'), [{ model: 'gpt-5-a', reasoning: { level: 'high', ratio: 1 } }]);

  // Models without reasoning remain usable; empty chains stay unavailable.
  res = await save({ translateDefaultModels: [entry('plain', 'fast')], translateFastModels: [], translateThinkModels: [] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await translate('default'), [{ model: 'gpt-4o', reasoning: undefined }]);
  const publicConfig = (await request('GET', '/api/translate/config', undefined, 'alice')).json();
  assert.equal(publicConfig.default, true);
  assert.equal(publicConfig.fast, false);
  assert.equal(publicConfig.think, false);
  assert.equal(publicConfig.translateFastModels, undefined, 'model settings stay admin-only');
  assert.equal((await save({ translateDefaultModels: [], translateFastModels: [entry('a', 'fast')] })).statusCode, 200);
  assert.equal((await request('GET', '/api/translate/config', undefined, 'alice')).json().default, false, 'explicitly empty default chain does not fall back to fast');
  assert.equal((await request('POST', '/api/translate/stream', { text: 'text', source: 'en', target: 'zh-CN', mode: 'default' }, 'alice')).statusCode, 400);
  console.log('PASS: explicit fast/think override presets, default mode isolation, translation defaults, native tiers, fallback isolation, legacy compatibility, validation and admin authorization.');
} finally {
  adapter.streamChat = originalStream;
  await app.close();
  rawDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
