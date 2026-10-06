import { createHash, randomInt } from 'node:crypto';
import type { ChatAdapter, ProviderRuntimeConfig } from '../types.js';
import { config } from '../config.js';
import { buildNovelAIRequest, NAI_MODELS, novelaiSchema } from '../novelai.js';

const activeTokens = new Set<string>();

async function request(cfg: ProviderRuntimeConfig, route: string, signal: AbortSignal, body?: unknown) {
  if (!cfg.apiKey) throw new Error('请配置 NovelAI Persistent API Token');
  const base = (cfg.baseUrl?.trim() || 'https://image.novelai.net').replace(/\/+$/, '');
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { ...cfg.extraHeaders, Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const messages: Record<number, string> = {
      401: 'NovelAI Token 无效或已过期', 402: '本次生成需要 Anlas，已停止，请等待订阅额度恢复',
      403: 'NovelAI 拒绝访问，请检查订阅状态', 429: 'NovelAI 繁忙或达到并发限制，请稍后手动重试',
    };
    throw new Error(messages[response.status] || `NovelAI 请求失败 (${response.status})，请检查提示词长度及参数`);
  }
  // Enforce the bound while streaming, not after buffering arbitrary data.
  const limit = route === '/ai/generate-image' ? Math.ceil(config.maxGeneratedImageBytes * 1.4) + 65536 : 262144;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('NovelAI 返回空响应');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) throw new Error('NovelAI 响应超过大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('NovelAI 未返回有效的 JSON 响应'); }
}

export async function novelaiSubscription(cfg: ProviderRuntimeConfig, signal = AbortSignal.timeout(15000)) {
  const data = await request(cfg, '/user/subscription', signal);
  const usage = data.usage;
  const percent = typeof usage?.percent === 'number' && Number.isFinite(usage.percent) ? usage.percent : null;
  const active = data.active === true && Number(data.expiresAt) * 1000 > Date.now();
  const opus = Number(data.tier) >= 3;
  // The API reports integer percentages. Keep a 1% buffer and fail closed on
  // absent/unknown usage data; zero can represent less than one generation.
  const available = active && opus && usage?.isNegative === false && percent !== null && percent >= 1;
  const balance = data.trainingStepsLeft;
  const anlas = typeof balance === 'number' ? balance :
    typeof balance?.fixedTrainingStepsLeft === 'number' && typeof balance?.purchasedTrainingSteps === 'number'
      ? balance.fixedTrainingStepsLeft + balance.purchasedTrainingSteps : null;
  return {
    active, opus, percent, available, anlas,
    refillSeconds: typeof usage?.timeUntilNextPercent === 'number' ? usage.timeUntilNextPercent : null,
    reason: available ? null : !active ? 'NovelAI 订阅未生效或已到期' : !opus ? '订阅额度模式需要 Opus 订阅' : '订阅额度不足 1% 或状态不可用，请等待恢复后重试',
  };
}

export async function novelaiTags(cfg: ProviderRuntimeConfig, model: string, prompt: string) {
  if (!NAI_MODELS.includes(model as typeof NAI_MODELS[number])) throw new Error('模型不可用');
  const data = await request(cfg, `/ai/generate-image/suggest-tags?${new URLSearchParams({ model, prompt, lang: 'en' })}`, AbortSignal.timeout(10000));
  const list = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
  return list.filter((t: any) => typeof t?.tag === 'string').slice(0, 12).map((t: any) => ({ tag: String(t.tag).slice(0, 160) }));
}

export const novelaiAdapter: ChatAdapter = {
  async *streamChat() { throw new Error('NovelAI 请在绘图工坊中使用'); },
  async listModels(cfg) {
    await novelaiSubscription(cfg);
    return NAI_MODELS.map(id => ({ id, name: id.endsWith('curated') ? 'V5 Curated' : 'V5 Full' }));
  },
  async generateImages(cfg, req) {
    if (!req.novelai) throw new Error('请使用绘图工坊的 NAI 创作面板');
    if (req.n !== undefined && req.n !== 1 || req.inputImages?.length || req.context?.length) throw new Error('NAI 订阅模式仅支持单张文生图');
    const options = novelaiSchema.parse(req.novelai);
    const seed = options.seed ?? randomInt(0, 4294967296);
    const payload = buildNovelAIRequest(req.model, req.prompt, req.size || '832x1216', options, seed);
    const key = createHash('sha256').update(cfg.apiKey || '').digest('hex');
    if (activeTokens.has(key)) throw new Error('此 NovelAI 账号正在生成，请等待当前任务完成');
    activeTokens.add(key);
    try {
      const subscription = await novelaiSubscription(cfg, AbortSignal.any([req.signal, AbortSignal.timeout(15000)]));
      if (!subscription.available) throw new Error(subscription.reason!);
      req.signal.throwIfAborted();
      // No automatic retries or failover: an interrupted response can already
      // have consumed an allowance. See README for the upstream charging race.
      const result = await request(cfg, '/ai/generate-image', req.signal, payload);
      if (!Array.isArray(result.images) || result.images.length !== 1 || typeof result.images[0]?.image !== 'string') throw new Error('NovelAI 返回的图片数量或格式异常');
      const actualSeed = Number.isInteger(result.images[0].seed) ? result.images[0].seed : seed;
      return { images: [{
        mime: 'image/png', dataBase64: result.images[0].image,
        generationSettings: { provider: 'novelai', version: 1, prompt: req.prompt, size: req.size || '832x1216', model: req.model,
          options: { ...options, seed: actualSeed }, actualPrompt: payload.input, actualNegativePrompt: payload.parameters.negative_prompt },
      }] };
    } finally { activeTokens.delete(key); }
  },
};
