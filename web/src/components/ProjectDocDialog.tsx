import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { create } from 'zustand';
import { api } from '../api';
import { Button, Field, Input, Modal, ModalActions, Spinner, Textarea, confirmDialog, toast } from './ui';
import type { ProjectDoc } from '../types';
import { locale, t } from '../i18n';

function errText(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback;
}

/** View / edit / create one project document. Viewers get a read-only view;
    unsaved edits ask before closing. Shared by the project page and the
    资料 chips in chat replies. */
export function ProjectDocDialog({ projectId, docId, canEdit, maxDocChars, desc, onSaved, onClose }: {
  projectId: string;
  /** null = a new document. */
  docId: string | null;
  canEdit: boolean;
  maxDocChars: number;
  desc?: string;
  onSaved?(doc: ProjectDoc, created: boolean): void;
  onClose(): void;
}) {
  const [editor, setEditor] = useState<{
    id: string | null; name: string; content: string; savedName: string; savedContent: string;
  } | null>(docId ? null : { id: null, name: '', content: '', savedName: '', savedContent: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    api.get<{ doc: ProjectDoc & { content: string } }>(`/api/projects/${projectId}/docs/${docId}`)
      .then((r) => { if (!cancelled) setEditor({ id: r.doc.id, name: r.doc.name, content: r.doc.content, savedName: r.doc.name, savedContent: r.doc.content }); })
      .catch((e) => { if (!cancelled) { toast(errText(e, t('读取失败')), 'err'); onClose(); } });
    return () => { cancelled = true; };
  }, [projectId, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = editor != null && (editor.name !== editor.savedName || editor.content !== editor.savedContent);

  // Escape reaches this dialog and the confirm on top of it alike; one ask at a time.
  const askingDiscard = useRef(false);
  async function close() {
    if (askingDiscard.current) return;
    if (dirty) {
      askingDiscard.current = true;
      const discard = await confirmDialog(t('放弃修改'), t('这份资料的修改还没有保存,确定关闭吗?'));
      askingDiscard.current = false;
      if (!discard) return;
    }
    onClose();
  }

  async function save() {
    if (!editor || saving || !dirty) return;
    const name = editor.name.trim();
    const { content } = editor;
    if (!name) { toast(t('请填写资料名称'), 'err'); return; }
    if (!content.trim()) { toast(t('资料内容不能为空'), 'err'); return; }
    if (content.length > maxDocChars) {
      toast(t('超出单文档上限({limit} 字符)', { limit: maxDocChars.toLocaleString(locale) }), 'err');
      return;
    }
    setSaving(true);
    try {
      if (editor.id) {
        const r = await api.patch<{ doc: ProjectDoc & { content: string } }>(
          `/api/projects/${projectId}/docs/${editor.id}`,
          {
            ...(name !== editor.savedName ? { name } : {}),
            ...(content !== editor.savedContent ? { content } : {}),
          },
        );
        const { content: saved, ...meta } = r.doc;
        setEditor({ id: meta.id, name: meta.name, content: saved, savedName: meta.name, savedContent: saved });
        onSaved?.(meta, false);
      } else {
        const r = await api.post<{ doc: ProjectDoc }>(`/api/projects/${projectId}/docs`, { name, content });
        setEditor({ id: r.doc.id, name: r.doc.name, content, savedName: r.doc.name, savedContent: content });
        onSaved?.(r.doc, true);
      }
      toast(t('资料已保存'), 'ok');
    } catch (e) { toast(errText(e, t('保存失败')), 'err'); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={() => void close()} wide desc={desc}
      title={!canEdit ? editor?.name ?? t('资料') : editor?.id || docId ? t('编辑资料') : t('新建资料')}>
      {!editor ? (
        <div className="flex justify-center py-12 text-tx3"><Spinner className="h-5 w-5" /></div>
      ) : canEdit ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-4"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
          }}>
          <Field label={t('名称')} required>
            <Input value={editor.name} maxLength={200} autoFocus={!editor.id}
              placeholder={t('如 产品规范.md')}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
          </Field>
          <Field label={t('内容')} required>
            <Textarea value={editor.content} rows={18} autoFocus={!!editor.id}
              className="max-h-[60vh] font-mono text-xs"
              onChange={(e) => setEditor({ ...editor, content: e.target.value })} />
          </Field>
          <ModalActions>
            <span className={`mr-auto self-center text-[11px] tabular-nums ${
              editor.content.length > maxDocChars ? 'text-err' : 'text-tx3'}`}>
              {t('{used} / {limit} 字符', { used: editor.content.length.toLocaleString(locale), limit: maxDocChars.toLocaleString(locale) })}
            </span>
            <Button variant="outline" onClick={() => void close()}>{t('关闭')}</Button>
            <Button type="submit" variant="primary" disabled={!dirty || saving}>
              {saving && <Spinner className="h-3.5 w-3.5" />}{t('保存')}
            </Button>
          </ModalActions>
        </form>
      ) : (
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-tx2">
          {editor.content}
        </pre>
      )}
    </Modal>
  );
}

// ---- 资料 chips in replies ----

interface ResolvedDoc {
  doc: { id: string; projectId: string; name: string };
  project: { id: string; name: string };
  canEdit: boolean;
  maxDocChars: number;
}

// One lookup per ref per page load: a reply can cite the same document many
// times, and history re-renders on every streamed token.
const resolved = new Map<string, Promise<ResolvedDoc | null>>();
function resolveDoc(ref: string): Promise<ResolvedDoc | null> {
  const key = ref.toLowerCase();
  let p = resolved.get(key);
  if (!p) {
    p = api.get<ResolvedDoc>(`/api/project-docs/${encodeURIComponent(key)}`).catch(() => null);
    resolved.set(key, p);
  }
  return p;
}

const useDocDialog = create<{ target: ResolvedDoc | null; open(t: ResolvedDoc): void; close(): void }>((set) => ({
  target: null,
  open(target) { set({ target }); },
  close() { set({ target: null }); },
}));

/** `[名称](doc:ref)` in a reply: a chip that opens the cited document. */
export function ProjectDocLink({ refId, children }: { refId: string; children: ReactNode }) {
  const [doc, setDoc] = useState<ResolvedDoc | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void resolveDoc(refId).then((d) => { if (!cancelled) setDoc(d); });
    return () => { cancelled = true; };
  }, [refId]);
  if (doc === null) {
    return <span className="doc-chip doc-chip-missing" title={t('这份资料已删除,或你没有该项目的访问权限')}><FileText size={11} />{children}</span>;
  }
  return (
    <button type="button" className="doc-chip" disabled={!doc}
      title={doc
        ? (doc.canEdit
          ? t('打开「{project}」的资料「{doc}」,可修改', { project: doc.project.name, doc: doc.doc.name })
          : t('打开「{project}」的资料「{doc}」', { project: doc.project.name, doc: doc.doc.name }))
        : undefined}
      onClick={() => doc && useDocDialog.getState().open(doc)}>
      <FileText size={11} />{children}
    </button>
  );
}

/** The one dialog behind every 资料 chip (mounted in the app shell). */
export function ProjectDocHost() {
  const target = useDocDialog((s) => s.target);
  const close = useDocDialog((s) => s.close);
  if (!target) return null;
  return (
    <ProjectDocDialog key={target.doc.id} projectId={target.doc.projectId} docId={target.doc.id}
      canEdit={target.canEdit} maxDocChars={target.maxDocChars}
      desc={target.canEdit
        ? t('项目「{project}」的参考资料,保存后新的回答会按修改后的内容来', { project: target.project.name })
        : t('项目「{project}」的参考资料(只读)', { project: target.project.name })}
      onSaved={(meta) => {
        const next = { ...target, doc: { ...target.doc, name: meta.name } };
        resolved.set(target.doc.id.replace(/-/g, '').slice(0, 8), Promise.resolve(next));
      }}
      onClose={close} />
  );
}
