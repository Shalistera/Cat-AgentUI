// Scheduled online snapshots of the SQLite database into data/backups/.
// Uses better-sqlite3's backup API (SQLite Online Backup), which is safe while
// the app keeps writing — no downtime, WAL content included. Snapshots rotate:
// only the newest BACKUP_KEEP files survive a sweep.
//
// Scope: the DB alone. Uploaded attachments and generated images live as plain
// files under data/uploads + data/images and would multiply snapshot size, so
// they are left to whole-directory backup (rsync of data/ + .env). The admin UI
// says so explicitly. Restoring a snapshot also needs the matching SECRET_KEY
// from .env — the DB only holds ciphertext for provider/MCP credentials.
import fs from 'node:fs';
import path from 'node:path';
import { rawDb } from './db/index.js';
import { config } from './config.js';

export const backupDir = path.join(config.dataDir, 'backups');

const FILENAME_RE = /^cat-agentui-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

export interface BackupFileInfo {
  filename: string;
  size: number;
  createdAt: number;
}

/** True iff the name is one of ours — the download route's path-traversal gate. */
export function isBackupFilename(name: string): boolean {
  return FILENAME_RE.test(name);
}

export function listBackups(): BackupFileInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(backupDir); } catch { return []; }
  return names.filter(isBackupFilename)
    .map((filename) => {
      try {
        const st = fs.statSync(path.join(backupDir, filename));
        return { filename, size: st.size, createdAt: st.mtimeMs };
      } catch { return null; }
    })
    .filter((x): x is BackupFileInfo => !!x)
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

function pruneOldBackups(): void {
  for (const b of listBackups().slice(config.backupKeep)) {
    try { fs.unlinkSync(path.join(backupDir, b.filename)); } catch { /* next sweep retries */ }
  }
}

let running: Promise<BackupFileInfo> | null = null;

/** Take one snapshot now. Concurrent callers share the in-flight run. */
export function runBackup(): Promise<BackupFileInfo> {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const filename = `cat-agentui-${stamp}.db`;
    const dest = path.join(backupDir, filename);
    // Write to a temp name first so a crash mid-backup never leaves a file the
    // listing (and rotation) would mistake for a complete snapshot.
    const tmp = `${dest}.part`;
    try {
      await rawDb.backup(tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, dest);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw err;
    }
    pruneOldBackups();
    const st = fs.statSync(dest);
    console.log(`[backup] snapshot ${filename} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
    return { filename, size: st.size, createdAt: st.mtimeMs };
  })();
  running.finally(() => { running = null; }).catch(() => { /* surfaced to caller */ });
  return running;
}

export function startBackupScheduler(): void {
  if (config.backupIntervalHours <= 0) {
    console.log('[backup] BACKUP_INTERVAL_HOURS=0 — automatic snapshots disabled');
    return;
  }
  const intervalMs = config.backupIntervalHours * 3600_000;
  const tick = () => {
    runBackup().catch((err) => console.error('[backup] snapshot failed:', (err as Error).message));
  };
  // If the newest snapshot is fresh enough (e.g. the service just restarted),
  // wait out the remainder instead of snapshotting on every boot.
  const newest = listBackups()[0];
  const sinceLast = newest ? Date.now() - newest.createdAt : Infinity;
  const firstDelay = Math.max(60_000, intervalMs - sinceLast);
  setTimeout(() => { tick(); setInterval(tick, intervalMs).unref(); }, firstDelay).unref();
}
