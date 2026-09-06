import type { Message } from './types';

// ---- message tree helpers ----
// A chat's messages hold every branch in (seq, createdAt) order; the visible
// conversation is the root→leaf chain ending at leafId. Regenerated replies
// and edited user messages are SIBLINGS (same parentId) switched with the
// version arrows. Shared by the chat page and the admin's read-only viewer.

export function computePath(all: Message[], leafId: string | null): Message[] {
  if (!all.length) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const leaf = (leafId && byId.get(leafId)) || all[all.length - 1];
  const path: Message[] = [];
  const seen = new Set<string>();
  let cur: Message | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

/** Walk down from a node always taking the newest child — the branch's tip. */
export function newestLeafUnder(all: Message[], id: string): string {
  let cur = id;
  for (;;) {
    const kids = all.filter((m) => m.parentId === cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1].id;
  }
}
