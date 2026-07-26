// The black cat. 🐈‍⬛
export function CatLogo({ size = 28, eye = 'var(--color-acc)' }: { size?: number; eye?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Cat-AgentUI">
      <path
        d="M12 10 L24 20 L40 20 L52 10 L52 30 C52 44 44 54 32 54 C20 54 12 44 12 30 Z"
        fill="#161619"
        stroke="var(--color-line2)"
        strokeWidth="1"
      />
      <ellipse cx="24" cy="34" rx="4.5" ry="5.5" fill={eye} />
      <ellipse cx="40" cy="34" rx="4.5" ry="5.5" fill={eye} />
      <ellipse cx="24" cy="35" rx="1.8" ry="4" fill="#161619" />
      <ellipse cx="40" cy="35" rx="1.8" ry="4" fill="#161619" />
    </svg>
  );
}

export function CatWordmark({ size = 24 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <CatLogo size={size} />
      <span className="font-semibold tracking-tight" style={{ fontSize: size * 0.62 }}>
        Cat<span className="text-acc">·</span>AgentUI
      </span>
    </div>
  );
}
