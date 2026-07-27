import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';
import { db, schema, now } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { getToolsForServers, callTool } from '../mcp/manager.js';
import { readUploadBase64 } from './uploads.js';
import { recordUsage } from '../usage.js';
import type { AdapterMessage, AdapterMessagePart, MessagePart, ToolDef } from '../types.js';

// ---- helpers ----

function createSse(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
  return {
    send(event: string, data: unknown) {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    },
    end() { clearInterval(ping); try { res.end(); } catch { /* closed */ } },
  };
}

function parseParts(json: string): MessagePart[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Next ordering key for a chat. Safe because better-sqlite3 is synchronous and
// the server runs as a single writer process.
function nextSeq(chatId: string): number {
  const row = db.select({ max: sql<number | null>`max(${schema.messages.seq})` })
    .from(schema.messages).where(eq(schema.messages.chatId, chatId)).get();
  return (row?.max ?? 0) + 1;
}

const EMPTY_TOOL_RESULT = '(工具没有返回内容)';

// Every tool_call must be answered by a tool_result or the provider APIs reject
// the whole history on replay. Interrupted turns (stop button, iteration cap)
// leave dangling calls behind, so close them out before persisting/replaying.
function closeDanglingToolCalls(parts: MessagePart[], reason: string): MessagePart[] {
  const answered = new Set(parts.filter((p) => p.type === 'tool_result').map((p) => p.toolCallId));
  const unanswered = parts.filter((p) => p.type === 'tool_call' && !answered.has(p.id));
  if (!unanswered.length) return parts;
  return [
    ...parts,
    ...unanswered.map((p) => ({
      type: 'tool_result' as const,
      toolCallId: (p as Extract<MessagePart, { type: 'tool_call' }>).id,
      name: (p as Extract<MessagePart, { type: 'tool_call' }>).name,
      result: reason,
      isError: true,
    })),
  ];
}

function appendText(parts: MessagePart[], type: 'text' | 'reasoning', text: string) {
  const last = parts[parts.length - 1];
  if (last && last.type === type) (last as { text: string }).text += text;
  else parts.push({ type, text } as MessagePart);
}

// Convert stored MessagePart[] to adapter parts (resolving image uploads to base64).
function toAdapterParts(parts: MessagePart[], ownerId: string, includeImages: boolean): AdapterMessagePart[] {
  const out: AdapterMessagePart[] = [];
  // repair history written before this guard existed
  for (const p of closeDanglingToolCalls(parts, '(调用未完成)')) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image' && p.uploadId && includeImages) {
      const img = readUploadBase64(p.uploadId, ownerId);
      if (img) out.push({ type: 'image', mime: img.mime, dataBase64: img.dataBase64 });
    } else if (p.type === 'tool_call') {
      out.push({ type: 'tool_call', id: p.id, name: p.name, args: p.args });
    } else if (p.type === 'tool_result') {
      // empty strings are rejected by some providers (Anthropic: "text content blocks must be non-empty")
      out.push({
        type: 'tool_result', toolCallId: p.toolCallId, name: p.name,
        result: p.result && p.result.length ? p.result : EMPTY_TOOL_RESULT,
        isError: p.isError,
      });
    }
    // reasoning parts are never replayed to providers
  }
  return out;
}

function chatSummary(c: typeof schema.chats.$inferSelect) {
  return {
    id: c.id, title: c.title, pinned: !!c.pinned, modelId: c.modelId,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

function messageDto(m: typeof schema.messages.$inferSelect) {
  return {
    id: m.id, role: m.role, parts: parseParts(m.parts), model: m.model,
    status: m.status, error: m.error,
    promptTokens: m.promptTokens, completionTokens: m.completionTokens, totalTokens: m.totalTokens,
    durationMs: m.durationMs, ttftMs: m.ttftMs, createdAt: m.createdAt,
  };
}

function getModelWithProvider(modelDbId: string | null) {
  if (!modelDbId) return null;
  const row = db.select().from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(and(eq(schema.models.id, modelDbId), eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1)))
    .get();
  return row ? { model: row.models, provider: row.providers } : null;
}

function getDefaultModel() {
  const rows = db.select().from(schema.models)
    .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
    .where(and(eq(schema.models.enabled, 1), eq(schema.providers.enabled, 1)))
    .orderBy(asc(schema.models.sortOrder)).all();
  const def = rows.find((r) => r.models.isDefault) ?? rows[0];
  return def ? { model: def.models, provider: def.providers } : null;
}

const partSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal('image'), uploadId: z.string().max(64) }),
]);

const streamBodySchema = z.object({
  content: z.array(partSchema).min(1).max(20).optional(),
  modelId: z.string().max(64).optional(),
  regenerateMessageId: z.string().max(64).optional(),
  editMessageId: z.string().max(64).optional(),
});

// per-user concurrent stream cap
const activeStreams = new Map<string, number>();

const TITLE_PROMPT = '请为上面这段对话生成一个简短的标题(不超过16个字),直接输出标题文本,不要任何引号、句号或解释。';

export async function chatRoutes(app: FastifyInstance) {
  app.get('/api/chats', async (req, reply) => {
    requireAuth(req, reply);
    const rows = db.select().from(schema.chats).where(eq(schema.chats.userId, req.user!.id)).all();
    rows.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    return { chats: rows.map(chatSummary) };
  });

  app.post('/api/chats', async (req, reply) => {
    requireAuth(req, reply);
    const body = z.object({ modelId: z.string().max(64).nullish() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const id = newId();
    const t = now();
    db.insert(schema.chats).values({
      id, userId: req.user!.id, title: '', modelId: body.data.modelId ?? null,
      createdAt: t, updatedAt: t,
    }).run();
    const c = db.select().from(schema.chats).where(eq(schema.chats.id, id)).get()!;
    return { chat: { ...chatSummary(c), systemPrompt: c.systemPrompt, temperature: c.temperature, maxTokens: c.maxTokens, mcpServerIds: [] } };
  });

  app.get('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const msgs = db.select().from(schema.messages).where(eq(schema.messages.chatId, id))
      .orderBy(asc(schema.messages.createdAt)).all();
    let mcpServerIds: string[] = [];
    try { mcpServerIds = JSON.parse(c.mcpServerIds); } catch { /* ignore */ }
    return {
      chat: {
        ...chatSummary(c),
        systemPrompt: c.systemPrompt, temperature: c.temperature,
        maxTokens: c.maxTokens, mcpServerIds,
      },
      messages: msgs.map(messageDto),
    };
  });

  app.patch('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      title: z.string().max(120).optional(),
      systemPrompt: z.string().max(20_000).nullish(),
      temperature: z.number().min(0).max(2).nullish(),
      maxTokens: z.number().int().min(1).max(1_000_000).nullish(),
      mcpServerIds: z.array(z.string().max(64)).max(20).optional(),
      pinned: z.boolean().optional(),
      modelId: z.string().max(64).nullish(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    const d = body.data;
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (d.title !== undefined) patch.title = d.title;
    if (d.systemPrompt !== undefined) patch.systemPrompt = d.systemPrompt;
    if (d.temperature !== undefined) patch.temperature = d.temperature;
    if (d.maxTokens !== undefined) patch.maxTokens = d.maxTokens;
    if (d.mcpServerIds !== undefined) patch.mcpServerIds = JSON.stringify(d.mcpServerIds);
    if (d.pinned !== undefined) patch.pinned = d.pinned ? 1 : 0;
    if (d.modelId !== undefined) patch.modelId = d.modelId;
    db.update(schema.chats).set(patch).where(eq(schema.chats.id, id)).run();
    const updated = db.select().from(schema.chats).where(eq(schema.chats.id, id)).get()!;
    let mcpServerIds: string[] = [];
    try { mcpServerIds = JSON.parse(updated.mcpServerIds); } catch { /* ignore */ }
    return { chat: { ...chatSummary(updated), systemPrompt: updated.systemPrompt, temperature: updated.temperature, maxTokens: updated.maxTokens, mcpServerIds } };
  });

  app.delete('/api/chats/:id', async (req, reply) => {
    requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const c = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.userId, req.user!.id))).get();
    if (!c) return reply.code(404).send({ error: '对话不存在' });
    db.delete(schema.chats).where(eq(schema.chats.id, id)).run();
    return { ok: true };
  });

  // ---- the main streaming endpoint ----
  app.post('/api/chats/:id/stream', async (req, reply) => {
    requireAuth(req, reply);
    const user = req.user!;
    const { id: chatId } = req.params as { id: string };
    const parsed = streamBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数错误' });
    const body = parsed.data;

    const chat = db.select().from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.userId, user.id))).get();
    if (!chat) return reply.code(404).send({ error: '对话不存在' });

    if ((activeStreams.get(user.id) ?? 0) >= 3) {
      return reply.code(429).send({ error: '并发对话数已达上限,请等待其他回复完成' });
    }

    // resolve model
    const picked = getModelWithProvider(body.modelId ?? chat.modelId) ?? getDefaultModel();
    if (!picked) return reply.code(400).send({ error: '没有可用的模型,请联系管理员配置' });
    const { model, provider } = picked;

    // --- prepare message history mutations ---
    let userMessageId: string | null = null;
    if (body.regenerateMessageId) {
      const target = db.select().from(schema.messages)
        .where(and(eq(schema.messages.id, body.regenerateMessageId), eq(schema.messages.chatId, chatId))).get();
      if (!target) return reply.code(404).send({ error: '消息不存在' });
      db.delete(schema.messages)
        .where(and(eq(schema.messages.chatId, chatId), gte(schema.messages.seq, target.seq))).run();
    } else if (body.editMessageId) {
      if (!body.content) return reply.code(400).send({ error: '缺少消息内容' });
      const target = db.select().from(schema.messages)
        .where(and(eq(schema.messages.id, body.editMessageId), eq(schema.messages.chatId, chatId))).get();
      if (!target || target.role !== 'user') return reply.code(404).send({ error: '消息不存在' });
      db.update(schema.messages).set({ parts: JSON.stringify(body.content) })
        .where(eq(schema.messages.id, target.id)).run();
      db.delete(schema.messages)
        .where(and(eq(schema.messages.chatId, chatId), gt(schema.messages.seq, target.seq))).run();
      userMessageId = target.id;
    } else {
      if (!body.content) return reply.code(400).send({ error: '缺少消息内容' });
      userMessageId = newId();
      db.insert(schema.messages).values({
        id: userMessageId, chatId, role: 'user', seq: nextSeq(chatId),
        parts: JSON.stringify(body.content), createdAt: now(),
      }).run();
    }

    const history = db.select().from(schema.messages).where(eq(schema.messages.chatId, chatId))
      .orderBy(asc(schema.messages.seq)).all()
      .filter((m) => !(m.role === 'assistant' && m.status === 'error' && parseParts(m.parts).length === 0));
    if (!history.length || history[history.length - 1].role !== 'user') {
      return reply.code(400).send({ error: '当前对话状态无法生成回复' });
    }

    const baseHistory: AdapterMessage[] = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      parts: toAdapterParts(parseParts(m.parts), user.id, !!model.vision),
    })).filter((m) => m.parts.length > 0);

    // MCP tools
    let mcpServerIds: string[] = [];
    try { mcpServerIds = JSON.parse(chat.mcpServerIds); } catch { /* ignore */ }
    let toolDefs: ToolDef[] | undefined;
    let toolErrors: { serverId: string; name: string; error: string }[] = [];
    if (model.tools && mcpServerIds.length) {
      const r = await getToolsForServers(mcpServerIds);
      toolDefs = r.tools.length ? r.tools : undefined;
      toolErrors = r.errors;
    }

    // --- start streaming ---
    // Re-check the cap here: the MCP tool fetch above yields, so several requests
    // can pass the early check before any of them registers.
    if ((activeStreams.get(user.id) ?? 0) >= 3) {
      return reply.code(429).send({ error: '并发对话数已达上限,请等待其他回复完成' });
    }
    activeStreams.set(user.id, (activeStreams.get(user.id) ?? 0) + 1);
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      activeStreams.set(user.id, Math.max(0, (activeStreams.get(user.id) ?? 1) - 1));
    };

    // Everything below is the streaming turn; the outer finally guarantees the
    // slot is released even if setup throws before the inner try/finally.
    try {
    const sse = createSse(reply);
    const controller = new AbortController();
    let clientGone = false;
    // response 'close' with writableEnded=false → client disconnected mid-stream
    // (request 'close' fires as soon as the body is consumed on Node 16+, so it's unusable here)
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) { clientGone = true; controller.abort(); }
    });

    const assistantId = newId();
    db.insert(schema.messages).values({
      id: assistantId, chatId, role: 'assistant', parts: '[]', seq: nextSeq(chatId),
      model: model.modelId, providerId: provider.id, status: 'streaming', createdAt: now(),
    }).run();
    if (body.modelId && body.modelId !== chat.modelId) {
      db.update(schema.chats).set({ modelId: body.modelId }).where(eq(schema.chats.id, chatId)).run();
    }

    sse.send('meta', { messageId: assistantId, userMessageId, model: model.modelId });
    for (const te of toolErrors) sse.send('notice', { message: `MCP 服务器「${te.name}」连接失败: ${te.error}` });

    const cfg = toRuntimeConfig(provider);
    const adapter = getAdapter(provider.type);
    const parts: MessagePart[] = [];
    const usage = { prompt: 0, completion: 0, total: 0 };
    let ttft: number | null = null;
    const t0 = Date.now();
    let status: 'done' | 'error' | 'stopped' = 'done';
    let errMsg: string | null = null;

    try {
      let iterations = 0;
      for (;;) {
        iterations++;
        const messages = [...baseHistory];
        if (parts.length) messages.push({ role: 'assistant', parts: toAdapterParts(parts, user.id, false) });
        const pendingCalls: { id: string; name: string; args: string }[] = [];
        let stopReason = 'stop';

        for await (const ev of adapter.streamChat(cfg, {
          model: model.modelId,
          system: chat.systemPrompt || undefined,
          messages,
          tools: toolDefs,
          temperature: chat.temperature ?? undefined,
          maxTokens: chat.maxTokens ?? undefined,
          signal: controller.signal,
        })) {
          if (ev.type === 'text') {
            if (ttft === null) ttft = Date.now() - t0;
            appendText(parts, 'text', ev.text);
            sse.send('delta', { text: ev.text });
          } else if (ev.type === 'reasoning') {
            if (ttft === null) ttft = Date.now() - t0;
            appendText(parts, 'reasoning', ev.text);
            sse.send('reasoning', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            parts.push({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.args });
            pendingCalls.push(ev);
            sse.send('tool_call', { id: ev.id, name: ev.name, args: ev.args });
          } else if (ev.type === 'usage') {
            usage.prompt += ev.usage.promptTokens ?? 0;
            usage.completion += ev.usage.completionTokens ?? 0;
            usage.total += ev.usage.totalTokens ?? ((ev.usage.promptTokens ?? 0) + (ev.usage.completionTokens ?? 0));
          } else if (ev.type === 'stop') {
            stopReason = ev.reason;
          }
        }

        if (stopReason === 'tool_calls' && pendingCalls.length && iterations < config.maxToolIterations) {
          for (const call of pendingCalls) {
            const { result, isError } = await callTool(call.name, call.args, { timeoutMs: 120_000 });
            const trimmed = result.length > 100_000 ? `${result.slice(0, 100_000)}\n…(结果已截断)` : result;
            const part: MessagePart = { type: 'tool_result', toolCallId: call.id, name: call.name, result: trimmed, isError };
            parts.push(part);
            sse.send('tool_result', part);
          }
          continue;
        }
        break;
      }
    } catch (e) {
      if (controller.signal.aborted || clientGone) {
        status = 'stopped';
      } else {
        status = 'error';
        errMsg = e instanceof Error ? e.message : String(e);
        sse.send('error', { message: errMsg });
      }
    } finally {
      releaseSlot();
    }

    const finalParts = closeDanglingToolCalls(
      parts,
      status === 'stopped' ? '(用户已停止,调用未执行)' : '(调用未完成)',
    );
    const durationMs = Date.now() - t0;
    db.update(schema.messages).set({
      parts: JSON.stringify(finalParts),
      status, error: errMsg,
      promptTokens: usage.prompt || null,
      completionTokens: usage.completion || null,
      totalTokens: usage.total || null,
      durationMs, ttftMs: ttft,
    }).where(eq(schema.messages.id, assistantId)).run();
    db.update(schema.chats).set({ updatedAt: now() }).where(eq(schema.chats.id, chatId)).run();
    recordUsage({
      userId: user.id, chatId, messageId: assistantId,
      providerId: provider.id, providerType: provider.type, model: model.modelId,
      kind: 'chat',
      promptTokens: usage.prompt, completionTokens: usage.completion, totalTokens: usage.total,
      durationMs,
    });

    sse.send('usage', {
      promptTokens: usage.prompt || null, completionTokens: usage.completion || null,
      totalTokens: usage.total || null, durationMs, ttftMs: ttft,
    });

    // auto-title on first successful exchange
    if (!chat.title && status === 'done' && !clientGone) {
      try {
        const titleMessages: AdapterMessage[] = [
          ...baseHistory,
          { role: 'assistant', parts: toAdapterParts(finalParts, user.id, false) },
          { role: 'user', parts: [{ type: 'text', text: TITLE_PROMPT }] },
        ];
        let title = '';
        const tUsage = { prompt: 0, completion: 0, total: 0 };
        for await (const ev of adapter.streamChat(cfg, {
          model: model.modelId, messages: titleMessages, maxTokens: 500,
          signal: AbortSignal.timeout(20_000),
        })) {
          if (ev.type === 'text') title += ev.text;
          else if (ev.type === 'usage') {
            tUsage.prompt += ev.usage.promptTokens ?? 0;
            tUsage.completion += ev.usage.completionTokens ?? 0;
            tUsage.total += ev.usage.totalTokens ?? 0;
          }
        }
        title = title.trim().replace(/^["'「『]|["'」』]$/g, '').split('\n')[0].slice(0, 60);
        if (title) {
          db.update(schema.chats).set({ title }).where(eq(schema.chats.id, chatId)).run();
          sse.send('title', { title });
        }
        recordUsage({
          userId: user.id, chatId, providerId: provider.id, providerType: provider.type,
          model: model.modelId, kind: 'title',
          promptTokens: tUsage.prompt, completionTokens: tUsage.completion, totalTokens: tUsage.total,
        });
      } catch { /* title generation is best-effort */ }
    }

    sse.send('done', { status });
    sse.end();
    } finally {
      releaseSlot();
    }
  });
}
