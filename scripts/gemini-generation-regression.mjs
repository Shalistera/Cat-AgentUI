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
// hardMaxTokens null = a caller that asked for an exact cap.
async function collect(model, reasoning, maxTokens = 8192, hardMaxTokens = 65536) {
  const events = []; let end;
  for await (const event of geminiAdapter.streamChat(cfg, { model, reasoning, maxTokens, hardMaxTokens: hardMaxTokens ?? undefined,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'fixture' }] }], signal: new AbortController().signal,
    onStreamEnd: (info) => { end = info; } })) events.push(event);
  return { events, end };
}
try {
  for (const model of ['gemini-4-argon', 'google/gemini-4-argon', 'publishers/google/models/gemini-4-argon']) {
    for (const [level, ratio] of [['low', 0], ['medium', 0.5], ['high', 1]]) {
      await collect(model, { level, ratio });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: level, includeThoughts: true }, `${model}: ${level}`);
      assert.equal(body.generationConfig.maxOutputTokens, 32768, `${model}: ${level} thinking gets room beyond the 8K answer cap`);
    }
    for (const level of ['off', 'minimal']) {
      await collect(model, { level, ratio: 0 });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low', includeThoughts: level !== 'off' }, `${model}: ${level}`);
      assert.equal(body.generationConfig.maxOutputTokens, 32768, `${model}: ${level} still thinks at low`);
    }
    for (const [ratio, expected] of [[0, 'low'], [0.5, 'medium'], [1, 'high']]) {
      await collect(model, { level: 'custom-effort', ratio });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: expected, includeThoughts: true });
    }
    await collect(model);
    assert.equal(body.generationConfig.thinkingConfig, undefined, `${model}: preserve provider defaults when effort is unspecified`);
    assert.equal(body.generationConfig.maxOutputTokens, 32768, `${model}: the provider default still thinks`);
  }
  for (const [level, ratio] of [['low', 0], ['medium', 0.5], ['high', 1]]) {
    const { events, end } = await collect('gemini-3.8-flash', { level, ratio });
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: level, includeThoughts: true });
    assert.equal(body.generationConfig.maxOutputTokens, 32768, 'thinking is billed inside the cap, so it gets room on top of the answer cap');
    assert.equal(events.at(-1).reason, 'length');
    assert.equal(events.find((e) => e.type === 'usage').usage.completionTokens, 8192, 'thinking and answer tokens remain correctly billed');
    assert.equal(end.requestedMaxOutputTokens, 32768, 'diagnostics report the cap actually sent');
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
  assert.equal(body.generationConfig.maxOutputTokens, 8192, 'a zero budget really turns thinking off, so the answer cap stays');
  await collect('gemini-2.5-pro', { level: 'high', ratio: 1 });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 32768, includeThoughts: true });
  assert.equal(body.generationConfig.maxOutputTokens, 32768 + 4096, 'a full thinking budget still leaves room for the answer');
  await collect('gemini-3.6-flash', { level: 'medium', ratio: 0.5 });
  assert.equal(body.generationConfig.maxOutputTokens, 32768);
  await collect('gemini-3.8-flash');
  assert.equal(body.generationConfig.thinkingConfig, undefined, 'unspecified effort preserves provider default');
  await collect('gemini-4-argon', { level: 'high', ratio: 1 }, 8192, 16384);
  assert.equal(body.generationConfig.maxOutputTokens, 16384, 'never above MAX_MODEL_OUTPUT_TOKENS');
  await collect('gemini-4-argon', { level: 'high', ratio: 1 }, 500, null);
  assert.equal(body.generationConfig.maxOutputTokens, 500, 'callers without a hard limit keep their exact cap');
  for (const model of ['gemini-2.0-flash', 'gemma-3-27b-it']) {
    await collect(model);
    assert.equal(body.generationConfig.maxOutputTokens, 8192, `${model}: non-thinking models keep the exact cap`);
  }
  console.log('PASS: native Gemini 4 Argon and Flash levels, prefixed model IDs, minimum/custom/default effort, legacy budgets, thinking room in output caps (bounded, exact without a hard limit), MAX_TOKENS mapping and separate thinking/answer diagnostics.');
} finally { globalThis.fetch = originalFetch; }
