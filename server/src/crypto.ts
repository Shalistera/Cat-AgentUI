import crypto from 'node:crypto';
import { config } from './config.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export class PasswordQueueFullError extends Error {
  readonly statusCode = 503;
  constructor() { super('密码服务繁忙,请稍后重试'); }
}

interface PasswordJob<T> {
  run(): Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

let activePasswordJobs = 0;
const passwordQueue: PasswordJob<unknown>[] = [];

function drainPasswordQueue(): void {
  while (activePasswordJobs < config.passwordConcurrency && passwordQueue.length) {
    const job = passwordQueue.shift()!;
    activePasswordJobs++;
    void job.run().then(job.resolve, job.reject).finally(() => {
      activePasswordJobs--;
      drainPasswordQueue();
    });
  }
}

function enqueuePasswordJob<T>(run: () => Promise<T>): Promise<T> {
  if (activePasswordJobs >= config.passwordConcurrency
    && passwordQueue.length >= config.passwordQueueMax) {
    return Promise.reject(new PasswordQueueFullError());
  }
  return new Promise<T>((resolve, reject) => {
    passwordQueue.push({ run, resolve, reject } as PasswordJob<unknown>);
    drainPasswordQueue();
  });
}

function scryptAsync(
  password: string, salt: Buffer, length: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, { ...params, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await enqueuePasswordJob(() => scryptAsync(password, salt, 32, SCRYPT_PARAMS));
  return `s2$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [tag, N, r, p, saltB64, hashB64] = stored.split('$');
    if (tag !== 's2') return false;
    const params = { N: Number(N), r: Number(r), p: Number(p) };
    if (!Number.isSafeInteger(params.N) || params.N < 16_384 || params.N > 131_072
      || (params.N & (params.N - 1)) !== 0
      || !Number.isSafeInteger(params.r) || params.r < 1 || params.r > 32
      || !Number.isSafeInteger(params.p) || params.p < 1 || params.p > 16) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length < 8 || salt.length > 64 || expected.length < 16 || expected.length > 64) return false;
    const actual = await enqueuePasswordJob(() => scryptAsync(password, salt, expected.length, params));
    return crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    if (err instanceof PasswordQueueFullError) throw err;
    return false;
  }
}

// --- Secrets at rest (provider API keys) ---
const encKey = crypto.createHash('sha256').update(config.secretKey + ':enc:v1').digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${iv.toString('base64')}$${tag.toString('base64')}$${ct.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [v, ivB64, tagB64, ctB64] = stored.split('$');
  if (v !== 'v1') throw new Error('bad secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = () => crypto.randomUUID();
