import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../store';
import { CatLogo } from '../components/Logo';
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
      if (r.isFirstUser) toast('欢迎!你是第一位用户,已自动成为管理员 🐈‍⬛', 'ok');
      nav('/', { replace: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="rounded-2xl border border-line bg-bg1 p-4 shadow-lg">
            <CatLogo size={52} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {bootstrap?.brand || 'Cat-AgentUI'}
          </h1>
          <p className="text-xs text-tx3">
            {bootstrap?.needsSetup ? '首次使用 — 注册的第一个账号将成为管理员' : '轻量 · 多模型 · AI 对话与绘图'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-bg1 p-6 shadow-xl">
          <Field label="用户名">
            <Input value={username} onChange={(e) => setUsername(e.target.value)}
              autoFocus autoComplete="username" maxLength={32} required />
          </Field>
          <Field label="密码" hint={mode === 'register' ? '至少 8 位' : undefined}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} required />
          </Field>
          {mode === 'register' && (
            <Field label="确认密码">
              <Input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
                autoComplete="new-password" maxLength={128} required />
            </Field>
          )}
          <Button variant="primary" size="lg" className="w-full" disabled={busy}
            onClick={(e) => submit(e as unknown as React.FormEvent)}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </Button>
          {canRegister && !bootstrap?.needsSetup && (
            <p className="text-center text-xs text-tx3">
              {mode === 'login' ? (
                <>没有账号?<button type="button" className="ml-1 cursor-pointer text-acc hover:underline" onClick={() => setMode('register')}>注册</button></>
              ) : (
                <>已有账号?<button type="button" className="ml-1 cursor-pointer text-acc hover:underline" onClick={() => setMode('login')}>登录</button></>
              )}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
