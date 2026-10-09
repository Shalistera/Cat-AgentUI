import { useId, useState } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { LineComparisonChart } from './LineComparisonChart';
import type { BarComparison, DataComparison } from '../types';
import { locale, t } from '../i18n';

function formatValue(value: number): string {
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 1e9)) return String(value);
  return value.toLocaleString(locale, { maximumSignificantDigits: 15 });
}

/** Fixed, zero-based scale shared by all categories, including negative values. */
export function comparisonScale(values: number[]) {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  return { min, max, span, position: (value: number) => (value - min) / span * 100 };
}

export function ComparisonChart({ data }: { data: DataComparison }) {
  return data?.chart === 'line' ? <LineComparisonChart data={data} /> : <BarComparisonChart data={data} />;
}

function BarComparisonChart({ data }: { data: BarComparison }) {
  const [table, setTable] = useState(false);
  const titleId = useId();
  // Imported/malformed messages should never take down the conversation.
  if (!data || typeof data.title !== 'string' || typeof data.unit !== 'string' || typeof data.source !== 'string'
    || !Array.isArray(data.items) || data.items.length < 2 || data.items.length > 12
    || data.items.some((i) => !i || typeof i.label !== 'string' || typeof i.value !== 'number'
      || !Number.isFinite(i.value) || Math.abs(i.value) > 1e15)) return null;
  const scale = comparisonScale(data.items.map((i) => i.value));
  const zero = scale.position(0);
  const ticks = scale.min < 0 && scale.max > 0
    ? [scale.min, 0, scale.max]
    : [scale.min, scale.min + scale.span];
  return (
    <section className="my-3 min-w-0 overflow-hidden rounded-xl border border-line bg-bg1" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 id={titleId} className="break-words text-sm font-semibold text-tx">{data.title}</h3>
          <p className="mt-1 break-words text-xs text-tx3">{t('{count} 项对比 · 单位：{unit}', { count: data.items.length, unit: data.unit })}</p>
        </div>
        <button type="button" onClick={() => setTable((v) => !v)} aria-pressed={table}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-tx2 hover:bg-bg2"
          aria-label={table ? t('切换为柱状图') : t('切换为数据表')}>
          {table ? <BarChart3 size={13} /> : <Table2 size={13} />}{table ? t('图表') : t('数据')}
        </button>
      </div>
      {table ? (
        <div className="overflow-x-auto px-4 py-3">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{t('{title}，单位：{unit}', { title: data.title, unit: data.unit })}</caption>
            <thead><tr className="border-b border-line text-tx3"><th scope="col" className="py-2 font-medium">{t('类别')}</th><th scope="col" className="py-2 text-right font-medium">{t('数值')}</th></tr></thead>
            <tbody>{data.items.map((item, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <th scope="row" className="break-words py-2 pr-3 font-normal text-tx2">{item.label}</th>
                <td className="py-2 text-right tabular-nums text-tx">{formatValue(item.value)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-4">
          <ul className="space-y-3" aria-label={t('{title}柱状图', { title: data.title })}>
            {data.items.map((item, i) => {
              const end = scale.position(item.value);
              return (
                <li key={i} title={t('{label}：{value} {unit}', { label: item.label, value: formatValue(item.value), unit: data.unit })}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                    <span className="min-w-0 break-words text-tx2">{item.label}</span>
                    <span className="shrink-0 tabular-nums text-tx">{formatValue(item.value)}</span>
                  </div>
                  <div className="relative h-5 rounded-sm bg-bg2" aria-hidden="true">
                    <span className="absolute inset-y-0 w-px bg-tx3/50" style={{ left: `${zero}%` }} />
                    {item.value === 0
                      ? <span className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-acc" style={{ left: `${zero}%` }} />
                      : <span className="absolute inset-y-0.5 rounded-sm bg-acc" style={{ left: `${Math.min(zero, end)}%`, width: `${Math.abs(end - zero)}%` }} />}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="relative mt-3 h-4 text-[10px] tabular-nums text-tx3" aria-hidden="true">
            {ticks.map((tick, i) => <span key={i} className="absolute"
              style={i === 0 ? { left: 0 } : i === ticks.length - 1 ? { right: 0 } : { left: `${zero}%`, transform: 'translateX(-50%)' }}>
              {formatValue(tick)}
            </span>)}
          </div>
        </div>
      )}
      <p className="break-words border-t border-line bg-bg0 px-4 py-2.5 text-[11px] leading-relaxed text-tx3">{t('数据来源：{source}', { source: data.source })}</p>
    </section>
  );
}
