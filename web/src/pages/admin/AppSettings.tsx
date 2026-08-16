import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../store';
import { Button, Card, Field, Input, Select, Spinner, ToggleRow, toast } from '../../components/ui';
import type { AppSettings as AppSettingsDto, ModelInfo } from '../../types';

export default function AppSettings() {
  const [loaded, setLoaded] = useState(false);
  const [brand, setBrand] = useState('');
  const [signupEnabled, setSignupEnabled] = useState(false);
  // Raw text so the fields can be emptied while typing; clamped on save.
  const [retentionDays, setRetentionDays] = useState('0');
  const [chatRetentionDays, setChatRetentionDays] = useState('0');
  const [quotaTokens, setQuotaTokens] = useState('0');
  const [quotaAction, setQuotaAction] = useState<AppSettingsDto['quotaAction']>('block');
  const [quotaFallback, setQuotaFallback] = useState('');
  const [titleModel, setTitleModel] = useState('');
  const [textModels, setTextModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);

  function apply(r: AppSettingsDto) {
    setBrand(r.brand); setSignupEnabled(r.signupEnabled);
    setRetentionDays(String(r.imageRetentionDays ?? 0));
    setChatRetentionDays(String(r.chatImageRetentionDays ?? 0));
    setQuotaTokens(String(r.quotaMonthlyTokens ?? 0));
    setQuotaAction(r.quotaAction ?? 'block');
    setQuotaFallback(r.quotaFallbackModelId ?? '');
    setTitleModel(r.titleModelId ?? '');
  }

  useEffect(() => {
    api.get<AppSettingsDto>('/api/admin/settings')
      .then((r) => { apply(r); setLoaded(true); })
      .catch((e) => toast(e instanceof Error ? e.message : '加载站点设置失败', 'err'));
    // Admins see every enabled model here — the downgrade target picker.
    api.get<ModelInfo[]>('/api/models')
      .then((r) => setTextModels(r.filter((m) => !m.imageGen)))
      .catch(() => { /* picker stays empty */ });
  }, []);

  async function save() {
    if (busy) return;
    const name = brand.trim();
    if (!name) { toast('站点名称不能为空', 'err'); return; }
    if (quotaAction === 'downgrade' && !quotaFallback) {
      toast('降级模式需要选择一个降级模型,否则超额会按拒绝处理', 'err');
      return;
    }
    setBusy(true);
    try {
      const clampDays = (v: string) => Math.min(3650, Math.max(0, Math.round(Number(v)) || 0));
      const r = await api.put<AppSettingsDto>('/api/admin/settings', {
        brand: name,
        signupEnabled,
        imageRetentionDays: clampDays(retentionDays),
        chatImageRetentionDays: clampDays(chatRetentionDays),
        quotaMonthlyTokens: Math.max(0, Math.round(Number(quotaTokens)) || 0),
        quotaAction,
        quotaFallbackModelId: quotaFallback || null,
        titleModelId: titleModel || null,
      });
      apply(r);
      toast('已保存', 'ok');
      useAuth.getState().refresh().catch(() => { /* ignore */ });
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div>
        <h1 className="text-base font-semibold tracking-tight text-tx">应用设置</h1>
        <p className="mt-0.5 text-xs text-tx3">站点名称、注册开关与生成图片的保留策略</p>
      </div>

      <Card title="站点设置" desc="影响登录页展示与新账号的注册方式。">
        <div className="space-y-5">
          <Field label="站点名称" hint="显示在登录页、侧边栏与浏览器标题">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={64} />
          </Field>

          <ToggleRow
            label="开放注册" desc="关闭后仅管理员可创建账号"
            checked={signupEnabled} onChange={setSignupEnabled}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="绘图工坊图片保留天数"
              hint="0 = 永久保留。只影响绘图工坊生成的图片,每小时清理一次,连文件一起删除。"
            >
              <Input
                type="number" min={0} max={3650} step={1} inputMode="numeric"
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field
              label="对话图片保留天数"
              hint="0 = 永久保留(建议)。只影响对话中作的图;过期后历史对话里对应的图片将无法显示。"
            >
              <Input
                type="number" min={0} max={3650} step={1} inputMode="numeric"
                value={chatRetentionDays}
                onChange={(e) => setChatRetentionDays(e.target.value)}
                placeholder="0"
              />
            </Field>
          </div>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}保存更改
            </Button>
          </div>
        </div>
      </Card>

      <Card title="成本治理" desc="共享 API Key 的月度用量保护。管理员不受配额限制,每月 1 日自动重新计算。">
        <div className="space-y-5">
          <Field
            label="默认月度 token 配额"
            hint="0 = 不限。适用于所有普通用户;可在「用户」页为单个用户覆盖(留空跟随此默认值)。"
          >
            <Input
              type="number" min={0} step={1} inputMode="numeric"
              value={quotaTokens} onChange={(e) => setQuotaTokens(e.target.value)}
              placeholder="0"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="超额后的处理" hint="降级仅对文字对话生效;绘图与 PPT 超额后一律拒绝。">
              <Select value={quotaAction} onChange={(e) => setQuotaAction(e.target.value as AppSettingsDto['quotaAction'])}>
                <option value="block">拒绝请求</option>
                <option value="downgrade">降级到指定模型</option>
              </Select>
            </Field>
            <Field label="降级模型" hint="超额用户的对话将改用该模型,并在对话中提示。">
              <Select value={quotaFallback} onChange={(e) => setQuotaFallback(e.target.value)}
                disabled={quotaAction !== 'downgrade'}>
                <option value="">未设置</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
                ))}
              </Select>
            </Field>
          </div>

          <Field
            label="对话标题生成模型"
            hint="首轮回复后自动为对话命名所用的模型。指定一个便宜的小模型可以省下大模型的 tokens;未设置时沿用当前对话的模型。"
          >
            <Select value={titleModel} onChange={(e) => setTitleModel(e.target.value)}>
              <option value="">未设置(跟随对话模型)</option>
              {textModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}({m.providerName})</option>
              ))}
            </Select>
          </Field>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>
              {busy && <Spinner className="h-3.5 w-3.5" />}保存更改
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
