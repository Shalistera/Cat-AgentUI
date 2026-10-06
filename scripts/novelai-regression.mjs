// Real API routes and migrations against local stubs. Never calls NovelAI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { novelaiSchema, buildNovelAIRequest, promptTags, tagHistory } from '../server/dist/novelai.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-novelai-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let quota = { active: true, tier: 3, expiresAt: Date.now() / 1000 + 86400, usage: { percent: 85, isNegative: false, timeUntilNextPercent: 600 }, trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 0 } };
let behavior = 'success', requests = [], helperRequests = 0, subReads = 0;
let app, logs = '', base, admin;
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/user/subscription') { subReads++; return res.end(JSON.stringify(quota)); }
  if (req.url.startsWith('/ai/generate-image/suggest-tags')) return res.end(JSON.stringify({ tags: [{ tag: 'watercolor', count: 12345, confidence: 0.9 }, { tag: 'watercolor (medium)' }] }));
  if (req.url === '/ai/generate-image') {
    requests.push(body);
    assert.equal(req.headers.accept, 'application/json');
    if (behavior === 'slow') await sleep(900);
    if (behavior === 'fail') { res.statusCode = 429; return res.end('{}'); }
    if (behavior === 'invalid') return res.end('{"images":[]}');
    return res.end(JSON.stringify({ images: [{ image: png, seed: body.parameters.seed }] }));
  }
  if (req.url.includes('/chat/completions')) {
    helperRequests++;
    const user = body.messages.find(m => m.role === 'user');
    const content = typeof user.content === 'string' ? user.content : user.content.map(p => p.text || '').join('');
    const source = JSON.parse(content);
    if (source.items) {
      const items = source.items.includes('数量不对') ? [] : source.items.map(t => t.replace('双马尾', 'twintails').replace('红眼睛', 'red eyes'));
      res.setHeader('content-type', 'text/event-stream');
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ items }) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
    }
    const prepared = JSON.stringify({ basePrompt: '2girls, cafe. Two girls drink hot chocolate by the window.', negativePrompt: 'hat', characters: source.characters.map((c, i) => ({ prompt: `girl, ${i ? 'black' : 'white'} hair`, negativePrompt: c.negativePrompt ? 'glasses' : '' })) });
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: prepared }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 } })}\n\ndata: [DONE]\n\n`);
    return;
  }
  res.statusCode = 404; res.end('{}');
});
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function wait(fn) { for (let i = 0; i < 160; i++) { const r = await fn(); if (r) return r; await sleep(50); } throw new Error(`Timed out\n${logs.slice(-2000)}`); }
async function call(method, route, body, cookie = admin) {
  const res = await fetch(base + route, { method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function done(id, cookie = admin) { return wait(async () => { const r = await call('GET', `/api/images/jobs/${id}`, undefined, cookie); return r.data.status !== 'running' ? r.data : null; }); }
async function job(body, cookie = admin) { const r = await call('POST', '/api/images/generate', body, cookie); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.jobId; }

try {
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env: { ...process.env, DATA_DIR: data, SECRET_KEY: 'novelai-test-only-secret', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', chunk => { logs += chunk; }); app.stderr.on('data', chunk => { logs += chunk; });
  await wait(() => fetch(base + '/api/health').then(r => r.ok).catch(() => { if (app.exitCode !== null) throw new Error(logs); return false; }));
  admin = (await call('POST', '/api/auth/register', { username: 'naiadmin', password: 'nai-test-password' })).cookie;
  assert(admin);
  const provider = (await call('POST', '/api/admin/providers', { name: 'NovelAI local stub', type: 'novelai', apiKey: 'nai-test-key', baseUrl: `http://127.0.0.1:${upstreamPort}` })).data;
  assert.equal((await call('POST', `/api/admin/providers/${provider.id}/fetch-models`)).data.models.length, 2);
  assert.equal((await call('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'nai-diffusion-4-5-full' }] })).status, 400);
  await call('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'nai-diffusion-5-curated', displayName: 'V5 Curated' }, { modelId: 'nai-diffusion-5-full', displayName: 'V5 Full' }] });
  const modelList = (await call('GET', '/api/admin/providers')).data.find(p => p.id === provider.id).models;
  const [curated, full] = ['nai-diffusion-5-curated', 'nai-diffusion-5-full'].map(id => modelList.find(m => m.modelId === id).id);
  assert.equal((await call('PATCH', `/api/admin/models/${curated}`, { imageGen: false })).status, 400);
  assert.equal((await call('PUT', '/api/admin/agent', { imageGeneration: { modelIds: [curated] } })).status, 400);
  assert(!(await call('GET', '/api/models')).data.some(m => m.id === curated));
  assert.equal((await call('GET', '/api/images/models')).data.length, 2);
  const helper = (await call('POST', '/api/admin/providers', { name: 'Prompt local stub', type: 'openai', apiKey: 'helper-test-key', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` })).data;
  await call('POST', '/api/admin/models', { providerId: helper.id, models: [{ modelId: 'prompt-helper', displayName: '提示词助手' }] });
  const helperId = (await call('GET', '/api/admin/providers')).data.find(p => p.id === helper.id).models[0].id;
  const cfg = (await call('GET', '/api/images/novelai/config')).data;
  assert.equal(cfg.helpers[0].id, helperId); assert(cfg.uc.heavy.includes('artistic error'));
  assert.equal((await call('GET', `/api/images/novelai/${curated}/subscription`)).data.available, true);
  const suggested = (await call('GET', `/api/images/novelai/${curated}/tags?q=water`)).data.tags;
  assert.deepEqual(suggested, [{ tag: 'watercolor', count: 12345 }, { tag: 'watercolor (medium)', count: null }], 'suggestions carry upstream popularity');

  await call('POST', '/api/admin/users', { username: 'naiuser', password: 'nai-test-password', role: 'user', allowImages: true, allowImageModels: true });
  const user = await call('POST', '/api/auth/login', { username: 'naiuser', password: 'nai-test-password' });
  assert.equal((await call('PATCH', `/api/admin/users/${user.data.user.id}`, { allowImages: true, allowImageModels: true })).status, 200);
  await call('POST', '/api/admin/users', { username: 'denied', password: 'nai-test-password', role: 'user', allowImages: false, allowImageModels: true });
  const denied = await call('POST', '/api/auth/login', { username: 'denied', password: 'nai-test-password' });
  assert.equal((await call('GET', `/api/images/novelai/${curated}/subscription`, undefined, denied.cookie)).status, 403);
  assert.equal((await call('GET', '/api/images/novelai/config', undefined, denied.cookie)).status, 403);
  await call('PATCH', `/api/admin/models/${full}`, { accessMode: 'restricted', allowedUserIds: [] });
  assert.equal((await call('GET', `/api/images/novelai/${full}/subscription`, undefined, user.cookie)).status, 403);
  assert.equal((await call('GET', `/api/images/novelai/${full}/tags?q=water`, undefined, user.cookie)).status, 403);
  await call('PATCH', `/api/admin/models/${full}`, { accessMode: 'shared' });

  const prep = await call('POST', '/api/images/novelai/prepare', { modelId: curated, helperModelId: helperId, scene: '两位女孩在咖啡馆', negativePrompt: '帽子', characters: [{ name: '白发女孩', description: '白发', negativePrompt: '' }, { name: '黑发女孩', description: '黑发', negativePrompt: '眼镜' }] }, user.cookie);
  assert.equal(prep.status, 200, JSON.stringify(prep.data)); assert.equal(prep.data.characters.length, 2); assert.equal(helperRequests, 1);
  const options = novelaiSchema.parse({ basePrompt: prep.data.basePrompt, seed: 0, artists: [{ tag: 'artist:test', weight: 1.2 }], useCoords: true,
    characters: prep.data.characters.map((c, i) => ({ ...c, name: `角色 ${i + 1}`, description: i ? '黑发' : '白发', x: i ? .75 : .25, y: .5 })), negativePrompt: 'hat', imageText: '你好' });
  const body = { modelId: curated, prompt: '两位女孩在咖啡馆', n: 1, size: '1216x832', novelai: options };
  assert.equal((await call('POST', '/api/images/generate', body, denied.cookie)).status, 403);
  const finished = await done(await job(body, user.cookie), user.cookie);
  assert.equal(finished.status, 'done', JSON.stringify(finished)); assert.equal(finished.images.length, 1);
  const sent = requests.at(-1); assert.equal(sent.model, 'nai-diffusion-5-curated'); assert.equal(sent.parameters.seed, 0); assert.equal(sent.parameters.n_samples, 1);
  assert.equal(sent.parameters.v4_prompt.caption.char_captions[1].centers[0].x, .75);
  assert.equal(sent.parameters.v4_negative_prompt.caption.char_captions[1].char_caption, 'glasses');
  assert(sent.input.startsWith('1.2::artist:test::')); assert(sent.input.endsWith('Text: 你好')); assert(!sent.input.includes('no text'));
  assert(sent.parameters.negative_prompt.includes('artistic error')); assert(sent.parameters.negative_prompt.endsWith('hat'));
  const meta = JSON.parse(finished.images[0].generationSettings); assert.equal(meta.options.seed, 0); assert.equal(meta.options.characters.length, 2);
  assert.equal(meta.options.sourceMode, 'assisted'); assert(!finished.images[0].generationSettings.includes('nai-test-key'));
  const restored = await call('GET', `/api/images/novelai/restore/${finished.images[0].id}`, undefined, user.cookie);
  assert.equal(restored.data.modelId, curated); assert.equal(restored.data.image.generationSettings, finished.images[0].generationSettings);
  assert.equal((await call('GET', `/api/images/novelai/restore/${finished.images[0].id}`)).status, 404, 'cannot restore another user’s image');
  const studioHistory = (await call('GET', '/api/images?kind=novelai&limit=10', undefined, user.cookie)).data;
  assert.deepEqual(studioHistory.images.map(i => i.id), [finished.images[0].id], 'studio history lists only the user’s own NAI images');
  assert.equal(studioHistory.total, 1);
  const remembered = (await call('GET', '/api/images/novelai/tag-history', undefined, user.cookie)).data;
  assert.deepEqual(remembered.tags.map(t => t.tag).sort(), ['2girls', 'artist:test', 'black hair', 'girl', 'white hair'],
    'tag history keeps prompt, character and artist tags but not sentences');
  assert.deepEqual(remembered.negative.map(t => t.tag).sort(), ['glasses', 'hat']);
  assert.equal(remembered.tags.find(t => t.tag === 'girl').count, 1, 'a tag counts once per image');
  assert.equal((await call('GET', '/api/images/novelai/tag-history', undefined, denied.cookie)).status, 403);
  assert.deepEqual((await call('GET', '/api/images/novelai/tag-history')).data, { tags: [], negative: [] }, 'history is per user');
  const tagify = await call('POST', '/api/images/novelai/tagify', { modelId: curated, helperModelId: helperId, items: ['{双马尾}', '红眼睛'] }, user.cookie);
  assert.equal(tagify.status, 200, JSON.stringify(tagify.data));
  assert.deepEqual(tagify.data.items, ['{twintails}', 'red eyes']);
  assert.equal((await call('POST', '/api/images/novelai/tagify', { modelId: curated, helperModelId: helperId, items: [] }, user.cookie)).status, 400);
  assert.equal((await call('POST', '/api/images/novelai/tagify', { modelId: curated, helperModelId: helperId, items: ['数量不对', 'x'] }, user.cookie)).status, 502, 'a reply of the wrong length is rejected');
  assert.equal((await call('POST', '/api/images/novelai/tagify', { modelId: curated, helperModelId: helperId, items: ['猫'] }, denied.cookie)).status, 403);
  const fullResult = await done(await job({ ...body, modelId: full, novelai: { ...options, ucEnabled: false, imageText: '' }, size: '1024x1024' }));
  assert.equal(fullResult.status, 'done'); assert.equal(requests.at(-1).parameters.negative_prompt, 'hat');
  assert.equal(requests.at(-1).model, 'nai-diffusion-5-full');

  const count = requests.length;
  assert.equal((await call('POST', '/api/images/generate', { ...body, n: 2 })).status, 400);
  assert.equal((await call('POST', '/api/images/generate', { ...body, novelai: { ...options, steps: 29 } })).status, 400);
  assert.equal((await call('POST', '/api/images/generate', { ...body, inputUploadIds: ['not-a-reference'] })).status, 400);
  assert.equal((await done(await job({ ...body, size: '2048x2048' }))).status, 'error');
  assert.equal(requests.length, count, 'invalid billable requests never reach generation');
  for (const change of [{ active: false }, { tier: 2 }, { usage: null }, { usage: { percent: 0, isNegative: false } }, { usage: { percent: 80, isNegative: true } }]) {
    const before = quota; quota = { ...quota, ...change };
    const result = await done(await job(body)); assert.equal(result.status, 'error'); quota = before;
  }
  assert.equal(requests.length, count, 'unavailable subscription never reaches generation');
  assert(subReads > 5, 'subscription is rechecked per generation');

  behavior = 'slow';
  const first = await job(body); await wait(() => requests.length > count);
  const second = await job({ ...body, modelId: full });
  assert.equal((await done(second)).status, 'error', 'two models share the same credential lock');
  assert.equal((await done(first)).status, 'done'); assert.equal(requests.length, count + 1);
  behavior = 'fail'; const previous = requests.length;
  assert.equal((await done(await job(body))).status, 'error'); assert.equal(requests.length, previous + 1, '429 is not retried');
  behavior = 'success';
  const compiled = buildNovelAIRequest('nai-diffusion-5-full', 'cafe', '832x1216', novelaiSchema.parse({ basePrompt: 'a sign Text: Hello' }), 1);
  assert(compiled.input.endsWith('Text: Hello')); assert(!compiled.input.includes('no text'));
  const trailing = buildNovelAIRequest('nai-diffusion-5-full', 'x', '832x1216', novelaiSchema.parse({ basePrompt: '1girl, smile, ', negativePrompt: 'hat, ', ucEnabled: false, quality: 'none', characters: [{ prompt: 'girl, ', negativePrompt: '' }] }), 1);
  assert.equal(trailing.input, '1girl, smile', 'the trailing comma Tag 模式 leaves is not sent');
  assert.equal(trailing.parameters.negative_prompt, 'hat');
  assert.equal(trailing.parameters.v4_prompt.caption.char_captions[0].char_caption, 'girl');
  assert.deepEqual(promptTags('{{Long_Hair}}, 1.2::blue eyes::, o_o, 雨天, she walks along the road., Text: Hello, world'), ['long hair', 'blue eyes', 'o_o']);
  const day = 86_400_000;
  const history = tagHistory([
    { settings: JSON.stringify({ provider: 'novelai', options: { basePrompt: 'smile, cat', negativePrompt: 'hat' } }), createdAt: 10 * day },
    { settings: JSON.stringify({ provider: 'novelai', options: { basePrompt: 'smile, smile, dog' } }), createdAt: 70 * day },
    { settings: 'not json', createdAt: 70 * day },
    { settings: JSON.stringify({ provider: 'openai', options: { basePrompt: 'ignored' } }), createdAt: 70 * day },
  ], 70 * day);
  assert.deepEqual(history.tags.map(t => [t.tag, t.count, t.score]), [['smile', 2, 1.25], ['dog', 1, 1], ['cat', 1, 0.25]], 'recent use outranks old use');
  assert.equal(history.tags[0].last, 70 * day); assert.deepEqual(history.negative.map(t => t.tag), ['hat']);
  console.log('NovelAI regression passed: V5 models, permissions, preparation, tag history, tag conversion, UC, coordinates, metadata, subscription gate, request limits, shared credential concurrency and no retry.');
  if (process.argv.includes('--serve')) {
    console.log(`UI fixture: ${base} (naiadmin / nai-test-password)`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} finally {
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await new Promise(resolve => { app.once('exit', resolve); setTimeout(() => { app.kill('SIGKILL'); resolve(); }, 2000).unref(); }); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
}
