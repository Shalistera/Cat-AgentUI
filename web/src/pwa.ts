// 添加到桌面 / 安装为应用.
//
// Chrome, Edge and Samsung Internet (Android and desktop) fire
// `beforeinstallprompt`; we keep the event so our own button can open the
// native install sheet later. iOS has no API at all — the guide walks through
// the Share sheet instead. In-app browsers (WeChat, QQ, DingTalk, Feishu…)
// cannot install anything, so they are first sent out to a real browser.
//
// The listeners are attached at import time: the event can fire before React
// mounts, and it fires only once per page load.

import { create } from 'zustand';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform =
  | 'installed'       // running as the app, or installed from this browser
  | 'android-prompt'  // native one-tap install is available
  | 'android-manual'  // Android browser without the prompt: its own menu
  | 'ios-safari'      // Share → 添加到主屏幕
  | 'ios-other'       // Chrome / Edge / Firefox on iOS: their share sheet
  | 'in-app'          // WeChat & co.: open in a browser first
  | 'desktop-prompt'  // Chrome / Edge on a computer
  | 'desktop-safari'  // macOS Safari: File → Add to Dock
  | 'desktop-other';  // nothing to offer

export type InAppHost = 'wechat' | 'wecom' | 'qq' | 'dingtalk' | 'feishu' | 'weibo' | 'other';

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
    .some((m) => window.matchMedia(`(display-mode: ${m})`).matches);
}

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  return /Android/i.test(ua);
}

export function isMobile(): boolean {
  return isIOS() || isAndroid();
}

export function inAppHost(): InAppHost | null {
  if (/wxwork/i.test(ua)) return 'wecom'; // also says MicroMessenger
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/DingTalk/i.test(ua)) return 'dingtalk';
  if (/Lark|Feishu/i.test(ua)) return 'feishu';
  if (/Weibo/i.test(ua)) return 'weibo';
  if (/\bQQ\//.test(ua)) return 'qq'; // \b keeps the standalone MQQBrowser out
  if (/AlipayClient|aweme|BytedanceWebview|FBAN|FBAV|Instagram|\bLine\//.test(ua)) return 'other';
  return null;
}

/** Safari's own major version (the OS version in the UA is frozen since iOS 26). */
export function iosSafariMajor(): number {
  const m = ua.match(/Version\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

// ---- install state ----
// "Installed" is remembered per browser: once the app is installed, the
// browser tab no longer gets the prompt, and without the flag the phone card
// would start teaching the manual steps instead. On Android the installed app
// shares storage with Chrome, so running standalone sets it too.

const INSTALLED_KEY = 'cat-installed';

function readInstalled(): boolean {
  try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch { return false; }
}

function rememberInstalled(): void {
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* private mode */ }
}

interface InstallState {
  prompt: BeforeInstallPromptEvent | null;
  installed: boolean;
  guideOpen: boolean;
  openGuide(): void;
  closeGuide(): void;
}

export const useInstall = create<InstallState>((set) => ({
  prompt: null,
  installed: readInstalled(),
  guideOpen: false,
  openGuide() { set({ guideOpen: true }); },
  closeGuide() { set({ guideOpen: false }); },
}));

if (typeof window !== 'undefined') {
  if (isStandalone()) rememberInstalled();
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress Chrome's own mini-infobar; we offer the install at a better moment.
    e.preventDefault();
    useInstall.setState({ prompt: e as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => {
    rememberInstalled();
    useInstall.setState({ prompt: null, installed: true });
  });
}

export function installPlatform(prompt: BeforeInstallPromptEvent | null, installed: boolean): InstallPlatform {
  if (isStandalone()) return 'installed';
  if (inAppHost()) return 'in-app';
  if (isIOS()) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  // A fresh prompt beats the remembered flag: the browser only offers it
  // while the app is not installed (any more).
  if (prompt) return isAndroid() ? 'android-prompt' : 'desktop-prompt';
  if (installed) return 'installed';
  if (isAndroid()) return 'android-manual';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'desktop-safari';
  return 'desktop-other';
}

export function useInstallPlatform(): InstallPlatform {
  const prompt = useInstall((s) => s.prompt);
  const installed = useInstall((s) => s.installed);
  return installPlatform(prompt, installed);
}

/** Opens the browser's native install sheet. Resolves true when accepted. */
export async function runInstallPrompt(): Promise<boolean> {
  const { prompt } = useInstall.getState();
  if (!prompt) return false;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  // A prompt event is single-use either way.
  if (outcome === 'accepted') rememberInstalled();
  useInstall.setState({ prompt: null, ...(outcome === 'accepted' ? { installed: true } : {}) });
  return outcome === 'accepted';
}

// ---- when to offer it unprompted (phones and tablets only) ----
// Not on the first visit — a card before the person has used the app is
// just an ad. From the second visit on; 以后再说 snoozes it for two weeks on
// this device and the third dismissal retires it. The account menu entry stays.

const VISITS_KEY = 'cat-install-visits';
const SNOOZE_KEY = 'cat-install-snooze';
const DISMISSALS_KEY = 'cat-install-dismissals';
const SNOOZE_MS = 14 * 86_400_000;
const MAX_DISMISSALS = 3;

// A visit is a browser session, not a page load — refreshing doesn't count.
let visits = 0;
try {
  visits = Number(localStorage.getItem(VISITS_KEY)) || 0;
  if (!sessionStorage.getItem(VISITS_KEY)) {
    sessionStorage.setItem(VISITS_KEY, '1');
    localStorage.setItem(VISITS_KEY, String(++visits));
  }
} catch { /* private mode: never nag */ }

export function installNudgeDue(): boolean {
  if (!isMobile() || isStandalone()) return false;
  try {
    if ((Number(localStorage.getItem(DISMISSALS_KEY)) || 0) >= MAX_DISMISSALS) return false;
    if (Date.now() < (Number(localStorage.getItem(SNOOZE_KEY)) || 0)) return false;
  } catch { return false; }
  return visits >= 2;
}

export function snoozeInstallNudge(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    localStorage.setItem(DISMISSALS_KEY, String((Number(localStorage.getItem(DISMISSALS_KEY)) || 0) + 1));
  } catch { /* ignore */ }
}

// ---- shared guide link: https://host/?install ----
// Remembered across the login redirect, consumed once.

const LINK_KEY = 'cat-install-link';
try {
  if (new URLSearchParams(location.search).has('install')) sessionStorage.setItem(LINK_KEY, '1');
} catch { /* ignore */ }

export function takeInstallLinkFlag(): boolean {
  try {
    if (!sessionStorage.getItem(LINK_KEY)) return false;
    sessionStorage.removeItem(LINK_KEY);
    return true;
  } catch { return false; }
}

// ---- service worker (notifications only — see public/sw.js) ----

export function registerServiceWorker(onNavigate: (path: string) => void): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* notifications fall back to the page */ });
  };
  // Off the startup path: nothing needs the worker until work finishes.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
  // A clicked notification asks an open tab to route there (sw.js).
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type !== 'cat-navigate' || !data.url) return;
    const url = new URL(data.url, location.origin);
    if (url.origin === location.origin) onNavigate(url.pathname + url.search);
  });
}
