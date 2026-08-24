// Isolated end-to-end regression for the resource/security boundaries added to
// Cat-AgentUI. It uses only loopback listeners and a temporary DATA_DIR.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-security-'));
const viteFsProbe = path.join(root, 'data', `vite-fs-probe-${process.pid}-${Date.now()}.txt`);
const webRequire = createRequire(path.join(root, 'web', 'package.json'));
const Database = webRequire('better-sqlite3');
const viteCli = path.join(path.dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js');
const katexFonts = path.join(path.dirname(webRequire.resolve('katex/package.json')), 'dist', 'fonts');
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

async function waitForUrl(url, child) {
  let lastError = '';
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early (${child.exitCode}): ${lastError}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server did not become ready: ${lastError}`);
}

function viteFsUrl(base, filePath) {
  const normalized = filePath.split(path.sep).join('/').replace(/^\/+/, '');
  return `${base}/@fs/${encodeURI(normalized)}`;
}

function cookieOf(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function run() {
  const [appPort, mockPort, vitePort] = await Promise.all([freePort(), freePort(), freePort()]);
  const base = `http://127.0.0.1:${appPort}`;
  const viteBase = `http://127.0.0.1:${vitePort}`;
  const providerKey = 'PROVIDER_KEY_CANARY_d87f2f37';
  const providerKeyPrefix = providerKey.slice(0, 12);
  const providerKeyTail = providerKey.slice(12);
  const providerHeader = 'PROVIDER_HEADER_CANARY_90acfb31';
  const mcpEnvSecret = 'MCP_ENV_CANARY_16ed8ac2';
  const mcpHeaderSecret = 'MCP_HEADER_CANARY_8fc046f1';
  const appSecret = 'APP_SECRET_CANARY_22a753f8';
  const legacyHeaderSecret = 'LEGACY_HEADER_CANARY_734f01a9';
  const secretCanaries = [
    providerKey, providerKeyTail, providerHeader, mcpEnvSecret, mcpHeaderSecret,
    appSecret, legacyHeaderSecret,
  ];

  fs.mkdirSync(path.dirname(viteFsProbe), { recursive: true });
  fs.writeFileSync(viteFsProbe, 'Vite filesystem isolation probe\n', { flag: 'wx' });

  const vite = start(process.execPath, [
    viteCli,
    '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort',
  ], {
    cwd: path.join(root, 'web'),
    env: { ...process.env, DEV_PROXY_HOST: '' },
  });
  let viteLogs = '';
  vite.stderr.on('data', (chunk) => { viteLogs += chunk.toString(); });
  vite.stdout.on('data', (chunk) => { viteLogs += chunk.toString(); });
  await waitForUrl(`${viteBase}/`, vite).catch((err) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${viteLogs}`);
  });

  const allowedViteFiles = [
    path.join(root, 'web', 'src', 'main.tsx'),
    path.join(root, 'web', 'src', 'index.css'),
    path.join(katexFonts, 'KaTeX_Main-Regular.woff2'),
  ];
  for (const filePath of allowedViteFiles) {
    const res = await fetch(viteFsUrl(viteBase, filePath));
    assert(res.status === 200, `Vite should serve ${filePath} (${res.status})`);
  }

  const deniedViteFiles = [
    viteFsProbe,
    path.join(root, 'package.json'),
    path.join(root, 'server', 'src', 'index.ts'),
    path.join(root, 'node_modules', 'katex', 'LICENSE'),
  ];
  const workspaceServerPath = path.join(
    root, 'node_modules', '@cat-agentui', 'server', 'src', 'index.ts',
  );
  if (fs.existsSync(workspaceServerPath)) deniedViteFiles.push(workspaceServerPath);
  for (const filePath of deniedViteFiles) {
    const res = await fetch(viteFsUrl(viteBase, filePath));
    assert(res.status === 403, `Vite exposed ${filePath} (${res.status})`);
  }

  const mock = start(process.execPath, ['scripts/mock-openai.mjs', String(mockPort)]);
  const appEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: String(appPort),
    SECRET_KEY: appSecret,
    COOKIE_SECURE: 'false',
    MAX_USER_UPLOAD_MB: '20',
    MAX_USER_IMAGE_MB: '40',
    MAX_TOTAL_STORAGE_MB: '100',
    MAX_MESSAGE_ATTACHMENT_MB: '10',
    DEFAULT_MODEL_OUTPUT_TOKENS: '256',
    MAX_MODEL_OUTPUT_TOKENS: '1024',
    MAX_TURN_OUTPUT_CHARS: '1000',
    CHAT_TURN_TIMEOUT_SECONDS: '3',
    CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS: '1',
    PASSWORD_CONCURRENCY: '1',
    PASSWORD_QUEUE_MAX: '2',
  };
  const app = start(process.execPath, ['server/dist/index.js'], { env: appEnv });
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
  const bootstrapAfterSetup = await jsonReq('GET', '/api/auth/bootstrap');
  assert(bootstrapAfterSetup.status === 200 && bootstrapAfterSetup.json.signupEnabled === false,
    'registration defaults closed after setup');
  const blockedRegistration = await jsonReq('POST', '/api/auth/register', {
    username: 'unexpected', password: 'password-123',
  });
  assert(blockedRegistration.status === 403, 'public registration blocked by default');

  const createdUser = await jsonReq('POST', '/api/admin/users', {
    username: 'alice', password: 'password-123', role: 'user',
  }, adminCookie);
  assert(createdUser.status === 200, 'create user');
  const userId = createdUser.json.user.id;

  const provider = await jsonReq('POST', '/api/admin/providers', {
    name: 'mock', type: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    apiKey: providerKey,
    // The shorter value deliberately prefixes the API key; streaming
    // redaction must not reveal the longer key's tail at a chunk boundary.
    extraHeaders: {
      'x-audit-secret': providerHeader,
      'x-prefix-secret': providerKeyPrefix,
    },
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
  assert(!secretCanaries.some((secret) => JSON.stringify(providers.json).includes(secret)),
    'provider secrets are write-only');
  const configured = providers.json.find((item) => item.id === provider.json.id);
  assert(configured.hasKey && configured.hasExtraHeaders
    && configured.extraHeaderKeys.includes('x-audit-secret')
    && configured.extraHeaderKeys.includes('x-prefix-secret'), 'provider secret metadata');
  const preservedProvider = await jsonReq('PATCH', `/api/admin/providers/${provider.json.id}`, {
    extraHeaders: { 'x-empty-header': '' },
    preserveExtraHeaderKeys: ['x-audit-secret', 'x-prefix-secret'],
  }, adminCookie);
  assert(preservedProvider.status === 200
    && preservedProvider.json.extraHeaderKeys.includes('x-audit-secret')
    && preservedProvider.json.extraHeaderKeys.includes('x-prefix-secret')
    && preservedProvider.json.extraHeaderKeys.includes('x-empty-header')
    && !secretCanaries.some((secret) => JSON.stringify(preservedProvider.json).includes(secret)),
  'write-only provider headers preserve/replace semantics');
  const textModel = configured.models.find((item) => item.modelId === 'mock-gpt');
  const imageModel = configured.models.find((item) => item.modelId === 'mock-image');
  assert(textModel && imageModel, 'model ids');

  const mcp = await jsonReq('POST', '/api/admin/mcp', {
    name: 'mock-tools', transport: 'stdio', command: process.execPath,
    args: [path.join(root, 'scripts', 'mock-mcp.mjs')],
    env: { MOCK_MCP_SECRET: mcpEnvSecret }, enabled: true,
    accessMode: 'restricted', allowedUserIds: [],
  }, adminCookie);
  assert(mcp.status === 200, 'create MCP');

  const login = await jsonReq('POST', '/api/auth/login', {
    username: 'alice', password: 'password-123',
  });
  assert(login.status === 200, 'user login');
  const userCookie = login.cookie;
  const forwardedHttpsLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'x-csrf': '1', 'x-forwarded-proto': 'https', 'content-type': 'application/json',
    },
    body: JSON.stringify({ username: 'alice', password: 'password-123' }),
  });
  assert(forwardedHttpsLogin.status === 200
    && /;\s*Secure(?:;|$)/i.test(forwardedHttpsLogin.headers.get('set-cookie') || ''),
  'HTTPS proxy session cookie is Secure');

  // Provider text and error bodies are attacker-controlled. Neither whole nor
  // cross-chunk echoes of request credentials may reach SSE or saved history.
  const echoChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const echoTurn = await stream(echoChat.json.chat.id, [
    { type: 'text', text: 'echo_auth_content' },
  ], textModel.id, userCookie);
  assert(echoTurn.status === 200
    && !secretCanaries.some((secret) => echoTurn.text.includes(secret))
    && echoTurn.text.includes('敏感信息已隐藏'), 'provider streamed secret redaction');
  let echoSaved = await jsonReq('GET', `/api/chats/${echoChat.json.chat.id}`, undefined, userCookie);
  assert(!secretCanaries.some((secret) => JSON.stringify(echoSaved.json).includes(secret)),
    'provider streamed secret not persisted');
  const errorTurn = await stream(echoChat.json.chat.id, [
    { type: 'text', text: 'echo_auth_error' },
  ], textModel.id, userCookie);
  assert(errorTurn.status === 200 && errorTurn.text.includes('event: error')
    && !secretCanaries.some((secret) => errorTurn.text.includes(secret)),
  'provider error secret redaction');
  echoSaved = await jsonReq('GET', `/api/chats/${echoChat.json.chat.id}`, undefined, userCookie);
  assert(!secretCanaries.some((secret) => JSON.stringify(echoSaved.json).includes(secret)),
    'provider error secret not persisted');
  await jsonReq('DELETE', `/api/chats/${echoChat.json.chat.id}`, undefined, userCookie);

  // A remote MCP handshake can also reflect its Authorization header.
  const remoteMcp = await jsonReq('POST', '/api/admin/mcp', {
    name: 'remote-secret-probe', transport: 'http',
    url: `http://127.0.0.1:${mockPort}/mcp-leak`,
    headers: { authorization: `Bearer ${mcpHeaderSecret}` },
    accessMode: 'restricted', allowedUserIds: [userId], enabled: true,
  }, adminCookie);
  assert(remoteMcp.status === 200, 'create remote MCP secret probe');
  const remoteChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  await jsonReq('PATCH', `/api/chats/${remoteChat.json.chat.id}`, {
    mcpServerIds: [remoteMcp.json.id],
  }, userCookie);
  const remoteTurn = await stream(remoteChat.json.chat.id, [
    { type: 'text', text: 'ordinary request' },
  ], textModel.id, userCookie);
  assert(remoteTurn.status === 200 && remoteTurn.text.includes('event: notice')
    && !remoteTurn.text.includes(mcpHeaderSecret), 'MCP connection error secret redaction');
  await jsonReq('DELETE', `/api/chats/${remoteChat.json.chat.id}`, undefined, userCookie);

  const adminMcpList = await jsonReq('GET', '/api/admin/mcp', undefined, adminCookie);
  assert(!secretCanaries.some((secret) => JSON.stringify(adminMcpList.json).includes(secret)),
    'MCP secrets and saved errors are write-only');

  // At rest, Provider custom headers and all MCP credentials are ciphertext.
  const auditDb = new Database(path.join(dataDir, 'cat-agentui.db'), { readonly: true, fileMustExist: true });
  const providerAtRest = auditDb.prepare(
    'select extra_headers legacy, extra_headers_enc encrypted from providers where id = ?',
  ).get(provider.json.id);
  const mcpAtRest = auditDb.prepare(
    'select env_enc, headers_enc from mcp_servers where id in (?, ?)',
  ).all(mcp.json.id, remoteMcp.json.id);
  auditDb.close();
  assert(providerAtRest.legacy === '{}' && providerAtRest.encrypted
    && !providerAtRest.encrypted.includes(providerHeader), 'provider headers encrypted at rest');
  assert(mcpAtRest.length === 2 && !secretCanaries.some((secret) => JSON.stringify(mcpAtRest).includes(secret)),
    'MCP secrets encrypted at rest');
  assert((fs.statSync(dataDir).mode & 0o777) === 0o700
    && (fs.statSync(path.join(dataDir, 'cat-agentui.db')).mode & 0o777) === 0o600,
  'secret-bearing storage permissions');
  await jsonReq('DELETE', `/api/admin/mcp/${remoteMcp.json.id}`, undefined, adminCookie);

  const limitChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const limitTurn = await stream(limitChat.json.chat.id, [
    { type: 'text', text: 'check_output_limit' },
  ], textModel.id, userCookie);
  assert(limitTurn.status === 200 && limitTurn.text.includes('max_tokens:256'),
    'default model output token limit sent');
  await jsonReq('DELETE', `/api/chats/${limitChat.json.chat.id}`, undefined, userCookie);

  const longChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const longTurn = await stream(longChat.json.chat.id, [
    { type: 'text', text: 'long_output' },
  ], textModel.id, userCookie);
  assert(longTurn.status === 200 && longTurn.text.includes('event: error')
    && longTurn.text.includes('1000'), 'turn output character budget');
  await jsonReq('DELETE', `/api/chats/${longChat.json.chat.id}`, undefined, userCookie);

  const idleChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const idleStarted = performance.now();
  const idleTurn = await stream(idleChat.json.chat.id, [
    { type: 'text', text: 'stall_provider' },
  ], textModel.id, userCookie);
  const idleMs = performance.now() - idleStarted;
  assert(idleTurn.status === 200 && idleTurn.text.includes('event: error')
    && idleTurn.text.includes('没有返回数据') && idleMs < 2500, 'provider idle timeout');
  await jsonReq('DELETE', `/api/chats/${idleChat.json.chat.id}`, undefined, userCookie);

  const timeoutChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const timeoutStarted = performance.now();
  const timeoutTurn = await stream(timeoutChat.json.chat.id, [
    { type: 'text', text: 'slow_stream' },
  ], textModel.id, userCookie);
  const timeoutMs = performance.now() - timeoutStarted;
  assert(timeoutTurn.status === 200 && timeoutTurn.text.includes('event: error')
    && timeoutTurn.text.includes('总时限') && timeoutMs < 4500, 'chat turn total timeout');
  await jsonReq('DELETE', `/api/chats/${timeoutChat.json.chat.id}`, undefined, userCookie);

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
  const toolTurn = await stream(chatId, [{ type: 'text', text: 'use_tool leak_env' }], textModel.id, userCookie);
  assert(toolTurn.status === 200 && toolTurn.text.includes('event: tool_result')
    && toolTurn.text.includes('敏感信息已隐藏') && !toolTurn.text.includes(mcpEnvSecret),
  'authorized tool call secret redaction');
  const toolSaved = await jsonReq('GET', `/api/chats/${chatId}`, undefined, userCookie);
  assert(!JSON.stringify(toolSaved.json).includes(mcpEnvSecret), 'MCP secret not persisted');

  // A hostile Provider can place its request credential in tool-call metadata
  // or arguments. Redact before the call reaches MCP, SSE, or persistence.
  const argChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  await jsonReq('PATCH', `/api/chats/${argChat.json.chat.id}`, {
    mcpServerIds: [mcp.json.id],
  }, userCookie);
  const argTurn = await stream(argChat.json.chat.id, [
    { type: 'text', text: 'use_tool tool_arg_auth' },
  ], textModel.id, userCookie);
  assert(argTurn.status === 200 && argTurn.text.includes('event: tool_result')
    && argTurn.text.includes('敏感信息已隐藏') && !argTurn.text.includes(providerKey),
  'tool-call credential redaction');
  const argSaved = await jsonReq('GET', `/api/chats/${argChat.json.chat.id}`, undefined, userCookie);
  assert(!JSON.stringify(argSaved.json).includes(providerKey), 'tool-call credential not persisted');
  await jsonReq('DELETE', `/api/chats/${argChat.json.chat.id}`, undefined, userCookie);

  await jsonReq('PATCH', `/api/admin/mcp/${mcp.json.id}`, { allowedUserIds: [] }, adminCookie);
  const revokedTurn = await stream(chatId, [{ type: 'text', text: 'use_tool again' }], textModel.id, userCookie);
  assert(revokedTurn.status === 200
    && !revokedTurn.text.includes('event: tool_result')
    && revokedTurn.text.includes('event: notice'), 'revocation enforced on existing chat');

  await jsonReq('PATCH', `/api/admin/mcp/${mcp.json.id}`, {
    accessMode: 'shared',
  }, adminCookie);
  listed = await jsonReq('GET', '/api/mcp/servers', undefined, userCookie);
  assert(listed.json.some((item) => item.id === mcp.json.id), 'shared MCP visible to regular user');
  const sharedChat = await jsonReq('POST', '/api/chats', { modelId: textModel.id }, userCookie);
  const sharedChatId = sharedChat.json.chat.id;
  const sharedBound = await jsonReq('PATCH', `/api/chats/${sharedChatId}`, {
    mcpServerIds: [mcp.json.id],
  }, userCookie);
  assert(sharedBound.status === 200, 'shared MCP bind');
  const sharedTurn = await stream(sharedChatId, [{ type: 'text', text: 'use_tool shared' }], textModel.id, userCookie);
  assert(sharedTurn.status === 200 && sharedTurn.text.includes('event: tool_result'), 'shared MCP tool call');
  await jsonReq('DELETE', `/api/chats/${sharedChatId}`, undefined, userCookie);

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
  // Image access is default-deny per user; the gate below only makes sense
  // after an explicit admin grant.
  const ungrantedImage = await jsonReq('POST', '/api/images/generate', imageBody, userCookie);
  assert(ungrantedImage.status === 403, 'image generation denied without grant');
  const grantImages = await jsonReq('PATCH', `/api/admin/users/${userId}`, {
    allowImages: true, allowImageModels: true,
  }, adminCookie);
  assert(grantImages.status === 200, 'grant image permissions');
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
  assert(!secretCanaries.some((secret) => appLogs.includes(secret)), 'secrets absent from app logs');

  // Simulate a pre-0012 plaintext custom-header row, then prove the next start
  // encrypts it and truncates WAL frames containing the old value.
  await new Promise((resolve) => {
    if (app.exitCode !== null) return resolve();
    app.once('exit', resolve);
    app.kill('SIGTERM');
  });
  const legacyDb = new Database(path.join(dataDir, 'cat-agentui.db'));
  legacyDb.prepare(
    'update providers set extra_headers = ?, extra_headers_enc = null where id = ?',
  ).run(JSON.stringify({ 'x-legacy-secret': legacyHeaderSecret }), provider.json.id);
  legacyDb.prepare('update chats set title = ? where id = ?')
    .run(`legacy echo ${legacyHeaderSecret}`, chatId);
  legacyDb.prepare('update messages set error = ? where chat_id = ?')
    .run(`legacy error authorization=Bearer ${legacyHeaderSecret}`, chatId);
  legacyDb.close();

  const restarted = start(process.execPath, ['server/dist/index.js'], { env: appEnv });
  let restartedLogs = '';
  restarted.stderr.on('data', (chunk) => { restartedLogs += chunk.toString(); });
  restarted.stdout.on('data', (chunk) => { restartedLogs += chunk.toString(); });
  await waitForHealth(base, restarted).catch((err) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${restartedLogs}`);
  });
  const migratedDb = new Database(path.join(dataDir, 'cat-agentui.db'), {
    readonly: true, fileMustExist: true,
  });
  const migratedHeader = migratedDb.prepare(
    'select extra_headers legacy, extra_headers_enc encrypted from providers where id = ?',
  ).get(provider.json.id);
  migratedDb.close();
  assert(migratedHeader.legacy === '{}' && migratedHeader.encrypted
    && !migratedHeader.encrypted.includes(legacyHeaderSecret), 'legacy provider header migration');
  const legacyEchoCount = new Database(path.join(dataDir, 'cat-agentui.db'), {
    readonly: true, fileMustExist: true,
  });
  const leakedRows = legacyEchoCount.prepare(
    'select (select count(*) from chats where title like ?) + (select count(*) from messages where error like ?) total',
  ).get(`%${legacyHeaderSecret}%`, `%${legacyHeaderSecret}%`);
  legacyEchoCount.close();
  assert(Number(leakedRows.total) === 0, 'legacy persisted secret echoes scrubbed');
  assert(!secretCanaries.some((secret) => restartedLogs.includes(secret)),
    'secrets absent from restart logs');
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(dataDir, `cat-agentui.db${suffix}`);
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file).toString('latin1');
    assert(!secretCanaries.some((secret) => bytes.includes(secret)),
      `plaintext secret found in SQLite${suffix || ' main file'}`);
  }

  return {
    viteFsIsolation: 'pass',
    providerSecretRedaction: 'pass',
    mcpSecretRedaction: 'pass',
    encryptedCustomHeaders: 'pass',
    legacyHeaderMigration: 'pass',
    secretFilePermissions: 'pass',
    secureProxyCookie: 'pass',
    mcpAcl: 'pass',
    mcpRevocation: 'pass',
    mcpSharedAccess: 'pass',
    registrationDefaultClosed: 'pass',
    defaultOutputTokenLimit: 'pass',
    turnOutputBudget: 'pass',
    providerIdleTimeout: 'pass',
    chatTurnTimeout: 'pass',
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
  fs.rmSync(viteFsProbe, { force: true });
  const expectedPrefix = path.join(os.tmpdir(), 'cat-agentui-security-');
  if (dataDir.startsWith(expectedPrefix)) fs.rmSync(dataDir, { recursive: true, force: true });
}
