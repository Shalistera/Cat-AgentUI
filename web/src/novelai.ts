import type { ImageRecord } from './types';

export const NAI_SIZES = ['832x1216', '1216x832', '1024x1024'] as const;
/** Subscription mode only covers the three Normal sizes; each gets a plain-language use case. */
export const NAI_SIZE_OPTIONS: { size: typeof NAI_SIZES[number]; label: string; hint: string }[] = [
  { size: '832x1216', label: '竖图', hint: '人物、立绘' },
  { size: '1216x832', label: '横图', hint: '风景、场景' },
  { size: '1024x1024', label: '方图', hint: '头像、图标' },
];
// The first three tag strings are what older drafts and saved images carry;
// keep them byte-identical so those still highlight the right card. `swatch`
// is a CSS background that hints at the look without needing sample images.
export const NAI_STYLES = [
  { name: '自动', tags: '', hint: '不加画风词，交给模型发挥', swatch: 'conic-gradient(from 210deg at 50% 50%, #f9d5e5, #c9d8ff, #c6f0dc, #fde7b0, #f9d5e5)' },
  { name: '清透动画', tags: 'anime coloring, soft lighting, delicate lines', hint: '干净明亮的日系动画上色', swatch: 'linear-gradient(135deg, #b8cee5, #e3ccbf 55%, #f7ead9)' },
  { name: '赛璐璐', tags: 'anime screenshot, cel shading, flat color', hint: '动画截图般的硬边阴影', swatch: 'linear-gradient(135deg, #f6c7b6 0 42%, #e58f7c 42% 58%, #7fb3d5 58%)' },
  { name: '柔和水彩', tags: 'watercolor, soft colors, traditional media', hint: '晕染、通透的手绘水彩', swatch: 'radial-gradient(circle at 30% 35%, #c1d2bfdd 0 22%, transparent 46%), radial-gradient(circle at 72% 62%, #e7cbd0dd 0 24%, transparent 50%), #f3eee4' },
  { name: '厚涂', tags: 'painterly, oil painting (medium), dramatic lighting', hint: '笔触厚重、光影强烈', swatch: 'radial-gradient(circle at 70% 28%, #f3d29b, #b9734a 46%, #3b2a3a)' },
  { name: '复古手绘', tags: 'pencil drawing, traditional media, muted colors', hint: '铅笔线条、低饱和', swatch: 'repeating-linear-gradient(-45deg, transparent 0 5px, #8a7f7238 5px 6px), #efe8db' },
  { name: '90 年代', tags: 'retro artstyle, 1990s (style)', hint: '老动画的怀旧质感', swatch: 'linear-gradient(160deg, #e9b7a3, #a78bb5 52%, #4f6d8f)' },
  { name: '梦幻光影', tags: 'light particles, bloom, pastel colors, soft focus', hint: '柔光、光斑、粉彩', swatch: 'radial-gradient(circle at 26% 30%, #fff 0 5%, transparent 6%), radial-gradient(circle at 70% 64%, #ffffffaa 0 8%, transparent 9%), linear-gradient(135deg, #f9d5e5, #c9d8ff)' },
  { name: '黑白漫画', tags: 'monochrome, greyscale, comic', hint: '漫画分镜般的黑白', swatch: 'radial-gradient(#3a3a3a 1.2px, transparent 1.6px) 0 0 / 6px 6px, linear-gradient(135deg, #f4f4f4, #cfcfcf)' },
  { name: 'Q 版', tags: 'chibi', hint: '大头小身、可爱', swatch: 'radial-gradient(circle at 50% 44%, #ffd9c2 0 26%, transparent 27%), radial-gradient(ellipse at 50% 92%, #ff9eb5 0 30%, transparent 31%), #ffe9a8' },
  { name: '像素', tags: 'pixel art', hint: '复古游戏像素风', swatch: 'conic-gradient(#7ec4cf 25%, #ffd166 0 50%, #7ec4cf 0 75%, #ffd166 0) 0 0 / 12px 12px' },
] as const;
/** One click fills the description — a starting point, not a template. */
export const NAI_EXAMPLES = [
  { title: '雨夜街头', text: '雨夜的霓虹街头，撑着透明雨伞的白发少女回头看向镜头，地面倒映着彩色灯光' },
  { title: '樱花教室', text: '春天午后的教室，窗外樱花飘落，黑长发女生托着下巴望向窗外，阳光洒在课桌上' },
  { title: '雨天咖啡馆', text: '两位女孩坐在雨天的咖啡馆，白发女孩靠窗，黑发女孩坐在对面，一边喝热可可一边聊天，暖黄的灯光' },
  { title: '魔女森林', text: '发光蘑菇点缀的奇幻森林，戴尖帽子的小魔女骑着扫帚飞过，萤火虫环绕在她身边' },
  { title: '天台机甲', text: '未来都市的天台上，穿白色机甲的少女握着长枪，身后是巨大的满月和城市灯火' },
  { title: '午睡橘猫', text: '洒满阳光的木地板上，一只橘猫蜷成一团午睡，旁边滚着一个毛线球' },
];
export const NAI_UC_OPTIONS = [
  { value: 'heavy', label: '标准（推荐）' },
  { value: 'light', label: '轻度' },
  { value: 'human', label: '人物优化' },
  { value: 'furry', label: '兽人优化' },
  { value: 'off', label: '不使用' },
] as const;
/** Each character keeps the same colour on its card and its position dot. */
export const NAI_CHAR_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ad7f58'];

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
/**
 * `manual` is Tag 模式: the user edits the raw prompt fields (basePrompt,
 * character prompt, negativePrompt) directly. Otherwise they write natural
 * language into the description fields and the helper translates them before
 * each generation; `preparedFor` is the source signature of the translation
 * currently held in the raw fields, so an unchanged description is reused.
 */
export interface NaiDraft {
  scene: string; size: string; options: NaiOptions; helperModelId: string;
  helperEnabled: boolean; manual: boolean; preparedFor: string;
}
export type NaiImageRequest = { modelId: string; prompt: string; size: string; n: 1; novelai: NaiOptions };
export type NaiStyle = { name: string; tags: string; artists: NaiOptions['artists'] };
export const NAI_DEFAULTS = { steps: 23, scale: 7 };
export const newNaiDraft = (): NaiDraft => ({
  scene: '', size: '832x1216', helperModelId: '', helperEnabled: true, manual: false, preparedFor: '',
  options: { sourceMode: 'assisted', basePrompt: '', stylePrompt: NAI_STYLES[1].tags, artists: [], characters: [], useCoords: false,
    ucEnabled: true, ucPreset: 'heavy', negativePrompt: '', negativeDescription: '', quality: 'standard',
    transparent: false, imageText: '', steps: NAI_DEFAULTS.steps, scale: NAI_DEFAULTS.scale, seed: null },
});
export const newNaiCharacter = (index: number): NaiCharacter => ({
  name: '', description: '', prompt: '', negativePrompt: '', negativeDescription: '',
  // Spread new characters left to right so they don't stack on one spot.
  x: [0.3, 0.7, 0.5, 0.15, 0.85][index % 5], y: 0.5,
});
const descriptionParts = (d: NaiDraft) =>
  [d.scene, d.options.negativeDescription, d.options.characters.map(c => [c.name, c.description, c.negativeDescription])];
/** What the helper translates; any change here invalidates the cached translation. */
export function sourceSignature(draft: NaiDraft) {
  return JSON.stringify([...descriptionParts(draft), draft.helperEnabled && draft.helperModelId]);
}
/**
 * `preparedFor` value left behind when leaving Tag 模式: the raw fields then
 * hold the user's own tags, not a translation. Coming back while the
 * descriptions are unchanged must give those tags back.
 */
export const tagsMark = (draft: NaiDraft) => `tags:${JSON.stringify(descriptionParts(draft))}`;
/** Settings tucked behind 高级设置 that differ from the defaults — surfaced as a dot. */
export function advancedChanged(o: NaiOptions) {
  return o.steps !== NAI_DEFAULTS.steps || o.scale !== NAI_DEFAULTS.scale || o.quality !== 'standard'
    || o.seed !== null || o.transparent || !!o.imageText.trim();
}
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
    steps: Math.round(num(o.steps, NAI_DEFAULTS.steps, 1, 28)), scale: num(o.scale, NAI_DEFAULTS.scale, 0, 10),
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
export interface NaiImageInfo {
  draft: NaiDraft; seed: number | null; size: string; actualPrompt: string; actualNegativePrompt: string;
}
/** Parses the settings an NAI image was made with; null for any other image. */
export function naiImageInfo(image: ImageRecord): NaiImageInfo | null {
  try {
    const value = JSON.parse(image.generationSettings || 'null');
    if (value?.provider !== 'novelai' || value.version !== 1) return null;
    const draft = normalizeNaiDraft({ scene: value.prompt, size: value.size, options: value.options, manual: value.options?.sourceMode === 'raw', preparedFor: 'restored' });
    return {
      draft, seed: draft.options.seed, size: draft.size,
      actualPrompt: str(value.actualPrompt, 20000), actualNegativePrompt: str(value.actualNegativePrompt, 20000),
    };
  } catch { return null; }
}
export function naiImageDraft(image: ImageRecord): NaiDraft | null {
  return naiImageInfo(image)?.draft ?? null;
}
