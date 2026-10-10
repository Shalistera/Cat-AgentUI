import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useProjects, useUi } from '../store';
import { Button, Field, Input, Modal, ModalActions, toast } from './ui';
import type { Project } from '../types';
import { t } from '../i18n';

/** Shared "新建项目" dialog — creating always lands on the new project's page. */
export function CreateProjectModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const nav = useNavigate();
  const projectsStore = useProjects();
  const { setSidebarOpen } = useUi();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ project: Project }>('/api/projects', { name: n });
      projectsStore.upsert(r.project);
      onClose();
      setName('');
      nav(`/projects/${r.project.id}`);
      if (window.innerWidth <= 900) setSidebarOpen(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : t('创建项目失败'), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('新建项目')}
      desc={t('把固定要求(比如「用中文回答、语气正式」)和参考资料放进项目,项目里的对话会自动遵循这些要求,并按需查阅资料。')}>
      <form onSubmit={(e) => { e.preventDefault(); create(); }}>
        <Field label={t('项目名称')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)}
            autoFocus maxLength={80} placeholder={t('例如:季度复盘、API 集成…')} />
        </Field>
        <ModalActions>
          <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t('创建')}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
