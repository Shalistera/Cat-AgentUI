import assert from 'node:assert/strict';
import { withFailover, resetLineHealth, lineStatus } from '../server/dist/providers/failover.js';
import { ProviderEmptyError, ProviderInterruptedError } from '../server/dist/providers/stream-integrity.js';
import { geminiAdapter } from '../server/dist/providers/gemini.js';
import { ContinuationText } from '../server/dist/continuation-text.js';

const base = { id: 'qa', type: 'gemini', endpointId: 'a', endpointName: 'A', baseUrl: 'http://mock.invalid', apiKey: null, useResponses: false, useVertex: false,
  vertexProject: null, vertexLocation: null, vertexSaJson: null, extraHeaders: {}, recoverEmptyStreams: true };
const req = (extra = {}) => ({ model: 'qa', messages: [], signal: new AbortController().signal, ...extra });
const collect = async (stream) => { const all = []; for await (const e of stream) all.push(e); return all; };
let calls;
const fake = (steps) => { calls = []; return withFailover({ async *streamChat(c, r) {
  calls.push(c.endpointId);
  const events = steps.shift();
  for (const ev of events ?? []) { if (ev instanceof Error) throw ev; yield ev; }
}, async listModels() { return []; } }); };
const usage = { type: 'usage', usage: { totalTokens: 3 } };
const stop = { type: 'stop', reason: 'stop' };
const success = [{ type: 'text', text: 'Working answer' }, usage, stop];
const thought = { type: 'reasoning', text: 'incomplete speculation' };

resetLineHealth();
const adapter = fake([[thought, usage, stop], success]);
const notices = [];
const output = await collect(adapter.streamChat({ ...base, fallbacks: [{ ...base, endpointId: 'b', endpointName: 'B' }] }, req({ onFailover: (n) => notices.push(n) })));
assert.deepEqual(calls, ['a', 'b']);
assert.equal(notices[0].recovery, 'empty');
assert(!output.some((e) => e.type === 'reasoning'));
assert.equal(output.filter((e) => e.type === 'usage').reduce((n, e) => n + e.usage.totalTokens, 0), 6);
assert.equal(lineStatus('a').failures, 1, 'empty HTTP success degrades the failing endpoint');

resetLineHealth();
await assert.rejects(collect(fake([[stop], [stop], success]).streamChat({ ...base, fallbacks: [{ ...base, endpointId: 'b' }, { ...base, endpointId: 'c' }] }, req())), ProviderEmptyError);
assert.deepEqual(calls, ['a', 'b'], 'empty recovery does not walk an unbounded list of lines');
for (const reason of ['length', 'content_filter']) {
  const out = await collect(fake([[thought, { type: 'stop', reason }], success]).streamChat(base, req()));
  assert.equal(calls.length, 1); assert.equal(out.at(-1).reason, reason);
  const afterEnd = await collect(fake([[{ type: 'stop', reason }, new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })], success]).streamChat(base, req()));
  assert.equal(calls.length, 1); assert.equal(afterEnd.at(-1).reason, reason, 'later connection reset cannot bypass a terminal refusal or limit');
}
await assert.rejects(collect(fake([[{ type: 'text', text: 'Partial answer' }, { type: 'stop', reason: 'other' }], success]).streamChat(base, req())), ProviderInterruptedError);
assert.equal(calls.length, 1, 'line layer never replays visible partial output');
const cancel = new AbortController();
await assert.rejects(collect(fake([[usage, stop], success]).streamChat(base, req({ signal: cancel.signal, onFailover: () => cancel.abort() }))));
assert.equal(calls.length, 1, 'cancel prevents the recovery attempt');

const original = 'This original prefix must remain exactly once.';
const joiner = new ContinuationText(original);
assert.equal(joiner.push(original.slice(0, 8)), '');
assert.equal(joiner.push(original.slice(8) + ' Fresh tail.'), ' Fresh tail.');
assert.equal(joiner.flush(), '');
const different = new ContinuationText(original);
assert.equal(different.push('A different continuation.'), 'A different continuation.');

const savedFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Already complete' }] }, finishReason: 'STOP' }] })}\n\n`));
    setTimeout(() => controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })), 10);
  } }));
  const final = await collect(withFailover(geminiAdapter).streamChat(base, req()));
  assert.equal(final.at(-1).reason, 'stop', 'a socket reset after an explicit final frame does not trigger continuation');
} finally { globalThis.fetch = savedFetch; }
console.log('Passed: empty channel failover, discarded reasoning, attempt accounting/bounds, policy and cancellation, no partial replay, overlap removal, and confirmed finish before socket reset.');
