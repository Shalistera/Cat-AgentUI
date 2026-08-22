import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireAuth } from '../auth.js';

// Full-text search across the user's chats: titles AND message bodies, with a
// snippet around the first hit. Substring matching (not FTS5) is deliberate —
// it works for CJK text of any length, needs no index maintenance, and at this
// deployment's scale (10–20 users) a scan is comfortably fast.

const MAX_RESULTS = 50;
const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 64;

interface ParsedQuery {
  text: string;
  pinned: boolean | null;
  project: string | null; // project name substring
}

// Open WebUI-style prefixes: `project:名称` / `folder:名称` / `pinned:true`.
// Everything else is the literal text to look for.
function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = { text: '', pinned: null, project: null };
  const rest: string[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const m = /^(project|folder|pinned)[:：](.*)$/i.exec(token);
    if (!m) { rest.push(token); continue; }
    const value = m[2];
    if (/^pinned$/i.test(m[1])) {
      out.pinned = !/^(false|0|no|否)$/i.test(value);
    } else if (value) {
      out.project = value.toLowerCase();
    }
  }
  out.text = rest.join(' ').trim();
  return out;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

function makeSnippet(text: string, idx: number, matchLen: number): string {
  const start = Math.max(0, idx - SNIPPET_BEFORE);
  const end = Math.min(text.length, idx + matchLen + SNIPPET_AFTER);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function textPartsOf(partsJson: string): string[] {
  try {
    const parts = JSON.parse(partsJson) as { type?: string; text?: string }[];
    return Array.isArray(parts)
      ? parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text!)
      : [];
  } catch { return []; }
}

export async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', async (req, reply) => {
    requireAuth(req, reply);
    const userId = req.user!.id;
    const raw = String((req.query as { q?: unknown }).q ?? '').slice(0, 200);
    const q = parseQuery(raw);

    let chats = db.select().from(schema.chats).where(eq(schema.chats.userId, userId)).all();
    if (q.pinned !== null) chats = chats.filter((c) => !!c.pinned === q.pinned);
    if (q.project !== null) {
      const projs = db.select({ id: schema.projects.id, name: schema.projects.name })
        .from(schema.projects).where(eq(schema.projects.userId, userId)).all();
      const wanted = new Set(projs.filter((p) => p.name.toLowerCase().includes(q.project!)).map((p) => p.id));
      chats = chats.filter((c) => c.projectId && wanted.has(c.projectId));
    }
    const chatById = new Map(chats.map((c) => [c.id, c]));

    type Hit = {
      chat: typeof schema.chats.$inferSelect;
      titleMatch: boolean;
      snippet: string | null;
      matchCount: number;
      bestSeq: number;
    };
    const hits = new Map<string, Hit>();
    const qLower = q.text.toLowerCase();

    if (!qLower) {
      // Filter-only query (e.g. just `pinned:true`): list the filtered chats.
      for (const c of chats) {
        hits.set(c.id, { chat: c, titleMatch: false, snippet: null, matchCount: 0, bestSeq: 0 });
      }
    } else {
      for (const c of chats) {
        if ((c.title || '').toLowerCase().includes(qLower)) {
          hits.set(c.id, { chat: c, titleMatch: true, snippet: null, matchCount: 0, bestSeq: 0 });
        }
      }
      // Coarse SQL prefilter on the raw JSON, then a precise in-JS check on the
      // decoded text parts. Quotes/backslashes are JSON-escaped in storage, so
      // the LIKE pattern uses the longest chunk free of them; the JS pass is
      // the source of truth.
      const chunk = q.text.split(/["\\]/).reduce((a, b) => (b.length > a.length ? b : a), '');
      const pattern = `%${escapeLike(chunk)}%`;
      const msgRows = db.select({
        chatId: schema.messages.chatId, parts: schema.messages.parts, seq: schema.messages.seq,
      }).from(schema.messages)
        .innerJoin(schema.chats, eq(schema.messages.chatId, schema.chats.id))
        .where(and(
          eq(schema.chats.userId, userId),
          sql`${schema.messages.parts} LIKE ${pattern} ESCAPE '\\'`,
        )).all();
      for (const m of msgRows) {
        const chat = chatById.get(m.chatId);
        if (!chat) continue;
        const text = textPartsOf(m.parts).join('\n');
        const idx = text.toLowerCase().indexOf(qLower);
        if (idx < 0) continue;
        const prev = hits.get(m.chatId);
        if (prev) {
          prev.matchCount += 1;
          // Snippet comes from the newest matching message of the chat.
          if (m.seq >= prev.bestSeq || !prev.snippet) {
            prev.snippet = makeSnippet(text, idx, q.text.length);
            prev.bestSeq = m.seq;
          }
        } else {
          hits.set(m.chatId, {
            chat, titleMatch: false, matchCount: 1, bestSeq: m.seq,
            snippet: makeSnippet(text, idx, q.text.length),
          });
        }
      }
    }

    const results = [...hits.values()]
      .sort((a, b) => (b.chat.pinned - a.chat.pinned) || (b.chat.updatedAt - a.chat.updatedAt))
      .slice(0, MAX_RESULTS)
      .map((h) => ({
        id: h.chat.id, title: h.chat.title, pinned: !!h.chat.pinned,
        projectId: h.chat.projectId, updatedAt: h.chat.updatedAt,
        titleMatch: h.titleMatch, snippet: h.snippet, matchCount: h.matchCount,
      }));
    return { results, query: q.text };
  });
}
