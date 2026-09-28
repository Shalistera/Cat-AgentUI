import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { getAgentSettings, policyAllows, userWantsAgentTools } from './agent-settings.js';
import type { DataComparison, MessagePart, ToolDef } from './types.js';

export const COMPARE_DATA_TOOL = 'compare_data';
export type ComparisonChartTarget = 'bar' | 'line';
export type ComparisonIntent = { hint: string; chart?: ComparisonChartTarget };

/** A narrow presentation hint for the current user message, not a classifier
 * over retrieved documents or assistant history. No extra model request. */
export function comparisonPresentationIntent(userText: string): ComparisonIntent | null {
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
  if (/(?:为什么|为何|怎么).{0,24}(?:调用|选用|选择|出图|绘图)|(?:解释|分析|排查|检查).{0,20}(?:提示词|工具定义|图表工具|绘图工具|调用失败)/.test(text)) return null;

  const compare = /对比|比较|两者|两种|区别|\bcompar(?:e|ing|ison)\b/i.test(text);
  const time = /(?:按|随|用).{0,6}(?:时间|日期|月份|年度|季度)|时间(?:段|轴|序列)|一天内|不同时段|逐(?:小时|时|日|月|年)|\bover time\b|\btime[ -]?series\b|\btimeline\b/i.test(text);
  const display = /展示|呈现|显示|画|绘制|可视化|\b(?:show|display|plot|visuali[sz]e)\b/i.test(text);
  const chart = /(?:画|绘制|生成|展示|显示|用|调用|测试).{0,20}(?:图表|折线图|柱状图|对比图|曲线)|(?:图表|折线图|柱状图|对比图).{0,20}(?:展示|呈现|显示|调用|测试|试试)|\b(?:plot|draw|show|create).{0,24}\b(?:chart|graph|curve)s?\b/i.test(text);
  const temporal = compare && time && (display || /按.{0,6}(?:时间|日期)|\bover time\b|\btime[ -]?series\b/i.test(text));
  if (!chart && !temporal) return null;
  const bar = /柱状图|条形图|\bbar (?:chart|graph)s?\b/i.test(text);
  const line = /折线图|曲线|\bline (?:chart|graph)s?\b|\bcurves?\b/i.test(text);
  if (bar && line && !temporal && /区别|原理|用法|适用/.test(text)) return null;
  // An explicit chart choice wins over the default for temporal comparisons.
  // Ambiguous/mixed requests keep both options; no retrieved text is inspected.
  const target = bar && line ? undefined : bar ? 'bar' : line || temporal ? 'line' : undefined;
  const hint = [
    '[本轮图表意图]',
    target === 'bar' ? '用户指定柱状图,按用户指定的指标比较。'
      : target === 'line' ? '本轮目标是折线图:多个对象用共用横轴的多条曲线。时间变化应优先绘制时间曲线,不能改画峰值、总量等汇总柱状图;非数值事件/流程仍按用户要求展示。'
      : '用户本轮明确要求图表展示或测试图表能力。',
    '先围绕目标取有依据的数据,足够后在正文前调用 compare_data。若只找到汇总值,按下方图表规则补查时间序列;仍不足就简短说明具体缺口,不换指标凑图、不编造数值。',
  ].join('\n');
  return { hint, chart: target };
}

export function comparisonPresentationHint(userText: string): string | null {
  return comparisonPresentationIntent(userText)?.hint ?? null;
}

export const DATA_COMPARISON_PROMPT = [
  '[图表对比]',
  '先确定用户要比较的对象、指标和横轴,再找数据。图表必须回答这个目标,出图次数不是目标。用户不必知道工具名:“对比两者,用时间段展示”应选择共用时间轴的多曲线;分类/汇总数值比较可用柱状图,用户明确指定图形时遵从其要求。不要把相关但不同的指标当作替代,例如浓度不等于药效、峰值不等于全天变化。',
  '数据足够后优先出图:调用 compare_data,再写 2–4 条短结论及必要来源/局限,默认约 200–400 字。不要先写长篇科普、重复表格或 ASCII 时间轴。该工具可直接画 1–6 条曲线,不依赖工作区、命令执行或沙盒,无需 scipy/matplotlib 或绘图技能。',
  '缺数据时:若只找到峰值/时长/摘要,但目标需要时间序列,利用当前可用搜索/读取能力做一轮有目标的补查,优先原始资料的时间点、数据表或曲线。拿不到原图或不能可靠提取时如实说明。仍不足就用 1–2 句说明缺少什么,不改画无关柱状图,不反复搜索凑图。只有少量峰值、范围或时长时,不能编造成完整时间曲线。',
  '计算与展示分开:确需计算/拟合时可先用可用计算工具求数值,绘图仍用 compare_data。缺少计算库不代表图表工具不可用;可行时用已安装工具,否则说明计算受阻,不能假装已求得数据。用户要求或允许估算且有可核实计算依据时,才绘制并标注依据、假设和“估算”;实测值与估算不能混称。',
  '明确仅用文字/表格时不调用图表。只测试工具且未要求真实数据时可用标明“演示”的数据;已要求检索真实资料时不能换成演示。调试任务只报告与测试有关的结果和缺口,不扩展成个人咨询或追问个人情况。',
].join('\n');

const BAR_EXAMPLE = '柱状图 {"title":"两天销量","unit":"件","source":"演示数据","chart":"bar","items":[{"label":"周一","value":10},{"label":"周二","value":12}]}';
const LINE_EXAMPLE = '多曲线 {"title":"两家店销量随时间变化","unit":"件","source":"演示数据","chart":"line","xLabel":"天","x":[1,2,3],"series":[{"label":"甲店","values":[10,12,11]},{"label":"乙店","values":[8,11,13]}]}';
function comparisonDescription(target?: ComparisonChartTarget): string {
  return [
    '按用户要的指标展示数值对比,不以相关的汇总值替代时间变化。多条曲线可直接展示,不需要 Python、scipy、matplotlib 或沙盒。',
    target ? `本轮只接受 ${target === 'line' ? 'line 折线图;多个对象放进 series 的多条曲线,共用 x' : 'bar 柱状图' }。` : 'chart=bar 画柱状图,chart=line 画单条或多条折线。',
    '所有图都填 title、unit、source。',
    target !== 'line' ? '柱状图再填 items;折线字段省略或填 null。' : null,
    target !== 'bar' ? '折线图再填 xLabel、递增数值 x、series;需要文字刻度时加 xLabels。每条 series 有 label 和与 x 等长的 values,缺失值填 null。' : null,
    '以下仅为格式示例,实际调用替换为符合用户目标的数据:',
    target !== 'line' ? BAR_EXAMPLE : null,
    target !== 'bar' ? LINE_EXAMPLE : null,
    '每轮只展示一张图;错误可按报错修正一次。成功后简述结论。',
  ].filter(Boolean).join('\n');
}
export const COMPARE_DATA_DEF: ToolDef = {
  name: COMPARE_DATA_TOOL,
  description: comparisonDescription(),
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

/** Narrow the advertised shape only when the current request has a clear
 * chart target. Runtime validation enforces the same target for loose models. */
export function comparisonToolDefinition(target?: ComparisonChartTarget): ToolDef {
  if (!target) return COMPARE_DATA_DEF;
  const base = COMPARE_DATA_DEF.parameters.properties as Record<string, Record<string, unknown>>;
  const required = ['title', 'unit', 'source', 'chart', ...(target === 'line' ? ['xLabel', 'x', 'series'] : ['items'])];
  const properties = Object.fromEntries([...required, ...(target === 'line' ? ['xLabels'] : [])].map((name) => {
    const property = { ...base[name] };
    if (required.includes(name) && Array.isArray(property.type)) property.type = property.type.find((t) => t !== 'null');
    if (name === 'chart') property.enum = [target];
    return [name, property];
  }));
  return { ...COMPARE_DATA_DEF, description: comparisonDescription(target),
    parameters: { type: 'object', properties, required, additionalProperties: false } };
}

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

export function callCompareData(ctx: { userId: string; chatId: string; attempt: number; alreadyRendered?: boolean; chartTarget?: ComparisonChartTarget }, args: string): {
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
  if (ctx.chartTarget && (data.chart ?? 'bar') !== ctx.chartTarget) {
    const target = ctx.chartTarget === 'line'
      ? '本轮需要折线图(line),不能用峰值或总量柱状图替代时间变化。请取得与目标匹配的横轴数据,多对象用共用 x 的 series。'
      : '用户指定柱状图(bar),请用 items 展示其要求的分类指标。';
    return fail(`${target}${ctx.attempt < 2 ? '可修正一次;数据不足时简短说明缺口,不能补造数据。' : '本轮修正次数已用完,请简短说明问题,不要重试。'}`);
  }
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
