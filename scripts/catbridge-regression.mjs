import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

const dir = await mkdtemp(join(tmpdir(), 'catbridge-panel-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const base = `http://127.0.0.1:${port}`;
let cookie = '';
let logs = '';
let peer;
const app = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: resolve('.'),
  env: {
    ...process.env,
    DATA_DIR: dir,
    SECRET_KEY: 'catbridge-regression-only',
    HOST: '127.0.0.1',
    PORT: String(port),
    COOKIE_SECURE: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => (logs += d));
app.stderr.on('data', (d) => (logs += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, path, body, auth = cookie) {
  const res = await fetch(base + path, {
    method,
    headers: {
      cookie: auth,
      'x-csrf': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return {
    status: res.status,
    data: await res.json(),
    cookie: res.headers.get('set-cookie')?.split(';')[0],
  };
}
async function connect(token) {
  const ws = new WebSocket(
    base.replace('http', 'ws') + '/api/catbridge/connect',
    { headers: { authorization: `Bearer ${token}` } },
  );
  const queue = [];
  ws.on('message', (d) => queue.push(JSON.parse(d)));
  await once(ws, 'open');
  ws.send(
    JSON.stringify({
      type: 'bridge.hello',
      version: 1,
      cliVersion: 'test fixture',
      model: 'fixture',
      capabilities: ['text', 'workspace'],
    }),
  );
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    async next(predicate) {
      for (let n = 0; n < 1000; n++) {
        const at = queue.findIndex(predicate);
        if (at >= 0) return queue.splice(at, 1)[0];
        await sleep(10);
      }
      throw new Error('等待桥接消息超时');
    },
  };
}
async function newChat(modelId, auth = cookie) {
  const r = await req('POST', '/api/chats', { modelId }, auth);
  assert.equal(r.status, 200);
  return r.data.chat.id;
}
async function stream(chatId, body, onEvent = async () => {}) {
  const res = await fetch(base + `/api/chats/${chatId}/stream`, {
    method: 'POST',
    headers: { cookie, 'x-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), ...body }),
  });
  const events = [];
  if (res.status !== 200)
    return { status: res.status, error: await res.json(), events };
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let n;
    while ((n = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, n);
      buffer = buffer.slice(n + 2);
      const match = /event: ([^\n]+)\ndata: ([^\n]+)/.exec(frame);
      if (match) {
        const e = { type: match[1], data: JSON.parse(match[2]) };
        events.push(e);
        await onEvent(e);
      }
    }
  }
  return { status: res.status, events };
}
const content = (text) => [{ type: 'text', text }];
async function accept(chatId, e, decision = 'allow') {
  if (e.type === 'tool_confirm') {
    const r = await req('POST', `/api/chats/${chatId}/tool-decision`, {
      messageId: e.data.messageId,
      decisions: Object.fromEntries(e.data.calls.map((c) => [c.id, decision])),
    });
    assert.equal(r.status, 200);
  }
}
function driver(turn) {
  let seq = 0;
  return {
    async tool(name, args, duplicate = false) {
      const toolCallId = randomUUID();
      const msg = {
        type: 'tool.call',
        runId: turn.runId,
        seq: ++seq,
        toolCallId,
        name,
        args,
      };
      peer.send(msg);
      if (duplicate) peer.send(msg);
      return (
        await peer.next(
          (m) => m.type === 'tool.result' && m.toolCallId === toolCallId,
        )
      ).result;
    },
    event(event, duplicate = false) {
      const m = { type: 'turn.event', runId: turn.runId, seq: ++seq, event };
      peer.send(m);
      if (duplicate) peer.send(m);
    },
    end(status = 'done') {
      peer.send({
        type: 'turn.end',
        runId: turn.runId,
        seq: ++seq,
        status,
        reason: 'stop',
      });
    },
  };
}
async function ready() {
  for (let i = 0; i < 200; i++) {
    if (
      await fetch(base + '/api/health')
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await sleep(50);
  }
  throw new Error(logs);
}
try {
  await ready();
  cookie = (
    await req('POST', '/api/auth/register', {
      username: 'admin',
      password: 'password-123',
    })
  ).cookie;
  const paired = await req('POST', '/api/admin/catbridge/pair', {});
  assert.equal(paired.status, 200);
  const { token, modelId } = paired.data;
  assert(
    !JSON.stringify((await req('GET', '/api/admin/catbridge')).data).includes(
      token,
    ),
  );
  assert((await req('GET', '/api/models')).data.some((m) => m.id === modelId));
  const chat = await newChat(modelId);
  assert.equal(
    (await stream(chat, { content: content('offline') })).status,
    503,
  );
  peer = await connect(token);
  await sleep(30);
  const turnPromise = stream(chat, { content: content('create marker') }, (e) =>
    accept(chat, e),
  );
  const first = await peer.next((m) => m.type === 'turn.start');
  const d = driver(first);
  assert.deepEqual(first.tools.map((t) => t.name).sort(), [
    'workspace_delete',
    'workspace_edit',
    'workspace_list',
    'workspace_read',
    'workspace_write',
  ]);
  assert.equal(
    (await stream(await newChat(modelId), { content: content('busy') })).status,
    409,
  );
  assert.equal(
    (
      await d.tool(
        'workspace_write',
        { path: 'marker.txt', content: 'ONE', chatId: 'foreign-chat' },
        true,
      )
    ).isError,
    false,
  );
  assert.equal(
    (
      await d.tool(
        'workspace_edit',
        { path: 'marker.txt', old_string: 'ONE', new_string: 'TWO' },
        true,
      )
    ).isError,
    false,
  );
  assert.equal(
    (await d.tool('workspace_read', { path: '../escape' })).isError,
    true,
  );
  assert.equal(
    (await d.tool('run_command', { command: 'touch forbidden' })).isError,
    true,
  );
  d.event({ type: 'text', text: 'streamed once' }, true);
  d.end();
  const result = await turnPromise;
  assert.equal(
    result.events
      .filter((e) => e.type === 'delta')
      .map((e) => e.data.text)
      .join(''),
    'streamed once',
  );
  assert.equal(
    result.events.filter(
      (e) => e.type === 'tool_call' && e.data.name === 'workspace_edit',
    ).length,
    1,
  );
  assert.equal(
    (
      await req(
        'GET',
        `/api/chats/${chat}/workspace/file?path=marker.txt&text=1`,
      )
    ).data.text,
    'TWO',
  );
  assert.equal(
    result.events.find((e) => e.type === 'done').data.status,
    'done',
  );
  assert.equal(
    result.events.find((e) => e.type === 'usage').data.totalTokens,
    null,
    'unknown usage remains unknown',
  );
  console.log(
    'PASS: streaming, tools, confirmation, duplicate calls/events, path scope, unavailable tools, busy and unknown usage',
  );

  const denyPromise = stream(chat, { content: content('deny write') }, (e) =>
    accept(chat, e, 'deny'),
  );
  const denied = driver(await peer.next((m) => m.type === 'turn.start'));
  assert.equal(
    (
      await denied.tool('workspace_write', {
        path: 'denied.txt',
        content: 'forbidden',
      })
    ).isError,
    true,
  );
  denied.event({ type: 'text', text: 'denied' });
  denied.end();
  await denyPromise;
  assert.equal(
    (
      await req(
        'GET',
        `/api/chats/${chat}/workspace/file?path=denied.txt&text=1`,
      )
    ).status,
    404,
  );

  const agent = (await req('GET', '/api/admin/agent')).data.settings;
  const revokePromise = stream(
    chat,
    { content: content('revoke during confirmation') },
    async (e) => {
      if (e.type === 'tool_confirm') {
        const saved = await req('PUT', '/api/admin/agent', {
          ...agent,
          workspace: { ...agent.workspace, enabled: false },
        });
        assert.equal(saved.status, 200);
        await accept(chat, e);
      }
    },
  );
  const revoked = driver(await peer.next((m) => m.type === 'turn.start'));
  assert.equal(
    (
      await revoked.tool('workspace_write', {
        path: 'revoked.txt',
        content: 'forbidden',
      })
    ).isError,
    true,
  );
  revoked.event({ type: 'text', text: 'revoked' });
  revoked.end();
  await revokePromise;
  await req('PUT', '/api/admin/agent', agent);
  assert.equal(
    (
      await req(
        'GET',
        `/api/chats/${chat}/workspace/file?path=revoked.txt&text=1`,
      )
    ).status,
    404,
  );
  console.log('PASS: deny and permission revoked while waiting');

  const meta = result.events.find((e) => e.type === 'meta').data;
  const editPromise = stream(chat, {
    content: content('replacement branch'),
    editMessageId: meta.userMessageId,
  });
  const edited = await peer.next((m) => m.type === 'turn.start');
  assert.equal(edited.messages.length, 1);
  assert(!JSON.stringify(edited.messages).includes('create marker'));
  const ed = driver(edited);
  ed.event({ type: 'text', text: 'edited' });
  ed.end();
  await editPromise;
  console.log('PASS: edited branch history');

  const cancelPromise = stream(
    chat,
    { content: content('stop while confirming') },
    async (e) => {
      if (e.type === 'tool_confirm') {
        const r = await req('POST', `/api/chats/${chat}/stop`, {
          messageId: e.data.messageId,
        });
        assert.equal(r.data.stopped, true);
      }
    },
  );
  const cancelTurn = await peer.next((m) => m.type === 'turn.start');
  const cancelled = driver(cancelTurn);
  const waiting = cancelled
    .tool('workspace_write', { path: 'cancelled.txt', content: 'forbidden' }, true)
    .catch(() => {});
  await peer.next((m) => m.type === 'turn.cancel');
  cancelled.end('cancelled');
  assert.equal(
    (await cancelPromise).events.find((e) => e.type === 'done').data.status,
    'stopped',
  );
  assert.equal(
    (
      await req(
        'GET',
        `/api/chats/${chat}/workspace/file?path=cancelled.txt&text=1`,
      )
    ).status,
    404,
  );
  // This call intentionally gets no tool result after cancellation.
  void waiting;

  const disconnectPromise = stream(chat, { content: content('disconnect') });
  await peer.next((m) => m.type === 'turn.start');
  peer.ws.terminate();
  assert.equal(
    (await disconnectPromise).events.find((e) => e.type === 'done').data.status,
    'error',
  );
  console.log('PASS: stop while confirming and disconnect terminal states');

  await req('POST', '/api/admin/users', {
    username: 'other',
    password: 'password-123',
    role: 'admin',
  });
  const other = (
    await req(
      'POST',
      '/api/auth/login',
      { username: 'other', password: 'password-123' },
      '',
    )
  ).cookie;
  assert.equal(
    (await req('GET', '/api/models', undefined, other)).data.some(
      (m) => m.id === modelId,
    ),
    false,
  );
  assert.equal(
    (await req('POST', '/api/admin/catbridge/pair', {}, other)).status,
    403,
  );
  assert.equal(
    (await req('GET', `/api/chats/${chat}/workspace`, undefined, other)).status,
    404,
  );
  assert.equal((await req('DELETE', '/api/admin/catbridge/pair')).status, 200);
  const bad = new WebSocket(
    base.replace('http', 'ws') + '/api/catbridge/connect',
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.match(
    String(
      (await once(bad, 'error', { signal: AbortSignal.timeout(5000) }))[0],
    ),
    /401/,
  );
  console.log('PASS: non-owner exclusion and revoked credentials');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  peer?.ws.terminate();
  app.kill('SIGTERM');
  const kill = setTimeout(() => app.kill('SIGKILL'), 3000);
  await once(app, 'exit');
  clearTimeout(kill);
  await rm(dir, { recursive: true, force: true });
}
