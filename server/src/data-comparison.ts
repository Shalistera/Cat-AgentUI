import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { getAgentSettings, policyAllows, userWantsAgentTools } from './agent-settings.js';
import type { DataComparison, MessagePart, ToolDef } from './types.js';

export const COMPARE_DATA_TOOL = 'compare_data';
export const DATA_COMPARISON_PROMPT = [
  '[图表对比]',
  '用户要求图表、曲线、趋势或按时间展示数值比较时,先收集必要数据,再调用 compare_data,最后写简短结论。需要联网就先检索来源。数据足够后优先出图,不要先写长篇背景科普、重复表格或 ASCII 时间轴;出图前最多一句进度说明。此工具不依赖工作区、命令执行或沙盒。',
  '除非用户明确要求详述,图后只写 2–4 条关键差异及必要的来源/局限说明,正文约 200–400 字即可;不要逐时间段重复描述图上已有信息。闲聊和没有比较需求的回答照常回复,不用图表。',
  '图表数值必须有依据,先明确比较条件、共同单位及来源。只有少量峰值、范围或时长时,不能编造成完整时间曲线;找不到逐点数据或可核实计算依据时,简短说明缺口并给已有事实,不要为了出图猜数。估算必须明确依据和假设,不能当作实测数据或个人效果预测。',
].join('\n');
export const COMPARE_DATA_DEF: ToolDef = {
  name: COMPARE_DATA_TOOL,
  description: '比较有依据的同指标、同单位数值并立即展示图表和数据表。分类比较用 items(2–12 项);连续/时间序列用 chart=line、xLabel、严格递增的数值 x、series(1–6 条等长曲线,每条 2–120 点,合计最多 600 点),可用 xLabels 标注时间。缺失值用 null。每轮最多一次,无需沙盒或 HTML。先出图再简短解释,不要重复整组数据。',
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
