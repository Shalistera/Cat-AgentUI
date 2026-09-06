// OCR 工坊: PDFs and images → continuous plain text or Markdown, streamed.
// Gemini only, on purpose: it takes PDFs natively through inlineData, so no
// server-side rasterising/pre-processing is needed (OpenAI's file inputs would
// need exactly that). Output is one continuous document — the prompt forbids
// page numbers and per-page grouping, which is what people actually want from
// a scan-to-text tool.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { newId } from '../crypto.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getAdapter, toRuntimeConfig } from '../providers/index.js';
import { recordUsage } from '../usage.js';
import { canUseModel } from '../model-access.js';
import { checkModelLimit, checkQuota, modelLimitBlockMessage, quotaBlockMessage } from '../quota.js';
import { tryAcquireChatTurn, tryReserveContextImageBytes } from '../admission.js';
import { cleanupUnreferencedUploads, getOwnedUploadMedia, readMediaBase64 } from '../storage.js';
import { allConfiguredSecretValues, redactSensitiveText } from '../secrets.js';
import type { AdapterMessagePart } from '../types.js';

const bodySchema = z.object({
  modelId: z.string().max(64),
  uploadIds: z.array(z.string().max(64)).min(1).max(config.maxAttachmentsPerMessage),
  format: z.enum(['text', 'markdown']),
});

const COMMON_RULES = [
  '你是一个 OCR 转录引擎。任务:把上面所有文件中的文字完整、准确地转录出来。',
  '严格要求:',
  '1. 逐字转录,保持原文语言,不翻译、不总结、不改写、不补充任何评论或说明。',
  '2. 绝对不要输出页码、"第 X 页"、"Page X"、页眉页脚中的页码或分页标记。',
  '3. 不要按页面或图片分段、分组、加标题;跨页被截断的段落、表格、列表要直接衔接成连续完整的内容。',
  '4. 多个文件按给出的顺序连续输出,不要加文件名或分隔标题。',
  '5. 无法辨认的字用 [无法辨认] 标注,不要猜测编造。',
  '6. 直接输出转录结果,开头和结尾不要有任何额外文字。',
];

const FORMAT_RULES = {
  text: [
    '输出格式:纯文本。按自然段落换行,不使用任何 Markdown 标记(不要 #、*、|、``` 等)。表格用制表符或空格对齐即可。',
  ],
  markdown: [
    '输出格式:Markdown。用 # 层级还原标题,用列表还原项目符号/编号,表格用 GFM 表格语法还原,必要的加粗/斜体可保留。不要用代码块包裹整体输出。',
  ],
};

function ocrPrompt(format: 'text' | 'markdown'): string {
  return [...COMMON_RULES, ...FORMAT_RULES[format]].join('\n');
}

function createSse(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
  return {
    send(event: string, data: unknown) {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    },
    end() { clearInterval(ping); try { res.end(); } catch { /* closed */ } },
  };
}

export async function ocrRoutes(app: FastifyInstance) {
  app.post('/api/ocr/stream', async (req, reply) => {
    requireAuth(req, reply);
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: '参数错误' });
    const { modelId, uploadIds, format } = body.data;
    const userId = req.user!.id;

    const row = db.select().from(schema.models)
      .innerJoin(schema.providers, eq(schema.models.providerId, schema.providers.id))
      .where(and(
        eq(schema.models.id, modelId), eq(schema.models.enabled, 1),
        eq(schema.models.imageGen, 0), eq(schema.providers.enabled, 1),
      )).get();
    if (!row) return reply.code(400).send({ error: '模型不可用' });
    const { models: model, providers: provider } = row;
    if (provider.type !== 'gemini' || !model.vision) {
      return reply.code(400).send({ error: 'OCR 仅支持 Gemini 系列的视觉模型' });
    }
    if (!canUseModel(req.user!, model.id)) return reply.code(403).send({ error: '该模型未对你开放' });

    // No notice channel for a quiet downgrade here — over quota simply refuses.
    const quota = checkQuota(userId);
    if (!quota.ok) return reply.code(429).send({ error: quotaBlockMessage(quota) });
    const modelLimit = checkModelLimit(req.user!, model);
    if (!modelLimit.ok) return reply.code(429).send({ error: modelLimitBlockMessage(model, modelLimit) });

    // Resolve + budget the files before taking any concurrency slot.
    const medias = [];
    const seen = new Set<string>();
    for (const id of uploadIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const media = await getOwnedUploadMedia(id, userId);
      if (!media) return reply.code(404).send({ error: '附件不存在或已过期,请重新上传' });
      if (!media.mime.startsWith('image/') && media.mime !== 'application/pdf') {
        return reply.code(400).send({ error: `「${media.name ?? id}」不是图片或 PDF` });
      }
      medias.push(media);
    }
    const totalBytes = medias.reduce((n, m) => n + m.size, 0);
    if (totalBytes > config.maxMessageAttachmentBytes) {
      return reply.code(413).send({ error: `附件总大小超过 ${Math.round(config.maxMessageAttachmentBytes / 1024 / 1024)} MB 限制` });
    }

    const jobId = newId();
    const turnLease = tryAcquireChatTurn(userId, `ocr:${jobId}`);
    if (!turnLease) return reply.code(429).send({ error: '并发任务过多,请稍后再试' });
    const bytesLease = tryReserveContextImageBytes(userId, totalBytes);
    if (!bytesLease) {
      turnLease.release();
      return reply.code(429).send({ error: '当前处理中的附件过多,请稍后再试' });
    }

    const sse = createSse(reply);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), config.chatTurnTimeoutMs);
    // Node ≥16 emits 'close' on the request as soon as its body is consumed, so
    // a client-gone check has to watch the response side.
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) abort.abort(); });
    const secretValues = allConfiguredSecretValues();
    const t0 = Date.now();
    const usage = { prompt: 0, completion: 0, total: 0 };
    let chars = 0;
    let status: 'done' | 'stopped' | 'error' = 'done';

    try {
      const parts: AdapterMessagePart[] = [];
      for (const m of medias) {
        const { mime, dataBase64 } = await readMediaBase64(m, config.maxMessageAttachmentBytes);
        parts.push({ type: mime === 'application/pdf' ? 'file' : 'image', mime, dataBase64 });
      }
      parts.push({ type: 'text', text: ocrPrompt(format) });

      const adapter = getAdapter(provider.type);
      for await (const ev of adapter.streamChat(toRuntimeConfig(provider), {
        model: model.modelId,
        messages: [{ role: 'user', parts }],
        maxTokens: config.maxModelOutputTokens,
        signal: abort.signal,
      })) {
        if (ev.type === 'text') {
          chars += ev.text.length;
          if (chars > config.maxTurnOutputChars) { status = 'stopped'; abort.abort(); break; }
          sse.send('delta', { text: redactSensitiveText(ev.text, secretValues) });
        } else if (ev.type === 'usage') {
          usage.prompt += ev.usage.promptTokens ?? 0;
          usage.completion += ev.usage.completionTokens ?? 0;
          usage.total += ev.usage.totalTokens ?? 0;
        }
      }
      if (abort.signal.aborted && status === 'done') status = 'stopped';
    } catch (err) {
      if (abort.signal.aborted) {
        status = 'stopped';
      } else {
        status = 'error';
        const message = redactSensitiveText(err instanceof Error ? err.message : String(err), secretValues);
        sse.send('error', { message });
      }
    } finally {
      clearTimeout(timeout);
      bytesLease.release();
      turnLease.release();
      const durationMs = Date.now() - t0;
      if (usage.total || usage.prompt || usage.completion) {
        recordUsage({
          userId, providerId: provider.id, providerType: provider.type, model: model.modelId,
          kind: 'ocr', promptTokens: usage.prompt, completionTokens: usage.completion,
          totalTokens: usage.total, durationMs,
        });
      }
      sse.send('usage', { promptTokens: usage.prompt, completionTokens: usage.completion, totalTokens: usage.total, durationMs });
      sse.send('done', { status });
      sse.end();
      // OCR keeps nothing: the source files are deleted once the run is over
      // (the page re-uploads if the user runs again with another format).
      await cleanupUnreferencedUploads(userId, uploadIds);
    }
  });
}
