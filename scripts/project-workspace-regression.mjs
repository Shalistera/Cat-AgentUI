// Real routes + filesystem + temporary SQLite. Linux uses procfs directly.
// On other hosts only the /proc/self/fd path spelling is adapted for this test;
// this does not test Linux sandbox execution or concurrent symlink attacks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';

const restarting = process.argv[2] === '--verify-restart';
const temp = restarting ? process.env.DATA_DIR : fs.mkdtempSync(path.join(os.tmpdir(), 'cat-project-workspace-'));
process.env.DATA_DIR = temp;
process.env.SECRET_KEY = 'project-workspace-regression';
process.env.MAX_WORKSPACE_FILES = '10';
const originals = new Map();
if (process.platform !== 'linux') {
  const fds = new Map();
  const translate = (p) => {
    if (typeof p !== 'string') return p;
    const m = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(p);
    if (!m) return p;
    assert(fds.has(+m[1]), `unknown fd ${p}`);
    return path.join(fds.get(+m[1]), m[2] ?? '');
  };
  const replace = (name, fn) => { originals.set(name, fs[name]); fs[name] = fn(fs[name]); };
  replace('openSync', (orig) => (p, ...args) => {
    p = translate(p);
    const fd = orig(p, ...args);
    fds.set(fd, p);
    return fd;
  });
  replace('closeSync', (orig) => (fd) => { fds.delete(fd); return orig(fd); });
  for (const name of ['readdirSync', 'lstatSync', 'mkdirSync', 'unlinkSync', 'rmdirSync']) {
    replace(name, (orig) => (p, ...args) => orig(translate(p), ...args));
  }
  replace('renameSync', (orig) => (a, b) => orig(translate(a), translate(b)));
}
const { db, rawDb, schema, runMigrations, setSetting } = await import('../server/dist/db/index.js');
const { authPlugin } = await import('../server/dist/auth.js');
const { sha256hex } = await import('../server/dist/crypto.js');
const { projectRoutes } = await import('../server/dist/routes/projects.js');
const { chatRoutes } = await import('../server/dist/routes/chats.js');
const { workspaceRoutes } = await import('../server/dist/routes/workspace.js');
const { withChatLock } = await import('../server/dist/workspace-lock.js');
const { workspaceScope, withWorkspaceScope, privateWorkspaceRoot, projectWorkspaceRoot } = await import('../server/dist/workspace-scope.js');
const { workspaceRoot, writeWorkspaceFile, readWorkspaceText, callWorkspaceTool, listWorkspace,
  allWorkspacesBytes, sweepOrphanWorkspaces, buildWorkspacePrompt } = await import('../server/dist/workspace.js');
const { getAdapter, toRuntimeConfig } = await import('../server/dist/providers/index.js');
const { runSubagent } = await import('../server/dist/subagent.js');
const { runInSandbox } = await import('../server/dist/sandbox/exec.js');
if (restarting) {
  const listing = await withWorkspaceScope(process.argv[3], () => listWorkspace(process.argv[3]));
  console.log(JSON.stringify(listing));
  rawDb.close();
  process.exit(0);
}
const adapter = getAdapter('openai');
const originalStream = adapter.streamChat;
let promptSawShared = false;
let beforeModelTool = () => {};
adapter.streamChat = async function* (_cfg, req) {
  promptSawShared ||= req.system.includes('同一用户在本项目中的所有对话');
  if (!req.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))) {
    beforeModelTool();
    beforeModelTool = () => {};
    yield { type: 'tool_call', id: 'write', name: 'workspace_write', args: JSON.stringify({ path: 'model.md', content: 'Written by the model' }) };
    yield { type: 'stop', reason: 'tool_calls' };
  } else {
    yield { type: 'text', text: 'Saved in the shared project workspace.' };
    yield { type: 'stop', reason: 'stop' };
  }
};
const app = Fastify();
app.setErrorHandler((e, _req, reply) => reply.code(e.message === 'forbidden' ? 403 : e.message === 'unauthorized' ? 401 : 500).send({ error: e.message }));
const request = (method, url, payload, user = 'alice') => app.inject({ method, url, payload,
  headers: { 'x-csrf': '1', cookie: `cat_session=${user}-session` } });
const ok = (r) => { assert.equal(r.statusCode, 200, r.body); return r.json(); };
const newChat = async (projectId, user = 'alice') => {
  const chat = ok(await request('POST', '/api/chats', { projectId, modelId: 'model' }, user)).chat;
  ok(await request('PATCH', `/api/chats/${chat.id}`, { title: 'Fixture' }, user));
  return chat.id;
};
const list = async (id, user) => ok(await request('GET', `/api/chats/${id}/workspace`, undefined, user));
const put = async (id, name, content, scopeKey, user) => request('PUT', `/api/chats/${id}/workspace/file${scopeKey ? `?scope=${encodeURIComponent(scopeKey)}` : ''}`, { path: name, content }, user);
const read = async (id, name, user) => ok(await request('GET', `/api/chats/${id}/workspace/file?text=1&path=${encodeURIComponent(name)}`, undefined, user)).text;
const tick = () => new Promise((r) => setImmediate(r));
try {
  runMigrations();
  for (const user of ['alice', 'bob', 'admin']) {
    db.insert(schema.users).values({ id: user, username: user, passwordHash: 'unused', role: user === 'admin' ? 'admin' : 'user', createdAt: Date.now() }).run();
    db.insert(schema.sessions).values({ userId: user, tokenHash: sha256hex(`${user}-session`), createdAt: Date.now(), expiresAt: Date.now() + 600_000 }).run();
  }
  db.insert(schema.providers).values({ id: 'provider', type: 'openai', name: 'Fixture', createdAt: Date.now() }).run();
  db.insert(schema.models).values({ id: 'model', providerId: 'provider', modelId: 'fixture', tools: 1, createdAt: Date.now() }).run();
  setSetting('followup_enabled', false);
  await app.register(cookie);
  await authPlugin(app);
  await projectRoutes(app);
  await chatRoutes(app);
  await app.register(workspaceRoutes);

  const p = ok(await request('POST', '/api/projects', { name: 'Shared project' })).project;
  assert.equal(p.sharedWorkspace, false, 'sharing defaults off');
  const q = ok(await request('POST', '/api/projects', { name: 'Other project', sharedWorkspace: true })).project;
  assert.equal(q.sharedWorkspace, true);
  ok(await request('PUT', `/api/projects/${p.id}/sharing`, { accessMode: 'restricted', members: [{ userId: 'bob', role: 'editor' }] }));
  assert.equal((await request('PATCH', `/api/projects/${p.id}`, { sharedWorkspace: true }, 'bob')).statusCode, 403);
  assert.equal((await request('PATCH', `/api/projects/${p.id}`, { sharedWorkspace: 'yes' })).statusCode, 400);
  const a1 = await newChat(p.id), a2 = await newChat(p.id), b1 = await newChat(p.id, 'bob'), other = await newChat(q.id);
  ok(await put(a1, 'private.md', 'Original private file'));
  assert.equal((await list(a1)).scope, 'chat');
  assert.equal((await list(a2)).files.length, 0);
  const privateKey = (await list(a1)).scopeKey;

  assert.equal(ok(await request('PATCH', `/api/projects/${p.id}`, { sharedWorkspace: true })).project.sharedWorkspace, true);
  const sharedKey = (await list(a1)).scopeKey;
  assert.equal((await list(a1)).scope, 'project');
  assert.equal(await read(a2, 'private.md'), 'Original private file', 'existing files are imported across chats');
  assert.equal((await list(a2)).scopeKey, sharedKey);
  assert.notEqual((await list(b1, 'bob')).scopeKey, sharedKey);
  assert.notEqual((await list(other)).scopeKey, sharedKey);
  assert.equal((await put(a1, 'private.md', 'stale editor', privateKey)).statusCode, 409);
  ok(await put(a1, 'shared.md', 'First draft', sharedKey));
  assert.equal(await read(a2, 'shared.md'), 'First draft');
  assert.equal((await list(b1, 'bob')).files.length, 0);
  assert.equal((await list(other)).files.length, 0);
  assert.equal((await request('GET', `/api/chats/${a1}/workspace`, undefined, 'bob')).statusCode, 404);
  assert.equal((await request('GET', `/api/chats/${a1}/workspace`, undefined, 'admin')).statusCode, 404);
  assert.equal((await put(b1, 'shared.md', 'forged scope', sharedKey, 'bob')).statusCode, 409);
  ok(await put(b1, 'shared.md', 'Bob only', undefined, 'bob'));
  assert.equal(await read(a1, 'shared.md'), 'First draft');
  assert.equal(await read(b1, 'shared.md', 'bob'), 'Bob only');
  assert.equal((await put(a1, '../escape.txt', 'blocked')).statusCode, 400);

  const edited = await callWorkspaceTool(a2, 'workspace_edit', JSON.stringify({ path: 'shared.md', old_string: 'First', new_string: 'Second' }));
  assert.equal(edited.isError, false, edited.result);
  assert.equal(await read(a1, 'shared.md'), 'Second draft');
  assert(buildWorkspacePrompt(a2).includes('shared.md'));
  beforeModelTool = () => db.update(schema.projects).set({ sharedWorkspace: 0 }).where(eq(schema.projects.id, p.id)).run();
  const generated = await request('POST', `/api/chats/${a2}/stream`, { content: [{ type: 'text', text: 'Write a file' }] });
  assert.equal(generated.statusCode, 200, generated.body);
  assert(promptSawShared);
  assert.equal(workspaceScope(a1).kind, 'chat');
  assert(!fs.existsSync(path.join(privateWorkspaceRoot(a2), 'model.md')), 'a running turn keeps its project scope after settings change');
  ok(await request('PATCH', `/api/projects/${p.id}`, { sharedWorkspace: true }));
  assert.equal(await read(a1, 'model.md'), 'Written by the model');
  const child = await runSubagent({
    user: db.select().from(schema.users).where(eq(schema.users.id, 'alice')).get(), chatId: a1, projectId: p.id,
    parentMessageId: 'fixture-parent', provider: db.select().from(schema.providers).get(), model: db.select().from(schema.models).get(),
    cfg: toRuntimeConfig(db.select().from(schema.providers).get()), reasoning: undefined, secretValues: [],
    signal: new AbortController().signal, askConfirm: async () => new Map(), onProgress() {}, consumeOutput() {},
    adapter: { async *streamChat(_cfg, req) {
      const result = req.messages.flatMap((m) => m.parts).find((part) => part.type === 'tool_result');
      if (!result) {
        yield { type: 'tool_call', id: 'read-shared', name: 'workspace_read', args: JSON.stringify({ path: 'model.md' }) };
        yield { type: 'stop', reason: 'tool_calls' };
      } else {
        yield { type: 'text', text: result.result };
        yield { type: 'stop', reason: 'stop' };
      }
    } },
  }, 'Read the file produced in the other project chat.');
  assert.equal(child.stopped, 'done', child.error);
  assert.match(child.text, /Written by the model/);


  // Browser uploads and downloads use the same storage as model tools.
  const boundary = 'project-workspace-boundary';
  const upload = await app.inject({ method: 'POST', url: `/api/chats/${a1}/workspace/upload?scope=${encodeURIComponent(sharedKey)}`,
    headers: { 'x-csrf': '1', cookie: 'cat_session=alice-session', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\nUploaded text\r\n--${boundary}--\r\n` });
  ok(upload);
  assert.equal(await read(a2, 'upload.txt'), 'Uploaded text');
  ok(await request('POST', `/api/chats/${a2}/workspace/rename`, { from: 'upload.txt', to: 'folder/renamed.txt' }));
  assert.equal((await request('GET', `/api/chats/${a1}/workspace/file?path=folder%2Frenamed.txt&download=1`)).body, 'Uploaded text');
  ok(await request('DELETE', `/api/chats/${a1}/workspace/file?path=folder`));
  assert(!(await list(a2)).files.some((f) => f.path.includes('renamed')));

  // Same-user project chats share both locking and one quota budget.
  let unlock;
  let held;
  const acquired = new Promise((r) => { held = r; });
  const order = [];
  const first = withChatLock(a1, async () => { order.push('first'); held(); await new Promise((r) => { unlock = r; }); });
  await acquired;
  const second = writeWorkspaceFile(a2, 'queued.txt', 'queued').then(() => order.push('second'));
  const cancelled = new AbortController();
  const sandbox = runInSandbox({ chatId: a2, userId: 'alice', command: 'exit 0', signal: cancelled.signal });
  const sandboxStopped = assert.rejects(sandbox, (e) => e.name === 'AbortError');
  cancelled.abort();
  await writeWorkspaceFile(b1, 'independent.txt', 'other user');
  await tick();
  assert.deepEqual(order, ['first']);
  unlock();
  await Promise.all([first, second, sandboxStopped]);
  assert.deepEqual(order, ['first', 'second']);
  for (let i = listWorkspace(a1).files.length; i < 9; i++) await writeWorkspaceFile(a1, `quota-${i}.txt`, 'x');
  const competing = await Promise.allSettled([writeWorkspaceFile(a1, 'quota-a.txt', 'a'), writeWorkspaceFile(a2, 'quota-b.txt', 'b')]);
  assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(competing.find((r) => r.status === 'rejected').reason.statusCode, 413);
  assert.equal(listWorkspace(a1).files.length, 10);
  ok(await request('DELETE', `/api/chats/${a2}/workspace/file?path=queued.txt`));

  const sharedRoot = workspaceRoot(a1);
  await withWorkspaceScope(a1, async () => {
    ok(await request('PATCH', `/api/projects/${p.id}`, { sharedWorkspace: false }));
    await tick();
    assert.equal(workspaceRoot(a1), sharedRoot, 'in-flight work keeps its original scope');
    await writeWorkspaceFile(a1, 'pinned.txt', 'old scope');
  });
  assert.equal(workspaceRoot(a1), privateWorkspaceRoot(a1));
  assert.equal(await read(a1, 'private.md'), 'Original private file');
  assert.equal((await put(a1, 'shared.md', 'stale shared editor', sharedKey)).statusCode, 409);
  assert.equal((await list(a2)).files.length, 0);
  assert(fs.existsSync(path.join(sharedRoot, 'pinned.txt')));
  const storage = allWorkspacesBytes();
  const expectedBytes = (root) => fs.readdirSync(root, { withFileTypes: true }).reduce((sum, item) => {
    const p = path.join(root, item.name);
    return sum + (item.isDirectory() ? expectedBytes(p) : fs.statSync(p).size);
  }, 0);
  assert.equal(storage.bytes, expectedBytes(path.join(temp, 'workspaces')) + expectedBytes(path.join(temp, 'project-workspaces')));
  assert.equal(storage.chats, 3, 'one private directory and two per-user project directories, counted once');
  sweepOrphanWorkspaces();
  assert(fs.existsSync(path.join(sharedRoot, 'shared.md')), 'disabled shared workspaces survive startup cleanup');
  ok(await request('PATCH', `/api/projects/${p.id}`, { sharedWorkspace: true }));
  assert.equal(await read(a2, 'shared.md'), 'Second draft');
  ok(await request('PATCH', `/api/chats/${a2}`, { projectId: q.id }));
  assert.equal((await list(a2)).scopeKey, (await list(other)).scopeKey);
  assert.equal((await list(a2)).files.length, 0);
  ok(await request('PATCH', `/api/chats/${a2}`, { projectId: p.id }));

  ok(await request('DELETE', `/api/chats/${a1}`));
  assert.equal(await read(a2, 'shared.md'), 'Second draft');
  assert(!fs.existsSync(privateWorkspaceRoot(a1)), 'chat deletion removes only its private directory');
  ok(await request('DELETE', `/api/chats/${a2}`));
  sweepOrphanWorkspaces();
  assert(fs.existsSync(sharedRoot), 'deleting the last chat keeps project files');
  const a3 = await newChat(p.id);
  assert.equal(await read(a3, 'shared.md'), 'Second draft');
  ok(await request('PUT', `/api/projects/${p.id}/sharing`, { accessMode: 'private', members: [] }));
  assert.equal((await list(b1, 'bob')).scope, 'chat', 'revoked project access cannot resolve its shared scope');
  db.delete(schema.users).where(eq(schema.users.id, 'bob')).run();
  sweepOrphanWorkspaces();
  assert(!fs.existsSync(projectWorkspaceRoot(p.id, 'bob')));
  assert(fs.existsSync(sharedRoot));
  ok(await request('DELETE', `/api/projects/${p.id}`));
  assert(!fs.existsSync(projectWorkspaceRoot(p.id)));
  assert.equal(ok(await request('GET', `/api/chats/${a3}`)).chat.projectId, null);
  assert.equal((await list(a3)).scope, 'chat');

  // Upgrade recovery: already-enabled projects import all old private files,
  // preserve every conflicting version, and survive a fresh server process.
  const recovery = ok(await request('POST', '/api/projects', { name: 'Import existing files' })).project;
  ok(await request('PUT', `/api/projects/${recovery.id}/sharing`, { accessMode: 'restricted', members: [{ userId: 'admin', role: 'editor' }] }));
  const c1 = await newChat(recovery.id), c2 = await newChat(recovery.id), c3 = await newChat(recovery.id, 'admin');
  for (const [id, version] of [[c1, 'First private version'], [c2, 'Second private version']]) {
    ok(await put(id, 'notes.md', version));
    ok(await put(id, 'same.md', 'Identical in both chats'));
    for (let i = 0; i < 5; i++) ok(await put(id, `${id === c1 ? 'alpha' : 'beta'}-${i}.txt`, `File ${i}`));
  }
  ok(await put(c1, 'nested/readme.md', 'Nested file'));
  ok(await put(c1, 'collision.txt', 'File at directory path'));
  ok(await put(c2, 'collision.txt/deep.md', 'File under conflicting directory'));
  await writeWorkspaceFile(c2, 'binary.bin', Buffer.from([0, 255, 42, 128]));
  ok(await put(c3, 'admin-private.md', 'Another member only', undefined, 'admin'));
  const root = projectWorkspaceRoot(recovery.id, 'alice');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'notes.md'), 'Existing shared version');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'Untouched');
  fs.symlinkSync(outside, path.join(privateWorkspaceRoot(c1), 'escape'));
  fs.symlinkSync(outside, path.join(root, 'nested'));
  // Simulate the state written by the previous release, without a new toggle.
  db.update(schema.projects).set({ sharedWorkspace: 1 }).where(eq(schema.projects.id, recovery.id)).run();
  const imported = await list(c2);
  assert.equal(imported.files.length, 18, 'all merged files remain listed even above the configured quota');
  assert.equal(await read(c1, 'notes.md'), 'Existing shared version');
  const contents = await Promise.all(imported.files.filter((f) => f.path.endsWith('.md')).map((f) => read(c2, f.path)));
  for (const version of ['First private version', 'Second private version', 'Nested file', 'File under conflicting directory']) assert(contents.includes(version), version);
  assert.equal(imported.files.filter((f) => f.path === 'same.md').length, 1);
  assert.deepEqual((await request('GET', `/api/chats/${c1}/workspace/file?path=binary.bin`)).rawPayload, Buffer.from([0, 255, 42, 128]));
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'Untouched');
  assert(!imported.files.some((f) => f.path.includes('admin-private') || f.path.includes('sentinel')));
  assert.equal(await read(c3, 'admin-private.md', 'admin'), 'Another member only');
  assert.equal((await list(c3, 'admin')).files.length, 1);
  assert.equal((await put(c1, 'over-quota.txt', 'Blocked')).statusCode, 413);
  // Simulate a crash after copies were committed but before the import ledger.
  fs.writeFileSync(path.join(temp, 'workspace-imports', recovery.id, 'alice.json'), '[]');
  assert.deepEqual((await list(c1)).files.map((f) => f.path), imported.files.map((f) => f.path));
  for (const file of imported.files.filter((f) => /^(alpha|beta)-/.test(f.path))) {
    ok(await request('DELETE', `/api/chats/${c1}/workspace/file?path=${file.path}`));
  }
  assert.equal((await list(c2)).files.length, 8, 'deleted imports stay deleted');
  ok(await put(c2, 'notes.md', 'Edited shared version'));
  ok(await request('POST', `/api/chats/${c1}/workspace/rename`, { from: 'same.md', to: 'renamed.md' }));
  const beforeRestart = (await list(c2)).files.map((f) => f.path);
  const restart = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify-restart', c1], { env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(restart.status, 0, restart.stderr || restart.stdout);
  assert.deepEqual(JSON.parse(restart.stdout).files.map((f) => f.path), beforeRestart);
  assert.equal(await read(c1, 'notes.md'), 'Edited shared version');
  ok(await request('PATCH', `/api/projects/${recovery.id}`, { sharedWorkspace: false }));
  assert.equal(await read(c1, 'notes.md'), 'First private version');
  ok(await put(c1, 'notes.md', 'New private revision'));
  ok(await request('PATCH', `/api/projects/${recovery.id}`, { sharedWorkspace: true }));
  assert.equal(await read(c2, 'notes.md'), 'Edited shared version');
  const revised = (await list(c1)).files;
  assert.equal(revised.length, 9);
  assert((await Promise.all(revised.filter((f) => f.path.endsWith('.md')).map((f) => read(c1, f.path)))).includes('New private revision'));
  // Wait for an in-flight private writer before importing its completed file.
  ok(await request('PATCH', `/api/projects/${recovery.id}`, { sharedWorkspace: false }));
  let releasePrivate, privateReady;
  const readyPrivate = new Promise((resolve) => { privateReady = resolve; });
  const writer = withChatLock(c1, async () => {
    privateReady();
    await new Promise((resolve) => { releasePrivate = resolve; });
    fs.writeFileSync(path.join(privateWorkspaceRoot(c1), 'late.md'), 'Finished before import');
  });
  await readyPrivate;
  ok(await request('PATCH', `/api/projects/${recovery.id}`, { sharedWorkspace: true }));
  let importFinished = false;
  const pendingListing = list(c2).then((r) => { importFinished = true; return r; });
  await tick();
  assert.equal(importFinished, false);
  releasePrivate();
  await writer;
  await pendingListing;
  assert.equal(await read(c2, 'late.md'), 'Finished before import');
  const moved = await newChat(null);
  ok(await put(moved, 'moved.md', 'Existing file in moved chat'));
  ok(await request('PATCH', `/api/chats/${moved}`, { projectId: recovery.id }));
  assert.equal(await read(c1, 'moved.md'), 'Existing file in moved chat');
  ok(await request('DELETE', `/api/projects/${recovery.id}`));
  assert(!fs.existsSync(path.join(temp, 'workspace-imports', recovery.id)));
  assert.equal(await read(c1, 'notes.md'), 'New private revision');
  console.log('Workspace import regression passed: legacy recovery, content and directory collisions, binary files, member isolation, symlink isolation, quota preservation, crash retries, restart/toggle idempotence, shared edits/deletes/renames, private revisions, in-flight writes and moved chats.');
  console.log('Project workspace regression passed: default/owner settings, same-user cross-chat files, member/project isolation, model/subagent tools, uploads/rename/download/delete, stale-scope rejection, shared lock/quota, cancellation while waiting for the sandbox lock, pinned async work, toggle preservation, move/delete/orphan cleanup and storage accounting.');
} finally {
  adapter.streamChat = originalStream;
  await app.close();
  rawDb.close();
  for (const [name, original] of originals) fs[name] = original;
  fs.rmSync(temp, { recursive: true, force: true });
}
