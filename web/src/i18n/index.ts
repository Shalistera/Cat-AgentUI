// ---- i18n ----
// Chinese is the source language: UI strings are written in Chinese and
// wrapped in t(), which looks the exact source string up in the English
// dictionaries (i18n/en/*.ts) when the UI runs in English. A missing entry
// falls back to the Chinese text, so nothing ever renders blank.
//
// The language is resolved once at startup and switching reloads the page.
// That keeps t() a plain function — usable in module-level constants, the
// store and api.ts — instead of threading a reactive hook everywhere.
//
// `npm run check:i18n -w web` lists t() strings without an English entry.

import serverPatterns from './server-patterns';

export type Lang = 'zh' | 'en';
/** What the user picked; 'auto' follows the browser (zh-* → 中文, else English). */
export type LangPref = Lang | 'auto';

const LANG_KEY = 'cat-lang';

// Guarded so Node regression scripts that import api.ts (no Vite, no DOM)
// still load this module; they run in Chinese with no dictionaries.
const dictModules = typeof import.meta.glob === 'function'
  ? import.meta.glob<{ default: Record<string, string> }>('./en/*.ts', { eager: true })
  : {};
const en: Record<string, string> = Object.assign({}, ...Object.values(dictModules).map((m) => m.default));

function browserLang(): Lang {
  if (typeof navigator === 'undefined') return 'zh';
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  return (list[0] || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function readPref(): LangPref {
  try {
    const saved = globalThis.localStorage?.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* private mode */ }
  return 'auto';
}

export function resolveLang(pref: LangPref): Lang {
  return pref === 'auto' ? browserLang() : pref;
}

export const langPref: LangPref = readPref();
export const lang: Lang = resolveLang(langPref);
export const isEn = lang === 'en';
/** BCP 47 tag for Intl / toLocale*String. */
export const locale = isEn ? 'en-US' : 'zh-CN';

if (typeof document !== 'undefined') document.documentElement.lang = locale;

type Vars = Record<string, string | number>;

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translate a Chinese source string. `{name}` placeholders are filled from vars.
    A `@@context` suffix separates identical Chinese words that need different
    English (t('关闭') "Close" vs t('关闭@@off') "Off"); it never renders. */
export function t(zh: string, vars?: Vars): string {
  const at = zh.indexOf('@@');
  const source = at < 0 ? zh : zh.slice(0, at);
  return fill(isEn ? (en[zh] ?? source) : source, vars);
}

/** Best-effort translation of text that came from the server (error messages
    etc.): an exact dictionary hit wins; otherwise the first matching pattern
    from server-patterns.ts handles messages the server built from a template.
    Anything else passes through unchanged. */
export function tServer(text: string): string {
  if (!isEn) return text;
  const exact = en[text];
  if (exact !== undefined) return exact;
  for (const [re, replacement] of serverPatterns) {
    if (re.test(text)) return text.replace(re, replacement);
  }
  return text;
}

/** Persist the choice locally; returns true when the page must reload to apply it. */
export function storeLangPref(pref: LangPref): boolean {
  try {
    if (pref === 'auto') localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, pref);
  } catch { /* private mode */ }
  return resolveLang(pref) !== lang;
}

/** Adopt the language saved on the account (set from another device). Reloads
    when it differs from what is on screen; a no-op otherwise. */
export function adoptAccountLang(saved: unknown): void {
  if (saved !== 'zh' && saved !== 'en') return;
  if (saved === langPref) return;
  if (storeLangPref(saved)) location.reload();
}
