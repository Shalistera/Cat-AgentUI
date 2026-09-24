// Exercise the actual upstream and browser readers with fragmented transport
// chunks. No live provider, database or listening socket is needed.
import assert from 'node:assert/strict';
import { sseMessages } from '../server/dist/providers/sse.js';
import { streamChat, ApiError } from '../web/src/api.ts';

const encoder = new TextEncoder();
const collect = async (it) => { const out = []; for await (const ev of it) out.push(ev); return out; };
function response(text) {
  const bytes = encoder.encode(text);
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (i < bytes.length) controller.enqueue(bytes.slice(i, ++i));
      else controller.close();
    },
  }));
}

for (const ending of ['', '\n', '\n\n', '\r\n\r\n']) {
  assert.deepEqual(await collect(sseMessages(response(`: ping\r\n\r\nevent: finish\r\ndata: {"text":"完整回复🐱"}${ending}`))), [
    { event: 'finish', data: '{"text":"完整回复🐱"}' },
  ], 'retain an EOF data line and split UTF-8 codepoints');
}
let heartbeatBytes = 0;
assert.deepEqual(await collect(sseMessages(response(': heartbeat\n\n'), (bytes) => { heartbeatBytes += bytes; })), []);
assert.equal(heartbeatBytes, encoder.encode(': heartbeat\n\n').length, 'comment-only traffic reports activity without inventing generated output');

const realFetch = globalThis.fetch;
try {
  for (const ending of ['', '\n', '\n\n', '\r\n\r\n']) {
    const seen = [];
    globalThis.fetch = async () => response(`event: delta\ndata: {"text":"完整回复🐱"}\n\nevent: done\ndata: {"status":"done","finishReason":"stop"}${ending}`);
    await streamChat('test', {}, {
      onDelta: (text) => seen.push(text),
      onDone: (status, reason) => seen.push([status, reason]),
    }, new AbortController().signal);
    assert.deepEqual(seen, ['完整回复🐱', ['done', 'stop']], 'browser dispatches a final unterminated done event exactly once');
  }

  let feed;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { feed = controller; } }));
  let completed = false;
  let read = streamChat('test', {}, { onDone: () => { completed = true; } }, new AbortController().signal);
  feed.enqueue(encoder.encode('event: delta\ndata: {"text":"partial"}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(completed, false, 'silence on an open connection is not completion');
  feed.enqueue(encoder.encode('event: done\ndata: {"status":"done","finishReason":"stop"}'));
  feed.close();
  await read;
  assert.equal(completed, true);

  globalThis.fetch = async () => response('event: delta\ndata: {"text":"partial"}\n\n');
  completed = false;
  await streamChat('test', {}, { onDone: () => { completed = true; } }, new AbortController().signal);
  assert.equal(completed, false, 'a missing done event must not be invented');

  globalThis.fetch = async () => response('event: done\ndata: {"status":"done"');
  await streamChat('test', {}, { onDone: () => { completed = true; } }, new AbortController().signal);
  assert.equal(completed, false, 'a truncated JSON finish event is not a successful completion');

  globalThis.fetch = async () => new Response(JSON.stringify({ error: '对话并发数已达上限' }), { status: 429 });
  await assert.rejects(streamChat('test', {}, {}, new AbortController().signal), (e) => e instanceof ApiError && e.status === 429);
} finally { globalThis.fetch = realFetch; }
console.log('Passed: upstream/browser SSE tails, UTF-8 fragmentation, delayed completion, missing completion and pre-admission rejection.');
