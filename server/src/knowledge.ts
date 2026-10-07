import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { rawDb } from './db/index.js';
import type { ToolDef } from './types.js';

// Project knowledge, retrieval side. A turn loads as many whole documents as
// the model's context comfortably holds (routes/projects.ts); the rest are
// listed in a manifest and fetched on demand through these tools — the same
// pattern the first-party Claude/ChatGPT project features use. The sandbox
// additionally sees every document as a read-only file under /project.

const CHUNK_CHARS = 1200;
const SEARCH_LIMIT = 8;
const SEARCH_RESULT_CAP = 12_000; // chars of snippets per tool call
const READ_WINDOW = 15_000; // chars per project_read_doc call
const MAX_TERMS = 16;

/** Below this a tool round-trip costs more than just shipping the text. */
export const PROJECT_INJECT_MIN_CHARS = 6_000;

// ---- how much to load whole ----

/** Approximate context window, in tokens, by model id. Only sizes how much
    project text rides along whole — a guess on the low side is harmless (the
    rest stays searchable), one on the high side costs tokens. Gateway
    prefixes (`openai/gpt-5`) and Claude Code's `[1m]` suffix are understood. */
export function contextWindowTokens(modelId: string): number {
  const raw = modelId.toLowerCase();
  const id = raw.replace(/^.*\//, '');
  if (raw.includes('[1m]')) return 1_000_000;
  if (/claude-(opus|sonnet)-4[-.][6-9]|claude-(opus|sonnet|fable|mythos)-[5-9]/.test(id)) return 1_000_000;
  if (id.includes('claude')) return 200_000;
  if (/gemini-(1\.5|[2-9])/.test(id)) return 1_000_000;
  if (/gpt-4\.1/.test(id)) return 1_000_000;
  if (/gpt-5/.test(id)) return 400_000;
  if (/^o[1-9]/.test(id)) return 200_000;
  if (/grok-4/.test(id)) return 256_000;
  return 128_000;
}

/** Characters of project text a turn on this model may load whole: ~15% of
    the context, within the operator's PROJECT_INJECT_MAX_CHARS. Chinese runs
    about one character per token on current tokenizers (English ~3), so the
    budget counts characters as tokens to stay safe for Chinese corpora. */
export function projectInjectBudget(modelId: string): number {
  const byContext = Math.floor(contextWindowTokens(modelId) * 0.15);
  return Math.min(config.projectInjectMaxChars, Math.max(PROJECT_INJECT_MIN_CHARS, byContext));
}

// ---- chunks & search ----

interface Chunk { offset: number; text: string }

/** Paragraph-friendly chunking that keeps each chunk's character offset in
    the original document, so a search hit can be read in context. */
function chunkDoc(content: string): Chunk[] {
  const out: Chunk[] = [];
  let pos = 0;
  while (pos < content.length) {
    let end = Math.min(content.length, pos + CHUNK_CHARS);
    if (end < content.length) {
      const slice = content.slice(pos, end);
      let cut = slice.lastIndexOf('\n\n');
      if (cut < CHUNK_CHARS * 0.4) cut = slice.lastIndexOf('\n');
      if (cut < CHUNK_CHARS * 0.4) cut = CHUNK_CHARS;
      end = pos + cut;
    }
    const raw = content.slice(pos, end);
    const text = raw.trim();
    if (text) out.push({ offset: pos + (raw.length - raw.trimStart().length), text });
    pos = end;
  }
  return out;
}

const SEPARATORS = /[\s,，。、;；:：!！?？"“”'‘’()（）【】[\]{}<>《》|/\\·…]+/;
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]{3,}/g;

/** Query → terms, plus the overlapping two-character pieces of longer CJK
    terms: written Chinese has no spaces, so 「差旅报销」 must still find
    「差旅费报销」. */
function queryTerms(query: string): { terms: string[]; grams: string[][] } {
  const terms = [...new Set(query.toLowerCase().split(SEPARATORS).filter(Boolean))].slice(0, MAX_TERMS);
  const grams = terms.map((t) => {
    const out = new Set<string>();
    for (const run of t.match(CJK_RUN) ?? []) {
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
    }
    return [...out];
  });
  return { terms, grams };
}

function occurrences(hay: string, needle: string, cap = 8): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** A document's citation handle: the first 8 hex digits of its id. Stable
    across turns (unlike a per-turn index), short enough for a model to copy,
    and what `[名称](doc:ref)` links in replies point at. */
export function docRef(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/** How the model is asked to cite project documents. */
export const DOC_CITE_RULE = '引用资料时,在依据它的句子末尾用 Markdown 链接标注出处:[文档名](doc:ref),ref 是该文档的编号,例如「……须在 30 日内完成[合同.md](doc:1a2b3c4d)」。界面会把它显示成可点开的资料标签;只标注真正用到的资料,不要编造编号,不要在文末再罗列。';

interface Hit { name: string; ref: string; offset: number; text: string; docChars: number }

/** Ranks chunks by query terms weighted by rarity (idf) and term frequency,
    then by how much of the query a chunk covers. A project's corpus is capped
    at a few MB, so scoring every chunk in memory is fast and — unlike a
    trigram index — handles one- and two-character Chinese terms. */
function searchDocs(projectId: string, query: string): Hit[] {
  const { terms, grams } = queryTerms(query);
  if (!terms.length) return [];
  const docs = rawDb.prepare('SELECT id, name, content FROM project_docs WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as { id: string; name: string; content: string }[];
  const chunks = docs.flatMap((d) => chunkDoc(d.content).map((c) => ({
    ...c, name: d.name, ref: docRef(d.id), lowerName: d.name.toLowerCase(), lower: c.text.toLowerCase(), docChars: d.content.length,
  })));
  if (!chunks.length) return [];
  const idf = (key: string) => {
    let df = 0;
    for (const c of chunks) if (c.lower.includes(key)) df++;
    return df ? Math.log(1 + chunks.length / df) : 0;
  };
  const termIdf = terms.map(idf);
  const gramIdf = grams.map((g) => g.map(idf));
  const sat = (tf: number) => (tf * 2.2) / (tf + 1.2);

  const scored = chunks.map((c) => {
    let score = 0;
    let covered = 0;
    terms.forEach((t, k) => {
      const weight = t.length === 1 ? 0.3 : 1;
      const tf = termIdf[k] ? occurrences(c.lower, t) : 0;
      if (tf) { score += weight * termIdf[k] * sat(tf); covered += 1; }
      if (termIdf[k] && c.lowerName.includes(t)) score += 0.5 * termIdf[k];
      if (!tf && grams[k].length) {
        let present = 0;
        grams[k].forEach((g, j) => {
          const gtf = gramIdf[k][j] ? occurrences(c.lower, g) : 0;
          if (gtf) { present++; score += 0.45 * gramIdf[k][j] * sat(gtf); }
        });
        if (present * 2 >= grams[k].length) covered += 0.5;
      }
    });
    return { c, score: score * (0.5 + covered / terms.length) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  return scored.slice(0, SEARCH_LIMIT).map(({ c }) => ({ name: c.name, ref: c.ref, offset: c.offset, text: c.text, docChars: c.docChars }));
}

// ---- tools ----

export const PROJECT_TOOL_DEFS: ToolDef[] = [
  {
    name: 'project_search',
    description: '在当前项目的参考资料中检索,返回最相关的片段、所属文档名和字符位置。用几个关键词或短语查询(空格分隔),中文不必分词;一次没搜到可以换近义词再试。需要片段前后文时,用 project_read_doc 从给出的位置读取原文。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词或短语,多个用空格分隔' } },
      required: ['query'],
    },
  },
  {
    name: 'project_read_doc',
    description: '按文档名读取项目参考资料的原文。长文档分段返回,响应里会给出继续读取所需的 offset;从检索结果跳读时,offset 可以设为片段位置之前一点。',
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
    if (!hits.length) return { result: `没有找到与「${query}」相关的内容。可以换个说法或拆成更短的关键词,也可以用 project_read_doc 直接读取某个文档。`, isError: false };
    const parts: string[] = [];
    let used = 0;
    for (const h of hits) {
      const block = `【${h.name} · ref ${h.ref} · 第 ${h.offset}–${h.offset + h.text.length} 字符 / 共 ${h.docChars} 字符】\n${h.text}`;
      if (used + block.length > SEARCH_RESULT_CAP) break;
      parts.push(block);
      used += block.length;
    }
    return { result: `${parts.join('\n\n---\n\n')}\n\n(需要上下文时,用 project_read_doc 传文档名和 offset 读取原文)`, isError: false };
  }

  if (name === 'project_read_doc') {
    const docName = typeof args.name === 'string' ? args.name.trim() : '';
    const offset = Number.isInteger(args.offset) && (args.offset as number) > 0 ? args.offset as number : 0;
    if (!docName) return { result: '缺少 name 参数', isError: true };
    const rows = rawDb.prepare('SELECT id, name, content FROM project_docs WHERE project_id = ?')
      .all(projectId) as { id: string; name: string; content: string }[];
    const doc = rows.find((r) => r.name === docName)
      ?? rows.find((r) => r.name.includes(docName) || docName.includes(r.name));
    if (!doc) {
      const names = rows.map((r) => r.name).join('、') || '(项目没有任何文档)';
      return { result: `没有名为「${docName}」的文档。可用文档:${names}`, isError: true };
    }
    const slice = doc.content.slice(offset, offset + READ_WINDOW);
    if (!slice) return { result: `offset ${offset} 超出文档长度(共 ${doc.content.length} 字符)`, isError: true };
    const end = offset + slice.length;
    const header = `【${doc.name} · ref ${docRef(doc.id)}】第 ${offset}–${end} 字符,共 ${doc.content.length} 字符`;
    const footer = end < doc.content.length ? `\n\n(未完,继续读取请传 offset=${end})` : '\n\n(已到文档末尾)';
    return { result: `${header}\n\n${slice}${footer}`, isError: false };
  }

  return { result: `未知的项目工具「${name}」`, isError: true };
}

// ---- sandbox files ----

const FILES_ROOT = path.join(config.dataDir, 'sandbox', 'project-files');
/** A version unused this long can go: no command runs longer than the sandbox cap. */
const STALE_MS = (config.maxSandboxTimeoutSec + 60) * 1000;

/** A document name as a file name: no path separators or control characters,
    not hidden, at most 200 bytes, unique (case-insensitively) in the folder. */
function fileNameFor(name: string, used: Set<string>): string {
  const clean = name.normalize('NFC').replace(/[/\\\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').trim() || 'document';
  const ext = path.extname(clean).slice(0, 16);
  let stem = clean.slice(0, clean.length - ext.length) || 'document';
  while (stem.length > 1 && Buffer.byteLength(stem + ext) > 200) stem = stem.slice(0, -1);
  let candidate = stem + ext;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The project's documents as files, for a read-only /project mount in the
    sandbox. Written once per content version (a hash of every document), so
    repeated commands reuse the directory; null when the project has none. */
export function projectFilesDir(projectId: string): string | null {
  const docs = rawDb.prepare('SELECT id, name, content FROM project_docs WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as { id: string; name: string; content: string }[];
  if (!docs.length) return null;
  const hash = createHash('sha256');
  for (const d of docs) hash.update(d.id).update('\0').update(d.name).update('\0').update(d.content).update('\0');
  const prefix = `${projectId.replace(/[^a-zA-Z0-9-]/g, '')}-`;
  const dir = path.join(FILES_ROOT, `${prefix}${hash.digest('hex').slice(0, 16)}`);
  if (fs.existsSync(dir)) {
    // mtime marks "last used": a newer version only sweeps this one once idle.
    const t = new Date();
    try { fs.utimesSync(dir, t, t); } catch { /* best effort */ }
    return dir;
  }

  fs.mkdirSync(FILES_ROOT, { recursive: true, mode: 0o700 });
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    const used = new Set<string>();
    for (const d of docs) fs.writeFileSync(path.join(tmp, fileNameFor(d.name, used)), d.content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(dir)) throw err; // otherwise a concurrent writer won the rename
  }
  for (const entry of fs.readdirSync(FILES_ROOT)) {
    const full = path.join(FILES_ROOT, entry);
    if (!entry.startsWith(prefix) || full === dir) continue;
    try { if (Date.now() - fs.statSync(full).mtimeMs > STALE_MS) fs.rmSync(full, { recursive: true, force: true }); } catch { /* raced */ }
  }
  return dir;
}

export function removeProjectFiles(projectId: string) {
  const prefix = `${projectId.replace(/[^a-zA-Z0-9-]/g, '')}-`;
  if (!fs.existsSync(FILES_ROOT)) return;
  for (const entry of fs.readdirSync(FILES_ROOT)) {
    if (entry.startsWith(prefix)) fs.rmSync(path.join(FILES_ROOT, entry), { recursive: true, force: true });
  }
}

/** Startup: the FTS5 index older versions kept is no longer read (search
    scores chunks directly), and file copies of deleted projects go away. */
export function initProjectKnowledge() {
  rawDb.exec('DROP TABLE IF EXISTS project_docs_fts');
  if (!fs.existsSync(FILES_ROOT)) return;
  const live = new Set((rawDb.prepare('SELECT id FROM projects').all() as { id: string }[])
    .map((p) => `${p.id.replace(/[^a-zA-Z0-9-]/g, '')}-`));
  for (const entry of fs.readdirSync(FILES_ROOT)) {
    const id = entry.replace(/[0-9a-f]{16}(\.tmp-.*)?$/, '');
    if (!live.has(id) || entry.includes('.tmp-')) fs.rmSync(path.join(FILES_ROOT, entry), { recursive: true, force: true });
  }
}
