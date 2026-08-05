import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { argon2Verify } from 'hash-wasm';
import { config } from './config.js';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
  return `s2$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Hashes imported from Open WebUI (bcrypt `$2b$`, argon2 `$argon2id$`) verify
// here so migrated users keep their passwords; on the first successful login
// the route re-hashes to our native scrypt format (see needsRehash).
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (stored.startsWith('s2$')) {
      const [, N, r, p, saltB64, hashB64] = stored.split('$');
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const actual = crypto.scryptSync(password, salt, expected.length, {
        N: Number(N), r: Number(r), p: Number(p),
      });
      return crypto.timingSafeEqual(actual, expected);
    }
    if (/^\$2[abxy]\$/.test(stored)) {
      // bcryptjs truncates at 72 UTF-8 bytes internally, matching Open WebUI's
      // own pre-truncation — pass the plaintext through untouched.
      return bcrypt.compareSync(password, stored);
    }
    if (stored.startsWith('$argon2')) {
      return await argon2Verify({ password, hash: stored });
    }
    return false;
  } catch {
    return false;
  }
}

// True for any hash not in our native scrypt format — the caller should
// re-hash with hashPassword() while it still has the plaintext in hand.
export function needsRehash(stored: string): boolean {
  return !stored.startsWith('s2$');
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
