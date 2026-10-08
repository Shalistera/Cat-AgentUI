// Anthropic adapter request shape against a local stub: adaptive thinking +
// effort on Claude 4.6+/5 (never budget_tokens or sampling there), budgets on
// older models, thinking blocks replayed for the tool loop in progress only,
// conversation cache breakpoints, cached tokens counted as prompt tokens —
// and Gemini never receiving a Claude thinking signature. Never calls a real API.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync(path.join((await import('node:os')).tmpdir(), 'cat-anthropic-'));
process.env.SECRET_KEY = 'anthropic-adapter-test-only';
const { anthropicAdapter, ANTHROPIC_SIG_PREFIX } = await import(`${root}/server/dist/providers/anthropic.js`);
const { geminiAdapter } = await import(`${root}/server/dist/providers/gemini.js`);

const bodies = [];
let script = 'text';
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  bodies.push({ url: req.url, body });
  if (req.url.includes(':streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`);
  }
  const start = { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } };
  if (script === 'tool') {
    return sse(res, [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先查一下' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'project_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"差旅"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]);
  }
  sse(res, [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const cfg = { id: 'p', type: 'anthropic', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', extraHeaders: {}, useResponses: false, useVertex: false, vertexProject: null, vertexLocation: null, vertexSaJson: null };
const user = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });
async function run(req, adapter = anthropicAdapter, c = cfg) {
  const events = [];
  for await (const ev of adapter.streamChat(c, { signal: AbortSignal.timeout(10_000), ...req })) events.push(ev);
  return { events, body: bodies.at(-1).body };
}

try {
  // Opus 5.5, thinking on: adaptive + effort, summarized display, no budget / sampling.
  let { body, events } = await run({ model: 'claude-opus-5-5', messages: [user('hi')], reasoning: { level: 'high', ratio: 1 }, temperature: 0.2 });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.temperature, undefined);
  assert(body.max_tokens >= 32_768);
  assert.equal(events.find((e) => e.type === 'usage').usage.promptTokens, 1060, 'cached reads/writes count as prompt tokens');
  // Opus 5.5, "off": it can't stop thinking, so the lowest effort; still no sampling.
  ({ body } = await run({ model: 'claude-opus-5-5', messages: [user('hi')], temperature: 0.2 }));
  assert.equal(body.thinking, undefined); assert.deepEqual(body.output_config, { effort: 'low' }); assert.equal(body.temperature, undefined);
  // Opus 4.7, "off": omitting thinking already means none; no effort forced.
  ({ body } = await run({ model: 'claude-opus-4-7', messages: [user('hi')] }));
  assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined);
  // Sonnet 4.6 has no xhigh and no `display`.
  ({ body } = await run({ model: 'claude-sonnet-4-6', messages: [user('hi')], reasoning: { level: 'xhigh', ratio: 1 } }));
  assert.deepEqual(body.thinking, { type: 'adaptive' }); assert.deepEqual(body.output_config, { effort: 'high' });
  // Gateway names map too; custom ladder names fall back to the ratio.
  ({ body } = await run({ model: 'anthropic/claude-sonnet-5-5', messages: [user('hi')], reasoning: { level: '深度', ratio: 0.5 } }));
  assert.deepEqual(body.output_config, { effort: 'medium' });
  // Older models keep token budgets (and sampling when not thinking).
  ({ body } = await run({ model: 'claude-sonnet-4-5', messages: [user('hi')], reasoning: { level: 'medium', ratio: 0.5 } }));
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 17_408 }); assert(body.max_tokens >= 17_408 + 4096);
  // Haiku 5.5 joins the 5 family: thinks by default, rejects sampling and budgets.
  ({ body } = await run({ model: 'claude-haiku-5-5', messages: [user('hi')], temperature: 0.2 }));
  assert.equal(body.thinking, undefined); assert.deepEqual(body.output_config, { effort: 'low' }); assert.equal(body.temperature, undefined);
  ({ body } = await run({ model: 'claude-haiku-5-5', messages: [user('hi')], reasoning: { level: 'high', ratio: 1 } }));
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' }); assert.deepEqual(body.output_config, { effort: 'high' });
  ({ body } = await run({ model: 'claude-haiku-4-5', messages: [user('hi')], temperature: 0.2 }));
  assert.equal(body.temperature, 0.2); assert.equal(body.thinking, undefined);

  // Tool loop: the thinking block rides on the call and comes back first in the turn in progress.
  script = 'tool';
  ({ events } = await run({ model: 'claude-opus-5-5', messages: [user('差旅标准?')], reasoning: { level: 'high', ratio: 1 } }));
  const call = events.find((e) => e.type === 'tool_call');
  assert(call.sig.startsWith(ANTHROPIC_SIG_PREFIX));
  assert.deepEqual(JSON.parse(call.sig.slice(ANTHROPIC_SIG_PREFIX.length)), [{ type: 'thinking', thinking: '先查一下', signature: 'SIG-1' }]);
  script = 'text';
  const longSystem = '项目资料'.repeat(1200);
  const earlier = { role: 'assistant', parts: [{ type: 'text', text: '之前' }, { ...call, type: 'tool_call' }, { type: 'tool_result', toolCallId: call.id, name: call.name, result: '旧结果' }, { type: 'text', text: '旧回答' }] };
  ({ body } = await run({
    model: 'claude-opus-5-5', system: longSystem, reasoning: { level: 'high', ratio: 1 },
    messages: [user('上一轮'), earlier, user('差旅标准?'), { role: 'assistant', parts: [{ type: 'text', text: '我查一下。' }, { type: 'tool_call', id: call.id, name: call.name, args: call.args, sig: call.sig }, { type: 'tool_result', toolCallId: call.id, name: call.name, result: '每天300元' }] }],
  }));
  const msgs = body.messages;
  const current = msgs.at(-2);
  assert.equal(current.role, 'assistant');
  assert.deepEqual(current.content.map((b) => b.type), ['thinking', 'text', 'tool_use'], 'thinking opens the assistant message');
  assert.equal(current.content[0].signature, 'SIG-1');
  assert(!msgs[1].content.some((b) => b.type === 'thinking'), 'earlier turns are not replayed with thinking');
  // Cache: system, the newest block, and the previous user turn.
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.equal(msgs.at(-1).content.at(-1).cache_control.type, 'ephemeral');
  const prevUser = msgs.slice(0, -1).findLast((m) => m.role === 'user');
  assert.equal(prevUser.content.at(-1).cache_control.type, 'ephemeral');
  assert.equal(JSON.stringify(body).split('cache_control').length - 1, 3, 'at most three breakpoints here (limit is four)');

  // A chat switched to Gemini: Claude's thinking signature must not be echoed as Gemini's.
  const gcfg = { ...cfg, type: 'gemini', baseUrl: `http://127.0.0.1:${server.address().port}` };
  await run({ model: 'gemini-2.5-pro', messages: [user('q'), { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'project_search', args: '{}', sig: call.sig }, { type: 'tool_result', toolCallId: 'c1', name: 'project_search', result: 'r' }] }, user('next')] }, geminiAdapter, gcfg);
  const gbody = bodies.at(-1);
  assert(gbody.url.includes(':streamGenerateContent'), gbody.url);
  assert(!JSON.stringify(gbody.body).includes('thoughtSignature'), 'no foreign signature sent to Gemini');
  console.log('Anthropic adapter regression passed: adaptive thinking + effort, legacy budgets, thinking replay for the live tool loop only, cache breakpoints, cached-token accounting, Gemini signature guard.');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  server.close();
  process.exit(process.exitCode ?? 0);
}
