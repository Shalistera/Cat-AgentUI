import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema, now } from './db/index.js';
import { newId } from './crypto.js';
import { contextWindowTokens } from './knowledge.js';
import { OFF } from './reasoning.js';
import type { ChatAdapter, MessagePart, ProviderRuntimeConfig, UsageInfo } from './types.js';

export const COMPACTION_MODEL_KEY = 'compaction_model_id';
export const COMPACTION_FALLBACK_KEY = 'compaction_fallback_to_chat';

// 上下文压缩. A chat's history is replayed up to a budget sized to the model:
// about half its context window, counting one character per token (what
// Chinese costs on current tokenizers; English costs a third of that). When
// a branch outgrows it, the older part is folded into a written summary
// instead of silently falling away: the summary leads the replayed history
// and the recent turns follow verbatim. Summaries are per branch — anchored
// to the last message they cover — and are only rewritten once the verbatim
// part outgrows the budget again, so the replayed prefix stays the same (and
// cacheable) from one compaction to the next.

/** Compact once the replay would use more than this share of the budget… */
const FIT = 0.9;
/** …and keep this share verbatim afterwards, leaving room to grow. */
const KEEP = 0.55;
const SUMMARY_LEAD = '[早前对话摘要]';

export interface HistoryBudget { textChars: number; messages: number }

export function historyBudget(modelId: string): HistoryBudget {
  const byContext = Math.floor(contextWindowTokens(modelId) * 0.5);
  return {
    textChars: Math.max(10_000, Math.min(config.maxContextTextChars, byContext)),
    messages: config.maxContextMessages,
  };
}

/** Longest summary to ask for: a few percent of the budget. */
export function summaryTargetChars(budget: HistoryBudget): number {
  return Math.round(Math.min(24_000, Math.max(3_000, budget.textChars * 0.06)));
}

/** The text that opens the replayed history when a summary stands in for older turns. */
export function summaryLead(summary: string): string {
  return `${SUMMARY_LEAD}\n本对话较早的部分已压缩成下面的摘要,原始消息不再逐条提供;需要时以摘要为准继续对话。\n\n${summary}`;
}

export function isSummaryLead(text: string): boolean {
  return text.startsWith(SUMMARY_LEAD);
}

export type SummaryRow = typeof schema.chatSummaries.$inferSelect;

/** The deepest summary on this branch. Its anchor must be in the chain, and
    not be the newest message (the turn being answered). */
export function branchSummary(chatId: string, chainIds: string[]): { row: SummaryRow; index: number } | null {
  const pos = new Map(chainIds.map((id, i) => [id, i]));
  let best: { row: SummaryRow; index: number } | null = null;
  for (const row of db.select().from(schema.chatSummaries).where(eq(schema.chatSummaries.chatId, chatId)).all()) {
    const i = pos.get(row.upToMessageId);
    if (i === undefined || i >= chainIds.length - 1) continue;
    if (!best || i > best.index || (i === best.index && row.createdAt > best.row.createdAt)) best = { row, index: i };
  }
  return best;
}

/** A message was deleted or rewritten: summaries may still carry the old text. */
export function clearSummaries(chatId: string) {
  db.delete(schema.chatSummaries).where(eq(schema.chatSummaries.chatId, chatId)).run();
}

export function saveSummary(chatId: string, upToMessageId: string, summary: string, covered: number, model: string) {
  db.insert(schema.chatSummaries).values({ id: newId(), chatId, upToMessageId, summary, covered, model, createdAt: now() }).run();
}

export interface HistoryPlan {
  /** First chain index replayed verbatim. */
  start: number;
  /** The summary in force (replayed ahead of `start`), if any. */
  summary: SummaryRow | null;
  /** Chain indexes [from, to] to fold into a new summary, together with `summary`. */
  compact: { from: number; to: number } | null;
}

/**
 * Where the verbatim replay starts, and whether something has to be folded
 * into a summary first. `cost` is each message's approximate replay size in
 * characters; the last chain entry is the message being answered.
 */
export function planHistory(
  chain: { role: string; cost: number }[],
  summary: { row: SummaryRow; index: number } | null,
  budget: HistoryBudget,
): HistoryPlan {
  const from = summary ? summary.index + 1 : 0;
  const current = summary?.row ?? null;
  let total = current?.summary.length ?? 0;
  for (let i = from; i < chain.length; i++) total += chain[i].cost;
  if (total <= budget.textChars * FIT && chain.length - from <= budget.messages) {
    return { start: from, summary: current, compact: null };
  }
  // Keep the newest turns that fit the KEEP share (count too) — the message
  // being answered always — and start on a user message.
  const keepChars = budget.textChars * KEEP - summaryTargetChars(budget);
  const keepCount = Math.max(2, Math.floor(budget.messages * KEEP));
  let start = chain.length - 1;
  let used = chain[start].cost;
  while (start - 1 >= from && used + chain[start - 1].cost <= keepChars && chain.length - start + 1 <= keepCount) {
    start--;
    used += chain[start].cost;
  }
  while (start < chain.length - 1 && chain[start].role !== 'user') start++;
  if (start <= from) return { start: from, summary: current, compact: null };
  return { start, summary: current, compact: { from, to: start - 1 } };
}

// ---- writing the summary ----

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…(略)` : s);

function partLine(p: MessagePart): string | null {
  switch (p.type) {
    case 'text': return p.text.trim() || null;
    case 'tool_call': return `〔调用工具 ${p.name}:${clip(p.args, 400)}〕`;
    case 'tool_result': return `〔工具 ${p.name} 的结果${p.isError ? '(出错)' : ''}:${clip(p.result, 1500)}〕`;
    case 'file': return `〔附件:${p.name ?? '文件'}〕`;
    case 'image': return '〔图片〕';
    case 'data_comparison': return `〔数据对比图:${p.title}〕`;
    default: return null;
  }
}

function transcript(rows: { role: string; parts: MessagePart[] }[]): string {
  return rows.map((r) => {
    const body = r.parts.map(partLine).filter(Boolean).join('\n');
    return body ? `【${r.role === 'user' ? '用户' : '助手'}】\n${body}` : null;
  }).filter(Boolean).join('\n\n');
}

const SUMMARY_SYSTEM = '你负责压缩一段很长的对话,让同一位 AI 助手在之后的轮次里只凭摘要也能无缝接着聊。只输出摘要正文,不要寒暄,不要解释你在做什么。';

function summaryPrompt(previous: string | null, excerpt: string, targetChars: number): string {
  return [
    previous ? `[已有摘要](覆盖更早的对话)\n${previous}` : null,
    `[需要压缩的对话]\n${excerpt}`,
    [
      `请写一份新的完整摘要,${previous ? '替代已有摘要并纳入上面这段对话' : '概括上面这段对话'}。要求:`,
      '- 使用对话本身的语言书写。',
      '- 保留:用户的目标、背景、偏好和明确提出的要求;已经确定的结论和决定;重要的事实、数字、名称、链接、文件名,以及代码或数据的关键部分;助手做过的工具操作和结果(例如写入了哪些工作区文件);尚未完成的事项和待回答的问题。',
      '- 按主题或时间顺序分条组织,写清谁提出了什么、最后定了什么,不要逐句复述。',
      '- 不要编造或评价,不要加入对话里没有的内容。',
      `- 不超过 ${targetChars} 字。`,
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

/** Fold all selected history using the summarizer's own context budget. A
    cheaper model can have a smaller window than the conversation model, so
    long transcripts are processed in order with a rolling summary. Usage is
    reported per request, including a failed attempt's reported tokens. */
export async function writeSummary(
  deps: {
    adapter: ChatAdapter; cfg: ProviderRuntimeConfig; model: string; signal: AbortSignal;
    beforeRequest?(): void;
    onUsage(u: UsageInfo, durationMs: number): void;
  },
  previous: string | null,
  rows: { role: string; parts: MessagePart[] }[],
  targetChars: number,
): Promise<string> {
  const inputCap = Math.floor(contextWindowTokens(deps.model) * 0.5);
  targetChars = Math.min(targetChars, Math.floor(inputCap / 4));
  let remaining = transcript(rows);
  let summary = previous ?? '';
  // An older summary may have been produced by a much larger model. Include
  // every character as source material instead of trimming it to fit.
  if (summary.length > inputCap / 2) {
    remaining = `[较早的对话摘要]\n${summary}\n\n${remaining}`;
    summary = '';
  }
  do {
    deps.signal.throwIfAborted();
    const available = inputCap - SUMMARY_SYSTEM.length - summaryPrompt(summary, '', targetChars).length;
    if (available < 1_000) throw new Error('压缩模型上下文不足');
    let end = Math.min(remaining.length, available);
    if (end < remaining.length) {
      const boundary = remaining.lastIndexOf('\n\n', end);
      if (boundary > end / 2) end = boundary;
      // Do not split a UTF-16 surrogate pair across requests.
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    const prompt = summaryPrompt(summary, remaining.slice(0, end), targetChars);
    deps.beforeRequest?.();
    const startedAt = Date.now();
    let text = '';
    let spent: UsageInfo = {};
    let stopReason: string | undefined;
    try {
      for await (const ev of deps.adapter.streamChat(deps.cfg, {
        model: deps.model,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
        maxTokens: Math.min(config.maxModelOutputTokens, targetChars + 4_000),
        hardMaxTokens: config.maxModelOutputTokens,
        reasoning: { level: OFF, ratio: 0 },
        signal: deps.signal,
      })) {
        if (ev.type === 'text') {
          text += ev.text;
          if (text.length > targetChars * 2) throw new Error('压缩模型返回的摘要过长');
        } else if (ev.type === 'usage') {
          // Adapters also yield usage from failed provider-line attempts.
          spent.promptTokens = (spent.promptTokens ?? 0) + (ev.usage.promptTokens ?? 0);
          spent.completionTokens = (spent.completionTokens ?? 0) + (ev.usage.completionTokens ?? 0);
          spent.totalTokens = (spent.totalTokens ?? 0)
            + (ev.usage.totalTokens ?? (ev.usage.promptTokens ?? 0) + (ev.usage.completionTokens ?? 0));
        }
        else if (ev.type === 'stop') stopReason = ev.reason;
      }
      deps.signal.throwIfAborted();
      text = text.trim();
      if (!text) throw new Error('模型没有返回摘要');
      if (stopReason !== 'stop') throw new Error('压缩模型未完整返回摘要');
      summary = text.length > targetChars * 1.5 ? `${text.slice(0, Math.round(targetChars * 1.5))}…` : text;
      remaining = remaining.slice(end);
    } finally {
      deps.onUsage(spent, Date.now() - startedAt);
    }
  } while (remaining.length);
  return summary;
}
