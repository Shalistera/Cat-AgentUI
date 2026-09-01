import fs from 'node:fs';
import path from 'node:path';
import { and, eq, like, lt, sql } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema } from './db/index.js';

export type StorageKind = 'upload' | 'image';

interface ReservationRow { userId: string; kind: StorageKind; bytes: number }
const reservations = new Map<symbol, ReservationRow>();
let untrackedStorageBytes = 0;

export interface StorageReservation {
  readonly bytes: number;
  readonly kind: StorageKind;
  release(): void;
}

export type ReserveResult =
  | { ok: true; reservation: StorageReservation }
  | { ok: false; reason: 'user' | 'global' };

function sumUploads(userId?: string): number {
  const q = db.select({ n: sql<number>`coalesce(sum(${schema.uploads.size}), 0)` })
    .from(schema.uploads);
  return (userId ? q.where(eq(schema.uploads.userId, userId)).get() : q.get())?.n ?? 0;
}

function sumImages(userId?: string): number {
  const q = db.select({ n: sql<number>`coalesce(sum(${schema.images.byteSize}), 0)` })
    .from(schema.images);
  return (userId ? q.where(eq(schema.images.userId, userId)).get() : q.get())?.n ?? 0;
}

function reservedBytes(kind?: StorageKind, userId?: string): number {
  let total = 0;
  for (const r of reservations.values()) {
    if (kind && r.kind !== kind) continue;
    if (userId && r.userId !== userId) continue;
    total += r.bytes;
  }
  return total;
}

/**
 * Reserve worst-case bytes before an async upload/provider call. Reservations
 * close the check-then-write race between concurrent requests in this process.
 */
export function tryReserveStorage(userId: string, kind: StorageKind, bytes: number): ReserveResult {
  const perUserLimit = kind === 'upload' ? config.maxUserUploadBytes : config.maxUserImageBytes;
  const perUserStored = kind === 'upload' ? sumUploads(userId) : sumImages(userId);
  if (perUserStored + reservedBytes(kind, userId) + bytes > perUserLimit) {
    return { ok: false, reason: 'user' };
  }

  const globalStored = sumUploads() + sumImages() + untrackedStorageBytes;
  if (globalStored + reservedBytes() + bytes > config.maxTotalStorageBytes) {
    return { ok: false, reason: 'global' };
  }

  const token = Symbol(kind);
  reservations.set(token, { userId, kind, bytes });
  let released = false;
  return {
    ok: true,
    reservation: {
      bytes,
      kind,
      release() {
        if (released) return;
        released = true;
        reservations.delete(token);
      },
    },
  };
}

export function quotaErrorMessage(kind: StorageKind, reason: 'user' | 'global'): string {
  if (reason === 'global') return '服务器存储空间配额已满,请联系管理员清理文件';
  return kind === 'upload'
    ? '你的附件存储配额已满,请删除不再需要的附件'
    : '你的生成图片存储配额已满,请先在画廊中删除部分图片';
}

export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};

export function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

export function detectImageMime(buf: Uint8Array): string | null {
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12
    && Buffer.from(buf.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(buf.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6) {
    const sig = Buffer.from(buf.subarray(0, 6)).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  return null;
}

export async function detectImageFileMime(filePath: string): Promise<string | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return detectImageMime(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Mimes whose content is fed to models as extracted plain text. */
export function isTextDocMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === DOCX_MIME;
}

export type UploadSniff =
  | { ok: true; mime: string; ext: string }
  | { ok: false; error: string };

/**
 * Classify an uploaded file by content, never by the browser-claimed mimetype
 * (drag-and-drop routinely delivers empty or generic types). Accepted shapes:
 * images (magic bytes), PDF, docx (zip + .docx name), and any UTF-8 text file.
 */
export async function sniffUpload(filePath: string, origName: string | null): Promise<UploadSniff> {
  const buf = await fs.promises.readFile(filePath);
  const image = detectImageMime(buf);
  if (image) return { ok: true, mime: image, ext: extForMime(image) };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { ok: true, mime: 'application/pdf', ext: 'pdf' };
  }
  const nameExt = (origName ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) {
    if (nameExt === 'docx') return { ok: true, mime: DOCX_MIME, ext: 'docx' };
    return { ok: false, error: '不支持该压缩格式文件(Word 请使用 .docx)' };
  }
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return { ok: false, error: '旧版 Office 格式(.doc/.xls/.ppt)不支持,请另存为 .docx 或 PDF' };
  }
  // Everything else must be readable text: UTF-8 and free of NUL bytes.
  if (buf.includes(0)) return { ok: false, error: '不支持的文件类型(仅图片、PDF、docx 及文本文件)' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { ok: false, error: '文本文件必须是 UTF-8 编码' };
  }
  const isMd = nameExt === 'md' || nameExt === 'markdown';
  // Store the real extension so the on-disk name stays meaningful; anything
  // exotic falls back to .txt.
  const ext = /^[a-z0-9]{1,8}$/.test(nameExt) ? nameExt : 'txt';
  return { ok: true, mime: isMd ? 'text/markdown' : 'text/plain', ext };
}

export interface OwnedMedia {
  kind: StorageKind;
  id: string;
  mime: string;
  size: number;
  filePath: string;
  name?: string; // original filename, for prompt labels and UI chips
}

export async function getOwnedUploadMedia(id: string, userId: string): Promise<OwnedMedia | null> {
  const row = db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get();
  if (!row || row.userId !== userId) return null;
  const filePath = path.join(config.dataDir, 'uploads', row.filename);
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size !== row.size) {
      db.update(schema.uploads).set({ size: stat.size }).where(eq(schema.uploads.id, id)).run();
    }
    return { kind: 'upload', id, mime: row.mime, size: stat.size, filePath, name: row.origName ?? undefined };
  } catch {
    return null;
  }
}

export async function getOwnedImageMedia(id: string, userId: string): Promise<OwnedMedia | null> {
  const row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
  if (!row || row.userId !== userId) return null;
  const filePath = path.join(config.dataDir, 'images', row.filename);
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size !== row.byteSize) {
      db.update(schema.images).set({ byteSize: stat.size }).where(eq(schema.images.id, id)).run();
    }
    const ext = path.extname(row.filename).slice(1).toLowerCase();
    return { kind: 'image', id, mime: MIME_BY_EXT[ext] ?? 'image/png', size: stat.size, filePath };
  } catch {
    return null;
  }
}

export async function readMediaBase64(media: OwnedMedia, maxBytes: number): Promise<{
  mime: string;
  dataBase64: string;
}> {
  if (media.size > maxBytes) throw new Error('附件超过上下文大小限制');
  const buf = await fs.promises.readFile(media.filePath);
  if (buf.length > maxBytes) throw new Error('附件超过上下文大小限制');
  return { mime: media.mime, dataBase64: buf.toString('base64') };
}

export function decodeGeneratedImage(dataBase64: string, declaredMime: string): {
  buffer: Buffer;
  mime: string;
} {
  const clean = dataBase64.replace(/\s/g, '');
  const maxEncoded = Math.ceil(config.maxGeneratedImageBytes / 3) * 4 + 8;
  if (!clean || clean.length > maxEncoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('Provider 返回的图片过大或编码无效');
  }
  const buffer = Buffer.from(clean, 'base64');
  if (!buffer.length || buffer.length > config.maxGeneratedImageBytes) {
    throw new Error('Provider 返回的图片超过大小限制');
  }
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error('Provider 返回的内容不是受支持的图片');
  const rawDeclared = declaredMime.split(';', 1)[0].trim().toLowerCase();
  const normalizedDeclared = rawDeclared === 'image/jpg' ? 'image/jpeg' : rawDeclared;
  if (normalizedDeclared && normalizedDeclared !== mime) {
    throw new Error('Provider 返回的图片类型与内容不一致');
  }
  return { buffer, mime };
}

/** Repair byte metadata and account for legacy disk orphans before quotas go live. */
export async function reconcileStorageMetadata(): Promise<void> {
  const imageRows = db.select({ id: schema.images.id, filename: schema.images.filename, byteSize: schema.images.byteSize })
    .from(schema.images).all();
  for (const row of imageRows) {
    try {
      const stat = await fs.promises.stat(path.join(config.dataDir, 'images', row.filename));
      if (row.byteSize !== stat.size) {
        db.update(schema.images).set({ byteSize: stat.size }).where(eq(schema.images.id, row.id)).run();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        db.update(schema.images).set({ byteSize: 0 }).where(eq(schema.images.id, row.id)).run();
      } else {
        throw err;
      }
    }
  }

  const uploadRows = db.select({ id: schema.uploads.id, filename: schema.uploads.filename, size: schema.uploads.size })
    .from(schema.uploads).all();
  for (const row of uploadRows) {
    try {
      const stat = await fs.promises.stat(path.join(config.dataDir, 'uploads', row.filename));
      if (row.size !== stat.size) {
        db.update(schema.uploads).set({ size: stat.size }).where(eq(schema.uploads.id, row.id)).run();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        db.update(schema.uploads).set({ size: 0 }).where(eq(schema.uploads.id, row.id)).run();
      } else {
        throw err;
      }
    }
  }

  const known = {
    images: new Set(imageRows.map((row) => row.filename)),
    uploads: new Set(uploadRows.map((row) => row.filename)),
  };
  untrackedStorageBytes = 0;
  for (const dir of ['images', 'uploads'] as const) {
    const dirPath = path.join(config.dataDir, dir);
    for (const filename of await fs.promises.readdir(dirPath)) {
      if (known[dir].has(filename)) continue;
      const filePath = path.join(dirPath, filename);
      try {
        const stat = await fs.promises.lstat(filePath);
        if (stat.isFile()) untrackedStorageBytes += stat.size;
      } catch { /* a concurrent/manual filesystem change is reconciled next restart */ }
    }
  }
}

export async function unlinkStoredFiles(rows: { filename: string }[], dir: 'uploads' | 'images'): Promise<void> {
  await Promise.all(rows.map(async (row) => {
    try { await fs.promises.unlink(path.join(config.dataDir, dir, row.filename)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }));
}

export function uploadIdsFromPartsJson(partsJson: string): string[] {
  try {
    const parts = JSON.parse(partsJson) as { type?: string; uploadId?: string }[];
    if (!Array.isArray(parts)) return [];
    return parts.flatMap((p) => (p.type === 'image' || p.type === 'file') && p.uploadId ? [p.uploadId] : []);
  } catch {
    return [];
  }
}

export function uploadIsReferenced(uploadId: string): boolean {
  const candidates = db.select({ parts: schema.messages.parts }).from(schema.messages)
    .where(like(schema.messages.parts, `%${uploadId}%`)).all();
  return candidates.some((row) => uploadIdsFromPartsJson(row.parts).includes(uploadId));
}

/** Delete candidate uploads only after no saved message references them. */
export async function cleanupUnreferencedUploads(userId: string, candidateIds: Iterable<string>): Promise<void> {
  for (const id of new Set(candidateIds)) {
    if (uploadIsReferenced(id)) continue;
    const row = db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get();
    if (!row || row.userId !== userId) continue;
    try { await fs.promises.unlink(path.join(config.dataDir, 'uploads', row.filename)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    db.delete(schema.uploads).where(eq(schema.uploads.id, id)).run();
  }
}

// ---------------------------------------------------------------------------
// Admin storage overview + cleanup
// ---------------------------------------------------------------------------

export interface StorageOverview {
  uploads: { count: number; bytes: number; unreferencedCount: number; unreferencedBytes: number };
  images: { count: number; bytes: number; workshopBytes: number; chatBytes: number };
  /** Files on disk that no DB row knows about (crashed uploads, manual copies). */
  orphans: { count: number; bytes: number };
  limits: { total: number; perUserUploads: number; perUserImages: number };
  freeSpace: number | null;
  topUsers: { userId: string; username: string; displayName: string | null; uploadBytes: number; imageBytes: number }[];
}

/** Every uploadId any saved message still points at. One pass over the
    messages that contain an attachment part at all — far cheaper than a LIKE
    per upload when the question is "which uploads are unused". */
function referencedUploadIds(): Set<string> {
  const out = new Set<string>();
  const rows = db.select({ parts: schema.messages.parts }).from(schema.messages)
    .where(like(schema.messages.parts, '%"uploadId"%')).all();
  for (const r of rows) for (const id of uploadIdsFromPartsJson(r.parts)) out.add(id);
  return out;
}

/** Uploads no message references — abandoned drafts, workshop inputs, etc.
    Optionally only those older than `olderThanMs`. */
function unreferencedUploads(olderThanMs = 0) {
  const referenced = referencedUploadIds();
  const cutoff = Date.now() - olderThanMs;
  return db.select().from(schema.uploads)
    .where(olderThanMs > 0 ? lt(schema.uploads.createdAt, cutoff) : undefined).all()
    .filter((u) => !referenced.has(u.id));
}

const PART_GRACE_MS = 60 * 60_000;

/** Files under data/uploads and data/images with no DB row. A fresh `.part`
    (or any file touched within the last hour) is an upload in flight, not an
    orphan. */
async function orphanFiles(): Promise<{ dir: 'uploads' | 'images'; filename: string; size: number }[]> {
  const known = {
    uploads: new Set(db.select({ f: schema.uploads.filename }).from(schema.uploads).all().map((r) => r.f)),
    images: new Set(db.select({ f: schema.images.filename }).from(schema.images).all().map((r) => r.f)),
  };
  const out: { dir: 'uploads' | 'images'; filename: string; size: number }[] = [];
  const recent = Date.now() - PART_GRACE_MS;
  for (const dir of ['uploads', 'images'] as const) {
    const dirPath = path.join(config.dataDir, dir);
    let names: string[] = [];
    try { names = await fs.promises.readdir(dirPath); } catch { continue; }
    for (const filename of names) {
      if (known[dir].has(filename)) continue;
      try {
        const st = await fs.promises.lstat(path.join(dirPath, filename));
        if (!st.isFile() || st.mtimeMs > recent) continue;
        out.push({ dir, filename, size: st.size });
      } catch { /* vanished mid-scan */ }
    }
  }
  return out;
}

function freeSpaceAt(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

export async function storageOverview(): Promise<StorageOverview> {
  const up = db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${schema.uploads.size}), 0)` })
    .from(schema.uploads).get() ?? { n: 0, bytes: 0 };
  const unref = unreferencedUploads();
  const im = db.select({
    source: schema.images.source,
    n: sql<number>`count(*)`,
    bytes: sql<number>`coalesce(sum(${schema.images.byteSize}), 0)`,
  }).from(schema.images).groupBy(schema.images.source).all();
  const imgTotal = im.reduce((a, r) => ({ n: a.n + r.n, bytes: a.bytes + r.bytes }), { n: 0, bytes: 0 });
  const orphans = await orphanFiles();

  const uploadByUser = new Map(db.select({ userId: schema.uploads.userId, bytes: sql<number>`coalesce(sum(${schema.uploads.size}), 0)` })
    .from(schema.uploads).groupBy(schema.uploads.userId).all().map((r) => [r.userId, r.bytes]));
  const imageByUser = new Map(db.select({ userId: schema.images.userId, bytes: sql<number>`coalesce(sum(${schema.images.byteSize}), 0)` })
    .from(schema.images).groupBy(schema.images.userId).all().map((r) => [r.userId, r.bytes]));
  const users = db.select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.users).all();
  const topUsers = users.map((u) => ({
    userId: u.id, username: u.username, displayName: u.displayName,
    uploadBytes: uploadByUser.get(u.id) ?? 0, imageBytes: imageByUser.get(u.id) ?? 0,
  }))
    .filter((u) => u.uploadBytes + u.imageBytes > 0)
    .sort((a, b) => (b.uploadBytes + b.imageBytes) - (a.uploadBytes + a.imageBytes))
    .slice(0, 10);

  return {
    uploads: {
      count: up.n, bytes: up.bytes,
      unreferencedCount: unref.length, unreferencedBytes: unref.reduce((n, u) => n + u.size, 0),
    },
    images: {
      count: imgTotal.n, bytes: imgTotal.bytes,
      workshopBytes: im.find((r) => r.source === 'workshop')?.bytes ?? 0,
      chatBytes: im.find((r) => r.source === 'chat')?.bytes ?? 0,
    },
    orphans: { count: orphans.length, bytes: orphans.reduce((n, o) => n + o.size, 0) },
    limits: {
      total: config.maxTotalStorageBytes,
      perUserUploads: config.maxUserUploadBytes,
      perUserImages: config.maxUserImageBytes,
    },
    freeSpace: freeSpaceAt(config.dataDir),
    topUsers,
  };
}

/** Delete on-disk files nothing references. Returns bytes reclaimed. */
export async function removeOrphanFiles(): Promise<{ count: number; bytes: number }> {
  const orphans = await orphanFiles();
  let count = 0; let bytes = 0;
  for (const o of orphans) {
    try {
      await fs.promises.unlink(path.join(config.dataDir, o.dir, o.filename));
      count++; bytes += o.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.log(`[storage] keep orphan ${o.dir}/${o.filename}: ${(err as Error).message}`);
      }
    }
  }
  untrackedStorageBytes = Math.max(0, untrackedStorageBytes - bytes);
  return { count, bytes };
}

/**
 * Delete uploads that no saved message references and that are older than
 * `olderThanMs` (0 = regardless of age). Age matters: a file uploaded a minute
 * ago is most likely sitting in someone's composer draft, not abandoned.
 */
export async function removeUnreferencedUploads(olderThanMs: number): Promise<{ count: number; bytes: number }> {
  const rows = unreferencedUploads(olderThanMs);
  let count = 0; let bytes = 0;
  for (const row of rows) {
    // Re-check right before deleting: a message may have been saved meanwhile.
    if (uploadIsReferenced(row.id)) continue;
    try { await fs.promises.unlink(path.join(config.dataDir, 'uploads', row.filename)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.log(`[storage] keep upload ${row.id}: unlink failed (${(err as Error).message})`);
        continue;
      }
    }
    db.delete(schema.uploads).where(and(eq(schema.uploads.id, row.id), eq(schema.uploads.filename, row.filename))).run();
    count++; bytes += row.size;
  }
  return { count, bytes };
}

