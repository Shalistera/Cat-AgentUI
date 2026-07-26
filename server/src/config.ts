import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// serverRoot = server/ (works from both src/ via tsx and dist/ after tsc)
const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(serverRoot, '..');

const envPath = path.join(repoRoot, '.env');

function loadEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = loadEnvFile();
const env = (k: string, def?: string) => process.env[k] ?? fileEnv[k] ?? def;

// Auto-generate a secret key on first run and persist it.
let secretKey = env('SECRET_KEY');
if (!secretKey) {
  secretKey = crypto.randomBytes(32).toString('base64url');
  fs.appendFileSync(envPath, `${fs.existsSync(envPath) && fs.readFileSync(envPath, 'utf8').length > 0 ? '\n' : ''}SECRET_KEY=${secretKey}\n`);
}

export const config = {
  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0')!,
  secretKey,
  dataDir: env('DATA_DIR', path.join(repoRoot, 'data'))!,
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  sessionTtlMs: Number(env('SESSION_TTL_DAYS', '30')) * 24 * 3600 * 1000,
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
  // Hard caps to protect the box
  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '20')) * 1024 * 1024,
  maxToolIterations: Number(env('MAX_TOOL_ITERATIONS', '10')),
};

for (const d of ['', 'uploads', 'images']) {
  fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
}
