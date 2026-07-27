// Minimal OpenAI-compatible mock server for local E2E testing (no real API key needed).
// Usage: node scripts/mock-openai.mjs [port]   (default 4141)
// Then add a provider in Cat-AgentUI: type=openai, baseUrl=http://127.0.0.1:4141/v1, any key.
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.argv[2] || 4141);

// ---- tiny PNG writer, so each request returns a visibly different picture ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function solidPng(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // a soft diagonal gradient so the image reads as a picture, not a swatch
      const k = 0.65 + 0.35 * ((x + y) / (2 * size));
      raw.writeUInt8(Math.min(255, Math.round(r * k)), row + 1 + x * 3);
      raw.writeUInt8(Math.min(255, Math.round(g * k)), row + 2 + x * 3);
      raw.writeUInt8(Math.min(255, Math.round(b * k)), row + 3 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Colour is derived from the prompt: "画只猫" and "换成蓝色" come back different,
// which is what makes context carry-over visible when testing.
function promptImage(prompt) {
  let h = 2166136261;
  for (const ch of String(prompt || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const hue = [(h >>> 16) & 255, (h >>> 8) & 255, h & 255].map((v) => 40 + (v % 200));
  return solidPng(256, hue).toString('base64');
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url}`);
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }, { id: 'mock-image' }] }));
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    const lastMsg = body.messages?.[body.messages.length - 1];
    const lastText = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : (lastMsg?.content ?? []).map((p) => p.text ?? '').join(' ');
    const hasToolResult = body.messages?.some((m) => m.role === 'tool');
    const wantsTool = body.tools?.length && /use_tool/.test(lastText ?? '') && !hasToolResult;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model };

    if (wantsTool) {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: body.tools[0].function.name, arguments: '' } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"cat"}' } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    } else {
      const reply = hasToolResult
        ? ['工具调用完成。', '这是', '基于工具结果的', '回答。']
        : ['你好,', '我是**黑猫**。', '\n\n```python\nprint("meow")\n```\n', '公式:$E=mc^2$。', `你说了:${(lastText ?? '').slice(0, 40)}`];
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      for (const t of reply) {
        await sleep(120);
        send({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (req.url === '/v1/images/generations' && req.method === 'POST') {
    const body = await readBody(req);
    await sleep(600);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: body.n || 1 }, (_, i) => ({ b64_json: promptImage(`${body.prompt}#${i}`) })),
      usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
    }));
    return;
  }

  // image editing (reference images) — used when a chat turn carries earlier pictures
  if (req.url === '/v1/images/edits' && req.method === 'POST') {
    const raw = await readRaw(req);
    const prompt = /name="prompt"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(raw.toString('latin1'))?.[1] ?? '';
    const refs = (raw.toString('latin1').match(/name="image\[\]"/g) ?? []).length;
    await sleep(600);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: promptImage(`edit:${refs}:${prompt}`) }],
      usage: { input_tokens: 30, output_tokens: 100, total_tokens: 130 },
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
}).listen(PORT, '127.0.0.1', () => console.log(`mock-openai on http://127.0.0.1:${PORT}/v1`));
