import { Link } from 'react-router-dom';
import { useAuth } from '../../store';
import { Card, Field, Input, Select, Spinner, Textarea, ToggleRow, toast } from '../../components/ui';
import { t } from '../../i18n';
import type { AppSettings } from '../../types';
import { ModelSelect, SaveBar, SectionIntro, useSettingsForm, useTextModels } from './settings-common';

interface Form {
  brand: string;
  signupEnabled: boolean;
  announcement: string;
  // Raw text so the field can be emptied while typing; clamped on save.
  quotaTokens: string;
  quotaAction: AppSettings['quotaAction'];
  quotaFallback: string;
  usageCurrency: string;
}

const toForm = (r: AppSettings): Form => ({
  brand: r.brand,
  signupEnabled: r.signupEnabled,
  announcement: r.announcement ?? '',
  quotaTokens: String(r.quotaMonthlyTokens ?? 0),
  quotaAction: r.quotaAction ?? 'block',
  quotaFallback: r.quotaFallbackModelId ?? '',
  usageCurrency: r.usageCurrency ?? '$',
});

export default function GeneralSettings() {
  const { form, set, dirty, busy, reset, save } = useSettingsForm(toForm);
  const textModels = useTextModels();

  if (!form) return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;

  async function submit() {
    if (!form) return;
    const name = form.brand.trim();
    if (!name) { toast(t('站点名称不能为空'), 'err'); return; }
    if (form.quotaAction === 'downgrade' && !form.quotaFallback) {
      toast(t('降级模式需要选择一个降级模型,否则超额会按拒绝处理'), 'err');
      return;
    }
    const r = await save({
      brand: name,
      signupEnabled: form.signupEnabled,
      announcement: form.announcement.trim(),
      quotaMonthlyTokens: Math.max(0, Math.round(Number(form.quotaTokens)) || 0),
      quotaAction: form.quotaAction,
      quotaFallbackModelId: form.quotaFallback || null,
      usageCurrency: form.usageCurrency.trim() || '$',
    });
    // The brand shows in the sidebar and tab title.
    if (r) useAuth.getState().refresh().catch(() => { /* ignore */ });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <SectionIntro title={t('通用')}>{t('站点名称、注册方式、站内公告与默认用量配额')}</SectionIntro>

      <Card title={t('站点')} desc={t('影响登录页展示与新账号的注册方式。')}>
        <div className="space-y-4">
          <Field label={t('站点名称')} hint={t('显示在登录页、侧边栏与浏览器标题')}>
            <Input value={form.brand} onChange={(e) => set({ brand: e.target.value })} maxLength={64} />
          </Field>
          <ToggleRow
            label={t('开放注册')} desc={t('关闭后仅管理员可创建账号')}
            checked={form.signupEnabled} onChange={(v) => set({ signupEnabled: v })}
          />
        </div>
      </Card>

      <Card
        title={t('站内公告')}
        desc={t('留空则不显示。保存后所有已登录用户的页面顶部会立即出现横幅;用户可自行关闭,公告内容再次修改后会重新弹出。')}
      >
        <Textarea
          rows={3} maxLength={4000} value={form.announcement}
          onChange={(e) => set({ announcement: e.target.value })}
          placeholder={t('例如:今晚 23:00-23:30 系统维护,期间服务暂不可用。')}
        />
      </Card>

      <Card title={t('用量配额')} desc={t('共享 API Key 的月度用量保护。管理员不受配额限制,每月 1 日自动重新计算。')}>
        <div className="space-y-4">
          <Field
            label={t('默认月度 token 配额')}
            hint={t('0 = 不限。适用于所有普通用户;可在「用户」页为单个用户覆盖(留空跟随此默认值)。')}
          >
            <Input
              type="number" min={0} step={1} inputMode="numeric" className="max-w-48"
              value={form.quotaTokens} onChange={(e) => set({ quotaTokens: e.target.value })}
              placeholder="0"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('超额后的处理')} hint={t('降级仅对文字对话生效;绘图与 PPT 超额后一律拒绝。')}>
              <Select value={form.quotaAction} onChange={(e) => set({ quotaAction: e.target.value as AppSettings['quotaAction'] })}>
                <option value="block">{t('拒绝请求')}</option>
                <option value="downgrade">{t('降级到指定模型')}</option>
              </Select>
            </Field>
            <Field label={t('降级模型')} hint={t('超额用户的对话将改用该模型,并在对话中提示。')}>
              <ModelSelect value={form.quotaFallback} onChange={(id) => set({ quotaFallback: id })}
                models={textModels} emptyLabel={t('未设置')} disabled={form.quotaAction !== 'downgrade'} />
            </Field>
          </div>

          <Field
            label={t('成本货币符号')}
            hint={t('用量看板成本列显示的货币符号(如 ¥、$)。单价在各模型详情页配置;没有任何模型配置单价时不显示成本。')}
          >
            <Input
              className="max-w-24" value={form.usageCurrency} maxLength={8}
              onChange={(e) => set({ usageCurrency: e.target.value })} placeholder="$"
            />
          </Field>

          <p className="text-xs leading-relaxed text-tx3">
            {t('单个模型的每日 / 每周上限在')}
            <Link to="/admin/models" className="mx-0.5 text-acc hover:underline">{t('模型设置')}</Link>
            {t('的模型详情里配置,达到上限时同样按这里的「超额后的处理」执行。')}
          </p>
        </div>
      </Card>

      <SaveBar dirty={dirty} busy={busy} onSave={submit} onReset={reset} />
    </div>
  );
}
