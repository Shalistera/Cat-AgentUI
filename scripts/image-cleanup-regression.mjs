// Gallery housekeeping: paging and order, the storage summary, 清理空间
// (preview + delete), and the opt-in 自动清理 that trims the oldest workshop
// images after a generation. Real routes and migrations on a temporary
// database, with a loopback stub as the image provider — no paid service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const MIB = 1024 * 1024;
const IMAGE_BYTES = 400_000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-image-cleanup-'));
// 3 MiB per user and 1 MiB reserved per picture: six 400 kB pictures fit, the
// seventh is refused unless 自动清理 may make room.
Object.assign(process.env, {
  DATA_DIR: dataDir, SECRET_KEY: 'image-cleanup-regression-secret', COOKIE_SECURE: 'false',
  MAX_USER_IMAGE_MB: '3', MAX_GENERATED_IMAGE_MB: '1', MAX_TOTAL_STORAGE_MB: '100',
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Only the magic bytes are checked, so a PNG signature plus padding passes as
// a picture of any size.
const png = (bytes) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8)]);
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [{ b64_json: png(IMAGE_BYTES).toString('base64') }] }));
});
let app;
let rawDb;

try {
  const database = await import('../server/dist/db/index.js');
  rawDb = database.rawDb;
  database.runMigrations();
  const { authPlugin } = await import('../server/dist/auth.js');
  const { authRoutes } = await import('../server/dist/routes/auth.js');
  const { adminRoutes } = await import('../server/dist/routes/admin.js');
  const { providerRoutes } = await import('../server/dist/routes/providers.js');
  const { imageRoutes } = await import('../server/dist/routes/images.js');
  const { imageStorageSummary, suggestedCleanupCount, trimImagesToQuota } = await import('../server/dist/image-cleanup.js');
  app = Fastify();
  await app.register(cookie);
  await authPlugin(app);
  app.setErrorHandler((err, req, reply) => {
    const status = { unauthorized: 401, forbidden: 403, 'no-images-access': 403 }[err.message] ?? 500;
    reply.code(status).send({ error: err.message });
  });
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(providerRoutes);
  await app.register(imageRoutes);
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const request = (method, url, payload, session = '') => app.inject({
    method, url, payload, headers: { 'x-csrf': '1', cookie: session },
  });
  const sessionOf = (response) => response.headers['set-cookie'].split(';')[0];
  const admin = sessionOf(await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' }));
  const provider = (await request('POST', '/api/admin/providers', {
    name: 'Image stub', type: 'openai', apiKey: 'stub-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
  }, admin)).json();
  assert.ok(provider.id, 'provider created');
  await request('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'gpt-image-stub', imageGen: true }] }, admin);
  const modelId = (await request('GET', '/api/admin/providers', undefined, admin)).json()
    .find((p) => p.id === provider.id).models[0].id;

  async function generate(session) {
    const r = await request('POST', '/api/images/generate', { modelId, prompt: 'cleanup fixture' }, session);
    if (r.statusCode !== 200) return { status: r.statusCode, body: r.json() };
    for (let i = 0; i < 400; i++) {
      const job = (await request('GET', `/api/images/jobs/${r.json().jobId}`, undefined, session)).json();
      if (job.status !== 'running') {
        await sleep(3); // distinct createdAt for the next picture
        return { status: 200, job };
      }
      await sleep(10);
    }
    throw new Error('image job timed out');
  }
  const gallery = async (query, session = admin) => (await request('GET', `/api/images?${query}`, undefined, session)).json();
  const cleanup = (body, session = admin) => request('POST', '/api/images/cleanup', body, session);
  const setAutoClean = (value, session = admin) => request('PATCH', '/api/auth/profile', { settings: { imageAutoClean: value } }, session);
  const exists = (id) => !!rawDb.prepare('select 1 from images where id = ?').get(id);
  const createdAt = (id) => rawDb.prepare('select created_at as t from images where id = ?').get(id).t;
  const userId = (name) => rawDb.prepare('select id from users where username = ?').get(name).id;
  const insertImage = (owner, id, source, at, bytes, { directory = false } = {}) => {
    const file = path.join(dataDir, 'images', `${id}.png`);
    if (directory) fs.mkdirSync(file); else fs.writeFileSync(file, png(bytes));
    rawDb.prepare('insert into images (id, user_id, source, prompt, filename, byte_size, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, owner, source, `fixture ${id}`, `${id}.png`, bytes, at);
  };

  // ---- fill the quota with auto-clean off ----
  const made = [];
  for (let i = 0; i < 6; i++) {
    const r = await generate(admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.job.status, 'done', JSON.stringify(r.job));
    assert.deepEqual(r.job.trimmed, [], 'nothing is trimmed while auto-clean is off');
    made.push(r.job.images[0].id);
  }
  const refused = await request('POST', '/api/images/generate', { modelId, prompt: 'one too many' }, admin);
  assert.equal(refused.statusCode, 413, 'worst-case reservation no longer fits');
  assert.equal(refused.json().code, 'image_quota', 'clients can offer 清理空间');
  assert.equal(refused.json().error, '图片存储空间不足,请到作品集「清理空间」删除旧图,或开启自动清理');

  // ---- listing: both orders, stable paging, storage summary ----
  const oldestPage = await gallery('limit=2&offset=0&sort=oldest');
  assert.deepEqual(oldestPage.images.map((i) => i.id), made.slice(0, 2), 'oldest first');
  assert.deepEqual((await gallery('limit=2&offset=0')).images.map((i) => i.id), [made[5], made[4]], 'newest first by default');
  assert.deepEqual((await gallery('limit=4&offset=4&sort=oldest')).images.map((i) => i.id), made.slice(4), 'later pages');
  assert.equal(oldestPage.total, 6);
  const summary = {
    used: 6 * IMAGE_BYTES, limit: 3 * MIB, count: 6, chat: { count: 0, bytes: 0 },
    oldestAt: createdAt(made[0]), reservePerImage: MIB, autoClean: false,
  };
  assert.deepEqual(oldestPage.storage, summary, 'gallery pages carry the storage summary');
  // Two new images' reservation (2 MiB) must fit afterwards: 4 × 400 kB on real
  // sizes, rounded up to 10 — then capped at half of the six pictures.
  assert.deepEqual((await request('GET', '/api/images/storage', undefined, admin)).json(), { ...summary, suggestedCount: 3 });

  // ---- 自动清理: strictly boolean, admits against reclaimable bytes, trims only what is needed ----
  assert.equal((await setAutoClean('yes')).statusCode, 400, 'the flag is strictly boolean');
  assert.equal((await setAutoClean(true)).statusCode, 200);
  assert.equal((await gallery('limit=1')).storage.autoClean, true);
  let r = await generate(admin);
  assert.equal(r.job.status, 'done', 'admitted once old pictures may make room');
  assert.deepEqual(r.job.trimmed, [], 'the real picture still fits: nothing deleted');
  made.push(r.job.images[0].id);
  r = await generate(admin);
  assert.deepEqual(r.job.trimmed, [made[0]], 'exactly the oldest picture made room');
  made.push(r.job.images[0].id);
  assert.equal((await request('GET', `/api/images/${made[0]}/file`, undefined, admin)).statusCode, 404, 'its file is gone');
  const afterTrim = await gallery('limit=100&sort=oldest');
  assert.deepEqual(afterTrim.images.map((i) => i.id), made.slice(1));
  assert.equal(afterTrim.storage.used, 7 * IMAGE_BYTES, 'back within the quota');

  // ---- 清理空间 preview: same selection as the delete, chat images opt-in ----
  const adminId = userId('admin');
  insertImage(adminId, 'chat-old', 'chat', 1000, IMAGE_BYTES);
  let preview = (await cleanup({ mode: 'oldest', count: 2, dryRun: true })).json();
  assert.deepEqual(
    { count: preview.count, bytes: preview.bytes, chat: preview.chat, from: preview.from, to: preview.to },
    { count: 2, bytes: 2 * IMAGE_BYTES, chat: 0, from: createdAt(made[1]), to: createdAt(made[2]) },
    'chat-born images stay out by default, even when older',
  );
  assert.deepEqual(preview.samples.map((s) => s.id), [made[1], made[2]]);
  assert.equal(preview.samples[0].prompt, 'cleanup fixture', 'samples carry prompts for the thumbnails');
  preview = (await cleanup({ mode: 'oldest', count: 2, includeChat: true, dryRun: true })).json();
  assert.deepEqual(preview.samples.map((s) => s.id), ['chat-old', made[1]]);
  assert.equal(preview.chat, 1);
  preview = (await cleanup({ mode: 'oldest', count: 50, dryRun: true })).json();
  assert.equal(preview.count, 7, 'a count past the end selects what exists');
  assert.deepEqual(preview.samples.map((s) => s.id), [made[1], made[2], made[3], made[5], made[6], made[7]], 'three from each end');
  preview = (await cleanup({ mode: 'before', before: createdAt(made[3]), dryRun: true })).json();
  assert.equal(preview.count, 2, 'before a date excludes that moment');
  preview = (await cleanup({ mode: 'before', before: 0, dryRun: true })).json();
  assert.deepEqual({ count: preview.count, from: preview.from, samples: preview.samples }, { count: 0, from: null, samples: [] });
  assert.ok(exists(made[1]) && exists('chat-old'), 'a preview deletes nothing');

  // ---- 清理空间 delete ----
  let done = (await cleanup({ mode: 'oldest', count: 2, upTo: createdAt(made[2]) })).json();
  assert.deepEqual(done, { ok: true, deleted: 2, bytes: 2 * IMAGE_BYTES });
  assert.ok(!exists(made[1]) && !exists(made[2]) && exists('chat-old'));
  assert.ok(!fs.existsSync(path.join(dataDir, 'images', `${made[1]}.png`)), 'files go with their rows');
  done = (await cleanup({ mode: 'oldest', count: 100, upTo: createdAt(made[4]) })).json();
  assert.equal(done.deleted, 2, 'upTo keeps newer pictures out of a big count');
  assert.ok(!exists(made[4]) && exists(made[5]));
  done = (await cleanup({ mode: 'before', before: createdAt(made[6]), includeChat: true })).json();
  assert.equal(done.deleted, 2, 'chat image and the older workshop picture');
  assert.ok(!exists('chat-old') && !exists(made[5]) && exists(made[6]));
  assert.ok(!fs.existsSync(path.join(dataDir, 'images', 'chat-old.png')), 'chat image file removed too');
  for (const bad of [{ mode: 'oldest' }, { mode: 'oldest', count: 0 }, { mode: 'oldest', count: 1.5 },
    { mode: 'before', before: -1 }, { mode: 'everything' }, { mode: 'before', before: 1, includeChat: 'yes' }]) {
    assert.equal((await cleanup(bad)).statusCode, 400, JSON.stringify(bad));
  }

  // ---- per-user scope and the workshop gate ----
  assert.equal((await request('POST', '/api/admin/users', { username: 'member', password: 'password-123' }, admin)).statusCode, 200);
  const member = sessionOf(await request('POST', '/api/auth/login', { username: 'member', password: 'password-123' }));
  const memberId = userId('member');
  assert.equal((await cleanup({ mode: 'oldest', count: 1, dryRun: true }, member)).statusCode, 403, 'needs workshop access');
  assert.equal((await request('GET', '/api/images/storage', undefined, member)).statusCode, 403);
  assert.equal((await request('PATCH', `/api/admin/users/${memberId}`, { allowImages: true }, admin)).statusCode, 200);
  assert.equal((await cleanup({ mode: 'oldest', count: 100, dryRun: true }, member)).json().count, 0, 'sees only own images');
  assert.equal((await cleanup({ mode: 'oldest', count: 100, includeChat: true }, member)).json().deleted, 0);
  assert.ok(exists(made[6]) && exists(made[7]), "another user's cleanup leaves these alone");

  // ---- auto-clean that cannot make enough room says so ----
  insertImage(adminId, 'chat-big', 'chat', Date.now(), Math.round(2.5 * MIB));
  const stuck = await request('POST', '/api/images/generate', { modelId, prompt: 'no room' }, admin);
  assert.equal(stuck.statusCode, 413);
  assert.equal(stuck.json().code, 'image_quota');
  assert.match(stuck.json().error, /自动清理也腾不出足够空间/);
  assert.equal((await setAutoClean(false)).statusCode, 200);
  assert.match((await request('POST', '/api/images/generate', { modelId, prompt: 'no room' }, admin)).json().error, /或开启自动清理$/);

  // ---- trimImagesToQuota directly: chat images, `before`, files that won't go ----
  assert.equal((await setAutoClean(true, member)).statusCode, 200);
  insertImage(memberId, 'm-stuck', 'workshop', 100, IMAGE_BYTES, { directory: true }); // unlink fails: EISDIR
  insertImage(memberId, 'm-chat', 'chat', 200, IMAGE_BYTES);
  insertImage(memberId, 'm-a', 'workshop', 300, Math.round(1.5 * MIB));
  insertImage(memberId, 'm-b', 'workshop', 400, Math.round(1.5 * MIB));
  insertImage(memberId, 'm-c', 'workshop', 500, IMAGE_BYTES);
  assert.deepEqual(trimImagesToQuota(memberId, 300), [], 'only images older than the reservation qualify');
  assert.deepEqual(trimImagesToQuota(memberId, 450), ['m-a'], 'skips a stuck file and the chat image, stops once within quota');
  assert.ok(exists('m-stuck') && exists('m-chat') && exists('m-b') && exists('m-c'), 'a row whose file is still there stays');
  assert.deepEqual(trimImagesToQuota(memberId, Date.now()), [], 'within quota: nothing more');
  insertImage(memberId, 'm-d', 'workshop', 600, Math.round(1.5 * MIB));
  assert.equal((await setAutoClean(false, member)).statusCode, 200);
  assert.deepEqual(trimImagesToQuota(memberId, Date.now()), [], 'never trims with the switch off');

  // ---- the dialog's default count follows real sizes, oldest first ----
  // 30 tiny old pictures, then big new ones: an average would wildly
  // overshoot; the real sizes say how many it takes.
  const sizer = userId('admin');
  rawDb.prepare('delete from images where user_id = ?').run(sizer);
  for (let i = 0; i < 30; i++) insertImage(sizer, `tiny-${i}`, 'workshop', 10 + i, 1000);
  for (let i = 0; i < 30; i++) insertImage(sizer, `big-${i}`, 'workshop', 100 + i, 90_000);
  // 3 MiB quota, ~2.7 MB used: two reservations (2 MiB) must fit → free
  // ~1.7 MB more → every tiny picture plus 19 big ones, rounded to 10, capped at 30.
  assert.equal(suggestedCleanupCount(sizer, imageStorageSummary(sizer)), 30);
  rawDb.prepare("delete from images where user_id = ? and id like 'big-%' and created_at >= 110").run(sizer);
  // ~0.9 MB used: just a tenth of the quota (314 kB) → the 30 tiny ones free
  // 30 kB, then 4 big ones → 34 → rounded 40 → capped at half of 40 = 20.
  assert.equal(suggestedCleanupCount(sizer, imageStorageSummary(sizer)), 20);
  assert.equal(suggestedCleanupCount(memberId, imageStorageSummary(memberId)) >= 1, true);
  rawDb.prepare('delete from images where user_id = ?').run(sizer);
  assert.equal(suggestedCleanupCount(sizer, imageStorageSummary(sizer)), 0, 'no gallery, no suggestion');

  console.log('image cleanup regression passed');
} finally {
  await app?.close();
  upstream.close();
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
