import { useModels } from '../store';
import type { ModelInfo } from '../types';

/* ---------------------------------------------------------------------------
   Model avatars.

   The built-in marks are simplified, brand-evocative glyphs — deliberately not
   pixel-exact reproductions of anyone's trademark. They exist so a reader can
   tell at a glance which family answered; an operator who wants the official
   asset uploads it per provider in the admin console, which takes precedence
   over everything here.
   ------------------------------------------------------------------------ */

export type Brand = 'openai' | 'anthropic' | 'gemini';

/** The model name is more trustworthy than the provider type: an OpenAI-
    compatible gateway is typed `openai` while serving Claude or Gemini. */
export function brandOf(modelName: string | null | undefined, providerType?: string | null): Brand | null {
  const s = (modelName ?? '').toLowerCase().trim();
  if (s) {
    if (s.includes('claude')) return 'anthropic';
    if (s.includes('gemini') || s.includes('gemma') || s.includes('imagen')) return 'gemini';
    if (s.includes('gpt') || s.includes('dall-e') || /^o[1-9](\b|[-.])/.test(s)) return 'openai';
  }
  // `openai` is a PROTOCOL here, not a vendor — the admin console calls it
  // "OpenAI 兼容", and DeepSeek / Qwen / Moonshot all sit behind it. Stamping
  // the OpenAI mark on those would misattribute them, so an unrecognised model
  // name falls through to the provider's own initial instead.
  if (providerType === 'anthropic' || providerType === 'gemini') return providerType;
  return null;
}

/** OpenAI — a six-lobed rosette standing in for the knot. */
function OpenAIMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {[0, 60, 120].map((a) => (
        <ellipse key={a} cx="12" cy="12" rx="4.1" ry="9.1" transform={`rotate(${a} 12 12)`}
          stroke="currentColor" strokeWidth="1.6" />
      ))}
    </svg>
  );
}

/** Claude — the radial burst, in Anthropic's clay. */
function ClaudeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={i} x="10.95" y="1.9" width="2.1" height="8.4" rx="1.05"
          fill="#d97757" transform={`rotate(${i * 30} 12 12)`} />
      ))}
    </svg>
  );
}

/** Gemini — the four-point spark, on the brand gradient. */
function GeminiMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="cat-gemini-grad" x1="2" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285f4" />
          <stop offset="0.55" stopColor="#9b72f9" />
          <stop offset="1" stopColor="#d96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.8c0 5.6 4.6 10.2 10.2 10.2C16.6 12 12 16.6 12 22.2 12 16.6 7.4 12 1.8 12 7.4 12 12 7.4 12 1.8Z"
        fill="url(#cat-gemini-grad)"
      />
    </svg>
  );
}

function BrandMark({ brand, size }: { brand: Brand; size: number }) {
  if (brand === 'anthropic') return <ClaudeMark size={size} />;
  if (brand === 'gemini') return <GeminiMark size={size} />;
  return <OpenAIMark size={size} />;
}

interface AvatarProps {
  size: number;
  /** Draw the bordered tile. Off for inline use inside menus and pills. */
  tile: boolean;
  title: string;
  brand: Brand | null;
  /** Custom avatar URL; wins over the built-in mark when present. */
  custom: string | null;
  /** Shown when nothing else resolves — first letter of the provider name. */
  fallback: string;
}

function Avatar({ size, tile, title, brand, custom, fallback }: AvatarProps) {
  const inner = Math.round(size * (tile ? 0.62 : 1));
  // Rendered as <img>, never inlined: an uploaded SVG must not get a script
  // context, and an <img> never gives it one.
  const content = custom
    ? <img src={custom} alt="" className="object-contain" style={{ width: inner, height: inner }} />
    : brand
      ? <BrandMark brand={brand} size={inner} />
      : (
        <span className="font-semibold text-tx2" style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}>
          {fallback}
        </span>
      );

  if (!tile) {
    return <span className="inline-flex shrink-0 items-center justify-center text-tx" title={title}>{content}</span>;
  }
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line2 bg-bg2 text-tx shadow-xs"
      style={{ width: size, height: size }}
    >
      {content}
    </span>
  );
}

const initialOf = (s: string | null | undefined) => (s ?? '?').trim().charAt(0).toUpperCase() || '?';

export function ModelAvatar({ model, info, size = 30, tile = true }: {
  /** API model name, e.g. `gpt-5.2` — used when `info` is not available. */
  model?: string | null;
  /** Preferred source: carries the provider's type and custom avatar. */
  info?: ModelInfo | null;
  size?: number;
  tile?: boolean;
}) {
  const models = useModels((s) => s.models);
  // A message only stores the API model name, so recover the provider from the
  // model catalogue; if the model was since deleted the name heuristic still
  // resolves the right family.
  const resolved = info ?? (model ? models.find((m) => m.modelId === model) : undefined) ?? null;
  const name = info?.modelId ?? model ?? null;
  return (
    <Avatar
      size={size}
      tile={tile}
      title={resolved?.displayName ?? name ?? '模型'}
      brand={brandOf(name, resolved?.providerType)}
      custom={resolved?.avatarUrl ?? resolved?.providerAvatarUrl ?? null}
      fallback={initialOf(resolved?.providerName ?? name)}
    />
  );
}

/** Provider-level avatar for the admin console, where no model is in play.
    Here the endpoint disambiguates what the type cannot: an `openai`-typed
    provider pointed at api.openai.com really is OpenAI, while one pointed
    somewhere else is a compatible gateway and gets its own initial. */
export function ProviderAvatar({ name, type, baseUrl, avatarUrl, size = 32, tile = true }: {
  name: string; type?: string | null; baseUrl?: string | null;
  avatarUrl?: string | null; size?: number; tile?: boolean;
}) {
  const brand = type === 'openai' && (!baseUrl || /(^|\/\/|\.)openai\.com(\/|$|:)/i.test(baseUrl))
    ? 'openai' as const
    : brandOf(null, type);
  return (
    <Avatar
      size={size}
      tile={tile}
      title={name}
      brand={brand}
      custom={avatarUrl ?? null}
      fallback={initialOf(name)}
    />
  );
}
