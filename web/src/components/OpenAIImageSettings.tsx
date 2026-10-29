import { Field, Input, Select } from './ui';
import { t } from '../i18n';

export type OpenAIImageOptions = {
  quality: 'low' | 'medium' | 'high';
  size: string;
  width: string;
  height: string;
};

export const DEFAULT_OPENAI_IMAGE_OPTIONS: OpenAIImageOptions = {
  quality: 'medium', size: 'auto', width: '1024', height: '1024',
};

const SIZES = [
  '1024x1024', '1536x1024', '1024x1536',
  '2048x2048', '2048x1152', '1152x2048',
  '2560x1440', '1440x2560', '3840x2160', '2160x3840',
];

export function openaiImageSize(options: OpenAIImageOptions): string {
  return options.size === 'custom' ? `${options.width}x${options.height}` : options.size;
}

export function openaiImageSizeError(options: OpenAIImageOptions): string | null {
  const size = openaiImageSize(options);
  if (size === 'auto') return null;
  if (!/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size)) return t('宽高须为正整数');
  const [width, height] = size.split('x').map(Number);
  if (width > 3840 || height > 3840 || width % 16 || height % 16) return t('宽高须为 16 的倍数,每边最多 3840 像素');
  if (Math.max(width, height) > Math.min(width, height) * 3) return t('长边与短边之比最多为 3:1');
  if (width * height < 655360 || width * height > 8294400) return t('总像素须在 655,360 至 8,294,400 之间');
  return null;
}

export function OpenAIImageSettings({ value, onChange }: {
  value: OpenAIImageOptions; onChange(value: OpenAIImageOptions): void;
}) {
  const error = openaiImageSizeError(value);
  const [width, height] = openaiImageSize(value).split('x').map(Number);
  const experimental = !error && width * height > 3686400;
  return <div className="space-y-3 rounded-lg border border-line bg-bg0 p-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('图像质量')}>
        <Select aria-label={t('图像质量')} value={value.quality}
          onChange={(e) => onChange({ ...value, quality: e.target.value as OpenAIImageOptions['quality'] })}>
          <option value="low">{t('低')} · low</option>
          <option value="medium">{t('中')} · medium</option>
          <option value="high">{t('高')} · high</option>
        </Select>
      </Field>
      <Field label={t('分辨率')}>
        <Select aria-label={t('分辨率')} value={value.size} onChange={(e) => onChange({ ...value, size: e.target.value })}>
          <option value="auto">{t('自动')}</option>
          {SIZES.map((size) => <option key={size} value={size}>{size.replace('x', ' × ')}</option>)}
          <option value="custom">{t('自定义')}</option>
        </Select>
      </Field>
    </div>
    {value.size === 'custom' && <div className="grid grid-cols-2 gap-3">
      <Field label={t('宽度(px)')}>
        <Input aria-label={t('宽度(px)')} type="number" min={16} max={3840} step={16} value={value.width}
          onChange={(e) => onChange({ ...value, width: e.target.value })} />
      </Field>
      <Field label={t('高度(px)')}>
        <Input aria-label={t('高度(px)')} type="number" min={16} max={3840} step={16} value={value.height}
          onChange={(e) => onChange({ ...value, height: e.target.value })} />
      </Field>
    </div>}
    {value.size === 'custom' && <p className="text-xs leading-relaxed text-tx3">
      {t('宽高为 16 的倍数,每边最多 3840 像素,长宽比不超过 3:1,总像素为 655,360–8,294,400。')}
    </p>}
    {error && <p role="alert" className="text-xs text-err">{error}</p>}
    {experimental && <p className="text-xs text-tx3">{t('超过 3,686,400 像素的分辨率为实验性规格。')}</p>}
  </div>;
}
