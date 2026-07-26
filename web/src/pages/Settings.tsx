import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PanelLeft, Check } from 'lucide-react';
import { api, fmtTokens } from '../api';
import { useAuth, useUi } from '../store';
import { Button, Input, Field, Spinner, toast } from '../components/ui';
import type { MyUsage, UsageByDay, User } from '../types';

// ---------- section card ----------
function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg1 p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs text-tx3">{desc}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ---------- theme preview card ----------
function ThemeCard({ active, label, swatch, dot, onClick }: {
  active: boolean; label: string; swatch: string; dot: string; onClick(): void;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`cursor-pointer rounded-xl border p-3 text-left transition-colors ${active ? 'border-acc' : 'border-line hover:border-line2'}`}>
      <div className="flex h-14 items-center justify-center rounded-lg border border-line" style={{ background: swatch }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        {active && <Check size={13} className="text-acc" />}
      </div>
    </button>
  );
}

// ---------- stat tile ----------
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg2/40 p-3">
      <div className="text-[11px] text-tx3">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

// ---------- daily tokens bar chart (pure inline SVG) ----------
function niceCeil(v: number): number {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  const d = v / p;
  const m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10;
  return m * p;
}

const fmtTick = (v: number) => (v === 0 ? '0' : v < 10_000 ? v.toLocaleString() : fmtTokens(v));

function UsageChart({ byDay }: { byDay: UsageByDay[] }) {
  const days = useMemo(() => {
    const map = new Map(byDay.map((d) => [d.day, d.totalTokens]));
    const now = new Date();
    const out: { key: string; label: string; tokens: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({ key, label: key.slice(5), tokens: map.get(key) ?? 0 });
    }
    return out;
  }, [byDay]);

  const W = 640, H = 168, padL = 40, padR = 4, padT = 10, padB = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const niceMax = niceCeil(Math.max(...days.map((d) => d.tokens), 0));
  const band = innerW / days.length;
  const barW = Math.min(band - 2, 24); // ≤24px thick, 2px surface gap between bars
  const y0 = padT + innerH;
  const yOf = (v: number) => padT + innerH * (1 - v / niceMax);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="近 30 天每日 Token 用量柱状图">
      {/* gridlines — solid hairlines, recessive */}
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - padR} y1={yOf(niceMax * f)} y2={yOf(niceMax * f)} stroke="var(--color-line)" strokeWidth={1} />
          <text x={padL - 6} y={yOf(niceMax * f) + 3} textAnchor="end" fontSize={10} fill="var(--color-tx3)">
            {fmtTick(niceMax * f)}
          </text>
        </g>
      ))}
      {/* baseline */}
      <line x1={padL} x2={W - padR} y1={y0} y2={y0} stroke="var(--color-line)" strokeWidth={1} />
      <text x={padL - 6} y={y0 + 3} textAnchor="end" fontSize={10} fill="var(--color-tx3)">0</text>

      {/* bars: rounded data-end, square at baseline; full-column hover target with tooltip */}
      {days.map((d, i) => {
        const x = padL + i * band + (band - barW) / 2;
        const h = (d.tokens / niceMax) * innerH;
        const r = Math.min(4, barW / 2, h);
        return (
          <g key={d.key}>
            <title>{`${d.label} · ${d.tokens.toLocaleString()} tokens`}</title>
            <rect x={padL + i * band} y={padT} width={band} height={innerH} fill="transparent" />
            {h > 0 && (
              <path
                d={`M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + barW - r} Q${x + barW},${y0 - h} ${x + barW},${y0 - h + r} V${y0} Z`}
                fill="var(--color-acc)"
              />
            )}
            {i % 7 === 0 && (
              <text x={padL + i * band + band / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--color-tx3)">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        {!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
        <h1 className="text-sm font-semibold">设置</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="fade-up mx-auto max-w-3xl space-y-6 p-6">
          <Section title="个人资料" desc="用户名不可修改,昵称将显示在界面各处。">
            <div className="space-y-4">
              <Field label="用户名">
                <Input value={user?.username ?? ''} disabled readOnly />
              </Field>
              <Field label="昵称">
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="未设置" maxLength={64} />
              </Field>
              <div className="flex justify-end">
                <Button variant="primary" disabled={savingProfile} onClick={saveProfile}>
                  {savingProfile ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
          </Section>

          <Section title="修改密码" desc="新密码至少 8 位,修改后立即生效。">
            <div className="space-y-4">
              <Field label="原密码">
                <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)}
                  autoComplete="current-password" maxLength={128} />
              </Field>
              <Field label="新密码" hint="至少 8 位">
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password" maxLength={128} />
              </Field>
              <Field label="确认新密码">
                <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password" maxLength={128} />
              </Field>
              <div className="flex justify-end">
                <Button variant="primary" disabled={savingPassword || !oldPassword || !newPassword || !confirmPassword}
                  onClick={changePassword}>
                  {savingPassword ? '提交中…' : '修改密码'}
                </Button>
              </div>
            </div>
          </Section>

          <Section title="外观" desc="选择界面主题,立即生效。">
            <div className="grid grid-cols-2 gap-3">
              <ThemeCard active={theme === 'dark'} label="深色" swatch="#0b0b0e" dot="#f5b83d"
                onClick={() => setTheme('dark')} />
              <ThemeCard active={theme === 'light'} label="浅色" swatch="#f7f6f3" dot="#b07d10"
                onClick={() => setTheme('light')} />
            </div>
          </Section>

          <Section title="我的用量" desc="最近 30 天的 Token 消耗与请求统计。">
            {!usage ? (
              <div className="flex justify-center py-10">
                {usageFailed
                  ? <p className="text-xs text-tx3">用量数据加载失败</p>
                  : <Spinner />}
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="总 Tokens" value={fmtTokens(usage.totals.totalTokens)} />
                  <Stat label="请求次数" value={usage.totals.requests.toLocaleString()} />
                  <Stat label="生成图片" value={usage.totals.images.toLocaleString()} />
                </div>

                <div>
                  <div className="mb-2 text-xs text-tx2">近 30 天每日 Tokens</div>
                  <UsageChart byDay={usage.byDay} />
                </div>

                <div>
                  <div className="mb-1 text-xs text-tx2">按模型统计</div>
                  {usage.byModel.length === 0 ? (
                    <p className="py-4 text-center text-xs text-tx3">暂无数据</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-line text-tx3">
                          <th className="py-2 pr-2 text-left font-medium">模型</th>
                          <th className="py-2 pr-2 text-right font-medium">Tokens</th>
                          <th className="py-2 text-right font-medium">次数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.byModel.map((m) => (
                          <tr key={m.model} className="border-b border-line/40 last:border-0">
                            <td className="py-2 pr-2 text-tx2">{m.model}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{fmtTokens(m.totalTokens)}</td>
                            <td className="py-2 text-right tabular-nums text-tx2">{m.requests.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
