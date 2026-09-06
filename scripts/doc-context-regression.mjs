// A document uploaded early in a long chat must still reach the model after
// the replay window has moved past it (the "it forgot my file" complaint).
// Runs the built server against the mock provider with a 3-message window so
// the case is cheap to produce. Loopback only, temporary DATA_DIR.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-agentui-context-'));
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
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
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

async function waitForHealth(base, child, logs) {
  let lastError = '';
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${logs()}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready: ${lastError}\n${logs()}`);
}

function cookieOf(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function run() {
  const [appPort, mockPort] = await Promise.all([freePort(), freePort()]);
  const base = `http://127.0.0.1:${appPort}`;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  const mock = start(process.execPath, ['scripts/mock-openai.mjs', String(mockPort)]);
  mock.stdout.resume(); mock.stderr.resume();
  const app = start(process.execPath, ['server/dist/index.js'], {
    env: {
      ...process.env,
      DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(appPort),
      SECRET_KEY: 'CONTEXT_TEST_SECRET_1f3a', COOKIE_SECURE: 'false',
      // The whole point: a window small enough that turn 1 falls out by turn 4.
      MAX_CONTEXT_MESSAGES: '3',
    },
  });
  let appLogs = '';
  app.stdout.on('data', (c) => { appLogs += c.toString(); });
  app.stderr.on('data', (c) => { appLogs += c.toString(); });
  await waitForHealth(base, app, () => appLogs);

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
  async function uploadText(text, name, cookie) {
    const form = new FormData();
    form.append('file', new Blob([text], { type: 'text/plain' }), name);
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-csrf': '1', cookie }, body: form });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  async function stream(chatId, body, cookie) {
    const res = await fetch(`${base}/api/chats/${chatId}/stream`, {
      method: 'POST',
      headers: { 'x-csrf': '1', 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }
  // The newest provider request whose final user message says `text` — the
  // turn itself, not the title / follow-up calls that trail it.
  const contentText = (m) => (typeof m?.content === 'string'
    ? m.content : (m?.content ?? []).map((p) => p.text ?? '').join('\n'));
  async function requestFor(text) {
    const all = await (await fetch(`${mockBase}/__requests`)).json();
    const hit = [...all].reverse().find((r) => {
      const last = (r.messages ?? []).at(-1);
      return last?.role === 'user' && contentText(last).includes(text);
    });
    assert(hit, `no provider request ended with "${text}"`);
    return hit;
  }
  const sentText = (req) => JSON.stringify(req?.messages ?? []);
  const userTurns = (req) => (req?.messages ?? []).filter((m) => m.role === 'user').length;

  const reg = await jsonReq('POST', '/api/auth/register', { username: 'admin', password: 'password-123' });
  assert(reg.status === 200, 'admin registration');
  const cookie = reg.cookie;
  const provider = await jsonReq('POST', '/api/admin/providers', {
    name: 'mock', type: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock',
  }, cookie);
  assert(provider.status === 200, 'create provider');
  await jsonReq('POST', '/api/admin/models', {
    providerId: provider.json.id,
    models: [{ modelId: 'mock-gpt', displayName: 'Mock GPT', vision: true, tools: true, imageGen: false }],
  }, cookie);
  const providers = await jsonReq('GET', '/api/admin/providers', undefined, cookie);
  const model = providers.json.find((p) => p.id === provider.json.id).models.find((m) => m.modelId === 'mock-gpt');
  assert(model, 'model id');

  const MARK = 'CONTRACT-MARK-7f3e9a';
  const doc = await uploadText(`合同编号 ${MARK}\n甲方:测试公司\n乙方:另一家公司\n付款条款:30 天。`, 'contract.txt', cookie);
  assert(doc.status === 200 && doc.json.id, `upload text doc (${doc.status} ${JSON.stringify(doc.json)})`);

  const chat = await jsonReq('POST', '/api/chats', { modelId: model.id }, cookie);
  const chatId = chat.json.chat.id;
  const turn1 = await stream(chatId, {
    modelId: model.id,
    content: [{ type: 'text', text: '请记住这份合同' }, { type: 'file', uploadId: doc.json.id }],
  }, cookie);
  assert(turn1.status === 200 && !turn1.text.includes('event: error'), 'turn 1 with the document');
  const req1 = await requestFor('请记住这份合同');
  assert(sentText(req1).includes(MARK) && !sentText(req1).includes('早前上传'),
    'turn 1 sends the document in place');

  for (const n of [2, 3, 4]) {
    const t = await stream(chatId, { modelId: model.id, content: [{ type: 'text', text: `hello ${n}` }] }, cookie);
    assert(t.status === 200 && !t.text.includes('event: error'), `turn ${n}`);
  }
  const req4 = await requestFor('hello 4');
  assert(userTurns(req4) <= 2, `window really is small (${userTurns(req4)} user turns)`);
  assert(sentText(req4).includes(MARK) && sentText(req4).includes('早前上传的附件'),
    `document carried past the window — sent: ${sentText(req4).slice(0, 1500)}`);
  const firstUser = (req4.messages ?? []).find((m) => m.role === 'user');
  assert(contentText(firstUser).includes(MARK), 'carried document rides on the oldest user turn in the window');

  // Regenerating the latest reply takes the same road.
  const saved = await jsonReq('GET', `/api/chats/${chatId}`, undefined, cookie);
  const lastReply = [...saved.json.messages].reverse().find((m) => m.role === 'assistant');
  const regen = await stream(chatId, { modelId: model.id, regenerateMessageId: lastReply.id }, cookie);
  assert(regen.status === 200 && !regen.text.includes('event: error'), 'regenerate');
  const all = await (await fetch(`${mockBase}/__requests`)).json();
  const hello4Turns = all.filter((r) => { const l = (r.messages ?? []).at(-1); return l?.role === 'user' && contentText(l).includes('hello 4'); });
  assert(hello4Turns.length >= 2, 'regenerate produced a second request for the same turn');
  const reqR = hello4Turns.at(-1);
  assert(sentText(reqR).includes(MARK), 'document carried on regenerate');

  // A document the window still contains is not duplicated by the carry.
  const chat2 = await jsonReq('POST', '/api/chats', { modelId: model.id }, cookie);
  const t21 = await stream(chat2.json.chat.id, {
    modelId: model.id,
    content: [{ type: 'text', text: 'first' }, { type: 'file', uploadId: doc.json.id }],
  }, cookie);
  assert(t21.status === 200, 'chat 2 turn 1');
  const t22 = await stream(chat2.json.chat.id, { modelId: model.id, content: [{ type: 'text', text: 'second' }] }, cookie);
  assert(t22.status === 200, 'chat 2 turn 2');
  const req22 = await requestFor('second');
  assert(sentText(req22).split(MARK).length === 2 && !sentText(req22).includes('早前上传'),
    'in-window document appears exactly once, uncarried');

  return { documentInPlace: 'pass', documentCarriedPastWindow: 'pass', documentCarriedOnRegenerate: 'pass', noDuplicateCarry: 'pass' };
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await stopChildren();
  const expectedPrefix = path.join(os.tmpdir(), 'cat-agentui-context-');
  if (dataDir.startsWith(expectedPrefix)) fs.rmSync(dataDir, { recursive: true, force: true });
}
