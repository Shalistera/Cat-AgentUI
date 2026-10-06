import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight, FilePlus, FileText, FolderClosed, MessageSquarePlus, PanelLeft, Pencil, Trash2, Upload, Users, X,
} from 'lucide-react';
import { api, fmtTime } from '../api';
import {
  chatHandoff, LAST_MODEL_KEY, useChats, useMcp, useModels, useProjects, useUi,
} from '../store';
import { Composer, type ComposerSettings, type PendingAttachment } from '../components/Composer';
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, ModalActions, PageHeader, Select, Spinner, Textarea,
  confirmDialog, toast,
} from '../components/ui';
import type {
  ChatSummary, DirectoryUser, ModelInfo, Project, ProjectAccessMode, ProjectDoc, ProjectLimits, ProjectMember,
  ProjectMemberRole,
} from '../types';

const ACCESS_LABEL: Record<ProjectAccessMode, string> = { private: '仅自己', shared: '所有人', restricted: '指定成员' };
const ROLE_LABEL = { owner: '所有者', editor: '可编辑', viewer: '可查看' } as const;

function userLabel(u: { username: string; displayName: string | null }) {
  return u.displayName ? `${u.displayName}(${u.username})` : u.username;
}

/** Owner-only sharing dialog: who may use the project, and who may edit it. */
function SharingModal({ open, onClose, project, members, onSaved }: {
  open: boolean; onClose(): void; project: Project; members: ProjectMember[];
  onSaved(p: Project, members: ProjectMember[]): void;
}) {
  const [mode, setMode] = useState<ProjectAccessMode>(project.accessMode);
  const [list, setList] = useState<ProjectMember[]>(members);
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(project.accessMode); setList(members);
    api.get<{ users: DirectoryUser[] }>('/api/users/directory')
      .then((r) => setDirectory(r.users))
      .catch(() => setDirectory([]));
  }, [open, project.accessMode, members]);

  const remaining = (directory ?? []).filter((u) => !list.some((m) => m.userId === u.id));

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const r = await api.put<{ project: Project; members: ProjectMember[] }>(`/api/projects/${project.id}/sharing`, {
        accessMode: mode, members: list.map((m) => ({ userId: m.userId, role: m.role })),
      });
      onSaved(r.project, r.members);
      toast('共享设置已保存', 'ok');
      onClose();
    } catch (e) { toast(errText(e, '保存失败'), 'err'); }
    finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="共享项目"
      desc="共享的是项目指令和参考资料;每个人在项目里的对话仍然只有自己能看到。">
      <div className="space-y-5">
        <Field label="谁可以使用这个项目">
          <div className="grid gap-2 sm:grid-cols-3">
            {(['private', 'restricted', 'shared'] as ProjectAccessMode[]).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                className={`cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                  mode === m ? 'border-acc ring-1 ring-acc' : 'border-line hover:border-field'}`}>
                <div className="text-[13px] font-medium text-tx">{ACCESS_LABEL[m]}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-tx3">
                  {m === 'private' ? '只有你能看到' : m === 'restricted' ? '下方名单里的人可以用' : '所有登录用户都可以用'}
                </div>
              </button>
            ))}
          </div>
        </Field>

        <Field label={mode === 'shared' ? '额外授予编辑权限' : '成员'}
          hint={mode === 'shared'
            ? '所有人默认只能查看和使用;在这里列出的人还可以修改项目指令、增删资料。'
            : mode === 'restricted'
              ? '「可编辑」的成员可以修改项目指令、增删资料;「可查看」只能使用。'
              : '项目设为「仅自己」时,名单会保留但不生效。'}>
          <div className="space-y-2">
            {list.length > 0 && (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {list.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-tx">{userLabel(m)}</span>
                    <Select value={m.role} className="w-28"
                      onChange={(e) => setList((l) => l.map((x) => x.userId === m.userId ? { ...x, role: e.target.value as ProjectMemberRole } : x))}>
                      <option value="viewer">可查看</option>
                      <option value="editor">可编辑</option>
                    </Select>
                    <button type="button" title="移除" className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-err"
                      onClick={() => setList((l) => l.filter((x) => x.userId !== m.userId))}><X size={13} /></button>
                  </li>
                ))}
              </ul>
            )}
            <Select value="" disabled={directory === null || remaining.length === 0}
              onChange={(e) => {
                const u = remaining.find((x) => x.id === e.target.value);
                if (u) setList((l) => [...l, { userId: u.id, username: u.username, displayName: u.displayName, role: 'viewer' }]);
              }}>
              <option value="">{directory === null ? '加载用户…' : remaining.length ? '添加成员…' : '没有更多可添加的用户'}</option>
              {remaining.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </Select>
          </div>
        </Field>

        <ModalActions>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner className="h-3.5 w-3.5" />}保存
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// Client-side gate for "text only": anything with a NUL byte is binary, and a
// hard read via file.text() means the server never sees non-text payloads.
const ACCEPT = '.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.log,.ini,.toml,.sql,.py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.c,.h,.cpp,.sh,text/*';

function errText(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback;
}

export default function ProjectPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { sidebarOpen, setSidebarOpen } = useUi();
  const projectsStore = useProjects();
  const chatsStore = useChats();

  const [project, setProject] = useState<Project | null>(null);
  const [docs, setDocs] = useState<ProjectDoc[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [limits, setLimits] = useState<ProjectLimits | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const [instrDraft, setInstrDraft] = useState('');
  const [savingInstr, setSavingInstr] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  // Composer state — same defaults as a fresh chat on the chat page: last used
  // model → admin default, and 联网搜索 following the model's admin default.
  const models = useModels((s) => s.models);
  const modelsLoaded = useModels((s) => s.loaded);
  const loadModels = useModels((s) => s.load);
  const loadMcp = useMcp((s) => s.load);
  const mcpServers = useMcp((s) => s.servers);
  const [modelSel, setModelSel] = useState<ModelInfo | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [mcpSelected, setMcpSelected] = useState<string[]>([]);
  const [settings, setSettings] = useState<ComposerSettings>({ systemPrompt: '', reasoningEffort: 'off' });

  useEffect(() => {
    loadModels().catch(() => { /* composer shows the disabled state */ });
    loadMcp().catch(() => { /* optional */ });
  }, [loadModels, loadMcp]);

  useEffect(() => {
    if (!modelsLoaded) return;
    if (modelSel && models.some((m) => m.id === modelSel.id)) return;
    const last = localStorage.getItem(LAST_MODEL_KEY);
    // an image model is only ever picked deliberately, never as the default
    const pick = models.find((m) => m.id === last)
      ?? models.find((m) => m.isDefault && !m.imageGen)
      ?? models.find((m) => !m.imageGen)
      ?? models[0]
      ?? null;
    setModelSel(pick);
  }, [modelsLoaded, models]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!modelSel) return;
    const fallback = mcpServers.some((s) => s.isSearch && s.enabled);
    const available = modelSel.nativeSearch || (fallback && modelSel.tools && !modelSel.imageGen);
    setWebSearch(available && modelSel.defaultWebSearch);
  }, [mcpServers, modelSel]);

  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // One dialog views, edits and creates a document; id null = not saved yet.
  const [docEditor, setDocEditor] = useState<{
    id: string | null; name: string; content: string; savedName: string; savedContent: string;
  } | null>(null);
  const [savingDoc, setSavingDoc] = useState(false);

  useEffect(() => {
    if (!id) return;
    setProject(null); setFailed(false);
    api.get<{
      project: Project; docs: ProjectDoc[]; chats: ChatSummary[]; limits: ProjectLimits;
      members: ProjectMember[] | null; memberCount: number;
    }>(`/api/projects/${id}`)
      .then((r) => {
        setProject(r.project); setDocs(r.docs); setChats(r.chats); setLimits(r.limits);
        setMembers(r.members ?? []); setMemberCount(r.memberCount);
        setInstrDraft(r.project.instructions ?? '');
      })
      .catch(() => setFailed(true));
  }, [id]);

  function startChat(text: string, attachments: PendingAttachment[]) {
    if (!project) return;
    chatHandoff.payload = {
      text, attachments, modelId: modelSel?.id ?? null, settings, webSearch, mcpSelected,
    };
    nav(`/?project=${project.id}`);
  }

  const totalChars = docs.reduce((n, d) => n + d.chars, 0);
  const instrDirty = project != null && instrDraft !== (project.instructions ?? '');
  const isOwner = project?.role === 'owner';
  const canEdit = project?.role === 'owner' || project?.role === 'editor';
  const isShared = project != null && (project.accessMode !== 'private' || project.role !== 'owner');

  function syncStore(p: Project) {
    projectsStore.upsert({ ...p, docCount: docs.length, totalChars });
  }

  async function saveInstructions() {
    if (!project || savingInstr) return;
    setSavingInstr(true);
    try {
      const r = await api.patch<{ project: Project }>(`/api/projects/${project.id}`, {
        instructions: instrDraft.trim() === '' ? null : instrDraft,
      });
      setProject(r.project);
      setInstrDraft(r.project.instructions ?? '');
      syncStore(r.project);
      toast('项目指令已保存', 'ok');
    } catch (e) { toast(errText(e, '保存失败'), 'err'); }
    finally { setSavingInstr(false); }
  }

  async function saveMeta() {
    if (!project || savingMeta || !nameDraft.trim()) return;
    setSavingMeta(true);
    try {
      const r = await api.patch<{ project: Project }>(`/api/projects/${project.id}`, {
        name: nameDraft.trim(),
        description: descDraft.trim() === '' ? null : descDraft.trim(),
      });
      setProject(r.project);
      syncStore(r.project);
      setEditOpen(false);
    } catch (e) { toast(errText(e, '保存失败'), 'err'); }
    finally { setSavingMeta(false); }
  }

  async function removeProject() {
    if (!project) return;
    const ok = await confirmDialog(
      '删除项目',
      `将删除项目「${project.name}」及其全部资料。项目里的对话会保留,只是以后不再自动带上项目的要求和资料。`,
    );
    if (!ok) return;
    try {
      await api.del(`/api/projects/${project.id}`);
      projectsStore.remove(project.id);
      // Their chats survive with projectId cleared server-side.
      chatsStore.load().catch(() => { /* stale summaries are harmless */ });
      toast('项目已删除', 'ok');
      nav('/');
    } catch (e) { toast(errText(e, '删除失败'), 'err'); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!project || !limits || !files?.length || uploading) return;
    setUploading(true);
    let added = 0;
    let running = totalChars;
    try {
      for (const file of Array.from(files)) {
        try {
          if (file.size > limits.maxDocChars * 4) throw new Error(`「${file.name}」过大`);
          const content = await file.text();
          if (content.includes('\u0000')) throw new Error(`「${file.name}」不是文本文件`);
          if (!content.trim()) throw new Error(`「${file.name}」是空文件`);
          if (content.length > limits.maxDocChars) {
            throw new Error(`「${file.name}」超出单文档上限(${limits.maxDocChars.toLocaleString()} 字符)`);
          }
          if (running + content.length > limits.maxTotalChars) {
            throw new Error(`资料总量将超出上限,「${file.name}」未上传`);
          }
          const r = await api.post<{ doc: ProjectDoc }>(`/api/projects/${project.id}/docs`, {
            name: file.name.slice(0, 200), content,
          });
          setDocs((prev) => [...prev, r.doc]);
          running += r.doc.chars;
          added++;
        } catch (e) { toast(errText(e, '上传失败'), 'err'); }
      }
      if (added) toast(`已添加 ${added} 个文档`, 'ok');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function openDoc(doc: ProjectDoc) {
    if (!project) return;
    try {
      const r = await api.get<{ doc: ProjectDoc & { content: string } }>(`/api/projects/${project.id}/docs/${doc.id}`);
      setDocEditor({ id: r.doc.id, name: r.doc.name, content: r.doc.content, savedName: r.doc.name, savedContent: r.doc.content });
    } catch (e) { toast(errText(e, '读取失败'), 'err'); }
  }

  function newDoc() {
    if (limits && docs.length >= limits.maxDocs) { toast(`每个项目最多 ${limits.maxDocs} 个文档`, 'err'); return; }
    setDocEditor({ id: null, name: '', content: '', savedName: '', savedContent: '' });
  }

  const docDirty = docEditor != null
    && (docEditor.name !== docEditor.savedName || docEditor.content !== docEditor.savedContent);

  // Escape reaches this dialog and the confirm on top of it alike; one ask at a time.
  const askingDiscard = useRef(false);
  async function closeDocEditor() {
    if (askingDiscard.current) return;
    if (docDirty) {
      askingDiscard.current = true;
      const discard = await confirmDialog('放弃修改', '这份资料的修改还没有保存,确定关闭吗?');
      askingDiscard.current = false;
      if (!discard) return;
    }
    setDocEditor(null);
  }

  async function saveDoc() {
    if (!project || !limits || !docEditor || savingDoc || !docDirty) return;
    const name = docEditor.name.trim();
    const { content } = docEditor;
    if (!name) { toast('请填写资料名称', 'err'); return; }
    if (!content.trim()) { toast('资料内容不能为空', 'err'); return; }
    if (content.length > limits.maxDocChars) {
      toast(`超出单文档上限(${limits.maxDocChars.toLocaleString()} 字符)`, 'err');
      return;
    }
    setSavingDoc(true);
    try {
      if (docEditor.id) {
        const r = await api.patch<{ doc: ProjectDoc & { content: string } }>(
          `/api/projects/${project.id}/docs/${docEditor.id}`,
          {
            ...(name !== docEditor.savedName ? { name } : {}),
            ...(content !== docEditor.savedContent ? { content } : {}),
          },
        );
        const { content: saved, ...meta } = r.doc;
        setDocs((prev) => prev.map((d) => (d.id === meta.id ? meta : d)));
        setDocEditor({ id: meta.id, name: meta.name, content: saved, savedName: meta.name, savedContent: saved });
      } else {
        const r = await api.post<{ doc: ProjectDoc }>(`/api/projects/${project.id}/docs`, { name, content });
        setDocs((prev) => [...prev, r.doc]);
        setDocEditor({ id: r.doc.id, name: r.doc.name, content, savedName: r.doc.name, savedContent: content });
      }
      toast('资料已保存', 'ok');
    } catch (e) { toast(errText(e, '保存失败'), 'err'); }
    finally { setSavingDoc(false); }
  }

  async function removeDoc(doc: ProjectDoc) {
    if (!project) return;
    const ok = await confirmDialog('删除文档', `将从项目资料中移除「${doc.name}」。`);
    if (!ok) return;
    try {
      await api.del(`/api/projects/${project.id}/docs/${doc.id}`);
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (e) { toast(errText(e, '删除失败'), 'err'); }
  }

  const headerLeft = !sidebarOpen && (
    <Button variant="ghost" size="icon" title="打开侧栏" onClick={() => setSidebarOpen(true)}>
      <PanelLeft size={16} />
    </Button>
  );

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="项目" left={headerLeft} />
        <EmptyState icon={<FolderClosed size={22} />} title="项目不存在或已被删除"
          action={<Button variant="outline" size="sm" onClick={() => nav('/')}>回到对话</Button>} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="项目" left={headerLeft} />
        <div className="flex flex-1 items-center justify-center text-tx3"><Spinner className="h-6 w-6" /></div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader left={headerLeft} title={
        <span className="flex items-center gap-1">
          <Link to="/projects" className="shrink-0 font-normal text-tx3 transition-colors hover:text-tx hover:underline">项目</Link>
          <ChevronRight size={13} className="shrink-0 text-tx3" />
          <span className="truncate">{project.name}</span>
        </span>
      }>
        {isOwner && (
          <>
            <Button variant="ghost" size="iconSm" title="共享设置" onClick={() => setSharingOpen(true)}>
              <Users size={14} className={project.accessMode !== 'private' ? 'text-acc' : ''} />
            </Button>
            <Button variant="ghost" size="iconSm" title="编辑名称与描述"
              onClick={() => { setNameDraft(project.name); setDescDraft(project.description ?? ''); setEditOpen(true); }}>
              <Pencil size={14} />
            </Button>
            <Button variant="dangerGhost" size="iconSm" title="删除项目" onClick={removeProject}>
              <Trash2 size={14} />
            </Button>
          </>
        )}
        <Button variant="primary" size="sm" onClick={() => nav(`/?project=${project.id}`)}>
          <MessageSquarePlus size={14} />新对话
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto bg-bg0">
        {/* Conversations are the protagonist; instructions and docs sit in a
            quiet right-hand rail, the way the first-party project pages do. */}
        <div className="mx-auto grid max-w-5xl items-start gap-5 p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-5">
            {/* Hero: the project's identity sits right above where you talk to it. */}
            <div className="flex items-start gap-3 px-1 pt-1">
              <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-bg1 text-tx2 shadow-xs">
                <FolderClosed size={18} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-2xl font-semibold tracking-tight text-tx">{project.name}</h2>
                {project.description && <p className="mt-0.5 truncate text-[13px] text-tx3">{project.description}</p>}
                {isShared && (
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-tx3">
                    <Users size={11} />
                    {isOwner
                      ? <>共享给{ACCESS_LABEL[project.accessMode]}{project.accessMode !== 'shared' && memberCount > 0 ? ` · ${memberCount} 位成员` : ''}</>
                      : <>由 {userLabel(project.owner)} 共享</>}
                    <Badge tone={canEdit ? 'acc' : 'default'}>{ROLE_LABEL[project.role]}</Badge>
                  </p>
                )}
              </div>
            </div>

            {/* The real chat composer — model picker, tools and all; sending
                hands the full payload to the chat page, which auto-fires it. */}
            <Composer
              streaming={false}
              disabled={modelsLoaded && models.length === 0}
              model={modelSel}
              onModelChange={(m) => { setModelSel(m); localStorage.setItem(LAST_MODEL_KEY, m.id); }}
              webSearch={webSearch}
              onWebSearchChange={setWebSearch}
              mcpSelected={mcpSelected}
              onMcpChange={setMcpSelected}
              settings={settings}
              onSettingsChange={setSettings}
              onSend={startChat}
              onStop={() => { /* nothing streams here */ }}
              draftKey={`project:${project.id}`}
            />

            <Card title="项目内对话" flush>
              {chats.length === 0 ? (
                <EmptyState icon={<MessageSquarePlus size={22} />} title="还没有对话"
                  hint="在上方输入框说点什么,就会在这个项目里开启第一个对话。" />
              ) : (
                <div className="divide-y divide-line">
                  {chats.map((c) => (
                    <Link key={c.id} to={`/chat/${c.id}`}
                      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-bg2">
                      <span className="min-w-0 flex-1 truncate text-sm text-tx">{c.title || '新对话'}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-tx3">{fmtTime(c.updatedAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card title="项目指令" desc={canEdit
              ? '写给 AI 的固定要求,项目里的每个对话都会自动遵守,不用每次重复说。'
              : '写给 AI 的固定要求,项目里的每个对话都会自动遵守。你只有查看权限。'}>
              {canEdit ? (
                <>
                  <Textarea rows={7} value={instrDraft} onChange={(e) => setInstrDraft(e.target.value)}
                    maxLength={limits?.maxInstructionsChars} className="text-[13px]"
                    placeholder="例如:回答一律用中文,代码示例用 TypeScript,引用资料时注明文档名…" />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] tabular-nums text-tx3">
                      {instrDraft.length.toLocaleString()} / {limits?.maxInstructionsChars.toLocaleString()}
                    </span>
                    <Button variant="primary" size="xs" disabled={!instrDirty || savingInstr} onClick={saveInstructions}>
                      {savingInstr && <Spinner className="h-3 w-3" />}保存
                    </Button>
                  </div>
                </>
              ) : (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-tx2">
                  {project.instructions?.trim() || <span className="text-tx3">所有者还没有写项目指令。</span>}
                </p>
              )}
            </Card>

            <Card title="参考资料" desc="仅支持文本文件(txt / md / 代码等)。"
              actions={canEdit && (
                <>
                  <Button variant="ghost" size="iconSm" title="新建文本" onClick={newDoc}>
                    <FilePlus size={14} />
                  </Button>
                  <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden"
                    onChange={(e) => void uploadFiles(e.target.files)} />
                  <Button variant="ghost" size="iconSm" title="上传文档" disabled={uploading}
                    onClick={() => fileRef.current?.click()}>
                    {uploading ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
                  </Button>
                </>
              )}>
              {docs.length === 0 ? (
                <p className="py-2 text-xs leading-relaxed text-tx3">
                  {canEdit ? '上传或新建项目相关的文档、规范或笔记,模型回答时会优先依据它们。' : '这个项目还没有参考资料。'}
                </p>
              ) : (
                <>
                  <div className="space-y-0.5">
                    {docs.map((d) => (
                      <div key={d.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-bg2">
                        <FileText size={13} className="shrink-0 text-tx3" />
                        <button className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-tx hover:text-acc"
                          title={`${d.name} · ${d.chars.toLocaleString()} 字符${canEdit ? ' · 点击编辑' : ''}`} onClick={() => void openDoc(d)}>
                          {d.name}
                        </button>
                        {canEdit && (
                          <Button variant="dangerGhost" size="iconXs" title="删除文档"
                            className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                            onClick={() => void removeDoc(d)}>
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {limits && (
                    <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-tx3">
                      {docs.length} 个文档 · {totalChars.toLocaleString()} 字符
                      <br />
                      {totalChars <= limits.injectChars
                        ? '资料不多,每次对话都整篇提供给模型'
                        : totalChars <= (limits.injectCharsMax ?? limits.injectChars)
                          ? '长上下文模型(如 Claude、Gemini)整篇读取;其他模型放不下的部分按需检索'
                          : '放得下的文档整篇提供,其余由模型按需检索'}
                    </p>
                  )}
                </>
              )}
            </Card>
          </div>
        </div>
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="编辑项目">
        <form onSubmit={(e) => { e.preventDefault(); void saveMeta(); }} className="space-y-4">
          <Field label="项目名称" required>
            <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Field label="描述" hint="一句话说明这个项目是做什么的,显示在页头。">
            <Input value={descDraft} onChange={(e) => setDescDraft(e.target.value)} maxLength={300} />
          </Field>
          <ModalActions>
            <Button variant="outline" onClick={() => setEditOpen(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={savingMeta || !nameDraft.trim()}>
              {savingMeta && <Spinner className="h-3.5 w-3.5" />}保存
            </Button>
          </ModalActions>
        </form>
      </Modal>

      {isOwner && (
        <SharingModal open={sharingOpen} onClose={() => setSharingOpen(false)} project={project} members={members}
          onSaved={(p, m) => { setProject(p); setMembers(m); setMemberCount(m.length); syncStore(p); }} />
      )}

      <Modal open={docEditor !== null} onClose={() => void closeDocEditor()} wide
        title={!canEdit ? docEditor?.name ?? '' : docEditor?.id ? '编辑资料' : '新建资料'}>
        {docEditor && (canEdit ? (
          <form onSubmit={(e) => { e.preventDefault(); void saveDoc(); }} className="space-y-4"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveDoc(); }
            }}>
            <Field label="名称" required>
              <Input value={docEditor.name} maxLength={200} autoFocus={!docEditor.id}
                placeholder="如 产品规范.md"
                onChange={(e) => setDocEditor({ ...docEditor, name: e.target.value })} />
            </Field>
            <Field label="内容" required>
              <Textarea value={docEditor.content} rows={18} autoFocus={!!docEditor.id}
                className="max-h-[60vh] font-mono text-xs"
                onChange={(e) => setDocEditor({ ...docEditor, content: e.target.value })} />
            </Field>
            <ModalActions>
              <span className={`mr-auto self-center text-[11px] tabular-nums ${
                limits && docEditor.content.length > limits.maxDocChars ? 'text-err' : 'text-tx3'}`}>
                {docEditor.content.length.toLocaleString()} / {limits?.maxDocChars.toLocaleString()} 字符
              </span>
              <Button variant="outline" onClick={() => void closeDocEditor()}>关闭</Button>
              <Button type="submit" variant="primary" disabled={!docDirty || savingDoc}>
                {savingDoc && <Spinner className="h-3.5 w-3.5" />}保存
              </Button>
            </ModalActions>
          </form>
        ) : (
          <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-tx2">
            {docEditor.content}
          </pre>
        ))}
      </Modal>
    </div>
  );
}
