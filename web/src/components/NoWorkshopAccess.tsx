import { Lock, PanelLeft } from 'lucide-react';
import { useUi } from '../store';
import { Button, EmptyState, PageHeader } from './ui';

/** Shown in place of the 绘图工坊 pages when the user lacks allowImages. */
export function NoWorkshopAccess() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  return (
    <div className="contents">
      <PageHeader
        title="绘图工坊"
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />
      <div className="flex flex-1 items-center justify-center overflow-y-auto bg-bg0">
        <EmptyState
          icon={<Lock size={22} />}
          title="没有绘图工坊访问权限"
          hint="绘图工坊需要管理员单独开通,请联系管理员为你的账号开启后再来创作。"
        />
      </div>
    </div>
  );
}
