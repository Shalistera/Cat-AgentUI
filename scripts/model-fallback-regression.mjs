// Which model the chat offers when a provider keeps rate-limiting: the first
// one in the person's own order from another provider that can carry the
// conversation and still has allowance.
import assert from 'node:assert/strict';
import { suggestFallbackModel, configuredFallbackModel } from '../web/src/api.ts';

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

const primary = model('gemini-3.8-flash', 'google', { fallbackModelId: 'gemini-3.7-flash' });
assert.equal(configuredFallbackModel([primary, ...models], primary)?.id, 'gemini-3.7-flash', 'explicit fallback can be on the same provider');
assert.equal(configuredFallbackModel([primary], primary), null, 'missing/revoked fallback is not usable');
assert.equal(configuredFallbackModel(models, { ...primary, fallbackModelId: primary.id }), null, 'self-fallback cannot loop');
assert.equal(configuredFallbackModel(models, { ...primary, fallbackModelId: 'gpt-image-2' }), null);
assert.equal(configuredFallbackModel(models, { ...primary, fallbackModelId: 'gpt-5.6-luna' }), null, 'tools must be preserved');
assert.equal(configuredFallbackModel(models, { ...primary, fallbackModelId: 'gpt-5.6-sol' }), null, 'vision must be preserved');
assert.equal(configuredFallbackModel(models, { ...primary, fallbackModelId: 'claude-x' }), null, 'quota must be available');
assert.equal(configuredFallbackModel(models, { ...primary, fallbackModelId: null }), null, 'no configured fallback means no automatic switch');
console.log('configured fallback eligibility: OK');
