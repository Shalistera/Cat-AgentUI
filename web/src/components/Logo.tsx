/* The black cat. 🐈‍⬛ Grumpy, half-lidded, on-model with the character sheet.
   Every fill is a token so the mark holds up on white and on ink — the old
   hard-coded #161619 body vanished against dark surfaces. */

export function CatLogo({ size = 28, eye }: { size?: number; eye?: string }) {
  const iris = eye ?? 'var(--logo-eye)';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Cat-AgentUI" role="img">
      <path
        d="M8.5 39 C8.6 32.5 10.2 27.2 13.6 23.6 C12.5 19.9 12 13 13.1 9 Q13.7 5.9 16.9 7.7 C20.2 9.5 23.3 13.5 25.4 17.4 C27.5 16.7 29.7 16.3 32 16.3 C34.3 16.3 36.5 16.7 38.6 17.4 C40.7 13.5 43.8 9.5 47.1 7.7 Q50.3 5.9 50.9 9 C52 13 51.5 19.9 50.4 23.6 C53.8 27.2 55.4 32.5 55.5 39 C55.5 46 52.5 51.5 46.5 54.3 C42 56.3 36.8 56.8 32 56.8 C27.2 56.8 22 56.3 17.5 54.3 C11.5 51.5 8.5 46 8.5 39 Z"
        fill="var(--logo-body)"
        stroke="var(--logo-edge)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M22.6 18.7 L25.4 17.7 M41.4 18.7 L38.6 17.7" stroke="var(--logo-edge)" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M15.6 33.8 L25.8 34.5 L29.7 35.3 C29.9 39.6 27.9 43.4 23.3 43.4 C18.4 43.4 15.4 39.9 15.6 33.8 Z" fill={iris} />
      <path d="M48.4 33.8 L38.2 34.5 L34.3 35.3 C34.1 39.6 36.1 43.4 40.7 43.4 C45.6 43.4 48.6 39.9 48.4 33.8 Z" fill={iris} />
      <ellipse cx="24.3" cy="37.7" rx="2.3" ry="4.8" fill="var(--logo-body)" />
      <ellipse cx="39.7" cy="37.7" rx="2.3" ry="4.8" fill="var(--logo-body)" />
      <path d="M29.8 42.4 L34.2 42.4 L32 44.9 Z" fill="var(--logo-detail)" stroke="var(--logo-detail)" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M32 45 L32 46.8 M29.4 49.2 L32 46.8 L34.6 49.2" fill="none" stroke="var(--logo-detail)" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 43.8 L2.6 41.6 M11.8 46.8 L1.8 46.4 M12.6 49.6 L3.4 51.8" stroke="var(--logo-detail)" strokeWidth="1.2" strokeLinecap="round" opacity=".85" />
      <path d="M51.5 43.8 L61.4 41.6 M52.2 46.8 L62.2 46.4 M51.4 49.6 L60.6 51.8" stroke="var(--logo-detail)" strokeWidth="1.2" strokeLinecap="round" opacity=".85" />
    </svg>
  );
}

/** The mark set in an ink tile — the app icon as it appears in-product. */
export function CatMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg border border-line2 bg-bg2 shadow-xs"
      style={{ width: size, height: size }}
    >
      <CatLogo size={Math.round(size * 0.74)} />
    </span>
  );
}

/** Lockup: mark + wordmark. `label` lets an operator's own brand name ride the
    same lockup without the component guessing at typography. */
export function CatWordmark({ size = 32, label = 'Cat AgentUI', tagline }: {
  size?: number; label?: string; tagline?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <CatMark size={size} />
      <div className="min-w-0 leading-tight">
        <div className="truncate font-semibold tracking-tight text-tx" style={{ fontSize: Math.max(13, size * 0.44) }}>
          {label}
        </div>
        {tagline && <div className="truncate text-[11px] text-tx3">{tagline}</div>}
      </div>
    </div>
  );
}
