// Inline citations for Google Search grounding. Vertex tells us which spans
// of the answer each source backs (groundingSupports); at render time we
// append a marker after every such span, `[n](cite:n)`, which Markdown turns
// into a superscript chip linking to source n. The stored text is never
// modified — copying the message still yields clean prose.
export interface CitationSupport { text: string; start: number; sources: number[] }

const MARKER_RE = /\[\d+\]\(cite:\d+\)/;

/** Where a marker may not go: inside a fenced code block. Cheap check —
    count fences before the position. */
function insideFence(text: string, pos: number): boolean {
  let fences = 0;
  const re = /^(```|~~~)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index < pos) fences++;
  return fences % 2 === 1;
}

export function injectCitations(text: string, supports: CitationSupport[] | undefined): string {
  if (!supports?.length || !text || MARKER_RE.test(text)) return text;
  // Locate each span; supports come in reading order, so search forward from
  // the previous hit to disambiguate repeated sentences.
  const hits: { end: number; sources: number[] }[] = [];
  let cursor = 0;
  for (const s of [...supports].sort((a, b) => a.start - b.start)) {
    const needle = s.text.trim();
    if (!needle) continue;
    let at = text.indexOf(needle, cursor);
    if (at < 0) at = text.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    if (insideFence(text, end)) continue;
    hits.push({ end, sources: s.sources });
    cursor = Math.max(cursor, at);
  }
  if (!hits.length) return text;
  // Merge spans ending at the same place; insert from the back so offsets hold.
  const byEnd = new Map<number, number[]>();
  for (const h of hits) {
    const cur = byEnd.get(h.end) ?? [];
    for (const n of h.sources) if (!cur.includes(n)) cur.push(n);
    byEnd.set(h.end, cur);
  }
  let out = text;
  for (const end of [...byEnd.keys()].sort((a, b) => b - a)) {
    const nums = byEnd.get(end)!.sort((a, b) => a - b);
    // A span often ends with the sentence's punctuation; keep the chip glued
    // to it (no space) so it reads like a footnote mark.
    const marker = nums.map((n) => `[${n + 1}](cite:${n + 1})`).join('');
    out = out.slice(0, end) + marker + out.slice(end);
  }
  return out;
}
