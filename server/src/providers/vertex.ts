// Vertex AI endpoints for Gemini. One provider can list several locations in
// priority order (e.g. "global,us,eu"): each becomes a line the failover layer
// walks when the one before it is rate limited or down, so a 429 from one
// shared-capacity pool is retried against the next pool in the same request.
// Backup service accounts (other projects and billing accounts) add lines on
// the first location: Standard PayGo throughput is granted per organization,
// so an account outside the main one's organization is rate limited on its
// own, at the standard price.
// Priority PayGo (a pricier consumption option with steadier capacity) can
// ride on every request or only on one last attempt after the standard lines.

/** Multi-region locations: processing stays inside the jurisdiction, and the
 * host is `aiplatform.<loc>.rep.googleapis.com` rather than `<loc>-aiplatform`. */
const MULTI_REGIONS = new Set(['us', 'eu']);

export const MAX_VERTEX_LOCATIONS = 6;
export const MAX_VERTEX_ACCOUNTS = 5;

export type VertexPriorityMode = 'off' | 'fallback' | 'first_failure' | 'always';

export function parsePriorityMode(raw: string | null | undefined): VertexPriorityMode {
  return raw === 'fallback' || raw === 'first_failure' || raw === 'always' ? raw : 'off';
}

/** The stored comma-separated list, in the admin's order. Empty = global. */
export function parseVertexLocations(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[\s,，、]+/)) {
    const loc = part.trim().toLowerCase();
    if (loc && !out.includes(loc)) out.push(loc);
  }
  return out.length ? out : ['global'];
}

/** Validate admin input and return the value to store (null = default global).
 * Throws with a user-facing message on a malformed location. */
export function normalizeVertexLocations(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const locs = parseVertexLocations(raw);
  for (const loc of locs) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(loc)) throw new Error(`Vertex 区域「${loc}」格式不对,应为 global、us、eu 或 us-central1 这样的区域名`);
  }
  if (locs.length > MAX_VERTEX_LOCATIONS) throw new Error(`Vertex 区域最多 ${MAX_VERTEX_LOCATIONS} 个`);
  return locs.join(',');
}

export function vertexOrigin(location: string): string {
  if (location === 'global') return 'https://aiplatform.googleapis.com';
  if (MULTI_REGIONS.has(location)) return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

/** Priority PayGo is offered on the global and us/eu multi-region endpoints
 * only — single regions such as us-central1 reject it. */
export function priorityLocation(location: string): boolean {
  return location === 'global' || MULTI_REGIONS.has(location);
}

/** Priority PayGo covers the Gemini text models (2.5 and newer); image, TTS,
 * live, embedding and other specialised variants are left on standard PayGo. */
export function priorityModel(model: string): boolean {
  return /^gemini-\d/.test(model) && !/image|tts|live|audio|embedding|omni|transcribe|translate/.test(model);
}

/** Request header that asks for Priority PayGo (spilling over from any
 * Provisioned Throughput first, which is a no-op for projects without it). */
export const PRIORITY_HEADER = 'x-vertex-ai-llm-shared-request-type';

/** Where one Vertex line sends a model call, and whether it asks for
 * Priority PayGo. A custom base URL (a proxy) replaces only the host. */
export function vertexTarget(
  line: { baseUrl: string | null; vertexLocation: string | null; vertexPriority?: boolean },
  project: string, model: string, verb: string,
): { url: string; priority: boolean } {
  const location = parseVertexLocations(line.vertexLocation)[0];
  const origin = (line.baseUrl || vertexOrigin(location)).replace(/\/+$/, '');
  return {
    url: `${origin}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:${verb}`,
    priority: !!line.vertexPriority && priorityLocation(location) && priorityModel(model),
  };
}

export interface VertexLine {
  /** Circuit-breaker key; the first line is the provider's own. */
  key: string;
  location: string;
  priority: boolean;
  name: string;
  /** Only on the Priority fallback line: it serves just the models Priority
   * PayGo covers, and requests skip ahead to it after repeated rate limits. */
  onlyPriorityModels?: true;
  /** Only on a backup account's line: the account's id. */
  account?: string;
}

/** Circuit-breaker key of a backup account's line. */
export function vertexAccountLineKey(providerId: string, accountId: string): string {
  return `${providerId}:vertex-account:${accountId}`;
}

function lineLabel(location: string, priority: boolean, account?: number): string {
  return `Vertex ${location}${account ? ` · 账号 ${account}` : ''}${priority ? ' · Priority' : ''}`;
}

/** Every line a Vertex provider walks, in order: the first location on the
 * provider's own account, then each enabled backup account on that location,
 * then the other locations on the provider's account. All are standard PayGo
 * (Priority when the mode is 'always' and the location offers it). Last, in
 * 'fallback' and 'first_failure' modes, one Priority attempt on the
 * provider's account — on global when it is listed (the largest pool, and
 * the only one carrying some preview models), else on the first location
 * that offers Priority. The first entry is the provider's own line, keyed as
 * the primary. */
export function vertexLines(p: {
  id: string; vertexLocation: string | null; vertexPriority?: string | null; primaryName?: string | null;
}, accounts: readonly { id: string; enabled: number | boolean }[] = []): VertexLine[] {
  const mode = parsePriorityMode(p.vertexPriority);
  const locs = parseVertexLocations(p.vertexLocation);
  const lines: VertexLine[] = locs.map((location, i) => {
    const priority = mode === 'always' && priorityLocation(location);
    return {
      key: i === 0 ? `${p.id}:primary` : `${p.id}:vertex:${location}`,
      location,
      priority,
      name: lineLabel(location, priority),
    };
  });
  // Numbered by place in the admin's list (the provider's own account being
  // 1), disabled ones included, so a line keeps its name when another one is
  // switched off.
  const backups = accounts.flatMap((a, i): VertexLine[] => a.enabled ? [{
    key: vertexAccountLineKey(p.id, a.id), location: locs[0], priority: lines[0].priority,
    name: lineLabel(locs[0], lines[0].priority, i + 2), account: a.id,
  }] : []);
  lines.splice(1, 0, ...backups);
  if (mode === 'fallback' || mode === 'first_failure') {
    const location = locs.includes('global') ? 'global' : locs.find(priorityLocation);
    if (location) {
      lines.push({
        key: `${p.id}:vertex:${location}:priority`, location, priority: true,
        name: lineLabel(location, true), onlyPriorityModels: true,
      });
    }
  }
  // A single plain line keeps the familiar "主线路" wording; the admin's own
  // label for the provider's line wins either way.
  if (p.primaryName) lines[0].name = p.primaryName;
  else if (lines.length === 1) lines[0].name = '主线路';
  return lines;
}
