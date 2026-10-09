// Browser-native voice, both directions. Everything runs on the user's device
// (Web Speech API) — no server round-trips, no provider tokens, which is why
// this exists at all. Feature-detected: unsupported browsers (e.g. Firefox for
// recognition) simply never see the buttons.

import { locale, t } from './i18n';

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null;
}

export function sttSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * One continuous dictation session. `onText` receives the FULL transcript so
 * far (finalized + interim) on every update; append it to whatever the input
 * held when the session started.
 */
export function startDictation(onText: (text: string) => void, onEnd: () => void): SpeechRecognitionLike | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = navigator.language || locale;
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    onText(text);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd; // mic denied / no speech — either way the session is over
  try { rec.start(); } catch { return null; }
  return rec;
}

// ---- text-to-speech ----

export function ttsSupported(): boolean {
  return 'speechSynthesis' in window;
}

/** Markdown reads terribly aloud; keep the words, drop the syntax. */
function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, t('(代码块)'))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, t('(图片)'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function speak(markdown: string, onDone: () => void): void {
  stopSpeaking();
  const text = speakableText(markdown);
  if (!text) { onDone(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = /[一-鿿]/.test(text) ? 'zh-CN' : 'en-US';
  let done = false;
  const finish = () => { if (!done) { done = true; onDone(); } };
  u.onend = finish;
  u.onerror = finish;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (ttsSupported()) speechSynthesis.cancel(); // cancel fires each utterance's onend/onerror
}
