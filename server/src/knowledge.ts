import { rawDb } from './db/index.js';
import type { ToolDef } from './types.js';

// Project-knowledge retrieval (tier 2). Docs are chunked into an FTS5 index;
// when a project's corpus is too big to inject, the model gets a manifest plus
// these two tools and decides per turn what to fetch — the same on-demand
// pattern the first-party Claude/ChatGPT project features use.
//
// FTS5 is a virtual table, which drizzle can't model — it lives outside the
// migration journal and is (re)built idempotently at startup.

const CHUNK_CHARS = 1200;
const SEARCH_LIMIT = 8;
const SEARCH_RESULT_CAP = 12_000; // chars of snippets per tool call
const READ_WINDOW = 15_000; // chars per project_read_doc call

export function initKnowledgeIndex() {
  // trigram tokenizer: substring matching that works for CJK text, where the
  // default unicode61 tokenizer would treat whole sentences as single tokens.
  rawDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS project_docs_fts USING fts5(
    content, doc_id UNINDEXED, project_id UNINDEXED, name UNINDEXED, seq UNINDEXED,
    tokenize='trigram'
  )`);
  // Backfill docs uploaded before this index existed (or after a manual wipe).
  const docs = rawDb.prepare('SELECT count(*) AS n FROM project_docs').get() as { n: number };
  const indexed = rawDb.prepare('SELECT count(DISTINCT doc_id) AS n FROM project_docs_fts').get() as { n: number };
  if (docs.n !== indexed.n) {
    rawDb.prepare('DELETE FROM project_docs_fts').run();
    const rows = rawDb.prepare('SELECT id, project_id, name, content FROM project_docs').all() as
      { id: string; project_id: string; name: string; content: string }[];
    for (const d of rows) indexDoc(d.id, d.project_id, d.name, d.content);
  }
}

/** Paragraph-friendly chunking: prefer blank-line breaks, then newlines, then
    a hard cut — a chunk should read as a coherent passage, not a random slice. */
function chunkText(content: string): string[] {
  const out: string[] = [];
  let rest = content;
  while (rest.length > CHUNK_CHARS) {
    const slice = rest.slice(0, CHUNK_CHARS);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < CHUNK_CHARS * 0.4) cut = slice.lastIndexOf('\n');
    if (cut < CHUNK_CHARS * 0.4) cut = CHUNK_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

export function indexDoc(docId: string, projectId: string, name: string, content: string) {
  const insert = rawDb.prepare(
    'INSERT INTO project_docs_fts (content, doc_id, project_id, name, seq) VALUES (?, ?, ?, ?, ?)',
  );
  const chunks = chunkText(content);
  const tx = rawDb.transaction(() => {
    chunks.forEach((c, i) => insert.run(c, docId, projectId, name, i + 1));
  });
  tx();
}

export function removeDocIndex(docId: string) {
  rawDb.prepare('DELETE FROM project_docs_fts WHERE doc_id = ?').run(docId);
}

export function removeProjectIndex(projectId: string) {
  rawDb.prepare('DELETE FROM project_docs_fts WHERE project_id = ?').run(projectId);
}

interface Hit { name: string; seq: number; content: string }

function searchDocs(projectId: string, query: string): Hit[] {
  const q = query.trim();
  if (!q) return [];
  // OR the whitespace-separated terms so multi-keyword queries rank by bm25
  // instead of requiring an exact phrase.
  const terms = q.split(/\s+/).filter((t) => t.length >= 3);
  if (terms.length) {
    const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    try {
      const rows = rawDb.prepare(
        `SELECT name, seq, content FROM project_docs_fts
         WHERE project_docs_fts MATCH ? AND project_id = ?
         ORDER BY bm25(project_docs_fts) LIMIT ?`,
      ).all(match, projectId, SEARCH_LIMIT) as Hit[];
      if (rows.length) return rows;
    } catch { /* malformed query → fall through to LIKE */ }
  }
  // trigram needs ≥3 chars per token; two-character Chinese terms are everyday
  // queries, so a LIKE scan is the correctness fallback (corpus is small).
  const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return rawDb.prepare(
    `SELECT name, seq, content FROM project_docs_fts
     WHERE project_id = ? AND content LIKE ? ESCAPE '\\' LIMIT ?`,
  ).all(projectId, `%${esc}%`, SEARCH_LIMIT) as Hit[];
}

export const PROJECT_TOOL_DEFS: ToolDef[] = [
  {
    name: 'project_search',
    description: '在当前项目的参考资料中全文检索,返回最相关的片段及其所属文档名。查询用关键词或短语;一次没搜到可以换近义词再试。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词或短语' } },
      required: ['query'],
    },
  },
  {
    name: 'project_read_doc',
    description: '按文档名读取项目参考资料的原文。长文档分段返回,响应里会给出继续读取所需的 offset。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文档名,须与资料清单中的名称一致' },
        offset: { type: 'integer', description: '起始字符位置,默认 0' },
      },
      required: ['name'],
    },
  },
];

export function isProjectTool(name: string): boolean {
  return name === 'project_search' || name === 'project_read_doc';
}

export function callProjectTool(
  projectId: string,
  name: string,
  argsJson: string,
): { result: string; isError: boolean } {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* treated as empty */ }

  if (name === 'project_search') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return { result: '缺少 query 参数', isError: true };
    const hits = searchDocs(projectId, query);
    if (!hits.length) return { result: `没有找到与「${query}」相关的内容。可以换个关键词,或用 project_read_doc 直接读取某个文档。`, isError: false };
    const parts: string[] = [];
    let used = 0;
    for (const h of hits) {
      const block = `【${h.name} · 片段${h.seq}】\n${h.content}`;
      if (used + block.length > SEARCH_RESULT_CAP) break;
      parts.push(block);
      used += block.length;
    }
    return { result: parts.join('\n\n---\n\n'), isError: false };
  }

  if (name === 'project_read_doc') {
    const docName = typeof args.name === 'string' ? args.name.trim() : '';
    const offset = Number.isInteger(args.offset) && (args.offset as number) > 0 ? args.offset as number : 0;
    if (!docName) return { result: '缺少 name 参数', isError: true };
    const rows = rawDb.prepare('SELECT name, content FROM project_docs WHERE project_id = ?')
      .all(projectId) as { name: string; content: string }[];
    const doc = rows.find((r) => r.name === docName)
      ?? rows.find((r) => r.name.includes(docName) || docName.includes(r.name));
    if (!doc) {
      const names = rows.map((r) => r.name).join('、') || '(项目没有任何文档)';
      return { result: `没有名为「${docName}」的文档。可用文档:${names}`, isError: true };
    }
    const slice = doc.content.slice(offset, offset + READ_WINDOW);
    if (!slice) return { result: `offset ${offset} 超出文档长度(共 ${doc.content.length} 字符)`, isError: true };
    const end = offset + slice.length;
    const header = `【${doc.name}】第 ${offset}–${end} 字符,共 ${doc.content.length} 字符`;
    const footer = end < doc.content.length ? `\n\n(未完,继续读取请传 offset=${end})` : '\n\n(已到文档末尾)';
    return { result: `${header}\n\n${slice}${footer}`, isError: false };
  }

  return { result: `未知的项目工具「${name}」`, isError: true };
}
