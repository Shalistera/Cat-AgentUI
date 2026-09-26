import type { LineComparison } from './types';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e15;
export function validLineComparison(data: LineComparison): boolean {
  return !!data && data.chart === 'line' && typeof data.title === 'string' && typeof data.unit === 'string'
    && typeof data.source === 'string' && typeof data.xLabel === 'string'
    && Array.isArray(data.x) && data.x.length >= 2 && data.x.length <= 120
    && data.x.every((x, i) => finite(x) && (i === 0 || x > data.x[i - 1]))
    && (data.xLabels === undefined || (Array.isArray(data.xLabels) && data.xLabels.length === data.x.length && data.xLabels.every((l) => typeof l === 'string')))
    && Array.isArray(data.series) && data.series.length >= 1 && data.series.length <= 6
    && data.series.length * data.x.length <= 600
    && data.series.every((s) => !!s && typeof s.label === 'string' && Array.isArray(s.values)
      && s.values.length === data.x.length && s.values.every((v) => v === null || finite(v))
      && s.values.filter((v) => v !== null).length >= 2);
}

export function formatChartValue(value: number | null): string {
  if (value === null) return '—';
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 1e9)) return String(value);
  return value.toLocaleString('zh-CN', { maximumSignificantDigits: 15 });
}
export function formatAxisValue(value: number): string {
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 1e6)) return Number(value.toPrecision(3)).toExponential().replace('e+', 'e');
  return Number(value.toPrecision(4)).toLocaleString('zh-CN', { maximumSignificantDigits: 4 });
}

/** Always includes zero; round outwards so peaks cannot be clipped. */
export function lineDomain(values: number[]) {
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const span = high - low || 1;
  const rawStep = span / 4 || span;
  const power = 10 ** Math.floor(Math.log10(rawStep)) || rawStep;
  const fraction = rawStep / power;
  const step = power * (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil((high || (low === 0 ? 1 : 0)) / step) * step;
  const ticks = Array.from({ length: Math.min(10, Math.round((max - min) / step)) + 1 }, (_, i) => Number((min + step * i).toPrecision(15)));
  return { min, max, ticks, ratio: (value: number) => (value - min) / (max - min) };
}

export function nearestXIndex(x: number[], target: number): number {
  let lo = 0, hi = x.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (x[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && target - x[lo - 1] <= x[lo] - target ? lo - 1 : lo;
}

/** Nulls are gaps, never interpolated connections. */
export function linePath(x: number[], values: (number | null)[], px: (x: number) => number, py: (y: number) => number): string {
  let penDown = false;
  return values.map((value, i) => {
    if (value === null) { penDown = false; return ''; }
    const command = penDown ? 'L' : 'M';
    penDown = true;
    return `${command}${px(x[i]).toFixed(2)},${py(value).toFixed(2)}`;
  }).join(' ');
}
