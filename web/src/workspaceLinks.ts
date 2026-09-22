/** Stable, same-origin links that open a file in its chat's workspace panel. */
export function workspaceFileHref(chatId: string, path: string): string {
  const encoded = encodeURIComponent(path).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `/chat/${encodeURIComponent(chatId)}?file=${encoded}`;
}

export function normalizeWorkspacePath(path: string): string | null {
  const raw = path.trim().replace(/\\/g, '/');
  if (!raw || raw.length > 200 || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.length > 8 || parts.some((p) => p.startsWith('.') || p.length > 120)) return null;
  return parts.join('/');
}

export function resolveWorkspaceLink(href: string, origin: string, chatId?: string): { chatId: string; path: string } | null {
  try {
    const url = new URL(href, `${origin}/chat/${chatId ?? ''}`);
    if (url.origin !== origin) return null;
    const chat = /^\/chat\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (chat && url.searchParams.has('file')) {
      const path = normalizeWorkspacePath(url.searchParams.get('file')!);
      return path ? { chatId: chat[1], path } : null;
    }
    // Older replies invented relative file links or /chat/<filename> URLs.
    // Interpret only file-shaped paths in this chat, never other sites, chat
    // IDs, anchors, API endpoints or arbitrary application routes.
    if (!chatId || url.search || url.hash || !url.pathname.startsWith('/chat/')) return null;
    const path = normalizeWorkspacePath(decodeURIComponent(url.pathname.slice('/chat/'.length)));
    return path && /\.[A-Za-z0-9]{1,16}$/.test(path) ? { chatId, path } : null;
  } catch {
    return null;
  }
}
