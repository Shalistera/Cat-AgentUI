import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { getAgentSettings, policyAllows, userWantsAgentTools } from './agent-settings.js';
import type { DataComparison, MessagePart, ToolDef } from './types.js';

export const COMPARE_DATA_TOOL = 'compare_data';
export const COMPARE_DATA_DEF: ToolDef = {
  name: COMPARE_DATA_TOOL,
  description: '比较同一指标和单位的数据并直接展示图表/数据表。分类比较用 items(2–12 项柱状图);时间或连续数值上的曲线对比用 chart=line、xLabel、严格递增的数值 x、series(1–6 条曲线,每条与 x 等长,2–120 点,总计最多 600 点),可用 xLabels 标注时间。缺失值用 null,至少两个有效点。优先已有关键采样点,不要为平滑额外插值。仅用于用户要求的数据分析/方案数值比较,或明确要求图表;数据来自用户、已读取资料或实际计算结果,先统一单位和统计口径。不要为闲聊、新闻、单个数字、无关指标或猜测的数据调用。每轮最多一次;成功后简短解释结论,无需重复表格或生成 HTML;失败时用文字说明,不要重复调用。',
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
