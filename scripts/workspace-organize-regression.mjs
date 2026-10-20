// Folder management in the 工作区 panel: mkdir, batch move/delete, rename of
// folders and zip download, through the real routes, filesystem and a
// temporary SQLite. The host-side descriptor chain relies on Linux procfs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import JSZip from 'jszip';

if (process.platform !== 'linux') {
  console.log('Workspace organize regression skipped: needs Linux /proc/self/fd.');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-workspace-organize-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'workspace-organize-regression';
process.env.MAX_WORKSPACE_FILES = '40';
const { db, rawDb, schema, runMigrations, setSetting } = await import('../server/dist/db/index.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { workspaceRoutes } = await import('../server/dist/routes/workspace.js');
const { workspaceRoot } = await import('../server/dist/workspace.js');

const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.code(e.message === 'forbidden' ? 403 : e.message === 'unauthorized' ? 401 : 500).send({ error: e.message }));
const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const ok = (r) => { assert.equal(r.statusCode, 200, r.body); return r.json(); };

try {
  runMigrations();
  for (const user of ['alice', 'bob']) {
    db.insert(schema.users).values({ id: user, username: user, passwordHash: 'unused', role: 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: user, tokenHash: sha256hex(`${user}-session`), createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'provider', type: 'openai', name: 'Fixture', createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'model', providerId: 'provider', modelId: 'fixture', tools: 1, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  await app.register(cookie);
  await authPlugin(app);
  await chatRoutes(app);
  await app.register(workspaceRoutes);

  const chat = ok(await request('POST', '/api/chats', { modelId: 'model' })).chat.id;
  const base = `/api/chats/${chat}/workspace`;
  const list = async () => ok(await request('GET', base));
  const put = async (p, content) => ok(await request('PUT', `${base}/file`, { path: p, content }));
  const read = async (p) => ok(await request('GET', `${base}/file?text=1&path=${encodeURIComponent(p)}`)).text;
  const paths = async () => (await list()).files.map((f) => f.path).sort();
  const mkdir = (p) => request('POST', `${base}/mkdir`, { path: p });
  const move = (ps, to) => request('POST', `${base}/move`, { paths: ps, to });
  const del = (ps) => request('POST', `${base}/delete`, { paths: ps });

  // ---- folders ----
  ok(await mkdir('docs'));
  assert.deepEqual((await list()).dirs, ['docs'], 'an empty folder is listed');
  assert.equal((await mkdir('docs')).statusCode, 409, 'existing folder');
  assert.equal((await mkdir('.secret')).statusCode, 400, 'hidden names stay rejected');
  assert.equal((await mkdir('../out')).statusCode, 400);
  await put('a.md', 'A');
  assert.equal((await mkdir('a.md')).statusCode, 409, 'a file already has that name');
  ok(await mkdir('nested/deeper'));
  assert.deepEqual((await list()).dirs.sort(), ['docs', 'nested', 'nested/deeper']);

  // ---- batch move ----
  await put('b.md', 'B');
  await put('c.txt', 'C');
  let r = ok(await move(['a.md', 'b.md'], 'docs'));
  assert.deepEqual(r.moved, [{ from: 'a.md', to: 'docs/a.md' }, { from: 'b.md', to: 'docs/b.md' }]);
  assert.deepEqual(r.failed, []);
  assert.equal(await read('docs/a.md'), 'A');
  assert.deepEqual(await paths(), ['c.txt', 'docs/a.md', 'docs/b.md']);

  await put('a.md', 'second A');
  r = ok(await move(['a.md', 'c.txt'], 'docs'));
  assert.deepEqual(r.moved, [{ from: 'c.txt', to: 'docs/c.txt' }], 'one conflict does not stop the batch');
  assert.deepEqual(r.failed, [{ path: 'a.md', error: '目标已存在:docs/a.md' }]);
  assert.equal(await read('a.md'), 'second A', 'the conflicting file is left alone');
  assert.equal(await read('docs/a.md'), 'A', 'and nothing is overwritten');

  r = ok(await move(['docs/a.md'], 'docs'));
  assert.deepEqual(r, { ok: true, moved: [], failed: [] }, 'already there is a no-op');

  ok(await mkdir('docs/sub'));
  r = ok(await move(['docs'], 'docs/sub'));
  assert.deepEqual(r.failed, [{ path: 'docs', error: '不能把「docs」移动到它自己里面' }]);
  r = ok(await move(['docs'], 'docs'));
  assert.equal(r.failed.length, 1, 'a folder into itself');
  assert.equal((await move(['a.md'], 'missing')).statusCode, 404, 'the destination must exist');
  assert.equal((await move(['a.md'], 'a.md')).statusCode, 404, 'the destination must be a folder');
  assert.equal((await move(['../a.md'], '')).statusCode, 400);

  ok(await mkdir('archive'));
  r = ok(await move(['docs', 'docs/b.md'], 'archive'));
  assert.deepEqual(r.moved, [{ from: 'docs', to: 'archive/docs' }], 'a child of a moved folder goes with it');
  assert.equal(await read('archive/docs/b.md'), 'B');
  assert.deepEqual((await list()).dirs.sort(), ['archive', 'archive/docs', 'archive/docs/sub', 'nested', 'nested/deeper']);

  r = ok(await move(['archive/docs/b.md'], ''));
  assert.deepEqual(r.moved, [{ from: 'archive/docs/b.md', to: 'b.md' }], 'back to the root');

  // Moving a folder must not push its contents past MAX_DEPTH (8 segments).
  await put('deep/l2/l3/l4/f.txt', 'deep');
  ok(await mkdir('p1/p2/p3/p4'));
  r = ok(await move(['deep'], 'p1/p2/p3/p4'));
  assert.deepEqual(r.failed, [{ path: 'deep', error: '目录层级不能超过 8 层' }]);
  r = ok(await move(['deep'], 'p1/p2/p3'));
  assert.equal(r.moved.length, 1, 'exactly 8 segments is allowed');
  assert.equal(await read('p1/p2/p3/deep/l2/l3/l4/f.txt'), 'deep');

  // ---- rename folders ----
  ok(await request('POST', `${base}/rename`, { from: 'archive', to: 'old' }));
  assert.equal(await read('old/docs/a.md'), 'A');
  const intoSelf = await request('POST', `${base}/rename`, { from: 'old', to: 'old/inner' });
  assert.equal(intoSelf.statusCode, 400, intoSelf.body);

  // ---- irregular entries ----
  fs.symlinkSync('/etc', path.join(workspaceRoot(chat), 'link'));
  r = ok(await move(['link'], 'old'));
  assert.deepEqual(r.failed, [{ path: 'link', error: '不是普通文件:link' }], 'symlinks are not moved');
  assert.equal(fs.lstatSync(path.join(workspaceRoot(chat), 'link')).isSymbolicLink(), true);
  assert.equal((await request('POST', `${base}/zip`, { paths: ['link'] })).statusCode, 400, 'nor zipped');
  fs.symlinkSync('/etc', path.join(workspaceRoot(chat), 'old', 'etc-link'));
  fs.mkdirSync(path.join(workspaceRoot(chat), '.cache'));
  fs.writeFileSync(path.join(workspaceRoot(chat), '.cache', 'x.txt'), 'hidden');
  fs.writeFileSync(path.join(workspaceRoot(chat), 'old', '.hidden'), 'hidden');
  const listing = await list();
  assert(!listing.files.some((f) => f.path.startsWith('.cache/')), 'hidden folders are not listed');
  assert(!listing.dirs.includes('.cache'));

  // ---- zip ----
  const zipRes = await request('POST', `${base}/zip`, { paths: ['old', 'b.md'] });
  assert.equal(zipRes.statusCode, 200, zipRes.body);
  assert.equal(zipRes.headers['content-type'], 'application/zip');
  const zip = await JSZip.loadAsync(zipRes.rawPayload);
  const names = Object.keys(zip.files).sort();
  assert.deepEqual(names, ['b.md', 'old/', 'old/docs/', 'old/docs/a.md', 'old/docs/c.txt', 'old/docs/sub/']);
  assert.equal(await zip.file('old/docs/a.md').async('string'), 'A');
  assert.equal(await zip.file('b.md').async('string'), 'B');
  assert.equal((await request('POST', `${base}/zip`, { paths: ['nope.md'] })).statusCode, 404);

  // ---- batch delete ----
  r = ok(await del(['old', 'old/docs/a.md', 'b.md', 'never-existed.md']));
  assert.deepEqual(r.deleted.sort(), ['b.md', 'never-existed.md', 'old']);
  assert.equal(r.removed, 4, 'a.md, c.txt and .hidden inside the folder, plus b.md (the symlink is unlinked, not counted)');
  assert.deepEqual(r.failed, []);
  assert(!(await list()).dirs.includes('old'));
  assert.equal(fs.existsSync(path.join(workspaceRoot(chat), 'link')), true, 'unrelated entries survive');

  // ---- scope, ownership and limits ----
  const { scopeKey } = await list();
  assert.equal((await request('POST', `${base}/move?scope=stale`, { paths: ['a.md'], to: 'nested' })).statusCode, 409);
  ok(await request('POST', `${base}/move?scope=${encodeURIComponent(scopeKey)}`, { paths: ['a.md'], to: 'nested' }));
  assert.equal((await request('POST', `${base}/delete`, { paths: ['nested'] }, 'bob')).statusCode, 404);
  assert.equal((await request('POST', `${base}/mkdir`, { path: 'bob' }, 'bob')).statusCode, 404);
  assert.equal((await request('POST', `${base}/delete`, { paths: [] })).statusCode, 400);

  let capped = null;
  for (let i = 0; i < 45 && !capped; i++) {
    const res = await mkdir(`many-${i}`);
    if (res.statusCode !== 200) capped = res;
  }
  assert.equal(capped?.statusCode, 413, 'folder count is bounded');
  assert.match(capped.json().error, /^工作区文件夹数不能超过 40 个$/);

  console.log('Workspace organize regression passed: folders, batch move with conflicts/self/depth checks, rename, symlink refusal, hidden entries, zip, batch delete, scope, ownership and folder limits.');
} finally {
  await app.close();
  rawDb.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
