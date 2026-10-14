// Flags the tab when long-running work (chat reply, image generation, a tool
// call waiting for approval) finishes while the tab is hidden or unfocused,
// and clears it the moment the user comes back. No-op when the tab is
// already active.
//
// Three signals, so it reads at a glance in a crowded tab strip:
//   · the title leads with a coloured emoji and what happened
//     ("✅ 回复完成 · Cat AgentUI"), with a count once several pile up;
//   · the favicon gets a coloured dot — green done, red error, amber waiting;
//   · an installed app (desktop Chrome/Edge, iOS home screen) shows the count
//     on its icon via the Badging API.

import { t } from './i18n';

export type AlertKind = 'done' | 'error' | 'confirm';

// The most urgent pending event owns the title and the dot: something
// waiting on the person beats a failure, which beats a plain completion.
const STYLE: Record<AlertKind, { emoji: string; dot: string; rank: number }> = {
  done: { emoji: '✅', dot: '#16a34a', rank: 0 },
  error: { emoji: '⚠️', dot: '#dc2626', rank: 1 },
  confirm: { emoji: '🔔', dot: '#f59e0b', rank: 2 },
};

const BASE_TITLE = document.title;
const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
const BASE_ICON = iconLink?.getAttribute('href') ?? '';

let count = 0;
let top: { kind: AlertKind; label: string } | null = null;

type BadgeNavigator = Navigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };

/** The favicon is an inline SVG data URL (index.html); add a ringed dot top-right. */
function iconWithDot(color: string): string {
  const prefix = 'data:image/svg+xml,';
  if (!BASE_ICON.startsWith(prefix)) return BASE_ICON;
  const svg = decodeURIComponent(BASE_ICON.slice(prefix.length));
  const dot = `<circle cx='50' cy='14' r='13' fill='${color}' stroke='#ffffff' stroke-width='4'/>`;
  return prefix + encodeURIComponent(svg.replace(/<\/svg>\s*$/, `${dot}</svg>`));
}

function clear() {
  if (!count) return;
  count = 0;
  top = null;
  document.title = BASE_TITLE;
  iconLink?.setAttribute('href', BASE_ICON);
  (navigator as BadgeNavigator).clearAppBadge?.().catch(() => { /* unsupported */ });
}

window.addEventListener('focus', clear);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') clear();
});

/** `label` says what happened, e.g. t('回复完成'); each kind has a default. */
export function tabAlert(kind: AlertKind = 'done', label?: string) {
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  count += 1;
  if (!top || STYLE[kind].rank >= STYLE[top.kind].rank) {
    top = { kind, label: label ?? (kind === 'error' ? t('出错了') : kind === 'confirm' ? t('等你确认') : t('已完成')) };
  }
  document.title = `${count > 1 ? `(${count}) ` : ''}${STYLE[top.kind].emoji} ${top.label} · ${BASE_TITLE}`;
  iconLink?.setAttribute('href', iconWithDot(STYLE[top.kind].dot));
  // Only installed apps show it; iOS also wants notification permission.
  (navigator as BadgeNavigator).setAppBadge?.(count).catch(() => { /* unsupported */ });
}
