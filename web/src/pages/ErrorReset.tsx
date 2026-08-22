import { useState } from 'react';
import { Loader2, LogOut, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { CatMark } from '../components/Logo';
import { Button } from '../components/ui';

/**
 * Landing spot for browsers that carry stale state from a previous panel on
 * the same domain (Open WebUI redirects its users to /error, and its httpOnly
 * `token` cookie survives the migration). One big button resets everything —
 * server-side cookie expiry plus local storage and service workers — then
 * drops the user on the login page.
 */
export default function ErrorReset() {
  const [busy, setBusy] = useState(false);

  async function reset() {
    if (busy) return;
    setBusy(true);
    // Server expires every cookie it received (the httpOnly ones JS can't
    // touch); best-effort — local cleanup still runs if the call fails.
    try { await api.post('/api/auth/reset'); } catch { /* offline / 4xx */ }
    try {
      for (const part of document.cookie.split(';')) {
        const name = part.split('=')[0]?.trim();
        if (name) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      }
      localStorage.clear();
      sessionStorage.clear();
    } catch { /* storage may be blocked */ }
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      if (regs) await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* no SW support */ }
    // Full reload so nothing stale survives in memory either.
    window.location.href = '/login';
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg0 p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-bg1 p-8 text-center shadow-md">
        <div className="mb-5 flex items-center justify-center gap-3">
          <CatMark size={36} />
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-warn/15 text-warn">
            <TriangleAlert size={18} />
          </span>
        </div>
        <h1 className="text-lg font-semibold text-tx">页面遇到了问题</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-tx2">
          如果你是从旧面板(如 Open WebUI)迁移过来的用户,浏览器里残留的旧登录信息(Cookies)可能导致页面无法正常打开。
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-tx2">
          点击下面的按钮清除本站的登录状态与缓存,然后重新登录即可。
        </p>
        <Button
          variant="primary" size="lg" className="mt-6 w-full"
          onClick={() => void reset()} disabled={busy}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
          清除登录信息,重新登录
        </Button>
        <a href="/" className="mt-4 inline-block text-xs text-tx3 transition-colors hover:text-tx">
          先试试直接返回首页
        </a>
      </div>
    </div>
  );
}
