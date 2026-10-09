import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, ModalActions, Select, Spinner, Textarea, Toggle, ToggleRow,
  confirmDialog, toast,
} from '../../components/ui';
import { t, tServer } from '../../i18n';
import type { AdminUser, SkillDetail, SkillInfo } from '../../types';

const TEMPLATE = [
  '---',
  'name: my-skill',
  `description: ${t('一句话说明这个技能做什么、什么时候该用(模型靠这句话决定是否加载)。')}`,
  '---',
  '',
  `# ${t('技能标题')}`,
  '',
  `## ${t('何时使用')}`,
  '…',
  '',
  `## ${t('步骤')}`,
  '1. …',
  '2. …',
  '',
  `## ${t('注意')}`,
  '- …',
  '',
].join('\n');

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function postForm(path: string, form: FormData): Promise<unknown> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf': '1' }, body: form });
  const json = await res.json().catch(() => ({}));
  const err = (json as { error?: string }).error;
  if (!res.ok) throw new Error(err ? tServer(err) : t('请求失败 ({status})', { status: res.status }));
  return json;
}

// ---- create ----

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(): void }) {
  const [md, setMd] = useState(TEMPLATE);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setMd(TEMPLATE); }, [open]);
  async function submit() {
    setBusy(true);
    try { await api.post('/api/admin/skills', { skillMd: md }); toast(t('已创建'), 'ok'); onCreated(); onClose(); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={t('新建技能')}
      desc={t('SKILL.md:frontmatter 里的 name 就是技能名(小写字母、数字、连字符),description 是模型判断是否加载的依据;正文写具体步骤。')} wide>
      <Textarea className="h-96 font-mono text-[12px]" value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} />
      <ModalActions>
        <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>{busy && <Spinner className="h-3.5 w-3.5" />}{t('创建')}</Button>
      </ModalActions>
    </Modal>
  );
}

// ---- detail / edit ----

function DetailModal({ id, users, onClose, onChanged }: { id: string; users: AdminUser[]; onClose(): void; onChanged(): void }) {
  const [data, setData] = useState<SkillDetail | null>(null);
  const [md, setMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{ path: string; text: string } | null>(null);
  const [uploadDir, setUploadDir] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const normalUsers = users.filter((u) => u.role !== 'admin');

  const load = useCallback(() => {
    api.get<SkillDetail>(`/api/admin/skills/${id}`).then((r) => { setData(r); setMd(r.skillMd); }).catch((e) => toast(errMsg(e), 'err'));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await api.patch<{ skill: SkillInfo }>(`/api/admin/skills/${id}`, body);
      setData((d) => (d ? { ...d, skill: r.skill } : d));
      onChanged();
      return true;
    } catch (e) { toast(errMsg(e), 'err'); return false; } finally { setBusy(false); }
  }

  async function saveMd() {
    if (await patch({ skillMd: md })) { toast(t('已保存'), 'ok'); load(); }
  }

  async function upload(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      const form = new FormData();
      if (uploadDir.trim()) form.append('dir', uploadDir.trim());
      form.append('file', f);
      try { await postForm(`/api/admin/skills/${id}/upload`, form); }
      catch (e) { toast(t('{name}:{error}', { name: f.name, error: errMsg(e) }), 'err'); }
    }
    setBusy(false);
    load(); onChanged();
  }

  async function removeFile(p: string) {
    if (!(await confirmDialog(t('删除文件'), t('删除「{path}」?', { path: p })))) return;
    try { await api.del(`/api/admin/skills/${id}/file?path=${encodeURIComponent(p)}`); load(); onChanged(); }
    catch (e) { toast(errMsg(e), 'err'); }
  }

  async function viewFile(p: string) {
    try { const r = await api.get<{ text: string }>(`/api/admin/skills/${id}/file?path=${encodeURIComponent(p)}`); setViewing({ path: p, text: r.text }); }
    catch (e) { toast(errMsg(e), 'err'); }
  }

  const s = data?.skill;
  return (
    <Modal open onClose={onClose} title={s ? s.slug : t('技能')} desc={s?.description} wide>
      {!data || !s ? <div className="flex justify-center py-10 text-tx3"><Spinner /></div> : (
        <div className="space-y-4">
          <ToggleRow label={t('启用@@state')} desc={t('关闭后所有对话的技能清单里都不再出现')} checked={s.enabled} onChange={(v) => patch({ enabled: v })} disabled={busy} />
          <Field label={t('访问范围')} hint={t('管理员始终可用')}>
            <Select value={s.accessMode} onChange={(e) => patch({ accessMode: e.target.value })} disabled={busy}>
              <option value="shared">{t('所有登录用户')}</option>
              <option value="restricted">{t('仅指定普通用户')}</option>
            </Select>
          </Field>
          {s.accessMode === 'restricted' && (
            <div className="max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg0">
              {normalUsers.length === 0 ? <div className="px-3 py-3 text-xs text-tx3">{t('暂无普通用户')}</div> : normalUsers.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1 truncate text-[13px] text-tx">{u.displayName || u.username}</div>
                  <Toggle checked={s.allowedUserIds.includes(u.id)} disabled={busy}
                    onChange={(v) => patch({ allowedUserIds: v ? [...s.allowedUserIds, u.id] : s.allowedUserIds.filter((x) => x !== u.id) })} />
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] font-medium text-tx">SKILL.md</span>
              <Button size="sm" variant="primary" disabled={busy || md === data.skillMd} onClick={saveMd}>{t('保存 SKILL.md')}</Button>
            </div>
            <Textarea className="h-72 font-mono text-[12px]" value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] font-medium text-tx">{t('附带文件')} <span className="font-normal text-tx3">({data.files.length - 1})</span></span>
              <div className="flex items-center gap-2">
                <Input uiSize="sm" className="w-36 font-mono" placeholder={t('子目录,如 scripts')} value={uploadDir} onChange={(e) => setUploadDir(e.target.value)} />
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
                <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={13} />{t('上传文件')}</Button>
                <a className="inline-flex" href={`/api/admin/skills/${id}/export`}><Button size="sm" variant="outline"><Download size={13} />{t('导出 zip')}</Button></a>
              </div>
            </div>
            <p className="mb-2 text-xs text-tx3">
              {t('脚本、模板、参考资料等;填子目录可上传到 ')}
              <code className="font-mono">scripts/</code>
              {t(' 之类的位置,复杂结构建议打成 zip 导入。沙盒内路径为 ')}
              <code className="font-mono">/skills/{s.slug}/…</code>
            </p>
            {data.files.filter((f) => f.path !== 'SKILL.md').length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-tx3">{t('暂无附带文件')}</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-bg0">
                {data.files.filter((f) => f.path !== 'SKILL.md').map((f) => (
                  <li key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <FileText size={13} className="shrink-0 text-tx3" />
                    <button className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-tx hover:underline" onClick={() => viewFile(f.path)}>{f.path}</button>
                    <span className="tabular-nums text-tx3">{fmtBytes(f.size)}</span>
                    <button className="cursor-pointer rounded p-1 text-tx3 hover:bg-bg2 hover:text-err" title={t('删除')} onClick={() => removeFile(f.path)}><Trash2 size={13} /></button>
                  </li>
                ))}
              </ul>
            )}
            {viewing && (
              <div className="mt-2 rounded-lg border border-line">
                <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs">
                  <span className="font-mono text-tx">{viewing.path}</span>
                  <button className="cursor-pointer text-tx3 hover:text-tx" onClick={() => setViewing(null)}>{t('关闭')}</button>
                </div>
                <pre className="max-h-64 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-tx2">{viewing.text}</pre>
              </div>
            )}
          </div>

          <ModalActions>
            <Button variant="danger" onClick={async () => {
              if (!(await confirmDialog(t('删除技能'), t('删除「{name}」及其全部文件?', { name: s.slug })))) return;
              try { await api.del(`/api/admin/skills/${id}`); toast(t('已删除'), 'ok'); onChanged(); onClose(); }
              catch (e) { toast(errMsg(e), 'err'); }
            }}>{t('删除技能')}</Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={onClose}>{t('关闭')}</Button>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

// ---- page ----

export default function Skills() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [importing, setImporting] = useState(false);
  const zipRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.get<{ skills: SkillInfo[] }>('/api/admin/skills').then((r) => setSkills(r.skills)).catch((e) => toast(errMsg(e), 'err'));
  }, []);
  useEffect(() => {
    load();
    api.get<AdminUser[]>('/api/admin/users').then(setUsers).catch(() => { /* optional */ });
  }, [load]);

  async function importZip(files: FileList | null) {
    if (!files || !files.length) return;
    setImporting(true);
    const form = new FormData();
    form.append('replace', replace ? '1' : '0');
    form.append('file', files[0]);
    try {
      const r = await postForm('/api/admin/skills/import', form) as { skill: SkillInfo };
      toast(t('已导入「{name}」', { name: r.skill.slug }), 'ok');
      load();
    }
    catch (e) { toast(errMsg(e), 'err'); } finally { setImporting(false); }
  }

  async function importSamples() {
    try {
      const r = await api.post<{ skills: SkillInfo[] }>('/api/admin/skills/samples');
      toast(r.skills.length
        ? t('已导入 {n} 个示例技能', { n: r.skills.length })
        : t('示例技能已存在'), r.skills.length ? 'ok' : 'info');
      load();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-tx">{t('技能')}</h1>
          <p className="mt-0.5 text-xs text-tx3">
            {t('打包好的操作指南(Agent Skills 格式:SKILL.md + 附带脚本/资料)。模型在对话里只看到名称与用途,任务匹配时才加载完整说明;附带脚本可在沙盒里执行。')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-tx3"><Toggle checked={replace} onChange={setReplace} />{t('导入时覆盖同名')}</label>
          <input ref={zipRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { importZip(e.target.files); e.target.value = ''; }} />
          <Button variant="outline" size="sm" disabled={importing} onClick={() => zipRef.current?.click()}>{importing ? <Spinner className="h-3.5 w-3.5" /> : <Upload size={13} />}{t('导入 zip')}</Button>
          <Button variant="outline" size="sm" onClick={importSamples}><Sparkles size={13} />{t('导入示例')}</Button>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus size={13} />{t('新建技能')}</Button>
        </div>
      </div>

      {!skills ? <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
        : skills.length === 0 ? (
          <Card>
            <EmptyState icon={<Sparkles size={22} />} title={t('还没有技能')}
              hint={t('先点「导入示例」看看格式:一个把 Markdown 转成 Word 报告的技能,和一个用 pandas + matplotlib 出图的技能(需要沙盒和相应运行库)。')}
              action={<Button variant="primary" size="sm" onClick={importSamples}>{t('导入示例')}</Button>} />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {skills.map((s) => (
              <button key={s.id} className="cursor-pointer rounded-xl border border-line bg-bg1 p-4 text-left shadow-xs transition-colors hover:border-line2" onClick={() => setOpenId(s.id)}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-tx">{s.slug}</span>
                  {!s.enabled && <Badge tone="default">{t('已停用')}</Badge>}
                  <Badge tone={s.accessMode === 'shared' ? 'acc' : 'default'}>
                    {s.accessMode === 'shared' ? t('全员') : t('指定 {n} 人', { n: s.allowedUserIds.length })}
                  </Badge>
                </div>
                <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-tx2">{s.description}</p>
                <div className="mt-2 text-[11px] text-tx3">
                  {t('{n} 个文件', { n: s.fileCount })} · {fmtBytes(s.bytes)}
                </div>
              </button>
            ))}
          </div>
        )}

      <CreateModal open={creating} onClose={() => setCreating(false)} onCreated={load} />
      {openId && <DetailModal id={openId} users={users} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}
