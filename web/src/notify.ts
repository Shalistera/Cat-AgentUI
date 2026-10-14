// 后台完成通知 — a system notification when long work (a reply, a batch of
// images, a PPT) finishes while this tab is hidden or unfocused.
// Opt-in per browser: the permission is the browser's, so the switch lives in
// localStorage rather than the account. Companion to tabAlert (title and
// favicon marker), which keeps working regardless.
//
// Notifications go through the service worker registration when there is
// one: Android Chrome throws on `new Notification()` from a page, and a
// worker-owned notification can still open the app after its tab was closed.

import { create } from 'zustand';

const KEY = 'cat-notify';
const NUDGE_KEY = 'cat-notify-nudge';
const NUDGE_SNOOZE_MS = 30 * 86_400_000;

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

// Shown by the page itself (no worker) — closed when the person comes back.
const pageNotes = new Set<Notification>();

async function show(title: string, body: string, path?: string): Promise<void> {
  const options: NotificationOptions & { renotify?: boolean } = {
    body: body.slice(0, 160),
    icon: '/icon-192.png',
    // Same tag per destination: a second completion in the same chat
    // replaces the first instead of stacking — and still alerts.
    tag: path ?? 'cat-agentui',
    renotify: true,
    data: { url: path ?? '/' },
  };
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (reg?.active) {
    try { await reg.showNotification(title, options); return; } catch { /* fall back to the page */ }
  }
  const n = new Notification(title, options);
  pageNotes.add(n);
  n.onclose = () => { pageNotes.delete(n); };
  n.onclick = () => {
    window.focus();
    if (path) notifyNavigate.handler?.(path);
    n.close();
  };
}

/**
 * Fire a notification if the tab is in the background and the person opted in.
 * `path` is where a click should take them (e.g. /chat/<id>).
 */
export function notifyDone(title: string, body: string, path?: string): void {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (!notifyEnabled()) { noteMissed(); return; }
  show(title, body, path).catch(() => { /* the tab marker still shows */ });
}

/** Settings → 发送测试通知. Shown even while the tab has focus. */
export function notifyTest(title: string, body: string): Promise<void> {
  return show(title, body, location.pathname);
}

// Back in the app → the system copies are stale; clear ours.
function clearShown() {
  for (const n of pageNotes) n.close();
  navigator.serviceWorker?.getRegistration()
    .then((reg) => reg?.getNotifications())
    .then((list) => list?.forEach((n) => n.close()))
    .catch(() => { /* nothing to clear */ });
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', clearShown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') clearShown();
  });
}

// ---- 开启通知 nudge ----
// Asking on page load gets the prompt ignored — Safari and Firefox only
// allow it from a click, and Chrome often shrinks it to an address-bar icon.
// Ask right after it would have helped instead: work finished while the
// person was away and nothing could tell them. The banner is waiting when
// they come back; 不用了 snoozes it for 30 days.

interface NudgeState {
  show: boolean;
  dismiss(): void;
}

export const useNotifyNudge = create<NudgeState>((set) => ({
  show: false,
  dismiss() {
    try { localStorage.setItem(NUDGE_KEY, String(Date.now() + NUDGE_SNOOZE_MS)); } catch { /* ignore */ }
    set({ show: false });
  },
}));

function noteMissed(): void {
  // Denied, unsupported, or granted but switched off here: already decided.
  if (notifyPermission() !== 'default') return;
  try {
    if (Date.now() < (Number(localStorage.getItem(NUDGE_KEY)) || 0)) return;
  } catch { return; }
  useNotifyNudge.setState({ show: true });
}
