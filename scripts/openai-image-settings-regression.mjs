// Real routes, migrations, and OpenAI JSON/multipart requests against a local
// stub. Uses a temporary database and never calls a paid image service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-openai-image-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
// Two 1x1 frames (black/white), 200 ms each, looping forever. Keeping the
// exact bytes through the file route catches accidental first-frame conversion.
const gif = Buffer.from('47494638396101000100800000000000ffffff21ff0b4e45545343415045322e30030100000021f90400140000002c000000000100010000020244010021f90400140000002c00000000010001000002024c01003b', 'hex').toString('base64');
const fixtures = {
  png, gif,
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z',
  webp: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/v02aAA=',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [];
let app, base, admin, port, logs = '', behavior = 'success';
let failureGate;
const upstream = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/animation') {
    res.setHeader('content-type', 'image/gif'); return res.end(Buffer.from(gif, 'base64'));
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const request = new Request('http://localhost' + req.url, { method: 'POST', headers: req.headers, body: bytes });
  const form = req.headers['content-type']?.startsWith('multipart/') ? await request.formData() : null;
  const body = form ? Object.fromEntries(form) : JSON.parse(bytes.toString());
  requests.push({ url: req.url, body, imageCount: form?.getAll('image[]').length });
  res.setHeader('content-type', 'application/json');
  if (behavior === 'fail') {
    await failureGate;
    res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'fixture failure' } }));
  }
  const format = behavior === 'detect' || behavior === 'metadata' ? 'gif' : body.output_format ?? 'png';
  const result = behavior === 'url'
    ? { url: `http://127.0.0.1:${upstream.address().port}/animation` }
    : { b64_json: behavior === 'mismatch' ? png : fixtures[format] };
  res.end(JSON.stringify({
    ...(behavior === 'metadata' ? { output_format: format } : {}),
    data: Array.from({ length: Number(body.n ?? 1) }, () => result),
  }));
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function wait(fn) {
  for (let i = 0; i < 160; i++) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(`Timed out: ${logs.slice(-2000)}`);
}
async function call(method, route, body, cookie = admin) {
  const res = await fetch(base + route, { method,
    headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function start() {
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root,
    env: { ...process.env, DATA_DIR: data, SECRET_KEY: 'openai-image-test-only', HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', s => { logs += s; }); app.stderr.on('data', s => { logs += s; });
  await wait(() => fetch(base + '/api/health').then(r => r.ok).catch(() => { if (app.exitCode !== null) throw new Error(logs); return false; }));
}
async function stop() {
  if (!app || app.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => app.kill('SIGKILL'), 2000);
    app.once('exit', () => { clearTimeout(timer); resolve(); }); app.kill('SIGTERM');
  });
}
async function generate(modelId, options = {}) {
  const r = await call('POST', '/api/images/generate', { modelId, prompt: 'A small cat', ...options });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return wait(async () => {
    const result = await call('GET', `/api/images/jobs/${r.data.jobId}`);
    return result.data.status === 'running' ? null : result.data;
  });
}
async function patch(id, fields, status = 200) {
  const r = await call('PATCH', `/api/admin/models/${id}`, fields);
  assert.equal(r.status, status, JSON.stringify(r.data));
}

try {
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(); port = await listen(probe); await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  await start();
  admin = (await call('POST', '/api/auth/register', { username: 'imageadmin', password: 'image-test-password' })).cookie;
  assert(admin);
  const p = await call('POST', '/api/admin/providers', { name: 'OpenAI image fixture', type: 'openai', apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` });
  assert.equal(p.status, 200);
  const providerId = p.data.id;
  await call('POST', '/api/admin/models', { providerId, models: [
    { modelId: 'gpt-image-2.5-flare', imageGen: true },
    { modelId: 'gpt-image-2.5-sunburst', imageGen: true },
    { modelId: 'compatible-image-alias', imageGen: true },
    { modelId: 'chat-model', imageGen: false },
    { modelId: 'gpt-image-2.6-flare', imageGen: true },
    { modelId: 'gpt-image-2.6-sunburst', imageGen: true },
    { modelId: 'gpt-image-1.5', imageGen: true },
    { modelId: 'dall-e-3', imageGen: true },
  ] });
  const adminModels = () => call('GET', '/api/admin/providers').then(r => r.data.find(p => p.id === providerId).models);
  const models = await adminModels();
  const [flare, sunburst, alias, chat] = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'compatible-image-alias', 'chat-model']
    .map(name => models.find(m => m.modelId === name).id);
  const [flare26, sunburst26, oldImage, dalle] = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-1.5', 'dall-e-3']
    .map(name => models.find(m => m.modelId === name).id);
  assert(models.every(m => m.openaiImageSettings === false), 'existing/default model settings stay off');
  assert.equal((await generate(flare)).status, 'done');
  assert.equal(requests.at(-1).body.quality, undefined, 'disabled models keep provider defaults');
  const beforeDisabled = requests.length;
  assert.equal((await call('POST', '/api/images/generate', { modelId: flare, prompt: 'test', quality: 'high' })).status, 400);
  assert.equal(requests.length, beforeDisabled);
  await patch(chat, { openaiImageSettings: true }, 400);
  const gemini = (await call('POST', '/api/admin/providers', { name: 'Gemini fixture', type: 'gemini', apiKey: 'fixture' })).data;
  await call('POST', '/api/admin/models', { providerId: gemini.id, models: [{ modelId: 'gemini-image', imageGen: true }] });
  const geminiId = (await call('GET', '/api/admin/providers')).data.find(p => p.id === gemini.id).models[0].id;
  await patch(geminiId, { openaiImageSettings: true }, 400);
  for (const id of [flare, sunburst, alias]) await patch(id, { openaiImageSettings: true });
  const visible = (await call('GET', '/api/images/models')).data;
  assert(visible.find(m => m.id === flare).openaiImageSettings === true);
  assert(visible.find(m => m.id === geminiId).openaiImageSettings === false);
  assert.deepEqual(visible.find(m => m.id === flare26).outputFormats, ['png', 'jpeg', 'webp', 'gif']);
  assert.deepEqual(visible.find(m => m.id === sunburst26).outputFormats, ['png', 'jpeg', 'webp', 'gif']);
  assert.deepEqual(visible.find(m => m.id === oldImage).outputFormats, ['png', 'jpeg', 'webp']);
  assert.deepEqual(visible.find(m => m.id === dalle).outputFormats, []);
  assert.deepEqual(visible.find(m => m.id === geminiId).outputFormats, []);

  async function assertFile(image, format) {
    const file = await fetch(`${base}/api/images/${image.id}/file`, { headers: { cookie: admin } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), `image/${format}`);
    assert.match(file.headers.get('content-disposition'), new RegExp(`\\.${format === 'jpeg' ? 'jpg' : format}"$`));
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(fixtures[format], 'base64'));
  }
  // GIF is available without turning on the separate quality/size controls.
  const animation = await generate(flare26, { outputFormat: 'gif' });
  assert.equal(animation.status, 'done', JSON.stringify(animation));
  const defaultGif = requests.at(-1).body;
  assert.equal(defaultGif.output_format, 'gif');
  assert.equal(defaultGif.frame_count, 9); assert.equal(defaultGif.frame_duration_ms, 200);
  for (const unsupported of ['stream', 'partial_images', 'output_compression', 'prompt_rewriter', 'response_format']) {
    assert.equal(defaultGif[unsupported], undefined);
  }
  await assertFile(animation.images[0], 'gif');
  assert.deepEqual(JSON.parse(animation.images[0].generationSettings), { provider: 'openai', outputFormat: 'gif', frameCount: 9, frameDurationMs: 200 });
  const galleryImage = (await call('GET', '/api/images')).data.images.find(img => img.id === animation.images[0].id);
  assert(galleryImage.filename.endsWith('.gif'));
  assert.equal(galleryImage.generationSettings, animation.images[0].generationSettings);

  await patch(sunburst26, { openaiImageSettings: true });
  for (const [frameCount, frameDurationMs] of [[2, 20], [64, 2000], [12, 123]]) {
    const result = await generate(sunburst26, { outputFormat: 'gif', frameCount, frameDurationMs, size: '512x512', n: 2 });
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.equal(result.images.length, 2);
    assert.equal(requests.at(-1).body.size, '512x512', 'small GIF frames are not rejected by still-image minimums');
    assert.equal(requests.at(-1).body.frame_count, frameCount);
    assert.equal(requests.at(-1).body.frame_duration_ms, Math.round(frameDurationMs / 10) * 10);
    for (const image of result.images) await assertFile(image, 'gif');
  }
  const beforeInvalidGif = requests.length;
  for (const options of [
    { frameCount: 1 }, { frameCount: 65 }, { frameCount: 2.5 }, { frameCount: '9' },
    { frameDurationMs: 19 }, { frameDurationMs: 2001 }, { frameDurationMs: 20.5 },
    { size: '513x512' }, { size: '0x512' }, { inputUploadIds: ['unused-reference'] },
    { history: [{ role: 'user', text: 'draw' }, { role: 'assistant', text: 'which one?' }] },
    { outputFormat: 'svg' }, { outputFormat: 'png', frameCount: 9 }, { outputFormat: 'webp', frameDurationMs: 200 },
  ]) {
    const r = await call('POST', '/api/images/generate', { modelId: sunburst26, prompt: 'test', outputFormat: 'gif', ...options });
    assert.equal(r.status, 400, JSON.stringify(options));
  }
  for (const modelId of [oldImage, dalle, geminiId, alias]) {
    assert.equal((await call('POST', '/api/images/generate', { modelId, prompt: 'test', outputFormat: 'gif' })).status, 400);
  }
  assert.equal((await call('POST', '/api/images/generate', { modelId: flare26, prompt: 'test', frameCount: 9 })).status, 400);
  assert.equal(requests.length, beforeInvalidGif, 'invalid animation requests never reach the provider');
  for (const mode of ['detect', 'metadata', 'url']) {
    behavior = mode;
    const result = await generate(flare26, mode === 'url' ? { outputFormat: 'gif' } : {});
    assert.equal(result.status, 'done', `${mode}: ${JSON.stringify(result)}`);
    await assertFile(result.images[0], 'gif');
  }
  behavior = 'mismatch';
  assert.equal((await generate(flare26, { outputFormat: 'gif' })).status, 'error', 'declared GIF with PNG bytes must be rejected');
  behavior = 'success';

  await stop(); await start();
  assert((await adminModels()).find(m => m.id === flare).openaiImageSettings, 'setting survives restart and migration replay');
  assert.equal((await generate(flare)).status, 'done');
  assert.equal(requests.at(-1).body.quality, 'medium', 'omitted quality defaults to medium');
  assert.equal(requests.at(-1).body.size, undefined, 'automatic size uses the upstream default');
  for (const [id, quality, size] of [
    [flare, 'low', '1536x1024'], [sunburst, 'medium', '1024x1536'], [sunburst, 'high', '3840x2160'],
    [flare, 'high', '2160x3840'], [alias, 'medium', '1536x864'], [flare, 'medium', '640x1024'],
  ]) {
    const result = await generate(id, { quality, size });
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.equal(result.images[0].size, size);
    assert.equal(requests.at(-1).body.quality, quality);
    assert.equal(requests.at(-1).body.size, size);
    assert.equal(requests.at(-1).url, '/v1/images/generations');
  }
  const beforeInvalid = requests.length;
  for (const quality of ['xhigh', 'max', 'auto', 'hd', 'HIGH', '']) {
    assert.equal((await call('POST', '/api/images/generate', { modelId: flare, prompt: 'test', quality })).status, 400, quality);
  }
  for (const size of ['1025x1024', '4096x2048', '512x512', '3840x3840', '3072x768', '0x1024', '1024X1024', '1024x-1024', '']) {
    assert.equal((await call('POST', '/api/images/generate', { modelId: flare, prompt: 'test', size })).status, 400, size);
  }
  assert.equal(requests.length, beforeInvalid, 'invalid settings never reach the provider');

  const form = new FormData(); form.set('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'reference.png');
  const upload = await fetch(base + '/api/uploads', { method: 'POST', headers: { cookie: admin, 'x-csrf': '1' }, body: form });
  assert.equal(upload.status, 200); const inputUploadIds = [(await upload.json()).id];
  assert.equal((await generate(sunburst, { quality: 'high', size: '2048x2048', inputUploadIds })).status, 'done');
  assert.equal(requests.at(-1).url, '/v1/images/edits');
  assert.equal(requests.at(-1).body.quality, 'high');
  assert.equal(requests.at(-1).body.size, '2048x2048');
  assert.equal(requests.at(-1).imageCount, 1);
  const beforeGifEdit = requests.length;
  assert.equal((await call('POST', '/api/images/generate', { modelId: sunburst26, prompt: 'edit', outputFormat: 'gif', inputUploadIds })).status, 400);
  assert.equal(requests.length, beforeGifEdit);

  for (const outputFormat of Object.keys(fixtures).filter(format => format !== 'gif')) {
    for (const refs of [undefined, inputUploadIds]) {
      const result = await generate(sunburst26, { outputFormat, inputUploadIds: refs });
      assert.equal(result.status, 'done', JSON.stringify(result));
      assert.equal(requests.at(-1).url, refs ? '/v1/images/edits' : '/v1/images/generations');
      assert.equal(requests.at(-1).body.output_format, outputFormat);
      assert.equal(requests.at(-1).body.frame_count, undefined);
      assert.equal(requests.at(-1).body.frame_duration_ms, undefined);
      await assertFile(result.images[0], outputFormat);
    }
  }

  behavior = 'fail';
  let releaseFailure;
  failureGate = new Promise(resolve => { releaseFailure = resolve; });
  const failedJob = await call('POST', '/api/images/generate', { modelId: sunburst26, prompt: 'retry test', quality: 'low', size: '1536x864', outputFormat: 'gif', frameCount: 12, frameDurationMs: 123 });
  assert.equal(failedJob.status, 200);
  const active = (await call('GET', '/api/images/jobs/active')).data.jobs.find(j => j.modelId === sunburst26);
  releaseFailure();
  const failed = await wait(async () => {
    const r = await call('GET', `/api/images/jobs/${failedJob.data.jobId}`);
    return r.data.status === 'running' ? null : r.data;
  });
  assert.equal(failed.status, 'error');
  assert.equal(active.request.quality, 'low'); assert.equal(active.request.size, '1536x864');
  assert.equal(active.request.outputFormat, 'gif'); assert.equal(active.request.frameCount, 12); assert.equal(active.request.frameDurationMs, 120);
  behavior = 'success';
  assert.equal((await generate(sunburst26, active.request)).status, 'done', 'retry keeps the original options');
  assert.equal(requests.at(-1).body.quality, 'low');
  await patch(flare, { openaiImageSettings: false });
  assert.equal((await generate(flare)).status, 'done');
  assert.equal(requests.at(-1).body.quality, undefined);
  assert.equal(requests.at(-1).body.size, undefined);
  await patch(sunburst, { imageGen: false }); await patch(sunburst, { imageGen: true });
  assert.equal((await adminModels()).find(m => m.id === sunburst).openaiImageSettings, false, 'changing model kind clears the option');
  console.log('PASS: model settings, GIF capabilities and validation, animation parameters and retries, binary preservation, MIME/download extensions, JSON generation and multipart editing.');
  if (process.env.TEST_KEEP_OPEN === '1') {
    await patch(flare, { openaiImageSettings: true });
    await patch(geminiId, { enabled: false });
    await patch(flare26, { openaiImageSettings: true });
    console.log(`UI fixture: ${base} (imageadmin / image-test-password), model details: /admin/models/${flare}`);
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} finally {
  await stop();
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
}
