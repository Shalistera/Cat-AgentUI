import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { ChartNoAxesCombined, Table2 } from 'lucide-react';
import type { LineComparison } from '../types';
import { t } from '../i18n';
import { formatAxisValue, formatChartValue, lineDomain, linePath, nearestXIndex, validLineComparison } from '../chartGeometry';

const COLORS = Array.from({ length: 6 }, (_, i) => `var(--comparison-${i + 1})`);

export function LineComparisonChart({ data }: { data: LineComparison }) {
  return validLineComparison(data) ? <ValidatedLineChart data={data} /> : null;
}

function ValidatedLineChart({ data }: { data: LineComparison }) {
  const [table, setTable] = useState(false);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(640);
  const container = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const readoutId = useId();
  useEffect(() => {
    if (!container.current) return;
    const measure = () => {
      const w = container.current?.getBoundingClientRect().width;
      if (w && Number.isFinite(w)) setWidth(Math.max(180, w));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [table]);
  useEffect(() => { setActive(null); setHidden(new Set()); }, [data]);

  const selected = active !== null && active < data.x.length ? active : null;
  const height = width < 480 ? 260 : 310;
  const left = 60, right = 14, top = 16, bottom = 52;
  const plotWidth = Math.max(1, width - left - right), plotHeight = height - top - bottom;
  // Keep the same axes when hiding a series, so visual comparisons remain valid.
  const domain = lineDomain(data.series.flatMap((s) => s.values.filter((n): n is number => n !== null)));
  const xMin = data.x[0], xMax = data.x[data.x.length - 1];
  const px = (x: number) => left + (x - xMin) / (xMax - xMin) * plotWidth;
  const py = (y: number) => top + (1 - domain.ratio(y)) * plotHeight;
  const labelX = (i: number) => data.xLabels?.[i] ?? formatChartValue(data.x[i]);
  const visible = data.series.map((series, index) => ({ ...series, index })).filter((s) => !hidden.has(s.index));
  // Select by physical distance rather than index, including irregular samples.
  const tickCount = Math.max(2, Math.min(8, Math.floor(plotWidth / 85) + 1));
  const xTicks = [...new Set(Array.from({ length: tickCount }, (_, i) => nearestXIndex(data.x, xMin + (xMax - xMin) * i / (tickCount - 1))))]
    .filter((index, i, all) => i === 0 || i === all.length - 1 || (px(data.x[index]) - px(data.x[all[i - 1]]) >= 55 && px(xMax) - px(data.x[index]) >= 55));
  const select = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * width;
    const ratio = Math.max(0, Math.min(1, (x - left) / plotWidth));
    setActive(nearestXIndex(data.x, xMin + ratio * (xMax - xMin)));
  };

  return (
    <section className="comparison-line my-3 min-w-0 overflow-hidden rounded-xl border border-line bg-bg1" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 id={titleId} className="break-words text-sm font-semibold text-tx">{data.title}</h3>
          <p className="mt-1 text-xs text-tx3">{t('{count} 条曲线 · 单位：{unit}', { count: data.series.length, unit: data.unit })}</p>
        </div>
        <button type="button" onClick={() => setTable((v) => !v)} aria-pressed={table}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-tx2 hover:bg-bg2"
          aria-label={table ? t('切换为折线图') : t('切换为数据表')}>
          {table ? <ChartNoAxesCombined size={13} /> : <Table2 size={13} />}{table ? t('图表') : t('数据')}
        </button>
      </div>
      {table ? (
        <div className="max-h-96 overflow-auto px-4 py-3">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{t('{title}，单位：{unit}，缺失值显示为破折号', { title: data.title, unit: data.unit })}</caption>
            <thead className="sticky top-0 bg-bg1"><tr className="border-b border-line text-tx3">
              <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">{data.xLabel}</th>
              {data.series.map((series, i) => <th key={i} scope="col" className="min-w-24 px-2 py-2 text-right font-medium">{series.label}</th>)}
            </tr></thead>
            <tbody>{data.x.map((_, i) => <tr key={i} className="border-b border-line last:border-0">
              <th scope="row" className="whitespace-nowrap py-2 pr-3 font-normal text-tx2">{labelX(i)}</th>
              {data.series.map((series, j) => <td key={j} className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-tx">{formatChartValue(series.values[i])}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="px-3 pt-3 sm:px-4">
          <div ref={container}>
            <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" tabIndex={0}
              className="block rounded outline-offset-2 focus-visible:outline-2 focus-visible:outline-acc"
              aria-label={t('{title}折线图。横轴：{xLabel}，纵轴单位：{unit}。左右方向键选择数据点，Home 和 End 跳到首尾。', { title: data.title, xLabel: data.xLabel, unit: data.unit })}
              aria-describedby={readoutId}
              onPointerMove={select} onPointerDown={select}
              onFocus={() => setActive((v) => v ?? 0)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
                event.preventDefault();
                setActive((v) => event.key === 'Escape' ? null : event.key === 'Home' ? 0 : event.key === 'End' ? data.x.length - 1
                  : Math.max(0, Math.min(data.x.length - 1, (v ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))));
              }}>
              {domain.ticks.map((tick, i) => <g key={i}>
                <line x1={left} x2={width - right} y1={py(tick)} y2={py(tick)} stroke={tick === 0 ? 'var(--color-line2)' : 'var(--color-line)'} />
                <text x={left - 9} y={py(tick)} dominantBaseline="middle" textAnchor="end" fontSize={11} fill="var(--color-tx3)">{formatAxisValue(tick)}</text>
              </g>)}
              {xTicks.map((index, i) => <text key={index} x={px(data.x[index])} y={height - bottom + 21}
                textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--color-tx3)">
                <title>{labelX(index)}</title>{labelX(index).length > 12 ? `${labelX(index).slice(0, 11)}…` : labelX(index)}
              </text>)}
              <text x={left + plotWidth / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--color-tx3)">{data.xLabel}</text>
              {visible.map((series) => <g key={series.index}>
                <path d={linePath(data.x, series.values, px, py)} fill="none" stroke={COLORS[series.index]} strokeWidth={2.3} strokeLinejoin="round" />
                {series.values.map((value, i) => value !== null && (i === 0 || series.values[i - 1] === null) && (i === series.values.length - 1 || series.values[i + 1] === null)
                  ? <circle key={i} cx={px(data.x[i])} cy={py(value)} r={3} fill={COLORS[series.index]} /> : null)}
              </g>)}
              {selected !== null && <g>
                <line x1={px(data.x[selected!])} x2={px(data.x[selected!])} y1={top} y2={height - bottom} stroke="var(--color-tx3)" strokeDasharray="3 4" />
                {visible.map((series) => series.values[selected!] !== null
                  ? <circle key={series.index} cx={px(data.x[selected!])} cy={py(series.values[selected!]!)} r={4} fill={COLORS[series.index]} stroke="var(--color-bg1)" strokeWidth={1.5} /> : null)}
              </g>}
            </svg>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 py-3" aria-label={t('曲线图例')}>
            {data.series.map((series, i) => <button key={i} type="button" aria-pressed={!hidden.has(i)}
              disabled={visible.length === 1 && !hidden.has(i)} title={t(hidden.has(i) ? '显示{label}' : '隐藏{label}', { label: series.label })}
              onClick={() => setHidden((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; })}
              className={`flex min-w-0 cursor-pointer items-center gap-2 text-left text-xs text-tx2 disabled:cursor-default ${hidden.has(i) ? 'opacity-40 line-through' : ''}`}>
              <span className="h-0.5 w-4 shrink-0" style={{ background: COLORS[i] }} />
              <span className="break-words">{series.label}</span>
            </button>)}
          </div>
          <div id={readoutId} className="mb-3 rounded-md bg-bg2 px-3 py-2.5 text-xs text-tx2" aria-live="polite">
            {selected === null ? <span className="text-tx3">{t('悬停或点按查看数值，也可用左右方向键选择数据点。')}</span> : <>
              <p className="mb-2 font-medium">{t('{xLabel}：{value}', { xLabel: data.xLabel, value: labelX(selected!) })}</p>
              <dl className="grid gap-x-5 gap-y-1.5 sm:grid-cols-2">{visible.map((series) => <div key={series.index} className="flex min-w-0 items-baseline justify-between gap-3">
                <dt className="min-w-0 break-words"><span style={{ color: COLORS[series.index] }}>● </span>{series.label}</dt>
                <dd className="shrink-0 tabular-nums">{formatChartValue(series.values[selected!])}</dd>
              </div>)}</dl>
            </>}
          </div>
        </div>
      )}
      <p className="break-words border-t border-line bg-bg0 px-4 py-2.5 text-[11px] leading-relaxed text-tx3">{t('数据来源：{source}', { source: data.source })}</p>
    </section>
  );
}
