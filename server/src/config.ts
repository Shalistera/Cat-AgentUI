import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Runtime-created databases, WAL files, media, and secret files must not inherit
// a permissive service-manager umask (the previous default produced 0644 DBs).
process.umask(0o077);

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

function intEnv(key: string, def: number, min: number, max: number): number {
  const raw = env(key, String(def));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min}-${max} 之间的整数`);
  }
  return value;
}

const MIB = 1024 * 1024;
const maxModelOutputTokens = intEnv('MAX_MODEL_OUTPUT_TOKENS', 65_536, 1_000, 1_000_000);
const defaultModelOutputTokens = intEnv('DEFAULT_MODEL_OUTPUT_TOKENS', 8_192, 256, maxModelOutputTokens);

// Auto-generate a secret key on first run and persist it.
let secretKey = env('SECRET_KEY');
if (!secretKey) {
  secretKey = crypto.randomBytes(32).toString('base64url');
  fs.appendFileSync(
    envPath,
    `${fs.existsSync(envPath) && fs.readFileSync(envPath, 'utf8').length > 0 ? '\n' : ''}SECRET_KEY=${secretKey}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
try { fs.chmodSync(envPath, 0o600); } catch { /* read-only/external secret source */ }

export const config = {
  port: intEnv('PORT', 3000, 1, 65535),
  host: env('HOST', '0.0.0.0')!,
  secretKey,
  dataDir: env('DATA_DIR', path.join(repoRoot, 'data'))!,
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  sessionTtlMs: intEnv('SESSION_TTL_DAYS', 30, 1, 365) * 24 * 3600 * 1000,
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
  // Request/context budgets. Image bytes are raw bytes before base64 expansion.
  maxUploadBytes: intEnv('MAX_UPLOAD_MB', 20, 1, 100) * MIB,
  maxAttachmentsPerMessage: intEnv('MAX_ATTACHMENTS_PER_MESSAGE', 4, 1, 10),
  maxMessageAttachmentBytes: intEnv('MAX_MESSAGE_ATTACHMENT_MB', 20, 1, 100) * MIB,
  maxMessageTextChars: intEnv('MAX_MESSAGE_TEXT_CHARS', 64_000, 1_000, 500_000),
  maxContextMessages: intEnv('MAX_CONTEXT_MESSAGES', 40, 2, 500),
  // 临时对话 idle lifetime before the sweeper deletes it (messages + uploads).
  tempChatTtlMs: intEnv('TEMP_CHAT_TTL_HOURS', 24, 1, 720) * 3600_000,
  maxContextTextChars: intEnv('MAX_CONTEXT_TEXT_CHARS', 240_000, 10_000, 2_000_000),
  maxContextImageBytes: intEnv('MAX_CONTEXT_IMAGE_MB', 24, 1, 200) * MIB,
  maxContextImages: intEnv('MAX_CONTEXT_IMAGES', 6, 1, 20),
  maxContextImageBytesPerUser: intEnv('MAX_CONTEXT_IMAGE_MB_PER_USER', 48, 1, 500) * MIB,
  maxContextImageBytesGlobal: intEnv('MAX_CONTEXT_IMAGE_MB_GLOBAL', 96, 1, 2_000) * MIB,
  defaultModelOutputTokens,
  maxModelOutputTokens,
  maxTurnOutputChars: intEnv('MAX_TURN_OUTPUT_CHARS', 500_000, 1_000, 5_000_000),
  chatTurnTimeoutMs: intEnv('CHAT_TURN_TIMEOUT_SECONDS', 900, 1, 3_600) * 1000,
  chatProviderIdleTimeoutMs: intEnv('CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS', 120, 1, 600) * 1000,

  // Persistent-storage quotas.
  maxUserUploadBytes: intEnv('MAX_USER_UPLOAD_MB', 512, 1, 100_000) * MIB,
  maxUserImageBytes: intEnv('MAX_USER_IMAGE_MB', 1024, 1, 100_000) * MIB,
  maxTotalStorageBytes: intEnv('MAX_TOTAL_STORAGE_MB', 10_240, 10, 1_000_000) * MIB,
  maxGeneratedImageBytes: intEnv('MAX_GENERATED_IMAGE_MB', 20, 1, 100) * MIB,

  // Process-local admission control (deployment intentionally runs one process).
  maxChatConcurrencyPerUser: intEnv('MAX_CHAT_CONCURRENCY_PER_USER', 2, 1, 10),
  maxChatConcurrencyGlobal: intEnv('MAX_CHAT_CONCURRENCY_GLOBAL', 20, 1, 100),
  // Per-user cap spans *distinct* models — the same model never runs twice at
  // once for one user (see admission.ts).
  maxImageConcurrencyPerUser: intEnv('MAX_IMAGE_CONCURRENCY_PER_USER', 3, 1, 8),
  maxImageConcurrencyGlobal: intEnv('MAX_IMAGE_CONCURRENCY_GLOBAL', 8, 1, 40),
  passwordConcurrency: intEnv('PASSWORD_CONCURRENCY', 2, 1, 8),
  passwordQueueMax: intEnv('PASSWORD_QUEUE_MAX', 32, 1, 500),

  maxToolIterations: intEnv('MAX_TOOL_ITERATIONS', 10, 1, 50),

  // 工作区 (per-chat file directory the model edits through tools).
  maxWorkspaceBytes: intEnv('MAX_WORKSPACE_MB', 64, 1, 10_000) * MIB,
  maxWorkspaceFileBytes: intEnv('MAX_WORKSPACE_FILE_MB', 8, 1, 200) * MIB,
  maxWorkspaceFiles: intEnv('MAX_WORKSPACE_FILES', 500, 10, 10_000),

  // Scheduled SQLite snapshots (see backup.ts). 0 hours = disabled.
  backupIntervalHours: intEnv('BACKUP_INTERVAL_HOURS', 24, 0, 720),
  backupKeep: intEnv('BACKUP_KEEP', 14, 1, 365),
};

for (const d of ['', 'uploads', 'images', 'workspaces']) {
  const dir = path.join(config.dataDir, d);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on unusual filesystems */ }
}
