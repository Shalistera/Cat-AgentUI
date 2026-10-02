import { useEffect, useRef } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowUpDown, BarChart3, Bot, Boxes, DatabaseZap, Plug, Settings2, ShieldCheck, Sparkles, Terminal, Users as UsersIcon, Wrench, X,
} from 'lucide-react';
import { Button } from '../../components/ui';
import Chat from '../Chat';
import Dashboard from './Dashboard';
import Users from './Users';
import UserDetail from './UserDetail';
import UserChat from './UserChat';
import Providers from './Providers';
import Models from './Models';
import ModelDetail from './ModelDetail';
import ModelOrder from './ModelOrder';
import Mcp from './Mcp';
import AppSettings from './AppSettings';
import Import from './Import';
import Sandbox from './Sandbox';
import Skills from './Skills';
import AgentSettingsPage from './AgentSettings';
import CatBridge from './CatBridge';

/* The admin console is a dialog, the same shape as 设置: sections down the
   left, content on the right, floating over the app. It keeps URL routing
   (/admin/users/:id …) so every existing page, link and deep link still
   works — only the frame changed. Behind it sits an ordinary new-chat page,
   inert, so closing the dialog lands you on something rather than a void. */

const SECTIONS: { to: string; label: string; icon: typeof BarChart3; end?: boolean; group?: string }[] = [
  { to: '/admin', label: '总览', icon: BarChart3, end: true },
  { to: '/admin/users', label: '用户', icon: UsersIcon },
  { to: '/admin/providers', label: '模型服务', icon: Plug, group: '模型' },
  { to: '/admin/models', label: '模型设置', icon: Boxes },
  { to: '/admin/model-order', label: '模型排序', icon: ArrowUpDown },
  { to: '/admin/agent', label: '总控', icon: Bot, group: 'Agent 能力' },
  { to: '/admin/catbridge', label: 'CatBridge', icon: Plug },
  { to: '/admin/mcp', label: 'MCP', icon: Wrench },
  { to: '/admin/sandbox', label: '沙盒', icon: Terminal },
  { to: '/admin/skills', label: '技能', icon: Sparkles },
  { to: '/admin/settings', label: '站点设置', icon: Settings2, group: '站点' },
  { to: '/admin/import', label: '数据迁移', icon: DatabaseZap },
];

/** Where "关闭" goes: the page the person came from, remembered by whoever
    navigated into /admin (Sidebar) — falling back to the new-chat page. */
export const adminReturn = { path: '/' };

export default function Admin() {
  const loc = useLocation();
  const nav = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);

  const close = () => nav(adminReturn.path.startsWith('/admin') ? '/' : adminReturn.path);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // A new section starts at the top, like a fresh page would.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [loc.pathname]);

  const active = SECTIONS.find((s) => (s.end ? loc.pathname === s.to : loc.pathname.startsWith(s.to)))
    ?? SECTIONS[0];

  return (
    <>
      {/* inert: the page underneath can be seen, never focused or clicked */}
      <div className="flex h-full flex-col" inert aria-hidden>
        <Chat />
      </div>
      <div className="fixed inset-0 z-40 flex items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-label="管理后台">
        <div className="absolute inset-0 bg-scrim" onClick={close} />
        <div className="fade-up relative flex h-full w-full flex-col overflow-hidden bg-bg1 shadow-xl sm:h-[min(52rem,92vh)] sm:max-w-6xl sm:flex-row sm:rounded-xl sm:border sm:border-line">
          <aside className="flex shrink-0 flex-col border-b border-line bg-bg0 sm:w-52 sm:border-b-0 sm:border-r">
            <div className="flex items-center gap-2.5 px-4 pb-2 pt-4 sm:pb-3 sm:pt-5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pri text-prifg">
                <ShieldCheck size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold tracking-tight text-tx">管理后台</div>
                <div className="truncate text-[11px] text-tx3">用量、账号、模型与站点配置</div>
              </div>
              <Button variant="ghost" size="iconSm" onClick={close} title="关闭" className="sm:hidden"><X size={15} /></Button>
            </div>
            <nav className="flex gap-1 overflow-x-auto px-3 pb-3 sm:flex-1 sm:flex-col sm:overflow-y-auto sm:px-3 sm:pb-4" aria-label="管理分区">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                return (
                  <div key={s.to} className="contents sm:block">
                    {s.group && <div className="eyebrow hidden px-2.5 pb-1 pt-3 sm:block">{s.group}</div>}
                    <NavLink
                      to={s.to} end={s.end}
                      className={({ isActive }) => `flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                        isActive ? 'bg-bg2 font-medium text-tx shadow-xs' : 'text-tx2 hover:bg-bg2/70 hover:text-tx'}`}
                    >
                      {({ isActive }) => (
                        <>
                          <Icon size={14} className={isActive ? 'text-acc' : 'text-tx3'} />
                          {s.label}
                        </>
                      )}
                    </NavLink>
                  </div>
                );
              })}
            </nav>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="hidden items-center justify-between border-b border-line px-6 py-3.5 sm:flex">
              <h2 className="text-sm font-semibold tracking-tight text-tx">{active.label}</h2>
              <Button variant="ghost" size="iconSm" onClick={close} title="关闭"><X size={15} /></Button>
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-bg0/40">
              <Routes>
                <Route index element={<Dashboard />} />
                <Route path="users" element={<Users />} />
                <Route path="users/:id" element={<UserDetail />} />
                <Route path="users/:id/chats/:chatId" element={<UserChat />} />
                <Route path="providers" element={<Providers />} />
                <Route path="models" element={<Models />} />
                <Route path="models/:id" element={<ModelDetail />} />
                <Route path="model-order" element={<ModelOrder />} />
                <Route path="mcp" element={<Mcp />} />
                <Route path="sandbox" element={<Sandbox />} />
                <Route path="skills" element={<Skills />} />
                <Route path="agent" element={<AgentSettingsPage />} />
                <Route path="catbridge" element={<CatBridge />} />
                <Route path="settings" element={<AppSettings />} />
                <Route path="import" element={<Import />} />
              </Routes>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
