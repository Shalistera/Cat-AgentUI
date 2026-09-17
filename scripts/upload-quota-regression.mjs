// Real settings/auth/upload routes, isolated SQLite DB, no listening socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-upload-quota-'));
Object.assign(process.env, {
  DATA_DIR: dataDir, SECRET_KEY: 'upload-quota-regression-secret', COOKIE_SECURE: 'false',
  MAX_USER_UPLOAD_MB: '7', MAX_TOTAL_STORAGE_MB: '10', MAX_UPLOAD_MB: '2',
});
const MIB = 1024 * 1024;
let app;
let rawDb;

try {
  const database = await import('../server/dist/db/index.js');
  rawDb = database.rawDb;
  database.runMigrations();
  const { authPlugin } = await import('../server/dist/auth.js');
  const { authRoutes } = await import('../server/dist/routes/auth.js');
  const { adminRoutes } = await import('../server/dist/routes/admin.js');
  const { uploadRoutes } = await import('../server/dist/routes/uploads.js');
  const { tryReserveStorage } = await import('../server/dist/storage.js');
  app = Fastify();
  await app.register(cookie);
  await authPlugin(app);
  app.setErrorHandler((err, req, reply) => {
    reply.code(err.message === 'forbidden' ? 403 : err.message === 'unauthorized' ? 401 : 500)
      .send({ error: err.message });
  });
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(uploadRoutes);

  const request = (method, url, payload, session = '') => app.inject({
    method, url, payload, headers: { 'x-csrf': '1', cookie: session },
  });
  const sessionOf = (response) => response.headers['set-cookie'].split(';')[0];
  const registered = await request('POST', '/api/auth/register', { username: 'admin', password: 'password-123' });
  assert.equal(registered.statusCode, 200);
  const admin = sessionOf(registered);
  assert.equal((await request('POST', '/api/admin/users', { username: 'member', password: 'password-123' }, admin)).statusCode, 200);
  const login = await request('POST', '/api/auth/login', { username: 'member', password: 'password-123' });
  assert.equal(login.statusCode, 200);
  const member = sessionOf(login);

  const settings = () => request('GET', '/api/admin/settings', undefined, admin);
  const overview = () => request('GET', '/api/admin/storage', undefined, admin);
  const setLimit = (maxUserUploadMb, session = admin) => request('PUT', '/api/admin/settings', { maxUserUploadMb }, session);
  const upload = (bytes, session = member) => {
    const boundary = 'quota-regression-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quota.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.alloc(bytes, 'a'), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST', url: '/api/uploads', payload,
      headers: {
        'x-csrf': '1', cookie: session,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(payload.length),
      },
    });
  };

  assert.equal((await settings()).json().maxUserUploadMb, 7, 'environment fallback');
  assert.equal((await overview()).json().limits.perUserUploads, 7 * MIB);
  assert.equal((await setLimit(2, member)).statusCode, 403, 'only admins can change the limit');
  assert.equal((await setLimit(2, '')).statusCode, 401);
  for (const value of [0, -1, 1.5, 100001, '2', null]) {
    assert.equal((await setLimit(value)).statusCode, 400, `reject invalid limit ${value}`);
  }
  assert.equal((await settings()).json().maxUserUploadMb, 7, 'rejected writes preserve settings');
  assert.equal((await setLimit(100000)).statusCode, 200, 'maximum accepted');
  assert.equal((await setLimit(1)).statusCode, 200, 'minimum accepted');
  assert.equal((await overview()).json().limits.perUserUploads, MIB, 'overview updates immediately');

  const first = await upload(700_000);
  assert.equal(first.statusCode, 200);
  assert.equal((await upload(700_000)).statusCode, 413, 'cumulative user quota enforced');
  assert.equal((await upload(700_000, admin)).statusCode, 200, 'each user has their own allowance');
  assert.equal((await setLimit(2)).json().maxUserUploadMb, 2);
  assert.equal((await upload(700_000)).statusCode, 200, 'raising the limit permits uploads without restart');
  assert.equal((await setLimit(1)).statusCode, 200);
  assert.equal((await upload(1)).statusCode, 413, 'lowering the limit blocks an over-quota user');
  const original = await request('GET', `/api/uploads/${first.json().id}/file`, undefined, member);
  assert.equal(original.statusCode, 200, 'existing files are retained');
  assert.equal(original.rawPayload.length, 700_000);

  // In-flight reservations still count against the newly configured limit.
  const pending = tryReserveStorage('reservation-test', 'upload', MIB);
  assert.equal(pending.ok, true, 'exact boundary allowed');
  assert.deepEqual(tryReserveStorage('reservation-test', 'upload', 1), { ok: false, reason: 'user' });
  pending.reservation.release();
  const afterRelease = tryReserveStorage('reservation-test', 'upload', MIB);
  assert.equal(afterRelease.ok, true);
  afterRelease.reservation.release();

  assert.equal((await setLimit(100000)).statusCode, 200);
  assert.deepEqual(tryReserveStorage('reservation-test', 'upload', 10 * MIB), { ok: false, reason: 'global' }, 'global cap still applies');
  assert.equal((await setLimit(3)).statusCode, 200);
  assert.equal((await request('PUT', '/api/admin/settings', { brand: 'Quota test' }, admin)).statusCode, 200);
  assert.equal((await settings()).json().maxUserUploadMb, 3, 'unrelated settings preserve the limit');

  // A fresh process reads the persisted override even if the environment changes.
  const storageUrl = new URL('../server/dist/storage.js', import.meta.url).href;
  const persisted = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { maxUserUploadMb } = await import(${JSON.stringify(storageUrl)}); console.log(maxUserUploadMb());`,
  ], { env: { ...process.env, MAX_USER_UPLOAD_MB: '9' }, encoding: 'utf8' });
  assert.equal(persisted.trim(), '3');

  // --- /api/uploads/me: the user's own ledger, used by 设置 › 附件存储 ---
  const mine = (session = member) => request('GET', '/api/uploads/me', undefined, session);
  assert.equal((await mine('')).statusCode, 401);
  const before = (await mine()).json();
  assert.equal(before.limit, 3 * MIB, 'limit reflects the live admin setting');
  assert.equal(before.used, before.files.reduce((n, f) => n + f.size, 0), 'used sums the listed files');
  assert.ok(before.files.every((f) => f.chat === null), 'nothing attached to a chat yet');
  const adminIds = new Set((await mine(admin)).json().files.map((f) => f.id));
  assert.ok(adminIds.size > 0 && before.files.every((f) => !adminIds.has(f.id)), 'each account sees only its own files');

  // Attach the biggest file to a chat: it must show that chat and refuse deletion.
  const referenced = before.files[0];
  const uid = rawDb.prepare('select id from users where username = ?').get('member').id;
  rawDb.prepare('insert into chats (id, user_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)')
    .run('chat-1', uid, '带附件的对话', Date.now(), Date.now());
  rawDb.prepare('insert into messages (id, chat_id, role, parts, created_at) values (?, ?, ?, ?, ?)')
    .run('msg-1', 'chat-1', 'user', JSON.stringify([{ type: 'file', uploadId: referenced.id }, { type: 'text', text: 'hi' }]), Date.now());
  const after = (await mine()).json();
  const shown = after.files.find((f) => f.id === referenced.id);
  assert.deepEqual(shown.chat, { id: 'chat-1', title: '带附件的对话' }, 'referenced file names its chat');
  assert.ok(after.files.filter((f) => f.id !== referenced.id).every((f) => f.chat === null));
  assert.equal((await request('DELETE', `/api/uploads/${referenced.id}`, undefined, member)).statusCode, 409, 'referenced file cannot be deleted directly');

  // A loose file deletes and drops out of the ledger.
  const loose = after.files.find((f) => f.chat === null);
  assert.equal((await request('DELETE', `/api/uploads/${loose.id}`, undefined, member)).statusCode, 200);
  const final = (await mine()).json();
  assert.ok(!final.files.some((f) => f.id === loose.id));
  assert.equal(final.used, after.used - loose.size, 'used shrinks by the deleted size');

  console.log('Upload quota regression passed: defaults, permissions, validation, live enforcement, retention, reservations, global cap, persistence, user ledger.');
} finally {
  await app?.close();
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
