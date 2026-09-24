// Vertex AI endpoints for Gemini. One provider can list several locations in
// priority order (e.g. "global,us,eu"): each becomes a line the failover layer
// walks when the one before it is rate limited or down, so a 429 from one
// shared-capacity pool is retried against the next pool in the same request.
// Priority PayGo (a pricier consumption option with steadier capacity) can
// ride on every request or only on one last attempt after the standard lines.

/** Multi-region locations: processing stays inside the jurisdiction, and the
 * host is `aiplatform.<loc>.rep.googleapis.com` rather than `<loc>-aiplatform`. */
const MULTI_REGIONS = new Set(['us', 'eu']);

export const MAX_VERTEX_LOCATIONS = 6;

export type VertexPriorityMode = 'off' | 'fallback' | 'always';

export function parsePriorityMode(raw: string | null | undefined): VertexPriorityMode {
  return raw === 'fallback' || raw === 'always' ? raw : 'off';
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
}

function lineLabel(location: string, priority: boolean): string {
  return `Vertex ${location}${priority ? ' · Priority' : ''}`;
}

/** Every line a Vertex provider walks, in order: each location on standard
 * PayGo (Priority when the mode is 'always' and the location offers it), then,
 * in 'fallback' mode, one Priority attempt — on global when it is listed (the
 * largest pool, and the only one carrying some preview models), else on the
 * first location that offers Priority. The first entry is the provider's own
 * line, keyed as the primary. */
export function vertexLines(p: {
  id: string; vertexLocation: string | null; vertexPriority?: string | null; primaryName?: string | null;
}): VertexLine[] {
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
  if (mode === 'fallback') {
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
