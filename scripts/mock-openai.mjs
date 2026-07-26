// Minimal OpenAI-compatible mock server for local E2E testing (no real API key needed).
// Usage: node scripts/mock-openai.mjs [port]   (default 4141)
// Then add a provider in Cat-AgentUI: type=openai, baseUrl=http://127.0.0.1:4141/v1, any key.
import http from 'node:http';

const PORT = Number(process.argv[2] || 4141);

// 1x1 orange PNG
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
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
      data: Array.from({ length: body.n || 1 }, () => ({ b64_json: TINY_PNG })),
      usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
}).listen(PORT, '127.0.0.1', () => console.log(`mock-openai on http://127.0.0.1:${PORT}/v1`));
