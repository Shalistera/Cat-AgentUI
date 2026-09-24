// Which model the chat offers when a provider keeps rate-limiting: the first
// one in the person's own order from another provider that can carry the
// conversation and still has allowance.
import assert from 'node:assert/strict';
import { suggestFallbackModel } from '../web/src/api.ts';

const model = (id, providerId, extra = {}) => ({
  id, modelId: id, displayName: id, providerId, providerName: providerId,
  vision: true, tools: true, imageGen: false, usageLimit: null, ...extra,
});
const models = [
  model('gemini-3.7-flash', 'google'),
  model('gpt-image-2', 'openai', { imageGen: true }),
  model('gpt-5.6-luna', 'openai', { tools: false }),
  model('gpt-5.6-sol', 'openai', { vision: false }),
  model('claude-x', 'anthropic', { usageLimit: { period: 'day', requests: { used: 10, limit: 10 }, tokens: null } }),
  model('claude-y', 'anthropic'),
];
const pick = (opts) => suggestFallbackModel(models, { avoidProviderId: 'google', needsVision: false, needsTools: false, ...opts })?.id ?? null;

assert.equal(pick({}), 'gpt-5.6-luna', 'first other-provider text model in the given order');
assert.equal(pick({ needsTools: true }), 'gpt-5.6-sol', 'tools in play skip models without tools');
assert.equal(pick({ needsTools: true, needsVision: true }), 'claude-y', 'pictures skip non-vision models; spent allowance is skipped');
assert.equal(pick({ avoidProviderId: 'openai' }), 'gemini-3.7-flash');
assert.equal(suggestFallbackModel(models.slice(0, 2), { avoidProviderId: 'google', needsVision: false, needsTools: false }), null,
  'image models are never offered');
console.log('model-fallback regression: OK');
