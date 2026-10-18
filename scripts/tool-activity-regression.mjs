// The chat's activity rows name the project documents a reply read or
// searched, parsed from the headers the server writes on those tool results.
// Feed real results from the built server through the client parser so the
// two formats can't drift apart. Temporary DATA_DIR; never calls a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { docHits, docKey, docNamesIn, docRead, isNoHits } from '../web/src/projectDocTools.ts';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-tool-activity-'));
process.env.SECRET_KEY = 'tool-activity-regression';
process.env.PROJECT_INJECT_MAX_CHARS = '0';
const { db, schema, runMigrations } = await import('../server/dist/db/index.js');
const { callProjectTool, ProjectKnowledgeSession } = await import('../server/dist/knowledge.js');
const { ProjectLibrarySession, LIBRARY_SEARCH, LIBRARY_READ } = await import('../server/dist/project-library.js');

runMigrations();
const at = Date.now();
db.insert(schema.users).values({ id: 'alice', username: 'alice', passwordHash: 'unused', role: 'user', createdAt: at }).run();
const projectId = '11111111-2222-3333-4444-555555555555';
const libraryId = '66666666-7777-8888-9999-000000000000';
db.insert(schema.projects).values({ id: projectId, userId: 'alice', name: '当前项目', createdAt: at, updatedAt: at }).run();
db.insert(schema.projects).values({ id: libraryId, userId: 'alice', name: '法务 · 资料库', crossProjectSearch: 1, createdAt: at, updatedAt: at + 1 }).run();
const contractId = 'aaaaaaaa-1111-2222-3333-444444444444';
const scheduleId = 'bbbbbbbb-1111-2222-3333-444444444444';
const filler = (n) => Array.from({ length: n }, (_, i) => `第${i + 1}段:与主题无关的填充内容。\n`).join('');
// Separators and brackets the headers use themselves, inside the names.
const contractName = '合同 · 2026【草稿】.md';
const contract = `${filler(200)}第七条 违约金按日万分之五计算。\n${filler(200)}`;
const schedule = '付款计划:违约金另行约定,付款期限为 2026-03-31。\n';
const addDoc = (id, project, name, content, n) => db.insert(schema.projectDocs).values({ id, projectId: project, name, content, chars: content.length, createdAt: at + n }).run();
addDoc(contractId, projectId, contractName, contract, 1);
addDoc(scheduleId, projectId, '附件一 付款计划.docx', schedule, 2);
addDoc('cccccccc-1111-2222-3333-444444444444', libraryId, '采购 · 框架协议.md', `${filler(5)}框架协议约定质保金。\n`, 3);

let n = 0;
const call = (name, args) => ({ type: 'tool_call', id: `c${++n}`, name, args: JSON.stringify(args) });
const answer = (c, r) => ({ type: 'tool_result', toolCallId: c.id, name: c.name, result: r.result, isError: r.isError });
const run = (name, args, session = null) => {
  const c = call(name, args);
  return [c, answer(c, session ? session.call(projectId, name, c.args) : callProjectTool(projectId, name, c.args))];
};
const none = new Map();
const ref8 = (id) => id.replace(/-/g, '').slice(0, 8);

// A read by name: document, short ref and the exact range.
const [byName, byNameResult] = run('project_read_doc', { name: contractName, offset: 100, max_chars: 500 });
assert.deepEqual(docRead(byName, byNameResult, none),
  { project: undefined, name: contractName, ref: ref8(contractId), range: { start: 100, end: 600, total: contract.length } });

// A whole short document read by its full ref.
const [byRef, byRefResult] = run('project_read_doc', { ref: scheduleId.replace(/-/g, '') });
const whole = docRead(byRef, byRefResult, none);
assert.equal(whole.name, '附件一 付款计划.docx');
assert.equal(whole.ref, scheduleId.replace(/-/g, ''));
assert.equal(docKey(whole.ref), ref8(scheduleId));
assert.deepEqual(whole.range, { start: 0, end: schedule.length, total: schedule.length });

// A search names every document it quoted, once each, in result order.
const [, searchResult] = run('project_search', { query: '违约金', limit: 8 });
assert.deepEqual(docHits(searchResult).map((h) => [h.name, h.ref]).sort(),
  [[contractName, ref8(contractId)], ['附件一 付款计划.docx', ref8(scheduleId)]].sort());
assert.equal(isNoHits(searchResult), false);
const [, missResult] = run('project_search', { query: '量子纠缠' });
assert.deepEqual(docHits(missResult), []);
assert.equal(isNoHits(missResult), true);

// A repeated read returns a reminder without a header; the name comes from
// the earlier result in the same reply.
const session = new ProjectKnowledgeSession();
const first = run('project_read_doc', { ref: ref8(contractId) }, session);
const repeat = run('project_read_doc', { ref: ref8(contractId) }, session);
assert(!repeat[1].result.includes('【'), 'the repeat carries no header');
assert.equal(docRead(repeat[0], repeat[1], none).name, '');
const names = docNamesIn([...first, ...repeat, searchResult]);
assert.equal(docRead(repeat[0], repeat[1], names).name, contractName);
assert.equal(names.get(ref8(scheduleId)), '附件一 付款计划.docx');

// A failed read falls back to the name the model asked for.
const [missing, missingResult] = run('project_read_doc', { name: '补充协议' });
assert.equal(missingResult.isError, true);
assert.deepEqual(docRead(missing, missingResult, names), { ref: '', name: '补充协议' });

// Cross-project search and read: full refs, and the read names its project.
const library = new ProjectLibrarySession('alice', projectId);
const librarySearch = call(LIBRARY_SEARCH, { query: '质保金' });
const librarySearchResult = answer(librarySearch, library.call(LIBRARY_SEARCH, librarySearch.args));
const [libraryHit] = docHits(librarySearchResult);
assert.deepEqual(libraryHit, { name: '采购 · 框架协议.md', ref: 'cccccccc111122223333444444444444' });
const libraryRead = call(LIBRARY_READ, { project_id: libraryId, ref: libraryHit.ref, max_chars: 20 });
const libraryReadResult = answer(libraryRead, library.call(LIBRARY_READ, libraryRead.args));
const read = docRead(libraryRead, libraryReadResult, none);
assert.equal(read.project, '法务 · 资料库');
assert.equal(read.name, '采购 · 框架协议.md');
assert.equal(docKey(read.ref), 'cccccccc');
assert.equal(read.range.start, 0);
assert.equal(read.range.end, 20);
assert.equal(docNamesIn([librarySearchResult]).get('cccccccc'), '采购 · 框架协议.md');

console.log('tool activity regression passed');
