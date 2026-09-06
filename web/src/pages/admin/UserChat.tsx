import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Archive, ArrowLeft, ChevronDown, ChevronUp, Eye, FolderOpen, Pin, Timer } from 'lucide-react';
import { api, errMsg, fmtDate } from '../../api';
import { Badge, Button, EmptyState, Spinner, toast } from '../../components/ui';
import { ChatMessage } from '../../components/ChatMessage';
import { computePath, newestLeafUnder } from '../../tree';
import type { AdminChatDetail, Message } from '../../types';

/* Read-only view of another person's conversation. The same message
   component the owner sees, minus every handler — no edit, regenerate,
   delete, branch, bookmark or follow-up. Version arrows still work, but they
   only move THIS view: the owner's saved branch is never touched. */

export default function UserChat() {
  const { id: userId, chatId } = useParams<{ id: string; chatId: string }>();
  const [data, setData] = useState<AdminChatDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    api.get<AdminChatDetail>(`/api/admin/chats/${chatId}`)
      .then((r) => { if (alive) { setData(r); setLeafId(r.chat.currentLeafId); } })
      .catch((e) => { if (alive) { setData(null); toast(errMsg(e), 'err'); } })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [chatId]);

  const messages = data?.messages ?? [];
  const path = useMemo(() => computePath(messages, leafId), [messages, leafId]);

  function switchSibling(m: Message, dir: -1 | 1) {
    const sibs = messages.filter((x) => x.parentId === m.parentId);
    const idx = sibs.findIndex((x) => x.id === m.id);
    const target = sibs[idx + dir];
    if (target) setLeafId(newestLeafUnder(messages, target.id));
  }

  if (!loaded) {
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <EmptyState
          title="对话不存在"
          hint="它可能已被用户删除,或临时对话已过期清理。"
          action={<Link to={`/admin/users/${userId}`}><Button variant="outline" size="sm">返回用户详情</Button></Link>}
        />
      </div>
    );
  }

  const { user, chat } = data;
  const ownerLabel = user.displayName || user.username;
  const branchCount = messages.length - path.length;

  return (
    <div className="mx-auto max-w-[54rem] space-y-5 p-4 sm:p-6">
      <div className="space-y-3">
        <Link to={`/admin/users/${user.id}`}
          className="inline-flex items-center gap-1 text-xs text-tx3 transition-colors hover:text-tx">
          <ArrowLeft size={13} />返回 {ownerLabel} 的详情
        </Link>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight text-tx">
              {chat.title.trim() || '未命名对话'}
            </h1>
            {chat.pinned && <Badge><Pin size={10} />置顶</Badge>}
            {chat.archived && <Badge><Archive size={10} />归档</Badge>}
            {chat.temporary && <Badge tone="warn"><Timer size={10} />临时</Badge>}
            {chat.projectName && <Badge><FolderOpen size={10} />{chat.projectName}</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-tx3">
            <span>{ownerLabel}{user.displayName ? ` (@${user.username})` : ''}</span>
            {chat.modelName && <span className="font-mono">{chat.modelName}</span>}
            <span className="tabular-nums">创建于 {fmtDate(chat.createdAt)}</span>
            <span className="tabular-nums">最后活动 {fmtDate(chat.updatedAt)}</span>
            <span className="tabular-nums">{chat.messageCount} 条消息</span>
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-line bg-bg1 px-3 py-2 text-xs leading-relaxed text-tx2">
          <Eye size={14} className="mt-0.5 shrink-0 text-tx3" />
          <span>
            只读视图:按对方当前所在的分支显示
            {branchCount > 0 ? `,另有 ${branchCount} 条消息在其他版本分支里,可用消息下方的左右箭头查看` : ''}
            。这里的任何切换都不会改动对方的对话。
          </span>
        </div>

        {chat.systemPrompt && (
          <div className="rounded-lg border border-line bg-bg1">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-xs font-medium text-tx2 transition-colors hover:text-tx"
              onClick={() => setPromptOpen((v) => !v)}
            >
              <span>对话系统提示</span>
              {promptOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {promptOpen && (
              <pre className="whitespace-pre-wrap border-t border-line px-3 py-2 font-sans text-xs leading-relaxed text-tx2">
                {chat.systemPrompt}
              </pre>
            )}
          </div>
        )}
      </div>

      {path.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line2 px-3 py-8 text-center text-xs text-tx3">
          这个对话还没有任何消息
        </p>
      ) : (
        <div className="flex flex-col gap-7 pb-10">
          {path.map((m) => {
            const sibs = messages.filter((x) => x.parentId === m.parentId);
            const sibIdx = sibs.findIndex((x) => x.id === m.id);
            return (
              <ChatMessage
                key={m.id}
                msg={m}
                isStreaming={false}
                siblingInfo={sibs.length > 1 ? { index: sibIdx, total: sibs.length } : undefined}
                onSiblingPrev={sibIdx > 0 ? () => switchSibling(m, -1) : undefined}
                onSiblingNext={sibIdx < sibs.length - 1 ? () => switchSibling(m, 1) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
