import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../store';
import { Button, Card, Field, Input, Spinner, Toggle, toast } from '../../components/ui';
import type { AppSettings as AppSettingsDto } from '../../types';

export default function AppSettings() {
  const [loaded, setLoaded] = useState(false);
  const [brand, setBrand] = useState('');
  const [signupEnabled, setSignupEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<AppSettingsDto>('/api/admin/settings')
      .then((r) => { setBrand(r.brand); setSignupEnabled(r.signupEnabled); setLoaded(true); })
      .catch((e) => toast(e instanceof Error ? e.message : '加载站点设置失败', 'err'));
  }, []);

  async function save() {
    if (busy) return;
    const name = brand.trim();
    if (!name) { toast('站点名称不能为空', 'err'); return; }
    setBusy(true);
    try {
      const r = await api.put<AppSettingsDto>('/api/admin/settings', { brand: name, signupEnabled });
      setBrand(r.brand);
      setSignupEnabled(r.signupEnabled);
      toast('已保存', 'ok');
      useAuth.getState().refresh().catch(() => { /* ignore */ });
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return <div className="flex justify-center py-24"><Spinner className="h-6 w-6" /></div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Card title="站点设置" desc="影响登录页展示与新账号的注册方式。">
        <div className="space-y-5">
          <Field label="站点名称" hint="显示在登录页、侧边栏与浏览器标题">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={64} />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-bg0 px-3.5 py-3">
            <div>
              <div className="text-[13px] font-medium text-tx">开放注册</div>
              <div className="mt-0.5 text-xs text-tx3">关闭后仅管理员可创建账号</div>
            </div>
            <Toggle checked={signupEnabled} onChange={setSignupEnabled} />
          </div>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存更改'}</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
