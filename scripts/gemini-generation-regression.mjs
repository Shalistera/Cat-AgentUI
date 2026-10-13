// Inspect actual Gemini request JSON and end-of-stream diagnostics; no network.
import assert from 'node:assert/strict';
import { geminiAdapter } from '../server/dist/providers/gemini.js';
const cfg = { id: 'fixture', type: 'gemini', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {}, useVertex: false };
const originalFetch = globalThis.fetch;
let body;
globalThis.fetch = async (_url, init) => {
  body = JSON.parse(init.body);
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 200, thoughtsTokenCount: 6000, candidatesTokenCount: 2192, totalTokenCount: 8392 } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
};
async function collect(model, reasoning, maxTokens = 8192) {
  const events = []; let end;
  for await (const event of geminiAdapter.streamChat(cfg, { model, reasoning, maxTokens, hardMaxTokens: 65536,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'fixture' }] }], signal: new AbortController().signal,
    onStreamEnd: (info) => { end = info; } })) events.push(event);
  return { events, end };
}
try {
  for (const model of ['gemini-4-argon', 'google/gemini-4-argon', 'publishers/google/models/gemini-4-argon']) {
    for (const [level, ratio] of [['low', 0], ['medium', 0.5], ['high', 1]]) {
      await collect(model, { level, ratio });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: level, includeThoughts: true }, `${model}: ${level}`);
    }
    for (const level of ['off', 'minimal']) {
      await collect(model, { level, ratio: 0 });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low', includeThoughts: level !== 'off' }, `${model}: ${level}`);
    }
    for (const [ratio, expected] of [[0, 'low'], [0.5, 'medium'], [1, 'high']]) {
      await collect(model, { level: 'custom-effort', ratio });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: expected, includeThoughts: true });
    }
    await collect(model);
    assert.equal(body.generationConfig.thinkingConfig, undefined, `${model}: preserve provider defaults when effort is unspecified`);
  }
  for (const [level, ratio] of [['low', 0], ['medium', 0.5], ['high', 1]]) {
    const { events, end } = await collect('gemini-3.8-flash', { level, ratio });
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: level, includeThoughts: true });
    assert.equal(body.generationConfig.maxOutputTokens, 8192, 'honor the configured request cap');
    assert.equal(events.at(-1).reason, 'length');
    assert.equal(events.find((e) => e.type === 'usage').usage.completionTokens, 8192, 'thinking and answer tokens remain correctly billed');
    assert.equal(end.requestedMaxOutputTokens, 8192);
    assert.equal(end.thoughtTokens, 6000); assert.equal(end.answerTokens, 2192);
  }
  await collect('google/gemini-3.8-flash-preview', { level: 'off', ratio: 0 });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low', includeThoughts: false });
  await collect('gemini-3.7-flash', { level: 'minimal', ratio: 0 });
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  await collect('gemini-3.8-flash', { level: 'custom-max', ratio: 1 }, 65536);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.equal(body.generationConfig.maxOutputTokens, 65536);
  await collect('gemini-2.5-flash', { level: 'off', ratio: 0 });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0, includeThoughts: false });
  await collect('gemini-2.5-pro', { level: 'high', ratio: 1 });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 32768, includeThoughts: true });
  await collect('gemini-3.8-flash');
  assert.equal(body.generationConfig.thinkingConfig, undefined, 'unspecified effort preserves provider default');
  console.log('PASS: native Gemini 4 Argon and Flash levels, prefixed model IDs, minimum/custom/default effort, legacy budgets, explicit output caps, MAX_TOKENS mapping and separate thinking/answer diagnostics.');
} finally { globalThis.fetch = originalFetch; }
