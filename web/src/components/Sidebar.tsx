import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Archive, ArchiveRestore, Bookmark, Ghost, MessageSquarePlus, Search, Settings as SettingsIcon,
  ShieldCheck, LogOut, Sun, Moon, Pin, PinOff, Pencil, Trash2, PanelLeftClose,
  MoreHorizontal, FolderClosed, FolderOutput, Plus, ChevronRight, FileDown, FileJson, ChevronsUpDown,
  LayoutGrid,
  Users,
} from 'lucide-react';
import { useAuth, useChats, useProjects, useUi } from '../store';
import { adminReturn } from '../pages/admin/Admin';
import { api } from '../api';
import { CatMark } from './Logo';
import { Button, Input, Modal, ModalActions, Popover, confirmDialog, toast } from './ui';
import { CreateProjectModal } from './CreateProjectModal';
import { ReleaseNotesButton } from './ReleaseNotes';
import { WORKSHOPS, pinnedWorkshops } from '../workshops';
import type { ChatSummary, SearchResult, User } from '../types';
import { t } from '../i18n';

/** Wrap the first occurrence of `q` (case-insensitive) in a highlight mark. */
function highlightMatch(text: string, q: string) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[3px] bg-acc/25 px-px text-tx">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

/** 全文搜索结果行:标题 + 命中消息的上下文摘要。 */
function SearchResultRow({ r, q, active, onOpen }: {
  r: SearchResult; q: string; active: boolean; onOpen(): void;
}) {
  return (
    <button
      className={`block w-full cursor-pointer rounded-md border px-2.5 py-1.5 text-left transition-colors ${
        active ? 'border-line bg-bg1 shadow-xs' : 'border-transparent hover:bg-bg2'}`}
      onClick={onOpen}
    >
      <span className="flex items-center gap-1.5">
        {r.pinned && <Pin size={10} className="shrink-0 text-acc" />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-tx">
          {highlightMatch(r.title || t('新对话'), q)}
        </span>
        {r.archived && (
          <span className="shrink-0 rounded-sm bg-bg3 px-1 py-px text-[10px] text-tx3">{t('归档')}</span>
        )}
        {r.matchCount > 1 && (
          <span className="shrink-0 rounded-full bg-bg3 px-1.5 text-[10px] tabular-nums text-tx3">{r.matchCount}</span>
        )}
      </span>
      {r.snippet && (
        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-tx3">
          {highlightMatch(r.snippet, q)}
        </span>
      )}
    </button>
  );
}

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
      toast(projectId ? t('已移入「{name}」', { name: name ?? '' }) : t('已移出项目'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('移动失败'), 'err');
    }
  }

  async function togglePin() {
    setMenuOpen(false);
    await api.patch(`/api/chats/${chat.id}`, { pinned: !chat.pinned });
    patch(chat.id, { pinned: !chat.pinned });
  }

  async function toggleArchive() {
    setMenuOpen(false);
    await api.patch(`/api/chats/${chat.id}`, { archived: !chat.archived });
    patch(chat.id, { archived: !chat.archived });
    toast(chat.archived ? t('已取消归档') : t('已归档,可在侧栏底部或搜索 archived:true 找回'), 'ok');
  }

  function exportChat(format: 'markdown' | 'json') {
    setMenuOpen(false);
    // Plain navigation download: the attachment disposition keeps the page put.
    const a = document.createElement('a');
    a.href = `/api/chats/${chat.id}/export?format=${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
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
    if (!(await confirmDialog(t('删除对话'), t('确定删除「{title}」?此操作不可恢复。', { title: chat.title || t('新对话') })))) return;
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
          {chat.title || t('新对话')}
        </span>
      </button>
      <div className="pr-1">
        {/* The list scrolls, so the menu rides the portal-based Popover — an
            absolutely positioned panel would clip against the overflow rail. */}
        <Popover open={menuOpen} setOpen={setMenuOpen} align="right" width="w-44" trigger={
          <button
            title={t('更多操作')}
            className={`cursor-pointer rounded-sm p-1 text-tx3 transition-opacity hover:bg-bg3 hover:text-tx ${menuOpen ? '' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'}`}
          >
            <MoreHorizontal size={14} />
          </button>
        }>
          <div className="p-1">
            <button className={menuItem} onClick={togglePin}>
              {chat.pinned ? <PinOff size={12} /> : <Pin size={12} />}{chat.pinned ? t('取消置顶') : t('置顶')}
            </button>
            <button className={menuItem}
              onClick={() => { setMenuOpen(false); setTitle(chat.title); setRenaming(true); }}>
              <Pencil size={12} />{t('重命名')}
            </button>
            <button className={menuItem} onClick={toggleArchive}>
              {chat.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
              {chat.archived ? t('取消归档') : t('归档')}
            </button>
            <button className={menuItem} onClick={() => exportChat('markdown')}>
              <FileDown size={12} />{t('导出 Markdown')}
            </button>
            <button className={menuItem} onClick={() => exportChat('json')}>
              <FileJson size={12} />{t('导出 JSON')}
            </button>
            {(moveTargets.length > 0 || chat.projectId) && (
              <>
                <div className="my-1 border-t border-line" />
                <div className="eyebrow px-2 py-1">{t('移动到项目')}</div>
                {moveTargets.map((p) => (
                  <button key={p.id} className={menuItem} onClick={() => moveToProject(p.id, p.name)}>
                    <FolderClosed size={12} className="shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
                {chat.projectId && (
                  <button className={menuItem} onClick={() => moveToProject(null)}>
                    <FolderOutput size={12} className="shrink-0" />{t('移出项目')}
                  </button>
                )}
                <div className="my-1 border-t border-line" />
              </>
            )}
            <button className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-err transition-colors hover:bg-err/10" onClick={doDelete}>
              <Trash2 size={12} />{t('删除')}
            </button>
          </div>
        </Popover>
      </div>
      <Modal open={renaming} onClose={() => setRenaming(false)} title={t('重命名对话')}>
        <form onSubmit={(e) => { e.preventDefault(); doRename(); }}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={120} />
          <ModalActions>
            <Button variant="outline" onClick={() => setRenaming(false)}>{t('取消')}</Button>
            <Button variant="primary" onClick={doRename}>{t('保存')}</Button>
          </ModalActions>
        </form>
      </Modal>
    </div>
  );
}

/** The workshops as an icon row. Which ones show — and in what order — is the
    user's own (settings.workshopPins); the rest, plus pin toggles, live behind
    the grid button. One row costs the same height as one text item did, so
    adding a workshop no longer pushes the chat list up. */
function WorkshopRail({ onNavigate }: { onNavigate(): void }) {
  const nav = useNavigate();
  const pathname = useLocation().pathname;
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const pins = user?.settings.workshopPins ?? null;
  const pinned = pinnedWorkshops(pins);
  const pinnedIds = pinned.map((w) => w.id);
  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`);

  async function savePins(next: string[]) {
    if (saving) return;
    setSaving(true);
    try {
      const r = await api.patch<{ user: User }>('/api/auth/profile', { settings: { workshopPins: next } });
      setUser(r.user);
    } catch (e) {
      toast(e instanceof Error ? e.message : t('保存失败'), 'err');
    } finally {
      setSaving(false);
    }
  }
  const togglePin = (id: string) => savePins(
    pinnedIds.includes(id) ? pinnedIds.filter((x) => x !== id) : [...pinnedIds, id],
  );
  const move = (id: string, dir: -1 | 1) => {
    const i = pinnedIds.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= pinnedIds.length) return;
    const next = [...pinnedIds];
    [next[i], next[j]] = [next[j], next[i]];
    void savePins(next);
  };

  const iconBtn = (active: boolean) =>
    `flex h-9 flex-1 cursor-pointer items-center justify-center rounded-md border transition-colors ${
      active ? 'border-line bg-bg1 text-tx shadow-xs' : 'border-transparent text-tx2 hover:bg-bg2 hover:text-tx'}`;
  const menuItem = 'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-tx2 transition-colors hover:bg-bg2 hover:text-tx';

  return (
    <div className="flex items-center gap-1">
      {pinned.map((w) => (
        <button key={w.id} type="button" title={w.label} aria-label={w.label}
          className={iconBtn(isActive(w.to))}
          onClick={() => { nav(w.to); onNavigate(); }}>
          <w.Icon size={16} />
        </button>
      ))}
      <Popover open={open} setOpen={setOpen} align="right" width="w-56" trigger={
        <button type="button" title={t('全部工坊 / 钉选')} aria-label={t('全部工坊')}
          className={`${iconBtn(open)} ${pinned.length ? 'max-w-9 px-2' : ''}`}>
          <LayoutGrid size={16} />
          {!pinned.length && <span className="ml-1.5 text-[13px] font-medium">{t('工坊')}</span>}
        </button>
      }>
        <div className="p-1">
          <div className="eyebrow px-2 py-1">{t('工坊')}</div>
          {WORKSHOPS.map((w) => {
            const isPinned = pinnedIds.includes(w.id);
            const order = pinnedIds.indexOf(w.id);
            return (
              <div key={w.id} className="group flex items-center gap-1">
                <button className={`${menuItem} min-w-0 flex-1`}
                  onClick={() => { setOpen(false); nav(w.to); onNavigate(); }}>
                  <w.Icon size={13} className="shrink-0" />
                  <span className="truncate">{w.label}</span>
                </button>
                {isPinned && (
                  <span className="flex shrink-0 items-center">
                    <button title={t('前移')} disabled={saving || order <= 0}
                      className="cursor-pointer rounded-sm p-0.5 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                      onClick={() => move(w.id, -1)}>
                      <ChevronRight size={11} className="-rotate-90" />
                    </button>
                    <button title={t('后移')} disabled={saving || order >= pinnedIds.length - 1}
                      className="cursor-pointer rounded-sm p-0.5 text-tx3 hover:bg-bg2 hover:text-tx disabled:cursor-default disabled:opacity-30"
                      onClick={() => move(w.id, 1)}>
                      <ChevronRight size={11} className="rotate-90" />
                    </button>
                  </span>
                )}
                <button title={isPinned ? t('从图标栏移除') : t('钉到图标栏')} disabled={saving}
                  className={`shrink-0 cursor-pointer rounded-sm p-1 transition-colors hover:bg-bg2 ${isPinned ? 'text-acc' : 'text-tx3 hover:text-tx'}`}
                  onClick={() => togglePin(w.id)}>
                  {isPinned ? <Pin size={12} /> : <PinOff size={12} />}
                </button>
              </div>
            );
          })}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-relaxed text-tx3">
            {t('钉选的工坊显示在侧栏图标栏,按这里的顺序排列。')}
          </p>
        </div>
      </Popover>
    </div>
  );
}

export function Sidebar() {
  const nav = useNavigate();
  // The rail lives in a pathless layout route, so `useParams` never sees the
  // child route's :id — read the chat id off the path instead, or nothing in
  // the list ever shows as selected.
  const pathname = useLocation().pathname;
  const activeChatId = pathname.match(/^\/chat\/([^/]+)/)?.[1];
  const activeProjectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const { user, bootstrap, logout } = useAuth();
  const { chats, loaded, load } = useChats();
  const projectsStore = useProjects();
  const { theme, setThemeMode, sidebarOpen, setSidebarOpen } = useUi();
  const [query, setQuery] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const menuItem = 'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-tx2 transition-colors hover:bg-bg2 hover:text-tx';

  useEffect(() => { if (user && !loaded) load().catch(() => toast(t('加载对话列表失败'), 'err')); }, [user, loaded, load]);
  useEffect(() => {
    if (user && !projectsStore.loaded) projectsStore.load().catch(() => { /* section just stays empty */ });
  }, [user, projectsStore]);

  const q = query.trim();
  const searching = q.length > 0;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Full-text search rides the server: titles AND message bodies, with
  // `project:` / `pinned:` filters and a snippet per hit. Debounced so a
  // keystroke burst costs one request.
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [highlightQ, setHighlightQ] = useState('');
  useEffect(() => {
    if (!searching) { setResults(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.get<{ results: SearchResult[]; query: string }>(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => { if (!cancelled) { setResults(r.results); setHighlightQ(r.query); } })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, searching]);

  // Chats inside a project live under that project's node only — never in
  // 置顶/最近 — so the rail always answers "does this chat belong to a project?".
  // Archived chats leave every normal section for the collapsed shelf below.
  // Loose unpinned chats bucket by updatedAt into 今天/昨天/近一周/更早.
  const { pinned, recentGroups, recentCount, byProject, archived } = useMemo(() => {
    const known = new Set(projectsStore.projects.map((p) => p.id));
    const byProject = new Map<string, ChatSummary[]>();
    const loose: ChatSummary[] = [];
    const archived: ChatSummary[] = [];
    for (const c of chats) {
      if (c.archived) {
        archived.push(c);
      } else if (c.projectId && known.has(c.projectId)) {
        if (!byProject.has(c.projectId)) byProject.set(c.projectId, []);
        byProject.get(c.projectId)!.push(c);
      } else {
        loose.push(c);
      }
    }
    for (const list of byProject.values()) list.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const recent = loose.filter((c) => !c.pinned);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayStart = dayStart.getTime();
    const yesterdayStart = todayStart - 86_400_000;
    const weekStart = todayStart - 7 * 86_400_000;
    const bucketOf = (c: ChatSummary) => (
      c.updatedAt >= todayStart ? t('今天')
        : c.updatedAt >= yesterdayStart ? t('昨天')
        : c.updatedAt >= weekStart ? t('近一周') : t('更早')
    );
    // Fixed bucket order (not contiguous runs): local patches — un-pinning,
    // renames — can leave the array slightly out of updatedAt order, and runs
    // would then print a duplicate label.
    const buckets = new Map<string, ChatSummary[]>([[t('今天'), []], [t('昨天'), []], [t('近一周'), []], [t('更早'), []]]);
    for (const c of recent) buckets.get(bucketOf(c))!.push(c);
    return {
      pinned: loose.filter((c) => c.pinned),
      recentGroups: [...buckets].filter(([, list]) => list.length > 0),
      recentCount: recent.length, byProject, archived,
    };
  }, [chats, projectsStore.projects]);
  const [showArchived, setShowArchived] = useState(false);

  const activeChatProjectId = useMemo(
    () => chats.find((c) => c.id === activeChatId)?.projectId ?? null,
    [chats, activeChatId],
  );

  const visibleProjects = searching ? [] : projectsStore.projects;

  const empty = pinned.length === 0 && recentCount === 0 && byProject.size === 0;

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
        <div className="flex min-w-0 items-center gap-2.5">
          <button type="button" className="cursor-pointer" onClick={() => nav('/')} title={t('返回首页')}>
            <CatMark size={30} />
          </button>
          <div className="min-w-0 leading-tight">
            <button
              type="button"
              className="block max-w-[156px] cursor-pointer truncate text-[13px] font-semibold tracking-tight text-tx"
              onClick={() => nav('/')}
              title={t('返回首页')}
            >
              {bootstrap?.brand || 'Cat AgentUI'}
            </button>
            <div className="truncate text-[11px]">
              <ReleaseNotesButton className="text-tx3 hover:text-tx" />
            </div>
          </div>
        </div>
        <Button variant="ghost" size="iconSm" title={t('收起侧栏')} onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose size={15} />
        </Button>
      </div>

      {/* actions */}
      <div className="space-y-2 px-3 pt-3">
        <div className="flex gap-2">
          <Button variant="primary" size="md" className="flex-1" onClick={newChat}>
            <MessageSquarePlus size={15} />{t('新建对话')}
          </Button>
          <Button
            variant="outline" size="icon" title={t('临时对话:不写入历史记录,闲置 24 小时后自动删除')}
            onClick={() => { nav('/?temp=1'); if (window.innerWidth <= 900) setSidebarOpen(false); }}
          >
            <Ghost size={15} />
          </Button>
          <Button
            variant="outline" size="icon" title={t('收藏的消息')}
            className={pathname === '/bookmarks' ? 'border-acc/40 bg-acc/10 text-acc' : ''}
            onClick={() => { nav('/bookmarks'); if (window.innerWidth <= 900) setSidebarOpen(false); }}
          >
            <Bookmark size={15} />
          </Button>
        </div>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
          {/* line2, not --color-field: this is rail navigation, not a form —
              a deliberately quieter edge than real inputs carry. */}
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索对话与消息')}
            aria-label={t('搜索对话与消息')}
            title={t('搜索标题与消息正文。\n支持过滤:project:项目名、pinned:true、archived:true(默认不搜归档)')}
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
                title={t('查看全部项目')}
                className="eyebrow cursor-pointer rounded-sm transition-colors hover:text-tx"
                onClick={() => { nav('/projects'); if (window.innerWidth <= 900) setSidebarOpen(false); }}
              >
                {t('项目')}
              </button>
              <button
                title={t('新建项目')}
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
                      title={open ? t('收起') : t('展开')}
                      className="cursor-pointer self-stretch rounded-sm pl-1.5 pr-0.5 text-tx3 transition-colors hover:text-tx"
                      onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                    >
                      <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                    </button>
                    <button
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[7px] pr-1 text-left"
                      onClick={() => { nav(`/projects/${p.id}`); if (window.innerWidth <= 900) setSidebarOpen(false); }}
                    >
                      {p.role !== 'owner' || p.accessMode !== 'private'
                        ? <Users size={13} className="shrink-0 text-tx3" />
                        : <FolderClosed size={13} className="shrink-0 text-tx3" />}
                      <span className={`min-w-0 flex-1 truncate text-[13px] ${p.id === activeProjectId ? 'font-medium text-tx' : 'text-tx'}`}
                        title={p.role !== 'owner' ? t('{owner} 共享的项目', { owner: p.owner.displayName || p.owner.username }) : undefined}>{p.name}</span>
                    </button>
                    <button
                      title={t('在项目中新建对话')}
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
                        <p className="px-2 py-1 text-[11px] text-tx3">{t('项目内还没有对话')}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {projectsStore.loaded && projectsStore.projects.length === 0 && (
              <p className="px-2 pb-1 text-[11px] leading-relaxed text-tx3">{t('把常用的要求和资料放进项目,项目里的对话会自动用上。')}</p>
            )}
          </div>
        )}

        {searching && (
          <div className="space-y-0.5">
            <div className="eyebrow px-2 pb-1">{t('搜索结果')}</div>
            {(results ?? []).map((r) => (
              <SearchResultRow key={r.id} r={r} q={highlightQ} active={r.id === activeChatId}
                // Carry the term along: the chat opens with 对话内查找 on the first hit.
                onOpen={() => { nav(`/chat/${r.id}${highlightQ ? `?find=${encodeURIComponent(highlightQ)}` : ''}`); if (window.innerWidth <= 900) setSidebarOpen(false); }} />
            ))}
            {results === null && (
              <p className="px-2 py-4 text-center text-[11px] text-tx3">{t('搜索中…')}</p>
            )}
            {results !== null && results.length === 0 && (
              <p className="px-2 py-8 text-center text-xs leading-relaxed text-tx3">{t('没有匹配的对话或消息')}</p>
            )}
          </div>
        )}
        {!searching && pinned.length > 0 && (
          <div className="space-y-0.5">
            <div className="eyebrow px-2 pb-1">{t('置顶')}</div>
            {pinned.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
          </div>
        )}
        {!searching && recentGroups.map(([label, list]) => (
          <div key={label} className="space-y-0.5">
            <div className="eyebrow px-2 pb-1">{label}</div>
            {list.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
          </div>
        ))}
        {!searching && archived.length > 0 && (
          <div className="space-y-0.5">
            <button
              className="eyebrow flex cursor-pointer items-center gap-1 rounded-sm px-2 pb-1 transition-colors hover:text-tx"
              onClick={() => setShowArchived((v) => !v)}
              title={showArchived ? t('收起归档对话') : t('展开归档对话')}
            >
              <ChevronRight size={10} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              {t('已归档')} <span className="tabular-nums opacity-70">{archived.length}</span>
            </button>
            {showArchived && archived.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeChatId} />)}
          </div>
        )}
        {!searching && loaded && empty && archived.length === 0 && (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-tx3">{t('还没有对话记录')}</p>
        )}
      </div>

      {/* workshops + account */}
      <div className="shrink-0 border-t border-line p-3">
        <WorkshopRail onNavigate={() => { if (window.innerWidth <= 900) setSidebarOpen(false); }} />

        <Popover open={accountOpen} setOpen={setAccountOpen} align="left" width="w-[244px]" trigger={
          <button
            type="button"
            title={t('账号菜单')}
            className={`mt-3 flex w-full cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
              accountOpen ? 'border-line bg-bg2' : 'border-line bg-bg1 shadow-xs hover:bg-bg2'}`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-pri text-[11px] font-semibold text-prifg">
              {initial}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-tx">{user?.displayName || user?.username}</span>
              <span className="block text-[11px] text-tx3">{user?.role === 'admin' ? t('管理员') : t('用户')}</span>
            </span>
            <ChevronsUpDown size={14} className="shrink-0 text-tx3" />
          </button>
        }>
          <div className="p-1">
            <button className={menuItem} onClick={() => { setAccountOpen(false); useUi.getState().openSettings(); }}>
              <SettingsIcon size={13} />{t('设置')}
            </button>
            {user?.role === 'admin' && (
              <button className={menuItem} onClick={() => { setAccountOpen(false); adminReturn.path = window.location.pathname; nav('/admin'); if (window.innerWidth <= 900) setSidebarOpen(false); }}>
                <ShieldCheck size={13} />{t('管理后台')}
              </button>
            )}
            {/* Quick flip pins the opposite theme; 跟随系统 lives in 设置 → 外观. */}
            <button className={menuItem} title={t('固定为另一种主题;要跟随系统请到「设置 → 外观」')}
              onClick={() => setThemeMode(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
              {theme === 'dark' ? t('切换到浅色主题') : t('切换到深色主题')}
            </button>
            <div className="my-1 border-t border-line" />
            <button className={menuItem} onClick={async () => { setAccountOpen(false); await logout(); nav('/login'); }}>
              <LogOut size={13} />{t('退出登录')}
            </button>
          </div>
        </Popover>
      </div>

      <CreateProjectModal open={creatingProject} onClose={() => setCreatingProject(false)} />
    </aside>
  );
}
