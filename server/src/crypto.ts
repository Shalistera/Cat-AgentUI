import crypto from 'node:crypto';
import { config } from './config.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
  return `s2$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [tag, N, r, p, saltB64, hashB64] = stored.split('$');
    if (tag !== 's2') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
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
