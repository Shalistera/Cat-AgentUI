// 项目资料: model-sized whole-document loading, CJK-aware search with
// offsets, sandbox file copies, and sub-agents that can see the project.
// Module checks run against a temporary DATA_DIR; the end-to-end part drives
// the built server with a local OpenAI-compatible stub. Never calls a real model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleData = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-project-mod-'));
const e2eData = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-project-e2e-'));
process.env.DATA_DIR = moduleData;
process.env.SECRET_KEY = 'project-knowledge-test-only';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const filler = (label, n) => Array.from({ length: n }, (_, i) => `${label}第${i + 1}段:这里是与主题无关的填充内容,用来把文档撑大。\n`).join('\n');
const travel = '## 差旅\n员工出差的差旅费报销标准为每天300元,超出部分需要部门负责人审批。\n';
const bigDoc = `# 员工手册\n${filler('手册', 900)}\n${travel}\n${filler('附录', 900)}\n## Budget\nAll budget approval requests go to finance.\n`;
const smallDoc = '# 项目简介\n这是一个测试项目,用来验证项目资料的加载方式。\n';
const midDoc = `# 会议纪要\n${filler('纪要', 450)}`;

let app;
let logs = '';
try {
  // ---------- module level ----------
  const { runMigrations, db, schema, now } = await import(`${root}/server/dist/db/index.js`);
  runMigrations();
  const { contextWindowTokens, projectInjectBudget, callProjectTool, projectFilesDir, removeProjectFiles, initProjectKnowledge } =
    await import(`${root}/server/dist/knowledge.js`);
  const { buildProjectPrompt } = await import(`${root}/server/dist/routes/projects.js`);
  initProjectKnowledge();

  assert.equal(contextWindowTokens('claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindowTokens('anthropic/claude-sonnet-4.6'), 1_000_000);
  assert.equal(contextWindowTokens('claude-sonnet-4-5[1m]'), 1_000_000);
  assert.equal(contextWindowTokens('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(contextWindowTokens('gemini-2.5-pro'), 1_000_000);
  assert.equal(contextWindowTokens('gpt-4o-mini'), 128_000);
  assert.equal(projectInjectBudget('gpt-4o-mini'), 19_200);
  assert.equal(projectInjectBudget('claude-opus-5-5'), 150_000);

  const owner = 'u-owner';
  for (const [id, name] of [[owner, 'owner'], ['u-other', 'other']]) {
    db.insert(schema.users).values({ id, username: name, passwordHash: 'x', role: 'user', createdAt: now() }).run();
  }
  const projectId = '11111111-2222-3333-4444-555555555555';
  db.insert(schema.projects).values({ id: projectId, userId: owner, name: 'P', instructions: '用中文回答', createdAt: now(), updatedAt: now() }).run();
  const addDoc = (id, name, content, at) => db.insert(schema.projectDocs).values({ id, projectId, name, content, chars: content.length, createdAt: at }).run();
  addDoc('d-big', '员工手册.md', bigDoc, 1);
  addDoc('d-small', '简介.md', smallDoc, 2);
  addDoc('d-mid', '会议/纪要.md', midDoc, 3);
  assert(bigDoc.length > 19_200 && midDoc.length < 19_200 && bigDoc.length + smallDoc.length + midDoc.length < 150_000);

  // 128K model: only what fits loads whole, smallest first; the rest is a manifest + tools.
  const small = buildProjectPrompt(projectId, owner, { canUseTools: true, modelId: 'gpt-4o-mini' });
  assert(small.block.startsWith('[项目指令]\n用中文回答'));
  assert(small.block.includes('<document name="简介.md">'));
  assert(!small.block.includes('<document name="员工手册.md">'));
  assert(small.block.includes('[项目资料清单]') && small.block.includes('- 员工手册.md('), small.block.slice(0, 600));
  assert(small.block.includes('目录:差旅 / Budget'), 'manifest lists headings');
  assert.deepEqual(small.tools.map((t) => t.name), ['project_search', 'project_read_doc']);
  assert.equal(small.docCount, 3);
  // 1M model: everything fits → no manifest, no tools.
  const large = buildProjectPrompt(projectId, owner, { canUseTools: true, modelId: 'claude-opus-5-5' });
  assert(large.block.includes('全部参考文档') && large.block.includes('<document name="员工手册.md">'));
  assert.equal(large.tools, null);
  // Same inputs, same bytes: the block is a cacheable prefix.
  assert.equal(buildProjectPrompt(projectId, owner, { canUseTools: true, modelId: 'gpt-4o-mini' }).block, small.block);
  // No tools: at least the old 100K allowance, and a note for what was left out.
  const noTools = buildProjectPrompt(projectId, owner, { canUseTools: false, modelId: 'gpt-4o-mini' });
  assert.equal(noTools.tools, null);
  assert(noTools.block.includes('<document name="简介.md">'));
  // No access, nothing.
  assert.deepEqual(buildProjectPrompt(projectId, 'u-other', { canUseTools: true, modelId: 'gpt-4o-mini' }), { block: null, tools: null, docCount: 0 });

  // Search: space-separated two-character Chinese terms, offsets that point at the original text.
  const hit = callProjectTool(projectId, 'project_search', JSON.stringify({ query: '差旅 报销 标准' }));
  assert(!hit.isError && hit.result.includes('每天300元'), hit.result.slice(0, 300));
  const m = hit.result.match(/【员工手册\.md · 第 (\d+)–(\d+) 字符/);
  assert(m, hit.result.slice(0, 200));
  assert(bigDoc.slice(Number(m[1]), Number(m[2])).includes('差旅费报销标准'), 'offsets point into the document');
  // No spaces and a different wording still matches through two-character pieces.
  assert(callProjectTool(projectId, 'project_search', JSON.stringify({ query: '差旅报销' })).result.startsWith('【员工手册.md'));
  assert(callProjectTool(projectId, 'project_search', JSON.stringify({ query: 'budget approval' })).result.includes('go to finance'));
  assert(callProjectTool(projectId, 'project_search', JSON.stringify({ query: '量子纠缠' })).result.startsWith('没有找到'));
  const read = callProjectTool(projectId, 'project_read_doc', JSON.stringify({ name: '员工手册.md', offset: Number(m[1]) }));
  assert(read.result.includes('每天300元') && read.result.includes(`第 ${m[1]}–`));

  // Sandbox copies: sanitized unique names, reused while unchanged, a new version after an edit.
  const dir = projectFilesDir(projectId);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['会议_纪要.md', '员工手册.md', '简介.md'].sort());
  assert.equal(fs.readFileSync(path.join(dir, '员工手册.md'), 'utf8'), bigDoc);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(projectFilesDir(projectId), dir, 'unchanged corpus reuses the directory');
  addDoc('d-dup', '简介.md', '同名文档', 4);
  const dir2 = projectFilesDir(projectId);
  assert.notEqual(dir2, dir);
  assert(fs.readdirSync(dir2).includes('简介 (2).md'), fs.readdirSync(dir2).join(','));
  assert(fs.existsSync(dir), 'a recently used version is kept for running commands');
  // The real sandbox, where this host can run it: files visible and read-only.
  const { probeSandboxEnv } = await import(`${root}/server/dist/sandbox/env.js`);
  const { runInSandbox } = await import(`${root}/server/dist/sandbox/exec.js`);
  if ((await probeSandboxEnv()).runnable) {
    const user = { id: owner, role: 'user' };
    const r = await runInSandbox({ userId: owner, user, chatId: 'chat-sbx', projectId,
      command: 'ls /project | sort; grep -rl "每天300元" /project; touch /project/x 2>/dev/null && echo writable || echo read-only' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert(r.stdout.includes('会议_纪要.md') && r.stdout.includes('/project/员工手册.md') && r.stdout.includes('read-only'), r.stdout);
    const plain = await runInSandbox({ userId: owner, user, chatId: 'chat-sbx', command: 'test -e /project && echo present || echo absent' });
    assert.equal(plain.stdout.trim(), 'absent', 'no project, no mount');
  } else {
    console.log('(sandbox not runnable on this host: /project mount not exercised)');
  }
  removeProjectFiles(projectId);
  assert(!fs.existsSync(dir) && !fs.existsSync(dir2));

  // ---------- end to end: the parent turn and a sub-agent both see the project ----------
  const mainRequests = [];
  const subRequests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url.includes('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    const body = JSON.parse(raw);
    const system = body.messages.filter((x) => x.role === 'system').map((x) => typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).join('\n');
    const tools = (body.tools ?? []).map((t) => t.function.name);
    const toolMessages = body.messages.filter((x) => x.role === 'tool');
    const base = { id: 'cmpl', object: 'chat.completion.chunk', created: 0, model: body.model };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
    const call = (name, args) => {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    };
    const say = (text) => {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    };
    if (system.includes('你是一个子代理')) {
      subRequests.push({ system, tools, toolMessages });
      if (!toolMessages.length) call('project_search', { query: '差旅 报销 标准' });
      else say('子代理结论:差旅费每天300元。');
    } else if (tools.includes('spawn_subagent')) {
      mainRequests.push({ system, tools, toolMessages });
      if (!toolMessages.length) call('spawn_subagent', { task: '阅读员工手册,找出差旅费报销标准', title: '查差旅标准' });
      else say('完成:差旅费每天300元。');
    } else {
      say('标题');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env: { ...process.env, DATA_DIR: e2eData, HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => { logs += d; }); app.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 200; i++) { if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break; await sleep(50); }
  let cookie;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-csrf': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
  await api('POST', '/api/auth/register', { username: 'projadmin', password: 'project-test-password' });
  const provider = (await api('POST', '/api/admin/providers', { name: 'stub', type: 'openai', apiKey: 'k', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })).data;
  await api('POST', '/api/admin/models', { providerId: provider.id, models: [{ modelId: 'gpt-4o-mini' }] });
  const modelId = (await api('GET', '/api/admin/providers')).data.find((p) => p.id === provider.id).models[0].id;
  assert.equal((await api('PUT', '/api/admin/agent', { subagent: { enabled: true, accessMode: 'shared', allowedUserIds: [] } })).status, 200);
  const project = (await api('POST', '/api/projects', { name: '测试项目' })).data.project;
  for (const [name, content] of [['员工手册.md', bigDoc], ['简介.md', smallDoc]]) {
    assert.equal((await api('POST', `/api/projects/${project.id}/docs`, { name, content })).status, 200);
  }
  const detail = (await api('GET', `/api/projects/${project.id}`)).data;
  assert.equal(detail.limits.injectChars, 19_200); assert.equal(detail.limits.injectCharsMax, 150_000);
  const chat = (await api('POST', '/api/chats', { modelId, projectId: project.id })).data.chat.id;
  const stream = await fetch(`${base}/api/chats/${chat}/stream`, { method: 'POST', headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ content: [{ type: 'text', text: '差旅费标准是多少?' }] }) });
  const events = await stream.text();
  assert(events.includes('完成:差旅费每天300元'), events.slice(-800));

  assert(mainRequests[0].tools.includes('project_search') && mainRequests[0].system.includes('<document name="简介.md">'));
  const sub = subRequests[0];
  assert(sub, `sub-agent never ran\n${logs.slice(-1500)}`);
  assert(sub.tools.includes('project_search') && sub.tools.includes('project_read_doc'), `sub-agent tools: ${sub.tools}`);
  assert(sub.system.includes('[项目资料清单]') && sub.system.includes('员工手册.md') && sub.system.includes('<document name="简介.md">'));
  assert(subRequests[1].toolMessages.some((t) => String(t.content).includes('每天300元')), 'sub-agent search ran against the project');
  console.log('Project knowledge regression passed: context-sized loading, manifest + tools, CJK search with offsets, sandbox copies, sub-agent access.');
} catch (err) {
  console.error(err);
  if (logs) console.error(`--- server log ---\n${logs.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await new Promise((r) => { app.once('exit', r); setTimeout(r, 2000).unref(); }); }
  fs.rmSync(moduleData, { recursive: true, force: true });
  fs.rmSync(e2eData, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
