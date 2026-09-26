// Synthetic provider responses only: no credentials or external API calls.
import assert from 'node:assert/strict';
import { geminiAdapter } from '../server/dist/providers/gemini.js';

const cfg = { id: 'fixture', type: 'gemini', baseUrl: 'https://fixture.invalid', apiKey: null, extraHeaders: {}, useVertex: false };
const request = { model: 'fixture', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], signal: new AbortController().signal };
const longSignature = 'CjUK' + 'aB09+/'.repeat(4000) + '=';
let responseParts = [];
let sent;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  sent = JSON.parse(options.body);
  return new Response(responseParts.map((parts) => `data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
async function collect(req = request) {
  const events = [];
  for await (const event of geminiAdapter.streamChat(cfg, req)) events.push(event);
  return events;
}
try {
  responseParts = [[{ text: 'hello', thoughtSignature: longSignature }], [{ text: '', thoughtSignature: 'trailing==' }], [{ thought: true, text: 'summary', thoughtSignature: 'thought==' }]];
  const events = await collect();
  assert.deepEqual(events, [
    { type: 'text', text: 'hello' },
    { type: 'reasoning', text: 'summary' },
    { type: 'stop', reason: 'stop' },
  ]);
  responseParts = [[{ functionCall: { name: 'lookup', args: { id: 1 } }, thoughtSignature: longSignature }, { functionCall: { name: 'other', args: {} } }]];
  const calls = (await collect()).filter((e) => e.type === 'tool_call');
  assert.equal(calls[0].sig, longSignature);
  assert.equal(calls[1].sig, undefined);
  await collect({ ...request, messages: [...request.messages, { role: 'assistant', parts: [...calls, { type: 'tool_result', name: 'lookup', toolCallId: calls[0].id, result: 'done' }] }] });
  assert.equal(sent.contents[1].parts[0].thoughtSignature, longSignature);
  assert.equal(sent.contents[1].parts[1].thoughtSignature, undefined);
  responseParts = [[{ text: 'plain response' }, { thoughtSignature: null }, { thoughtSignature: 123 }, { thoughtSignature: '' }]];
  assert.equal((await collect()).filter((e) => e.type === 'thought_signature').length, 0);
  console.log('PASS: display-only signatures ignored; tool signatures preserved and replayed verbatim');
} finally {
  globalThis.fetch = originalFetch;
}
