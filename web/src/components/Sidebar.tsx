import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  MessageSquarePlus, Search, Image as ImageIcon, Settings as SettingsIcon,
  ShieldCheck, LogOut, Sun, Moon, Pin, PinOff, Pencil, Trash2, PanelLeftClose, MoreHorizontal,
} from 'lucide-react';
import { useAuth, useChats, useUi } from '../store';
import { api } from '../api';
import { CatWordmark } from './Logo';
import { Button, Input, Modal, ModalActions, confirmDialog, toast } from './ui';
import type { ChatSummary } from '../types';
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

  const menuItem = 'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-tx2 transition-colors hover:bg-bg2 hover:text-tx';

  return (
    // Selected rows lift to the white surface: on a grey rail that reads as
    // "current page" far faster than a slightly-darker grey fill does.
    <div className={`group relative flex items-center rounded-md border transition-colors ${
      active ? 'border-line bg-bg1 shadow-xs' : 'border-transparent hover:bg-bg2'}`}>
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2.5 py-[7px] text-left"
        onClick={() => nav(`/chat/${chat.id}`)}
      >
        {chat.pinned && <Pin size={10} className="shrink-0 text-acc" />}
        <span className={`truncate text-[13px] ${active ? 'font-medium text-tx' : 'text-tx2'}`}>
          {chat.title || '新对话'}
        </span>
      </button>
      <div className="relative pr-1">
        <button
          title="更多操作"
          className={`cursor-pointer rounded p-1 text-tx3 transition-opacity hover:bg-bg3 hover:text-tx ${menuOpen ? '' : 'opacity-0 group-hover:opacity-100'}`}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="fade-up absolute right-0 top-7 z-50 w-32 rounded-lg border border-line bg-bg1 p-1 shadow-lg">
              <button className={menuItem} onClick={togglePin}>
                {chat.pinned ? <PinOff size={12} /> : <Pin size={12} />}{chat.pinned ? '取消置顶' : '置顶'}
              </button>
              <button className={menuItem}
                onClick={() => { setMenuOpen(false); setTitle(chat.title); setRenaming(true); }}>
                <Pencil size={12} />重命名
              </button>
              <button className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-err transition-colors hover:bg-err/10" onClick={doDelete}>
                <Trash2 size={12} />删除
              </button>
            </div>
          </>
        )}
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
  const { user, bootstrap, logout } = useAuth();
  const { chats, loaded, load } = useChats();
  const { theme, setTheme, sidebarOpen, setSidebarOpen } = useUi();
  const [query, setQuery] = useState('');

  useEffect(() => { if (user && !loaded) load().catch(() => toast('加载对话列表失败', 'err')); }, [user, loaded, load]);

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
        <button className="min-w-0 cursor-pointer" onClick={() => nav('/')} title="回到首页">
          <CatWordmark size={30} label={bootstrap?.brand || 'Cat AgentUI'} />
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
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索对话"
            aria-label="搜索对话"
            className="h-8 w-full rounded-md border border-line bg-bg1 pl-8 pr-2 text-xs text-tx placeholder:text-tx3 transition-colors hover:border-field"
          />
        </div>
      </div>

      {/* conversation list */}
      <div className="mt-3 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
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
        <div className="mt-2 text-center font-mono text-[10px] text-tx3" title={appVersionTitle}>
          {appVersionLabel}
        </div>
      </div>
    </aside>
  );
}
