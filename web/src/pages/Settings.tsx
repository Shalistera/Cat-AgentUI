import { useEffect, useState } from 'react';
import { PanelLeft, Check } from 'lucide-react';
import { api, fmtTokens } from '../api';
import { useAuth, useUi } from '../store';
import { Button, Input, Field, Spinner, Card, PageHeader, Stat, ToggleRow, toast } from '../components/ui';
import { TokensBarChart } from '../components/TokensBarChart';
import type { MyUsage, User } from '../types';

/* Swatches for the theme previews. Each entry mirrors the @theme token block in
   index.css (bg0 / bg1 / line / tx / acc for the respective theme) — a preview
   can't read the other theme's CSS variables, so a token change there must be
   copied here. */
const THEME_PREVIEW = {
  light: { canvas: '#f6f7f9', surface: '#ffffff', line: '#e4e7ec', ink: '#14181f', dot: '#1f4fd8' },
  dark: { canvas: '#0c0e13', surface: '#14171e', line: '#242a34', ink: '#e7eaf0', dot: '#7aa2ff' },
} as const;

/** Miniature of the theme it selects — a swatch pair plus a chrome bar, so the
    choice is previewed rather than described. */
function ThemeCard({ active, label, canvas, surface, line, ink, dot, onClick }: {
  active: boolean; label: string; canvas: string; surface: string; line: string;
  ink: string; dot: string; onClick(): void;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`cursor-pointer rounded-lg border p-2.5 text-left transition-colors ${
        active ? 'border-acc ring-1 ring-acc' : 'border-line hover:border-field'}`}>
      <div className="flex h-16 overflow-hidden rounded-md border" style={{ background: canvas, borderColor: line }}>
        <div className="w-1/3 border-r" style={{ borderColor: line }}>
          <div className="m-1.5 h-1.5 w-8 rounded-full" style={{ background: dot }} />
          <div className="m-1.5 h-1 w-6 rounded-full opacity-40" style={{ background: ink }} />
          <div className="m-1.5 h-1 w-7 rounded-full opacity-40" style={{ background: ink }} />
        </div>
        <div className="flex-1 p-1.5" style={{ background: surface }}>
          <div className="h-1.5 w-full rounded-full opacity-70" style={{ background: ink }} />
          <div className="mt-1.5 h-1.5 w-2/3 rounded-full opacity-35" style={{ background: ink }} />
          <div className="mt-1.5 h-1.5 w-1/2 rounded-full opacity-35" style={{ background: ink }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[13px] font-medium text-tx">{label}</span>
        {active && <Check size={14} className="text-acc" />}
      </div>
    </button>
  );
}

// ---------- page ----------
export default function Settings() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const user = useAuth((s) => s.user);

  // profile
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [savingProfile, setSavingProfile] = useState(false);

  // password
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // chat preferences — saved to the account, not this browser
  const [titleEmoji, setTitleEmoji] = useState(!!user?.settings.titleEmoji);

  // usage
  const [usage, setUsage] = useState<MyUsage | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);

  useEffect(() => {
    api.get<MyUsage>('/api/usage/me')
      .then(setUsage)
      .catch(() => { setUsageFailed(true); toast('加载用量数据失败', 'err'); });
  }, []);

  async function saveProfile() {
    if (savingProfile) return;
    setSavingProfile(true);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { displayName: displayName.trim() });
      useAuth.setState({ user: r.user });
      toast('资料已保存', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    } finally {
      setSavingProfile(false);
    }
  }

  async function toggleTitleEmoji(v: boolean) {
    setTitleEmoji(v); // optimistic — the toggle should feel instant
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { titleEmoji: v } });
      useAuth.setState({ user: r.user });
    } catch (err) {
      setTitleEmoji(!v);
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    }
  }

  async function changePassword() {
    if (savingPassword) return;
    if (newPassword !== confirmPassword) { toast('两次输入的新密码不一致', 'err'); return; }
    if (newPassword.length < 8) { toast('新密码至少 8 位', 'err'); return; }
    setSavingPassword(true);
    try {
      await api.post('/api/auth/password', { oldPassword, newPassword });
      toast('密码已修改', 'ok');
      setOldPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err) {
      toast(err instanceof Error ? err.message : '修改失败', 'err');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <>
      <PageHeader
        title="设置"
        subtitle="账号、外观与个人用量"
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />

      <div className="flex-1 overflow-y-auto bg-bg0">
        <div className="fade-up mx-auto max-w-3xl space-y-5 p-6">
          <Card title="个人资料" desc="用户名不可修改;昵称会显示在界面各处。">
            <div className="space-y-4">
              <Field label="用户名">
                <Input value={user?.username ?? ''} disabled readOnly />
              </Field>
              <Field label="昵称">
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="未设置" maxLength={64} />
              </Field>
              <div className="flex justify-end border-t border-line pt-4">
                <Button variant="primary" disabled={savingProfile} onClick={saveProfile}>
                  {savingProfile ? '保存中…' : '保存更改'}
                </Button>
              </div>
            </div>
          </Card>

          <Card title="修改密码" desc="新密码至少 8 位,提交后立即生效。">
            <div className="space-y-4">
              <Field label="原密码">
                <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)}
                  autoComplete="current-password" maxLength={128} />
              </Field>
              <Field label="新密码" hint="至少 8 位字符">
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password" maxLength={128} />
              </Field>
              <Field label="确认新密码">
                <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password" maxLength={128} />
              </Field>
              <div className="flex justify-end border-t border-line pt-4">
                <Button variant="primary" disabled={savingPassword || !oldPassword || !newPassword || !confirmPassword}
                  onClick={changePassword}>
                  {savingPassword ? '提交中…' : '修改密码'}
                </Button>
              </div>
            </div>
          </Card>

          <Card title="对话偏好" desc="跟随账号保存,在任何设备上都生效。">
            <ToggleRow
              label="标题自动加 emoji"
              desc="开启后,自动生成的对话标题会以一个匹配主题的 emoji 开头"
              checked={titleEmoji} onChange={(v) => void toggleTitleEmoji(v)}
            />
          </Card>

          <Card title="外观" desc="主题选择会保存在本机,立即生效。">
            <div className="grid grid-cols-2 gap-3">
              <ThemeCard active={theme === 'light'} label="浅色" onClick={() => setTheme('light')}
                {...THEME_PREVIEW.light} />
              <ThemeCard active={theme === 'dark'} label="深色" onClick={() => setTheme('dark')}
                {...THEME_PREVIEW.dark} />
            </div>
          </Card>

          <Card title="我的用量" desc="最近 30 天的 Token 消耗与请求统计。">
            {!usage ? (
              /* Spinner inherits currentColor — the wrapper supplies the grey. */
              <div className="flex justify-center py-10 text-tx3">
                {usageFailed
                  ? <p className="text-xs">用量数据加载失败</p>
                  : <Spinner />}
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Stat label="总 Tokens" value={fmtTokens(usage.totals.totalTokens)} />
                  <Stat label="请求次数" value={usage.totals.requests.toLocaleString()} />
                  <Stat label="生成图片" value={usage.totals.images.toLocaleString()} />
                </div>

                {usage.quota?.limit != null && (
                  <div>
                    <div className="eyebrow mb-2">本月配额</div>
                    <div className="space-y-1.5">
                      <div className="h-1.5 overflow-hidden rounded-full bg-bg3">
                        <div
                          className={`h-full rounded-full transition-[width] ${usage.quota.used >= usage.quota.limit ? 'bg-err' : 'bg-acc'}`}
                          style={{ width: `${Math.min(100, (usage.quota.used / usage.quota.limit) * 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-tx3">
                        已用 <span className="tabular-nums text-tx2">{fmtTokens(usage.quota.used)}</span>
                        {' / '}<span className="tabular-nums text-tx2">{fmtTokens(usage.quota.limit)}</span> tokens,
                        每月 1 日重新计算{usage.quota.used >= usage.quota.limit ? ';本月配额已用完' : ''}
                      </p>
                    </div>
                  </div>
                )}

                <div>
                  <div className="eyebrow mb-2">近 30 天每日 Tokens</div>
                  <TokensBarChart byDay={usage.byDay} />
                </div>

                <div>
                  <div className="eyebrow mb-1.5">按模型统计</div>
                  {usage.byModel.length === 0 ? (
                    <p className="py-4 text-center text-xs text-tx3">暂无数据</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-line">
                          <th className="py-2 pr-2 text-left font-medium text-tx3">模型</th>
                          <th className="py-2 pr-2 text-right font-medium text-tx3">Tokens</th>
                          <th className="py-2 text-right font-medium text-tx3">次数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.byModel.map((m) => (
                          <tr key={m.model} className="border-b border-line last:border-0">
                            <td className="py-2 pr-2 text-tx2">{m.model}</td>
                            <td className="py-2 pr-2 text-right tabular-nums text-tx">{fmtTokens(m.totalTokens)}</td>
                            <td className="py-2 text-right tabular-nums text-tx2">{m.requests.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
