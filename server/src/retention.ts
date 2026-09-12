// Periodic cleanup of generated images past the admin-set retention windows.
// Workshop images and chat-born images are SEPARATE policies: expiring a
// gallery entry just trims the gallery, expiring a chat image punches a hole
// in a conversation — so each source has its own knob and 0 (the default)
// means keep forever. Deliberately conservative: a file that fails to unlink
// (other than already being gone) keeps its DB row so the next sweep retries.
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { db, schema, getSetting } from './db/index.js';
import { config } from './config.js';
import { cleanupUnreferencedUploads, uploadIdsFromPartsJson, removeUnreferencedUploads } from './storage.js';
import { removeWorkspace } from './workspace.js';

export const IMAGE_RETENTION_KEY = 'image_retention_days'; // 绘图工坊
export const CHAT_IMAGE_RETENTION_KEY = 'chat_image_retention_days'; // 对话中作图
// Uploads that no saved message references (abandoned drafts, workshop
// inputs). 0 = keep forever; otherwise removed once older than N days.
export const UPLOAD_RETENTION_KEY = 'upload_retention_days';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function sweepSource(source: 'workshop' | 'chat', settingKey: string): number {
  const days = getSetting<number>(settingKey, 0);
  if (!days || days <= 0) return 0;

  const cutoff = Date.now() - days * 86_400_000;
  const rows = db.select().from(schema.images)
    .where(and(eq(schema.images.source, source), lt(schema.images.createdAt, cutoff)))
    .all();
  let removed = 0;
  for (const row of rows) {
    try {
      fs.unlinkSync(path.join(config.dataDir, 'images', row.filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.log(`[retention] keep ${row.id}: unlink failed (${(err as Error).message})`);
        continue;
      }
    }
    db.delete(schema.images).where(eq(schema.images.id, row.id)).run();
    removed++;
  }
  if (removed) console.log(`[retention] removed ${removed} ${source} image(s) older than ${days}d`);
  return removed;
}

export function sweepExpiredImages(): number {
  return sweepSource('workshop', IMAGE_RETENTION_KEY)
    + sweepSource('chat', CHAT_IMAGE_RETENTION_KEY);
}

// 临时对话 past their idle TTL vanish for good — chat row, messages (via
// cascade) and any uploads that no surviving message still references.
async function sweepTemporaryChats(): Promise<number> {
  const cutoff = Date.now() - config.tempChatTtlMs;
  const rows = db.select({
    id: schema.chats.id, userId: schema.chats.userId,
  }).from(schema.chats)
    .where(and(eq(schema.chats.temporary, 1), lt(schema.chats.updatedAt, cutoff)))
    .all();
  for (const chat of rows) {
    const uploadIds = db.select({ parts: schema.messages.parts }).from(schema.messages)
      .where(eq(schema.messages.chatId, chat.id)).all()
      .flatMap((m) => uploadIdsFromPartsJson(m.parts));
    db.delete(schema.chats).where(eq(schema.chats.id, chat.id)).run();
    removeWorkspace(chat.id);
    await cleanupUnreferencedUploads(chat.userId, uploadIds);
  }
  if (rows.length) console.log(`[retention] removed ${rows.length} temporary chat(s) idle beyond TTL`);
  return rows.length;
}

export async function sweepUnreferencedUploads(): Promise<number> {
  const days = getSetting<number>(UPLOAD_RETENTION_KEY, 0);
  if (!days || days <= 0) return 0;
  const { count, bytes } = await removeUnreferencedUploads(days * 86_400_000);
  if (count) console.log(`[retention] removed ${count} unreferenced upload(s) older than ${days}d (${bytes} bytes)`);
  return count;
}

export function startRetentionSweeper() {
  // First pass shortly after boot (not during it), then hourly. unref so the
  // timers never hold a shutdown open.
  const sweep = () => { sweepExpiredImages(); void sweepTemporaryChats(); void sweepUnreferencedUploads(); };
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
