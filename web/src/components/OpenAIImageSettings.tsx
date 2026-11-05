import { Field, Input, Select } from './ui';
import { t } from '../i18n';
import type { ImageOutputFormat } from '../types';

export type OpenAIImageOptions = {
  quality: 'low' | 'medium' | 'high';
  size: string;
  width: string;
  height: string;
  outputFormat: ImageOutputFormat | 'auto';
  frameCount: string;
  frameDurationMs: string;
};

export const DEFAULT_OPENAI_IMAGE_OPTIONS: OpenAIImageOptions = {
  quality: 'medium', size: 'auto', width: '1024', height: '1024',
  outputFormat: 'auto', frameCount: '9', frameDurationMs: '200',
};

const SIZES = [
  '1024x1024', '1536x1024', '1024x1536',
  '2048x2048', '2048x1152', '1152x2048',
  '2560x1440', '1440x2560', '3840x2160', '2160x3840',
];
const GIF_SIZES = ['256x256', '512x512', '768x768', '1024x1024', '512x288', '288x512'];

export function openaiImageSize(options: OpenAIImageOptions): string {
  return options.size === 'custom' ? `${options.width}x${options.height}` : options.size;
}

export function openaiImageSizeError(options: OpenAIImageOptions): string | null {
  const size = openaiImageSize(options);
  if (size === 'auto') return null;
  if (!/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size)) return t('宽高须为正整数');
  const [width, height] = size.split('x').map(Number);
  if (options.outputFormat === 'gif') {
    return width % 16 || height % 16 ? t('GIF 每帧宽高须为 16 的正整数倍') : null;
  }
  if (width > 3840 || height > 3840 || width % 16 || height % 16) return t('宽高须为 16 的倍数,每边最多 3840 像素');
  if (Math.max(width, height) > Math.min(width, height) * 3) return t('长边与短边之比最多为 3:1');
  if (width * height < 655360 || width * height > 8294400) return t('总像素须在 655,360 至 8,294,400 之间');
  return null;
}

export function openaiImageAnimationError(options: OpenAIImageOptions): string | null {
  if (options.outputFormat !== 'gif') return null;
  const count = Number(options.frameCount);
  const duration = Number(options.frameDurationMs);
  if (!Number.isInteger(count) || count < 2 || count > 64) return t('GIF 帧数须为 2–64 的整数');
  if (!Number.isInteger(duration) || duration < 20 || duration > 2000) return t('GIF 帧间隔须为 20–2000 毫秒的整数');
  return null;
}

export function OpenAIImageSettings({ value, onChange, showQualitySize = true, outputFormats = [] }: {
  value: OpenAIImageOptions; onChange(value: OpenAIImageOptions): void;
  showQualitySize?: boolean; outputFormats?: ImageOutputFormat[];
}) {
  const isGif = value.outputFormat === 'gif';
  const error = openaiImageAnimationError(value) ?? (showQualitySize ? openaiImageSizeError(value) : null);
  const [width, height] = openaiImageSize(value).split('x').map(Number);
  const experimental = showQualitySize && !isGif && !error && width * height > 3686400;
  return <div className="space-y-3 rounded-lg border border-line bg-bg0 p-3">
    {outputFormats.length > 0 && <Field label={t('输出格式')}>
      <Select aria-label={t('输出格式')} value={value.outputFormat}
        onChange={(e) => {
          const outputFormat = e.target.value as OpenAIImageOptions['outputFormat'];
          onChange({ ...value, outputFormat, size: (isGif !== (outputFormat === 'gif')) ? 'auto' : value.size });
        }}>
        <option value="auto">{t('模型默认')}</option>
        {outputFormats.map((format) => <option key={format} value={format}>
          {format === 'gif' ? t('GIF 动图') : format.toUpperCase()}
        </option>)}
      </Select>
    </Field>}
    {isGif && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('帧数')}>
          <Input aria-label={t('帧数')} type="number" min={2} max={64} step={1} value={value.frameCount}
            onChange={(e) => onChange({ ...value, frameCount: e.target.value })} />
        </Field>
        <Field label={t('每帧时长(ms)')}>
          <Input aria-label={t('每帧时长(ms)')} type="number" min={20} max={2000} step={10} value={value.frameDurationMs}
            onChange={(e) => onChange({ ...value, frameDurationMs: e.target.value })} />
        </Field>
      </div>
      <p className="text-xs leading-relaxed text-tx3">{t('请在提示词中描述动作和循环方式;帧间隔按 10 毫秒取整。参考图能否生成 GIF 取决于所选服务。')}</p>
      {!openaiImageAnimationError(value) && <p className="text-xs text-tx3">
        {t('每轮动画约 {seconds} 秒', { seconds: Number((Number(value.frameCount) * Math.round(Number(value.frameDurationMs) / 10) / 100).toFixed(2)) })}
      </p>}
      <p className="text-xs leading-relaxed text-tx3">{t('建议使用自动分辨率。若超过模型像素预算,请减少帧数、尺寸或生成数量。')}</p>
    </>}
    {showQualitySize && <><div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('图像质量')}>
        <Select aria-label={t('图像质量')} value={value.quality}
          onChange={(e) => onChange({ ...value, quality: e.target.value as OpenAIImageOptions['quality'] })}>
          <option value="low">{t('低')} · low</option>
          <option value="medium">{t('中')} · medium</option>
          <option value="high">{t('高')} · high</option>
        </Select>
      </Field>
      <Field label={isGif ? t('每帧分辨率') : t('分辨率')}>
        <Select aria-label={isGif ? t('每帧分辨率') : t('分辨率')} value={value.size} onChange={(e) => onChange({ ...value, size: e.target.value })}>
          <option value="auto">{t('自动')}</option>
          {(isGif ? GIF_SIZES : SIZES).map((size) => <option key={size} value={size}>{size.replace('x', ' × ')}</option>)}
          <option value="custom">{t('自定义')}</option>
        </Select>
      </Field>
    </div>
    {value.size === 'custom' && <div className="grid grid-cols-2 gap-3">
      <Field label={t('宽度(px)')}>
        <Input aria-label={t('宽度(px)')} type="number" min={16} max={isGif ? 9999 : 3840} step={16} value={value.width}
          onChange={(e) => onChange({ ...value, width: e.target.value })} />
      </Field>
      <Field label={t('高度(px)')}>
        <Input aria-label={t('高度(px)')} type="number" min={16} max={isGif ? 9999 : 3840} step={16} value={value.height}
          onChange={(e) => onChange({ ...value, height: e.target.value })} />
      </Field>
    </div>}
    {value.size === 'custom' && <p className="text-xs leading-relaxed text-tx3">
      {isGif ? t('GIF 每帧宽高须为 16 的正整数倍') : t('宽高为 16 的倍数,每边最多 3840 像素,长宽比不超过 3:1,总像素为 655,360–8,294,400。')}
    </p>}
    </>}
    {error && <p role="alert" className="text-xs text-err">{error}</p>}
    {experimental && <p className="text-xs text-tx3">{t('超过 3,686,400 像素的分辨率为实验性规格。')}</p>}
  </div>;
}
