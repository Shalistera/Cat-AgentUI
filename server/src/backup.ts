// Scheduled online snapshots of the SQLite database into data/backups/.
// Uses better-sqlite3's backup API (SQLite Online Backup), which is safe while
// the app keeps writing — no downtime, WAL content included. Snapshots rotate:
// only the newest `keep` files survive a sweep.
//
// Policy (enabled / interval / keep) is admin-editable and lives in
// app_settings; BACKUP_INTERVAL_HOURS / BACKUP_KEEP from .env only seed the
// defaults. Saving new values calls rescheduleBackups() so they apply at once.
//
// Scope: the DB alone. Uploaded attachments and generated images live as plain
// files under data/uploads + data/images and would multiply snapshot size, so
// they are left to whole-directory backup (rsync of data/ + .env). The admin UI
// says so explicitly. Restoring a snapshot also needs the matching SECRET_KEY
// from .env — the DB only holds ciphertext for provider/MCP credentials.
import fs from 'node:fs';
import path from 'node:path';
import { rawDb, getSetting, setSetting } from './db/index.js';
import { config } from './config.js';

export const backupDir = path.join(config.dataDir, 'backups');

const FILENAME_RE = /^cat-agentui-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

const ENABLED_KEY = 'backup_enabled';
const INTERVAL_KEY = 'backup_interval_hours';
const KEEP_KEY = 'backup_keep';

export const BACKUP_INTERVAL_MIN = 1;
export const BACKUP_INTERVAL_MAX = 720;
export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 365;

export interface BackupSettings {
  /** Automatic snapshots on/off. Manual snapshots always work. */
  enabled: boolean;
  intervalHours: number;
  keep: number;
}

export interface BackupFileInfo {
  filename: string;
  size: number;
  createdAt: number;
}

export interface BackupStatus {
  running: boolean;
  /** Epoch ms of the next automatic snapshot, null when disabled. */
  nextRunAt: number | null;
  /** Error message of the most recent failed run, cleared by the next success. */
  lastError: string | null;
  /** Live size of the database (main file + WAL) — what a snapshot will roughly weigh. */
  dbSize: number;
  /** Free bytes on the volume holding data/backups. */
  freeSpace: number | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

export function getBackupSettings(): BackupSettings {
  const envInterval = config.backupIntervalHours;
  return {
    enabled: getSetting(ENABLED_KEY, envInterval > 0),
    intervalHours: clamp(getSetting(INTERVAL_KEY, envInterval > 0 ? envInterval : 24), BACKUP_INTERVAL_MIN, BACKUP_INTERVAL_MAX),
    keep: clamp(getSetting(KEEP_KEY, config.backupKeep), BACKUP_KEEP_MIN, BACKUP_KEEP_MAX),
  };
}

/** Persist a (partial) policy, prune to the new `keep` right away, and re-arm the timer. */
export function updateBackupSettings(patch: Partial<BackupSettings>): BackupSettings {
  if (patch.enabled !== undefined) setSetting(ENABLED_KEY, !!patch.enabled);
  if (patch.intervalHours !== undefined) setSetting(INTERVAL_KEY, clamp(patch.intervalHours, BACKUP_INTERVAL_MIN, BACKUP_INTERVAL_MAX));
  if (patch.keep !== undefined) setSetting(KEEP_KEY, clamp(patch.keep, BACKUP_KEEP_MIN, BACKUP_KEEP_MAX));
  const s = getBackupSettings();
  pruneOldBackups(s.keep);
  rescheduleBackups();
  return s;
}

/** True iff the name is one of ours — the download/delete routes' path-traversal gate. */
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

export function deleteBackup(filename: string): boolean {
  if (!isBackupFilename(filename)) return false;
  try { fs.unlinkSync(path.join(backupDir, filename)); return true; } catch { return false; }
}

function pruneOldBackups(keep: number): void {
  for (const b of listBackups().slice(keep)) {
    try { fs.unlinkSync(path.join(backupDir, b.filename)); } catch { /* next sweep retries */ }
  }
}

function dbSize(): number {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try { total += fs.statSync(rawDb.name + suffix).size; } catch { /* no WAL yet */ }
  }
  return total;
}

function freeSpace(): number | null {
  try {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const st = fs.statfsSync(backupDir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

let running: Promise<BackupFileInfo> | null = null;
let lastError: string | null = null;
let timer: NodeJS.Timeout | null = null;
let nextRunAt: number | null = null;

export function backupStatus(): BackupStatus {
  return { running: !!running, nextRunAt, lastError, dbSize: dbSize(), freeSpace: freeSpace() };
}

/** Take one snapshot now. Concurrent callers share the in-flight run. */
export function runBackup(): Promise<BackupFileInfo> {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    // A snapshot is about as big as the live DB; refuse rather than fill the
    // disk and take the app down with it. 20% headroom for the WAL checkpoint.
    const need = dbSize() * 1.2;
    const free = freeSpace();
    if (free !== null && free < need) {
      throw new Error(`磁盘剩余空间不足(需要约 ${(need / 1024 / 1024).toFixed(0)} MB,剩余 ${(free / 1024 / 1024).toFixed(0)} MB)`);
    }
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
    pruneOldBackups(getBackupSettings().keep);
    const st = fs.statSync(dest);
    console.log(`[backup] snapshot ${filename} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
    return { filename, size: st.size, createdAt: st.mtimeMs };
  })();
  running
    .then(() => { lastError = null; }, (err: Error) => { lastError = err.message; })
    .finally(() => { running = null; });
  return running;
}

/** (Re)arm the automatic-snapshot timer from the current settings. */
export function rescheduleBackups(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  nextRunAt = null;
  const s = getBackupSettings();
  if (!s.enabled) return;
  const intervalMs = s.intervalHours * 3600_000;
  // Count from the newest snapshot so a restart (or a manual backup) doesn't
  // trigger an extra one; never fire within the first minute after boot.
  const newest = listBackups()[0];
  const sinceLast = newest ? Date.now() - newest.createdAt : Infinity;
  const delay = Math.max(60_000, intervalMs - sinceLast);
  nextRunAt = Date.now() + delay;
  timer = setTimeout(() => {
    timer = null;
    runBackup()
      .catch((err) => console.error('[backup] snapshot failed:', (err as Error).message))
      .finally(rescheduleBackups);
  }, delay);
  timer.unref();
}

export function startBackupScheduler(): void {
  const s = getBackupSettings();
  console.log(s.enabled
    ? `[backup] automatic snapshots every ${s.intervalHours}h, keeping ${s.keep}`
    : '[backup] automatic snapshots disabled (enable in 管理后台 → 备份与迁移)');
  rescheduleBackups();
}
