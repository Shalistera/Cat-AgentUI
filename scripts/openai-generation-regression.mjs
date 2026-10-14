// Inspect actual OpenAI request caps on the wire; no network.
import assert from 'node:assert/strict';
import { openaiAdapter } from '../server/dist/providers/openai.js';
const official = { id: 'fixture', type: 'openai', baseUrl: '', apiKey: null, extraHeaders: {} };
const gateway = { ...official, baseUrl: 'https://gateway.invalid/v1' };
const responses = { ...gateway, useResponses: true };
const originalFetch = globalThis.fetch;
let body;
globalThis.fetch = async (url, init) => {
  body = JSON.parse(init.body);
  const event = url.endsWith('/responses') ? { type: 'response.completed', response: { status: 'completed' } }
    : { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
// hardMaxTokens null = a caller that asked for an exact cap.
async function cap(cfg, model, reasoning, maxTokens = 8192, hardMaxTokens = 65536) {
  for await (const _ev of openaiAdapter.streamChat(cfg, { model, reasoning, maxTokens, hardMaxTokens: hardMaxTokens ?? undefined,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'fixture' }] }], signal: new AbortController().signal })) { /* drain */ }
  return body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
}
const high = { level: 'high', ratio: 1 };
try {
  assert.equal(await cap(official, 'gpt-5.6-sol', high), 32768, 'reasoning is billed inside max_completion_tokens');
  assert.equal(body.max_tokens, undefined);
  assert.equal(await cap(gateway, 'gpt-5.6-sol', high), 32768);
  assert.equal(body.max_tokens, 32768, 'compatible gateways keep max_tokens');
  assert.equal(await cap(responses, 'gpt-6.1-sol', { level: 'xhigh', ratio: 1 }), 32768);
  assert.equal(body.max_output_tokens, 32768, 'Responses counts reasoning inside max_output_tokens');
  assert.equal(await cap(responses, 'openai/gpt-5.6-sol', high), 32768, 'gateway-prefixed model ids');
  assert.equal(await cap(responses, 'o4-mini', { level: 'low', ratio: 0 }), 32768);
  // off and an unspecified effort omit the field; the model reasons at its default.
  assert.equal(await cap(responses, 'gpt-5.6-luna'), 32768);
  assert.equal(await cap(responses, 'gpt-5.6-luna', { level: 'off', ratio: 0 }), 32768);
  assert.equal(body.reasoning, undefined);
  assert.equal(await cap(responses, 'gpt-5.6-luna', { level: 'none', ratio: 0 }), 8192, 'the no-reasoning tier keeps the answer cap');
  for (const model of ['gpt-5-chat-latest', 'gpt-4o', 'claude-code', 'deepseek-reasoner']) {
    assert.equal(await cap(gateway, model, model === 'deepseek-reasoner' ? high : undefined), 8192, `${model}: unknown output limit keeps the exact cap`);
  }
  assert.equal(await cap(responses, 'gpt-5.6-sol', high, 8192, 16384), 16384, 'never above MAX_MODEL_OUTPUT_TOKENS');
  assert.equal(await cap(responses, 'gpt-5.6-sol', high, 500, null), 500, 'callers without a hard limit keep their exact cap');
  assert.equal(await cap(responses, 'gpt-5.6-sol', high, 65536), 65536, 'a larger configured cap is kept');
  console.log('PASS: OpenAI reasoning models get room for reasoning in Chat Completions and Responses caps (bounded, exact without a hard limit); other models keep the exact cap.');
} finally { globalThis.fetch = originalFetch; }
