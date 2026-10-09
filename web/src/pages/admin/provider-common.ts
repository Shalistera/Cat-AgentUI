import { t } from '../../i18n';
import type { AdminProvider } from '../../types';

export type ProviderType = AdminProvider['type'];

export const TYPE_LABELS: Record<ProviderType, string> = {
  novelai: 'NovelAI V5',
  openai: t('OpenAI 兼容'),
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  'claude-code': t('本地 Claude Code'),
};

export const DEFAULT_URLS: Record<ProviderType, string> = {
  novelai: 'https://image.novelai.net',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'claude-code': t('本机 claude 进程'),
};
