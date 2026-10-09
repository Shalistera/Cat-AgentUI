import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, BookmarkX, ExternalLink, PanelLeft, Search } from 'lucide-react';
import { api, errMsg, fmtDate, fmtModelName } from '../api';
import { useUi } from '../store';
import { Markdown } from '../components/Markdown';
import { ModelAvatar } from '../components/ModelAvatar';
import { Button, EmptyState, PageHeader, Spinner, toast } from '../components/ui';
import type { Bookmark as BookmarkRow, MessagePart } from '../types';
import { t } from '../i18n';

function textOf(parts: MessagePart[]): string {
  return parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim();
}

// 收藏 — every bookmarked message, newest first, rendered as it looked in the
// chat. Each card links back to its exact spot in the conversation.
export default function Bookmarks() {
  const nav = useNavigate();
  const { sidebarOpen, setSidebarOpen } = useUi();
  const [rows, setRows] = useState<BookmarkRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.get<{ bookmarks: BookmarkRow[] }>('/api/bookmarks')
      .then((r) => setRows(r.bookmarks))
      .catch((e) => { toast(errMsg(e), 'err'); setRows([]); });
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!rows) return [];
    if (!q) return rows;
    return rows.filter((b) => b.chatTitle.toLowerCase().includes(q) || textOf(b.message.parts).toLowerCase().includes(q));
  }, [rows, q]);

  async function remove(b: BookmarkRow) {
    try {
      await api.del(`/api/chats/${b.chatId}/messages/${b.message.id}/bookmark`);
      setRows((r) => (r ? r.filter((x) => x.id !== b.id) : r));
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('收藏')}
        subtitle={rows ? t('{n} 条收藏的消息', { n: rows.length }) : undefined}
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title={t('打开侧栏')} onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      >
        <label className="relative block w-56 max-w-full">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx3" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('筛选收藏')} aria-label={t('筛选收藏')}
            className="h-8 w-full rounded-md border border-line2 bg-bg1 pl-8 pr-2 text-xs text-tx placeholder:text-tx3 transition-colors hover:border-field"
          />
        </label>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-[62rem] space-y-4">
          {rows === null && (
            <div className="flex justify-center py-16 text-tx3"><Spinner className="h-5 w-5" /></div>
          )}
          {rows !== null && rows.length === 0 && (
            <EmptyState
              icon={<Bookmark size={22} />}
              title={t('还没有收藏')}
              hint={t('在任意消息的操作栏点击书签图标,就会收进这里,方便以后快速找回。')}
            />
          )}
          {rows !== null && rows.length > 0 && shown.length === 0 && (
            <p className="py-12 text-center text-xs text-tx3">{t('没有匹配的收藏')}</p>
          )}
          {shown.map((b) => {
            const plain = textOf(b.message.parts);
            const long = plain.length > 700 || plain.split('\n').length > 14;
            const open = !!expanded[b.id];
            return (
              <article key={b.id} className="overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
                <header className="flex items-center gap-2 border-b border-line bg-bg2/45 px-3.5 py-2 text-xs">
                  {b.message.role === 'assistant'
                    ? <ModelAvatar model={fmtModelName(b.message.model)} size={18} />
                    : <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-pri text-[10px] font-semibold text-prifg">{t('我')}</span>}
                  <button
                    className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium text-tx hover:text-acc"
                    title={t('打开所在对话并定位到这条消息')}
                    onClick={() => nav(`/chat/${b.chatId}?msg=${b.message.id}`)}
                  >
                    {b.chatTitle || t('新对话')}
                  </button>
                  {b.message.model && <span className="hidden font-mono text-tx3 sm:inline">{fmtModelName(b.message.model)}</span>}
                  <span className="tabular-nums text-tx3">{fmtDate(b.message.createdAt)}</span>
                  <Button variant="ghost" size="iconSm" title={t('打开对话')} onClick={() => nav(`/chat/${b.chatId}?msg=${b.message.id}`)}>
                    <ExternalLink size={13} />
                  </Button>
                  <Button variant="dangerGhost" size="iconSm" title={t('取消收藏')} onClick={() => void remove(b)}>
                    <BookmarkX size={13} />
                  </Button>
                </header>
                <div className={`relative px-4 py-3 ${long && !open ? 'max-h-64 overflow-hidden' : ''}`}>
                  {b.message.role === 'assistant'
                    ? <Markdown text={plain || t('(无文字内容)')} workspaceChatId={b.chatId} />
                    : <div className="whitespace-pre-wrap wrap-anywhere text-[15px] leading-relaxed text-tx">{plain || t('(无文字内容)')}</div>}
                  {long && !open && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg1 to-transparent" />
                  )}
                </div>
                {long && (
                  <div className="border-t border-line px-4 py-1.5">
                    <button className="cursor-pointer text-xs font-medium text-tx2 hover:text-tx"
                      onClick={() => setExpanded((e) => ({ ...e, [b.id]: !open }))}>
                      {open ? t('收起') : t('展开全文')}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
