import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../store';
import { CatLogo, CatMark } from '../components/Logo';
import { ReleaseNotesButton } from '../components/ReleaseNotes';
import { Button, Input, Field, toast } from '../components/ui';
import type { User } from '../types';

export default function Login() {
  const nav = useNavigate();
  const { user, bootstrap, loaded, refresh } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!loaded) refresh(); }, [loaded, refresh]);
  useEffect(() => { if (user) nav('/', { replace: true }); }, [user, nav]);
  useEffect(() => {
    if (bootstrap?.needsSetup) setMode('register');
  }, [bootstrap]);

  const canRegister = bootstrap?.needsSetup || bootstrap?.signupEnabled;
  const brand = bootstrap?.brand || 'Cat AgentUI';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (mode === 'register' && password !== password2) {
      toast('两次输入的密码不一致', 'err');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ user: User; isFirstUser?: boolean }>(
        `/api/auth/${mode}`, { username, password },
      );
      useAuth.setState({ user: r.user });
      if (r.isFirstUser) toast('已创建管理员账号,欢迎使用', 'ok');
      nav('/', { replace: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full bg-bg1">
      {/* A deliberately quiet brand rail: this is an internal sign-in screen,
          not a product landing page. */}
      <aside className="relative hidden w-[36%] max-w-sm shrink-0 flex-col justify-between overflow-hidden bg-brand p-8 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: 'linear-gradient(var(--color-brandfg) 1px, transparent 1px), linear-gradient(90deg, var(--color-brandfg) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div className="relative flex items-center gap-3">
          {/* Light tile: the mark is a black cat, so it needs a pale field to
              read against the ink panel. The eye is amber darkened from the
              default --logo-eye (#d9a441), which lacks contrast on this tile. */}
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brandfg">
            <CatLogo size={26} eye="#c98f24" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-brandfg">{brand}</span>
        </div>

        <div className="relative">
          <ReleaseNotesButton className="text-[11px] text-brandfg/55 hover:text-brandfg" />
        </div>
      </aside>

      {/* Form panel */}
      {/* m-auto (not justify-center) so short viewports scroll instead of
          clipping the top of the form above the scroll start. */}
      <div className="flex min-w-0 flex-1 overflow-y-auto px-6 py-10">
        <div className="fade-up m-auto w-full max-w-[364px]">
          <div className="lg:hidden">
            <CatMark size={44} />
          </div>

          <h1 className="mt-5 text-xl font-semibold tracking-tight text-tx lg:mt-0">
            {bootstrap?.needsSetup ? '初始化管理员账号' : mode === 'login' ? `登录 ${brand}` : '创建账号'}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-tx2">
            {bootstrap?.needsSetup
              ? '这是第一次启动,注册的首个账号将自动获得管理员权限。'
              : mode === 'login' ? '请输入你的账号信息以继续。' : '填写下列信息完成注册。'}
          </p>

          <form onSubmit={submit} className="mt-7">
            {/* Fields keep their own rhythm container — the submit button needs
                a larger offset, and a margin utility on a space-y sibling loses
                without !important. */}
            <div className="space-y-4">
              <Field label="用户名" required>
                {/* 登录态放宽到 64:从 Open WebUI 迁移的账号以邮箱为用户名,可能超过注册上限 32 */}
                <Input value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy}
                  autoFocus autoComplete="username" maxLength={mode === 'login' ? 64 : 32} required />
              </Field>
              <Field label="密码" hint={mode === 'register' ? '至少 8 位字符' : undefined} required>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} required />
              </Field>
              {mode === 'register' && (
                <Field label="确认密码" required>
                  <Input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} disabled={busy}
                    autoComplete="new-password" maxLength={128} required />
                </Field>
              )}
            </div>

            <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={busy}>
              {busy ? '请稍候…' : bootstrap?.needsSetup ? '创建管理员账号' : mode === 'login' ? '登录' : '注册'}
            </Button>

            {canRegister && !bootstrap?.needsSetup && (
              <p className="mt-4 pt-1 text-center text-[13px] text-tx2">
                {mode === 'login' ? '还没有账号?' : '已有账号?'}
                <button type="button" className="ml-1 cursor-pointer font-medium text-acc hover:underline"
                  onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                  {mode === 'login' ? '注册' : '返回登录'}
                </button>
              </p>
            )}
          </form>
          <div className="mt-8 text-center">
            <ReleaseNotesButton className="text-[11px] font-medium text-tx3 hover:text-tx" />
          </div>
        </div>
      </div>
    </div>
  );
}
