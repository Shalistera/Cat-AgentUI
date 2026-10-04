import type { AdminProvider } from '../../types';

export type ProviderType = AdminProvider['type'];

export const TYPE_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  'claude-code': '本地 Claude Code',
};

export const DEFAULT_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  'claude-code': '本机 claude 进程',
};
