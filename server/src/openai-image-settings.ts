import { z } from 'zod';

export const openaiImageOutputSchema = z.object({
  outputFormat: z.enum(['png', 'jpeg', 'webp', 'gif']).optional(),
  frameCount: z.number().int().min(2).max(64).optional(),
  frameDurationMs: z.number().int().min(20).max(2000)
    .transform((ms) => Math.round(ms / 10) * 10).optional(),
});

export type ImageOutputFormat = NonNullable<z.infer<typeof openaiImageOutputSchema>['outputFormat']>;

// Keep capabilities on the server so the form and request validation agree.
// Compatible aliases can opt into raster formats via the existing model setting.
export function openaiImageOutputFormats(model: string, customSettings = false): ImageOutputFormat[] {
  if (/^dall-e/i.test(model) || (!/^gpt-image-/i.test(model) && model !== 'chatgpt-image-latest' && !customSettings)) return [];
  const formats: ImageOutputFormat[] = ['png', 'jpeg', 'webp'];
  if (/^gpt-image-2\.6(?:-(?:sunburst|flare))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(model)) formats.push('gif');
  return formats;
}

// GIF size describes each frame. It does not use the still-image minimum
// pixel count; the provider enforces its frame-count/request pixel budget.
// https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output
export const openaiGifSizeSchema = z.string().refine((size) => {
  if (size === 'auto') return true;
  if (!/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size)) return false;
  return size.split('x').map(Number).every((edge) => edge % 16 === 0);
}).default('auto');

// GPT Image 2.5 Flare / Sunburst limits:
// https://developers.openai.com/api/docs/guides/image-prompting#model-parameters
export const openaiImageSettingsSchema = z.object({
  // Explicit quality keeps the workshop's ceiling at high, including when
  // clients omit the field. Upstream auto may choose a higher tier.
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  size: z.string().refine((size) => {
    if (size === 'auto') return true;
    if (!/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size)) return false;
    const [width, height] = size.split('x').map(Number);
    const pixels = width * height;
    return width <= 3840 && height <= 3840
      && width % 16 === 0 && height % 16 === 0
      && Math.max(width, height) <= Math.min(width, height) * 3
      && pixels >= 655360 && pixels <= 8294400;
  }).default('auto'),
});
