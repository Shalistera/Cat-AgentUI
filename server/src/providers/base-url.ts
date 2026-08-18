// Base URLs are typed by hand, and every vendor's docs show a different part
// of the URL: a bare origin, an origin plus a version prefix, or the full
// endpoint. Each adapter appends its own paths, so anything past the root the
// adapter builds on has to come off first — otherwise the request lands on
// /v1/chat/completions/chat/completions and the user is left guessing.

/** Trailing slashes and whitespace off; nothing else touched. */
export function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Drop a trailing API endpoint (longest match wins, so `/chat/completions`
 * beats `/completions`). Case-insensitive; the surviving prefix keeps its
 * original casing.
 */
export function stripEndpointSuffix(url: string, suffixes: string[]): string {
  const u = trimUrl(url);
  const lower = u.toLowerCase();
  let hit = '';
  for (const s of suffixes) {
    if (s.length > hit.length && lower.endsWith(s)) hit = s;
  }
  return hit ? trimUrl(u.slice(0, -hit.length)) : u;
}

/** True for `https://host` / `https://host/` — an origin with no path of its own. */
export function isBareOrigin(url: string): boolean {
  try {
    return trimUrl(new URL(url).pathname) === '';
  } catch {
    return false;
  }
}
