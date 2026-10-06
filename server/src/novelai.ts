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

export function buildNovelAIRequest(model: string, prompt: string, size: string, options: NovelAIOptions, seed: number) {
  if (!NAI_MODELS.includes(model as typeof NAI_MODELS[number])) throw new Error('只支持 V5 Full 和 V5 Curated');
  if (!NAI_SIZES.includes(size as typeof NAI_SIZES[number])) throw new Error('订阅模式只支持 Normal 分辨率');
  const o = novelaiSchema.parse(options);
  if (model === NAI_MODELS[0] && o.imageText.length > 374) throw new Error('V5 Curated 的画面文字最多 374 个字符');
  const [width, height] = size.split('x').map(Number);
  const base = o.basePrompt.trim() || prompt.trim();
  if (!base) throw new Error('请填写画面描述');
  // Text: must stay last, including when the user supplied it manually.
  const textAt = base.indexOf('Text:');
  const text = o.imageText.trim() || (textAt >= 0 ? base.slice(textAt + 5).trim() : '');
  const quality = o.quality === 'none' ? '' : `very aesthetic, ${o.quality === 'light' ? 'amazing quality' : 'masterpiece'}${text ? '' : ', no text'}`;
  const actualPrompt = [
    o.artists.map(a => a.weight === 1 ? a.tag : `${a.weight}::${a.tag}::`).join(', '),
    o.stylePrompt.trim(), textAt >= 0 ? base.slice(0, textAt).trim() : base,
    o.transparent ? 'transparent background' : '', quality,
  ].filter(Boolean).join(', ') + (text ? ` Text: ${text}` : '');
  const negative = [o.ucEnabled ? NAI_UC[o.ucPreset] : '', o.negativePrompt.trim()].filter(Boolean).join(', ');
  const captions = (negative: boolean) => o.characters.map(c => ({
    char_caption: negative ? c.negativePrompt : c.prompt,
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
