import fs from 'node:fs';
import path from 'node:path';
import { eq, like, sql } from 'drizzle-orm';
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

export interface OwnedMedia {
  kind: StorageKind;
  id: string;
  mime: string;
  size: number;
  filePath: string;
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
    return { kind: 'upload', id, mime: row.mime, size: stat.size, filePath };
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
  if (media.size > maxBytes) throw new Error('图片超过上下文大小限制');
  const buf = await fs.promises.readFile(media.filePath);
  if (buf.length > maxBytes) throw new Error('图片超过上下文大小限制');
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
    return parts.flatMap((p) => p.type === 'image' && p.uploadId ? [p.uploadId] : []);
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
