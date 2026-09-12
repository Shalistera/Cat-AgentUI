import { NavLink, Route, Routes } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { useUi } from '../../store';
import { Button, PageHeader } from '../../components/ui';
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

const tabs: { to: string; label: string; end?: boolean }[] = [
  { to: '/admin', label: '总览', end: true },
  { to: '/admin/users', label: '用户' },
  { to: '/admin/providers', label: '模型服务' },
  { to: '/admin/models', label: '模型设置' },
  { to: '/admin/model-order', label: '模型排序' },
  { to: '/admin/mcp', label: 'MCP' },
  { to: '/admin/sandbox', label: '沙盒' },
  { to: '/admin/settings', label: '站点设置' },
  { to: '/admin/import', label: '数据迁移' },
];

export default function Admin() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  return (
    <>
      <PageHeader
        title="管理后台"
        subtitle="用量、账号、模型服务与站点配置"
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />

      {/* Ink underline, not a coloured one: the accent stays reserved for links
          and data, so the active tab reads as structure rather than emphasis. */}
      <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-bg1 px-4 sm:px-6">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-3 text-[13px] font-medium transition-colors ${
                isActive ? 'border-pri text-tx' : 'border-transparent text-tx2 hover:border-line2 hover:text-tx'
              }`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="fade-up flex-1 overflow-y-auto bg-bg0">
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
          <Route path="settings" element={<AppSettings />} />
          <Route path="import" element={<Import />} />
        </Routes>
      </div>
    </>
  );
}
