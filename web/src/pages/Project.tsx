import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight, FileText, FolderClosed, MessageSquarePlus, PanelLeft, Pencil, Trash2, Upload,
} from 'lucide-react';
import { api, fmtTime } from '../api';
import {
  chatHandoff, LAST_MODEL_KEY, searchPrefKey, useAuth, useChats, useMcp, useModels, useProjects, useUi,
} from '../store';
import { Composer, type ComposerSettings, type PendingImage } from '../components/Composer';
import {
  Button, Card, EmptyState, Field, Input, Modal, ModalActions, PageHeader, Spinner, Textarea,
  confirmDialog, toast,
} from '../components/ui';
import type { ChatSummary, ModelInfo, Project, ProjectDoc, ProjectLimits } from '../types';

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
  const [failed, setFailed] = useState(false);

  const [instrDraft, setInstrDraft] = useState('');
  const [savingInstr, setSavingInstr] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  // Composer state — same defaults as a fresh chat on the chat page: last used
  // model → admin default, and 联网搜索 on unless this user switched it off.
  const { user } = useAuth();
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
    if (localStorage.getItem(searchPrefKey(user?.id)) === '0') return;
    const fallback = mcpServers.some((s) => s.isSearch && s.enabled);
    if (modelSel?.nativeSearch || (fallback && modelSel?.tools && !modelSel.imageGen)) setWebSearch(true);
  }, [mcpServers, modelSel, user?.id]);

  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [viewingDoc, setViewingDoc] = useState<(ProjectDoc & { content: string }) | null>(null);

  useEffect(() => {
    if (!id) return;
    setProject(null); setFailed(false);
    api.get<{ project: Project; docs: ProjectDoc[]; chats: ChatSummary[]; limits: ProjectLimits }>(`/api/projects/${id}`)
      .then((r) => {
        setProject(r.project); setDocs(r.docs); setChats(r.chats); setLimits(r.limits);
        setInstrDraft(r.project.instructions ?? '');
      })
      .catch(() => setFailed(true));
  }, [id]);

  function startChat(text: string, images: PendingImage[]) {
    if (!project) return;
    chatHandoff.payload = {
      text, images, modelId: modelSel?.id ?? null, settings, webSearch, mcpSelected,
    };
    nav(`/?project=${project.id}`);
  }

  const totalChars = docs.reduce((n, d) => n + d.chars, 0);
  const instrDirty = project != null && instrDraft !== (project.instructions ?? '');

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
      `将删除项目「${project.name}」及其全部资料。项目内的对话会保留,只是不再携带项目上下文。`,
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

  async function viewDoc(doc: ProjectDoc) {
    if (!project) return;
    try {
      const r = await api.get<{ doc: ProjectDoc & { content: string } }>(`/api/projects/${project.id}/docs/${doc.id}`);
      setViewingDoc(r.doc);
    } catch (e) { toast(errText(e, '读取失败'), 'err'); }
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
        <Button variant="ghost" size="iconSm" title="编辑名称与描述"
          onClick={() => { setNameDraft(project.name); setDescDraft(project.description ?? ''); setEditOpen(true); }}>
          <Pencil size={14} />
        </Button>
        <Button variant="dangerGhost" size="iconSm" title="删除项目" onClick={removeProject}>
          <Trash2 size={14} />
        </Button>
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
            <Card title="项目指令" desc="项目内每个对话自动携带。">
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
            </Card>

            <Card title="参考资料" desc="仅支持文本文件(txt / md / 代码等)。"
              actions={
                <>
                  <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden"
                    onChange={(e) => void uploadFiles(e.target.files)} />
                  <Button variant="ghost" size="iconSm" title="上传文档" disabled={uploading}
                    onClick={() => fileRef.current?.click()}>
                    {uploading ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
                  </Button>
                </>
              }>
              {docs.length === 0 ? (
                <p className="py-2 text-xs leading-relaxed text-tx3">
                  上传项目相关的文档、规范或笔记,模型回答时会优先依据它们。
                </p>
              ) : (
                <>
                  <div className="space-y-0.5">
                    {docs.map((d) => (
                      <div key={d.id} className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-bg2">
                        <FileText size={13} className="shrink-0 text-tx3" />
                        <button className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-tx hover:text-acc"
                          title={`${d.name} · ${d.chars.toLocaleString()} 字符`} onClick={() => void viewDoc(d)}>
                          {d.name}
                        </button>
                        <Button variant="dangerGhost" size="iconXs" title="删除文档"
                          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                          onClick={() => void removeDoc(d)}>
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    ))}
                  </div>
                  {limits && (
                    <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-tx3">
                      {docs.length} 个文档 · {totalChars.toLocaleString()} 字符
                      <br />
                      {totalChars <= limits.injectChars
                        ? '资料量小,整体随对话提供'
                        : '对话中由模型按需检索'}
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

      <Modal open={viewingDoc !== null} onClose={() => setViewingDoc(null)} title={viewingDoc?.name ?? ''} wide>
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-tx2">
          {viewingDoc?.content}
        </pre>
      </Modal>
    </div>
  );
}
