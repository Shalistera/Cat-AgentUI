import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../../api';
import { Badge, Button, Card, Field, Input, Select, Spinner, Toggle, ToggleRow, toast } from '../../components/ui';
import type { AccessPolicy, AdminUser, AgentAdminData, AgentSettings, ModelInfo } from '../../types';

function fmtMb(n: number): string { return `${Math.round(n / 1048576)} MB`; }

/** enabled + 全员/指定用户 + user list: the one access block every capability shares. */
function AccessEditor({ value, onChange, users, disabled, enabledLabel, enabledDesc }: {
  value: AccessPolicy; onChange(v: AccessPolicy): void; users: AdminUser[]; disabled?: boolean;
  enabledLabel: string; enabledDesc: string;
}) {
  const normalUsers = users.filter((u) => u.role !== 'admin');
  return (
    <div className="space-y-3">
      <ToggleRow label={enabledLabel} desc={enabledDesc} checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} disabled={disabled} />
      {value.enabled && (
        <>
          <Field label="谁可以使用" hint="管理员始终可用">
            <Select value={value.accessMode} onChange={(e) => onChange({ ...value, accessMode: e.target.value as AccessPolicy['accessMode'] })} disabled={disabled}>
              <option value="shared">所有登录用户</option>
              <option value="restricted">仅指定普通用户</option>
            </Select>
          </Field>
          {value.accessMode === 'restricted' && (
            <div className="max-h-44 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg0">
              {normalUsers.length === 0 ? <div className="px-3 py-3 text-xs text-tx3">暂无普通用户</div> : normalUsers.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-tx">{u.displayName || u.username}</div>
                    {u.displayName && <div className="truncate text-[11px] text-tx3">@{u.username}</div>}
                  </div>
                  {u.disabled && <Badge tone="err">已停用</Badge>}
                  <Toggle checked={value.allowedUserIds.includes(u.id)} disabled={disabled}
                    onChange={(v) => onChange({ ...value, allowedUserIds: v ? [...value.allowedUserIds, u.id] : value.allowedUserIds.filter((x) => x !== u.id) })} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AgentSettingsPage() {
  const [data, setData] = useState<AgentAdminData | null>(null);
  const [s, setS] = useState<AgentSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<AgentAdminData>('/api/admin/agent').then((r) => { setData(r); setS(r.settings); }).catch((e) => toast(errMsg(e), 'err'));
    api.get<AdminUser[]>('/api/admin/users').then(setUsers).catch(() => { /* optional */ });
    api.get<ModelInfo[]>('/api/models').then(setModels).catch(() => { /* optional */ });
  }, []);

  if (!data || !s) return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings);

  async function save() {
    if (!s) return;
    setSaving(true);
    try {
      const r = await api.put<{ settings: AgentSettings }>('/api/admin/agent', s);
      setData((d) => (d ? { ...d, settings: r.settings } : d));
      setS(r.settings);
      toast('已保存', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setSaving(false); }
  }

  const num = (v: number, set: (n: number) => void, min: number, max: number, cls = 'max-w-32') => (
    <Input type="number" min={min} max={max} step={1} inputMode="numeric" className={cls} value={v} onChange={(e) => set(Number(e.target.value))} />
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-tx">Agent 能力</h1>
          <p className="mt-0.5 text-xs text-tx3">工作区、图表对比、图片生成、技能、子代理的总开关与访问范围。沙盒(命令执行)的开关、限额与运行库在<Link to="/admin/sandbox" className="mx-0.5 text-acc hover:underline">沙盒</Link>页;技能内容在<Link to="/admin/skills" className="mx-0.5 text-acc hover:underline">技能</Link>页。</p>
        </div>
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>{saving && <Spinner className="h-3.5 w-3.5" />}保存更改</Button>
      </div>

      <Card title="工作区" desc="每个对话一个私有文件目录,模型通过 workspace_* 工具读写;关闭后输入栏不再出现「工作区」按钮,已有文件保留但模型不可用。沙盒、子代理都建立在工作区之上。">
        <AccessEditor value={s.workspace} onChange={(v) => setS({ ...s, workspace: v })} users={users} disabled={saving}
          enabledLabel="允许使用工作区" enabledDesc={`每对话上限 ${fmtMb(data.limits.workspaceBytes)} / ${data.limits.workspaceFiles} 个文件,单文件 ${fmtMb(data.limits.workspaceFileBytes)}(环境变量 MAX_WORKSPACE_*)`} />
      </Card>

      <Card title="图表对比" desc="比较同一指标、同一单位的数值,支持柱状图和多曲线折线图,可切换为数据表。数据来源和数值始终可见。">
        <AccessEditor value={s.dataComparison} onChange={(v) => setS({ ...s, dataComparison: v })} users={users} disabled={saving}
          enabledLabel="允许使用图表对比" enabledDesc="默认开启,受个人智能工具开关控制。每轮最多展示一张图,格式错误可修正一次。柱状图 2–12 项;折线图最多 6 条曲线、每条 120 点、合计 600 点。多曲线也不依赖 Python 或沙盒;计算、拟合数据仍需相应计算能力。" />
      </Card>

      <Card title="图片生成" desc="普通聊天模型可按需要调用 generate_image,用下面选定的图片模型生成图片并直接展示在对话中。工具授权独立于模型可见权限:用户即使看不到这些模型、没有绘图工坊或直接使用图像模型的权限,也可通过此工具出图。">
        <div className="space-y-4">
          <AccessEditor value={s.imageGeneration} onChange={(v) => setS({ ...s, imageGeneration: { ...s.imageGeneration, ...v } })} users={users} disabled={saving}
            enabledLabel="允许模型调用图片生成" enabledDesc="默认关闭;需要用户开启智能工具,当前聊天模型支持工具调用。无需开启工作区或命令执行;用量、模型次数限制和存储限额照常计入用户。" />
          {s.imageGeneration.enabled && (
            <>
              <fieldset>
                <legend className="mb-1.5 text-[13px] font-medium text-tx">工具可调用的图片模型</legend>
                <div className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg0">
                  {models.filter((m) => m.imageGen && m.providerType !== 'novelai').map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-3 px-3 py-2">
                      <input type="checkbox" className="accent-acc" checked={s.imageGeneration.modelIds.includes(m.id)} disabled={saving}
                        onChange={(e) => setS({ ...s, imageGeneration: { ...s.imageGeneration, modelIds: e.target.checked
                          ? [...s.imageGeneration.modelIds, m.id] : s.imageGeneration.modelIds.filter((id) => id !== m.id) } })} />
                      <span className="min-w-0 flex-1 text-[13px] text-tx">{m.displayName || m.modelId}<span className="ml-1 text-xs text-tx3">({m.providerName})</span></span>
                      {s.imageGeneration.modelIds[0] === m.id && <Badge>默认</Badge>}
                    </label>
                  ))}
                  {!models.some((m) => m.imageGen) && <div className="px-3 py-3 text-xs text-tx3">暂无可用的图片模型,请先在模型管理中添加并启用。</div>}
                  {s.imageGeneration.modelIds.filter((id) => !models.some((m) => m.id === id && m.imageGen)).map((id) => (
                    <div key={id} className="flex items-center gap-2 px-3 py-2 text-xs text-tx3">
                      <span className="min-w-0 flex-1 break-all">模型不可用:{id}</span>
                      <button type="button" className="cursor-pointer text-err hover:underline" disabled={saving}
                        onClick={() => setS({ ...s, imageGeneration: { ...s.imageGeneration, modelIds: s.imageGeneration.modelIds.filter((x) => x !== id) } })}>移除</button>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-tx3">可以选择多个;第一个选中的模型为默认,聊天模型也可按需求选择其他已选模型。这里只列出当前启用的图片模型。</p>
              </fieldset>
              <Field label="每轮最多生成次数" hint="每次调用生成一张图片;失败的调用也计入本轮次数上限。">
                {num(s.imageGeneration.maxPerTurn, (n) => setS({ ...s, imageGeneration: { ...s.imageGeneration, maxPerTurn: n } }), 1, 10)}
              </Field>
              <Field label="普通用户每日调用上限" hint="每人每天跨全部图片模型合并计数,按服务器时间 0 点重置;0 为不限,管理员不受此限。已发送到图片模型的请求计次(含失败或取消),自动重试不重复扣次;参数错误或权限拒绝不扣次。">
                {num(s.imageGeneration.dailyLimit, (n) => setS({ ...s, imageGeneration: { ...s.imageGeneration, dailyLimit: n } }), 0, 10000)}
              </Field>
            </>
          )}
        </div>
      </Card>

      <Card title="技能" desc="总开关。关闭后所有对话都不再注入技能清单,也不提供 load_skill;各技能自己的启用与访问范围在技能页单独设置,两层都放行才可见。">
        <AccessEditor value={s.skills} onChange={(v) => setS({ ...s, skills: v })} users={users} disabled={saving}
          enabledLabel="允许使用技能" enabledDesc="模型只看到技能名称与用途,任务匹配时才加载完整说明" />
      </Card>

      <Card title="子代理" desc="模型可用 spawn_subagent 把独立子任务委派给一个看不到对话历史的子代理:同样的工作区 / 技能 / 沙盒工具,不能再嵌套,不能用 MCP;结果以文字回给主对话,文件留在工作区。每次委派都是一次完整的模型调用,token 记入发起用户(用量看板里的「子代理」)。">
        <div className="space-y-4">
          <AccessEditor value={s.subagent} onChange={(v) => setS({ ...s, subagent: { ...s.subagent, ...v } })} users={users} disabled={saving}
            enabledLabel="允许使用子代理" enabledDesc="默认关闭;需要工作区同时开启" />
          {s.subagent.enabled && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="子代理使用的模型" hint="留空 = 与主对话相同;指定一个便宜的工具模型可以控制成本">
                <Select value={s.subagent.modelId} onChange={(e) => setS({ ...s, subagent: { ...s.subagent, modelId: e.target.value } })}>
                  <option value="">与主对话相同</option>
                  {models.filter((m) => m.tools && !m.imageGen).map((m) => <option key={m.id} value={m.id}>{m.displayName || m.modelId}({m.providerName})</option>)}
                </Select>
              </Field>
              <Field label="每轮最多委派次数" hint="一条回复里 spawn_subagent 的上限">{num(s.subagent.maxPerTurn, (n) => setS({ ...s, subagent: { ...s.subagent, maxPerTurn: n } }), 1, 20)}</Field>
              <Field label="子代理工具轮数上限" hint={`主对话为 ${data.limits.toolIterations}(MAX_TOOL_ITERATIONS)`}>{num(s.subagent.maxIterations, (n) => setS({ ...s, subagent: { ...s.subagent, maxIterations: n } }), 1, 50)}</Field>
              <Field label="单个子代理超时(秒)" hint="含它执行的所有命令">{num(s.subagent.timeoutSec, (n) => setS({ ...s, subagent: { ...s.subagent, timeoutSec: n } }), 30, 1800)}</Field>
              <Field label="回传结论上限(字符)" hint="超出截断,避免子代理把整篇文件塞回主对话">{num(s.subagent.maxResultChars, (n) => setS({ ...s, subagent: { ...s.subagent, maxResultChars: n } }), 1000, 100000)}</Field>
              <div className="sm:col-span-2 lg:col-span-3">
                <ToggleRow label="子代理可以执行命令" desc="前提是沙盒本身已开启且该用户有权;沙盒的「执行前确认」对子代理同样生效,确认卡片会出现在主对话里"
                  checked={s.subagent.allowSandbox} onChange={(v) => setS({ ...s, subagent: { ...s.subagent, allowSandbox: v } })} disabled={saving} />
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
