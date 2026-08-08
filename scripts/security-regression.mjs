// Isolated end-to-end regression for the resource/security boundaries added to
// Cat-AgentUI. It uses only loopback listeners and a temporary DATA_DIR.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-security-'));
const children = [];

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.push(child);
  return child;
}

async function stopChildren() {
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  })));
}

async function waitForHealth(base, child) {
  let lastError = '';
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (${child.exitCode}): ${lastError}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server did not become ready: ${lastError}`);
}

function cookieOf(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function run() {
  const [appPort, mockPort] = await Promise.all([freePort(), freePort()]);
  const base = `http://127.0.0.1:${appPort}`;

  const mock = start(process.execPath, ['scripts/mock-openai.mjs', String(mockPort)]);
  const app = start(process.execPath, ['server/dist/index.js'], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      COOKIE_SECURE: 'false',
      MAX_USER_UPLOAD_MB: '20',
      MAX_USER_IMAGE_MB: '40',
      MAX_TOTAL_STORAGE_MB: '100',
      MAX_MESSAGE_ATTACHMENT_MB: '10',
      PASSWORD_CONCURRENCY: '1',
      PASSWORD_QUEUE_MAX: '2',
    },
  });
  let appLogs = '';
  app.stderr.on('data', (chunk) => { appLogs += chunk.toString(); });
  app.stdout.on('data', (chunk) => { appLogs += chunk.toString(); });
  mock.stderr.resume();
  mock.stdout.resume();
  await waitForHealth(base, app).catch((err) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${appLogs}`);
  });

  async function jsonReq(method, route, body, cookie) {
    const res = await fetch(base + route, {
      method,
      headers: {
        'x-csrf': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})), cookie: cookieOf(res) };
  }

  async function upload(bytes, cookie) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'test.png');
    const res = await fetch(`${base}/api/uploads`, {
      method: 'POST', headers: { 'x-csrf': '1', cookie }, body: form,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  async function stream(chatId, content, modelId, cookie) {
    const res = await fetch(`${base}/api/chats/${chatId}/stream`, {
      method: 'POST',
      headers: { 'x-csrf': '1', 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content, modelId }),
    });
    return { status: res.status, text: await res.text() };
  }

  const adminReg = await jsonReq('POST', '/api/auth/register', {
    username: 'admin', password: 'password-123',
  });
  assert(adminReg.status === 200 && adminReg.json.user.role === 'admin', 'admin registration');
  const adminCookie = adminReg.cookie;

  const createdUser = await jsonReq('POST', '/api/admin/users', {
    username: 'alice', password: 'password-123', role: 'user',
  }, adminCookie);
  assert(createdUser.status === 200, 'create user');
  const userId = createdUser.json.user.id;

  const provider = await jsonReq('POST', '/api/admin/providers', {
    name: 'mock', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'test',
  }, adminCookie);
  assert(provider.status === 200, 'create provider');
  await jsonReq('POST', '/api/admin/models', {
    providerId: provider.json.id,
    models: [
      { modelId: 'mock-gpt', displayName: 'Mock GPT', vision: true, tools: true, imageGen: false },
      { modelId: 'mock-image', displayName: 'Mock Image', vision: true, tools: false, imageGen: true },
    ],
  }, adminCookie);
  const providers = await jsonReq('GET', '/api/admin/providers', undefined, adminCookie);
  const configured = providers.json.find((item) => item.id === provider.json.id);
  const textModel = configured.models.find((item) => item.modelId === 'mock-gpt');
  const imageModel = configured.models.find((item) => item.modelId === 'mock-image');
  assert(textModel && imageModel, 'model ids');

  const mcp = await jsonReq('POST', '/api/admin/mcp', {
    name: 'mock-tools', transport: 'stdio', command: process.execPath,
    args: [path.join(root, 'scripts', 'mock-mcp.mjs')], enabled: true, allowedUserIds: [],
  }, adminCookie);
  assert(mcp.status === 200, 'create MCP');

  const login = await jsonReq('POST', '/api/auth/login', {
    username: 'alice', password: 'password-123',
  });
  assert(login.status === 200, 'user login');
  const userCookie = login.cookie;

  let listed = await jsonReq('GET', '/api/mcp/servers', undefined, userCookie);
  assert(listed.status === 200 && listed.json.length === 0, 'MCP hidden before grant');
  const chat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const chatId = chat.json.chat.id;
  let bound = await jsonReq('PATCH', `/api/chats/${chatId}`, {
    mcpServerIds: [mcp.json.id],
  }, userCookie);
  assert(bound.status === 403, 'MCP bind denied before grant');

  await jsonReq('PATCH', `/api/admin/mcp/${mcp.json.id}`, {
    allowedUserIds: [userId],
  }, adminCookie);
  listed = await jsonReq('GET', '/api/mcp/servers', undefined, userCookie);
  assert(listed.json.some((item) => item.id === mcp.json.id), 'MCP visible after grant');
  bound = await jsonReq('PATCH', `/api/chats/${chatId}`, {
    mcpServerIds: [mcp.json.id],
  }, userCookie);
  assert(bound.status === 200, 'MCP bind after grant');
  const toolTurn = await stream(chatId, [{ type: 'text', text: 'use_tool' }], textModel.id, userCookie);
  assert(toolTurn.status === 200 && toolTurn.text.includes('event: tool_result'), 'authorized tool call');

  await jsonReq('PATCH', `/api/admin/mcp/${mcp.json.id}`, { allowedUserIds: [] }, adminCookie);
  const revokedTurn = await stream(chatId, [{ type: 'text', text: 'use_tool again' }], textModel.id, userCookie);
  assert(revokedTurn.status === 200
    && !revokedTurn.text.includes('event: tool_result')
    && revokedTurn.text.includes('event: notice'), 'revocation enforced on existing chat');

  const pngSig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0]);
  const small = await upload(pngSig, userCookie);
  assert(small.status === 200, 'small upload');
  const repeated = Array.from({ length: 19 }, () => ({ type: 'image', uploadId: small.json.id }));
  repeated.push({ type: 'text', text: 'dedupe these' });
  const dedupeTurn = await stream(chatId, repeated, textModel.id, userCookie);
  assert(dedupeTurn.status === 200, 'dedupe stream');
  const chatAfter = await jsonReq('GET', `/api/chats/${chatId}`, undefined, userCookie);
  const lastUser = [...chatAfter.json.messages].reverse().find((message) => message.role === 'user');
  assert(lastUser.parts.filter((part) => part.type === 'image').length === 1, 'attachment dedupe');

  const fakePng = (size) => {
    const bytes = new Uint8Array(size);
    bytes.set(pngSig.subarray(0, 8));
    return bytes;
  };
  const large1 = await upload(fakePng(11 * 1024 * 1024), userCookie);
  const large2 = await upload(fakePng(11 * 1024 * 1024), userCookie);
  assert(large1.status === 200 && large2.status === 413, 'upload storage quota');
  const overBudgetTurn = await stream(chatId, [
    { type: 'image', uploadId: large1.json.id },
    { type: 'text', text: 'too large for one turn' },
  ], textModel.id, userCookie);
  assert(overBudgetTurn.status === 413, 'per-message attachment budget');
  const overTextTurn = await stream(chatId, [
    { type: 'text', text: 'x'.repeat(64_001) },
  ], textModel.id, userCookie);
  assert(overTextTurn.status === 400, 'per-message text budget');

  const imageBody = { modelId: imageModel.id, prompt: 'a cat', n: 1 };
  const imageResults = await Promise.all([
    jsonReq('POST', '/api/images/generate', imageBody, userCookie),
    jsonReq('POST', '/api/images/generate', imageBody, userCookie),
  ]);
  assert(imageResults.some((item) => item.status === 200)
    && imageResults.some((item) => item.status === 429), 'image concurrency gate');

  const deletedChat = await jsonReq('DELETE', `/api/chats/${chatId}`, undefined, userCookie);
  assert(deletedChat.status === 200, 'delete chat');
  const deletedAttachment = await fetch(`${base}/api/uploads/${small.json.id}/file`, {
    headers: { cookie: userCookie },
  });
  assert(deletedAttachment.status === 404, 'unreferenced attachment cleanup');

  const wrongLogins = Array.from({ length: 8 }, () => jsonReq('POST', '/api/auth/login', {
    username: 'alice', password: 'wrong-password',
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = performance.now();
  const health = await fetch(`${base}/api/health`);
  const healthMs = performance.now() - started;
  const wrongResults = await Promise.all(wrongLogins);
  assert(wrongResults.some((item) => item.status === 503), 'password queue bound');
  assert(health.ok && healthMs < 200, `password queue blocked event loop (${healthMs.toFixed(1)}ms)`);

  return {
    mcpAcl: 'pass',
    mcpRevocation: 'pass',
    attachmentDedupe: 'pass',
    attachmentBudget: 'pass',
    attachmentCleanup: 'pass',
    storageQuota: 'pass',
    imageConcurrency: 'pass',
    passwordQueue: 'pass',
    healthDuringEightScryptsMs: Number(healthMs.toFixed(1)),
  };
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await stopChildren();
  const expectedPrefix = path.join(os.tmpdir(), 'cat-agentui-security-');
  if (dataDir.startsWith(expectedPrefix)) fs.rmSync(dataDir, { recursive: true, force: true });
}
