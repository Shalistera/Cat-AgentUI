import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { withCanvasCsp } from '../sandboxedHtml';
import {
  ChevronLeft, Download, FileCode, FileImage, FileText, File as FileIcon, FolderOpen, Pencil,
  RefreshCw, Save, Trash2, Upload, X,
} from 'lucide-react';
import { api, errMsg, uploadWorkspaceFile } from '../api';
import { useWorkspacePanel } from '../store';
import { Markdown } from './Markdown';
import { Spinner, Toggle, confirmDialog, toast } from './ui';
import type { WorkspaceFile, WorkspaceListing } from '../types';

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
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function FileGlyph({ path, size = 14 }: { path: string; size?: number }) {
  const ext = extOf(path);
  const cls = 'shrink-0 text-tx3';
  if (IMAGE_EXT.has(ext)) return <FileImage size={size} className={cls} />;
  if (CODE_EXT.has(ext)) return <FileCode size={size} className={cls} />;
  if (TEXT_EXT.has(ext)) return <FileText size={size} className={cls} />;
  return <FileIcon size={size} className={cls} />;
}

function fileUrl(chatId: string, path: string, download = false): string {
  return `/api/chats/${chatId}/workspace/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
}

// ---- preview / editor for one file ----

function FileView({ chatId, file, onBack, onChanged }: {
  chatId: string; file: WorkspaceFile; onBack(): void; onChanged(): void;
}) {
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
    setError(null);
    api.get<{ text: string }>(`${fileUrl(chatId, file.path)}&text=1`)
      .then((r) => setText(r.text))
      .catch((e) => setError(errMsg(e)));
  }, [chatId, file.path, isText]);

  // Reload when the same file changes underneath (model edited it) unless the
  // person is mid-edit — their draft must not be clobbered.
  useEffect(() => { if (!editing) load(); }, [load, file.mtime, file.size, editing]);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/api/chats/${chatId}/workspace/file`, { path: file.path, content: draft });
      setText(draft);
      setEditing(false);
      onChanged();
      toast('已保存', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setSaving(false); }
  }

  let body: ReactNode;
  if (error) {
    body = <p className="p-4 text-sm text-err">{error}</p>;
  } else if (isImage) {
    body = <div className="flex items-start justify-center p-4"><img src={fileUrl(chatId, file.path)} alt={file.path} className="max-w-full rounded-md border border-line" /></div>;
  } else if (isPdf) {
    body = <iframe src={fileUrl(chatId, file.path)} title={file.path} className="h-full w-full border-0" />;
  } else if (!isText) {
    body = (
      <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-tx3">
        <FileIcon size={28} />
        <div>无法预览这种文件({fmtBytes(file.size)})</div>
        <a href={fileUrl(chatId, file.path, true)} className="text-acc hover:underline">下载</a>
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
    body = <div className="p-4"><Markdown text={text} /></div>;
  } else if (isHtml && rendered) {
    // No allow-same-origin: a model-written page must not reach our cookies.
    body = <iframe sandbox="allow-scripts allow-modals" srcDoc={withCanvasCsp(text)} title={file.path} className="h-full w-full border-0 bg-white" />;
  } else {
    body = <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed text-tx">{text}</pre>;
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-line bg-bg2 py-1.5 pl-2 pr-2">
        <button className={headBtn} title="返回文件列表" onClick={onBack}><ChevronLeft size={15} /></button>
        <FileGlyph path={file.path} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-tx" title={file.path}>{file.path}</span>
        <span className="mr-1 shrink-0 text-[11px] tabular-nums text-tx3">{fmtBytes(file.size)}</span>
        {(isMd || isHtml) && !editing && (
          <button className="h-7 cursor-pointer rounded-md px-2 text-[11px] text-tx2 hover:bg-bg3 hover:text-tx" onClick={() => setRendered((v) => !v)}>
            {rendered ? '源码' : '预览'}
          </button>
        )}
        {editable && !editing && (
          <button className={headBtn} title="编辑" onClick={() => { setDraft(text ?? ''); setEditing(true); }} disabled={text === null}>
            <Pencil size={13} />
          </button>
        )}
        {editing && (
          <>
            <button className={headBtn} title="保存" onClick={save} disabled={saving}>{saving ? <Spinner className="h-3.5 w-3.5" /> : <Save size={14} />}</button>
            <button className={headBtn} title="放弃修改" onClick={() => setEditing(false)}><X size={14} /></button>
          </>
        )}
        {!editing && (
          <a className={headBtn} title="下载" href={fileUrl(chatId, file.path, true)}><Download size={14} /></a>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </>
  );
}

// ---- the panel ----

export function WorkspacePanel() {
  const chatId = useWorkspacePanel((s) => s.chatId);
  const version = useWorkspacePanel((s) => s.version);
  const close = useWorkspacePanel((s) => s.close);
  const bump = useWorkspacePanel((s) => s.bump);
  const [data, setData] = useState<WorkspaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    if (!chatId) return;
    api.get<WorkspaceListing>(`/api/chats/${chatId}/workspace`)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(errMsg(e)));
  }, [chatId]);

  useEffect(() => { setData(null); setSelected(null); reload(); }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [version, reload]);

  const selectedFile = useMemo(() => data?.files.find((f) => f.path === selected) ?? null, [data, selected]);
  // The open file vanished (model or person deleted it) → back to the list.
  useEffect(() => { if (data && selected && !selectedFile) setSelected(null); }, [data, selected, selectedFile]);

  async function uploadFiles(files: FileList | File[] | null) {
    if (!chatId || !files || !files.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      try { await uploadWorkspaceFile(chatId, f); ok += 1; }
      catch (e) { toast(`${f.name}:${errMsg(e)}`, 'err'); }
    }
    setUploading(false);
    if (ok) { toast(`已上传 ${ok} 个文件`, 'ok'); bump(); }
  }

  async function remove(f: WorkspaceFile) {
    if (!chatId) return;
    if (!(await confirmDialog('删除文件', `确定删除「${f.path}」?此操作不可恢复。`))) return;
    try {
      await api.del(`${fileUrl(chatId, f.path)}`);
      bump();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function setEnabled(v: boolean) {
    if (!chatId) return;
    try {
      await api.patch(`/api/chats/${chatId}`, { workspace: v });
      setData((d) => (d ? { ...d, enabled: v } : d));
      // The chat page mirrors this flag in its composer button.
      window.dispatchEvent(new CustomEvent('caui:workspace-toggle', { detail: { chatId, enabled: v } }));
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  if (!chatId) return null;

  return (
    <aside
      className="fixed inset-0 z-40 flex flex-col bg-bg1 md:static md:relative md:z-auto md:w-[clamp(22rem,38vw,40rem)] md:shrink-0 md:border-l md:border-line"
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragging(true); }}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); uploadFiles(e.dataTransfer.files); }}
    >
      {selectedFile ? (
        <FileView chatId={chatId} file={selectedFile} onBack={() => setSelected(null)} onChanged={bump} />
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-line bg-bg2 py-1.5 pl-4 pr-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-tx3">
              <FolderOpen size={13} /> 工作区
            </span>
            <div className="flex items-center gap-1">
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
              <button className={headBtn} title="上传文件到工作区" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={14} />}
              </button>
              <button className={headBtn} title="刷新" onClick={reload}><RefreshCw size={13} /></button>
              <button className={headBtn} title="关闭面板" onClick={close}><X size={15} /></button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p className="p-4 text-sm text-err">{error}</p>
            ) : !data ? (
              <div className="flex justify-center py-10 text-tx3"><Spinner /></div>
            ) : data.files.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-tx3">
                <FolderOpen size={26} className="text-tx3/70" />
                <div className="text-tx2">工作区还是空的</div>
                <div className="text-xs leading-relaxed">
                  让模型把长文、方案、代码等成果写成文件,它会在这里出现并可以反复修改;也可以拖入或上传文件让模型处理。
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-line/60">
                {data.files.map((f) => (
                  <li key={f.path} className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-bg2">
                    <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left" onClick={() => setSelected(f.path)} title={f.path}>
                      <FileGlyph path={f.path} size={15} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-tx">{f.path}</span>
                        <span className="block text-[11px] tabular-nums text-tx3">{fmtBytes(f.size)} · {fmtWhen(f.mtime)}</span>
                      </span>
                    </button>
                    <a className={`${headBtn} opacity-0 group-hover:opacity-100 max-md:opacity-100`} title="下载" href={fileUrl(chatId, f.path, true)}>
                      <Download size={13} />
                    </a>
                    <button className={`${headBtn} opacity-0 hover:!text-err group-hover:opacity-100 max-md:opacity-100`} title="删除" onClick={() => remove(f)}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data && (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-bg2/60 px-4 py-2 text-[11px] text-tx3">
              <span className="tabular-nums">{data.files.length} 个文件 · {fmtBytes(data.bytes)} / {fmtBytes(data.limits.bytes)}</span>
              <label className="flex items-center gap-2">
                <span>{data.enabled ? '模型可读写' : '模型不可用'}</span>
                <Toggle checked={data.enabled} onChange={setEnabled} />
              </label>
            </div>
          )}
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-acc bg-acc/10 text-sm font-medium text-acc">
          松开以上传到工作区
        </div>
      )}
    </aside>
  );
}
