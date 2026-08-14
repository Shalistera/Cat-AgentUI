import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, FolderClosed, MessagesSquare, PanelLeft, Plus } from 'lucide-react';
import { fmtTime } from '../api';
import { useChats, useProjects, useUi } from '../store';
import { Button, EmptyState, PageHeader, Spinner, toast } from '../components/ui';
import { CreateProjectModal } from '../components/CreateProjectModal';

export default function ProjectsPage() {
  const nav = useNavigate();
  const { sidebarOpen, setSidebarOpen } = useUi();
  const projectsStore = useProjects();
  const { chats, loaded: chatsLoaded, load: loadChats } = useChats();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    projectsStore.load().catch(() => toast('加载项目列表失败', 'err'));
    if (!chatsLoaded) loadChats().catch(() => { /* counts just stay blank */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const chatCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of chats) if (c.projectId) m.set(c.projectId, (m.get(c.projectId) ?? 0) + 1);
    return m;
  }, [chats]);

  const headerLeft = !sidebarOpen && (
    <Button variant="ghost" size="icon" title="打开侧栏" onClick={() => setSidebarOpen(true)}>
      <PanelLeft size={16} />
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="项目" subtitle="沉淀指令与资料,让项目内的对话共享它们" left={headerLeft}>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} />新建项目
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto bg-bg0">
        {!projectsStore.loaded ? (
          <div className="flex h-full items-center justify-center text-tx3"><Spinner className="h-6 w-6" /></div>
        ) : projectsStore.projects.length === 0 ? (
          <EmptyState icon={<FolderClosed size={22} />} title="还没有项目"
            hint="项目可以沉淀一份指令和参考资料,项目内的每个对话都会自动带上它们。"
            action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus size={14} />新建项目</Button>} />
        ) : (
          <div className="mx-auto grid max-w-5xl gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
            {projectsStore.projects.map((p) => (
              <button
                key={p.id}
                onClick={() => nav(`/projects/${p.id}`)}
                className="group flex cursor-pointer flex-col rounded-xl border border-line bg-bg1 p-5 text-left shadow-xs transition-[border-color,box-shadow] hover:border-tx3 hover:shadow-md"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-bg2 text-tx2">
                    <FolderClosed size={16} />
                  </span>
                  <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-tx">{p.name}</h2>
                </div>
                <p className="mt-3 line-clamp-2 min-h-[2.5em] text-[13px] leading-relaxed text-tx3">
                  {p.description || '暂无描述'}
                </p>
                <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-[11px] text-tx3">
                  <span className="flex items-center gap-1"><MessagesSquare size={11} />{chatCount.get(p.id) ?? 0} 个对话</span>
                  <span className="flex items-center gap-1"><FileText size={11} />{p.docCount ?? 0} 份资料</span>
                  <span className="ml-auto tabular-nums">{fmtTime(p.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <CreateProjectModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
