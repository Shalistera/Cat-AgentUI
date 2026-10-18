// 项目资料 tool results as the chat shows them: which document a read opened
// and which part of it, which documents a search quoted. The headers come from
// the server (server/src/knowledge.ts, project-library.ts) and stay Chinese
// whatever the UI language; scripts/tool-activity-regression.mjs checks this
// parser against real results so the two can't drift apart.
import type { MessagePart } from './types';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>;

export const DOC_READ_TOOLS = new Set(['project_read_doc', 'project_library_read']);
export const DOC_SEARCH_TOOLS = new Set(['project_search', 'project_library_search']);

/** `[项目:p\n]【name · ref x】第 a–b 字符,共 n 字符` opens every read. */
const READ_HEAD = /^(?:项目:(.+)\n)?【(.+) · ref ([0-9a-f]{8}|[0-9a-f]{32})】第 (\d+)–(\d+) 字符,共 (\d+) 字符/;
/** `【[项目:p · project_id x · ]name · ref x · 第 a–b 字符 / 共 n 字符】` heads every search hit. */
const SEARCH_HIT = /^【(?:项目:.+? · project_id \S+ · )?(.+?) · ref ([0-9a-f]{8}|[0-9a-f]{32}) · 第 \d+–\d+ 字符 \/ 共 \d+ 字符】/gm;
const NO_HITS = /^(?:没有找到与「|允许检索的项目资料中没有相关片段)/;

export interface DocMention { ref: string; name: string }
export interface DocRead extends DocMention { project?: string; range?: { start: number; end: number; total: number } }

/** Eight- and 32-character refs name the same document. */
export const docKey = (ref: string) => ref.slice(0, 8).toLowerCase();

/** The document a read call opened and which part of it. A failed or
    repeated read has no header: its name then comes from the arguments, or
    from another result in the same reply (`docNames`). */
export function docRead(call: ToolCallPart, result: ToolResultPart | undefined, docNames: Map<string, string>): DocRead {
  const head = result && !result.isError ? READ_HEAD.exec(result.result) : null;
  if (head) {
    return { project: head[1], name: head[2], ref: head[3], range: { start: Number(head[4]), end: Number(head[5]), total: Number(head[6]) } };
  }
  let ref = '';
  let name = '';
  try {
    const a = JSON.parse(call.args || '{}') as Record<string, unknown>;
    if (typeof a.ref === 'string') ref = a.ref.trim();
    if (typeof a.name === 'string') name = a.name.trim();
  } catch { /* ignore */ }
  return { ref, name: name || (ref && docNames.get(docKey(ref))) || '' };
}

/** Documents a search quoted, in result order, each once. */
export function docHits(result: ToolResultPart): DocMention[] {
  const hits = new Map<string, DocMention>();
  for (const m of result.result.matchAll(SEARCH_HIT)) {
    if (!hits.has(docKey(m[2]))) hits.set(docKey(m[2]), { name: m[1], ref: m[2] });
  }
  return [...hits.values()];
}

/** The search ran and found nothing (as opposed to a repeat reminder). */
export function isNoHits(result: ToolResultPart): boolean {
  return !result.isError && NO_HITS.test(result.result);
}

/** ref → name for every document the reply's tool results mention. */
export function docNamesIn(parts: MessagePart[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const p of parts) {
    if (p.type !== 'tool_result' || p.isError) continue;
    if (DOC_READ_TOOLS.has(p.name)) {
      const head = READ_HEAD.exec(p.result);
      if (head) names.set(docKey(head[3]), head[2]);
    } else if (DOC_SEARCH_TOOLS.has(p.name)) {
      for (const hit of docHits(p)) names.set(docKey(hit.ref), hit.name);
    }
  }
  return names;
}
