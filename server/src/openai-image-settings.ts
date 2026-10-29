import { z } from 'zod';

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
