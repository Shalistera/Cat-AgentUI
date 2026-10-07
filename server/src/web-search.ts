// 联网搜索 — the built-in web_search tool. Any tool-capable model can call it
// (本地 Claude Code, OpenAI-compatible, Gemini where native search can't ride
// along, subagents): the search itself is one Google-grounded request to a
// small Gemini model the admin picks (gemini-3.5-flash-lite by default).
// Google runs the queries server-side; the findings come back with numbered
// sources the calling model cites from by linking.
//
// Like the first-party chat apps there is no switch in the composer: the tool
// is simply present and the model decides per question whether to search.
//
// One call walks a chain until something answers: the search model, then the
// fallback model (a different Gemini, possibly on another provider), then the
// admin-designated search MCP (Brave). A Google line that just failed is
// skipped for a short while, so a Vertex outage costs one timeout, not one
// per search. Google bills per executed search query past a monthly free
// allowance: a month counter (and per-person daily caps) guard the bill, and
// past the month's limit only the MCP is tried.
import { and, eq, sql } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema, today, getSetting, setSetting } from './db/index.js';
import { getAdapter, toRuntimeConfig } from './providers/index.js';
import { recordUsage } from './usage.js';
import { getAgentSettings, policyAllows, type AgentUser } from './agent-settings.js';
import { callTool, getToolsForServers } from './mcp/manager.js';
import { canUseMcpServer } from './mcp/access.js';
import { getSearchServerId } from './routes/mcp.js';
import type { GroundingSource, ToolDef } from './types.js';

export const WEB_SEARCH_TOOL = 'web_search';

export const WEB_SEARCH_TOOL_DEF: ToolDef = {
  name: WEB_SEARCH_TOOL,
  description: '搜索网页,返回要点与编号来源链接。问题涉及时效性信息、近期事件、具体数据、价格版本或你不确定的事实时调用;一次一个查询,结果不够可以换个说法再搜。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索查询,用具体的关键词或问题;涉及时间时写明年份' } },
    required: ['query'],
    additionalProperties: false,
  },
};

const MONTH_KEY = 'webSearchMonth'; // { month: 'YYYY-MM', queries: n }
// Per step: three steps must still fit a turn, and a healthy search takes 3–5 s.
const STEP_TIMEOUT_MS = 20_000;
const COOLDOWN_MS = 2 * 60_000;
const cooldownUntil = new Map<string, number>();

type ProviderRow = typeof schema.providers.$inferSelect;

function month(): string {
  return today().slice(0, 7);
}

/** Google-grounded queries executed this month (what Google bills). */
export function monthlySearchQueries(): number {
  const m = getSetting<{ month: string; queries: number } | null>(MONTH_KEY, null);
  return m && m.month === month() ? m.queries : 0;
}

function addMonthlyQueries(n: number) {
  if (n <= 0) return;
  setSetting(MONTH_KEY, { month: month(), queries: monthlySearchQueries() + n });
}

function geminiProviders(): ProviderRow[] {
  return db.select().from(schema.providers).where(eq(schema.providers.type, 'gemini')).all().filter((p) => p.enabled);
}

/** The Gemini provider searches run on: the admin's pick, else the first
    enabled Gemini provider (Vertex preferred). */
export function searchProvider(): ProviderRow | null {
  const { providerId } = getAgentSettings().webSearch;
  const rows = geminiProviders();
  if (providerId) return rows.find((p) => p.id === providerId) ?? null;
  return rows.find((p) => p.useVertex) ?? rows[0] ?? null;
}

/** The fallback model's provider: its own pick, else the search provider. */
function fallbackProvider(): ProviderRow | null {
  const { fallbackProviderId } = getAgentSettings().webSearch;
  return fallbackProviderId ? geminiProviders().find((p) => p.id === fallbackProviderId) ?? null : searchProvider();
}

interface GoogleLine { provider: ProviderRow; model: string; key: string }

function googleLines(): GoogleLine[] {
  const s = getAgentSettings().webSearch;
  const lines: GoogleLine[] = [];
  const primary = searchProvider();
  if (primary) lines.push({ provider: primary, model: s.model, key: `${primary.id}:${s.model}` });
  const backup = s.fallbackModel ? fallbackProvider() : null;
  if (backup && !lines.some((l) => l.key === `${backup.id}:${s.fallbackModel}`)) {
    lines.push({ provider: backup, model: s.fallbackModel, key: `${backup.id}:${s.fallbackModel}` });
  }
  return lines;
}

function googleAllowanceLeft(): boolean {
  const { monthlyLimit } = getAgentSettings().webSearch;
  return monthlyLimit === 0 || monthlySearchQueries() < monthlyLimit;
}

/** The designated search MCP, when the fallback is on and this person may use it. */
export function fallbackMcpServerId(user: AgentUser): string | null {
  if (!getAgentSettings().webSearch.mcpFallback) return null;
  const id = getSearchServerId();
  return id && canUseMcpServer(user, id) ? id : null;
}

/** Can a turn for this person offer web_search right now? Policy, plus at
    least one backend: a Google line with allowance left, or the MCP. */
export function webSearchToolAvailable(user: AgentUser): boolean {
  if (!policyAllows(getAgentSettings().webSearch, user)) return false;
  return (googleLines().length > 0 && googleAllowanceLeft()) || !!fallbackMcpServerId(user);
}

function usedToday(userId: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(schema.usageLog)
    .where(and(eq(schema.usageLog.userId, userId), eq(schema.usageLog.kind, 'web_search'), eq(schema.usageLog.day, today()))).get()?.n ?? 0;
}

export interface WebSearchContext {
  user: AgentUser;
  chatId: string;
  messageId: string;
  signal: AbortSignal;
}

export interface WebSearchOutcome {
  result: string;
  isError: boolean;
  query: string;
  queries: string[];
  sources: GroundingSource[];
  /** Shown on the sources block: 'Google 搜索' or the MCP server's name. */
  label?: string;
}

interface StepResult { text: string; queries: string[]; sources: GroundingSource[]; promptTokens: number; completionTokens: number }

async function searchGoogle(line: GoogleLine, query: string, signal: AbortSignal): Promise<StepResult> {
  const out: StepResult = { text: '', queries: [], sources: [], promptTokens: 0, completionTokens: 0 };
  for await (const ev of getAdapter(line.provider.type).streamChat(toRuntimeConfig(line.provider), {
    model: line.model,
    system: `今天是 ${today()}。你是搜索助手。用 Google 搜索回答下面的查询,用中文给出信息完整、含具体数据/日期/名称/版本的要点(6 条以内),每条尽量注明依据哪个来源;信息互相矛盾时如实说明;不要寒暄,不要在文末罗列链接。`,
    messages: [{ role: 'user', parts: [{ type: 'text', text: query }] }],
    webSearch: true,
    maxTokens: 2048,
    hardMaxTokens: config.maxModelOutputTokens,
    signal,
  })) {
    if (ev.type === 'text') out.text += ev.text;
    else if (ev.type === 'grounding') { out.queries = ev.grounding.queries; out.sources = ev.grounding.sources; }
    else if (ev.type === 'usage') { out.promptTokens += ev.usage.promptTokens ?? 0; out.completionTokens += ev.usage.completionTokens ?? 0; }
  }
  if (!out.text.trim()) throw new Error('搜索模型没有返回内容');
  return out;
}

/** Search results as url/title pairs: JSON lines ({url,title}) or bare URLs. */
export function sourcesFromSearchText(text: string): GroundingSource[] {
  const sources: GroundingSource[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let url = '';
    let title = '';
    if (t.startsWith('{')) {
      try { const o = JSON.parse(t) as { url?: unknown; title?: unknown }; if (typeof o.url === 'string') { url = o.url; title = typeof o.title === 'string' ? o.title : ''; } } catch { /* not json */ }
    }
    if (!url) { const m = t.match(/https?:\/\/[^\s)\]"'<>]+/); if (m) url = m[0]; }
    if (!url || sources.some((s) => s.uri === url)) continue;
    if (!title) { try { title = new URL(url).hostname.replace(/^www\./, ''); } catch { title = url; } }
    sources.push({ uri: url, title });
  }
  return sources;
}

async function searchMcp(serverId: string, user: AgentUser, query: string): Promise<StepResult & { label: string }> {
  const listed = await getToolsForServers([serverId], user);
  if (listed.errors.length) throw new Error(listed.errors[0].error);
  const routes = [...listed.capabilities.routes.entries()];
  const pick = routes.find(([, r]) => /web_search/i.test(r.originalName)) ?? routes.find(([, r]) => /search/i.test(r.originalName));
  if (!pick) throw new Error('备用搜索源没有搜索工具');
  // Fill the tool's query argument, whatever it is called.
  const def = listed.tools.find((t) => t.name === pick[0]);
  const props = (def?.parameters as { properties?: Record<string, { type?: string }>; required?: string[] } | undefined) ?? {};
  const arg = ['query', 'q', 'keyword', 'searchTerm'].find((k) => props.properties?.[k])
    ?? props.required?.find((k) => props.properties?.[k]?.type === 'string') ?? 'query';
  const r = await callTool(pick[0], JSON.stringify({ [arg]: query }), listed.capabilities, user, { timeoutMs: STEP_TIMEOUT_MS });
  if (r.isError) throw new Error(r.result.slice(0, 300));
  const label = db.select({ name: schema.mcpServers.name }).from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get()?.name ?? '联网搜索';
  return { text: r.result, queries: [query], sources: sourcesFromSearchText(r.result), promptTokens: 0, completionTokens: 0, label };
}

export async function runWebSearch(ctx: WebSearchContext, argsJson: string): Promise<WebSearchOutcome> {
  let query = '';
  try { const a = JSON.parse(argsJson || '{}') as { query?: unknown }; query = typeof a.query === 'string' ? a.query.trim().slice(0, 500) : ''; } catch { /* empty */ }
  const fail = (result: string): WebSearchOutcome => ({ result, isError: true, query, queries: [], sources: [] });
  if (!query) return fail('缺少 query 参数');

  const s = getAgentSettings().webSearch;
  const dailyLimit = ctx.user.role === 'admin' ? s.adminDailyLimit : s.dailyLimit;
  if (dailyLimit > 0 && usedToday(ctx.user.id) >= dailyLimit) {
    return fail(`你今天的联网搜索次数已达上限(${dailyLimit} 次),按服务器时间次日 0 点恢复;请直接根据已有知识回答,并告诉用户无法联网核实`);
  }

  // Lines in their cooldown are skipped — unless that would leave nothing
  // at all to try, in which case a possibly-recovered line beats no answer.
  const lines = googleAllowanceLeft() ? googleLines() : [];
  const mcpId = fallbackMcpServerId(ctx.user);
  const warm = lines.filter((l) => (cooldownUntil.get(l.key) ?? 0) <= Date.now());
  const toTry = warm.length || mcpId ? warm : lines;
  if (!toTry.length && !mcpId) {
    return fail(lines.length || googleLines().length
      ? '本月的 Google 搜索额度已用完,也没有可用的备用搜索源;请直接根据已有知识回答,并告诉用户无法联网核实'
      : '联网搜索当前不可用:管理员还没有配置可用的 Gemini 服务商或备用搜索源');
  }

  const t0 = Date.now();
  const errors: string[] = [];
  let found: (StepResult & { label: string; providerId?: string; providerType?: string; model: string }) | null = null;
  let spent = { promptTokens: 0, completionTokens: 0 };
  for (const line of toTry) {
    if (ctx.signal.aborted) break;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)]);
    try {
      const r = await searchGoogle(line, query, signal);
      addMonthlyQueries(r.queries.length);
      found = { ...r, label: 'Google 搜索', providerId: line.provider.id, providerType: line.provider.type, model: line.model };
      cooldownUntil.delete(line.key);
      break;
    } catch (err) {
      if (ctx.signal.aborted) break;
      cooldownUntil.set(line.key, Date.now() + COOLDOWN_MS);
      errors.push(`${line.model}:${signal.aborted ? `${STEP_TIMEOUT_MS / 1000} 秒未返回` : err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!found && mcpId && !ctx.signal.aborted) {
    try {
      const r = await searchMcp(mcpId, ctx.user, query);
      found = { ...r, model: `mcp:${r.label}` };
    } catch (err) {
      errors.push(`备用搜索源:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (found) spent = { promptTokens: found.promptTokens, completionTokens: found.completionTokens };
  // One row per call whatever the route, so the daily cap counts searches.
  recordUsage({
    userId: ctx.user.id, chatId: ctx.chatId, messageId: ctx.messageId,
    providerId: found?.providerId ?? toTry[0]?.provider.id, providerType: found?.providerType ?? toTry[0]?.provider.type,
    model: found?.model ?? toTry[0]?.model ?? 'mcp', kind: 'web_search', ...spent, durationMs: Date.now() - t0,
  });
  if (ctx.signal.aborted) return fail('对话已停止');
  if (!found) return fail(`搜索失败(${errors.join(';')})。可以换个说法再试一次,或直接回答并说明没能联网核实`);

  if (found.label !== 'Google 搜索') {
    // Raw results from the MCP: hand them over as-is; the model reads and cites.
    return { result: found.text, isError: false, query, queries: found.queries, sources: found.sources, label: found.label };
  }
  const list = found.sources.length
    ? `\n\n来源(引用时用 Markdown 链接指向对应 URL):\n${found.sources.map((src, i) => `[${i + 1}] ${src.title} — ${src.uri}`).join('\n')}`
    : '\n\n(本次搜索没有返回来源链接,以上内容无法逐条核实)';
  return { result: `${found.text.trim()}${list}`, isError: false, query, queries: found.queries, sources: found.sources, label: found.label };
}

/** For tests: forget line failures. */
export function resetSearchCooldowns(): void {
  cooldownUntil.clear();
}
