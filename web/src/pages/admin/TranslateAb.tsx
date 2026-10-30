import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, RefreshCw, Scale, Trash2 } from 'lucide-react';
import { api, errMsg, fmtDate, fmtDuration, fmtTime, fmtTokens } from '../../api';
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, Pager, SegmentedControl, Select, Spinner, Td, Th, ToggleRow,
  confirmDialog, toast,
} from '../../components/ui';
import { t, tServer } from '../../i18n';
import type {
  AppSettings, ModelInfo, TranslateAbPair, TranslateAbTrial, TranslateAbTrialRow, TranslateAbVote, TranslateConfig,
  TranslateModel,
} from '../../types';
import { ModelSelect, SaveBar, SectionIntro, TranslatePresetFields, useSettingsForm, useTextModels } from './settings-common';

/* 翻译 A/B — settings and results of the translation workshop's blind
   comparison (server/src/translate-ab.ts). Model A is always blue, model B
   always orange, ties neutral grey: the colours follow the slot everywhere on
   this page, so a glance at any bar or badge says which model it means. */

type Slot = 'a' | 'b';
interface Form { enabled: boolean; rate: string; a: TranslateModel | null; b: TranslateModel | null }

const toForm = (r: AppSettings): Form => {
  const ab = r.translateAb ?? { enabled: false, rate: 20, a: null, b: null };
  return { enabled: ab.enabled, rate: String(ab.rate), a: ab.a, b: ab.b };
};

const RATE_PRESETS = [5, 10, 20, 50, 100];
const SMALL_SAMPLE = 20;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const slotName = (s: Slot) => (s === 'a' ? t('模型 A') : t('模型 B'));
const slotColor = (s: Slot | 'tie') => `var(--ab-${s})`;

function reasoningLabel(r: string | null): string {
  if (r === null) return t('无思考档位');
  return r === 'off' ? t('不思考') : t('思考 · {level}', { level: r });
}
const MODE_LABEL: Record<TranslateAbTrialRow['mode'], string> = {
  default: t('默认'), fast: t('快速'), think: t('思考'),
};

function Dot({ slot }: { slot: Slot | 'tie' }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: slotColor(slot) }} aria-hidden />;
}

export default function TranslateAb() {
  const { saved, form, set, dirty, busy, reset, save } = useSettingsForm(toForm);
  const textModels = useTextModels();

  const [languages, setLanguages] = useState<Record<string, string>>({});
  useEffect(() => {
    api.get<TranslateConfig>('/api/translate/config').then((c) => setLanguages(c.languages)).catch(() => {});
  }, []);
  const langName = useCallback((code: string) => (code === 'auto' ? t('自动检测') : tServer(languages[code] ?? '') || code), [languages]);

  // ---- results ----
  const [pairs, setPairs] = useState<TranslateAbPair[] | null>(null);
  const [filter, setFilter] = useState<{ pair: string; voted: '1' | '0'; page: number }>({ pair: '', voted: '1', page: 0 });
  const [trials, setTrials] = useState<{ items: TranslateAbTrialRow[]; total: number; pageSize: number } | null>(null);
  const [detail, setDetail] = useState<TranslateAbTrial | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const loadPairs = useCallback(() => {
    api.get<{ pairs: TranslateAbPair[] }>('/api/admin/translate-ab/summary')
      .then((r) => setPairs(r.pairs))
      .catch((e) => { toast(errMsg(e), 'err'); setPairs([]); });
  }, []);
  useEffect(loadPairs, [loadPairs]);

  const loadTrials = useCallback(() => {
    const [a, b] = filter.pair ? filter.pair.split('|') : [];
    const q = new URLSearchParams({ voted: filter.voted, page: String(filter.page), ...(a && b ? { a, b } : {}) });
    api.get<{ items: TranslateAbTrialRow[]; total: number; pageSize: number }>(`/api/admin/translate-ab/trials?${q}`)
      .then(setTrials)
      .catch((e) => toast(errMsg(e), 'err'));
  }, [filter]);
  useEffect(loadTrials, [loadTrials]);

  const refresh = () => { loadPairs(); loadTrials(); };

  async function clear(pair?: TranslateAbPair) {
    const ok = await confirmDialog(
      pair ? t('删除这组对比记录?') : t('清空全部 A/B 记录?'),
      pair
        ? t('「{a}」对「{b}」的所有投票和保存的译文都会删除,无法恢复。', { a: pair.labelA, b: pair.labelB })
        : t('所有模型组合的投票和保存的译文都会删除,无法恢复。'),
    );
    if (!ok) return;
    try {
      const q = pair ? `?${new URLSearchParams({ a: pair.modelA, b: pair.modelB })}` : '';
      const r = await api.del<{ deleted: number }>(`/api/admin/translate-ab/trials${q}`);
      toast(t('已删除 {n} 条记录', { n: r.deleted }), 'ok');
      // A new filter object reloads the list; the summary reloads here.
      setFilter((f) => ({ ...f, pair: pair && f.pair !== `${pair.modelA}|${pair.modelB}` ? f.pair : '', page: 0 }));
      loadPairs();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function open(id: string) {
    setOpening(id);
    try { setDetail(await api.get<TranslateAbTrial>(`/api/admin/translate-ab/trials/${id}`)); }
    catch (e) { toast(errMsg(e), 'err'); }
    finally { setOpening(null); }
  }

  const currentKey = saved?.translateAb?.a && saved.translateAb.b
    ? `${saved.translateAb.a.modelId}|${saved.translateAb.b.modelId}` : '';
  const pairLabel = (p: { labelA: string; labelB: string }) => `${p.labelA}  vs  ${p.labelB}`;

  if (!form || !textModels) return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;

  const rate = Number(form.rate);
  const rateValid = Number.isInteger(rate) && rate >= 1 && rate <= 100;
  const submit = () => {
    if (!rateValid) { toast(t('出现率请填 1–100 之间的整数'), 'err'); return; }
    if (form.enabled && (!form.a || !form.b)) { toast(t('开启前请选好模型 A 和模型 B'), 'err'); return; }
    void save({ translateAb: { enabled: form.enabled, rate, a: form.a, b: form.b } }).then((r) => { if (r) loadPairs(); });
  };

  return (
    <div className="ab-palette mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <SectionIntro title={t('翻译 A/B 对比')}>
        {t('让一部分翻译同时交给两个模型,用户在两份译文里盲选更好的一份。用投票结果决定翻译工坊该用哪个模型。')}
      </SectionIntro>

      <Card title={t('对比设置')} desc={t('命中的翻译会同时调用模型 A 和模型 B。两份译文左右顺序随机、不显示模型名;用户选中的那份就是这次的译文。')}>
        <div className="space-y-4">
          <ToggleRow
            label={t('开启 A/B 对比')}
            desc={!form.enabled || !rateValid ? t('关闭时翻译工坊照常工作,已有投票记录保留。')
              : rate === 100 ? t('每次翻译都会变成对比。')
              : rate > 50 ? t('大约 {p}% 的翻译会变成对比。', { p: rate })
              : t('大约每 {n} 次翻译出现 1 次对比。', { n: Math.round(100 / rate) })}
            checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={busy}
          />
          <div className="grid gap-4 md:grid-cols-2">
            {(['a', 'b'] as const).map((slot) => (
              <SlotEditor key={slot} slot={slot} entry={form[slot]} other={form[slot === 'a' ? 'b' : 'a']}
                models={textModels} disabled={busy} onChange={(v) => set({ [slot]: v })} />
            ))}
          </div>
          <Field label={t('出现率')} hint={t('每次翻译以这个概率变成 A/B 对比。对比时两个模型都会调用,这次翻译的用量约为平时的两倍,计入该用户的配额。')}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-28">
                <Input type="number" min={1} max={100} step={1} inputMode="numeric" value={form.rate} disabled={busy}
                  onChange={(e) => set({ rate: e.target.value })} className="pr-8 tabular-nums" aria-label={t('出现率')} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-tx3">%</span>
              </div>
              {RATE_PRESETS.map((n) => (
                <button key={n} type="button" disabled={busy} onClick={() => set({ rate: String(n) })}
                  className={`h-7 cursor-pointer rounded-full border px-2.5 text-xs font-medium tabular-nums transition-colors ${
                    form.rate === String(n) ? 'border-acc bg-acc/10 text-acc' : 'border-line bg-bg1 text-tx2 hover:border-line2 hover:text-tx'}`}>
                  {n}%
                </button>
              ))}
            </div>
            {!rateValid && <p className="mt-1.5 text-xs text-err">{t('出现率请填 1–100 之间的整数')}</p>}
          </Field>
          <p className="text-xs leading-relaxed text-tx3">
            {t('用户选「默认」时,两个模型按上面的模式与等级调用;选「快速」或「思考」时按用户的选择。某个模型对该用户不可用(服务商权限、使用限额)时,这次自动按普通翻译处理。翻译用哪些模型本身在')}
            <Link to="/admin/task-models" className="mx-0.5 text-acc hover:underline">{t('任务模型')}</Link>
            {t('中设置。')}
          </p>
        </div>
      </Card>

      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />

      <Card
        title={t('投票结果')}
        desc={t('按模型组合汇总。胜率不计「差不多」;票数少时结论不稳定。')}
        actions={(
          <>
            <Button variant="ghost" size="sm" onClick={refresh}><RefreshCw size={13} />{t('刷新')}</Button>
            <Button variant="danger" size="sm" disabled={!pairs?.length} onClick={() => void clear()}>
              <Trash2 size={13} />{t('清空记录')}
            </Button>
          </>
        )}
      >
        {pairs === null ? (
          <div className="flex justify-center py-10 text-tx3"><Spinner className="h-5 w-5" /></div>
        ) : pairs.length === 0 ? (
          <EmptyState icon={<Scale size={20} />} title={t('还没有对比记录')}
            hint={t('开启 A/B 对比后,用户翻译时会按出现率看到两份译文并投票,结果会汇总在这里。')} />
        ) : (
          <div className="space-y-4">
            {pairs.map((p) => {
              const key = `${p.modelA}|${p.modelB}`;
              return (
                <PairResult key={key} pair={p} current={key === currentKey}
                  onShowRecords={() => {
                    setFilter({ pair: key, voted: '1', page: 0 });
                    document.getElementById('ab-records')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  onClear={() => void clear(p)} />
              );
            })}
          </div>
        )}
      </Card>

      <div id="ab-records" className="scroll-mt-4">
        <Card
          title={t('投票记录')}
          desc={t('点一条查看原文和两份译文。没投票的对比不保存内容,只计入出现次数。')}
          flush
          actions={(
            <SegmentedControl<'1' | '0'>
              value={filter.voted}
              onChange={(v) => setFilter((f) => ({ ...f, voted: v, page: 0 }))}
              options={[{ value: '1', label: t('已投票') }, { value: '0', label: t('全部') }]}
            />
          )}
        >
          {pairs && pairs.length > 1 && (
            <div className="border-b border-line px-5 py-3">
              <Select value={filter.pair} onChange={(e) => setFilter((f) => ({ ...f, pair: e.target.value, page: 0 }))}
                aria-label={t('模型组合')}>
                <option value="">{t('全部模型组合')}</option>
                {pairs.map((p) => <option key={`${p.modelA}|${p.modelB}`} value={`${p.modelA}|${p.modelB}`}>{pairLabel(p)}</option>)}
              </Select>
            </div>
          )}
          {!trials ? (
            <div className="flex justify-center py-10 text-tx3"><Spinner className="h-5 w-5" /></div>
          ) : trials.items.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-tx3">{filter.voted === '1' ? t('还没有投票') : t('还没有对比记录')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <Th>{t('时间')}</Th>
                    <Th>{t('用户')}</Th>
                    <Th>{t('语言')}</Th>
                    <Th className="w-full">{t('原文')}</Th>
                    <Th>{t('用户选择')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {trials.items.map((r) => (
                    <tr key={r.id} className="group cursor-pointer transition-colors hover:bg-bg2/60" onClick={() => void open(r.id)}>
                      <Td className="whitespace-nowrap tabular-nums">{fmtTime(r.createdAt)}</Td>
                      <Td className="whitespace-nowrap font-medium text-tx">{r.user.displayName || r.user.username}</Td>
                      <Td className="whitespace-nowrap">{langName(r.sourceLang)} → {langName(r.targetLang)}</Td>
                      <Td className="max-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate ${r.preview ? 'text-tx' : 'text-tx3'}`}>
                            {r.preview ?? (r.vote ? t('(内容未保存)') : t('(未投票,不保存内容)'))}
                          </span>
                          {opening === r.id ? <Spinner className="h-3.5 w-3.5 shrink-0 text-tx3" /> : <ChevronRight size={13} className="shrink-0 text-tx3" />}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap"><VoteBadge vote={r.vote} /></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {trials && trials.total > trials.pageSize && (
            <div className="border-t border-line px-5 py-3">
              <Pager page={filter.page} pages={Math.ceil(trials.total / trials.pageSize)}
                onChange={(page) => setFilter((f) => ({ ...f, page }))} />
            </div>
          )}
        </Card>
      </div>

      <TrialDetail trial={detail} onClose={() => setDetail(null)} langName={langName} />
    </div>
  );
}

function SlotEditor({ slot, entry, other, models, disabled, onChange }: {
  slot: Slot; entry: TranslateModel | null; other: TranslateModel | null; models: ModelInfo[]; disabled?: boolean;
  onChange(next: TranslateModel | null): void;
}) {
  const model = models.find((m) => m.id === entry?.modelId);
  return (
    <fieldset className="min-w-0 space-y-2.5 rounded-lg border border-line p-3">
      <legend className="flex items-center gap-1.5 px-1 text-[13px] font-medium text-tx"><Dot slot={slot} />{slotName(slot)}</legend>
      <ModelSelect
        value={entry?.modelId ?? ''} disabled={disabled} emptyLabel={t('选择模型…')}
        models={models.filter((m) => m.id !== other?.modelId)}
        // A new model has its own ladder: keep the mode, drop the tier.
        onChange={(id) => onChange(id ? { modelId: id, mode: entry?.mode ?? 'fast', reasoningEffort: null } : null)}
      />
      {entry && <TranslatePresetFields entry={entry} model={model} disabled={disabled} onChange={(p) => onChange({ ...entry, ...p })} />}
    </fieldset>
  );
}

/** Share of votes as one diverging bar: A wins | ties | B wins. */
function VoteBar({ pair }: { pair: TranslateAbPair }) {
  const [hover, setHover] = useState<Slot | 'tie' | null>(null);
  const segments = ([
    { key: 'a', n: pair.winsA, label: t('模型 A 更好') },
    { key: 'tie', n: pair.ties, label: t('差不多') },
    { key: 'b', n: pair.winsB, label: t('模型 B 更好') },
  ] as const).map((s) => ({ ...s, share: pair.voted ? s.n / pair.voted : 0 }));
  const visible = segments.filter((s) => s.n > 0);
  const active = segments.find((s) => s.key === hover);
  return (
    <div>
      <div className="relative" role="img"
        aria-label={segments.map((s) => `${s.label} ${s.n} (${pct(s.share)})`).join(', ')}>
        {active && (
          <div className="pointer-events-none absolute bottom-full z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-line2 bg-bg1 px-2 py-1 text-[11px] text-tx shadow-md"
            style={{ left: `${(segments.slice(0, segments.indexOf(active)).reduce((s, x) => s + x.share, 0) + active.share / 2) * 100}%` }}>
            <span className="inline-flex items-center gap-1.5"><Dot slot={active.key} />{active.label}</span>
            <span className="ml-2 tabular-nums text-tx2">{t('{n} 票', { n: active.n })} · {pct(active.share)}</span>
          </div>
        )}
        {visible.length ? (
          <div className="flex gap-[2px]" onMouseLeave={() => setHover(null)}>
            {visible.map((s, i) => (
              // The hit area is taller than the 10px mark.
              <div key={s.key} className="flex h-6 min-w-[3px] cursor-default items-center" style={{ flexGrow: s.n, flexBasis: 0 }}
                onMouseEnter={() => setHover(s.key)}>
                <div className={`h-2.5 w-full ${i === 0 ? 'rounded-l-[4px]' : ''} ${i === visible.length - 1 ? 'rounded-r-[4px]' : ''} ${
                  hover && hover !== s.key ? 'opacity-50' : ''} transition-opacity`} style={{ background: slotColor(s.key) }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-6 items-center"><div className="h-2.5 w-full rounded-[4px] bg-bg2" /></div>
        )}
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
        {segments.map((s, i) => (
          <div key={s.key} className={`flex min-w-0 items-center gap-1.5 ${i === 1 ? 'justify-center' : i === 2 ? 'justify-end' : ''}`}>
            <Dot slot={s.key} />
            <span className="truncate text-tx2">{s.label}</span>
            <span className="tabular-nums font-medium text-tx">{s.n}</span>
            {pair.voted > 0 && <span className="tabular-nums text-tx3">{pct(s.share)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function PairResult({ pair, current, onShowRecords, onClear }: {
  pair: TranslateAbPair; current: boolean; onShowRecords(): void; onClear(): void;
}) {
  const decisive = pair.winsA + pair.winsB;
  const rateA = decisive ? pair.winsA / decisive : null;
  const leader: Slot | 'even' | null = rateA === null ? null : rateA > 0.5 ? 'a' : rateA < 0.5 ? 'b' : 'even';
  const firstShare = decisive ? pair.firstPicked / decisive : null;
  const kpi = (label: string, value: ReactNode, hint?: string) => (
    <div className="min-w-0 rounded-md bg-bg0 px-3 py-2">
      <dt className="truncate text-[11px] text-tx3">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-medium tabular-nums text-tx">{value}</dd>
      {hint && <dd className="mt-0.5 text-[11px] leading-snug text-tx3">{hint}</dd>}
    </div>
  );
  const both = (a: string, b: string) => (
    <span className="inline-flex items-center gap-1.5"><Dot slot="a" />{a}<span className="text-tx3">·</span><Dot slot="b" />{b}</span>
  );
  return (
    <div className={`space-y-4 rounded-lg border p-4 ${current ? 'border-acc/40' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {(['a', 'b'] as const).map((slot, i) => (
          <div key={slot} className="flex min-w-0 items-center gap-1.5">
            {i === 1 && <span className="mr-1.5 text-xs text-tx3">vs</span>}
            <Dot slot={slot} />
            <span className="shrink-0 text-xs text-tx3">{slotName(slot)}</span>
            <span className={`truncate text-[13px] font-medium ${(slot === 'a' ? pair.removedA : pair.removedB) ? 'text-tx3 line-through' : 'text-tx'}`}
              title={(slot === 'a' ? pair.removedA : pair.removedB) ? t('模型已删除') : undefined}>
              {slot === 'a' ? pair.labelA : pair.labelB}
            </span>
          </div>
        ))}
        {current && <span className="ml-auto"><Badge tone="acc">{t('当前对比')}</Badge></span>}
      </div>

      {leader ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="stat-value text-2xl font-semibold tracking-tight tabular-nums text-tx">
            {pct(leader === 'b' ? 1 - rateA! : rateA!)}
          </span>
          <span className="text-sm text-tx2">
            {leader === 'even' ? t('两个模型打平') : t('{slot} 胜率', { slot: slotName(leader) })}
          </span>
          <span className="text-xs text-tx3">{t('({n} 票分出胜负)', { n: decisive })}</span>
          {pair.voted < SMALL_SAMPLE && <Badge tone="warn">{t('票数较少,仅供参考')}</Badge>}
        </div>
      ) : (
        <p className="text-sm text-tx2">
          {pair.voted ? t('目前都选了「差不多」,还分不出胜负。') : t('已出现 {n} 次,还没有人投票。', { n: pair.shown })}
        </p>
      )}

      <VoteBar pair={pair} />

      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {kpi(t('投票 / 出现'), `${pair.voted} / ${pair.shown}`, t('投票率 {p}', { p: pct(pair.shown ? pair.voted / pair.shown : 0) }))}
        {kpi(t('先显示的一份被选'), firstShare === null ? '—' : pct(firstShare), t('接近 50% 说明左右位置没影响选择'))}
        {kpi(t('平均耗时'), both(fmtDuration(pair.avgDurationA), fmtDuration(pair.avgDurationB)))}
        {kpi(t('平均 tokens'), both(fmtTokens(pair.avgTokensA), fmtTokens(pair.avgTokensB)))}
      </dl>

      <div className="flex flex-wrap items-center gap-2 text-xs text-tx3">
        <span className="tabular-nums">{fmtDate(pair.firstAt)} – {fmtDate(pair.lastAt)}</span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="dangerGhost" size="xs" onClick={onClear}><Trash2 size={12} />{t('删除这组')}</Button>
          <Button variant="outline" size="xs" onClick={onShowRecords}>{t('查看这组记录')}<ChevronRight size={12} /></Button>
        </span>
      </div>
    </div>
  );
}

function VoteBadge({ vote }: { vote: TranslateAbVote | null }) {
  if (!vote) return <span className="text-tx3">{t('未投票')}</span>;
  if (vote === 'tie') return <Badge><Dot slot="tie" />{t('差不多')}</Badge>;
  return <Badge><Dot slot={vote} />{vote === 'a' ? t('模型 A 更好') : t('模型 B 更好')}</Badge>;
}

function TrialDetail({ trial, onClose, langName }: {
  trial: TranslateAbTrial | null; onClose(): void; langName(code: string): string;
}) {
  const sides = useMemo(() => {
    if (!trial) return [];
    return (['a', 'b'] as const).map((slot) => ({
      slot,
      label: slot === 'a' ? trial.labelA : trial.labelB,
      reasoning: slot === 'a' ? trial.reasoningA : trial.reasoningB,
      tokens: slot === 'a' ? trial.tokensA : trial.tokensB,
      duration: slot === 'a' ? trial.durationA : trial.durationB,
      text: slot === 'a' ? trial.outputA : trial.outputB,
      position: (slot === 'b') === trial.swapped ? 1 : 2,
    }));
  }, [trial]);
  if (!trial) return null;
  const user = trial.user.displayName || trial.user.username;
  return (
    <Modal open onClose={onClose} wide className="ab-palette sm:max-w-4xl" title={t('对比详情')}
      desc={`${user} · ${fmtTime(trial.createdAt)} · ${langName(trial.sourceLang)} → ${langName(trial.targetLang)} · ${t('用户模式:{mode}', { mode: MODE_LABEL[trial.mode] })}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-tx2">
          <span>{t('用户选择')}</span><VoteBadge vote={trial.vote} />
          {trial.votedAt && <span className="text-tx3 tabular-nums">{fmtTime(trial.votedAt)}</span>}
        </div>
        {trial.sourceText === null ? (
          <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-xs leading-relaxed text-tx3">
            {trial.vote
              ? t('这次投票时内容已过期(服务重启或超过 12 小时),只保留了结果。')
              : t('用户没有投票,原文和译文不会保存。')}
          </p>
        ) : (
          <>
            <section>
              <h3 className="mb-1.5 text-xs font-medium text-tx3">{t('原文')} · {t('{n} 字', { n: trial.sourceChars.toLocaleString() })}</h3>
              <div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg0 px-3 py-2.5 text-[13px] leading-relaxed text-tx2">
                {trial.sourceText}
              </div>
              {trial.scene && <p className="mt-1.5 text-xs text-tx3">{t('场景:{scene}', { scene: trial.scene })}</p>}
            </section>
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {sides.map((s) => {
            const won = trial.vote === s.slot;
            return (
              <section key={s.slot} className={`flex min-w-0 flex-col rounded-lg border ${won ? 'border-acc/50 ring-1 ring-acc/30' : 'border-line'}`}>
                <div className="space-y-1 border-b border-line px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <Dot slot={s.slot} />
                    <span className="text-xs text-tx3">{slotName(s.slot)}</span>
                    <span className="min-w-0 truncate text-[13px] font-medium text-tx">{s.label}</span>
                    {won && <span className="ml-auto shrink-0"><Badge tone="acc">{t('用户选的')}</Badge></span>}
                  </div>
                  <div className="text-[11px] tabular-nums text-tx3">
                    {t('显示在第 {n} 位', { n: s.position })} · {reasoningLabel(s.reasoning)} · {fmtTokens(s.tokens)} tokens · {fmtDuration(s.duration)}
                  </div>
                </div>
                {s.text !== null && (
                  <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[13px] leading-relaxed text-tx">{s.text}</div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
