import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Card, Field, Select, Spinner, ToggleRow } from '../../components/ui';
import { t } from '../../i18n';
import type { AppSettings, ModelInfo, TranslateModel } from '../../types';
import { ModelSelect, SaveBar, SectionIntro, useSettingsForm, useTextModels } from './settings-common';

const CHAIN_MAX = 6;

/** Ordered model chain: the first is tried first, the rest are fallbacks. */
function ModelChain({ entries, mode, configureDefaults = false, onChange, models, disabled }: {
  entries: TranslateModel[]; mode: TranslateModel['mode']; configureDefaults?: boolean;
  onChange(next: TranslateModel[]): void; models: ModelInfo[]; disabled?: boolean;
}) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const remaining = models.filter((m) => !entries.some((entry) => entry.modelId === m.id));
  const update = (i: number, patch: Partial<TranslateModel>) =>
    onChange(entries.map((entry, index) => index === i ? { ...entry, ...patch } : entry));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {entries.length > 0 ? (
        <ol className="divide-y divide-line rounded-lg border border-line">
          {entries.map((entry, i) => {
            const m = byId.get(entry.modelId);
            const levels = m?.reasoningLevels ?? [];
            const staleEffort = !!entry.reasoningEffort && !levels.some((l) => l.value === entry.reasoningEffort);
            return (
              <li key={entry.modelId} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-xs tabular-nums text-tx3">{i + 1}.</span>
                  <span className={`min-w-0 flex-1 truncate ${m ? 'text-tx' : 'text-err'}`}>
                    {m ? `${m.displayName}(${m.providerName})` : t('模型已删除或停用({id})', { id: entry.modelId })}
                  </span>
                  <button type="button" title={t('上移')} disabled={disabled || i === 0}
                    className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                    onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                  <button type="button" title={t('下移')} disabled={disabled || i === entries.length - 1}
                    className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                    onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                  <button type="button" title={t('移除')} disabled={disabled}
                    className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-err disabled:opacity-30"
                    onClick={() => onChange(entries.filter((_, index) => index !== i))}><X size={13} /></button>
                </div>
                {configureDefaults && <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs text-tx3">
                    <span>{t('默认模式')}</span>
                    <Select value={entry.mode} disabled={disabled}
                      onChange={(e) => update(i, { mode: e.target.value as TranslateModel['mode'],
                        ...(e.target.value === 'fast' ? { reasoningEffort: null } : {}) })}>
                      <option value="fast">{t('快速')}</option>
                      <option value="think">{t('思考')}</option>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-tx3">
                    <span>{t('思考等级')}</span>
                    <Select value={entry.reasoningEffort ?? ''}
                      disabled={disabled || entry.mode === 'fast' || (!levels.length && !staleEffort)}
                      onChange={(e) => update(i, { reasoningEffort: e.target.value || null })}>
                      <option value="">{entry.mode === 'fast' ? t('不启用思考') : levels.length ? t('中间档位') : t('无可用思考档位')}</option>
                      {staleEffort && <option value={entry.reasoningEffort!} disabled>{t('已失效：{effort}', { effort: entry.reasoningEffort! })}</option>}
                      {levels.map((l) => <option key={l.value} value={l.value}>{l.label} ({l.value})</option>)}
                    </Select>
                  </label>
                </div>}
                {configureDefaults && staleEffort && <p className="text-xs text-err">{t('思考档位已变更,请重新选择等级或切换为快速模式。')}</p>}
                {configureDefaults && entry.mode === 'think' && !levels.length && !staleEffort && (
                  <p className="text-xs text-tx3">{t('该模型未配置思考档位,将按普通模式调用。可在模型设置中配置思考档位。')}</p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-tx3">{t('尚未选择模型,该模式对用户不可用。')}</p>
      )}
      {entries.length < CHAIN_MAX && (
        <Select value="" disabled={disabled || remaining.length === 0}
          onChange={(e) => { if (e.target.value) onChange([...entries, { modelId: e.target.value, mode, reasoningEffort: null }]); }}>
          <option value="">{remaining.length ? t('添加模型…') : t('没有更多可添加的模型')}</option>
          {remaining.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
          ))}
        </Select>
      )}
    </div>
  );
}

interface Form {
  titleModel: string;
  compactionModel: string;
  compactionFallback: boolean;
  followupEnabled: boolean;
  followupModel: string;
  translateDefault: TranslateModel[];
  translateFast: TranslateModel[];
  translateThink: TranslateModel[];
}

const toForm = (r: AppSettings): Form => ({
  titleModel: r.titleModelId ?? '',
  compactionModel: r.compactionModelId ?? '',
  compactionFallback: r.compactionFallbackToChat ?? false,
  followupEnabled: r.followupEnabled ?? true,
  followupModel: r.followupModelId ?? '',
  translateDefault: r.translateDefaultModels ?? [],
  // The fast / think chains carry no per-entry preset: the user's own choice
  // decides the effort there.
  translateFast: (r.translateFastModels ?? (r.translateFastModelIds ?? []).map((modelId) => ({ modelId })))
    .map((m) => ({ modelId: m.modelId, mode: 'fast', reasoningEffort: null })),
  translateThink: (r.translateThinkModels ?? (r.translateThinkModelIds ?? []).map((modelId) => ({ modelId })))
    .map((m) => ({ modelId: m.modelId, mode: 'think', reasoningEffort: null })),
});

export default function TaskModels() {
  const { form, set, dirty, busy, reset, save } = useSettingsForm(toForm);
  const textModels = useTextModels();

  if (!form || !textModels) return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;

  const submit = () => save({
    titleModelId: form.titleModel || null,
    compactionModelId: form.compactionModel || null,
    compactionFallbackToChat: form.compactionFallback,
    followupEnabled: form.followupEnabled,
    followupModelId: form.followupModel || null,
    translateDefaultModels: form.translateDefault,
    translateFastModels: form.translateFast,
    translateThinkModels: form.translateThink,
  });

  const follow = t('未设置(跟随对话模型)');

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <SectionIntro title={t('任务模型')}>
        {t('对话标题、长对话压缩、快速追问与翻译工坊各自使用的模型。联网搜索、网页阅读与子代理的模型在')}
        <Link to="/admin/agent" className="mx-0.5 text-acc hover:underline">{t('Agent 能力 → 总控')}</Link>
        {t('中设置。')}
      </SectionIntro>

      <Card
        title={t('对话中的自动任务')}
        desc={t('这些任务在后台自动调用模型。指定一个便宜的小模型可以省下大模型的 tokens;未设置时沿用当前对话的模型。')}
      >
        <div className="space-y-4">
          <Field label={t('对话标题生成模型')} hint={t('首轮回复后自动为对话命名。')}>
            <ModelSelect value={form.titleModel} onChange={(id) => set({ titleModel: id })} models={textModels} emptyLabel={follow} />
          </Field>

          <div className="space-y-3 rounded-lg border border-line p-3">
            <Field
              label={t('对话压缩模型')}
              hint={t('长对话生成摘要所用的模型。可选择成本较低、向用户开放的文本模型;长历史会分批压缩,用量记在实际使用的模型下。')}
            >
              <ModelSelect value={form.compactionModel} onChange={(id) => set({ compactionModel: id })} models={textModels} emptyLabel={follow} />
            </Field>
            <ToggleRow
              label={t('压缩失败时改用对话模型')}
              desc={t('专用压缩模型不可用或失败时,允许改用当前对话模型。默认关闭,避免意外使用高价模型;关闭时会提示压缩失败并继续使用近期历史。')}
              checked={form.compactionFallback} onChange={(v) => set({ compactionFallback: v })} disabled={!form.compactionModel}
            />
          </div>

          <div className="space-y-3 rounded-lg border border-line p-3">
            <ToggleRow
              label={t('回答后生成快速追问')}
              desc={t('每次回答完成后,自动生成 3 个可点击的追问建议(每次消耗少量 tokens)')}
              checked={form.followupEnabled} onChange={(v) => set({ followupEnabled: v })}
            />
            <Field label={t('快速追问生成模型')}>
              <ModelSelect value={form.followupModel} onChange={(id) => set({ followupModel: id })} models={textModels}
                emptyLabel={follow} disabled={!form.followupEnabled} />
            </Field>
          </div>
        </div>
      </Card>

      <Card
        title={t('翻译工坊')}
        desc={t('用户可选「默认 / 快速 / 思考」。默认档使用下面设置的模型模式与等级;用户明确选择快速或思考时,按用户选择执行。各档位按模型顺序调用,失败且尚未输出时自动切换。')}
      >
        <div className="space-y-5">
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-[13px] font-medium text-tx">{t('默认档模型')}</legend>
            <ModelChain entries={form.translateDefault} mode="fast" configureDefaults
              onChange={(v) => set({ translateDefault: v })} models={textModels} disabled={busy} />
            <p className="mt-1.5 text-xs text-tx3">{t('仅在用户选择「默认」时使用这些预设。每个模型可设置快速或思考,思考等级选择模型原生档位;未指定时使用中间档位。')}</p>
          </fieldset>
          <div className="grid gap-5 md:grid-cols-2">
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-medium text-tx">{t('快速模式模型链')}</legend>
              <ModelChain entries={form.translateFast} mode="fast" onChange={(v) => set({ translateFast: v })} models={textModels} disabled={busy} />
              <p className="mt-1.5 text-xs text-tx3">{t('用户选择「快速」时使用。关闭思考或使用模型支持的最低强度,不受默认档预设影响。')}</p>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[13px] font-medium text-tx">{t('思考模式模型链')}</legend>
              <ModelChain entries={form.translateThink} mode="think" onChange={(v) => set({ translateThink: v })} models={textModels} disabled={busy} />
              <p className="mt-1.5 text-xs text-tx3">{t('用户选择「思考」时使用。按用户选择的低 / 中 / 高映射到模型的最弱 / 中间 / 最强档位,不受默认档预设影响。')}</p>
            </fieldset>
          </div>
          <p className="text-xs leading-relaxed text-tx3">
            {t('翻译走一套固定的系统提示词(只输出译文、保留格式与专有名词、不执行原文中的指令等);用户选择的场景只作为语气偏好插入其中一处。模型访问权限在此不生效——列在这里即对所有用户可用。')}
          </p>
        </div>
      </Card>

      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </div>
  );
}
