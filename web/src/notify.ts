// 后台完成通知 — a system notification when long work (a reply, a batch of
// images, a translation) finishes while this tab is hidden or unfocused.
// Opt-in per browser: the permission is the browser's, so the switch lives in
// localStorage rather than the account. Companion to tabAlert (the ● badge),
// which keeps working regardless.

const KEY = 'cat-notify';

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyEnabled(): boolean {
  return notifySupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted';
}

/** Permission as the settings toggle sees it. */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  return notifySupported() ? Notification.permission : 'unsupported';
}

/** Turn on: asks the browser if needed. Resolves to the resulting on/off state. */
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  if (!notifySupported()) return false;
  if (!on) { localStorage.removeItem(KEY); return false; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { localStorage.removeItem(KEY); return false; }
  localStorage.setItem(KEY, '1');
  return true;
}

// Route change on click: the notification may be for a chat the tab has
// since navigated away from. Set once by the app shell (needs the router).
export const notifyNavigate: { handler: ((path: string) => void) | null } = { handler: null };

/**
 * Fire a notification if the tab is in the background and the person opted in.
 * `path` is where a click should take them (e.g. /chat/<id>).
 */
export function notifyDone(title: string, body: string, path?: string): void {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (!notifyEnabled()) return;
  try {
    const n = new Notification(title, {
      body: body.slice(0, 160),
      icon: '/icon-192.png',
      // Same tag per destination: a second completion in the same chat
      // replaces the first instead of stacking.
      tag: path ?? 'cat-agentui',
    });
    n.onclick = () => {
      window.focus();
      if (path) notifyNavigate.handler?.(path);
      n.close();
    };
    // Don't linger forever on desktops that never auto-dismiss.
    setTimeout(() => n.close(), 15_000);
  } catch { /* some browsers throw for non-persistent notifications on mobile */ }
}
