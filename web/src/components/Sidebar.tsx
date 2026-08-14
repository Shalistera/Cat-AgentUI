import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  MessageSquarePlus, Search, Image as ImageIcon, Settings as SettingsIcon, Presentation,
  ShieldCheck, LogOut, Sun, Moon, Pin, PinOff, Pencil, Trash2, PanelLeftClose, MoreHorizontal,
  FolderClosed, FolderOutput, Plus, ChevronRight,
} from 'lucide-react';
import { useAuth, useChats, useProjects, useUi } from '../store';
import { api } from '../api';
import { CatWordmark } from './Logo';
import { Button, Input, Modal, ModalActions, Popover, confirmDialog, toast } from './ui';
import { CreateProjectModal } from './CreateProjectModal';
import type { ChatSummary } from '../types';
import { appVersionLabel, appVersionTitle } from '../version';

function ChatRow({ chat, active }: { chat: ChatSummary; active: boolean }) {
  const nav = useNavigate();
  const { patch, remove } = useChats();
  const { projects } = useProjects();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);

  const moveTargets = projects.filter((p) => p.id !== chat.projectId);

  async function moveToProject(projectId: string | null, name?: string) {
    setMenuOpen(false);
    try {
      await api.patch(`/api/chats/${chat.id}`, { projectId });
      patch(chat.id, { projectId });
      toast(projectId ? `已移入「${name}」` : '已移出项目', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '移动失败', 'err');
    }
  }

  async function togglePin() {
    setMenuOpen(false);
    await api.patch(`/api/chats/${chat.id}`, { pinned: !chat.pinned });
    patch(chat.id, { pinned: !chat.pinned });
  }

  async function doRename() {
    const t = title.trim();
    setRenaming(false);
    if (!t || t === chat.title) return;
    await api.patch(`/api/chats/${chat.id}`, { title: t });
    patch(chat.id, { title: t });
  }

  async function doDelete() {
    setMenuOpen(false);
    if (!(await confirmDialog('删除对话', `确定删除「${chat.title || '新对话'}」?此操作不可恢复。`))) return;
    await api.del(`/api/chats/${chat.id}`);
    remove(chat.id);
    if (active) nav('/');
  }

  const menuItem = 'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-tx2 transition-colors hover:bg-bg2 hover:text-tx';

  return (
    // Selected rows lift to the white surface: on a grey rail that reads as
    // "current page" far faster than a slightly-darker grey fill does.
    <div className={`group relative flex items-center rounded-md border transition-colors ${
      active ? 'border-line bg-bg1 shadow-xs' : 'border-transparent hover:bg-bg2'}`}>
      {/* py-[7px] is deliberate: it lands the row on the exact height the
          rail's density needs — py-1.5/py-2 both miss it. */}
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2.5 py-[7px] text-left"
        onClick={() => nav(`/chat/${chat.id}`)}
      >
        {chat.pinned && <Pin size={10} className="shrink-0 text-acc" />}
        <span className={`truncate text-[13px] ${active ? 'font-medium text-tx' : 'text-tx2'}`}>
          {chat.title || '新对话'}
        </span>
      </button>
      <div className="pr-1">
        {/* The list scrolls, so the menu rides the portal-based Popover — an
            absolutely positioned panel would clip against the overflow rail. */}
        <Popover open={menuOpen} setOpen={setMenuOpen} align="right" width="w-44" trigger={
          <button
            title="更多操作"
            className={`cursor-pointer rounded-sm p-1 text-tx3 transition-opacity hover:bg-bg3 hover:text-tx ${menuOpen ? '' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'}`}
          >
            <MoreHorizontal size={14} />
          </button>
        }>
          <div className="p-1">
            <button className={menuItem} onClick={togglePin}>
              {chat.pinned ? <PinOff size={12} /> : <Pin size={12} />}{chat.pinned ? '取消置顶' : '置顶'}
            </button>
            <button className={menuItem}
              onClick={() => { setMenuOpen(false); setTitle(chat.title); setRenaming(true); }}>
              <Pencil size={12} />重命名
            </button>
            {(moveTargets.length > 0 || chat.projectId) && (
              <>
                <div className="my-1 border-t border-line" />
                <div className="eyebrow px-2 py-1">移动到项目</div>
                {moveTargets.map((p) => (
                  <button key={p.id} className={menuItem} onClick={() => moveToProject(p.id, p.name)}>
                    <FolderClosed size={12} className="shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
                {chat.projectId && (
                  <button className={menuItem} onClick={() => moveToProject(null)}>
                    <FolderOutput size={12} className="shrink-0" />移出项目
                  </button>
                )}
                <div className="my-1 border-t border-line" />
              </>
            )}
            <button className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-err transition-colors hover:bg-err/10" onClick={doDelete}>
              <Trash2 size={12} />删除
            </button>
          </div>
        </Popover>
      </div>
      <Modal open={renaming} onClose={() => setRenaming(false)} title="重命名对话">
        <form onSubmit={(e) => { e.preventDefault(); doRename(); }}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={120} />
          <ModalActions>
            <Button variant="outline" onClick={() => setRenaming(false)}>取消</Button>
            <Button variant="primary" onClick={doRename}>保存</Button>
          </ModalActions>
        </form>
      </Modal>
    </div>
  );
}

export function Sidebar() {
  const nav = useNavigate();
  // The rail lives in a pathless layout route, so `useParams` never sees the
  // child route's :id — read the chat id off the path instead, or nothing in
  // the list ever shows as selected.
  const activeChatId = useLocation().pathname.match(/^\/chat\/([^/]+)/)?.[1];
  const activeProjectId = useLocation().pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const { user, bootstrap, logout } = useAuth();
  const { chats, loaded, load } = useChats();
  const projectsStore = useProjects();
  const { theme, setTheme, sidebarOpen, setSidebarOpen } = useUi();
  const [query, setQuery] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  useEffect(() => { if (user && !loaded) load().catch(() => toast('加载对话列表失败', 'err')); }, [user, loaded, load]);
  useEffect(() => {
    if (user && !projectsStore.loaded) projectsStore.load().catch(() => { /* section just stays empty */ });
  }, [user, projectsStore]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Chats inside a project live under that project's node only — never in
  // 置顶/最近 — so the rail always answers "does this chat belong to a project?".
  const { pinned, recent, byProject } = useMemo(() => {
    const known = new Set(projectsStore.projects.map((p) => p.id));
    const byProject = new Map<string, ChatSummary[]>();
    const loose: ChatSummary[] = [];
    for (const c of chats) {
      if (q && !(c.title || '新对话').toLowerCase().includes(q)) continue;
      if (c.projectId && known.has(c.projectId)) {
        if (!byProject.has(c.projectId)) byProject.set(c.projectId, []);
        byProject.get(c.projectId)!.push(c);
      } else {
        loose.push(c);
      }
    }
    for (const list of byProject.values()) list.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return { pinned: loose.filter((c) => c.pinned), recent: loose.filter((c) => !c.pinned), byProject };
  }, [chats, q, projectsStore.projects]);

  const activeChatProjectId = useMemo(
    () => chats.find((c) => c.id === activeChatId)?.projectId ?? null,
    [chats, activeChatId],
  );

  // While searching, a project stays visible only if it (or a chat in it) matches.
  const visibleProjects = searching
    ? projectsStore.projects.filter((p) => byProject.has(p.id) || p.name.toLowerCase().includes(q))
    : projectsStore.projects;

  const empty = pinned.length === 0 && recent.length === 0 && byProject.size === 0;

  function newChat() {
    nav('/');
    if (window.innerWidth <= 900) setSidebarOpen(false);
  }

  const navItem = 'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium cursor-pointer transition-colors';
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `${navItem} ${isActive ? 'border border-line bg-bg1 text-tx shadow-xs' : 'border border-transparent text-tx2 hover:bg-bg2 hover:text-tx'}`;

  const initial = (user?.displayName || user?.username || '?').trim().charAt(0).toUpperCase();

  return (
    <aside className={`z-40 flex h-full w-[268px] shrink-0 flex-col border-r border-line bg-bg0 transition-transform max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-xl ${
      sidebarOpen ? '' : 'max-md:-translate-x-full md:hidden'}`}>

      {/* brand */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <button className="min-w-0 cursor-pointer" onClick={() => nav('/')} title={appVersionTitle}>
          <CatWordmark
            size={30}
            label={bootstrap?.brand || 'Cat AgentUI'}
            tagline={appVersionLabel}
          />
        </button>
        <Button variant="ghost" size="iconSm" title="收起侧栏" onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose size={15} />
        </Button>
      </div>

      {/* actions */}
      <div className="space-y-2 px-3 pt-3">
        <Button variant="primary" size="md" className="w-full" onClick={newChat}>
          <MessageSquarePlus size={15} />新建对话
        </Button>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
          {/* line2, not --color-field: this is rail navigation, not a form —
              a deliberately quieter edge than real inputs carry. */}
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索对话"
            aria-label="搜索对话"
            className="h-8 w-full rounded-md border border-line2 bg-bg1 pl-8 pr-2 text-xs text-tx placeholder:text-tx3 transition-colors hover:border-field"
          />
        </div>
      </div>

      {/* conversation list */}
      <div className="mt-3 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
        {(!searching || visibleProjects.length > 0) && (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between px-2 pb-1">
              <button
                title="查看全部项目"
                className="eyebrow cursor-pointer rounded-sm transition-colors hover:text-tx"
                onClick={() => { nav('/projects'); if (window.innerWidth <= 900) setSidebarOpen(false); }}
              >
                项目
              </button>
              <button
                title="新建项目"
                className="cursor-pointer rounded-sm p-0.5 text-tx3 transition-colors hover:bg-bg3 hover:text-tx"
                onClick={() => setCreatingProject(true)}
              >
                <Plus size={13} />
              </button>
            </div>
            {visibleProjects.map((p) => {
              const chatsIn = byProject.get(p.id) ?? [];
              // Searching forces matching projects open; otherwise an explicit
              // toggle wins, and the project holding the current chat auto-opens.
              const open = searching
                ? chatsIn.length > 0
                : (expanded[p.id] ?? (p.id === activeProjectId || p.id === activeChatProjectId));
              return (
                <div key={p.id}>
                  <div className={`group flex items-center rounded-md border transition-colors ${
                    p.id === activeProjectId ? 'border-line bg-bg1 shadow-xs' : 'border-transparent hover:bg-bg2'}`}>
                    <button
                      title={open ? '收起' : '展开'}
                      className="cursor-pointer self-stretch rounded-sm pl-1.5 pr-0.5 text-tx3 transition-colors hover:text-tx"
                      onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                    >
                      <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                    </button>
                    <button
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[7px] pr-1 text-left"
                      onClick={() => { nav(`/projects/${p.id}`); if (window.innerWidth <= 900) setSidebarOpen(false); }}
                    >
                      <FolderClosed size={13} className="shrink-0 text-tx3" />
                      <span className={`min-w-0 flex-1 truncate text-[13px] ${p.id === activeProjectId ? 'font-medium text-tx' : 'text-tx'}`}>{p.name}</span>
                    </button>
                    <button
                      title="在项目中新建对话"
                      className="mr-1 cursor-pointer rounded-sm p-1 text-tx3 opacity-0 transition-opacity hover:bg-bg3 hover:text-tx group-focus-within:opacity-100 group-hover:opacity-100"
                      onClick={() => { nav(`/?project=${p.id}`); if (window.innerWidth <= 900) setSidebarOpen(false); }}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {open && (
                    <div className="ml-[13px] space-y-0.5 border-l border-line py-0.5 pl-1.5">
                      {chatsIn.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
                      {chatsIn.length === 0 && (
                        <p className="px-2 py-1 text-[11px] text-tx3">项目内还没有对话</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {projectsStore.loaded && projectsStore.projects.length === 0 && (
              <p className="px-2 pb-1 text-[11px] leading-relaxed text-tx3">用项目沉淀指令与资料,项目内的对话自动携带它们。</p>
            )}
          </div>
        )}

        {pinned.length > 0 && (
          <div className="space-y-0.5">
            <div className="eyebrow px-2 pb-1">置顶</div>
            {pinned.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
          </div>
        )}
        {recent.length > 0 && (
          <div className="space-y-0.5">
            {(pinned.length > 0 || visibleProjects.length > 0) && <div className="eyebrow px-2 pb-1">最近</div>}
            {recent.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
          </div>
        )}
        {loaded && empty && (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-tx3">
            {query ? '没有匹配的对话' : '还没有对话记录'}
          </p>
        )}
      </div>

      {/* utility nav + account */}
      <div className="shrink-0 border-t border-line p-3">
        <nav className="space-y-0.5">
          <NavLink to="/images" className={navClass}>
            <ImageIcon size={15} />绘图工坊
          </NavLink>
          <NavLink to="/ppt" className={navClass}>
            <Presentation size={15} />PPT 工坊
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/admin" className={navClass}>
              <ShieldCheck size={15} />管理后台
            </NavLink>
          )}
          <NavLink to="/settings" className={navClass}>
            <SettingsIcon size={15} />设置
          </NavLink>
        </nav>

        <div className="mt-3 flex items-center gap-2.5 rounded-md border border-line bg-bg1 px-2.5 py-2 shadow-xs">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-pri text-[11px] font-semibold text-prifg">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-tx">{user?.displayName || user?.username}</div>
            <div className="text-[11px] text-tx3">{user?.role === 'admin' ? '管理员' : '用户'}</div>
          </div>
          <div className="flex items-center">
            <Button variant="ghost" size="iconSm" title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </Button>
            <Button variant="ghost" size="iconSm" title="退出登录"
              onClick={async () => { await logout(); nav('/login'); }}>
              <LogOut size={14} />
            </Button>
          </div>
        </div>
      </div>

      <CreateProjectModal open={creatingProject} onClose={() => setCreatingProject(false)} />
    </aside>
  );
}
