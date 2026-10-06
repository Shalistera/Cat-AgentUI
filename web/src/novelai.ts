import type { ImageRecord } from './types';

export const NAI_SIZES = ['832x1216', '1216x832', '1024x1024'] as const;
export const NAI_STYLES = [
  { name: '清透动画', tags: 'anime coloring, soft lighting, delicate lines', colors: ['#b8cee5', '#e3ccbf', '#f7ead9'] },
  { name: '柔和水彩', tags: 'watercolor, soft colors, traditional media', colors: ['#c1d2bf', '#e7cbd0', '#e9dfcd'] },
  { name: '复古手绘', tags: 'pencil drawing, traditional media, muted colors', colors: ['#bbb5ad', '#d4c7b3', '#efe8db'] },
];
export interface NaiCharacter {
  name: string; description: string; prompt: string; negativePrompt: string; negativeDescription: string; x: number; y: number;
}
export interface NaiOptions {
  sourceMode: 'assisted' | 'raw';
  basePrompt: string; stylePrompt: string; artists: { tag: string; weight: number }[];
  characters: NaiCharacter[]; useCoords: boolean; ucEnabled: boolean;
  ucPreset: 'heavy' | 'light' | 'human' | 'furry'; negativePrompt: string; negativeDescription: string;
  quality: 'standard' | 'light' | 'none'; transparent: boolean; imageText: string; steps: number; scale: number; seed: number | null;
}
export interface NaiDraft {
  scene: string; size: string; options: NaiOptions; helperModelId: string;
  helperEnabled: boolean; manual: boolean; preparedFor: string;
}
export type NaiImageRequest = { modelId: string; prompt: string; size: string; n: 1; novelai: NaiOptions };
export type NaiStyle = { name: string; tags: string; artists: NaiOptions['artists'] };
export const newNaiDraft = (): NaiDraft => ({
  scene: '', size: '832x1216', helperModelId: '', helperEnabled: true, manual: false, preparedFor: '',
  options: { sourceMode: 'assisted', basePrompt: '', stylePrompt: NAI_STYLES[0].tags, artists: [], characters: [], useCoords: false,
    ucEnabled: true, ucPreset: 'heavy', negativePrompt: '', negativeDescription: '', quality: 'standard',
    transparent: false, imageText: '', steps: 23, scale: 7, seed: null },
});
const str = (v: unknown, max = 6000) => typeof v === 'string' ? v.slice(0, max) : '';
const num = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
/** Storage and imported metadata are untrusted; recover useful fields only. */
export function normalizeNaiDraft(value: unknown): NaiDraft {
  const d = newNaiDraft();
  if (!value || typeof value !== 'object') return d;
  const v = value as Partial<NaiDraft>; const o = v.options;
  d.scene = str(v.scene, 4000); d.size = NAI_SIZES.includes(v.size as typeof NAI_SIZES[number]) ? v.size! : d.size;
  d.helperModelId = str(v.helperModelId, 100); d.helperEnabled = v.helperEnabled !== false;
  d.manual = v.manual === true; d.preparedFor = str(v.preparedFor, 20000);
  if (!o || typeof o !== 'object') return d;
  d.options = { ...d.options,
    sourceMode: o.sourceMode === 'raw' ? 'raw' : 'assisted',
    basePrompt: str(o.basePrompt), stylePrompt: str(o.stylePrompt, 2000),
    negativePrompt: str(o.negativePrompt, 3000), negativeDescription: str(o.negativeDescription, 2000),
    imageText: str(o.imageText, 750), quality: ['standard', 'light', 'none'].includes(o.quality) ? o.quality : 'standard',
    ucPreset: ['heavy', 'light', 'human', 'furry'].includes(o.ucPreset) ? o.ucPreset : 'heavy',
    useCoords: o.useCoords === true, ucEnabled: o.ucEnabled !== false, transparent: o.transparent === true,
    steps: Math.round(num(o.steps, 23, 1, 28)), scale: num(o.scale, 7, 0, 10),
    seed: o.seed === null || o.seed === undefined ? null : Math.round(num(o.seed, 0, 0, 4294967295)),
    artists: Array.isArray(o.artists) ? o.artists.filter(a => a && typeof a === 'object').slice(0, 12).map(a => ({ tag: str(a.tag, 160), weight: num(a.weight, 1, -3, 3) })) : [],
    characters: Array.isArray(o.characters) ? o.characters.filter(c => c && typeof c === 'object').slice(0, 22).map(c => ({
      name: str(c.name, 60), description: str(c.description, 1500), prompt: str(c.prompt, 2000),
      negativePrompt: str(c.negativePrompt, 1000), negativeDescription: str(c.negativeDescription, 1000),
      x: num(c.x, .5, 0, 1), y: num(c.y, .5, 0, 1),
    })) : [],
  };
  return d;
}
export function naiImageDraft(image: ImageRecord): NaiDraft | null {
  try {
    const value = JSON.parse(image.generationSettings || 'null');
    if (value?.provider !== 'novelai' || value.version !== 1) return null;
    return normalizeNaiDraft({ scene: value.prompt, size: value.size, options: value.options, manual: value.options?.sourceMode === 'raw', preparedFor: 'restored' });
  } catch { return null; }
}
