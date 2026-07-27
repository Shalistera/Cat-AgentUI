import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  MessageSquarePlus, Search, Image as ImageIcon, Settings as SettingsIcon,
  ShieldCheck, LogOut, Sun, Moon, Pin, PinOff, Pencil, Trash2, PanelLeftClose, MoreHorizontal,
} from 'lucide-react';
import { useAuth, useChats, useUi } from '../store';
import { api } from '../api';
import { CatWordmark } from './Logo';
import { Button, Input, Modal, confirmDialog, toast } from './ui';
import type { ChatSummary } from '../types';

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

  return (
    <div className={`group relative flex items-center rounded-lg transition-colors ${active ? 'bg-bg2' : 'hover:bg-bg2/60'}`}>
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => nav(`/chat/${chat.id}`)}
      >
        {chat.pinned && <Pin size={11} className="shrink-0 text-acc" />}
        <span className={`truncate text-[13px] ${active ? 'text-tx' : 'text-tx2'}`}>
          {chat.title || '新对话'}
        </span>
      </button>
      <div className="relative pr-1">
        <button
          className={`cursor-pointer rounded p-1 text-tx3 hover:bg-bg3 hover:text-tx ${menuOpen ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="fade-up absolute right-0 top-7 z-50 w-32 rounded-lg border border-line bg-bg1 p-1 shadow-xl">
              <button className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-tx2 hover:bg-bg2 hover:text-tx" onClick={togglePin}>
                {chat.pinned ? <PinOff size={12} /> : <Pin size={12} />}{chat.pinned ? '取消置顶' : '置顶'}
              </button>
              <button className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-tx2 hover:bg-bg2 hover:text-tx"
                onClick={() => { setMenuOpen(false); setTitle(chat.title); setRenaming(true); }}>
                <Pencil size={12} />重命名
              </button>
              <button className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-err hover:bg-err/10" onClick={doDelete}>
                <Trash2 size={12} />删除
              </button>
            </div>
          </>
        )}
      </div>
      <Modal open={renaming} onClose={() => setRenaming(false)} title="重命名对话">
        <form onSubmit={(e) => { e.preventDefault(); doRename(); }}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={120} />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(false)}>取消</Button>
            <Button variant="primary" onClick={doRename}>保存</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function Sidebar() {
  const nav = useNavigate();
  const { id: activeChatId } = useParams();
  const { user, logout } = useAuth();
  const { chats, loaded, load } = useChats();
  const { theme, setTheme, sidebarOpen, setSidebarOpen } = useUi();
  const [query, setQuery] = useState('');

  useEffect(() => { if (user && !loaded) load().catch(() => toast('加载对话列表失败', 'err')); }, [user, loaded, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? chats.filter((c) => (c.title || '新对话').toLowerCase().includes(q)) : chats;
  }, [chats, query]);

  async function newChat() {
    nav('/');
    if (window.innerWidth <= 900) setSidebarOpen(false);
  }

  const navItem = 'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] cursor-pointer transition-colors';

  return (
    <aside className={`z-40 flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-bg1 transition-transform max-md:fixed max-md:inset-y-0 max-md:left-0 ${sidebarOpen ? '' : 'max-md:-translate-x-full md:hidden'}`}>
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <button className="cursor-pointer" onClick={() => nav('/')}><CatWordmark size={26} /></button>
        <Button variant="ghost" size="icon" title="收起侧栏" onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose size={16} />
        </Button>
      </div>

      <div className="space-y-2 px-3 pt-2">
        <Button variant="primary" className="w-full" onClick={newChat}>
          <MessageSquarePlus size={15} />新对话
        </Button>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索对话…"
            className="w-full rounded-lg border border-transparent bg-bg2 py-1.5 pl-8 pr-2 text-xs text-tx placeholder:text-tx3 outline-none focus:border-line2"
          />
        </div>
      </div>

      <div className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3 pb-2">
        {filtered.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
        {loaded && filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-tx3">{query ? '没有匹配的对话' : '还没有对话,开始第一个吧'}</p>
        )}
      </div>

      <div className="border-t border-line p-3">
        <nav className="space-y-0.5">
          <NavLink to="/images" className={({ isActive }) => `${navItem} ${isActive ? 'bg-bg2 text-tx' : 'text-tx2 hover:bg-bg2/60 hover:text-tx'}`}>
            <ImageIcon size={15} />绘图工坊
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/admin" className={({ isActive }) => `${navItem} ${isActive ? 'bg-bg2 text-tx' : 'text-tx2 hover:bg-bg2/60 hover:text-tx'}`}>
              <ShieldCheck size={15} />管理后台
            </NavLink>
          )}
          <NavLink to="/settings" className={({ isActive }) => `${navItem} ${isActive ? 'bg-bg2 text-tx' : 'text-tx2 hover:bg-bg2/60 hover:text-tx'}`}>
            <SettingsIcon size={15} />设置
          </NavLink>
        </nav>
        <div className="mt-2 flex items-center justify-between rounded-lg bg-bg2/60 px-2.5 py-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{user?.displayName || user?.username}</div>
            <div className="text-[10px] text-tx3">{user?.role === 'admin' ? '管理员' : '用户'}</div>
          </div>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </Button>
            <Button variant="ghost" size="icon" title="退出登录"
              onClick={async () => { await logout(); nav('/login'); }}>
              <LogOut size={14} />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
