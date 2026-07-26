import { NavLink, Route, Routes } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { useUi } from '../../store';
import { Button } from '../../components/ui';
import Dashboard from './Dashboard';
import Users from './Users';
import Providers from './Providers';
import Mcp from './Mcp';
import AppSettings from './AppSettings';

const tabs: { to: string; label: string; end?: boolean }[] = [
  { to: '/admin', label: '总览', end: true },
  { to: '/admin/users', label: '用户' },
  { to: '/admin/providers', label: '模型服务' },
  { to: '/admin/mcp', label: 'MCP' },
  { to: '/admin/settings', label: '站点设置' },
];

export default function Admin() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        {!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
        <h1 className="text-sm font-semibold">管理后台</h1>
      </header>

      <nav className="flex shrink-0 items-center overflow-x-auto border-b border-line px-4">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition-colors ${
                isActive ? 'border-acc font-medium text-tx' : 'border-transparent text-tx2 hover:text-tx'
              }`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="users" element={<Users />} />
          <Route path="providers" element={<Providers />} />
          <Route path="mcp" element={<Mcp />} />
          <Route path="settings" element={<AppSettings />} />
        </Routes>
      </div>
    </>
  );
}
