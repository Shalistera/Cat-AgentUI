import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { db, schema } from './db/index.js';

export const SECRET_REDACTION = '[敏感信息已隐藏]';

type ProviderSecretsRow = {
  apiKeyEnc: string | null;
  vertexSaJsonEnc: string | null;
  extraHeaders: string;
  extraHeadersEnc?: string | null;
};

type McpSecretsRow = {
  envEnc: string | null;
  headersEnc: string | null;
};

function parseRecord(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

export function encryptSecretRecord(record: Record<string, string>): string | null {
  return Object.keys(record).length ? encryptSecret(JSON.stringify(record)) : null;
}

export function decryptSecretRecord(
  encrypted: string | null | undefined,
  label = '敏感配置',
): Record<string, string> {
  if (!encrypted) return {};
  try {
    return parseRecord(decryptSecret(encrypted));
  } catch {
    throw new Error(`无法解密${label}(SECRET_KEY 可能已更换),请重新填写并保存`);
  }
}

/** Read encrypted provider headers, with a temporary fallback for pre-0012 rows. */
export function providerExtraHeaders(row: ProviderSecretsRow): Record<string, string> {
  if (row.extraHeadersEnc) return decryptSecretRecord(row.extraHeadersEnc, 'Provider 自定义 Headers');
  return parseRecord(row.extraHeaders);
}

function addStringLeaves(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= 4) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addStringLeaves(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) addStringLeaves(item, out);
  }
}

export function providerSecretValues(row: ProviderSecretsRow): string[] {
  const out = new Set<string>();
  if (row.apiKeyEnc) {
    try { addStringLeaves(decryptSecret(row.apiKeyEnc), out); } catch { /* unusable secret */ }
  }
  if (row.vertexSaJsonEnc) {
    try {
      const json = decryptSecret(row.vertexSaJsonEnc);
      addStringLeaves(json, out);
      try { addStringLeaves(JSON.parse(json), out); } catch { /* raw value is still covered */ }
    } catch { /* unusable secret */ }
  }
  try { addStringLeaves(providerExtraHeaders(row), out); } catch { /* unusable secret */ }
  return [...out];
}

export function mcpSecretValues(row: McpSecretsRow): string[] {
  const out = new Set<string>();
  for (const enc of [row.envEnc, row.headersEnc]) {
    if (!enc) continue;
    try { addStringLeaves(parseRecord(decryptSecret(enc)), out); } catch { /* unusable secret */ }
  }
  return [...out];
}

/** Snapshot every server-side secret that must never enter a user-visible channel. */
export function allConfiguredSecretValues(extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  addStringLeaves(config.secretKey, out);
  for (const value of extra) addStringLeaves(value, out);

  for (const row of db.select({
    apiKeyEnc: schema.providers.apiKeyEnc,
    vertexSaJsonEnc: schema.providers.vertexSaJsonEnc,
    extraHeaders: schema.providers.extraHeaders,
    extraHeadersEnc: schema.providers.extraHeadersEnc,
  }).from(schema.providers).all()) {
    for (const value of providerSecretValues(row)) out.add(value);
  }
  for (const row of db.select({
    apiKeyEnc: schema.providerEndpoints.apiKeyEnc,
    extraHeadersEnc: schema.providerEndpoints.extraHeadersEnc,
  }).from(schema.providerEndpoints).all()) {
    for (const value of providerSecretValues({ ...row, vertexSaJsonEnc: null, extraHeaders: '{}' })) out.add(value);
  }
  for (const row of db.select({
    envEnc: schema.mcpServers.envEnc,
    headersEnc: schema.mcpServers.headersEnc,
  }).from(schema.mcpServers).all()) {
    for (const value of mcpSecretValues(row)) out.add(value);
  }
  return [...out];
}

function variants(values: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (value: string) => {
    if (value.length >= 4 && value !== SECRET_REDACTION) out.add(value);
  };
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    add(raw);
    if (raw.trim() !== raw) add(raw.trim());
    // These are common ways HTTP libraries and malicious/buggy tools echo a
    // credential. Bound transformations to keep redaction work predictable.
    if (raw.length <= 4096) {
      try { add(encodeURIComponent(raw)); } catch { /* ignore */ }
      add(JSON.stringify(raw).slice(1, -1));
      const b64 = Buffer.from(raw, 'utf8').toString('base64');
      add(b64);
      add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function redactPatterns(text: string, patterns: readonly string[]): string {
  let out = text;
  for (const pattern of patterns) {
    if (out.includes(pattern)) out = out.split(pattern).join(SECRET_REDACTION);
  }
  return out;
}

/** Defense in depth for unknown credentials embedded in labelled error text. */
function redactCredentialShapes(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${SECRET_REDACTION}`)
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api[_ -]?key|access[_ -]?token|secret|password)\b\s*["']?\s*[:=]\s*["']?)([^\s"',;}\]]{4,})/gi,
      `$1${SECRET_REDACTION}`,
    )
    .replace(/([?&](?:api_key|key|token|access_token)=)[^&#\s]+/gi, `$1${SECRET_REDACTION}`)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, SECRET_REDACTION);
}

export function redactKnownSecrets(text: string, values: readonly string[]): string {
  if (!text) return text;
  return redactPatterns(text, variants(values));
}

export function redactSensitiveText(text: string, values: readonly string[]): string {
  if (!text) return text;
  return redactCredentialShapes(redactKnownSecrets(text, values));
}

export function redactSensitiveValue<T>(value: T, values: readonly string[]): T {
  if (typeof value === 'string') return redactSensitiveText(value, values) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, values)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      out[redactSensitiveText(key, values)] = redactSensitiveValue(item, values);
    }
    return out as T;
  }
  return value;
}

/**
 * Exact secret redaction that remains safe when a Provider splits a key across
 * arbitrary SSE chunks. Only a suffix that is also a secret prefix is held, so
 * normal token streaming is not delayed by the longest configured credential.
 */
export class StreamingSecretRedactor {
  private readonly patterns: string[];
  private pending = '';

  constructor(values: readonly string[]) {
    this.patterns = variants(values);
  }

  push(chunk: string): string {
    if (!chunk) return '';
    this.pending += chunk;
    let output = '';

    for (;;) {
      let foundAt = -1;
      let found = '';
      for (const pattern of this.patterns) {
        const at = this.pending.indexOf(pattern);
        if (at >= 0 && (foundAt < 0 || at < foundAt || (at === foundAt && pattern.length > found.length))) {
          foundAt = at;
          found = pattern;
        }
      }
      if (foundAt >= 0) {
        const fromMatch = this.pending.slice(foundAt);
        // A configured value can be a prefix of another configured value. If
        // the bytes received so far still fit the longer value, do not redact
        // the shorter match and release the remaining (potentially sensitive)
        // suffix on the next chunk; keep the ambiguous suffix until it either
        // completes or diverges.
        if (this.patterns.some((pattern) => (
          pattern.length > found.length && pattern.startsWith(fromMatch)
        ))) {
          output += redactCredentialShapes(this.pending.slice(0, foundAt));
          this.pending = fromMatch;
          return output;
        }
        output += redactCredentialShapes(this.pending.slice(0, foundAt));
        output += SECRET_REDACTION;
        this.pending = this.pending.slice(foundAt + found.length);
        continue;
      }

      let keep = 0;
      for (const pattern of this.patterns) {
        const max = Math.min(this.pending.length, pattern.length - 1);
        for (let n = max; n > keep; n--) {
          if (this.pending.endsWith(pattern.slice(0, n))) {
            keep = n;
            break;
          }
        }
      }
      const ready = keep ? this.pending.slice(0, -keep) : this.pending;
      output += redactCredentialShapes(ready);
      this.pending = keep ? this.pending.slice(-keep) : '';
      return output;
    }
  }

  flush(): string {
    if (!this.pending) return '';
    // A stream ending halfway through a credential should not reveal a useful
    // prefix. Tiny coincidental suffixes are harmless and stay readable.
    const partialSecret = this.pending.length >= 4
      && this.patterns.some((pattern) => pattern.startsWith(this.pending));
    const output = partialSecret
      ? SECRET_REDACTION
      : redactCredentialShapes(redactPatterns(this.pending, this.patterns));
    this.pending = '';
    return output;
  }
}

/** Encrypt legacy plaintext Provider headers after schema migration 0012. */
export function migrateLegacyProviderHeaders(): number {
  const rows = db.select().from(schema.providers).all();
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const legacy = parseRecord(row.extraHeaders);
      if (!Object.keys(legacy).length) continue;
      // If an encrypted value already exists, it is authoritative; plaintext
      // should still be erased after an interrupted/partially rolled out start.
      const patch = row.extraHeadersEnc
        ? { extraHeaders: '{}' }
        : { extraHeaders: '{}', extraHeadersEnc: encryptSecretRecord(legacy) };
      db.update(schema.providers).set(patch).where(eq(schema.providers.id, row.id)).run();
      changed++;
    }
  });
  return changed;
}

/** Remove credentials that older versions may already have persisted in output. */
export function scrubPersistedSecretEchoes(): number {
  const values = allConfiguredSecretValues();
  if (!values.length) return 0;
  let changed = 0;
  const scrub = (value: string | null): string | null => (
    value === null ? null : redactKnownSecrets(value, values)
  );

  const messages = db.select({
    id: schema.messages.id, parts: schema.messages.parts,
    error: schema.messages.error, model: schema.messages.model,
  }).from(schema.messages).all();
  const chats = db.select({ id: schema.chats.id, title: schema.chats.title })
    .from(schema.chats).all();
  const modelRows = db.select({
    id: schema.models.id, modelId: schema.models.modelId, displayName: schema.models.displayName,
  }).from(schema.models).all();
  const mcpRows = db.select({
    id: schema.mcpServers.id,
    lastError: schema.mcpServers.lastError,
    toolsCache: schema.mcpServers.toolsCache,
  }).from(schema.mcpServers).all();
  const decks = db.select({
    id: schema.decks.id, title: schema.decks.title,
    spec: schema.decks.spec, model: schema.decks.model,
  }).from(schema.decks).all();
  const images = db.select({ id: schema.images.id, model: schema.images.model })
    .from(schema.images).all();
  const usageRows = db.select({ id: schema.usageLog.id, model: schema.usageLog.model })
    .from(schema.usageLog).all();

  db.transaction(() => {
    for (const row of messages) {
      const parts = scrub(row.parts)!;
      const error = scrub(row.error);
      const model = scrub(row.model);
      if (parts !== row.parts || error !== row.error || model !== row.model) {
        db.update(schema.messages).set({ parts, error, model })
          .where(eq(schema.messages.id, row.id)).run();
        changed++;
      }
    }
    for (const row of chats) {
      const title = scrub(row.title)!;
      if (title !== row.title) {
        db.update(schema.chats).set({ title }).where(eq(schema.chats.id, row.id)).run();
        changed++;
      }
    }
    for (const row of modelRows) {
      const modelId = scrub(row.modelId)!;
      const displayName = scrub(row.displayName);
      if (modelId !== row.modelId || displayName !== row.displayName) {
        db.update(schema.models).set({ modelId, displayName })
          .where(eq(schema.models.id, row.id)).run();
        changed++;
      }
    }
    for (const row of mcpRows) {
      const lastError = scrub(row.lastError);
      const toolsCache = scrub(row.toolsCache)!;
      if (lastError !== row.lastError || toolsCache !== row.toolsCache) {
        db.update(schema.mcpServers).set({ lastError, toolsCache })
          .where(eq(schema.mcpServers.id, row.id)).run();
        changed++;
      }
    }
    for (const row of decks) {
      const title = scrub(row.title)!;
      const spec = scrub(row.spec)!;
      const model = scrub(row.model);
      if (title !== row.title || spec !== row.spec || model !== row.model) {
        db.update(schema.decks).set({ title, spec, model })
          .where(eq(schema.decks.id, row.id)).run();
        changed++;
      }
    }
    for (const row of images) {
      const model = scrub(row.model);
      if (model !== row.model) {
        db.update(schema.images).set({ model }).where(eq(schema.images.id, row.id)).run();
        changed++;
      }
    }
    for (const row of usageRows) {
      const model = scrub(row.model);
      if (model !== row.model) {
        db.update(schema.usageLog).set({ model }).where(eq(schema.usageLog.id, row.id)).run();
        changed++;
      }
    }
  });
  return changed;
}
