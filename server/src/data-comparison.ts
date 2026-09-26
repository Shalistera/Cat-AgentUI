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
  description: '用户要求图表、趋势或按时间展示数值对比时调用,包括先搜索/计算再展示的任务,不要求用户先给出数值或工具名。取得有依据的同指标、同单位数据后立即出图。分类比较用 items(2–12 项);时间序列用 chart=line、xLabel、递增数值 x、series(1–6 条等长曲线,每条 2–120 点,合计最多 600 点),xLabels 可标注时间,缺失值用 null。每轮最多一次,无需沙盒或 HTML;先出图再简短解释。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '对比的指标和统计范围,最多 80 字' },
      unit: { type: 'string', description: '所有数值共用的单位,例如 万元、%、毫秒、分,最多 24 字' },
      source: { type: 'string', description: '实际数据出处或计算依据,最多 160 字;估算数据必须明确标注' },
      chart: { type: 'string', enum: ['bar', 'line'], description: '省略为柱状图;折线图填 line。items 与折线字段二选一' },
      xLabel: { type: 'string', description: '横轴名称和单位,例如 时间(小时),最多 40 字' },
      x: { type: 'array', minItems: 2, maxItems: 120, items: { type: 'number', minimum: -1e15, maximum: 1e15 }, description: '实际横坐标,如 [6,8,8.5,10,12];严格递增,保留真实间隔' },
      xLabels: { type: 'array', minItems: 2, maxItems: 120, items: { type: 'string' }, description: '可选刻度标签,如 6:00、8:00、8:30;与 x 等长,每项最多 30 字' },
      series: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: {
        label: { type: 'string', description: '唯一的曲线名称,最多 80 字' },
        values: { type: 'array', minItems: 2, maxItems: 120, items: { type: ['number', 'null'] }, description: '与 x 对齐的数值,缺失位置用 null' },
      }, required: ['label', 'values'], additionalProperties: false } },
      items: { type: 'array', minItems: 2, maxItems: 12, items: {
        type: 'object', properties: {
          label: { type: 'string', description: '唯一的方案或类别名称,最多 40 字' },
          value: { type: 'number', minimum: -1e15, maximum: 1e15 },
        }, required: ['label', 'value'], additionalProperties: false,
      } },
    },
    required: ['title', 'unit', 'source'], additionalProperties: false,
  },
};

const finiteValue = z.number().finite().min(-1e15).max(1e15);
const common = {
  title: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(24),
  source: z.string().trim().min(1).max(160),
};
const uniqueLabels = (items: { label: string }[]) => new Set(items.map((i) => i.label.normalize('NFKC').toLowerCase())).size === items.length;
const barSchema = z.object({
  ...common,
  chart: z.literal('bar').optional(),
  items: z.array(z.object({ label: z.string().trim().min(1).max(40), value: finiteValue }).strict()).min(2).max(12),
}).strict().refine((v) => uniqueLabels(v.items));
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
}).strict().refine((v) =>
  v.x.every((x, i) => i === 0 || x > v.x[i - 1])
  && (!v.xLabels || v.xLabels.length === v.x.length)
  && v.x.length * v.series.length <= 600
  && uniqueLabels(v.series)
  && v.series.every((s) => s.values.length === v.x.length && s.values.filter((n) => n !== null).length >= 2));
const comparisonSchema = z.union([barSchema, lineSchema]);

/** Strict numeric input; the same validated data feeds both table and chart. */
export function parseComparison(args: string): DataComparison | null {
  if (args.length > 32000) return null;
  try {
    const parsed = comparisonSchema.safeParse(JSON.parse(args));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function callCompareData(ctx: { userId: string; chatId: string; attempt: number }, args: string): {
  result: string; isError: boolean; comparison?: Extract<MessagePart, { type: 'data_comparison' }>;
} {
  const fail = (result: string) => ({ result, isError: true });
  if (ctx.attempt > 1) return fail('本轮已调用过数据对比,请使用已有结果,不要重复调用。');
  // Recheck the live policy: an admin may revoke access during generation.
  const user = db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).get();
  if (!user || user.disabled || !userWantsAgentTools(user.settings)
    || !policyAllows(getAgentSettings().dataComparison, user)) return fail('图表对比当前未开放。');
  if (!db.select({ id: schema.chats.id }).from(schema.chats)
    .where(and(eq(schema.chats.id, ctx.chatId), eq(schema.chats.userId, user.id))).get()) return fail('对话不存在或无权访问。');
  const data = parseComparison(args);
  if (!data) return fail('数据格式无效:需要标题、共同单位、数据出处。柱状图为 2–12 项;折线图需递增横轴、1–6 条同长度曲线,每条 2–120 点、至少两个有效数值,总计不超过 600 点。请用文字说明,本轮不要重试。');
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
