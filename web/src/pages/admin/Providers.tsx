import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown, ArrowUp, ArrowUpToLine, Check, ChevronDown, Download, FlaskConical, Pencil, Plus, RotateCcw, Server, Trash2, Upload, X,
} from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, EmptyState, Field, Input, Modal, ModalActions, Select, Spinner,
  StatusDot, Td, Textarea, Th, Toggle, ToggleRow, confirmDialog, toast,
} from '../../components/ui';
import { KeyValueEditor, pairsToObject, type KVPair } from '../../components/KeyValueEditor';
import { ProviderAvatar } from '../../components/ModelAvatar';
import { locale, t, tServer } from '../../i18n';
import type { AdminModel, AdminProvider, AdminProviderEndpoint, AdminVertexLine, LineHealth } from '../../types';
import { DEFAULT_URLS, TYPE_LABELS, type ProviderType } from './provider-common';

// ---------- Vertex locations ----------
const PRESET_LOCATIONS = ['global', 'us', 'eu'];
const MAX_LOCATIONS = 6;

function locationLabel(loc: string): string {
  if (loc === 'global') return t('全球 · 按空闲容量调度,容量最大');
  if (loc === 'us') return t('美国多区域 · 只在美国境内处理');
  if (loc === 'eu') return t('欧盟多区域 · 只在欧盟境内处理');
  return t('单区域 · 容量最小,不支持 Priority');
}

function vertexHost(loc: string): string {
  if (loc === 'global') return 'aiplatform.googleapis.com';
  if (loc === 'us' || loc === 'eu') return `aiplatform.${loc}.rep.googleapis.com`;
  return `${loc}-aiplatform.googleapis.com`;
}

function parseLocations(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[\s,，、]+/)) {
    const loc = part.trim().toLowerCase();
    if (loc && !out.includes(loc)) out.push(loc);
  }
  return out;
}

// Ordered list, first tried first. Not wrapped in <Field>: a <label> would
// forward clicks on its blank area to the first button inside.
function VertexLocationEditor({ locations, onChange }: { locations: string[]; onChange(v: string[]): void }) {
  const [custom, setCustom] = useState('');
  const shown = locations.length ? locations : ['global'];
  const full = shown.length >= MAX_LOCATIONS;

  function move(i: number, delta: number) {
    const next = [...shown];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    onChange(next);
  }
  function add(loc: string) {
    const v = loc.trim().toLowerCase();
    if (!v) return;
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(v)) { toast(t('区域名只能包含小写字母、数字和连字符,如 us-central1'), 'err'); return; }
    if (shown.includes(v)) { toast(t('已在列表中'), 'err'); return; }
    onChange([...shown, v]);
    setCustom('');
  }

  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-tx">{t('Vertex 区域(按优先级)')}</div>
      <div className="space-y-1.5">
        {shown.map((loc, i) => (
          <div key={loc} className="flex items-center gap-2 rounded-md border border-line bg-bg1 px-2.5 py-1.5">
            <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-tx3">{i + 1}</span>
            <span className="font-mono text-xs font-medium text-tx">{loc}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-tx3">{locationLabel(loc)}</span>
            <Button variant="ghost" size="iconXs" title={t('提前')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={12} /></Button>
            <Button variant="ghost" size="iconXs" title={t('延后')} disabled={i === shown.length - 1} onClick={() => move(i, 1)}><ArrowDown size={12} /></Button>
            <Button variant="dangerGhost" size="iconXs" title={t('移除')} disabled={shown.length === 1}
              onClick={() => onChange(shown.filter((x) => x !== loc))}><X size={12} /></Button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {PRESET_LOCATIONS.filter((loc) => !shown.includes(loc)).map((loc) => (
          <Button key={loc} variant="outline" size="sm" disabled={full} onClick={() => add(loc)}><Plus size={12} />{loc}</Button>
        ))}
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); add(custom); }}>
          <div className="w-36"><Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t('其他,如 us-central1')} uiSize="sm" className="font-mono text-xs" /></div>
          <Button variant="outline" size="sm" type="submit" disabled={full || !custom.trim()}>{t('添加')}</Button>
        </form>
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-tx3">
        {t('从第一个开始用;被限流或出故障时,同一次请求内自动换下一个。global 会把请求调度到当时有空闲的区域,容量最大,Google 推荐优先用它减少 429;us、eu 只在对应地区内处理,容量是 global 的一部分。')}
      </div>
    </div>
  );
}

// ---------- provider create / edit modal ----------
function ProviderModal({ provider, onClose, onSaved }: {
  provider: AdminProvider | null; onClose(): void; onSaved(): Promise<void>;
}) {
  const isEdit = provider !== null;
  const [name, setName] = useState(provider?.name ?? '');
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [useResponses, setUseResponses] = useState(provider?.useResponses ?? false);
  const [useVertex, setUseVertex] = useState(provider?.useVertex ?? false);
  const [vertexProject, setVertexProject] = useState(provider?.vertexProject ?? '');
  const [vertexLocations, setVertexLocations] = useState<string[]>(parseLocations(provider?.vertexLocation));
  const [vertexPriority, setVertexPriority] = useState<AdminProvider['vertexPriority']>(provider?.vertexPriority ?? 'off');
  const [vertexSaJson, setVertexSaJson] = useState('');
  // Saved header values are write-only. Blank values on existing key rows mean
  // "keep", while typing replaces that key and deleting the row removes it.
  const [headers, setHeaders] = useState<KVPair[]>(
    (provider?.extraHeaderKeys ?? []).map((k) => ({ k, v: '' })),
  );
  const [hasKey, setHasKey] = useState(provider?.hasKey ?? false);
  const [hasVertexSa, setHasVertexSa] = useState(provider?.hasVertexSa ?? false);
  const [failoverThreshold, setFailoverThreshold] = useState(String(provider?.failoverThreshold ?? 3));
  const [failoverCooldown, setFailoverCooldown] = useState(String(provider?.failoverCooldownSeconds ?? 60));
  const [primaryName, setPrimaryName] = useState(provider?.primaryName ?? '');
  const [strip, setStrip] = useState(provider?.stripModelPrefix ?? '');
  const [add, setAdd] = useState(provider?.addModelPrefix ?? '');
  const [busy, setBusy] = useState(false);
  const saFileRef = useRef<HTMLInputElement>(null);
  const hasBackups = (provider?.endpoints.length ?? 0) > 0;

  const vertexMode = type === 'gemini' && useVertex;
  // Runs through this machine's own `claude` login: nothing to connect to.
  const local = type === 'claude-code';

  function applySaJson(text: string): boolean {
    try {
      const j = JSON.parse(text) as { project_id?: unknown };
      setVertexSaJson(JSON.stringify(j, null, 2));
      if (j.project_id && !vertexProject.trim()) setVertexProject(String(j.project_id));
      return true;
    } catch {
      return false;
    }
  }

  async function pickSaFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const ok = applySaJson(await f.text());
    toast(ok ? t('已读取服务账号 JSON') : t('文件不是有效的 JSON'), ok ? 'ok' : 'err');
  }

  async function submit() {
    if (busy) return;
    if (!name.trim()) { toast(t('请填写名称'), 'err'); return; }
    const body: Record<string, unknown> = {
      name: name.trim(),
      type,
      baseUrl: baseUrl.trim() || null,
      useResponses: type === 'openai' ? useResponses : false,
      useVertex: type === 'gemini' ? useVertex : false,
      vertexProject: vertexProject.trim() || null,
      vertexLocation: vertexLocations.join(',') || null,
      vertexPriority,
    };
    const existingHeaderKeys = new Set(provider?.extraHeaderKeys ?? []);
    // A blank existing row means "keep"; a newly-added blank row remains a
    // real empty-valued header, matching the panel's behavior before values
    // became write-only.
    const headerValues = pairsToObject(headers.filter(
      (p) => p.v.length > 0 || !existingHeaderKeys.has(p.k),
    ));
    body.extraHeaders = headerValues;
    if (isEdit) {
      body.preserveExtraHeaderKeys = headers
        .filter((p) => existingHeaderKeys.has(p.k) && p.v.length === 0)
        .map((p) => p.k);
    }
    if (apiKey) body.apiKey = apiKey;
    if (isEdit) {
      const threshold = Number(failoverThreshold);
      const cooldown = Number(failoverCooldown);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) { toast(t('切换阈值需为 1–100 的整数'), 'err'); return; }
      if (!Number.isInteger(cooldown) || cooldown < 5 || cooldown > 86400) { toast(t('熔断时长需为 5–86400 秒'), 'err'); return; }
      body.failoverThreshold = threshold;
      body.failoverCooldownSeconds = cooldown;
      body.primaryName = primaryName.trim() || null;
      body.stripModelPrefix = strip.trim();
      body.addModelPrefix = add.trim();
    }
    if (vertexSaJson.trim()) {
      // Validate here, with a message that says what's wrong — the server
      // would only answer with a generic 400.
      try {
        body.vertexSaJson = JSON.stringify(JSON.parse(vertexSaJson));
      } catch {
        toast(t('Service Account JSON 不是有效的 JSON,请检查是否完整复制(或直接上传文件)'), 'err');
        return;
      }
    }
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/admin/providers/${provider.id}`, body);
      else await api.post('/api/admin/providers', body);
      toast(isEdit ? t('已保存') : t('已添加 Provider'), 'ok');
      await onSaved();
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function clearKey() {
    if (!provider) return;
    try {
      await api.patch(`/api/admin/providers/${provider.id}`, { apiKey: '' });
      setHasKey(false); setApiKey('');
      toast(t('已清除 API Key'), 'ok');
      await onSaved();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function clearSaJson() {
    if (!provider) return;
    try {
      await api.patch(`/api/admin/providers/${provider.id}`, { vertexSaJson: '' });
      setHasVertexSa(false); setVertexSaJson('');
      toast(t('已清除 Service Account JSON'), 'ok');
      await onSaved();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? t('编辑 Provider') : t('添加 Provider')} wide>
      <div className="space-y-4">
        <Field label={t('名称')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('如 OpenAI 官方')} autoFocus maxLength={64} />
        </Field>
        <Field label={t('类型')}>
          <Select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
            <option value="openai">{t('OpenAI 兼容')}</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Google Gemini</option>
            <option value="claude-code">{t('本地 Claude Code(仅管理员)')}</option>
            <option value="novelai">{t('NovelAI V5(绘图工坊)')}</option>
          </Select>
        </Field>
        {local ? (
          <p className="rounded-lg border border-line bg-bg2/30 p-3 text-xs leading-relaxed text-tx2">
            {t('通过服务器上已登录的 Claude Code(')}<code>claude</code>{t('命令)对话,使用的是该账号的订阅额度。只有管理员能看到和使用这些模型,模型的访问范围设置对它不起作用。Claude Code 自带的命令行、读写文件等工具全部关闭,只能用面板自己的工具(沙盒、工作区、Skills、子代理等);温度和最大输出长度不生效。')}
          </p>
        ) : (<>
        {type === 'novelai' && <p className="rounded-lg border border-line bg-bg2 p-3 text-xs text-tx2">{t('使用 NovelAI 设置中的 Persistent API Token。仅支持 V5 Full / Curated 的 Opus 订阅额度模式，图片在绘图工坊中生成。添加后拉取并导入两个模型。')}</p>}
        <Field label={t('API 地址')} hint={type === 'novelai' ? t('留空使用 https://image.novelai.net，填写服务根地址，不加 /v1') : t('留空使用官方地址;可填任意兼容网关,写到 /v1 或整条接口地址都能识别')}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_URLS[type]} />
        </Field>
        {!vertexMode && (
          <Field label={type === 'novelai' ? t('Persistent API Token') : t('API Key')}>
            <div className="flex items-center gap-2">
              <Input
                type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                placeholder={isEdit && hasKey ? t('●●●●●●(已保存,留空保持不变)') : type === 'novelai' ? t('粘贴 NovelAI Persistent API Token') : 'sk-…'}
              />
              {isEdit && hasKey && (
                <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={clearKey}>{t('清除 Key')}</Button>
              )}
            </div>
          </Field>
        )}

        </>)}

        {type === 'openai' && (
          <ToggleRow
            label={t('使用 Responses API')} desc={t('新一代接口,支持推理摘要,仅官方及兼容网关支持')}
            checked={useResponses} onChange={setUseResponses}
          />
        )}

        {type === 'gemini' && (
          <>
            <ToggleRow
              label={t('使用 Vertex AI')} desc={t('使用服务账号鉴权,无需 API Key')}
              checked={useVertex} onChange={setUseVertex}
            />
            {useVertex && (
              <div className="space-y-4 rounded-lg border border-line bg-bg2/30 p-3">
                <Field label="Service Account JSON" hint={t('可直接上传 .json 文件,或粘贴完整内容')}>
                  <Textarea
                    rows={4} value={vertexSaJson}
                    onChange={(e) => setVertexSaJson(e.target.value)}
                    onBlur={() => { if (vertexSaJson.trim()) applySaJson(vertexSaJson); }}
                    className="font-mono text-xs"
                    placeholder={isEdit && hasVertexSa ? t('●●●●●●(已保存,留空保持不变)') : '{ "type": "service_account", … }'}
                  />
                  <div className="mt-1.5 flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => saFileRef.current?.click()}>
                      <Upload size={13} />{t('上传 JSON 文件')}
                    </Button>
                    {isEdit && hasVertexSa && (
                      <Button variant="outline" size="sm" onClick={clearSaJson}>{t('清除已保存的 JSON')}</Button>
                    )}
                  </div>
                  <input ref={saFileRef} type="file" accept=".json,application/json" hidden onChange={pickSaFile} />
                </Field>
                <Field label={t('Vertex 项目 ID')} hint={t('留空自动使用 JSON 中的 project_id')}>
                  <Input value={vertexProject} onChange={(e) => setVertexProject(e.target.value)} placeholder={t('留空自动读取')} />
                </Field>
                <VertexLocationEditor locations={vertexLocations} onChange={setVertexLocations} />
                <Field label="Priority PayGo" hint={vertexPriority === 'off'
                  ? t('按 token 计费、单价更高、更不容易被限流的付费方式,不用提前购买')
                  : t('Priority 单价高于标准按量付费,以 Google 定价页为准;用量统计仍按模型设置的单价计算。只在 global、us、eu 上生效,图像等不支持的模型仍走标准通道。首次失败模式会跳过标准重试和后续区域,已开始输出的回复不会重放。实际请求 Priority 时,对话会展示并保留优先通道标识')}>
                  <Select value={vertexPriority} onChange={(e) => setVertexPriority(e.target.value as AdminProvider['vertexPriority'])}>
                    <option value="off">{t('关闭 · 只用标准按量付费')}</option>
                    <option value="fallback">{t('限流时启用 · 标准请求被限流 5 次或各区域都试过后改走 Priority')}</option>
                    <option value="first_failure">{t('首次失败即启用 · 标准请求失败一次就改走 Priority')}</option>
                    <option value="always">{t('始终使用 · 所有请求都走 Priority')}</option>
                  </Select>
                </Field>
              </div>
            )}
          </>
        )}

        {!local && (
          <Field label={t('自定义 Headers')} hint={isEdit ? t('已保存值不回显;留空保持,填写替换,删除行即移除') : undefined}>
            <KeyValueEditor pairs={headers} onChange={setHeaders} keyPlaceholder={t('Header 名称')}
              valuePlaceholder={isEdit ? t('留空保持原值') : t('Header 值')} valueType="password" />
          </Field>
        )}

        {isEdit && !local && type !== 'novelai' && (
          <div className="space-y-4 rounded-lg border border-line bg-bg2/30 p-3">
            <Field label={t('主线路名称')} hint={vertexMode ? t('只在线路列表和切换提示里显示;留空显示为「主线路」,设置了多个区域或 Priority 时显示区域名') : t('只在备用线路列表和切换提示里显示;留空显示为「主线路」')}>
              <Input value={primaryName} onChange={(e) => setPrimaryName(e.target.value)} placeholder={t('如 OpenRouter')} maxLength={64} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('去掉模型名前缀')} hint={t('发送前从模型 ID 去掉;一般留空')}>
                <Input value={strip} onChange={(e) => setStrip(e.target.value)} placeholder={t('留空不处理')} maxLength={100} />
              </Field>
              <Field label={t('加上模型名前缀')} hint={t('去掉前缀后再加上这个')}>
                <Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder={t('留空不处理')} maxLength={100} />
              </Field>
            </div>
          </div>
        )}
        {isEdit && !local && type !== 'novelai' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('故障切换阈值')} hint={hasBackups ? t('同一线路连续失败这么多次后暂停使用') : t('添加备用线路后生效')}>
              <Input type="number" min={1} max={100} value={failoverThreshold}
                onChange={(e) => setFailoverThreshold(e.target.value)} />
            </Field>
            <Field label={t('熔断时长(秒)')} hint={t('暂停多久后再试探一次;成功即回到该线路')}>
              <Input type="number" min={5} max={86400} value={failoverCooldown}
                onChange={(e) => setFailoverCooldown(e.target.value)} />
            </Field>
          </div>
        )}

        <ModalActions>
          <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{isEdit ? t('保存更改') : t('添加 Provider')}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ---------- backup line create / edit modal ----------
function EndpointModal({ provider, endpoint, onClose, onSaved }: {
  provider: AdminProvider; endpoint: AdminProviderEndpoint | null; onClose(): void; onSaved(): Promise<void>;
}) {
  const isEdit = endpoint !== null;
  const [name, setName] = useState(endpoint?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(endpoint?.hasKey ?? false);
  const [useResponses, setUseResponses] = useState<'inherit' | 'on' | 'off'>(
    endpoint?.useResponses == null ? 'inherit' : endpoint.useResponses ? 'on' : 'off',
  );
  const [strip, setStrip] = useState(endpoint?.stripModelPrefix ?? '');
  const [add, setAdd] = useState(endpoint?.addModelPrefix ?? '');
  const [headers, setHeaders] = useState<KVPair[]>(
    (endpoint?.extraHeaderKeys ?? []).map((k) => ({ k, v: '' })),
  );
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (!name.trim()) { toast(t('请填写名称'), 'err'); return; }
    if (!isEdit && !baseUrl.trim()) { toast(t('请填写 API 地址'), 'err'); return; }
    const existingHeaderKeys = new Set(endpoint?.extraHeaderKeys ?? []);
    const body: Record<string, unknown> = {
      name: name.trim(),
      baseUrl: baseUrl.trim() || null,
      useResponses: useResponses === 'inherit' ? null : useResponses === 'on',
      stripModelPrefix: strip.trim(),
      addModelPrefix: add.trim(),
      extraHeaders: pairsToObject(headers.filter((p) => p.v.length > 0 || !existingHeaderKeys.has(p.k))),
    };
    if (isEdit) {
      body.preserveExtraHeaderKeys = headers
        .filter((p) => existingHeaderKeys.has(p.k) && p.v.length === 0)
        .map((p) => p.k);
    }
    if (apiKey) body.apiKey = apiKey;
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/admin/provider-endpoints/${endpoint.id}`, body);
      else await api.post(`/api/admin/providers/${provider.id}/endpoints`, body);
      toast(isEdit ? t('已保存') : t('已添加备用线路'), 'ok');
      await onSaved();
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function clearKey() {
    if (!endpoint) return;
    try {
      await api.patch(`/api/admin/provider-endpoints/${endpoint.id}`, { apiKey: '' });
      setHasKey(false); setApiKey('');
      toast(t('已清除 API Key'), 'ok');
      await onSaved();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? t('编辑备用线路') : t('添加备用线路')} wide>
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-tx3">
          {t('备用线路与「{name}」同类型({type}),共用同一份模型列表、权限和用量统计。主线路在返回内容前失败时才会用到它,主线路恢复后自动切回。', { name: provider.name, type: TYPE_LABELS[provider.type] })}
        </p>
        <Field label={t('名称')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('如 LiteLLM 备用')} autoFocus maxLength={64} />
        </Field>
        <Field label={t('API 地址')} hint={t('该线路的网关地址,写到 /v1 或整条接口地址都能识别')}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={DEFAULT_URLS[provider.type]} />
        </Field>
        <Field label={t('API Key')}>
          <div className="flex items-center gap-2">
            <Input
              type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              placeholder={isEdit && hasKey ? t('●●●●●●(已保存,留空保持不变)') : 'sk-…'}
            />
            {isEdit && hasKey && (
              <Button variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={clearKey}>{t('清除 Key')}</Button>
            )}
          </div>
        </Field>
        {provider.type === 'openai' && (
          <Field label="Responses API" hint={t('该网关不支持新版接口时可在这里单独关掉')}>
            <Select value={useResponses} onChange={(e) => setUseResponses(e.target.value as 'inherit' | 'on' | 'off')}>
              <option value="inherit">{t('跟随主线路({state})', { state: provider.useResponses ? t('开') : t('关') })}</option>
              <option value="on">{t('开')}</option>
              <option value="off">{t('关')}</option>
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('去掉模型名前缀')} hint={t('如主线路用 openai/gpt-4o,这里填 openai/')}>
            <Input value={strip} onChange={(e) => setStrip(e.target.value)} placeholder={t('留空不处理')} maxLength={100} />
          </Field>
          <Field label={t('加上模型名前缀')} hint={t('去掉前缀后再加上这个')}>
            <Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder={t('留空不处理')} maxLength={100} />
          </Field>
        </div>
        <Field label={t('自定义 Headers')} hint={isEdit ? t('已保存值不回显;留空保持,填写替换,删除行即移除') : undefined}>
          <KeyValueEditor pairs={headers} onChange={setHeaders} keyPlaceholder={t('Header 名称')}
            valuePlaceholder={isEdit ? t('留空保持原值') : t('Header 值')} valueType="password" />
        </Field>
        <ModalActions>
          <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{isEdit ? t('保存更改') : t('添加备用线路')}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ---------- line health ----------
function HealthBadge({ health, compact }: { health: LineHealth; compact?: boolean }) {
  if (health.state === 'open') {
    const left = health.openUntil ? Math.max(1, Math.ceil((health.openUntil - Date.now()) / 1000)) : 0;
    return <Badge tone="err">{compact ? t('熔断中') : t('熔断中 · {left} 秒后试探', { left })}</Badge>;
  }
  if (health.state === 'probing') return <Badge tone="warn">{t('试探中')}</Badge>;
  if (health.state === 'degraded') return <Badge tone="warn">{compact ? t('有失败') : t('连续失败 {n} 次', { n: health.failures })}</Badge>;
  return compact ? null : <Badge tone="ok">{t('正常@@health')}</Badge>;
}

function healthDetail(h: LineHealth): string {
  const bits: string[] = [];
  if (h.lastError) bits.push(t('最近错误:{error}', { error: tServer(h.lastError) }));
  if (h.lastFailureAt) bits.push(t('时间 {at}', { at: new Date(h.lastFailureAt).toLocaleString(locale) }));
  if (h.served) bits.push(t('已承接 {n} 次', { n: h.served }));
  if (h.tookOver) bits.push(t('其中接替 {n} 次', { n: h.tookOver }));
  if (h.missingModels.length) bits.push(t('没有 {models},这些模型暂时跳过此线路', { models: h.missingModels.join(t('、')) }));
  return bits.join(' · ');
}

// ---------- backup lines section inside the provider card ----------
function EndpointRow({ endpoint, provider, index, count, position, reload, onEdit }: {
  endpoint: AdminProviderEndpoint; provider: AdminProvider; index: number; count: number;
  /** 1-based place among all of the provider's lines. */
  position: number;
  reload(): Promise<void>; onEdit(): void;
}) {
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await fn(); await reload(); } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  function move(delta: number) {
    const ids = provider.endpoints.map((e) => e.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    run(async () => { await api.put(`/api/admin/providers/${provider.id}/endpoints/order`, { ids }); });
  }

  async function test() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; modelCount?: number; error?: string }>(`/api/admin/provider-endpoints/${endpoint.id}/test`);
      if (r.ok) toast(t('连接成功,发现 {n} 个模型', { n: r.modelCount ?? 0 }), 'ok');
      else toast(r.error ? tServer(r.error) : t('连接失败'), 'err');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!(await confirmDialog(t('删除备用线路'), t('确定删除「{name}」?', { name: endpoint.name })))) return;
    run(async () => { await api.del(`/api/admin/provider-endpoints/${endpoint.id}`); toast(t('已删除'), 'ok'); });
  }

  async function promote() {
    const primary = provider.primaryName || t('主线路');
    if (!(await confirmDialog(t('设为主线路'), t('把「{name}」的地址、Key、Headers 和模型名前缀设为主线路,原「{primary}」降为备用线路并占用这个位置。模型列表、权限和用量不变。', { name: endpoint.name, primary })))) return;
    run(async () => { await api.post(`/api/admin/provider-endpoints/${endpoint.id}/promote`); toast(t('已互换主线路'), 'ok'); });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line px-2.5 py-2">
      <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-tx3">{position}</span>
      <StatusDot tone={!endpoint.enabled ? 'idle' : endpoint.health.state === 'ok' ? 'ok' : endpoint.health.state === 'open' ? 'err' : 'warn'} />
      <span className="text-xs font-medium text-tx">{endpoint.name}</span>
      <span className="hidden min-w-0 max-w-[14rem] flex-1 truncate font-mono text-[11px] text-tx3 md:block" title={endpoint.baseUrl ?? ''}>
        {endpoint.baseUrl || DEFAULT_URLS[provider.type]}
      </span>
      {!endpoint.hasKey && <Badge tone="err">{t('未配置 Key')}</Badge>}
      {endpoint.enabled && <HealthBadge health={endpoint.health} />}
      <div className="ml-auto flex items-center gap-0.5">
        <Button variant="ghost" size="iconXs" title={t('提高优先级')} disabled={busy || index === 0} onClick={() => move(-1)}><ArrowUp size={12} /></Button>
        <Button variant="ghost" size="iconXs" title={t('降低优先级')} disabled={busy || index === count - 1} onClick={() => move(1)}><ArrowDown size={12} /></Button>
        <Button variant="ghost" size="iconXs" title={t('与主线路互换(设为主线路)')} disabled={busy} onClick={promote}><ArrowUpToLine size={12} /></Button>
        <Button variant="ghost" size="iconXs" title={t('测试连接')} disabled={busy} onClick={test}><FlaskConical size={12} /></Button>
        <Button variant="ghost" size="iconXs" title={t('编辑')} disabled={busy} onClick={onEdit}><Pencil size={12} /></Button>
        <Toggle checked={endpoint.enabled} disabled={busy}
          onChange={(v) => run(async () => { await api.patch(`/api/admin/provider-endpoints/${endpoint.id}`, { enabled: v }); })} />
        <Button variant="dangerGhost" size="iconXs" title={t('删除')} disabled={busy} onClick={remove}><Trash2 size={12} /></Button>
      </div>
      {(endpoint.health.lastError || endpoint.health.missingModels.length > 0) && (
        <p className="basis-full pl-7 text-[11px] text-tx3">{healthDetail(endpoint.health)}</p>
      )}
    </div>
  );
}

// Built-in Vertex lines (other locations, the Priority fallback): state only —
// their order and presence are set in the provider editor.
function VertexLineRow({ line, position }: { line: AdminVertexLine; position: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line px-2.5 py-2">
      <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-tx3">{position}</span>
      <StatusDot tone={line.health.state === 'ok' ? 'ok' : line.health.state === 'open' ? 'err' : 'warn'} />
      <span className="text-xs font-medium text-tx">{line.name}</span>
      {line.priority && <Badge tone="warn">{t('加价')}</Badge>}
      <span className="hidden min-w-0 max-w-[14rem] flex-1 truncate font-mono text-[11px] text-tx3 md:block">{vertexHost(line.location)}</span>
      <HealthBadge health={line.health} />
      {(line.health.lastError || line.health.missingModels.length > 0) && (
        <p className="basis-full pl-7 text-[11px] text-tx3">{healthDetail(line.health)}</p>
      )}
    </div>
  );
}

function BackupLines({ provider, reload }: { provider: AdminProvider; reload(): Promise<void> }) {
  const [editing, setEditing] = useState<AdminProviderEndpoint | null | undefined>(undefined);
  const [resetting, setResetting] = useState(false);
  const anyTrouble = provider.health.state !== 'ok'
    || provider.vertexLines.some((l) => l.health.state !== 'ok')
    || provider.endpoints.some((e) => e.health.state !== 'ok');
  const usesVertex = provider.type === 'gemini' && provider.useVertex;
  const firstLocation = parseLocations(provider.vertexLocation)[0] ?? 'global';

  async function resetHealth() {
    if (resetting) return;
    setResetting(true);
    try {
      await api.post(`/api/admin/providers/${provider.id}/health/reset`);
      toast(t('已重置线路状态'), 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setResetting(false); }
  }

  return (
    <div className="space-y-2 rounded-lg border border-line bg-bg2/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-tx">{t('备用线路')}</span>
        <span className="text-[11px] text-tx3">
          {t('主线路连续失败 {n} 次后暂停 {seconds} 秒,按顺序改走下面的线路', { n: provider.failoverThreshold, seconds: provider.failoverCooldownSeconds })}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {anyTrouble && (
            <Button variant="outline" size="sm" disabled={resetting} onClick={resetHealth}>
              {resetting ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw size={13} />}{t('重置状态')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
            <Plus size={13} />{t('添加线路')}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-bg1 px-2.5 py-2">
        <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-tx3">1</span>
        <StatusDot tone={provider.health.state === 'ok' ? 'ok' : provider.health.state === 'open' ? 'err' : 'warn'} />
        <span className="text-xs font-medium text-tx">{tServer(provider.primaryLineName)}</span>
        {provider.primaryLineName !== '主线路' && <Badge>{t('主')}</Badge>}
        {usesVertex && provider.vertexPriority === 'always' && ['global', 'us', 'eu'].includes(firstLocation) && <Badge tone="warn">{t('加价')}</Badge>}
        <span className="hidden min-w-0 max-w-[14rem] flex-1 truncate font-mono text-[11px] text-tx3 md:block">
          {usesVertex ? (provider.baseUrl || vertexHost(firstLocation)) : (provider.baseUrl || DEFAULT_URLS[provider.type])}
        </span>
        <HealthBadge health={provider.health} />
        {(provider.health.lastError || provider.health.missingModels.length > 0) && (
          <p className="basis-full pl-7 text-[11px] text-tx3">{healthDetail(provider.health)}</p>
        )}
      </div>
      {provider.vertexLines.map((l, i) => <VertexLineRow key={l.key} line={l} position={i + 2} />)}
      {provider.endpoints.map((e, i) => (
        <EndpointRow key={e.id} endpoint={e} provider={provider} index={i} count={provider.endpoints.length}
          position={i + 2 + provider.vertexLines.length} reload={reload} onEdit={() => setEditing(e)} />
      ))}
      {usesVertex && (
        <p className="px-1 text-[11px] text-tx3">{t('Vertex 的区域顺序和 Priority PayGo 在「编辑」里设置。')}</p>
      )}
      {provider.endpoints.length === 0 && (
        <p className="px-1 text-[11px] text-tx3">
          {usesVertex
            ? t('还可以加一条 Gemini API Key(AI Studio)线路,Vertex 各区域都不可用时接替。')
            : t('还没有备用线路。加一条同类型的网关(如 LiteLLM),主线路出故障时会自动接替。')}
        </p>
      )}
      {editing !== undefined && (
        <EndpointModal key={editing?.id ?? 'new'} provider={provider} endpoint={editing}
          onClose={() => setEditing(undefined)} onSaved={reload} />
      )}
    </div>
  );
}

// ---------- fetch-models picker modal ----------
function FetchModelsModal({ provider, models, onClose, onDone }: {
  provider: AdminProvider;
  models: { id: string; name?: string }[];
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const existing = useMemo(() => new Set((provider.models ?? []).map((m) => m.modelId)), [provider]);
  const candidates = useMemo(() => models.filter((m) => !existing.has(m.id)), [models, existing]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q));
  }, [candidates, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function confirm() {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      const ids = [...selected];
      await api.post('/api/admin/models', { providerId: provider.id, models: ids.map((id) => ({ modelId: id })) });
      toast(t('已添加 {n} 个模型', { n: ids.length }), 'ok');
      await onDone();
      onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('选择要添加的模型')} wide>
      <div className="space-y-3">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索模型…')} autoFocus />
        <div className="flex items-center gap-2 text-xs text-tx3">
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set(filtered.map((m) => m.id)))}>{t('全选')}</Button>
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>{t('清空')}</Button>
          <span className="ml-auto tabular-nums">{t('共 {total} 个可添加,已选 {selected} 个', { total: candidates.length, selected: selected.size })}</span>
        </div>
        <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {filtered.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-bg2">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--color-accs)]" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="font-mono text-xs text-tx">{m.id}</span>
              {m.name && m.name !== m.id && <span className="min-w-0 truncate text-xs text-tx3">{m.name}</span>}
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-tx3">
              {candidates.length === 0 ? t('拉取到的模型均已添加') : t('没有匹配的模型')}
            </p>
          )}
        </div>
        <ModalActions>
          <Button variant="outline" onClick={onClose}>{t('取消')}</Button>
          <Button variant="primary" disabled={busy || selected.size === 0} onClick={confirm}>
            {busy && <Spinner className="h-3.5 w-3.5" />}{t('确认添加')}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ---------- model row (roster only: display name, enable, delete) ----------
function ModelRow({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(model.displayName ?? '');
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, okMsg = t('已更新')) {
    if (busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, body);
      await reload();
      toast(okMsg, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function saveName() {
    setEditingName(false);
    const v = nameVal.trim();
    if (v === (model.displayName ?? '')) return;
    await patch({ displayName: v || null }, t('已更新显示名'));
  }

  async function remove() {
    if (!(await confirmDialog(t('删除模型'), t('确定删除模型「{id}」?', { id: model.modelId })))) return;
    setBusy(true);
    try {
      await api.del(`/api/admin/models/${model.id}`);
      await reload();
      toast(t('已删除模型'), 'ok');
    } catch (e) { toast(errMsg(e), 'err'); setBusy(false); }
  }

  return (
    <tr className="group transition-colors hover:bg-bg2/60">
      <Td className="max-w-[280px] truncate font-mono text-tx">{model.modelId}</Td>
      <Td>
        {editingName ? (
          <div className="flex items-center gap-1">
            <div className="w-40">
              <Input
                value={nameVal} onChange={(e) => setNameVal(e.target.value)} autoFocus
                className="py-1 text-xs"
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
              />
            </div>
            <Button variant="ghost" size="iconXs" title={t('保存')} onClick={saveName}>
              <Check size={13} className="text-ok" />
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className={model.displayName ? '' : 'text-tx3'}>{model.displayName || '—'}</span>
            <Button variant="ghost" size="iconXs" title={t('编辑显示名')}
              onClick={() => { setNameVal(model.displayName ?? ''); setEditingName(true); }}>
              <Pencil size={12} />
            </Button>
          </span>
        )}
      </Td>
      <Td className="text-center"><Toggle checked={model.enabled} disabled={busy} onChange={(v) => patch({ enabled: v }, v ? t('已启用') : t('已停用'))} /></Td>
      <Td className="text-right">
        <Button variant="dangerGhost" size="iconXs" title={t('删除')} disabled={busy} onClick={remove}>
          <Trash2 size={13} />
        </Button>
      </Td>
    </tr>
  );
}

// ---------- provider avatar ----------
const AVATAR_MIMES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AVATAR_MAX_BYTES = 128 * 1024;

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(t('读取文件失败')));
    r.readAsDataURL(file);
  });
}

/** Click the tile to replace the mark; the ✕ restores the built-in one. */
function ProviderAvatarPicker({ provider, reload }: { provider: AdminProvider; reload(): Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function save(avatar: string | null) {
    setBusy(true);
    try {
      await api.put(`/api/admin/providers/${provider.id}/avatar`, { avatar });
      toast(avatar ? t('头像已更新') : t('已恢复默认头像'), 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!AVATAR_MIMES.includes(file.type)) { toast(t('仅支持 SVG / PNG / JPEG / WebP / GIF'), 'err'); return; }
    if (file.size > AVATAR_MAX_BYTES) { toast(t('头像不能超过 128 KB'), 'err'); return; }
    try {
      await save(await readAsDataUri(file));
    } catch (err) { toast(errMsg(err), 'err'); }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title={t('点击上传自定义头像')}
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="cursor-pointer rounded-lg transition-opacity hover:opacity-70 disabled:opacity-40"
      >
        {busy
          ? <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line2 bg-bg2 text-tx3"><Spinner className="h-3.5 w-3.5" /></span>
          : <ProviderAvatar name={provider.name} type={provider.type} baseUrl={provider.baseUrl}
              avatarUrl={provider.avatarUrl} size={32} />}
      </button>
      {provider.avatarUrl && !busy && (
        <button
          type="button"
          title={t('恢复默认头像')}
          onClick={() => save(null)}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-line bg-bg1 text-tx3 shadow-sm transition-colors hover:border-err/50 hover:text-err"
        >
          <X size={9} />
        </button>
      )}
      <input ref={fileRef} type="file" hidden accept={AVATAR_MIMES.join(',')} onChange={pick} />
    </div>
  );
}

// ---------- provider card (collapsed by default) ----------
function ProviderCard({ provider, reload, onEdit }: {
  provider: AdminProvider; reload(): Promise<void>; onEdit(): void;
}) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<{ id: string; name?: string }[] | null>(null);
  const [manualId, setManualId] = useState('');
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState(false);
  const models = provider.models ?? [];
  const enabledCount = models.filter((m) => m.enabled).length;
  // Vertex authenticates with a service account, so "no API key" is its
  // normal, healthy state — judge it by the credential it actually uses.
  const usesVertex = provider.type === 'gemini' && provider.useVertex;
  const local = provider.type === 'claude-code';
  const hasCred = local || (usesVertex ? provider.hasVertexSa : provider.hasKey);

  async function setEnabled(v: boolean) {
    if (toggling) return;
    setToggling(true);
    try {
      await api.patch(`/api/admin/providers/${provider.id}`, { enabled: v });
      toast(v ? t('已启用') : t('已禁用'), 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setToggling(false); }
  }

  async function test() {
    if (testing) return;
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; models?: { id: string; name?: string }[]; error?: string }>(
        `/api/admin/providers/${provider.id}/test`,
      );
      if (r.ok) toast(t('连接成功,发现 {n} 个模型', { n: Array.isArray(r.models) ? r.models.length : 0 }), 'ok');
      else toast(r.error ? tServer(r.error) : t('连接失败'), 'err');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setTesting(false); }
  }

  async function remove() {
    if (!(await confirmDialog(t('删除 Provider'), t('确定删除「{name}」?其下所有模型将一并删除。', { name: provider.name })))) return;
    try {
      await api.del(`/api/admin/providers/${provider.id}`);
      toast(t('已删除 Provider'), 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function fetchModels() {
    if (fetching) return;
    setFetching(true);
    try {
      const r = await api.post<{ ok: boolean; models?: { id: string; name?: string }[]; error?: string }>(
        `/api/admin/providers/${provider.id}/fetch-models`,
      );
      if (r.ok) setFetched(Array.isArray(r.models) ? r.models : []);
      else toast(r.error ? tServer(r.error) : t('拉取失败'), 'err');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setFetching(false); }
  }

  async function addManual() {
    const id = manualId.trim();
    if (!id || adding) return;
    if (models.some((m) => m.modelId === id)) { toast(t('该模型已存在'), 'err'); return; }
    setAdding(true);
    try {
      await api.post('/api/admin/models', { providerId: provider.id, models: [{ modelId: id }] });
      toast(t('已添加 {id}', { id }), 'ok');
      setManualId('');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setAdding(false); }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-bg1 shadow-xs">
      {/* Whole header toggles the fold; the interactive bits stop propagation. */}
      <div
        className={`flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 transition-colors hover:bg-bg2/40 ${open ? 'border-b border-line' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={15} className={`shrink-0 text-tx3 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div onClick={(e) => e.stopPropagation()}>
          <ProviderAvatarPicker provider={provider} reload={reload} />
        </div>
        <StatusDot tone={!provider.enabled ? 'idle' : hasCred ? 'ok' : 'warn'} />
        <span className="text-[13px] font-semibold text-tx">{provider.name}</span>
        <Badge>{TYPE_LABELS[provider.type]}</Badge>
        {usesVertex && <Badge>Vertex</Badge>}
        {provider.enabled && provider.endpoints.length + provider.vertexLines.length > 0 && (
          provider.health.state === 'open' || provider.health.state === 'probing'
            ? <Badge tone="err">{t('主线路熔断 · 走备用')}</Badge>
            : provider.endpoints.some((e) => e.enabled) || provider.vertexLines.length > 0
              ? <Badge tone="acc">{t('{n} 条备用线路', { n: provider.endpoints.filter((e) => e.enabled).length + provider.vertexLines.length })}</Badge>
              : null
        )}
        {/* Phones keep only name/type/toggle in the header — the status dot
            already encodes the credential state the hidden badge spells out. */}
        <span className="hidden min-w-0 max-w-[16rem] flex-1 truncate font-mono text-[11px] text-tx3 md:block" title={provider.baseUrl || DEFAULT_URLS[provider.type]}>
          {usesVertex
            ? (provider.baseUrl || parseLocations(provider.vertexLocation).map(vertexHost)[0] || vertexHost('global'))
            : (provider.baseUrl || DEFAULT_URLS[provider.type])}
        </span>
        <span className="hidden text-[11px] tabular-nums text-tx3 sm:inline">{t('{total} 个模型 · {enabled} 已启用', { total: models.length, enabled: enabledCount })}</span>
        <span className="hidden sm:contents">
          {local ? <Badge tone="warn">{t('仅管理员')}</Badge> : (
            <Badge tone={hasCred ? 'ok' : 'err'}>
              {usesVertex ? (hasCred ? t('已配置凭证') : t('未配置凭证')) : (hasCred ? t('已配置 Key') : t('未配置 Key'))}
            </Badge>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Toggle checked={provider.enabled} disabled={toggling} onChange={setEnabled} />
        </div>
      </div>

      {open && (
        <div className="space-y-3 px-4 py-3">
          {/* Two deliberate rows at every width — a single flex-wrap row used
              to shatter into three ragged lines on phones. */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={fetchModels} disabled={fetching}>
                {fetching ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />}{t('拉取模型列表')}
              </Button>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={test} disabled={testing}>
                  {testing ? <Spinner className="h-3.5 w-3.5" /> : <FlaskConical size={13} />}{t('测试')}
                </Button>
                <Button variant="ghost" size="iconSm" title={t('编辑')} onClick={onEdit}><Pencil size={14} /></Button>
                <Button variant="dangerGhost" size="iconSm" title={t('删除')} onClick={remove}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); addManual(); }}>
              <div className="min-w-0 flex-1 sm:max-w-[16rem]">
                <Input value={manualId} onChange={(e) => setManualId(e.target.value)}
                  placeholder={t('手动输入模型 ID')} uiSize="sm" className="text-xs" />
              </div>
              <Button variant="outline" size="sm" type="submit" className="shrink-0" disabled={adding || !manualId.trim()}>
                {adding ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={13} />}{t('手动添加')}
              </Button>
            </form>
          </div>

          {models.length === 0 ? (
            <p className="rounded-md border border-dashed border-line2 px-3 py-4 text-center text-xs text-tx3">
              {t('尚未添加模型 — 点击「拉取模型列表」或手动输入模型 ID')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <Th>{t('模型 ID')}</Th>
                    <Th>{t('显示名')}</Th>
                    <Th className="text-center">{t('启用@@state')}</Th>
                    <Th className="text-right">{t('删除')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => <ModelRow key={m.id} model={m} reload={reload} />)}
                </tbody>
              </table>
            </div>
          )}

          {!local && provider.type !== 'novelai' && <BackupLines provider={provider} reload={reload} />}

          <p className="text-[11px] leading-relaxed text-tx3">
            {t('视觉/工具/推理等能力与可见性在')}<Link to="/admin/models" className="mx-0.5 text-acc hover:underline">{t('模型设置')}</Link>{t('配置;选择器中的显示顺序在')}<Link to="/admin/model-order" className="mx-0.5 text-acc hover:underline">{t('模型排序')}</Link>{t('调整。')}
          </p>
        </div>
      )}

      {fetched !== null && (
        <FetchModelsModal provider={provider} models={fetched} onClose={() => setFetched(null)} onDone={reload} />
      )}
    </div>
  );
}

// ---------- page ----------
export default function Providers() {
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProvider | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<AdminProvider[] | { providers?: AdminProvider[] }>('/api/admin/providers');
      setProviders(Array.isArray(r) ? r : r.providers ?? []);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight text-tx">{t('模型服务')}</h1>
          <p className="mt-0.5 text-xs leading-relaxed text-tx3">
            {t('管理 AI 提供商接入。点击卡片展开模型列表,在这里添加模型、设置显示名与启用状态。')}
          </p>
        </div>
        <Button variant="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus size={15} />{t('添加 Provider')}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-line bg-bg1 shadow-xs">
          <EmptyState
            icon={<Server size={22} />}
            title={t('还没有配置模型服务')}
            hint={t('接入 OpenAI 兼容、Anthropic 或 Google Gemini 服务后,即可在对话中选择模型。')}
            action={(
              <Button variant="primary" size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus size={14} />{t('添加 Provider')}
              </Button>
            )}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} reload={load}
              onEdit={() => { setEditing(p); setFormOpen(true); }} />
          ))}
        </div>
      )}

      {formOpen && (
        <ProviderModal
          key={editing?.id ?? 'new'}
          provider={editing}
          onClose={() => setFormOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
