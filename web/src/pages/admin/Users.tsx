import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, BarChart3, CircleCheck, Image as ImageIcon, KeyRound, LogOut, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errMsg, fmtDate, fmtTokens } from '../../api';
import { Badge, Button, Field, Input, Modal, ModalActions, Select, Spinner, Td, Th, ToggleRow, confirmDialog, toast } from '../../components/ui';
import { t } from '../../i18n';
import type { AdminUser } from '../../types';

function userLabel(u: AdminUser): string {
  return u.displayName ? `${u.displayName} (${u.username})` : u.username;
}

/** The cap as the admin reads it — admins are exempt, 0 means uncapped. */
function quotaLabel(u: AdminUser): string {
  if (u.role === 'admin') return t('豁免');
  if (u.monthlyTokenQuota === null) return t('默认');
  if (u.monthlyTokenQuota === 0) return t('不限');
  return fmtTokens(u.monthlyTokenQuota);
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
  // quota modal
  const [quotaTarget, setQuotaTarget] = useState<AdminUser | null>(null);
  const [quotaValue, setQuotaValue] = useState('');
  // image-permission modal
  const [permTarget, setPermTarget] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api.get<AdminUser[]>('/api/admin/users'));
    } catch (e) {
      toast(e instanceof Error ? e.message : t('加载用户列表失败'), 'err');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createUser() {
    if (busy) return;
    if (password.length < 8) { toast(t('密码至少 8 位'), 'err'); return; }
    setBusy(true);
    try {
      await api.post('/api/admin/users', { username: username.trim(), password, role });
      toast(t('用户已创建'), 'ok');
      setCreateOpen(false);
      setUsername(''); setPassword(''); setRole('user');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('创建失败'), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!resetTarget || busy) return;
    if (newPassword.length < 8) { toast(t('密码至少 8 位'), 'err'); return; }
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${resetTarget.id}`, { password: newPassword });
      toast(t('密码已重置'), 'ok');
      setResetTarget(null); setNewPassword('');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('重置失败'), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function saveQuota() {
    if (!quotaTarget || busy) return;
    const raw = quotaValue.trim();
    let quota: number | null = null;
    if (raw !== '') {
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n) || n < 0) { toast(t('配额需为不小于 0 的整数'), 'err'); return; }
      quota = n;
    }
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${quotaTarget.id}`, { monthlyTokenQuota: quota });
      toast(t('已更新月度配额'), 'ok');
      setQuotaTarget(null);
      await load();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function savePerm(patch: { allowImages?: boolean; allowImageModels?: boolean }) {
    if (!permTarget || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${permTarget.id}`, patch);
      setPermTarget((cur) => (cur ? { ...cur, ...patch } : cur));
      await load();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function toggleRole(u: AdminUser) {
    const next = u.role === 'admin' ? 'user' : 'admin';
    const ok = await confirmDialog(
      t('切换角色'),
      t('确定将「{name}」的角色改为{role}?', {
        name: userLabel(u),
        role: next === 'admin' ? t('管理员') : t('普通用户'),
      }),
      false,
    );
    if (!ok) return;
    try {
      await api.patch(`/api/admin/users/${u.id}`, { role: next });
      toast(t('角色已更新'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('操作失败'), 'err');
    }
    await load();
  }

  async function toggleDisabled(u: AdminUser) {
    const ok = u.disabled
      ? await confirmDialog(t('启用用户'), t('确定重新启用「{name}」?', { name: userLabel(u) }), false)
      : await confirmDialog(t('停用用户'), t('确定停用「{name}」?停用后该用户将被立即登出且无法登录。', { name: userLabel(u) }));
    if (!ok) return;
    try {
      await api.patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled });
      toast(u.disabled ? t('用户已启用') : t('用户已停用'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('操作失败'), 'err');
    }
    await load();
  }

  async function forceLogout(u: AdminUser) {
    const ok = await confirmDialog(
      t('强制下线'),
      t('将「{name}」从所有已登录设备({n} 台)退出,账号本身不受影响,可以重新登录。',
        { name: userLabel(u), n: u.activeSessions }),
      false,
    );
    if (!ok) return;
    try {
      const r = await api.post<{ removed: number }>(`/api/admin/users/${u.id}/logout`);
      toast(r.removed ? t('已退出 {n} 台设备', { n: r.removed }) : t('该用户当前没有登录中的设备'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('操作失败'), 'err');
    }
    await load();
  }

  async function deleteUser(u: AdminUser) {
    const ok = await confirmDialog(
      t('删除用户'),
      t('确定永久删除「{name}」?该用户的所有对话、图片与上传文件将一并删除,此操作不可恢复!',
        { name: userLabel(u) }),
    );
    if (!ok) return;
    try {
      await api.del(`/api/admin/users/${u.id}`);
      toast(t('用户已删除'), 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : t('删除失败'), 'err');
    }
    await load();
  }

  if (!users) {
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-tx">{t('用户@@nav')}</h1>
          <p className="mt-0.5 text-xs text-tx3">{t('共 {n} 个账号', { n: users.length })}</p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={15} />{t('新建用户')}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-bg1 shadow-xs">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr>
              <Th>{t('用户名')}</Th>
              <Th>{t('角色')}</Th>
              <Th>{t('状态')}</Th>
              <Th className="text-right">Tokens</Th>
              <Th className="text-right">{t('本月 / 配额')}</Th>
              <Th className="text-right">{t('请求')}</Th>
              <Th className="text-right">{t('图片')}</Th>
              <Th className="text-right" title={t('已保存的对话数(不含临时对话),点击查看')}>{t('对话')}</Th>
              <Th>{t('注册时间')}</Th>
              <Th className="text-right">{t('操作')}</Th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="group transition-colors hover:bg-bg2/60">
                <Td>
                  <Link to={`/admin/users/${u.id}`} title={t('查看用量详情')}
                    className="font-medium text-tx hover:underline">
                    {userLabel(u)}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={u.role === 'admin' ? 'acc' : 'default'}>{u.role === 'admin' ? t('管理员') : t('用户')}</Badge>
                </Td>
                <Td>
                  <Badge tone={u.disabled ? 'err' : 'ok'}>{u.disabled ? t('已停用') : t('正常')}</Badge>
                </Td>
                <Td className="text-right tabular-nums">{fmtTokens(u.usage.totalTokens)}</Td>
                <Td className="text-right">
                  <button
                    type="button"
                    title={t('设置月度配额')}
                    onClick={() => {
                      setQuotaValue(u.monthlyTokenQuota === null ? '' : String(u.monthlyTokenQuota));
                      setQuotaTarget(u);
                    }}
                    className="cursor-pointer rounded-sm px-1 py-0.5 tabular-nums transition-colors hover:bg-bg3"
                  >
                    {fmtTokens(u.usage.monthTokens)} / <span className={
                      u.role !== 'admin' && (u.monthlyTokenQuota ?? -1) > 0
                        && u.usage.monthTokens >= u.monthlyTokenQuota! ? 'text-err' : ''
                    }>{quotaLabel(u)}</span>
                  </button>
                </Td>
                <Td className="text-right tabular-nums">{u.usage.requests.toLocaleString()}</Td>
                <Td className="text-right tabular-nums">{u.usage.images.toLocaleString()}</Td>
                <Td className="text-right tabular-nums">
                  <Link to={`/admin/users/${u.id}`} title={t('查看该用户的对话记录')} className="hover:underline">
                    {u.chats.toLocaleString()}
                  </Link>
                </Td>
                <Td className="tabular-nums">{fmtDate(u.createdAt)}</Td>
                <Td>
                  <div className="flex items-center justify-end gap-0.5">
                    <Link to={`/admin/users/${u.id}`} title={t('用量详情')}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-tx2 transition-colors hover:bg-bg3 hover:text-tx">
                      <BarChart3 size={14} />
                    </Link>
                    <Button variant="ghost" size="iconSm" title={t('绘图权限')}
                      onClick={() => setPermTarget(u)}>
                      <ImageIcon size={14} className={u.allowImages || u.allowImageModels ? 'text-acc' : ''} />
                    </Button>
                    <Button variant="ghost" size="iconSm" title={t('重置密码')}
                      onClick={() => { setNewPassword(''); setResetTarget(u); }}>
                      <KeyRound size={14} />
                    </Button>
                    <Button variant="ghost" size="iconSm"
                      title={u.activeSessions
                        ? t('强制下线(当前 {n} 台设备在线)', { n: u.activeSessions })
                        : t('强制下线(当前没有登录中的设备)')}
                      disabled={!u.activeSessions} onClick={() => forceLogout(u)}>
                      <LogOut size={14} className={u.activeSessions ? 'text-acc' : ''} />
                    </Button>
                    <Button variant="ghost" size="iconSm"
                      title={u.role === 'admin' ? t('降为普通用户') : t('升为管理员')}
                      onClick={() => toggleRole(u)}>
                      <ShieldCheck size={14} className={u.role === 'admin' ? 'text-acc' : ''} />
                    </Button>
                    <Button variant="ghost" size="iconSm" title={u.disabled ? t('启用') : t('停用')}
                      onClick={() => toggleDisabled(u)}>
                      {u.disabled ? <CircleCheck size={14} className="text-ok" /> : <Ban size={14} />}
                    </Button>
                    <Button variant="dangerGhost" size="iconSm" title={t('删除')}
                      onClick={() => deleteUser(u)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('新建用户')}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); createUser(); }}>
          <Field label={t('用户名')}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)}
              autoFocus maxLength={32} required placeholder={t('2-32 位')} />
          </Field>
          <Field label={t('密码')} hint={t('至少 8 位')}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" maxLength={128} required />
          </Field>
          <Field label={t('角色')}>
            <Select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
              <option value="user">{t('用户')}</option>
              <option value="admin">{t('管理员')}</option>
            </Select>
          </Field>
          <ModalActions>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('取消')}</Button>
            <Button variant="primary" disabled={busy} onClick={createUser}>
              {busy && <Spinner className="h-3.5 w-3.5" />}{t('创建用户')}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal open={!!quotaTarget} onClose={() => setQuotaTarget(null)}
        title={`${t('月度 token 配额')}${quotaTarget ? ` — ${userLabel(quotaTarget)}` : ''}`}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); saveQuota(); }}>
          {quotaTarget?.role === 'admin' && (
            <p className="rounded-md border border-line bg-bg2/50 px-3 py-2 text-xs leading-relaxed text-tx3">
              {t('管理员不受配额限制,此处的设置仅在该账号转为普通用户后生效。')}
            </p>
          )}
          <Field label={t('每月 token 上限')} hint={t('留空 = 跟随「站点 → 通用」里的默认配额;0 = 不限;超额后的处理也在那里配置')}>
            <Input
              type="number" min={0} step={1} inputMode="numeric"
              value={quotaValue} onChange={(e) => setQuotaValue(e.target.value)}
              autoFocus placeholder={t('留空跟随默认')}
            />
          </Field>
          {quotaTarget && (
            <p className="text-xs text-tx3">
              {t('本月已用 {n} tokens,每月 1 日重新计算。', { n: fmtTokens(quotaTarget.usage.monthTokens) })}
            </p>
          )}
          <ModalActions>
            <Button variant="outline" onClick={() => setQuotaTarget(null)}>{t('取消')}</Button>
            <Button variant="primary" disabled={busy} onClick={saveQuota}>
              {busy && <Spinner className="h-3.5 w-3.5" />}{t('保存')}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal open={!!permTarget} onClose={() => setPermTarget(null)}
        title={`${t('绘图权限')}${permTarget ? ` — ${userLabel(permTarget)}` : ''}`}>
        <div className="space-y-4">
          {permTarget?.role === 'admin' && (
            <p className="rounded-md border border-line bg-bg2/50 px-3 py-2 text-xs leading-relaxed text-tx3">
              {t('管理员始终拥有全部权限,此处的设置仅在该账号转为普通用户后生效。')}
            </p>
          )}
          <ToggleRow
            label={t('绘图工坊访问权限')}
            desc={t('关闭时打开绘图工坊会提示没有权限')}
            checked={!!permTarget?.allowImages}
            onChange={(v) => void savePerm({ allowImages: v })}
            disabled={busy}
          />
          <ToggleRow
            label={t('图像模型使用权限')}
            desc={t('关闭时在模型列表中看不到图像模型,也无法生成图片')}
            checked={!!permTarget?.allowImageModels}
            onChange={(v) => void savePerm({ allowImageModels: v })}
            disabled={busy}
          />
          <ModalActions>
            <Button variant="outline" onClick={() => setPermTarget(null)}>{t('完成')}</Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal open={!!resetTarget} onClose={() => setResetTarget(null)}
        title={`${t('重置密码')}${resetTarget ? ` — ${userLabel(resetTarget)}` : ''}`}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); resetPassword(); }}>
          <Field label={t('新密码')} hint={t('至少 8 位,重置后该用户需重新登录')}>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              autoFocus autoComplete="new-password" maxLength={128} required />
          </Field>
          <ModalActions>
            <Button variant="outline" onClick={() => setResetTarget(null)}>{t('取消')}</Button>
            <Button variant="primary" disabled={busy} onClick={resetPassword}>
              {busy && <Spinner className="h-3.5 w-3.5" />}{t('重置密码')}
            </Button>
          </ModalActions>
        </form>
      </Modal>
    </div>
  );
}
