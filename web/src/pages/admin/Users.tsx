import { useCallback, useEffect, useState } from 'react';
import { Ban, CircleCheck, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, fmtDate, fmtTokens } from '../../api';
import { Badge, Button, Field, Input, Modal, Select, Spinner, confirmDialog, toast } from '../../components/ui';
import type { AdminUser } from '../../types';

const th = 'border-b border-line px-3 py-2 text-left font-medium text-tx3';
const td = 'px-3 py-2';

function userLabel(u: AdminUser): string {
  return u.displayName ? `${u.displayName} (${u.username})` : u.username;
}

export default function Users() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  // create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [busy, setBusy] = useState(false);
  // reset-password modal
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(async () => {
    try {
      setUsers(await api.get<AdminUser[]>('/api/admin/users'));
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载用户列表失败', 'err');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createUser() {
    if (busy) return;
    if (password.length < 8) { toast('密码至少 8 位', 'err'); return; }
    setBusy(true);
    try {
      await api.post('/api/admin/users', { username: username.trim(), password, role });
      toast('用户已创建', 'ok');
      setCreateOpen(false);
      setUsername(''); setPassword(''); setRole('user');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!resetTarget || busy) return;
    if (newPassword.length < 8) { toast('密码至少 8 位', 'err'); return; }
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${resetTarget.id}`, { password: newPassword });
      toast('密码已重置', 'ok');
      setResetTarget(null); setNewPassword('');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : '重置失败', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function toggleRole(u: AdminUser) {
    const next = u.role === 'admin' ? 'user' : 'admin';
    const ok = await confirmDialog(
      '切换角色',
      `确定将「${userLabel(u)}」的角色改为${next === 'admin' ? '管理员' : '普通用户'}?`,
      false,
    );
    if (!ok) return;
    try {
      await api.patch(`/api/admin/users/${u.id}`, { role: next });
      toast('角色已更新', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'err');
    }
    await load();
  }

  async function toggleDisabled(u: AdminUser) {
    const ok = u.disabled
      ? await confirmDialog('启用用户', `确定重新启用「${userLabel(u)}」?`, false)
      : await confirmDialog('停用用户', `确定停用「${userLabel(u)}」?停用后该用户将被立即登出且无法登录。`);
    if (!ok) return;
    try {
      await api.patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled });
      toast(u.disabled ? '用户已启用' : '用户已停用', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'err');
    }
    await load();
  }

  async function deleteUser(u: AdminUser) {
    const ok = await confirmDialog(
      '删除用户',
      `确定永久删除「${userLabel(u)}」?该用户的所有对话、图片与上传文件将一并删除,此操作不可恢复!`,
    );
    if (!ok) return;
    try {
      await api.del(`/api/admin/users/${u.id}`);
      toast('用户已删除', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'err');
    }
    await load();
  }

  if (!users) {
    return <div className="flex justify-center py-24"><Spinner className="h-6 w-6" /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-tx2">共 {users.length} 位用户</p>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={15} />新建用户
        </Button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-bg1">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr>
              <th className={th}>用户名</th>
              <th className={th}>角色</th>
              <th className={th}>状态</th>
              <th className={th}>Tokens</th>
              <th className={th}>请求</th>
              <th className={th}>图片</th>
              <th className={th}>注册时间</th>
              <th className={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-line/60 last:border-0">
                <td className={`${td} font-medium`}>{userLabel(u)}</td>
                <td className={td}>
                  <Badge tone={u.role === 'admin' ? 'acc' : 'default'}>{u.role === 'admin' ? '管理员' : '用户'}</Badge>
                </td>
                <td className={td}>
                  <Badge tone={u.disabled ? 'err' : 'ok'}>{u.disabled ? '已停用' : '正常'}</Badge>
                </td>
                <td className={`${td} tabular-nums`}>{fmtTokens(u.usage.totalTokens)}</td>
                <td className={`${td} tabular-nums`}>{u.usage.requests.toLocaleString()}</td>
                <td className={`${td} tabular-nums`}>{u.usage.images.toLocaleString()}</td>
                <td className={`${td} tabular-nums text-tx2`}>{fmtDate(u.createdAt)}</td>
                <td className={`${td}`}>
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="!p-1.5" title="重置密码"
                      onClick={() => { setNewPassword(''); setResetTarget(u); }}>
                      <KeyRound size={14} />
                    </Button>
                    <Button variant="ghost" size="icon" className="!p-1.5"
                      title={u.role === 'admin' ? '降为普通用户' : '升为管理员'}
                      onClick={() => toggleRole(u)}>
                      <ShieldCheck size={14} className={u.role === 'admin' ? 'text-acc' : ''} />
                    </Button>
                    <Button variant="ghost" size="icon" className="!p-1.5" title={u.disabled ? '启用' : '停用'}
                      onClick={() => toggleDisabled(u)}>
                      {u.disabled ? <CircleCheck size={14} className="text-ok" /> : <Ban size={14} />}
                    </Button>
                    <Button variant="ghost" size="icon" className="!p-1.5 hover:!bg-err/10 hover:!text-err" title="删除"
                      onClick={() => deleteUser(u)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建用户">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); createUser(); }}>
          <Field label="用户名">
            <Input value={username} onChange={(e) => setUsername(e.target.value)}
              autoFocus maxLength={32} required placeholder="2-32 位" />
          </Field>
          <Field label="密码" hint="至少 8 位">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" maxLength={128} required />
          </Field>
          <Field label="角色">
            <Select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </Select>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={createUser}>{busy ? '创建中…' : '创建'}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!resetTarget} onClose={() => setResetTarget(null)}
        title={`重置密码${resetTarget ? ` — ${userLabel(resetTarget)}` : ''}`}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); resetPassword(); }}>
          <Field label="新密码" hint="至少 8 位,重置后该用户需重新登录">
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              autoFocus autoComplete="new-password" maxLength={128} required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setResetTarget(null)}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={resetPassword}>{busy ? '请稍候…' : '重置'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
