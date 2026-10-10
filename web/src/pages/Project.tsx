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
import { ProjectDocDialog } from '../components/ProjectDocDialog';
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, ModalActions, PageHeader, Select, Spinner, Textarea,
  confirmDialog, toast,
} from '../components/ui';
import type {
  ChatSummary, DirectoryUser, ModelInfo, Project, ProjectAccessMode, ProjectDoc, ProjectLimits, ProjectMember,
  ProjectMemberRole,
} from '../types';
import { locale, t } from '../i18n';

const ACCESS_LABEL: Record<ProjectAccessMode, string> = { private: t('仅自己'), shared: t('所有人'), restricted: t('指定成员') };
const ROLE_LABEL = { owner: t('所有者'), editor: t('可编辑'), viewer: t('可查看') } as const;

function userLabel(u: { username: string; displayName: string | null }) {
  return u.displayName ? t('{name}({username})', { name: u.displayName, username: u.username }) : u.username;
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
      toast(t('共享设置已保存'), 'ok');
      onClose();
    } catch (e) { toast(errText(e, t('保存失败')), 'err'); }
    finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('共享项目')}
      desc={t('共享的是项目指令和参考资料;每个人在项目里的对话仍然只有自己能看到。')}>
      <div className="space-y-5">
        <Field label={t('谁可以使用这个项目')}>
          <div className="grid gap-2 sm:grid-cols-3">
            {(['private', 'restricted', 'shared'] as ProjectAccessMode[]).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                className={`cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                  mode === m ? 'border-acc ring-1 ring-acc' : 'border-line hover:border-field'}`}>
                <div className="text-[13px] font-medium text-tx">{ACCESS_LABEL[m]}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-tx3">
                  {m === 'private' ? t('只有你能看到') : m === 'restricted' ? t('下方名单里的人可以用') : t('所有登录用户都可以用')}
                </div>
              </button>
            ))}
          </div>
        </Field>

        <Field label={mode === 'shared' ? t('额外授予编辑权限') : t('成员')}
          hint={mode === 'shared'
            ? t('所有人默认只能查看和使用;在这里列出的人还可以修改项目指令、增删资料。')
            : mode === 'restricted'
              ? t('「可编辑」的成员可以修改项目指令、增删资料;「可查看」只能使用。')
              : t('项目设为「仅自己」时,名单会保留但不生效。')}>
          <div className="space-y-2">
            {list.length > 0 && (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {list.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-tx">{userLabel(m)}</span>
                    <Select value={m.role} className="w-28"
                      onChange={(e) => setList((l) => l.map((x) => x.userId === m.userId ? { ...x, role: e.target.value as ProjectMemberRole } : x))}>
                      <option value="viewer">{t('可查看')}</option>
                      <option value="editor">{t('可编辑')}</option>
                    </Select>
                    <button type="button" title={t('移除')} className="cursor-pointer rounded-sm p-1 text-tx3 hover:bg-bg2 hover:text-err"
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
              <option value="">{directory === null ? t('加载用户…') : remaining.length ? t('添加成员…') : t('没有更多可添加的用户')}</option>
              {remaining.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
            </Select>
          </div>
        </Field>

        <ModalActions>
          <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner className="h-3.5 w-3.5" />}{t('保存')}
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
  // model → admin default.
  const models = useModels((s) => s.models);
  const modelsLoaded = useModels((s) => s.loaded);
  const loadModels = useModels((s) => s.load);
  const loadMcp = useMcp((s) => s.load);
  const [modelSel, setModelSel] = useState<ModelInfo | null>(null);
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

  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // One dialog views, edits and creates a document; id null = a new one.
  const [docDialog, setDocDialog] = useState<{ id: string | null } | null>(null);

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
      text, attachments, modelId: modelSel?.id ?? null, settings, mcpSelected,
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
      toast(t('项目指令已保存'), 'ok');
    } catch (e) { toast(errText(e, t('保存失败')), 'err'); }
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
    } catch (e) { toast(errText(e, t('保存失败')), 'err'); }
    finally { setSavingMeta(false); }
  }

  async function removeProject() {
    if (!project) return;
    const ok = await confirmDialog(
      t('删除项目'),
      t('将删除项目「{name}」及其全部资料。项目里的对话会保留,只是以后不再自动带上项目的要求和资料。', { name: project.name }),
    );
    if (!ok) return;
    try {
      await api.del(`/api/projects/${project.id}`);
      projectsStore.remove(project.id);
      // Their chats survive with projectId cleared server-side.
      chatsStore.load().catch(() => { /* stale summaries are harmless */ });
      toast(t('项目已删除'), 'ok');
      nav('/');
    } catch (e) { toast(errText(e, t('删除失败')), 'err'); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!project || !limits || !files?.length || uploading) return;
    setUploading(true);
    let added = 0;
    let running = totalChars;
    try {
      for (const file of Array.from(files)) {
        try {
          if (file.size > limits.maxDocChars * 4) throw new Error(t('「{name}」过大', { name: file.name }));
          const content = await file.text();
          if (content.includes('\u0000')) throw new Error(t('「{name}」不是文本文件', { name: file.name }));
          if (!content.trim()) throw new Error(t('「{name}」是空文件', { name: file.name }));
          if (content.length > limits.maxDocChars) {
            throw new Error(t('「{name}」超出单文档上限({limit} 字符)', { name: file.name, limit: limits.maxDocChars.toLocaleString(locale) }));
          }
          if (running + content.length > limits.maxTotalChars) {
            throw new Error(t('资料总量将超出上限,「{name}」未上传', { name: file.name }));
          }
          const r = await api.post<{ doc: ProjectDoc }>(`/api/projects/${project.id}/docs`, {
            name: file.name.slice(0, 200), content,
          });
          setDocs((prev) => [...prev, r.doc]);
          running += r.doc.chars;
          added++;
        } catch (e) { toast(errText(e, t('上传失败')), 'err'); }
      }
      if (added) toast(t('已添加 {n} 个文档', { n: added }), 'ok');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function openDoc(doc: ProjectDoc) {
    setDocDialog({ id: doc.id });
  }

  function newDoc() {
    if (limits && docs.length >= limits.maxDocs) { toast(t('每个项目最多 {n} 个文档', { n: limits.maxDocs }), 'err'); return; }
    setDocDialog({ id: null });
  }

  async function removeDoc(doc: ProjectDoc) {
    if (!project) return;
    const ok = await confirmDialog(t('删除文档'), t('将从项目资料中移除「{name}」。', { name: doc.name }));
    if (!ok) return;
    try {
      await api.del(`/api/projects/${project.id}/docs/${doc.id}`);
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (e) { toast(errText(e, t('删除失败')), 'err'); }
  }

  const headerLeft = !sidebarOpen && (
    <Button variant="ghost" size="icon" title={t('打开侧栏')} onClick={() => setSidebarOpen(true)}>
      <PanelLeft size={16} />
    </Button>
  );

  if (failed) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title={t('项目')} left={headerLeft} />
        <EmptyState icon={<FolderClosed size={22} />} title={t('项目不存在或已被删除')}
          action={<Button variant="outline" size="sm" onClick={() => nav('/')}>{t('回到对话')}</Button>} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title={t('项目')} left={headerLeft} />
        <div className="flex flex-1 items-center justify-center text-tx3"><Spinner className="h-6 w-6" /></div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader left={headerLeft} title={
        <span className="flex items-center gap-1">
          <Link to="/projects" className="shrink-0 font-normal text-tx3 transition-colors hover:text-tx hover:underline">{t('项目')}</Link>
          <ChevronRight size={13} className="shrink-0 text-tx3" />
          <span className="truncate">{project.name}</span>
        </span>
      }>
        {isOwner && (
          <>
            <Button variant="ghost" size="iconSm" title={t('共享设置')} onClick={() => setSharingOpen(true)}>
              <Users size={14} className={project.accessMode !== 'private' ? 'text-acc' : ''} />
            </Button>
            <Button variant="ghost" size="iconSm" title={t('编辑名称与描述')}
              onClick={() => { setNameDraft(project.name); setDescDraft(project.description ?? ''); setEditOpen(true); }}>
              <Pencil size={14} />
            </Button>
            <Button variant="dangerGhost" size="iconSm" title={t('删除项目')} onClick={removeProject}>
              <Trash2 size={14} />
            </Button>
          </>
        )}
        <Button variant="primary" size="sm" onClick={() => nav(`/?project=${project.id}`)}>
          <MessageSquarePlus size={14} />{t('新对话')}
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
                      ? <>{t('共享给{scope}', { scope: ACCESS_LABEL[project.accessMode] })}{project.accessMode !== 'shared' && memberCount > 0 ? t(' · {n} 位成员', { n: memberCount }) : ''}</>
                      : <>{t('由 {owner} 共享', { owner: userLabel(project.owner) })}</>}
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
              mcpSelected={mcpSelected}
              onMcpChange={setMcpSelected}
              settings={settings}
              onSettingsChange={setSettings}
              onSend={startChat}
              onStop={() => { /* nothing streams here */ }}
              draftKey={`project:${project.id}`}
            />

            <Card title={t('项目内对话')} flush>
              {chats.length === 0 ? (
                <EmptyState icon={<MessageSquarePlus size={22} />} title={t('还没有对话')}
                  hint={t('在上方输入框说点什么,就会在这个项目里开启第一个对话。')} />
              ) : (
                <div className="divide-y divide-line">
                  {chats.map((c) => (
                    <Link key={c.id} to={`/chat/${c.id}`}
                      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-bg2">
                      <span className="min-w-0 flex-1 truncate text-sm text-tx">{c.title || t('新对话')}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-tx3">{fmtTime(c.updatedAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card title={t('项目指令')} desc={canEdit
              ? t('写给 AI 的固定要求,项目里的每个对话都会自动遵守,不用每次重复说。')
              : t('写给 AI 的固定要求,项目里的每个对话都会自动遵守。你只有查看权限。')}>
              {canEdit ? (
                <>
                  <Textarea rows={7} value={instrDraft} onChange={(e) => setInstrDraft(e.target.value)}
                    maxLength={limits?.maxInstructionsChars} className="text-[13px]"
                    placeholder={t('例如:回答一律用中文,代码示例用 TypeScript,引用资料时注明文档名…')} />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] tabular-nums text-tx3">
                      {instrDraft.length.toLocaleString(locale)} / {limits?.maxInstructionsChars.toLocaleString(locale)}
                    </span>
                    <Button variant="primary" size="xs" disabled={!instrDirty || savingInstr} onClick={saveInstructions}>
                      {savingInstr && <Spinner className="h-3 w-3" />}{t('保存')}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-tx2">
                  {project.instructions?.trim() || <span className="text-tx3">{t('所有者还没有写项目指令。')}</span>}
                </p>
              )}
            </Card>

            <Card title={t('参考资料')} desc={t('仅支持文本文件(txt / md / 代码等)。')}
              actions={canEdit && (
                <>
                  <Button variant="ghost" size="iconSm" title={t('新建文本')} onClick={newDoc}>
                    <FilePlus size={14} />
                  </Button>
                  <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden"
                    onChange={(e) => void uploadFiles(e.target.files)} />
                  <Button variant="ghost" size="iconSm" title={t('上传文档')} disabled={uploading}
                    onClick={() => fileRef.current?.click()}>
                    {uploading ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
                  </Button>
                </>
              )}>
              {docs.length === 0 ? (
                <p className="py-2 text-xs leading-relaxed text-tx3">
                  {canEdit ? t('上传或新建项目相关的文档、规范或笔记,模型回答时会优先依据它们。') : t('这个项目还没有参考资料。')}
                </p>
              ) : (
                <>
                  <div className="space-y-0.5">
                    {docs.map((d) => (
                      <div key={d.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-bg2">
                        <FileText size={13} className="shrink-0 text-tx3" />
                        <button className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-tx hover:text-acc"
                          title={canEdit
                            ? t('{name} · {chars} 字符 · 点击编辑', { name: d.name, chars: d.chars.toLocaleString(locale) })
                            : t('{name} · {chars} 字符', { name: d.name, chars: d.chars.toLocaleString(locale) })} onClick={() => openDoc(d)}>
                          {d.name}
                        </button>
                        {canEdit && (
                          <Button variant="dangerGhost" size="iconXs" title={t('删除文档')}
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
                      {t('{docs} 个文档 · {chars} 字符', { docs: docs.length, chars: totalChars.toLocaleString(locale) })}
                      <br />
                      {limits.injectChars === 0
                        ? t('资料按需检索:先提供目录,模型需要时再搜索和阅读相关内容。请使用支持工具调用的模型。')
                        : totalChars <= limits.injectChars
                        ? t('资料不多,每次对话都整篇提供给模型')
                        : totalChars <= (limits.injectCharsMax ?? limits.injectChars)
                          ? t('长上下文模型(如 Claude、Gemini)整篇读取;其他模型放不下的部分按需检索')
                          : t('放得下的文档整篇提供,其余由模型按需检索')}
                    </p>
                  )}
                </>
              )}
            </Card>
          </div>
        </div>
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={t('编辑项目')}>
        <form onSubmit={(e) => { e.preventDefault(); void saveMeta(); }} className="space-y-4">
          <Field label={t('项目名称')} required>
            <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Field label={t('描述')} hint={t('一句话说明这个项目是做什么的,显示在页头。')}>
            <Input value={descDraft} onChange={(e) => setDescDraft(e.target.value)} maxLength={300} />
          </Field>
          <ModalActions>
            <Button variant="outline" onClick={() => setEditOpen(false)}>{t('取消')}</Button>
            <Button type="submit" variant="primary" disabled={savingMeta || !nameDraft.trim()}>
              {savingMeta && <Spinner className="h-3.5 w-3.5" />}{t('保存')}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      {isOwner && (
        <SharingModal open={sharingOpen} onClose={() => setSharingOpen(false)} project={project} members={members}
          onSaved={(p, m) => { setProject(p); setMembers(m); setMemberCount(m.length); syncStore(p); }} />
      )}

      {docDialog && limits && (
        <ProjectDocDialog projectId={project.id} docId={docDialog.id} canEdit={canEdit} maxDocChars={limits.maxDocChars}
          onSaved={(doc, created) => {
            setDocs((prev) => (created ? [...prev, doc] : prev.map((d) => (d.id === doc.id ? doc : d))));
            if (created) setDocDialog({ id: doc.id });
          }}
          onClose={() => setDocDialog(null)} />
      )}
    </div>
  );
}
