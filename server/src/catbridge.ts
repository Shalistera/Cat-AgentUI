import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db, schema, getSetting, setSetting, now } from './db/index.js';
import { newId, newToken, sha256hex } from './crypto.js';
import { requireAdmin } from './auth.js';
import type { AdapterMessage, ToolDef, UsageInfo } from './types.js';

type Pair = {
  id: string;
  userId: string;
  tokenHash: string | null;
  providerId: string;
  modelId: string;
  confirmWrites: boolean;
};
const KEY = 'catbridge';
const MAX_FRAME = 2 * 1024 * 1024;
export function bridgePair() {
  return getSetting<Pair | null>(KEY, null);
}
export function bridgeOwnsModel(userId: string, modelId: string) {
  const pair = bridgePair();
  return !!pair && pair.userId === userId && pair.modelId === modelId;
}
function ownerId() {
  return db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, 'admin'))
    .orderBy(asc(schema.users.createdAt))
    .get()?.id;
}
function pairValid(pair: Pair) {
  const current = bridgePair();
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, pair.userId))
    .get();
  return (
    !!current?.tokenHash &&
    current.tokenHash === pair.tokenHash &&
    !!user &&
    !user.disabled &&
    user.id === ownerId()
  );
}
type ToolResult = { result: string; isError?: boolean };
type BridgeEvent =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'usage'; usage: UsageInfo };
interface Run {
  id: string;
  seq: number;
  cancelled: boolean;
  pendingTools: number;
  controller: AbortController;
  calls: Map<string, { fingerprint: string; result: Promise<ToolResult> }>;
  chain: Promise<unknown>;
  event(e: BridgeEvent): void;
  tool(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  resolve(reason: 'stop' | 'length'): void;
  reject(e: Error): void;
  cleanup(): void;
}
interface Connection {
  ws: WebSocket;
  pair: Pair;
  ready: boolean;
  alive: boolean;
  cliVersion: string;
  model: string;
  run?: Run;
}
let connection: Connection | undefined;
let lastError: string | null = null;
function send(c: Connection, value: unknown) {
  const data = JSON.stringify(value);
  if (
    c.ws.readyState !== WebSocket.OPEN ||
    c.ws.bufferedAmount > 4 * MAX_FRAME ||
    Buffer.byteLength(data) > MAX_FRAME
  )
    throw new Error('CatBridge 连接不可用或消息过大');
  c.ws.send(data);
}
function disconnect(c: Connection, message: string) {
  if (connection === c) {
    connection = undefined;
    lastError = message;
  }
  if (c.run) {
    c.run.controller.abort();
    c.run.reject(new Error(message));
    c.run.cleanup();
    c.run = undefined;
  }
  c.ws.close(1008, 'Bridge disconnected');
}
export function bridgeStatus() {
  const pair = bridgePair();
  const c = connection;
  return {
    paired: !!pair?.tokenHash,
    state: c?.ready ? (c.run ? 'busy' : 'online') : 'offline',
    cliVersion: c?.cliVersion || null,
    model: c?.model || null,
    modelId: pair?.modelId || null,
    confirmWrites: pair?.confirmWrites ?? true,
    error: lastError,
  };
}
export function assertBridgeReady(userId: string, modelId: string) {
  if (!bridgeOwnsModel(userId, modelId))
    throw Object.assign(new Error('CatBridge 仅对配对账号开放'), {
      statusCode: 403,
    });
  if (!connection?.ready || !pairValid(connection.pair))
    throw Object.assign(new Error('CatBridge 离线，请启动本机连接器'), {
      statusCode: 503,
    });
  if (connection.run)
    throw Object.assign(new Error('CatBridge 正忙，请等待当前回合结束'), {
      statusCode: 409,
    });
}

export async function runBridgeTurn(input: {
  userId: string;
  modelId: string;
  chatId: string;
  system?: string;
  messages: AdapterMessage[];
  tools: ToolDef[];
  maxTokens: number;
  signal: AbortSignal;
  onEvent: (e: BridgeEvent) => void;
  onTool: Run['tool'];
}) {
  assertBridgeReady(input.userId, input.modelId);
  input.signal.throwIfAborted();
  const c = connection!;
  return new Promise<'stop' | 'length'>((resolve, reject) => {
    let cancelTimer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const run: Run = {
      id: randomUUID(),
      seq: 0,
      cancelled: false,
      pendingTools: 0,
      controller,
      calls: new Map(),
      chain: Promise.resolve(),
      event: input.onEvent,
      tool: input.onTool,
      resolve,
      reject,
      cleanup() {
        clearTimeout(cancelTimer);
        input.signal.removeEventListener('abort', cancel);
      },
    };
    const cancel = () => {
      run.cancelled = true;
      controller.abort();
      reject(new Error('对话已停止'));
      try {
        send(c, { type: 'turn.cancel', runId: run.id });
      } catch {
        disconnect(c, 'CatBridge 连接中断');
      }
      cancelTimer = setTimeout(
        () => disconnect(c, 'CatBridge 未响应取消，已断开'),
        5000,
      );
    };
    c.run = run;
    input.signal.addEventListener('abort', cancel, { once: true });
    try {
      send(c, {
        type: 'turn.start',
        runId: run.id,
        chatId: input.chatId,
        system: input.system || '',
        messages: input.messages,
        tools: input.tools,
        maxTokens: input.maxTokens,
      });
    } catch (e) {
      disconnect(c, (e as Error).message);
    }
  });
}

const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['text', 'reasoning']),
    text: z.string().max(500000),
  }),
  z.object({
    type: z.literal('usage'),
    usage: z.object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    }),
  }),
]);
const messageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('bridge.hello'),
    version: z.literal(1),
    cliVersion: z.string().max(100),
    model: z.string().max(160),
    capabilities: z.array(z.enum(['text', 'workspace'])),
  }),
  z.object({
    type: z.literal('turn.event'),
    runId: z.string().uuid(),
    seq: z.number().int().positive(),
    event: eventSchema,
  }),
  z.object({
    type: z.literal('tool.call'),
    runId: z.string().uuid(),
    seq: z.number().int().positive(),
    toolCallId: z.string().uuid(),
    name: z.string().regex(/^[\w]{1,64}$/),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('turn.end'),
    runId: z.string().uuid(),
    seq: z.number().int().positive(),
    status: z.enum(['done', 'error', 'cancelled']),
    reason: z.enum(['stop', 'length']).optional(),
    error: z.string().max(2000).optional(),
  }),
]);

export async function catbridgeRoutes(app: FastifyInstance) {
  app.get('/api/admin/catbridge', async (req, reply) => {
    requireAdmin(req, reply);
    if (req.user!.id !== ownerId())
      return reply.code(403).send({ error: 'CatBridge 仅对站点所有者开放' });
    return bridgeStatus();
  });
  app.post('/api/admin/catbridge/pair', async (req, reply) => {
    requireAdmin(req, reply);
    if (req.user!.id !== ownerId())
      return reply.code(403).send({ error: 'CatBridge 仅对站点所有者开放' });
    const token = newToken();
    const previous = bridgePair();
    const pair: Pair = previous
      ? { ...previous, tokenHash: sha256hex(token), userId: req.user!.id }
      : {
          id: newId(),
          userId: req.user!.id,
          tokenHash: sha256hex(token),
          providerId: newId(),
          modelId: newId(),
          confirmWrites: true,
        };
    db.transaction(() => {
      db.insert(schema.providers)
        .values({
          id: pair.providerId,
          name: 'CatBridge',
          type: 'catbridge',
          createdAt: now(),
        })
        .onConflictDoNothing()
        .run();
      db.insert(schema.models)
        .values({
          id: pair.modelId,
          providerId: pair.providerId,
          modelId: 'local-claude',
          displayName: 'Claude Code · CatBridge',
          description: '本机 Claude Code · 文本与工作区工具',
          vision: 0,
          tools: 1,
          accessMode: 'restricted',
          reasoningMode: 'off',
          createdAt: now(),
        })
        .onConflictDoNothing()
        .run();
      setSetting(KEY, pair);
    });
    if (connection) disconnect(connection, '配对凭证已更新');
    lastError = null;
    reply.header('cache-control', 'no-store');
    return { token, ...bridgeStatus() };
  });
  app.delete('/api/admin/catbridge/pair', async (req, reply) => {
    requireAdmin(req, reply);
    if (req.user!.id !== ownerId())
      return reply.code(403).send({ error: 'CatBridge 仅对站点所有者开放' });
    const pair = bridgePair();
    if (pair) setSetting(KEY, { ...pair, tokenHash: null });
    if (connection) disconnect(connection, '配对已撤销');
    return { ok: true };
  });
  app.patch('/api/admin/catbridge', async (req, reply) => {
    requireAdmin(req, reply);
    if (req.user!.id !== ownerId())
      return reply.code(403).send({ error: 'CatBridge 仅对站点所有者开放' });
    const parsed = z.object({ confirmWrites: z.boolean() }).safeParse(req.body);
    const pair = bridgePair();
    if (!parsed.success || !pair)
      return reply.code(400).send({ error: '请先配对' });
    setSetting(KEY, { ...pair, ...parsed.data });
    return bridgeStatus();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  app.server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/catbridge/connect') {
      socket.destroy();
      return;
    }
    const pair = bridgePair();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (
      req.headers.origin ||
      !pair?.tokenHash ||
      !token ||
      sha256hex(token) !== pair.tokenHash ||
      !pairValid(pair)
    ) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    if (connection) {
      socket.end(
        'HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Connection = {
        ws,
        pair,
        ready: false,
        alive: true,
        cliVersion: '',
        model: '',
      };
      connection = c;
      const helloTimer = setTimeout(() => {
        if (!c.ready) disconnect(c, 'CatBridge 握手超时');
      }, 10000);
      ws.on('pong', () => {
        c.alive = true;
      });
      ws.on('error', () => disconnect(c, 'CatBridge 连接错误'));
      ws.on('close', () => {
        clearTimeout(helloTimer);
        disconnect(c, 'CatBridge 连接中断');
      });
      ws.on('message', (data) => {
        try {
          if (!pairValid(pair)) throw new Error('配对账号或凭证已失效');
          const m = messageSchema.parse(JSON.parse(data.toString()));
          if (m.type === 'bridge.hello') {
            if (c.ready) throw new Error('重复握手');
            c.ready = true;
            c.cliVersion = m.cliVersion;
            c.model = m.model;
            lastError = null;
            clearTimeout(helloTimer);
            return;
          }
          const run = c.run;
          if (!c.ready || !run || run.id !== m.runId)
            throw new Error('回合不匹配');
          if (m.type === 'tool.call') {
            const known = run.calls.get(m.toolCallId);
            const fingerprint = JSON.stringify([m.name, m.args]);
            if (known) {
              if (known.fingerprint !== fingerprint)
                throw new Error('重复工具 ID 的参数不同');
              if (m.seq > run.seq) {
                if (m.seq !== run.seq + 1) throw new Error('事件序号缺失');
                run.seq = m.seq;
              }
              void known.result
                .then((result) => {
                  if (c.run === run && !run.cancelled)
                    send(c, {
                      type: 'tool.result',
                      runId: run.id,
                      toolCallId: m.toolCallId,
                      result,
                    });
                })
                .catch(() => {
                  if (c.run === run && !run.cancelled) disconnect(c, '工具结果传输失败');
                });
              return;
            }
          }
          if (m.seq <= run.seq) return;
          if (m.seq !== run.seq + 1) throw new Error('事件序号缺失');
          run.seq = m.seq;
          if (m.type === 'turn.end') {
            if (run.pendingTools && !run.cancelled)
              throw new Error('工具尚未完成');
            if (m.status === 'done' && !run.cancelled) {
              run.resolve(m.reason || 'stop');
              lastError = null;
            } else {
              lastError = m.error || 'CatBridge 回合取消';
              run.reject(new Error(lastError));
            }
            run.controller.abort();
            run.cleanup();
            c.run = undefined;
            return;
          }
          if (run.cancelled) return;
          if (m.type === 'turn.event') run.event(m.event);
          if (m.type === 'tool.call') {
            if (run.calls.size >= 100) throw new Error('工具调用次数超过上限');
            run.pendingTools++;
            const result = run.chain
              .then(() => {
                run.controller.signal.throwIfAborted();
                return run.tool(
                  m.toolCallId,
                  m.name,
                  m.args,
                  run.controller.signal,
                );
              })
              .finally(() => {
                run.pendingTools--;
              });
            run.calls.set(m.toolCallId, {
              fingerprint: JSON.stringify([m.name, m.args]),
              result,
            });
            run.chain = result.catch(() => {});
            void result
              .then((result) => {
                if (c.run === run && !run.cancelled)
                  send(c, {
                    type: 'tool.result',
                    runId: run.id,
                    toolCallId: m.toolCallId,
                    result,
                  });
              })
              .catch(() => {
                if (c.run === run && !run.cancelled)
                  disconnect(c, '工具执行中断');
              });
          }
        } catch {
          disconnect(c, 'CatBridge 协议校验失败');
        }
      });
    });
  });
  const heartbeat = setInterval(() => {
    const c = connection;
    if (!c) return;
    if (!c.alive || !pairValid(c.pair)) {
      disconnect(c, 'CatBridge 心跳超时或授权失效');
      c.ws.terminate();
      return;
    }
    c.alive = false;
    c.ws.ping();
  }, 15000);
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    if (connection) {
      const c = connection;
      disconnect(c, '面板关闭');
      c.ws.terminate();
    }
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
}
