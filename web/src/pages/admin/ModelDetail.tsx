import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronUp, Plus, Upload, X } from 'lucide-react';
import { api, errMsg } from '../../api';
import {
  Badge, Button, Card, EmptyState, Field, Input, SegmentedControl, Spinner, Textarea, toast,
} from '../../components/ui';
import { ProviderAvatar } from '../../components/ModelAvatar';
import type { AdminModel, AdminProvider, ReasoningLevel, ReasoningMode } from '../../types';
import { TYPE_LABELS } from './provider-common';

/* The per-model drill-down. The list page keeps the toggles an admin flips in
   passing; anything that needs a form — the user-facing blurb, the reasoning
   ladder, and whatever detail settings come next — lives here. */

const MODE_LABELS: Record<ReasoningMode, string> = { auto: '默认', custom: '自定义', off: '关闭' };
const DESCRIPTION_MAX = 500;

// ---------- 模型图标 ----------
const ICON_MIMES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ICON_MAX_BYTES = 128 * 1024;

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/** The model's own icon when set, else the provider avatar / brand mark. */
function ModelIcon({ provider, model, size }: {
  provider: AdminProvider; model: AdminModel; size: number;
}) {
  if (!model.avatarUrl) {
    return <ProviderAvatar name={provider.name} type={provider.type} baseUrl={provider.baseUrl}
      avatarUrl={provider.avatarUrl} size={size} />;
  }
  const inner = Math.round(size * 0.62);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line2 bg-bg2 shadow-xs"
      style={{ width: size, height: size }}
    >
      {/* <img>, never inlined — an uploaded SVG must not get a script context. */}
      <img src={model.avatarUrl} alt="" className="object-contain" style={{ width: inner, height: inner }} />
    </span>
  );
}

function IconCard({ provider, model, reload }: {
  provider: AdminProvider; model: AdminModel; reload(): Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function save(avatar: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      await api.put(`/api/admin/models/${model.id}/avatar`, { avatar });
      toast(avatar ? '模型图标已更新' : '已恢复默认图标', 'ok');
      await reload();
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ICON_MIMES.includes(file.type)) { toast('仅支持 SVG / PNG / JPEG / WebP / GIF', 'err'); return; }
    if (file.size > ICON_MAX_BYTES) { toast('图标不能超过 128 KB', 'err'); return; }
    try {
      await save(await readAsDataUri(file));
    } catch (err) { toast(errMsg(err), 'err'); }
  }

  return (
    <Card title="模型图标"
      desc="推荐 SVG(也支持 PNG / JPEG / WebP / GIF,不超过 128 KB)。上传后模型选择器、对话页与新对话首页都优先显示它;未上传时沿用 Provider 头像或内置品牌图标。">
      <div className="flex items-center gap-4">
        {busy ? (
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-line2 bg-bg2 text-tx3">
            <Spinner className="h-4 w-4" />
          </span>
        ) : (
          <ModelIcon provider={provider} model={model} size={56} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={13} />上传图标
          </Button>
          {model.avatarUrl && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => save(null)}>
              <X size={13} />恢复默认
            </Button>
          )}
        </div>
      </div>
      <input ref={fileRef} type="file" hidden accept={ICON_MIMES.join(',')} onChange={pick} />
    </Card>
  );
}

// ---------- 模型描述 ----------
/** The blurb users see under the model name when starting a new chat. */
function DescriptionCard({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [text, setText] = useState(model.description ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = (text.trim() || null) !== (model.description ?? null);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, { description: text.trim() || null });
      await reload();
      toast('已更新模型描述', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="模型描述" desc="展示给用户:出现在新对话首页的模型名称下方。留空则不显示。">
      <div className="space-y-3">
        <Textarea
          rows={3}
          maxLength={DESCRIPTION_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例如:现在世界上最强的模型,但是很贵"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] tabular-nums text-tx3">{text.length}/{DESCRIPTION_MAX}</span>
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={save}>
            {busy && <Spinner className="h-3.5 w-3.5" />}保存描述
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------- 单价 ----------
/** Per-1M-token prices powering the 用量看板 cost columns. Empty = not priced. */
function PricingCard({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const [input, setInput] = useState(model.inputPrice != null ? String(model.inputPrice) : '');
  const [output, setOutput] = useState(model.outputPrice != null ? String(model.outputPrice) : '');
  const [busy, setBusy] = useState(false);

  const parse = (v: string): number | null | undefined => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : undefined; // undefined = invalid
  };
  const dirty = (parse(input) ?? null) !== (model.inputPrice ?? null)
    || (parse(output) ?? null) !== (model.outputPrice ?? null);

  async function save() {
    if (busy) return;
    const inputPrice = parse(input);
    const outputPrice = parse(output);
    if (inputPrice === undefined || outputPrice === undefined) {
      toast('单价必须是不小于 0 的数字,留空表示未配置', 'err');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, { inputPrice, outputPrice });
      await reload();
      toast('已更新模型单价', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Card
      title="模型单价"
      desc="每 100 万 tokens 的价格,用于用量看板的成本折算(按当前单价估算历史用量)。货币符号在「应用设置 → 成本治理」配置。两项都留空 = 不参与成本统计。"
    >
      <div className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="输入单价 / 1M tokens">
            <Input
              inputMode="decimal" value={input} placeholder="未配置"
              onChange={(e) => setInput(e.target.value)}
            />
          </Field>
          <Field label="输出单价 / 1M tokens">
            <Input
              inputMode="decimal" value={output} placeholder="未配置"
              onChange={(e) => setOutput(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={save}>
            {busy && <Spinner className="h-3.5 w-3.5" />}保存单价
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------- 推理档位 ----------
/**
 * Levels default to the vendor's common tiers, derived from the model id, and
 * reach the user in Chinese. Custom is there for the week a vendor ships a tier
 * we have never heard of — which is why it takes both halves: the name the API
 * expects and the one a person can read.
 */
function ReasoningCard({ model, reload }: { model: AdminModel; reload(): Promise<void> }) {
  const { mode: savedMode, custom, defaults } = model.reasoning;
  const [mode, setMode] = useState<ReasoningMode>(savedMode);
  // Seed the editor with whatever is already in effect, so picking 自定义 is an
  // edit rather than a blank page.
  const [rows, setRows] = useState<ReasoningLevel[]>(() => {
    const seed = custom.length ? custom : defaults;
    return seed.length ? seed : [{ value: '', label: '' }];
  });
  const [busy, setBusy] = useState(false);

  const filled = rows.filter((r) => r.value.trim());
  const setRow = (i: number, patch: Partial<ReasoningLevel>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(i, 1);
    next.splice(i + dir, 0, row);
    setRows(next);
  };

  async function save() {
    if (busy) return;
    if (mode === 'custom' && !filled.length) { toast('请至少填写一个档位', 'err'); return; }
    setBusy(true);
    try {
      await api.patch(`/api/admin/models/${model.id}`, {
        reasoningMode: mode,
        // Only send the ladder when it is the one in use — otherwise a stray
        // half-typed row would overwrite what is saved.
        ...(mode === 'custom' ? { reasoningLevels: filled } : {}),
      });
      await reload();
      toast('已更新推理档位', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="推理档位" desc="决定聊天页「推理强度」菜单里的选项,以及发送给服务端的值。">
      <div className="space-y-4">
        <SegmentedControl<ReasoningMode>
          value={mode}
          onChange={setMode}
          options={(['auto', 'custom', 'off'] as const).map((m) => ({ value: m, label: MODE_LABELS[m] }))}
        />

        {mode === 'auto' && (defaults.length ? (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-tx3">按该模型所属系列的常见档位自动设置,用户端显示中文。</p>
            <div className="flex flex-wrap gap-1.5">
              {defaults.map((l) => (
                <Badge key={l.value}>{l.label}<span className="font-mono text-tx3">{l.value}</span></Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-tx3">
            未识别到该模型的推理档位,聊天页不会显示推理强度。如果它其实支持,改用「自定义」填写即可。
          </p>
        ))}

        {mode === 'custom' && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-tx3">
              从弱到强排列。左侧是发送给服务端的值(OpenAI 会原样作为 <span className="font-mono">reasoning_effort</span> 发出),
              右侧是用户看到的名称,留空则自动取常见档位的中文名。
            </p>
            <div className="flex gap-2 pr-[4.5rem] text-[11px] text-tx3">
              <span className="flex-1">值(英文)</span>
              <span className="flex-1">显示名</span>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={r.value} placeholder="xhigh" uiSize="sm" className="flex-1 font-mono text-xs"
                  onChange={(e) => setRow(i, { value: e.target.value })}
                />
                <Input
                  value={r.label} placeholder="留空自动" uiSize="sm" className="flex-1 text-xs"
                  onChange={(e) => setRow(i, { label: e.target.value })}
                />
                <div className="flex shrink-0">
                  <Button variant="ghost" size="iconXs" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ChevronUp size={13} />
                  </Button>
                  <Button variant="ghost" size="iconXs" title="下移" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                    <ChevronDown size={13} />
                  </Button>
                  <Button variant="dangerGhost" size="iconXs" title="删除此档位"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <X size={13} />
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex gap-2 pt-0.5">
              <Button variant="outline" size="sm" onClick={() => setRows([...rows, { value: '', label: '' }])}>
                <Plus size={13} />添加档位
              </Button>
              {defaults.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setRows(defaults)}>填入默认档位</Button>
              )}
            </div>
          </div>
        )}

        {mode === 'off' && (
          <p className="text-xs leading-relaxed text-tx3">
            视为该模型没有推理模式:聊天页隐藏推理强度,请求里也不会带上这个字段。
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="primary" size="sm" disabled={busy} onClick={save}>
            {busy && <Spinner className="h-3.5 w-3.5" />}保存推理档位
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------- page ----------
export default function ModelDetail() {
  const { id } = useParams<{ id: string }>();
  const [found, setFound] = useState<{ provider: AdminProvider; model: AdminModel } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.get<AdminProvider[] | { providers?: AdminProvider[] }>('/api/admin/providers');
      const providers = Array.isArray(r) ? r : r.providers ?? [];
      for (const provider of providers) {
        const model = (provider.models ?? []).find((m) => m.id === id);
        if (model) { setFound({ provider, model }); return; }
      }
      setFound(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex justify-center py-16 text-tx3"><Spinner className="h-6 w-6" /></div>;
  }
  if (!found) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <EmptyState
          title="模型不存在"
          hint="它可能已被删除。"
          action={<Link to="/admin/models"><Button variant="outline" size="sm">返回模型设置</Button></Link>}
        />
      </div>
    );
  }

  const { provider, model } = found;
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div className="space-y-3">
        <Link to="/admin/models"
          className="inline-flex items-center gap-1 text-xs text-tx3 transition-colors hover:text-tx">
          <ArrowLeft size={13} />返回模型设置
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <ModelIcon provider={provider} model={model} size={40} />
          <div className="min-w-0">
            <h1 className="truncate font-mono text-base font-semibold tracking-tight text-tx">{model.modelId}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-tx3">
              {model.displayName && <span className="text-tx2">{model.displayName}</span>}
              <Badge>{provider.name} · {TYPE_LABELS[provider.type]}</Badge>
              {model.isDefault && <Badge tone="acc">默认模型</Badge>}
              {model.enabled ? <Badge tone="ok">启用中</Badge> : <Badge>已停用</Badge>}
            </div>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-tx3">
          能力开关、默认联网、可见性等基础项仍在模型设置列表页;这里放需要展开编辑的详细配置。
        </p>
      </div>

      <IconCard provider={provider} model={model} reload={load} />
      <DescriptionCard model={model} reload={load} />
      <PricingCard model={model} reload={load} />
      <ReasoningCard model={model} reload={load} />
    </div>
  );
}
