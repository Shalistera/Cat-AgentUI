/* ---------------------------------------------------------------------------
   Tag 模式 text tools. The NovelAI V4+ prompt syntax they understand:
     {tag}        ×1.05 per layer       [tag]  ÷1.05 per layer
     1.2::tags::  a numeric weight up to the next `::` (or the end)
     Text: …      literal image text — always last, no syntax after it
   Pure string work, so scripts/nai-tags-regression.mjs can test it directly.
   ------------------------------------------------------------------------ */

export const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NUM = /^-?(?:\d+(?:\.\d*)?|\.\d+)::/;
const isSep = (c: string | undefined) => c === ',' || c === '\n';
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '　';
// A number only opens a weight when it starts a word: "v1.2::" is text.
const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}.]/u.test(c);

/** Where the literal image text begins; prompt syntax only applies before it. */
export function textStart(s: string) {
  const i = s.indexOf('Text:');
  return i < 0 ? s.length : i;
}

/* ---------- weights ---------- */

export interface WeightSpan { start: number; end: number; weight: number }
export interface Analysis {
  /** Runs whose effective weight isn't 1, brackets included. */
  spans: WeightSpan[];
  /** Positions of brackets without a partner. */
  errors: number[];
}

export function analyze(s: string): Analysis {
  const limit = textStart(s);
  const stack: { kind: '{' | '[' | 'num'; at: number; factor: number }[] = [];
  const spans: WeightSpan[] = [];
  const errors: number[] = [];
  let weight = 1;
  let from = 0;
  const shift = (at: number) => {
    const w = stack.reduce((m, f) => m * f.factor, 1);
    if (Math.abs(w - weight) < 1e-9) return;
    if (Math.abs(weight - 1) > 1e-9 && at > from) spans.push({ start: from, end: at, weight });
    weight = w;
    from = at;
  };
  for (let i = 0; i < limit;) {
    const c = s[i];
    if (c === '{' || c === '[') {
      stack.push({ kind: c, at: i, factor: c === '{' ? 1.05 : 1 / 1.05 });
      shift(i);
      i++;
    } else if (c === '}' || c === ']') {
      const top = stack[stack.length - 1];
      if (top && top.kind === (c === '}' ? '{' : '[')) { stack.pop(); shift(i + 1); } else errors.push(i);
      i++;
    } else if (c === ':' && s[i + 1] === ':') {
      let n = stack.length - 1;
      while (n >= 0 && stack[n].kind !== 'num') n--;
      // `::` closes the numeric weight, and with it anything opened inside.
      if (n >= 0) {
        for (const f of stack.splice(n)) if (f.kind !== 'num') errors.push(f.at);
        shift(i + 2);
      }
      i += 2;
    } else {
      const m = !wordChar(s[i - 1]) && /[-.\d]/.test(c) ? NUM.exec(s.slice(i, i + 24)) : null;
      if (m && i + m[0].length <= limit) {
        stack.push({ kind: 'num', at: i, factor: parseFloat(m[0]) });
        shift(i);
        i += m[0].length;
      } else i++;
    }
  }
  if (Math.abs(weight - 1) > 1e-9 && limit > from) spans.push({ start: from, end: limit, weight });
  // A numeric weight may run to the end; an unclosed bracket may not.
  for (const f of stack) if (f.kind !== 'num') errors.push(f.at);
  return { spans, errors: errors.sort((a, b) => a - b) };
}

/** Effective weight of the character just before `pos` (where the caret sits). */
export function weightAt(a: Analysis, pos: number) {
  const at = Math.max(0, pos - 1);
  return a.spans.find((s) => at >= s.start && at < s.end)?.weight ?? 1;
}

export const fmtWeight = (w: number) => String(Math.round(w * 100) / 100);

/* ---------- pieces ---------- */

type Wrap = { kind: '{' | '[' | 'num'; at: number; len: number; value: number };
/**
 * One comma- or newline-separated chunk. Brackets at its edges are either its
 * own (matched within the chunk: `{{tag}}`) or belong to a group spanning
 * several chunks (`{white hair` … `red eyes}`), which edits must leave alone.
 */
export interface Piece {
  /** Raw span between separators, surrounding spaces included. */
  start: number; end: number;
  /** The tag itself. */
  coreStart: number; coreEnd: number;
  /** The tag with its own emphasis. */
  ownStart: number; ownEnd: number;
  /** Own emphasis, outermost first. */
  own: Wrap[];
  /** Brackets at the edges that belong to an enclosing group. */
  outerOpen: number; outerClose: number;
}

function piece(s: string, start: number, end: number): Piece {
  let p = start;
  let q = end;
  const opens: Wrap[] = [];
  const closes: Wrap[] = [];
  for (;;) {
    while (p < q && isSpace(s[p])) p++;
    const c = s[p];
    if (p < q && (c === '{' || c === '[')) { opens.push({ kind: c, at: p, len: 1, value: 0 }); p++; continue; }
    const m = p < q ? NUM.exec(s.slice(p, Math.min(q, p + 24))) : null;
    if (m) { opens.push({ kind: 'num', at: p, len: m[0].length, value: parseFloat(m[0]) }); p += m[0].length; continue; }
    break;
  }
  for (;;) {
    while (q > p && isSpace(s[q - 1])) q--;
    const c = s[q - 1];
    if (q > p && (c === '}' || c === ']')) { closes.unshift({ kind: c === '}' ? '{' : '[', at: q - 1, len: 1, value: 0 }); q--; continue; }
    if (q - 2 >= p && c === ':' && s[q - 2] === ':') { closes.unshift({ kind: 'num', at: q - 2, len: 2, value: 0 }); q -= 2; continue; }
    break;
  }
  // Pair from the inside out; whatever doesn't pair belongs to an outer group.
  let i = opens.length - 1;
  let j = 0;
  while (i >= 0 && j < closes.length && opens[i].kind === closes[j].kind) { i--; j++; }
  const own = opens.slice(i + 1);
  const last = closes[j - 1];
  return {
    start, end, coreStart: p, coreEnd: q, own,
    ownStart: own.length ? own[0].at : p,
    ownEnd: last ? last.at + last.len : q,
    outerOpen: i + 1, outerClose: closes.length - j,
  };
}

export function pieces(s: string, limit = textStart(s)): Piece[] {
  const out: Piece[] = [];
  let start = 0;
  for (let i = 0; i <= limit; i++) {
    if (i < limit && !isSep(s[i])) continue;
    out.push(piece(s, start, i));
    start = i + 1;
  }
  return out;
}

export const coreOf = (s: string, p: Piece) => s.slice(p.coreStart, p.coreEnd);

/**
 * The form a tag is compared and remembered in: lowercase, single spaces,
 * Danbooru underscores as spaces — except in short emoticon tags like o_o or
 * ^_^, where the underscore is the tag. Mirrors server/src/novelai.ts.
 */
export function tagKey(raw: string) {
  let t = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t.length > 3) t = t.replace(/([\p{L}\p{N})])_+(?=[\p{L}\p{N}(])/gu, '$1 ');
  return t;
}

/** Worth remembering as a tag: short, not a sentence, not CJK. Mirrors the server. */
export function memorable(t: string) {
  const words = t.split(' ').length;
  return !!t && t.length <= 60 && words <= 6 && (/[\p{L}\p{N}]/u.test(t) || t.length <= 4)
    && !HAS_CJK.test(t) && !(words > 2 && /[.!?]$/.test(t));
}

/** The prompt's tags in their compared form (see tagKey), in order. */
export function promptTags(s: string) {
  return pieces(s).map((p) => tagKey(coreOf(s, p))).filter(memorable);
}

export function tagSet(s: string) {
  return new Set(pieces(s).map((p) => tagKey(coreOf(s, p))).filter(Boolean));
}

function balanced(s: string) {
  return analyze(s).errors.length === 0;
}

/* ---------- edits ---------- */

/** Replace [start, end) with `insert`, then select [selStart, selEnd). */
export interface Edit { start: number; end: number; insert: string; selStart: number; selEnd: number }

/** The smallest single edit turning `a` into `b`; the caret lands after the change. */
export function diffEdit(a: string, b: string): Edit {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const insert = b.slice(p, b.length - q);
  return { start: p, end: a.length - q, insert, selStart: p + insert.length, selEnd: p + insert.length };
}

const openText = (w: Wrap) => (w.kind === 'num' ? `${fmtWeight(w.value)}::` : w.kind);
const closeText = (w: Wrap) => (w.kind === 'num' ? '::' : w.kind === '{' ? '}' : ']');

/** New own emphasis one step stronger (dir 1) or weaker (-1). */
function restep(own: Wrap[], dir: 1 | -1) {
  let num: Wrap | undefined;
  for (const w of own) if (w.kind === 'num') num = w;
  let wraps: Wrap[];
  if (num) {
    // A numeric weight moves in 0.1 steps and disappears at 1.
    const next = Math.max(-3, Math.min(3, Math.round((num.value + dir * 0.1) * 100) / 100));
    wraps = own.filter((w) => w !== num || Math.abs(next - 1) > 1e-9).map((w) => (w === num ? { ...w, value: next } : w));
  } else {
    // Braces: { and [ cancel out, so [[tag]] → [tag] → tag → {tag} → {{tag}}.
    const level = own.reduce((n, w) => n + (w.kind === '{' ? 1 : -1), 0) + dir;
    const kind = level > 0 ? '{' : '[';
    wraps = Array.from({ length: Math.min(10, Math.abs(level)) }, () => ({ kind, at: 0, len: 1, value: 0 }) as Wrap);
  }
  return { open: wraps.map(openText).join(''), close: [...wraps].reverse().map(closeText).join('') };
}

/**
 * Make the tag at the caret — or the selected tags — one step stronger or
 * weaker. Returns the edit, or a message saying why there's nothing to do.
 */
export function emphasize(s: string, selStart: number, selEnd: number, dir: 1 | -1): Edit | string {
  const limit = textStart(s);
  let a = Math.min(selStart, selEnd);
  let b = Math.max(selStart, selEnd);
  if (limit < s.length && b > limit) return '画面文字（Text: 之后的内容）不能调整权重';
  if (a === b) {
    const p = pieces(s, limit).find((x) => a >= x.start && a <= x.end);
    if (!p || p.coreStart >= p.coreEnd) return '先把光标放在要调整的 tag 上';
    const core = coreOf(s, p);
    if (!balanced(core)) return '这个 tag 的括号不完整，先把括号补全';
    const { open, close } = restep(p.own, dir);
    const caret = p.ownStart + open.length + Math.max(0, Math.min(core.length, a - p.coreStart));
    return { start: p.ownStart, end: p.ownEnd, insert: open + core + close, selStart: caret, selEnd: caret };
  }
  while (a < b && (isSpace(s[a]) || isSep(s[a]))) a++;
  while (b > a && (isSpace(s[b - 1]) || isSep(s[b - 1]))) b--;
  if (a >= b) return '先选中要调整的 tag';
  const inner = piece(s, a, b);
  const core = coreOf(s, inner);
  if (inner.outerOpen || inner.outerClose || !core || !balanced(core)) return '选中的内容括号不完整，请选中完整的 tag';
  // Emphasis right outside the selection is its own too — that's where the
  // previous press left it, so pressing again keeps stepping.
  let own = inner.own;
  let start = inner.ownStart;
  let end = inner.ownEnd;
  for (;;) {
    const l = s[start - 1];
    const r = s[end];
    if ((l === '{' && r === '}') || (l === '[' && r === ']')) {
      own = [{ kind: l, at: start - 1, len: 1, value: 0 }, ...own];
      start--;
      end++;
      continue;
    }
    const m = r === ':' && s[end + 1] === ':' ? /(?:^|[^\p{L}\p{N}.])(-?(?:\d+(?:\.\d*)?|\.\d+)::)$/u.exec(s.slice(Math.max(0, start - 24), start)) : null;
    if (m) {
      own = [{ kind: 'num', at: start - m[1].length, len: m[1].length, value: parseFloat(m[1]) }, ...own];
      start -= m[1].length;
      end += 2;
      continue;
    }
    break;
  }
  const { open, close } = restep(own, dir);
  return { start, end, insert: open + core + close, selStart: start + open.length, selEnd: start + open.length + core.length };
}

/** Append tags before any `Text:` part, leaving `, ` after them to keep typing. */
export function appendTags(s: string, insert: string) {
  const limit = textStart(s);
  const head = s.slice(0, limit);
  const tail = s.slice(limit);
  const trail = /[\s,]*$/.exec(head)![0];
  const body = head.slice(0, head.length - trail.length);
  const sep = !body ? '' : trail.includes('\n') ? '\n' : ', ';
  return tail ? `${body}${sep}${insert}, ${tail}` : `${body}${sep}${insert}, `;
}

/** Remove every occurrence of the tag (compared via tagKey) with one adjacent separator. */
export function removeTag(s: string, key: string) {
  let out = s;
  const found = pieces(s).filter((p) => p.coreStart < p.coreEnd && tagKey(coreOf(s, p)) === key);
  for (const p of found.reverse()) {
    const a = p.ownStart;
    const b = p.ownEnd;
    let after = b;
    while (isSpace(out[after])) after++;
    let before = a - 1;
    while (before >= 0 && isSpace(out[before])) before--;
    const next = isSep(out[after]) ? out[after] : '';
    const prev = before >= 0 && isSep(out[before]) ? out[before] : '';
    let from = a;
    let to = b;
    // The last tag of a group keeps the group's closing bracket glued on.
    if (p.outerClose && prev) from = before;
    else if (next === ',') { to = after + 1; while (isSpace(out[to])) to++; }
    else if (prev === ',') from = before;
    else if (next) to = after + 1;
    else if (prev) from = before;
    out = out.slice(0, from) + out.slice(to);
  }
  return out;
}

/** Split into chunks at separators outside brackets and numeric weights. */
export function topLevel(s: string) {
  const out: string[] = [];
  let depth = 0;
  let num = false;
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (i === s.length || (isSep(c) && depth === 0 && !num)) {
      const chunk = s.slice(start, i).trim();
      if (chunk) out.push(chunk);
      start = i + 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && s[i + 1] === ':') { num = false; i++; }
    else if (!num && !wordChar(s[i - 1]) && /[-.\d]/.test(c)) {
      const m = NUM.exec(s.slice(i, i + 24));
      if (m) { num = true; i += m[0].length - 1; }
    }
  }
  return out;
}

/** The chunks of a saved group that the prompt doesn't have yet. */
export function missingChunks(s: string, group: string) {
  const have = tagSet(s);
  return topLevel(group.slice(0, textStart(group))).filter((chunk) => !have.has(tagKey(coreOf(chunk, piece(chunk, 0, chunk.length)))));
}

/** Append the chunks of `group` that the prompt doesn't have yet. */
export function addMissing(s: string, group: string) {
  const add = missingChunks(s, group);
  return { text: add.length ? appendTags(s, add.join(', ')) : s, added: add.length };
}

/* ---------- typing helpers ---------- */

// What a Chinese keyboard types where NovelAI wants ASCII.
const WIDE: Record<string, string> = {
  '，': ',', '、': ',', '。': '.', '：': ':', '｛': '{', '｝': '}', '【': '[', '】': ']',
  '［': '[', '］': ']', '（': '(', '）': ')', '｜': '|', '　': ' ',
};
export const HAS_WIDE = /[，、。：｛｝【】［］（）｜　]/;

/** Full-width punctuation → ASCII (a comma gets its space), tracking the caret. */
export function toHalfWidth(s: string, caret = s.length) {
  const limit = textStart(s);
  let out = '';
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    if (i === caret) at = out.length;
    const r = i < limit ? WIDE[s[i]] : undefined;
    if (r === undefined) { out += s[i]; continue; }
    out += r;
    if ((r === ',' || r === '.') && !/\s/.test(s[i + 1] ?? '')) out += ' ';
  }
  return { text: out, caret: at < 0 ? out.length : at };
}

function tidyPiece(p: string) {
  let t = p.replace(/\s+/g, ' ').trim()
    .replace(/([{[])\s+/g, '$1').replace(/\s+([}\]])/g, '$1').replace(/\s*::\s*/g, '::');
  const bare = t.replace(/^(?:[{[]|-?(?:\d+(?:\.\d*)?|\.\d+)::)+/, '').replace(/(?:[}\]]|::)+$/, '');
  if (bare.length > 3) t = t.replace(/([\p{L}\p{N})])_+(?=[\p{L}\p{N}(])/gu, '$1 ');
  return t;
}

const PROSE = new Set(['a', 'an', 'the', 'and', 'with', 'in', 'on', 'of', 'at', 'to', 'is', 'are', 'her', 'his', 'their', 'by', 'for']);
/** Tags copied from Danbooru arrive space-separated: `1girl long_hair blue_eyes`. */
function booruWords(piece: string) {
  const words = piece.trim().split(/\s+/);
  if (words.length < 2 || !words.some((w) => /[\p{L}\p{N}]_[\p{L}\p{N}(]/u.test(w))) return null;
  return words.some((w) => PROSE.has(w.toLowerCase())) ? null : words;
}

/**
 * 「整理」: ASCII punctuation, one `, ` between tags, underscores to spaces,
 * Danbooru-style space-separated lists split up, duplicates removed. Line
 * breaks and the `Text:` part are kept as written.
 */
export function tidyPrompt(s: string) {
  const limit = textStart(s);
  const head = toHalfWidth(s.slice(0, limit)).text;
  const tail = s.slice(limit);
  const seen = new Set<string>();
  let removed = 0;
  const lines = head.split('\n').map((line) => line.split(',').flatMap((p) => booruWords(p) ?? [p]).map(tidyPiece).filter(Boolean).filter((p) => {
    // Chunks of a multi-tag group stay put, or the brackets would come apart.
    if (!balanced(p)) return true;
    const key = p.toLowerCase();
    if (seen.has(key)) { removed++; return false; }
    seen.add(key);
    return true;
  }).join(', ')).filter(Boolean);
  const body = lines.join('\n');
  return { text: tail ? (body ? `${body}, ${tail}` : tail) : body, removed };
}

/** How many tags 「整理」 would drop as duplicates (same form, same emphasis). */
export function duplicateCount(s: string) {
  const seen = new Set<string>();
  let n = 0;
  for (const p of pieces(s)) {
    if (p.outerOpen || p.outerClose || p.coreStart >= p.coreEnd) continue;
    const key = tidyPiece(s.slice(p.ownStart, p.ownEnd)).toLowerCase();
    if (seen.has(key)) n++;
    else seen.add(key);
  }
  return n;
}

/** Pieces with Chinese (or other CJK) text, for 「转成 tag」. */
export function cjkPieces(s: string) {
  return pieces(s).filter((p) => HAS_CJK.test(coreOf(s, p)))
    .map((p) => ({ start: p.ownStart, end: p.ownEnd, text: s.slice(p.ownStart, p.ownEnd) }));
}

/** Replace ranges (from cjkPieces) by their conversions; unknown ones stay. */
export function replaceRanges(s: string, ranges: { start: number; end: number; text: string }[], map: Map<string, string>) {
  let out = s;
  let n = 0;
  for (const r of [...ranges].sort((x, y) => y.start - x.start)) {
    const rep = map.get(r.text.trim())?.trim();
    if (!rep || rep === r.text) continue;
    out = out.slice(0, r.start) + rep + out.slice(r.end);
    n++;
  }
  return { text: out, replaced: n };
}

/** The chunk being typed at the caret, minus leading emphasis ({ [ or 1.2::) — what autocomplete completes. */
export function tokenAt(s: string, caret: number) {
  let start = caret;
  while (start > 0 && !isSep(s[start - 1])) start--;
  const raw = s.slice(start, caret);
  const lead = /^\s*(?:[{[]+|-?\d+(?:\.\d+)?::)?\s*/.exec(raw)?.[0].length ?? 0;
  return { start: start + lead, query: raw.slice(lead) };
}

/* ---------- remembered tags ---------- */

export type TagStat = { tag: string; count: number; score: number; last: number };
export type TagHistory = { tags: TagStat[]; negative: TagStat[] };
export const EMPTY_HISTORY: TagHistory = { tags: [], negative: [] };

export function normalizeHistory(v: unknown): TagHistory {
  const list = (x: unknown) => (Array.isArray(x) ? x : [])
    .filter((t): t is TagStat => !!t && typeof t.tag === 'string' && typeof t.count === 'number')
    .slice(0, 400).map((t) => ({ tag: t.tag.slice(0, 60), count: t.count, score: Number(t.score) || 0, last: Number(t.last) || 0 }));
  const h = v as Partial<TagHistory> | null;
  return { tags: list(h?.tags), negative: list(h?.negative) };
}

/** The tags a generation used, by pool. Same sources as the server's tag history. */
export function usedTags(o: {
  basePrompt: string; negativePrompt: string; artists: { tag: string }[];
  characters: { prompt: string; negativePrompt: string }[];
}) {
  return {
    tags: [o.basePrompt, ...o.characters.map((c) => c.prompt)].flatMap(promptTags)
      .concat(o.artists.map((a) => tagKey(a.tag)).filter(memorable)),
    negative: [o.negativePrompt, ...o.characters.map((c) => c.negativePrompt)].flatMap(promptTags),
  };
}

/** Count a just-submitted prompt right away; the server learns it from the saved image. */
export function rememberTags(h: TagHistory, used: { tags: string[]; negative: string[] }, now = Date.now()): TagHistory {
  const bump = (list: TagStat[], tags: string[]) => {
    const fresh = new Set(tags);
    if (!fresh.size) return list;
    const next = list.map((t) => (fresh.has(t.tag) ? { ...t, count: t.count + 1, score: t.score + 1, last: now } : t));
    for (const tag of fresh) if (!list.some((t) => t.tag === tag)) next.push({ tag, count: 1, score: 1, last: now });
    return next.sort((a, b) => b.score - a.score);
  };
  return { tags: bump(h.tags, used.tags), negative: bump(h.negative, used.negative) };
}

export type TagGroup = { name: string; tags: string };
export function normalizeGroups(v: unknown): TagGroup[] {
  if (!Array.isArray(v)) return [];
  return v.filter((g) => typeof g?.name === 'string' && typeof g?.tags === 'string' && g.name.trim() && g.tags.trim())
    .slice(0, 60).map((g) => ({ name: g.name.slice(0, 40), tags: g.tags.slice(0, 2000) }));
}
