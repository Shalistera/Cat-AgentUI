import { fmtTokens } from '../api';
import type { UsageByDay } from '../types';
import { locale, t } from '../i18n';

// The one daily-tokens bar chart, shared by the admin dashboard and the user's
// settings page — same axis math, same gridlines, same hover feedback.

/** Last n calendar days (local time, today inclusive) as YYYY-MM-DD keys. */
function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/** Round a maximum up to a clean axis number (1/2/2.5/5 × 10^k). */
function niceCeil(v: number): number {
  if (v <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 2, 2.5, 5, 10]) {
    if (s * pow >= v) return s * pow;
  }
  return 10 * pow;
}

/** Small counts stay exact; big ones compress ("12.4k"). */
const fmtTick = (v: number) => (v === 0 ? '0' : v < 10_000 ? v.toLocaleString() : fmtTokens(v));

export function TokensBarChart({ byDay, days = 30 }: { byDay: UsageByDay[]; days?: number }) {
  const map = new Map(byDay.map((d) => [d.day, d]));
  const series = lastDays(days).map((day) => {
    const d = map.get(day);
    return { day, totalTokens: d?.totalTokens ?? 0, requests: d?.requests ?? 0 };
  });

  // viewBox geometry — responsive via w-full
  const W = 800; const H = 200;
  const padL = 44; const padR = 8; const padT = 10; const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = niceCeil(Math.max(...series.map((d) => d.totalTokens)));
  const slot = plotW / series.length;
  const barW = Math.max(1.5, Math.min(24, slot - 2)); // thin marks, ≥2px surface gap
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelStep = Math.max(1, Math.round(days / 6)); // sparse x labels

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={t('每日 Token 用量柱状图')}>
      {/* recessive hairline gridlines + clean y ticks */}
      {ticks.map((t) => {
        const y = padT + plotH - (t / max) * plotH;
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-line)" strokeWidth="1" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--color-tx3)">
              {fmtTick(t)}
            </text>
          </g>
        );
      })}
      {/* baseline */}
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke="var(--color-line)" strokeWidth="1" />
      <text x={padL - 6} y={padT + plotH + 3} textAnchor="end" fontSize="10" fill="var(--color-tx3)">0</text>

      {series.map((d, i) => {
        const h = (d.totalTokens / max) * plotH;
        const x = padL + i * slot + (slot - barW) / 2;
        const y = padT + plotH - h;
        const r = Math.min(4, barW / 2, h); // rounded data-end, square at baseline
        return (
          <g key={d.day} className="group/bar">
            <title>{t('{day} · {tokens} tokens · {requests} 次请求', { day: d.day, tokens: d.totalTokens.toLocaleString(locale), requests: d.requests })}</title>
            {/* full-slot invisible hit target */}
            <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
            {h > 0 && (
              <path
                d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`}
                fill="var(--color-acc)"
                className="opacity-85 transition-opacity group-hover/bar:opacity-100"
              />
            )}
            {i % labelStep === 0 && (
              <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--color-tx3)">
                {d.day.slice(5).replace('-', '/')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
