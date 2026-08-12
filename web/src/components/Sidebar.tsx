import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  MessageSquarePlus, Search, Image as ImageIcon, Settings as SettingsIcon, Presentation,
  ShieldCheck, LogOut, Sun, Moon, Pin, PinOff, Pencil, Trash2, PanelLeftClose, MoreHorizontal,
  FolderClosed, Plus,
} from 'lucide-react';
import { useAuth, useChats, useProjects, useUi } from '../store';
import { api } from '../api';
import { CatWordmark } from './Logo';
import { Button, Field, Input, Modal, ModalActions, Popover, confirmDialog, toast } from './ui';
import type { ChatSummary, Project } from '../types';
import { appVersionLabel, appVersionTitle } from '../version';

function ChatRow({ chat, active }: { chat: ChatSummary; active: boolean }) {
  const nav = useNavigate();
  const { patch, remove } = useChats();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);

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
        <Popover open={menuOpen} setOpen={setMenuOpen} align="right" width="w-32" trigger={
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
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);

  useEffect(() => { if (user && !loaded) load().catch(() => toast('加载对话列表失败', 'err')); }, [user, loaded, load]);
  useEffect(() => {
    if (user && !projectsStore.loaded) projectsStore.load().catch(() => { /* section just stays empty */ });
  }, [user, projectsStore]);

  async function createProject() {
    const name = projectName.trim();
    if (!name || projectBusy) return;
    setProjectBusy(true);
    try {
      const r = await api.post<{ project: Project }>('/api/projects', { name });
      projectsStore.upsert(r.project);
      setCreatingProject(false);
      setProjectName('');
      nav(`/projects/${r.project.id}`);
      if (window.innerWidth <= 900) setSidebarOpen(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建项目失败', 'err');
    } finally {
      setProjectBusy(false);
    }
  }

  const { pinned, recent } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? chats.filter((c) => (c.title || '新对话').toLowerCase().includes(q)) : chats;
    return { pinned: list.filter((c) => c.pinned), recent: list.filter((c) => !c.pinned) };
  }, [chats, query]);

  const empty = pinned.length === 0 && recent.length === 0;

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
        <div className="space-y-0.5">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="eyebrow">项目</span>
            <button
              title="新建项目"
              className="cursor-pointer rounded-sm p-0.5 text-tx3 transition-colors hover:bg-bg3 hover:text-tx"
              onClick={() => setCreatingProject(true)}
            >
              <Plus size={13} />
            </button>
          </div>
          {projectsStore.projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { nav(`/projects/${p.id}`); if (window.innerWidth <= 900) setSidebarOpen(false); }}
              className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-[7px] text-left transition-colors ${
                p.id === activeProjectId ? 'border-line bg-bg1 shadow-xs' : 'border-transparent hover:bg-bg2'}`}
            >
              <FolderClosed size={13} className="shrink-0 text-tx3" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-tx">{p.name}</span>
            </button>
          ))}
          {projectsStore.loaded && projectsStore.projects.length === 0 && (
            <p className="px-2 pb-1 text-[11px] leading-relaxed text-tx3">用项目沉淀指令与资料,项目内的对话自动携带它们。</p>
          )}
        </div>

        {pinned.length > 0 && (
          <div className="space-y-0.5">
            <div className="eyebrow px-2 pb-1">置顶</div>
            {pinned.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
          </div>
        )}
        {recent.length > 0 && (
          <div className="space-y-0.5">
            {pinned.length > 0 && <div className="eyebrow px-2 pb-1">最近</div>}
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

      <Modal open={creatingProject} onClose={() => setCreatingProject(false)} title="新建项目"
        desc="项目可以沉淀一份指令和参考资料,项目内的每个对话都会自动带上它们。">
        <form onSubmit={(e) => { e.preventDefault(); createProject(); }}>
          <Field label="项目名称" required>
            <Input value={projectName} onChange={(e) => setProjectName(e.target.value)}
              autoFocus maxLength={80} placeholder="例如:季度复盘、API 集成…" />
          </Field>
          <ModalActions>
            <Button variant="outline" onClick={() => setCreatingProject(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={projectBusy || !projectName.trim()}>创建</Button>
          </ModalActions>
        </form>
      </Modal>
    </aside>
  );
}
