import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { config, serverRoot } from '../config.js';
import * as schema from './schema.js';

const sqlite = new Database(path.join(config.dataDir, 'cat-agentui.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export { schema };
/** Raw handle for things drizzle can't model (FTS5 virtual tables). */
export const rawDb = sqlite;

export function runMigrations() {
  migrate(db, { migrationsFolder: path.join(serverRoot, 'drizzle') });
}

// --- app settings helpers ---
export function getSetting<T>(key: string, def: T): T {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get();
  if (!row) return def;
  try { return JSON.parse(row.value) as T; } catch { return def; }
}

export function setSetting(key: string, value: unknown) {
  const json = JSON.stringify(value);
  db.insert(schema.appSettings).values({ key, value: json })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: json } }).run();
}

export const now = () => Date.now();
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
