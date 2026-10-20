import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { withCanvasCsp } from '../sandboxedHtml';
import {
  ChevronLeft, ChevronRight, Copy, CornerLeftUp, Download, FileCode, FileImage, FileText, File as FileIcon, Folder,
  FolderInput, FolderOpen, FolderPlus, Pencil, PencilLine, RefreshCw, Save, Trash2, Upload, X,
} from 'lucide-react';
import { api, downloadWorkspaceZip, errMsg, uploadWorkspaceFile } from '../api';
import { useComposerInsert, useWorkspacePanel } from '../store';
import { Markdown } from './Markdown';
import { Button, Input, Modal, ModalActions, Spinner, confirmDialog, toast } from './ui';
import type { WorkspaceFile, WorkspaceListing } from '../types';
import { locale, t, tServer } from '../i18n';

const headBtn = 'flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg3 hover:text-tx disabled:opacity-40 disabled:pointer-events-none';

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'html', 'htm', 'svg', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'sql', 'r', 'lua', 'tex', 'rst', 'log', 'diff', 'patch', 'mermaid', 'mmd', 'vue',
  'srt', 'vtt', 'docx']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const CODE_EXT = new Set(['json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'svg', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'sql', 'r', 'lua', 'vue']);

function extOf(p: string): string {
  const base = p.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}

function FileGlyph({ path, size = 14 }: { path: string; size?: number }) {
  const ext = extOf(path);
  const cls = 'shrink-0 text-tx3';
  if (IMAGE_EXT.has(ext)) return <FileImage size={size} className={cls} />;
  if (CODE_EXT.has(ext)) return <FileCode size={size} className={cls} />;
  if (TEXT_EXT.has(ext)) return <FileText size={size} className={cls} />;
  return <FileIcon size={size} className={cls} />;
}

function fileUrl(chatId: string, path: string, download = false, scopeKey?: string): string {
  return `/api/chats/${chatId}/workspace/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}${scopeKey ? `&scope=${encodeURIComponent(scopeKey)}` : ''}`;
}

// ---- preview / editor for one file ----

function FileView({ chatId, file, scopeKey, onBack, onChanged }: {
  chatId: string; file: WorkspaceFile; scopeKey: string; onBack(): void; onChanged(): void;
}) {
  // Keep an open editor tied to the directory from which its draft was loaded.
  const [fileScope] = useState(scopeKey);
  const ext = extOf(file.path);
  const isImage = IMAGE_EXT.has(ext);
  const isPdf = ext === 'pdf';
  const isText = TEXT_EXT.has(ext);
  const isMd = ext === 'md' || ext === 'markdown';
  const isHtml = ext === 'html' || ext === 'htm' || ext === 'svg';
  const editable = isText && ext !== 'docx';
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // md/html default to rendered; a toggle flips to source.
  const [rendered, setRendered] = useState(true);

  const load = useCallback(() => {
    if (!isText) { setText(null); return; }
    setText(null);
    setError(null);
    api.get<{ text: string }>(`${fileUrl(chatId, file.path, false, fileScope)}&text=1`)
      .then((r) => setText(r.text))
      .catch((e) => setError(errMsg(e)));
  }, [chatId, file.path, isText, fileScope]);

  // Reload when the same file changes underneath (model edited it) unless the
  // person is mid-edit — their draft must not be clobbered.
  useEffect(() => { if (!editing) load(); }, [load, file.mtime, file.size, editing]);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/api/chats/${chatId}/workspace/file?scope=${encodeURIComponent(fileScope)}`, { path: file.path, content: draft });
      setText(draft);
      setEditing(false);
      onChanged();
      toast(t('已保存'), 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setSaving(false); }
  }

  const copyLabel = editing ? t('复制草稿') : isMd || isHtml ? t('复制源码') : ext === 'docx' ? t('复制文本') : t('复制内容');
  async function copy() {
    if (text === null || error) return;
    try {
      await navigator.clipboard.writeText(editing ? draft : text);
      toast(t('已复制'), 'ok');
    } catch {
      toast(t('复制失败，请检查浏览器剪贴板权限，或手动选择内容复制。'), 'err');
    }
  }

  let body: ReactNode;
  if (error) {
    body = <p className="p-4 text-sm text-err">{error}</p>;
  } else if (isImage) {
    body = <div className="flex items-start justify-center p-4"><img src={fileUrl(chatId, file.path, false, fileScope)} alt={file.path} className="max-w-full rounded-md border border-line" /></div>;
  } else if (isPdf) {
    body = <iframe src={fileUrl(chatId, file.path, false, fileScope)} title={file.path} className="h-full w-full border-0" />;
  } else if (!isText) {
    body = (
      <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-tx3">
        <FileIcon size={28} />
        <div>{t('无法预览这种文件({size})', { size: fmtBytes(file.size) })}</div>
        <a href={fileUrl(chatId, file.path, true, fileScope)} className="text-acc hover:underline">{t('下载')}</a>
      </div>
    );
  } else if (text === null) {
    body = <div className="flex justify-center py-10 text-tx3"><Spinner /></div>;
  } else if (editing) {
    body = (
      <textarea
        className="h-full w-full resize-none bg-bg1 p-4 font-mono text-[12.5px] leading-relaxed text-tx outline-none"
        value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
      />
    );
  } else if (isMd && rendered) {
    body = <div className="p-4"><Markdown text={text} workspaceChatId={chatId} /></div>;
  } else if (isHtml && rendered) {
    // No allow-same-origin: a model-written page must not reach our cookies.
    body = <iframe sandbox="allow-scripts allow-modals" srcDoc={withCanvasCsp(text)} title={file.path} className="h-full w-full border-0 bg-white" />;
  } else {
    body = <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed text-tx">{text}</pre>;
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-line bg-bg2 py-1.5 pl-2 pr-2">
        <button className={headBtn} title={t('返回文件列表')} onClick={onBack}><ChevronLeft size={15} /></button>
        <FileGlyph path={file.path} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-tx" title={file.path}>{file.path}</span>
        <span className="mr-1 shrink-0 text-[11px] tabular-nums text-tx3">{fmtBytes(file.size)}</span>
        {(isMd || isHtml) && !editing && (
          <button className="h-7 cursor-pointer rounded-md px-2 text-[11px] text-tx2 hover:bg-bg3 hover:text-tx" onClick={() => setRendered((v) => !v)}>
            {rendered ? t('源码') : t('预览')}
          </button>
        )}
        {isText && (
          <button type="button" className={`${headBtn} shrink-0`} title={copyLabel} aria-label={copyLabel}
            onClick={copy} disabled={text === null || error !== null}>
            <Copy size={13} />
          </button>
        )}
        {editable && !editing && (
          <button className={headBtn} title={t('编辑')} onClick={() => { setDraft(text ?? ''); setEditing(true); }} disabled={text === null}>
            <Pencil size={13} />
          </button>
        )}
        {editing && (
          <>
            <button className={headBtn} title={t('保存')} onClick={save} disabled={saving}>{saving ? <Spinner className="h-3.5 w-3.5" /> : <Save size={14} />}</button>
            <button className={headBtn} title={t('放弃修改')} onClick={() => setEditing(false)}><X size={14} /></button>
          </>
        )}
        {!editing && (
          <a className={headBtn} title={t('下载')} href={fileUrl(chatId, file.path, true, fileScope)}><Download size={14} /></a>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </>
  );
}

// ---- guidance: what the workspace is for, as tasks you can try ----
// Clicking one drops the prompt into the composer; sending stays the person's call.
const STARTERS: { label: string; prompt: string }[] = [
  { label: t('把一段内容整理成 Word 或 PDF'), prompt: t('帮我把下面这段内容整理成一份排版规范的报告,导出 PDF 和 Word 各一份:\n\n') },
  { label: t('写一篇长文,之后逐段修改'), prompt: t('帮我写一份 1500 字左右的方案初稿,保存到工作区;写完后我会逐段让你修改。主题是:') },
  { label: t('分析一份表格并出图'), prompt: t('我会上传一份 CSV / Excel,请按关键列做汇总统计、找出异常,画一张图表,结论写成 分析.md。') },
  { label: t('把上传的文档转换格式'), prompt: t('把我上传到工作区的文档转换成 PDF。') },
  { label: t('按大纲分章生成一份文档'), prompt: t('按下面的大纲写成完整文档,每章一个小节,保存为 文档.md:\n\n') },
];

function Starters({ compact = false }: { compact?: boolean }) {
  const insert = useComposerInsert((s) => s.insert);
  return (
    <div className={compact ? 'mt-3 w-full' : 'mt-4 w-full'}>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-tx3">{t('试试这些')}</div>
      <ul className="space-y-1">
        {STARTERS.map((s) => (
          <li key={s.label}>
            <button type="button" onClick={() => insert(s.prompt)} title={t('放进输入框,由你决定何时发送')}
              className="w-full cursor-pointer rounded-md border border-line bg-bg1 px-2.5 py-1.5 text-left text-xs text-tx2 transition-colors hover:border-acc/50 hover:bg-acc/5 hover:text-tx">
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}


// ---- folders, selection and batch operations ----

const rowBtn = 'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-tx3 transition-colors hover:bg-bg3 hover:text-tx disabled:opacity-40 disabled:pointer-events-none';
const barBtn = 'flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-tx2 transition-colors hover:bg-bg3 hover:text-tx disabled:opacity-40 disabled:pointer-events-none';
/** Marks a drag that started on a row, as opposed to files from the desktop. */
const DRAG_TYPE = 'application/x-caui-workspace';

const parentOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** Would moving `path` into `dir` put it inside itself? */
const intoItself = (path: string, dir: string) => dir === path || dir.startsWith(`${path}/`);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, locale, { numeric: true });

function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return t('名称不能为空');
  if (/[\\/]/.test(n)) return t('名称里不能有 / 或 \\');
  if (n.startsWith('.')) return t('名称不能以 . 开头');
  return null;
}

type Entry =
  | { kind: 'dir'; path: string; name: string; items: number; size: number }
  | { kind: 'file'; path: string; name: string; file: WorkspaceFile };

interface BatchFailure { path: string; error: string }

function reportFailures(failed: BatchFailure[]) {
  if (!failed.length) return;
  const first = `${baseOf(failed[0].path)}:${tServer(failed[0].error)}`;
  toast(failed.length === 1 ? first : t('{first}(另有 {count} 项失败)', { first, count: failed.length - 1 }), 'err');
}

function NameDialog({ title, initial = '', selectStem = false, confirm, onSubmit, onClose }: {
  title: string; initial?: string; selectStem?: boolean; confirm: string;
  onSubmit(name: string): Promise<void>; onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Like a file manager: renaming selects the name but not the extension.
    const dot = selectStem ? initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = nameProblem(value);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try { await onSubmit(value.trim()); onClose(); }
    catch (err) { setError(errMsg(err)); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={submit}>
        <Input ref={inputRef} value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} maxLength={120} />
        {error && <p className="mt-2 text-[12px] text-err">{error}</p>}
        <ModalActions>
          <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? <Spinner className="h-3.5 w-3.5" /> : confirm}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function MoveDialog({ paths, dirs, onMove, onMkdir, onClose }: {
  paths: string[]; dirs: Set<string>;
  onMove(to: string): Promise<void>; onMkdir(path: string): Promise<void>; onClose(): void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  // Folders made from this dialog show up before the list reloads.
  const [made, setMade] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const all = new Set([...dirs, ...made]);
    const out: { path: string; name: string; depth: number }[] = [{ path: '', name: t('全部文件'), depth: 0 }];
    const visit = (parent: string, depth: number) => {
      const kids = [...all].filter((d) => parentOf(d) === parent).map((d) => ({ path: d, name: baseOf(d) })).sort(byName);
      for (const k of kids) { out.push({ ...k, depth }); visit(k.path, depth + 1); }
    };
    visit('', 1);
    return out;
  }, [dirs, made]);

  const isHere = (dir: string) => paths.every((p) => parentOf(p) === dir);
  const blocked = (dir: string) => isHere(dir) || paths.some((p) => intoItself(p, dir));

  async function mkdir(e: FormEvent) {
    e.preventDefault();
    const problem = nameProblem(name);
    if (problem) { setError(problem); return; }
    const path = joinPath(target ?? '', name.trim());
    setBusy(true);
    try {
      await onMkdir(path);
      setMade((m) => [...m, path]);
      setTarget(path);
      setCreating(false);
      setName('');
      setError(null);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  async function submit() {
    if (target === null) return;
    setBusy(true);
    try { await onMove(target); onClose(); }
    catch (err) { setError(errMsg(err)); setBusy(false); }
  }

  const where = target === null || target === '' ? t('全部文件') : baseOf(target);
  return (
    <Modal open onClose={onClose} title={t('移动 {count} 项', { count: paths.length })}
      desc={paths.length === 1 ? t('把「{name}」移动到选中的文件夹', { name: baseOf(paths[0]) }) : t('把选中的项目移动到选中的文件夹')}>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-line py-1">
        {rows.map((r) => (
          <button key={r.path || '/'} type="button" disabled={blocked(r.path)} onClick={() => { setTarget(r.path); setError(null); }}
            style={{ paddingLeft: 10 + r.depth * 16 }}
            className={`flex w-full cursor-pointer items-center gap-2 py-1.5 pr-3 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${target === r.path ? 'bg-acc/10 text-acc' : 'text-tx hover:bg-bg2'}`}>
            {r.path ? <Folder size={14} className="shrink-0" /> : <FolderOpen size={14} className="shrink-0" />}
            <span className="min-w-0 truncate">{r.name}</span>
            {isHere(r.path) && <span className="ml-auto shrink-0 text-[11px] text-tx3">{t('当前位置')}</span>}
          </button>
        ))}
      </div>
      {creating ? (
        <form className="mt-3 flex items-center gap-2" onSubmit={mkdir}>
          <Input uiSize="sm" autoFocus value={name} maxLength={120} placeholder={t('在「{name}」里新建文件夹', { name: where })}
            onChange={(e) => { setName(e.target.value); setError(null); }} />
          <Button type="submit" size="sm" variant="primary" disabled={busy}>{t('创建')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setError(null); }}>{t('取消')}</Button>
        </form>
      ) : (
        <button type="button" className="mt-3 flex cursor-pointer items-center gap-1.5 text-[12px] text-acc hover:underline" onClick={() => setCreating(true)}>
          <FolderPlus size={13} /> {t('在「{name}」里新建文件夹', { name: where })}
        </button>
      )}
      {error && <p className="mt-2 text-[12px] text-err">{error}</p>}
      <ModalActions>
        <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
        <Button variant="primary" disabled={target === null || busy} onClick={submit}>{t('移动到这里')}</Button>
      </ModalActions>
    </Modal>
  );
}

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'move'; paths: string[] };

// ---- the panel ----

export function WorkspacePanel() {
  const chatId = useWorkspacePanel((s) => s.chatId);
  const home = useWorkspacePanel((s) => s.home);
  if (!chatId && !home) return null;
  return <WorkspacePanelContent key={chatId ?? 'home'} chatId={chatId} />;
}

function WorkspacePanelContent({ chatId }: { chatId: string | null }) {
  const version = useWorkspacePanel((s) => s.version);
  const close = useWorkspacePanel((s) => s.close);
  const bump = useWorkspacePanel((s) => s.bump);
  const [data, setData] = useState<WorkspaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = useWorkspacePanel((s) => s.selectedPath);
  const setSelected = useWorkspacePanel((s) => s.selectFile);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const [cwd, setCwd] = useState('');
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  // Row drag: the paths being dragged and the folder currently under the pointer.
  const dragPaths = useRef<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const allRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    if (!chatId) return;
    const id = ++requestId.current;
    api.get<WorkspaceListing>(`/api/chats/${chatId}/workspace`)
      .then((r) => {
        if (id !== requestId.current) return;
        setData(r); setError(null); useWorkspacePanel.getState().setCount(chatId, r.files.length);
      })
      .catch((e) => { if (id === requestId.current) setError(errMsg(e)); });
  }, [chatId]);

  useEffect(() => { reload(); return () => { requestId.current += 1; }; }, [version, reload]);
  // Refresh cross-chat changes while showing the list. An open editor keeps
  // its draft and its original scope until the person returns to the list.
  useEffect(() => {
    if (!chatId || selected) return;
    reload();
    const refresh = () => { if (document.visibilityState === 'visible') reload(); };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [chatId, selected, reload]);

  const selectedFile = useMemo(() => data?.files.find((f) => f.path === selected) ?? null, [data, selected]);

  // Folders that exist, explicit (possibly empty) or implied by a file path.
  const allDirs = useMemo(() => {
    const set = new Set<string>(data?.dirs ?? []);
    for (const f of data?.files ?? []) for (let d = parentOf(f.path); d; d = parentOf(d)) set.add(d);
    return set;
  }, [data]);

  const entries = useMemo<Entry[]>(() => {
    if (!data) return [];
    const dirs = [...allDirs].filter((d) => parentOf(d) === cwd).map((d) => {
      let items = 0;
      let size = 0;
      for (const x of allDirs) if (parentOf(x) === d) items += 1;
      for (const f of data.files) {
        if (parentOf(f.path) === d) items += 1;
        if (f.path.startsWith(`${d}/`)) size += f.size;
      }
      return { kind: 'dir' as const, path: d, name: baseOf(d), items, size };
    }).sort(byName);
    const files = data.files.filter((f) => parentOf(f.path) === cwd)
      .map((f) => ({ kind: 'file' as const, path: f.path, name: baseOf(f.path), file: f })).sort(byName);
    return [...dirs, ...files];
  }, [data, allDirs, cwd]);

  // Opening a file (also from a chat link) lands back in its folder.
  useEffect(() => { if (selected) setCwd(parentOf(selected)); }, [selected]);
  // The folder vanished (deleted, moved, renamed): climb to what still exists.
  useEffect(() => {
    if (!data || !cwd || allDirs.has(cwd)) return;
    let d = cwd;
    while (d && !allDirs.has(d)) d = parentOf(d);
    setCwd(d);
  }, [data, allDirs, cwd]);
  useEffect(() => { setChecked(new Set()); }, [cwd]);
  // Drop picks that no longer exist after a refresh.
  useEffect(() => {
    setChecked((prev) => {
      if (!prev.size) return prev;
      const live = new Set(entries.map((e) => e.path));
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const allChecked = entries.length > 0 && entries.every((e) => checked.has(e.path));
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = checked.size > 0 && !allChecked;
  }, [checked, allChecked]);

  const scopeQ = data ? `?scope=${encodeURIComponent(data.scopeKey)}` : '';

  function toggle(path: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  async function uploadFiles(files: FileList | File[] | null, dir = cwd) {
    if (!chatId || !data || !files || !files.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      try { await uploadWorkspaceFile(chatId, f, dir || undefined, data.scopeKey); ok += 1; }
      catch (e) { toast(`${f.name}:${errMsg(e)}`, 'err'); }
    }
    setUploading(false);
    if (ok) { toast(t('已上传 {count} 个文件', { count: ok }), 'ok'); bump(); }
  }

  async function mkdir(path: string) {
    await api.post(`/api/chats/${chatId}/workspace/mkdir${scopeQ}`, { path });
    bump();
  }

  async function rename(entry: Entry, name: string) {
    const to = joinPath(parentOf(entry.path), name);
    if (to === entry.path) return;
    await api.post(`/api/chats/${chatId}/workspace/rename${scopeQ}`, { from: entry.path, to });
    bump();
  }

  /** Throws only when the request as a whole fails; per-item failures toast. */
  async function move(paths: string[], to: string) {
    const r = await api.post<{ moved: { from: string; to: string }[]; failed: BatchFailure[] }>(
      `/api/chats/${chatId}/workspace/move${scopeQ}`, { paths, to });
    if (r.moved.length) toast(t('已移动 {count} 项到「{dir}」', { count: r.moved.length, dir: to || t('全部文件') }), 'ok');
    reportFailures(r.failed);
    setChecked(new Set());
    bump();
  }

  async function dropMove(paths: string[], to: string) {
    try { await move(paths, to); } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function removeEntries(paths: string[]) {
    if (!chatId || !paths.length) return;
    const picked = entries.filter((e) => paths.includes(e.path));
    const dirs = picked.filter((e) => e.kind === 'dir');
    const filesInside = (dir: string) => data?.files.filter((f) => f.path.startsWith(`${dir}/`)).length ?? 0;
    let body: string;
    if (paths.length === 1 && dirs.length === 1) {
      body = t('确定删除文件夹「{path}」及其中的 {count} 个文件?此操作不可恢复。', { path: baseOf(paths[0]), count: filesInside(paths[0]) });
    } else if (paths.length === 1) {
      body = t('确定删除「{path}」?此操作不可恢复。', { path: baseOf(paths[0]) });
    } else if (dirs.length) {
      body = t('确定删除选中的 {count} 项?其中的文件夹会连同里面的文件一起删除,此操作不可恢复。', { count: paths.length });
    } else {
      body = t('确定删除选中的 {count} 项?此操作不可恢复。', { count: paths.length });
    }
    if (!(await confirmDialog(paths.length === 1 && !dirs.length ? t('删除文件') : t('删除'), body))) return;
    setBusy(true);
    try {
      const r = await api.post<{ deleted: string[]; failed: BatchFailure[] }>(`/api/chats/${chatId}/workspace/delete${scopeQ}`, { paths });
      if (r.deleted.length > 1) toast(t('已删除 {count} 项', { count: r.deleted.length }), 'ok');
      reportFailures(r.failed);
      setChecked(new Set());
      bump();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }

  async function downloadZip(paths: string[]) {
    if (!chatId || !data || !paths.length) return;
    const name = paths.length === 1 ? baseOf(paths[0]) : cwd ? baseOf(cwd) : t('工作区');
    setBusy(true);
    try { await downloadWorkspaceZip(chatId, paths, `${name}.zip`, data.scopeKey); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }

  /** Drag targets: folders take rows dragged from the list (move) and files
      dragged from the desktop (upload into that folder). */
  function dropProps(dir: string) {
    return {
      onDragOver(e: DragEvent) {
        const types = e.dataTransfer.types;
        if (types.includes(DRAG_TYPE)) {
          const paths = dragPaths.current;
          if (!paths.length || paths.every((p) => parentOf(p) === dir) || paths.some((p) => intoItself(p, dir))) return;
          e.dataTransfer.dropEffect = 'move';
        } else if (!types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        if (dropTarget !== dir) setDropTarget(dir);
      },
      onDragLeave(e: DragEvent) {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDropTarget((d) => (d === dir ? null : d));
      },
      onDrop(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(null);
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          const paths = dragPaths.current;
          dragPaths.current = [];
          if (paths.length) dropMove(paths, dir);
        } else {
          uploadFiles(e.dataTransfer.files, dir);
        }
      },
    };
  }

  function dragStart(e: DragEvent, path: string) {
    const paths = checked.has(path) ? [...checked] : [path];
    dragPaths.current = paths;
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = 'move';
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  // Home (no chat yet): guidance only; uploads need a chat and appear once
  // the first message creates one.
  if (!chatId) {
    return (
      <aside className="fixed inset-0 z-40 flex flex-col bg-bg1 md:static md:relative md:z-auto md:w-[clamp(22rem,38vw,40rem)] md:shrink-0 md:border-l md:border-line">
        <div className="flex items-center justify-between border-b border-line bg-bg2 py-1.5 pl-4 pr-2">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-tx3"><FolderOpen size={13} /> {t('工作区')}</span>
          <button className={headBtn} title={t('关闭面板')} onClick={close}><X size={15} /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10 text-center text-sm text-tx3">
          <FolderOpen size={26} className="text-tx3/70" />
          <div className="mt-2 text-tx2">{t('在工作区保存和管理对话文件')}</div>
          <div className="mt-1 text-xs leading-relaxed">
            {t('助手会把长文、报告、代码、数据结果写成文件放在这里,并且可以在原文上反复修改;你也可以把文件拖进来交给它处理。发出第一条消息后这里就会接上这段对话。')}
          </div>
          <Starters />
        </div>
      </aside>
    );
  }

  const crumbs = cwd ? ['', ...cwd.split('/').map((_, i, segs) => segs.slice(0, i + 1).join('/'))] : [];
  const uploadDir = dropTarget ?? cwd;
  const workspaceEmpty = !!data && data.files.length === 0 && allDirs.size === 0;

  return (
    <aside
      className="fixed inset-0 z-40 flex flex-col bg-bg1 md:static md:relative md:z-auto md:w-[clamp(22rem,38vw,40rem)] md:shrink-0 md:border-l md:border-line"
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDragging(true); }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={(e) => { if (!hasFiles(e)) return; dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); setDropTarget(null); } }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); setDropTarget(null); uploadFiles(e.dataTransfer.files); }}
    >
      {selectedFile ? (
        <FileView key={`${chatId}:${selectedFile.path}`} chatId={chatId} file={selectedFile} scopeKey={data!.scopeKey} onBack={() => setSelected(null)} onChanged={bump} />
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-line bg-bg2 py-1.5 pl-4 pr-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-tx3">
              {selected && <button className={headBtn} title={t('返回文件列表')} onClick={() => setSelected(null)}><ChevronLeft size={15} /></button>}
              <FolderOpen size={13} /> {data?.scope === 'project' ? t('个人项目工作区') : t('工作区')}
            </span>
            <div className="flex items-center gap-1">
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
              <button className={headBtn} title={cwd ? t('在「{name}」里新建文件夹', { name: baseOf(cwd) }) : t('新建文件夹')}
                onClick={() => setDialog({ kind: 'mkdir' })} disabled={!data || !!selected}>
                <FolderPlus size={14} />
              </button>
              <button className={headBtn} title={cwd ? t('上传文件到「{name}」', { name: baseOf(cwd) }) : t('上传文件到工作区')}
                onClick={() => fileRef.current?.click()} disabled={uploading || !data}>
                {uploading ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
              </button>
              <button className={headBtn} title={t('刷新')} onClick={reload}><RefreshCw size={13} /></button>
              <button className={headBtn} title={t('关闭面板')} onClick={close}><X size={15} /></button>
            </div>
          </div>

          {data?.scope === 'project' && <p className="border-b border-line px-4 py-2 text-[11px] text-tx3">
            {t('你的项目对话共用这些文件,其他成员各自独立。')}
          </p>}

          {data && !selected && cwd && (
            <div className="flex items-center gap-0.5 border-b border-line px-2 py-1 text-[12px]">
              <button className={`${headBtn} shrink-0 ${dropTarget === parentOf(cwd) ? 'bg-acc/10 text-acc' : ''}`} title={t('返回上一级')}
                onClick={() => setCwd(parentOf(cwd))} {...dropProps(parentOf(cwd))}>
                <CornerLeftUp size={14} />
              </button>
              <nav className="flex min-w-0 flex-1 items-center overflow-x-auto" aria-label={t('当前文件夹')}>
                {crumbs.map((c, i) => (
                  <Fragment key={c || '/'}>
                    {i > 0 && <ChevronRight size={12} className="shrink-0 text-tx3" />}
                    <button type="button" onClick={() => setCwd(c)} {...(c === cwd ? {} : dropProps(c))} title={c || t('全部文件')}
                      className={`max-w-[11rem] shrink-0 cursor-pointer truncate rounded px-1.5 py-0.5 transition-colors ${c === cwd ? 'font-medium text-tx' : 'text-tx2 hover:bg-bg3 hover:text-tx'} ${dropTarget === c && c !== cwd ? 'bg-acc/10 text-acc ring-1 ring-inset ring-acc' : ''}`}>
                      {c ? baseOf(c) : t('全部文件')}
                    </button>
                  </Fragment>
                ))}
              </nav>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p className="p-4 text-sm text-err">{error}</p>
            ) : !data ? (
              <div className="flex justify-center py-10 text-tx3"><Spinner /></div>
            ) : selected ? (
              <div className="p-4 text-sm text-tx2" role="status">
                <p className="break-words">{t('无法打开「{path}」：文件不存在或已被删除。', { path: selected })}</p>
                <button className="mt-3 cursor-pointer text-acc hover:underline" onClick={() => setSelected(null)}>{t('返回文件列表')}</button>
              </div>
            ) : workspaceEmpty ? (
              <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-sm text-tx3">
                <FolderOpen size={26} className="text-tx3/70" />
                <div className="text-tx2">{t('工作区还是空的')}</div>
                <div className="text-xs leading-relaxed">
                  {t('助手写出的文件会出现在这里并可以反复修改;也可以拖入或上传文件交给它处理。')}
                </div>
                <Starters compact />
              </div>
            ) : entries.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-tx3">
                <Folder size={26} className="text-tx3/70" />
                <div className="text-tx2">{t('这个文件夹是空的')}</div>
                <div className="text-xs leading-relaxed">{t('把文件拖到这里,或点上方的上传按钮放进这个文件夹。')}</div>
              </div>
            ) : (
              <>
                <div className="sticky top-0 z-[1] flex min-h-9 items-center gap-2 border-b border-line bg-bg1/95 px-3 py-1 backdrop-blur">
                  <input ref={allRef} type="checkbox" className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-acc" checked={allChecked}
                    title={t('全选')} aria-label={t('全选')}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(entries.map((e) => e.path)))} />
                  {checked.size ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-tx">{t('已选 {count} 项', { count: checked.size })}</span>
                      <button className={barBtn} disabled={busy} onClick={() => setDialog({ kind: 'move', paths: [...checked] })}>
                        <FolderInput size={13} /> {t('移动到')}
                      </button>
                      <button className={barBtn} disabled={busy} onClick={() => downloadZip([...checked])}>
                        {busy ? <Spinner className="h-3 w-3" /> : <Download size={13} />} {t('下载')}
                      </button>
                      <button className={`${barBtn} hover:!text-err`} disabled={busy} onClick={() => removeEntries([...checked])}>
                        <Trash2 size={13} /> {t('删除')}
                      </button>
                      <button className={rowBtn} title={t('取消选择')} onClick={() => setChecked(new Set())}><X size={14} /></button>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-tx3">
                      {t('{count} 项', { count: entries.length })} · {t('勾选后可以批量移动、下载或删除')}
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-line/60">
                  {entries.map((e) => {
                    const isChecked = checked.has(e.path);
                    return (
                      <li key={e.path} draggable
                        onDragStart={(ev) => dragStart(ev, e.path)}
                        onDragEnd={() => { dragPaths.current = []; setDropTarget(null); }}
                        {...(e.kind === 'dir' ? dropProps(e.path) : {})}
                        className={`group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-bg2 ${isChecked ? 'bg-acc/5' : ''} ${dropTarget === e.path ? 'bg-acc/10 ring-1 ring-inset ring-acc' : ''}`}>
                        <input type="checkbox" className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-acc" checked={isChecked}
                          onChange={() => toggle(e.path)} aria-label={t('选择「{name}」', { name: e.name })} />
                        <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left" title={e.path}
                          onClick={() => (e.kind === 'dir' ? setCwd(e.path) : setSelected(e.path))}>
                          {e.kind === 'dir' ? <Folder size={15} className="shrink-0 text-acc" /> : <FileGlyph path={e.path} size={15} />}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-tx">{e.name}</span>
                            <span className="block text-[11px] tabular-nums text-tx3">
                              {e.kind === 'dir'
                                ? `${t('{count} 项', { count: e.items })}${e.size ? ` · ${fmtBytes(e.size)}` : ''}`
                                : `${fmtBytes(e.file.size)} · ${fmtWhen(e.file.mtime)}`}
                            </span>
                          </span>
                        </button>
                        <button className={rowBtn} title={t('重命名')} onClick={() => setDialog({ kind: 'rename', entry: e })}>
                          <PencilLine size={13} />
                        </button>
                        {e.kind === 'file' ? (
                          <a className={rowBtn} title={t('下载')} href={fileUrl(chatId, e.path, true, data.scopeKey)}><Download size={13} /></a>
                        ) : (
                          <button className={rowBtn} title={t('打包下载')} disabled={busy} onClick={() => downloadZip([e.path])}><Download size={13} /></button>
                        )}
                        <button className={`${rowBtn} hover:!text-err`} title={t('删除')} disabled={busy} onClick={() => removeEntries([e.path])}>
                          <Trash2 size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>

          {data && (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-bg2/60 px-4 py-2 text-[11px] text-tx3">
              <span className="tabular-nums">{t('{count} 个文件 · {used} / {total}', { count: data.files.length, used: fmtBytes(data.bytes), total: fmtBytes(data.limits.bytes) })}</span>
              <span>{data.enabled ? t('助手可读写') : t('智能工具已关闭,助手不会改动这些文件')}</span>
            </div>
          )}
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-acc bg-acc/10 text-sm font-medium text-acc">
          {uploadDir ? t('松开以上传到「{name}」', { name: baseOf(uploadDir) }) : t('松开以上传到工作区')}
        </div>
      )}

      {dialog?.kind === 'mkdir' && (
        <NameDialog title={cwd ? t('在「{name}」里新建文件夹', { name: baseOf(cwd) }) : t('新建文件夹')} confirm={t('创建')}
          onSubmit={(name) => mkdir(joinPath(cwd, name))} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog title={dialog.entry.kind === 'dir' ? t('重命名文件夹') : t('重命名文件')} confirm={t('重命名')}
          initial={dialog.entry.name} selectStem={dialog.entry.kind === 'file'}
          onSubmit={(name) => rename(dialog.entry, name)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog paths={dialog.paths} dirs={allDirs} onMkdir={mkdir}
          onMove={(to) => move(dialog.paths, to)} onClose={() => setDialog(null)} />
      )}
    </aside>
  );
}
