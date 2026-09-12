import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart3, Check, FlaskConical, LayoutTemplate, LogOut, MessageSquareText, Monitor, Palette, Smartphone, Tablet, UserRound, X,
} from 'lucide-react';
import { api, fmtCost, fmtModelName, fmtTime, fmtTokens } from '../api';
import { notifyEnabled, notifyPermission, setNotifyEnabled } from '../notify';
import { useAuth, useUi, type SettingsTab } from '../store';
import { Badge, Button, Field, Input, Spinner, Stat, Textarea, ToggleRow, confirmDialog, toast } from './ui';
import { TokensBarChart } from './TokensBarChart';
import type { MyUsage, SessionInfo, User } from '../types';

/* claude.ai-style settings: one dialog, sections down the left, content on the
   right. Nothing here is a page any more — /settings just opens this. Each
   section is its own component so it loads (and fails) independently. */

const TABS: { id: SettingsTab; label: string; icon: typeof UserRound }[] = [
  { id: 'account', label: '账号', icon: UserRound },
  { id: 'chat', label: '对话偏好', icon: MessageSquareText },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'devices', label: '登录设备', icon: Monitor },
  { id: 'usage', label: '我的用量', icon: BarChart3 },
];
// 实验性功能 lives apart from the regular sections: pinned to the bottom of
// the rail, dashed, with a Beta tag — it should read as a side door, not as
// one more preference page.
const LABS_TAB = { id: 'labs' as SettingsTab, label: '实验性功能', icon: FlaskConical };

/** Section = heading + one-line description + body. Stacked sections are
    separated by a rule instead of nested cards, so the dialog stays flat. */
function Section({ title, desc, actions, children }: {
  title: string; desc?: string; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="border-b border-line py-5 first:pt-0 last:border-0 last:pb-0">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight text-tx">{title}</h3>
          {desc && <p className="mt-0.5 text-xs leading-relaxed text-tx3">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

// ---------- 账号 ----------
function AccountSection() {
  const user = useAuth((s) => s.user);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  async function saveProfile() {
    if (savingProfile) return;
    setSavingProfile(true);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { displayName: displayName.trim() });
      useAuth.setState({ user: r.user });
      toast('资料已保存', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    } finally { setSavingProfile(false); }
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
    } finally { setSavingPassword(false); }
  }

  const profileDirty = displayName.trim() !== (user?.displayName ?? '');

  return (
    <>
      <Section title="个人资料" desc="用户名不可修改;昵称会显示在界面各处。">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="用户名">
            <Input value={user?.username ?? ''} disabled readOnly />
          </Field>
          <Field label="昵称">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder="未设置" maxLength={64} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" size="sm" disabled={savingProfile || !profileDirty} onClick={saveProfile}>
            {savingProfile && <Spinner className="h-3.5 w-3.5" />}保存资料
          </Button>
        </div>
      </Section>

      <Section title="修改密码" desc="新密码至少 8 位;修改后其他设备会被登出,当前设备保持登录。">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void changePassword(); }}>
          <Field label="原密码">
            <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)}
              autoComplete="current-password" maxLength={128} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="新密码" hint="至少 8 位字符">
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password" maxLength={128} />
            </Field>
            <Field label="确认新密码">
              <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password" maxLength={128} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm"
              disabled={savingPassword || !oldPassword || !newPassword || !confirmPassword}>
              {savingPassword && <Spinner className="h-3.5 w-3.5" />}修改密码
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}

// ---------- 对话偏好 ----------
function ChatSection() {
  const user = useAuth((s) => s.user);
  const [titleEmoji, setTitleEmoji] = useState(!!user?.settings.titleEmoji);
  const [confirmTools, setConfirmTools] = useState(!!user?.settings.confirmTools);
  const [agentTools, setAgentTools] = useState(user?.settings.agentTools !== false);
  const [notify, setNotify] = useState(notifyEnabled());
  const perm = notifyPermission();
  const savedInstructions = user?.settings.customInstructions ?? '';
  const [instructions, setInstructions] = useState(savedInstructions);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const instructionsDirty = instructions !== savedInstructions;

  async function saveInstructions() {
    if (savingInstructions) return;
    setSavingInstructions(true);
    try {
      const value = instructions.trim();
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { customInstructions: value || null } });
      useAuth.setState({ user: r.user });
      setInstructions(value);
      toast('已保存,之后的每次对话都会带上', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    } finally {
      setSavingInstructions(false);
    }
  }

  async function saveSetting(key: 'titleEmoji' | 'confirmTools' | 'agentTools', v: boolean, revert: (v: boolean) => void) {
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { [key]: v } });
      useAuth.setState({ user: r.user });
    } catch (err) {
      revert(!v);
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    }
  }

  async function toggleNotify(v: boolean) {
    const on = await setNotifyEnabled(v);
    setNotify(on);
    if (v && !on) {
      toast(Notification.permission === 'denied'
        ? '浏览器已拒绝本站的通知权限,请在地址栏的站点设置里重新允许'
        : '未获得通知权限', 'err');
    }
  }

  return (
    <>
      <Section
        title="全局自定义指令"
        desc="告诉模型关于你的情况和你希望它怎么回复,会自动加在每次对话的系统提示前面;单个对话的系统提示可以覆盖它。"
        actions={(
          <Button variant="primary" size="sm" disabled={!instructionsDirty || savingInstructions} onClick={() => void saveInstructions()}>
            {savingInstructions && <Spinner className="h-3.5 w-3.5" />}保存
          </Button>
        )}
      >
        <Textarea
          rows={6}
          maxLength={1500}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={'例如:\n我是后端工程师,主要用 Go 和 PostgreSQL。\n回答请用中文,先给结论再解释;代码示例不要省略错误处理;不确定的地方明确说不确定。'}
        />
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-tx3">
          <span>不影响绘图、OCR、翻译等工坊。</span>
          <span className="tabular-nums">{instructions.length}/1500</span>
        </div>
      </Section>
      <Section title="对话偏好" desc="跟随账号保存,在任何设备上都生效。">
        <ToggleRow
          label="智能工具"
          desc="允许助手在需要时把长内容写成文件、在沙盒里运行代码做分析和转换、调用技能、把子任务交给子代理。产生的文件显示在对话顶部的「文件」标签里。关闭后助手只用文字回答"
          checked={agentTools}
          onChange={(v) => { setAgentTools(v); void saveSetting('agentTools', v, setAgentTools); }}
        />
        <div className="mt-3">
        <ToggleRow
          label="标题自动加 emoji"
          desc="开启后,自动生成的对话标题会以一个匹配主题的 emoji 开头"
          checked={titleEmoji}
          onChange={(v) => { setTitleEmoji(v); void saveSetting('titleEmoji', v, setTitleEmoji); }}
        />
        </div>
        <div className="mt-3">
          <ToggleRow
            label="每次调用 MCP 工具前都询问我"
            desc="开启后,模型每次想调用任何 MCP 工具都会先暂停,由你点「允许」或「拒绝」。关闭时只有管理员标记为需确认的服务器才会询问"
            checked={confirmTools}
            onChange={(v) => { setConfirmTools(v); void saveSetting('confirmTools', v, setConfirmTools); }}
          />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-tx3">
          快捷指令在新对话页直接编辑;模型收藏与排序在输入框的模型选择器里调整;翻译场景在翻译工坊页面管理。
        </p>
      </Section>
      <Section title="后台完成通知" desc="只在这台设备的这个浏览器上生效;通知权限由浏览器管理。">
        <ToggleRow
          label="切到别的标签页或窗口时,完成后弹系统通知"
          desc={perm === 'unsupported'
            ? '当前浏览器不支持系统通知'
            : perm === 'denied'
              ? '浏览器已拒绝本站的通知权限,需要在站点设置中重新允许'
              : '回复生成、批量绘图、PPT 生成完成时通知;点击通知直接回到对应页面。标签页标题上的 ● 提示不受影响'}
          checked={notify}
          disabled={perm === 'unsupported' || perm === 'denied'}
          onChange={(v) => void toggleNotify(v)}
        />
      </Section>
    </>
  );
}

// ---------- 外观 ----------
/* Swatches for the theme previews. Each entry mirrors the @theme token block in
   index.css (bg0 / bg1 / line / tx / acc for the respective theme) — a preview
   can't read the other theme's CSS variables, so a token change there must be
   copied here. */
const THEME_PREVIEW = {
  light: { canvas: '#f6f7f9', surface: '#ffffff', line: '#e4e7ec', ink: '#14181f', dot: '#1f4fd8' },
  dark: { canvas: '#0c0e13', surface: '#14171e', line: '#242a34', ink: '#e7eaf0', dot: '#7aa2ff' },
} as const;

type Swatch = (typeof THEME_PREVIEW)[keyof typeof THEME_PREVIEW];

function ThemePreview({ canvas, surface, line, ink, dot }: Swatch) {
  return (
    <div className="flex h-full w-full" style={{ background: canvas }}>
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
  );
}

/** Miniature of the theme it selects; 跟随系统 shows both halves split
    diagonally, the way OS pickers do. */
function ThemeCard({ active, label, hint, preview, onClick }: {
  active: boolean; label: string; hint?: string; preview: 'light' | 'dark' | 'system'; onClick(): void;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`cursor-pointer rounded-lg border p-2.5 text-left transition-colors ${
        active ? 'border-acc ring-1 ring-acc' : 'border-line hover:border-field'}`}>
      <div className="relative h-16 overflow-hidden rounded-md border border-line">
        {preview === 'system' ? (
          <>
            <div className="absolute inset-0"><ThemePreview {...THEME_PREVIEW.light} /></div>
            <div className="absolute inset-0" style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}>
              <ThemePreview {...THEME_PREVIEW.dark} />
            </div>
          </>
        ) : <ThemePreview {...THEME_PREVIEW[preview]} />}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-tx">{label}</span>
          {hint && <span className="block truncate text-[11px] text-tx3">{hint}</span>}
        </span>
        {active && <Check size={14} className="shrink-0 text-acc" />}
      </div>
    </button>
  );
}

function AppearanceSection() {
  const mode = useUi((s) => s.themeMode);
  const theme = useUi((s) => s.theme);
  const setThemeMode = useUi((s) => s.setThemeMode);
  return (
    <Section title="主题" desc="保存在本机浏览器,立即生效。「跟随系统」会随 iOS / Android / macOS / Windows 的深浅色设置实时切换。">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ThemeCard active={mode === 'system'} label="跟随系统" preview="system"
          hint={`当前系统为${theme === 'dark' ? '深色' : '浅色'}`} onClick={() => setThemeMode('system')} />
        <ThemeCard active={mode === 'light'} label="浅色" preview="light" onClick={() => setThemeMode('light')} />
        <ThemeCard active={mode === 'dark'} label="深色" preview="dark" onClick={() => setThemeMode('dark')} />
      </div>
    </Section>
  );
}

// ---------- 登录设备 ----------
/** "Chrome · Windows" from a UA string — enough to recognise a device; the
    full string stays in the tooltip. */
function describeUa(ua: string | null): { label: string; kind: 'phone' | 'tablet' | 'desktop' } {
  if (!ua) return { label: '未知设备', kind: 'desktop' };
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : /MicroMessenger/.test(ua) ? '微信'
    : '浏览器';
  const kind = /iPad|Tablet/.test(ua) ? 'tablet' : /iPhone|Android.*Mobile/.test(ua) ? 'phone' : 'desktop';
  return { label: [browser, os].filter(Boolean).join(' · '), kind };
}

const KIND_ICON = { phone: Smartphone, tablet: Tablet, desktop: Monitor };

function DevicesSection() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    return api.get<{ sessions: SessionInfo[] }>('/api/auth/sessions')
      .then((r) => { setSessions(r.sessions); setFailed(false); })
      .catch(() => setFailed(true));
  }
  useEffect(() => { void load(); }, []);

  async function revoke(s: SessionInfo) {
    if (busy) return;
    setBusy(s.id);
    try {
      await api.del(`/api/auth/sessions/${s.id}`);
      toast('该设备已退出登录', 'ok');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'err');
    } finally { setBusy(null); }
  }

  async function revokeOthers() {
    if (busy) return;
    const ok = await confirmDialog('退出其他设备', '除当前浏览器外,所有已登录的设备都需要重新登录。', false);
    if (!ok) return;
    setBusy('others');
    try {
      const r = await api.post<{ removed: number }>('/api/auth/sessions/revoke-others');
      toast(r.removed ? `已退出 ${r.removed} 台其他设备` : '没有其他已登录的设备', 'ok');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'err');
    } finally { setBusy(null); }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <Section title="登录设备" desc="当前账号在哪些浏览器上保持着登录。发现不认识的设备,先退出它,再修改密码。"
      actions={others > 0 && (
        <Button variant="outline" size="xs" disabled={busy !== null} onClick={() => void revokeOthers()}>
          <LogOut size={12} />退出其他设备
        </Button>
      )}>
      {sessions === null ? (
        <div className="flex justify-center py-6 text-tx3">
          {failed ? <p className="text-xs">加载失败(服务端可能还是旧版本)</p> : <Spinner />}
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {sessions.map((s) => {
            const d = describeUa(s.userAgent);
            const Icon = KIND_ICON[d.kind];
            return (
              <li key={s.id} className="flex items-center gap-3 px-3.5 py-2.5" title={s.userAgent ?? undefined}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-bg2 text-tx2">
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-tx">
                    <span className="truncate">{d.label}</span>
                    {s.current && <Badge tone="acc">当前设备</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11px] tabular-nums text-tx3">
                    {s.ip ? `${s.ip} · ` : ''}最近活动 {fmtTime(s.lastSeenAt)} · 登录于 {fmtTime(s.createdAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => void revoke(s)}>
                    {busy === s.id ? <Spinner className="h-3 w-3" /> : '退出'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---------- 我的用量 ----------
function UsageSection() {
  const [usage, setUsage] = useState<MyUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get<MyUsage>('/api/usage/me')
      .then(setUsage)
      .catch(() => { setFailed(true); toast('加载用量数据失败', 'err'); });
  }, []);

  return (
    <Section title="我的用量" desc="最近 30 天的 Token 消耗与请求统计。">
      {!usage ? (
        <div className="flex justify-center py-10 text-tx3">
          {failed ? <p className="text-xs">用量数据加载失败</p> : <Spinner />}
        </div>
      ) : (
        <div className="space-y-6">
          <div className={`grid grid-cols-2 gap-3 ${usage.totals.cost != null ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
            <Stat label="总 Tokens" value={fmtTokens(usage.totals.totalTokens)} />
            {usage.totals.cost != null && (
              <Stat label="折算成本" value={fmtCost(usage.totals.cost, usage.currency)} hint="按各模型当前单价估算" />
            )}
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
                      <td className="py-2 pr-2 text-tx2">{fmtModelName(m.model)}</td>
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
    </Section>
  );
}

// ---------- 实验性功能 ----------
function LabsSection() {
  const user = useAuth((s) => s.user);
  const [canvas, setCanvas] = useState(!!user?.settings.canvasAnswers);

  async function saveThoughtSignatures(v: boolean) {
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { showThoughtSignatures: v } });
      useAuth.setState({ user: r.user });
      toast(v ? '加密块显示已开启' : '加密块显示已关闭', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    }
  }

  async function saveCanvas(v: boolean) {
    setCanvas(v);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { canvasAnswers: v } });
      useAuth.setState({ user: r.user });
      toast(v ? '互动画布已开启:输入框里多了「画布」按钮' : '互动画布已关闭', 'ok');
    } catch (err) {
      setCanvas(!v);
      toast(err instanceof Error ? err.message : '保存失败', 'err');
    }
  }

  return (
    <>
      <div className="mb-5 flex items-start gap-3 rounded-lg border border-dashed border-acc/40 bg-acc/5 px-4 py-3">
        <FlaskConical size={16} className="mt-0.5 shrink-0 text-acc" />
        <p className="text-xs leading-relaxed text-tx2">
          这里是还在打磨中的玩法:可能不稳定、可能改动、也可能消失。全部默认关闭,只对你自己生效,随时可以关掉,不影响已有对话。
        </p>
      </div>
      <Section title="思维签名 · 加密块" desc="查看 Gemini 聊天接口实际返回的 thoughtSignature 原始字符串。">
        <ToggleRow label="显示加密块" checked={user?.settings.showThoughtSignatures === true}
          desc="在助手回复下方显示可展开、可复制的加密块；仅影响显示，默认关闭。"
          onChange={(v) => void saveThoughtSignatures(v)} />
        <p className="mt-3 text-xs leading-relaxed text-tx3">
          这是不透明的加密数据，无法在这里解密为思维链。模型或中转服务不一定返回；旧消息只能显示已保存的签名。目前支持 Gemini 原生聊天接口。
        </p>
      </Section>
      <Section
        title="互动画布"
        desc="让模型在文字回答之外,按需附上一个可交互的小组件(HTML / Canvas / JavaScript),直接在对话里渲染。"
      >
        <ToggleRow
          label="启用互动画布"
          desc="模型仍然照常用文字回答;只在流程、结构、数据、可调参数这类「看比读更清楚」的内容上,才在文字下方附一个互动组件"
          checked={canvas}
          onChange={(v) => void saveCanvas(v)}
        />
        <ul className="mt-4 space-y-2 text-xs leading-relaxed text-tx3">
          <li className="flex gap-2">
            <LayoutTemplate size={13} className="mt-0.5 shrink-0 text-tx3" />
            <span>开启后输入框会多出「画布」按钮:点亮它,这一条回答就一定带组件;不点则由模型自行判断。</span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-tx3" />
            <span>组件跟随深浅色主题,可切换查看源码、重新加载,或在右侧面板打开;组件里的按钮可以把一个追问放进输入框,由你决定是否发送。</span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-tx3" />
            <span>带组件的回答会多用一些输出 tokens、多等几十秒;复杂组件偶尔会有 bug,请以文字为准。</span>
          </li>
        </ul>
      </Section>
    </>
  );
}

// ---------- dialog ----------
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const setTab = useUi((s) => s.setSettingsTab);
  const close = useUi((s) => s.closeSettings);
  const user = useAuth((s) => s.user);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, close]);

  if (!open || !user) return null;
  const active = [...TABS, LABS_TAB].find((t) => t.id === tab) ?? TABS[0];
  const initial = (user.displayName || user.username).slice(0, 1).toUpperCase();

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="设置">
      <div className="absolute inset-0 bg-scrim" onClick={close} />
      {/* Full-screen sheet on phones; a fixed-height two-pane dialog on desktop
          so switching sections never makes the window jump. */}
      <div className="fade-up relative flex h-full w-full flex-col overflow-hidden bg-bg1 shadow-xl sm:h-[min(44rem,88vh)] sm:max-w-4xl sm:flex-row sm:rounded-xl sm:border sm:border-line">
        {/* left rail */}
        <aside className="flex shrink-0 flex-col border-b border-line bg-bg0 sm:w-56 sm:border-b-0 sm:border-r">
          <div className="flex items-center gap-3 px-4 pb-2 pt-4 sm:pb-3 sm:pt-5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pri text-xs font-semibold text-prifg">
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold tracking-tight text-tx">{user.displayName || user.username}</div>
              <div className="truncate text-[11px] text-tx3">@{user.username} · {user.role === 'admin' ? '管理员' : '用户'}</div>
            </div>
            <Button variant="ghost" size="iconSm" onClick={close} title="关闭" className="sm:hidden"><X size={15} /></Button>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 sm:flex-1 sm:flex-col sm:px-3 sm:pb-4" aria-label="设置分区">
            {TABS.map((t) => {
              const Icon = t.icon;
              const isActive = t.id === active.id;
              return (
                <button
                  key={t.id} type="button" aria-current={isActive ? 'page' : undefined}
                  onClick={() => setTab(t.id)}
                  className={`flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                    isActive ? 'bg-bg2 font-medium text-tx shadow-xs' : 'text-tx2 hover:bg-bg2/70 hover:text-tx'}`}
                >
                  <Icon size={14} className={isActive ? 'text-acc' : 'text-tx3'} />
                  {t.label}
                </button>
              );
            })}
            {/* 实验性功能: bottom-left, past a rule, dashed — deliberately apart. */}
            <div className="shrink-0 sm:mt-auto sm:border-t sm:border-line sm:pt-3">
              <button
                type="button" aria-current={active.id === LABS_TAB.id ? 'page' : undefined}
                onClick={() => setTab(LABS_TAB.id)}
                className={`flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors ${
                  active.id === LABS_TAB.id
                    ? 'border-acc/60 bg-acc/10 font-medium text-tx'
                    : 'border-dashed border-line2 text-tx2 hover:border-acc/50 hover:bg-acc/5 hover:text-tx'}`}
              >
                <FlaskConical size={14} className="text-acc" />
                {LABS_TAB.label}
                <span className="ml-auto rounded-sm bg-acc/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-acc">Beta</span>
              </button>
            </div>
          </nav>
        </aside>

        {/* content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="hidden items-center justify-between border-b border-line px-6 py-3.5 sm:flex">
            <h2 className="text-sm font-semibold tracking-tight text-tx">{active.label}</h2>
            <Button variant="ghost" size="iconSm" onClick={close} title="关闭"><X size={15} /></Button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {/* key remounts the section so each visit refetches (devices, usage) */}
            <div key={active.id} className="fade-up mx-auto max-w-2xl">
              {active.id === 'account' && <AccountSection />}
              {active.id === 'chat' && <ChatSection />}
              {active.id === 'appearance' && <AppearanceSection />}
              {active.id === 'devices' && <DevicesSection />}
              {active.id === 'usage' && <UsageSection />}
              {active.id === 'labs' && <LabsSection />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
