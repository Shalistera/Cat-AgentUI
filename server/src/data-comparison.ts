import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { getAgentSettings, policyAllows, userWantsAgentTools } from './agent-settings.js';
import type { DataComparison, MessagePart, ToolDef } from './types.js';

export const COMPARE_DATA_TOOL = 'compare_data';

/** A narrow presentation hint for the current user message, not a classifier
 * over retrieved documents or assistant history. No extra model request. */
export function comparisonPresentationHint(userText: string): string | null {
  const text = userText.normalize('NFKC')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`|“[^”]*”|「[^」]*」|"[^"\n]*"/g, ' ')
    .replace(/^\s*>.*$/gm, ' ').trim();
  if (!text) return null;
  // Explicit opt-outs and requests to discuss/write code are not chart tasks.
  // Negation must modify the chart itself: “不要长文,用图表展示” is positive.
  if (/(?:不要|不用|无需|不需要|别)\s*(?:(?:再|额外|给我|帮我|为我|生成|提供|绘制|展示|显示|添加|输出|使用|用|画|做)\s*){0,4}(?:图表|图形|画图|绘图|曲线|可视化|折线图|柱状图|对比图)|(?:只|仅)(?:要|用)(?:纯)?(?:文字|文本|表格)|\b(?:no (?:charts?|graphs?)|(?:do not|don't) (?:plot|draw|chart)|(?:text|table)[ -]only)\b/i.test(text)) return null;
  if (/^(?:请帮我|请|帮我|麻烦)?\s*(?:翻译|润色|改写|检查语法|解释(?:一下)?这(?:句|段)话|(?:写|编写|实现|开发).{0,24}(?:代码|脚本|函数|组件))/.test(text)) return null;

  const compare = /对比|比较|两者|两种|区别|\bcompar(?:e|ing|ison)\b/i.test(text);
  const time = /(?:按|随|用).{0,6}(?:时间|日期|月份|年度|季度)|时间(?:段|轴|序列)|逐(?:时|日|月|年)|\bover time\b|\btime[ -]?series\b|\btimeline\b/i.test(text);
  const display = /展示|呈现|显示|画|绘制|可视化|\b(?:show|display|plot|visuali[sz]e)\b/i.test(text);
  const chart = /(?:画|绘制|生成|展示|显示|用|调用|测试).{0,20}(?:图表|折线图|柱状图|对比图|曲线)|(?:图表|折线图|柱状图|对比图).{0,20}(?:展示|呈现|显示|调用|测试|试试)|\b(?:plot|draw|show|create).{0,24}\b(?:chart|graph|curve)s?\b/i.test(text);
  const temporal = compare && time && (display || /按.{0,6}(?:时间|日期)|\bover time\b|\btime[ -]?series\b/i.test(text));
  if (!chart && !temporal) return null;
  return [
    '[本轮图表意图]',
    temporal ? '用户本轮要求按时间展示对比,可量化的时间变化应优先绘制时间曲线;非数值的事件/流程仍按用户要求展示。'
      : '用户本轮明确要求图表展示或测试图表能力。',
    '先取有依据的数据,足够后在正文前实际调用 compare_data;不要用 ASCII 时间轴、长文或“已调用”的文字代替工具调用。缺少所需数值时简短说明缺口,不能编造或换成无关图表。出图后简述结论;用户明确要求的详述仍保留。',
  ].join('\n');
}

export const DATA_COMPARISON_PROMPT = [
  '[图表对比]',
  '用户要求图表、曲线、趋势或按时间展示数值比较时,先收集必要数据,再调用 compare_data,最后写简短结论。需要联网就先检索来源。数据足够后优先出图,不要先写长篇背景科普、重复表格或 ASCII 时间轴;出图前最多一句进度说明。此工具不依赖工作区、命令执行或沙盒。',
  '除非用户明确要求详述,图后只写 2–4 条关键差异及必要的来源/局限说明,正文约 200–400 字即可;不要逐时间段重复描述图上已有信息。闲聊和没有比较需求的回答照常回复,不用图表。',
  '用户不必说出工具名或“画图”:“对比两者,用时间段展示”也应先考虑调用图表工具。明确仅用文字/表格或不要图表时,遵从用户要求。',
  '图表数值必须有依据,先明确比较条件、共同单位及来源。只有少量峰值、范围或时长时,不能编造成完整时间曲线;找不到逐点数据或可核实计算依据时,简短说明缺口并给已有事实,不要为了出图猜数。估算必须明确依据和假设,不能当作实测数据或个人效果预测。',
].join('\n');
export const COMPARE_DATA_DEF: ToolDef = {
  name: COMPARE_DATA_TOOL,
  description: [
    '展示数值对比图。用户要图表、趋势或按时间比较时,先搜索/计算取得数据再调用,无需沙盒或 HTML。',
    '柱状图:填 title、unit、source、chart="bar"、items 即可。折线图:填 title、unit、source、chart="line"、xLabel、x、series;需要文字刻度时加 xLabels。未使用字段省略或填 null,会忽略另一种图的字段。',
    '以下均为虚构格式示例,使用时替换为真实数据:',
    '柱状图 {"title":"两天销量","unit":"件","source":"示例数据","chart":"bar","items":[{"label":"周一","value":10},{"label":"周二","value":12}]}',
    '折线图 {"title":"两天销量","unit":"件","source":"示例数据","chart":"line","xLabel":"天","x":[1,2],"xLabels":["周一","周二"],"series":[{"label":"销量","values":[10,12]}]}',
    '每轮只展示一张图;格式错误可按具体报错修正一次。成功后简述结论。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '对比的指标和统计范围,最多 80 字' },
      unit: { type: 'string', description: '所有数值共用的单位,例如 万元、%、毫秒、分,最多 24 字' },
      source: { type: 'string', description: '实际数据出处、链接或计算依据,最多 1000 字;估算数据必须明确标注' },
      chart: { type: 'string', enum: ['bar', 'line'], description: 'bar=柱状图,line=折线图;省略时按提供的数据字段识别' },
      xLabel: { type: ['string', 'null'], description: '仅折线图需要:横轴名称和单位,如 时间(小时),最多 40 字' },
      x: { type: ['array', 'null'], minItems: 2, maxItems: 120, items: { type: 'number', minimum: -1e15, maximum: 1e15 }, description: '仅折线图需要:递增数值横坐标,保留真实间隔,如 [0,1,4] 表示相距 1 天和 3 天;日期文字放 xLabels' },
      xLabels: { type: ['array', 'null'], minItems: 2, maxItems: 120, items: { type: 'string' }, description: '可选折线刻度标签,如 ["09-24","09-25"];与 x 等长,每项最多 30 字。不需要就省略或填 null' },
      series: { type: ['array', 'null'], minItems: 1, maxItems: 6, description: '仅折线图需要:1–6 条曲线,每条 values 与 x 等长,总计最多 600 点', items: { type: 'object', properties: {
        label: { type: 'string', description: '唯一的曲线名称,最多 80 字' },
        values: { type: 'array', minItems: 2, maxItems: 120, items: { type: ['number', 'null'] }, description: '与 x 对齐的数值,缺失位置用 null' },
      }, required: ['label', 'values'], additionalProperties: false } },
      items: { type: ['array', 'null'], minItems: 2, maxItems: 12, description: '仅柱状图需要:2–12 个名称与数值。画折线图时省略或填 null', items: {
        type: 'object', properties: {
          label: { type: 'string', description: '唯一的方案或类别名称,最多 40 字' },
          value: { type: 'number', minimum: -1e15, maximum: 1e15 },
        }, required: ['label', 'value'], additionalProperties: false,
      } },
    },
    required: ['title', 'unit', 'source'], additionalProperties: false,
  },
};

// Accept unambiguous numeric strings, not empty strings/booleans/units as zero.
const finiteValue = z.preprocess((v) => typeof v === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim())
  ? Number(v.trim()) : v, z.number().finite().min(-1e15).max(1e15));
const common = {
  title: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(24),
  source: z.string().trim().min(1).max(1000),
};
const uniqueLabels = (items: { label: string }[]) => new Set(items.map((i) => i.label.normalize('NFKC').toLowerCase())).size === items.length;
const barSchema = z.object({
  ...common,
  chart: z.literal('bar').optional(),
  items: z.array(z.object({ label: z.string().trim().min(1).max(40), value: finiteValue }).strict()).min(2).max(12),
}).strict().refine((v) => uniqueLabels(v.items), { path: ['items'], message: 'label 名称不能重复,请给每项不同的名称' });
const lineSchema = z.object({
  ...common,
  chart: z.literal('line'),
  xLabel: z.string().trim().min(1).max(40),
  x: z.array(finiteValue).min(2).max(120),
  xLabels: z.array(z.string().trim().min(1).max(30)).min(2).max(120).optional(),
  series: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    values: z.array(finiteValue.nullable()).min(2).max(120),
  }).strict()).min(1).max(6),
}).strict().superRefine((v, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  v.x.forEach((x, i) => {
    if (i > 0 && x <= v.x[i - 1]) issue(['x', i], '必须大于前一个横坐标;请同步调整横轴和对应数值,不能单独排序');
  });
  if (v.xLabels && v.xLabels.length !== v.x.length) issue(['xLabels'], `需与 x 一样有 ${v.x.length} 项;不需要文字刻度时可省略`);
  if (v.x.length * v.series.length > 600) issue(['series'], '所有曲线合计最多 600 点');
  if (!uniqueLabels(v.series)) issue(['series'], 'label 名称不能重复,请给每条曲线不同的名称');
  v.series.forEach((s, i) => {
    if (s.values.length !== v.x.length) issue(['series', i, 'values'], `需与 x 一样有 ${v.x.length} 项;缺失位置用 null,不要补造数值`);
    if (s.values.filter((n) => n !== null).length < 2) issue(['series', i, 'values'], '至少需要两个有效数值才能连线;不能补造数值');
  });
});

function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.reduce<string>((s, p) => typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p), '') || '参数';
  let message = issue.message;
  if (issue.code === 'invalid_type') message = issue.expected === 'number'
    ? issue.path[0] === 'x' ? '需要有限数值横坐标;日期或时间文字请放在 xLabels 中'
      : issue.path.includes('values') ? '需要有限数字或 null;单位填在 unit,缺失值用 null'
      : '需要有限数字;单位填在 unit,不能用空字符串或 null 代替数值'
    : issue.expected === 'string' ? '需要填写文字' : issue.expected === 'array' ? '需要填写数组' : '类型不正确';
  if (issue.code === 'too_small') message = `至少需要 ${issue.minimum}${issue.origin === 'array' ? ' 项' : issue.origin === 'string' ? ' 个字符' : ''}`;
  if (issue.code === 'too_big') message = `最多允许 ${issue.maximum}${issue.origin === 'array' ? ' 项' : issue.origin === 'string' ? ' 个字符' : ''}`;
  if (issue.code === 'unrecognized_keys') message = '包含未定义字段,请只使用工具参数中的字段';
  return `${path}: ${message}`;
}

function readComparison(args: string): { data: DataComparison; error?: never } | { data?: never; error: string } {
  if (args.length > 32000) return { error: '参数总长度超过 32000 字符,请减少数据点或缩短说明' };
  let raw: unknown;
  try { raw = JSON.parse(args); } catch { return { error: '参数必须是合法 JSON 对象' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '参数必须是 JSON 对象' };
  const input = { ...raw } as Record<string, unknown>;
  // Select a branch before validation. Irrelevant fields (including provider-
  // required placeholders) never enter the renderer or invalidate real data.
  if (typeof input.chart === 'string') input.chart = input.chart.trim().toLowerCase();
  if (input.chart == null || input.chart === '') {
    const hasItems = Array.isArray(input.items) && input.items.length > 0;
    const hasSeries = Array.isArray(input.series) && input.series.length > 0;
    if (hasItems && hasSeries) return { error: 'chart: 同时提供了 items 和 series,请填写 bar 或 line 选择要画的图' };
    if (hasSeries) input.chart = 'line'; else delete input.chart;
  }
  if (input.chart !== undefined && input.chart !== 'bar' && input.chart !== 'line') return { error: 'chart: 只支持 bar(柱状图)或 line(折线图)' };
  const line = input.chart === 'line';
  for (const field of line ? ['items'] : ['xLabel', 'x', 'xLabels', 'series']) delete input[field];
  if (input.xLabels == null || (Array.isArray(input.xLabels) && input.xLabels.length === 0)) delete input.xLabels;
  const parsed = (line ? lineSchema : barSchema).safeParse(input);
  return parsed.success ? { data: parsed.data } : { error: parsed.error.issues.slice(0, 4).map(describeIssue).join('\n') };
}

/** Normalize harmless formatting only; keep data and geometry checks strict. */
export function parseComparison(args: string): DataComparison | null {
  return readComparison(args).data ?? null;
}

export function callCompareData(ctx: { userId: string; chatId: string; attempt: number; alreadyRendered?: boolean }, args: string): {
  result: string; isError: boolean; comparison?: Extract<MessagePart, { type: 'data_comparison' }>;
} {
  const fail = (result: string) => ({ result, isError: true });
  if (ctx.alreadyRendered) return fail('本轮已展示图表,请使用已有结果,不要重复调用。');
  if (ctx.attempt > 2) return fail('本轮图表参数已尝试两次,请简短说明问题,不要继续重试。');
  // Recheck the live policy: an admin may revoke access during generation.
  const user = db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).get();
  if (!user || user.disabled || !userWantsAgentTools(user.settings)
    || !policyAllows(getAgentSettings().dataComparison, user)) return fail('图表对比当前未开放。');
  if (!db.select({ id: schema.chats.id }).from(schema.chats)
    .where(and(eq(schema.chats.id, ctx.chatId), eq(schema.chats.userId, user.id))).get()) return fail('对话不存在或无权访问。');
  const parsed = readComparison(args);
  if (!parsed.data) return fail(`图表参数有误:\n${parsed.error}\n${ctx.attempt < 2 ? '请保留已有真实数据,按以上字段提示修正后重试一次。' : '本轮修正次数已用完,请简短说明问题,不要继续重试。'}`);
  const data = parsed.data;
  if (data.chart === 'line') {
    return {
      isError: false,
      result: JSON.stringify({ displayed: true, chart: 'line', unit: data.unit, xLabel: data.xLabel,
        series: data.series.map((series) => {
          const values = series.values.filter((n): n is number => n !== null);
          const min = Math.min(...values), max = Math.max(...values);
          return { label: series.label, min, max, range: Number((max - min).toPrecision(15)),
            peakX: data.x[series.values.indexOf(max)] };
        }), note: '折线图和数据表已展示,缺失值处断开。只需解释结论,不要重复输出整组数据或绘图代码。' }),
      comparison: { type: 'data_comparison', ...data },
    };
  }
  const min = Math.min(...data.items.map((i) => i.value));
  const max = Math.max(...data.items.map((i) => i.value));
  const range = Number((max - min).toPrecision(15));
  return {
    isError: false,
    result: JSON.stringify({ displayed: true, unit: data.unit,
      min: { value: min, labels: data.items.filter((i) => i.value === min).map((i) => i.label) },
      max: { value: max, labels: data.items.filter((i) => i.value === max).map((i) => i.label) },
      range, note: '图表和数据表已展示。只需简短解释结论,不重复输出整组数据。' }),
    comparison: { type: 'data_comparison', ...data },
  };
}
