import type { ChatAdapter, ProviderRuntimeConfig, ProviderType } from '../types.js';
import { decryptSecret } from '../crypto.js';
import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';

const adapters: Record<ProviderType, ChatAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(type: string): ChatAdapter {
  const a = adapters[type as ProviderType];
  if (!a) throw new Error(`未知的 Provider 类型: ${type}`);
  return a;
}

export interface ProviderRow {
  id: string;
  type: string;
  baseUrl: string | null;
  apiKeyEnc: string | null;
  useResponses: number;
  useVertex: number;
  vertexProject: string | null;
  vertexLocation: string | null;
  vertexSaJsonEnc: string | null;
  extraHeaders: string;
}

export function toRuntimeConfig(row: ProviderRow): ProviderRuntimeConfig {
  let extraHeaders: Record<string, string> = {};
  try { extraHeaders = JSON.parse(row.extraHeaders || '{}'); } catch { /* ignore */ }
  return {
    id: row.id,
    type: row.type as ProviderType,
    baseUrl: row.baseUrl,
    apiKey: row.apiKeyEnc ? decryptSecret(row.apiKeyEnc) : null,
    useResponses: !!row.useResponses,
    useVertex: !!row.useVertex,
    vertexProject: row.vertexProject,
    vertexLocation: row.vertexLocation,
    vertexSaJson: row.vertexSaJsonEnc ? decryptSecret(row.vertexSaJsonEnc) : null,
    extraHeaders,
  };
}
