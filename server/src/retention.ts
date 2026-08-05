// Periodic cleanup of generated images past the admin-set retention window.
// Deliberately conservative: a file that fails to unlink (other than already
// being gone) keeps its DB row so the next sweep retries, and retention 0
// means keep forever (the default).
import fs from 'node:fs';
import path from 'node:path';
import { eq, lt } from 'drizzle-orm';
import { db, schema, getSetting } from './db/index.js';
import { config } from './config.js';

export const IMAGE_RETENTION_KEY = 'image_retention_days';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function sweepExpiredImages(): number {
  const days = getSetting<number>(IMAGE_RETENTION_KEY, 0);
  if (!days || days <= 0) return 0;

  const cutoff = Date.now() - days * 86_400_000;
  const rows = db.select().from(schema.images).where(lt(schema.images.createdAt, cutoff)).all();
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
  if (removed) console.log(`[retention] removed ${removed} image(s) older than ${days}d`);
  return removed;
}

export function startRetentionSweeper() {
  // First pass shortly after boot (not during it), then hourly. unref so the
  // timers never hold a shutdown open.
  setTimeout(sweepExpiredImages, 30_000).unref();
  setInterval(sweepExpiredImages, SWEEP_INTERVAL_MS).unref();
}
