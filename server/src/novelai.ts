import { z } from 'zod';

export const NAI_MODELS = ['nai-diffusion-5-curated', 'nai-diffusion-5-full'] as const;
export const NAI_SIZES = ['832x1216', '1216x832', '1024x1024'] as const;
// Official V5 UC presets: https://docs.novelai.net/en/image/undesiredcontent/
const heavy = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
export const NAI_UC = {
  heavy,
  light: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
  human: `${heavy}, @_@, mismatched pupils, glowing eyes, bad anatomy`,
  furry: '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic',
};

export const novelaiSchema = z.object({
  sourceMode: z.enum(['assisted', 'raw']).default('assisted'),
  basePrompt: z.string().max(6000).default(''),
  stylePrompt: z.string().max(2000).default(''),
  artists: z.array(z.object({ tag: z.string().trim().min(1).max(160), weight: z.number().min(-3).max(3) })).max(12).default([]),
  characters: z.array(z.object({
    name: z.string().max(60).default(''),
    description: z.string().max(1500).default(''),
    prompt: z.string().max(2000),
    negativePrompt: z.string().max(1000).default(''),
    negativeDescription: z.string().max(1000).default(''),
    x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5),
  })).max(22).default([]),
  useCoords: z.boolean().default(false),
  ucEnabled: z.boolean().default(true),
  ucPreset: z.enum(['heavy', 'light', 'human', 'furry']).default('heavy'),
  negativePrompt: z.string().max(3000).default(''),
  negativeDescription: z.string().max(2000).default(''),
  quality: z.enum(['standard', 'light', 'none']).default('standard'),
  transparent: z.boolean().default(false),
  imageText: z.string().max(750).default(''),
  steps: z.number().int().min(1).max(28).default(23),
  scale: z.number().min(0).max(10).default(7),
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
}).strict();
export type NovelAIOptions = z.infer<typeof novelaiSchema>;

// Tag 模式 leaves a ", " after the last tag to keep typing; never send it on.
const tidy = (s: string) => s.replace(/^[\s,]+|[\s,]+$/g, '');

export function buildNovelAIRequest(model: string, prompt: string, size: string, options: NovelAIOptions, seed: number) {
  if (!NAI_MODELS.includes(model as typeof NAI_MODELS[number])) throw new Error('只支持 V5 Full 和 V5 Curated');
  if (!NAI_SIZES.includes(size as typeof NAI_SIZES[number])) throw new Error('订阅模式只支持 Normal 分辨率');
  const o = novelaiSchema.parse(options);
  if (model === NAI_MODELS[0] && o.imageText.length > 374) throw new Error('V5 Curated 的画面文字最多 374 个字符');
  const [width, height] = size.split('x').map(Number);
  const base = tidy(o.basePrompt) || tidy(prompt);
  if (!base) throw new Error('请填写画面描述');
  // Text: must stay last, including when the user supplied it manually.
  const textAt = base.indexOf('Text:');
  const text = o.imageText.trim() || (textAt >= 0 ? base.slice(textAt + 5).trim() : '');
  const quality = o.quality === 'none' ? '' : `very aesthetic, ${o.quality === 'light' ? 'amazing quality' : 'masterpiece'}${text ? '' : ', no text'}`;
  const actualPrompt = [
    o.artists.map(a => a.weight === 1 ? a.tag : `${a.weight}::${a.tag}::`).join(', '),
    tidy(o.stylePrompt), textAt >= 0 ? tidy(base.slice(0, textAt)) : base,
    o.transparent ? 'transparent background' : '', quality,
  ].filter(Boolean).join(', ') + (text ? ` Text: ${text}` : '');
  const negative = [o.ucEnabled ? NAI_UC[o.ucPreset] : '', tidy(o.negativePrompt)].filter(Boolean).join(', ');
  const captions = (negative: boolean) => o.characters.map(c => ({
    char_caption: tidy(negative ? c.negativePrompt : c.prompt),
    centers: [{ x: c.x, y: c.y }],
  }));
  return {
    input: actualPrompt, model, action: 'generate',
    parameters: {
      params_version: 4, width, height, steps: o.steps, scale: o.scale,
      sampler: 'k_euler_ancestral', n_samples: 1, seed,
      negative_prompt: negative,
      v4_prompt: { caption: { base_caption: actualPrompt, char_captions: captions(false) }, use_coords: o.useCoords, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negative, char_captions: captions(true) }, use_coords: o.useCoords, use_order: false, legacy_uc: false },
      // Presets are compiled once above; never ask the API to append them again.
      qualityToggle: false, ucPreset: 4, cfg_rescale: 0, legacy: false,
      sm: false, sm_dyn: false, dynamic_thresholding: false, straight_alpha: true,
    },
  };
}

/* ---------- remembered tags (Tag 模式 autocomplete and 常用) ---------- */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A prompt chunk in the form tags are compared and remembered in: emphasis
 * stripped, lowercase, Danbooru underscores as spaces (not in short emoticon
 * tags like o_o). '' when it isn't worth remembering — sentences, CJK, long
 * phrases. Mirrors tagKey()/memorable() in web/src/naiTags.ts.
 */
export function promptTagKey(raw: string) {
  let t = raw.replace(/^(?:\s|[{[]|-?(?:\d+(?:\.\d*)?|\.\d+)::)+/, '').replace(/(?:\s|[}\]]|::)+$/, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  if (t.length > 3) t = t.replace(/([\p{L}\p{N})])_+(?=[\p{L}\p{N}(])/gu, '$1 ');
  const words = t.split(' ').length;
  const ok = !!t && t.length <= 60 && words <= 6 && (/[\p{L}\p{N}]/u.test(t) || t.length <= 4)
    && !CJK.test(t) && !(words > 2 && /[.!?]$/.test(t));
  return ok ? t : '';
}

export function promptTags(prompt: string) {
  const textAt = prompt.indexOf('Text:');
  return (textAt >= 0 ? prompt.slice(0, textAt) : prompt).split(/[,\n]/).map(promptTagKey).filter(Boolean);
}

type TagStat = { tag: string; count: number; score: number; last: number };
const HALF_LIFE_DAYS = 30;

/**
 * Tags a user has generated with, from the settings saved on their NAI
 * images: how often (count) and how recently (score — each use counts 1,
 * halving every 30 days). Separate pools for prompts and exclusions.
 */
export function tagHistory(rows: { settings: string | null; createdAt: number }[], now: number) {
  const pools = { tags: new Map<string, TagStat>(), negative: new Map<string, TagStat>() };
  const add = (pool: Map<string, TagStat>, tags: string[], at: number) => {
    const weight = 0.5 ** (Math.max(0, now - at) / 86_400_000 / HALF_LIFE_DAYS);
    for (const tag of new Set(tags)) {
      const s = pool.get(tag) ?? { tag, count: 0, score: 0, last: 0 };
      s.count++; s.score += weight; s.last = Math.max(s.last, at);
      pool.set(tag, s);
    }
  };
  const str = (v: unknown) => typeof v === 'string' ? v : '';
  for (const row of rows) {
    let o: any;
    try {
      const v = JSON.parse(row.settings || 'null');
      if (v?.provider !== 'novelai') continue;
      o = v.options;
    } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const chars: any[] = Array.isArray(o.characters) ? o.characters : [];
    const artists: any[] = Array.isArray(o.artists) ? o.artists : [];
    add(pools.tags, [str(o.basePrompt), ...chars.map(c => str(c?.prompt))].flatMap(promptTags)
      .concat(artists.map(a => promptTagKey(str(a?.tag))).filter(Boolean)), row.createdAt);
    add(pools.negative, [str(o.negativePrompt), ...chars.map(c => str(c?.negativePrompt))].flatMap(promptTags), row.createdAt);
  }
  const top = (pool: Map<string, TagStat>, n: number) => [...pool.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count).slice(0, n)
    .map(s => ({ ...s, score: Math.round(s.score * 1000) / 1000 }));
  return { tags: top(pools.tags, 300), negative: top(pools.negative, 150) };
}
