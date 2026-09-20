import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanelLeft, ScanText, Upload, X, Copy, Check, Download, Square, FileText, Image as ImageIcon, Eye, Code,
} from 'lucide-react';
import { useAuth, useModels, useUi } from '../store';
import { streamSse, uploadFile, fmtDuration, fmtTokens } from '../api';
import {
  Button, Card, Field, Select, Spinner, PageHeader, EmptyState, SegmentedControl, toast,
} from '../components/ui';
import { Markdown } from '../components/Markdown';

/* OCR 工坊 — drop PDFs / images, get one continuous text or Markdown document
   back. Files stay local until 开始识别 (uploaded per run and deleted by the
   server afterwards), so re-running with another format is just another
   upload. Gemini-only by design: see server/src/routes/ocr.ts. */

const MAX_TOTAL_MB = 20;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';

type Format = 'text' | 'markdown';

function fmtBytes(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isAcceptable(f: File): boolean {
  return f.type.startsWith('image/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

export default function Ocr() {
  const maxFiles = useAuth((s) => s.bootstrap?.maxAttachmentsPerMessage ?? 20);
  const { sidebarOpen, setSidebarOpen } = useUi();
  const { models: allModels, loaded, load } = useModels();
  useEffect(() => { void load(); }, [load]);

  // Gemini takes PDFs natively; nothing else qualifies without pre-processing.
  const models = useMemo(
    () => allModels.filter((m) => m.providerType === 'gemini' && m.vision && !m.imageGen),
    [allModels],
  );
  const [modelId, setModelId] = useState('');
  useEffect(() => {
    if (!models.length) return;
    if (!models.some((m) => m.id === modelId)) setModelId((models.find((m) => m.isDefault) ?? models[0]).id);
  }, [models, modelId]);

  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<Format>('text');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<'upload' | 'ocr'>('upload');
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ totalTokens: number; durationMs: number } | null>(null);
  const [preview, setPreview] = useState(true);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    const rejected = incoming.filter((f) => !isAcceptable(f));
    if (rejected.length) toast(`已跳过 ${rejected.length} 个非图片/PDF 文件`, 'err');
    setFiles((prev) => {
      const next = [...prev];
      for (const f of incoming.filter(isAcceptable)) {
        if (next.length >= maxFiles) { toast(`最多 ${maxFiles} 个文件`, 'err'); break; }
        if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
        next.push(f);
      }
      return next;
    });
  }

  async function run() {
    if (running || !files.length || !modelId) return;
    if (files.length > maxFiles) { toast(`最多 ${maxFiles} 个文件,请移除多余附件`, 'err'); return; }
    if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) {
      toast(`附件总大小不能超过 ${MAX_TOTAL_MB} MB`, 'err');
      return;
    }
    setRunning(true); setPhase('upload'); setResult(''); setError(null); setStats(null); setElapsed(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const uploadIds: string[] = [];
      for (const f of files) {
        if (ctrl.signal.aborted) return;
        uploadIds.push((await uploadFile(f)).id);
      }
      setPhase('ocr');
      let text = '';
      let status = 'done';
      await streamSse('/api/ocr/stream', { modelId, uploadIds, format }, (event, data) => {
        if (event === 'delta') { text += data.text ?? ''; setResult(text); }
        else if (event === 'usage') setStats({ totalTokens: data.totalTokens ?? 0, durationMs: data.durationMs ?? 0 });
        else if (event === 'error') setError(data.message ?? '识别失败');
        else if (event === 'done') status = data.status ?? 'done';
      }, ctrl.signal);
      if (status === 'stopped' && !ctrl.signal.aborted) toast('输出已达上限,结果可能不完整', 'err');
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : '识别失败');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() { abortRef.current?.abort(); }

  async function copy() {
    await navigator.clipboard.writeText(result);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }

  function download() {
    const ext = format === 'markdown' ? 'md' : 'txt';
    const base = (files[0]?.name.replace(/\.[^.]+$/, '') || 'ocr').slice(0, 60);
    const blob = new Blob([result], { type: format === 'markdown' ? 'text/markdown' : 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${base}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const canRun = files.length > 0 && !!modelId && !running;

  return (
    <div className="contents">
      <PageHeader
        title="OCR 工坊"
        subtitle="PDF 与图片转文字:输出连续全文,不分页、不带页码"
        left={!sidebarOpen && (
          <Button variant="ghost" size="icon" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={16} />
          </Button>
        )}
      />

      <div className="flex-1 overflow-y-auto bg-bg0">
        <div className="mx-auto max-w-5xl space-y-5 p-6">
          <Card title="识别文件" desc={`支持 PDF、PNG、JPG、WebP、GIF,最多 ${maxFiles} 个文件、共 ${MAX_TOTAL_MB} MB。文件仅用于本次识别,完成后即从服务器删除。`}
            flush={loaded && models.length === 0}>
            {!loaded ? (
              <div className="flex justify-center py-10 text-tx3"><Spinner className="h-5 w-5" /></div>
            ) : models.length === 0 ? (
              <EmptyState
                icon={<ScanText size={22} />}
                title="没有可用的 Gemini 视觉模型"
                hint="OCR 需要 Gemini 系列的视觉模型(它能直接读取 PDF,无需预处理)。请联系管理员在后台添加 Gemini Provider 并开放模型。"
              />
            ) : (
              <div className="space-y-4">
                <div
                  className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
                    dragging ? 'border-acc bg-acc/5' : 'border-line hover:border-line2 hover:bg-bg2/40'}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                >
                  <Upload size={20} className="text-tx3" />
                  <p className="text-sm text-tx2">拖放文件到这里,或点击选择</p>
                  <p className="text-xs text-tx3">扫描件、截图、拍照的文档都可以</p>
                  <input ref={fileRef} type="file" hidden multiple accept={ACCEPT}
                    onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                </div>

                {files.length > 0 && (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {files.map((f, i) => (
                      <li key={`${f.name}-${f.size}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                        {f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
                          ? <FileText size={15} className="shrink-0 text-tx3" />
                          : <ImageIcon size={15} className="shrink-0 text-tx3" />}
                        <span className="min-w-0 flex-1 truncate text-tx">{f.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-tx3">{fmtBytes(f.size)}</span>
                        <button title="移除" disabled={running}
                          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-tx3 transition-colors hover:bg-bg2 hover:text-tx disabled:opacity-40"
                          onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <Field label="模型" hint="仅列出 Gemini 系列视觉模型">
                      <Select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={running}>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>{`${m.displayName || m.modelId} · ${m.providerName}`}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="输出格式">
                    <SegmentedControl<Format>
                      value={format}
                      onChange={setFormat}
                      options={[{ value: 'text', label: '纯文本' }, { value: 'markdown', label: 'Markdown' }]}
                    />
                  </Field>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-xs leading-relaxed text-tx3">
                    跨页内容会自动衔接为完整段落;多个文件按列表顺序连续输出。识别用量计入你的 token 配额。
                  </p>
                  {running ? (
                    <Button variant="outline" onClick={stop} className="shrink-0">
                      <Square size={12} fill="currentColor" />停止 {elapsed.toFixed(1)}s
                    </Button>
                  ) : (
                    <Button variant="primary" disabled={!canRun} onClick={run} className="shrink-0">
                      <ScanText size={15} />开始识别
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Card>

          {(running || result || error) && (
            <Card
              title="识别结果"
              desc={running
                ? phase === 'upload' ? '正在上传文件…' : '正在识别,文字会边识别边显示…'
                : stats ? `${fmtTokens(stats.totalTokens)} tokens · ${fmtDuration(stats.durationMs)}` : undefined}
              actions={result ? (
                <div className="flex items-center gap-1">
                  {format === 'markdown' && (
                    <Button variant="ghost" size="sm" title={preview ? '查看 Markdown 源码' : '预览渲染效果'}
                      onClick={() => setPreview(!preview)}>
                      {preview ? <Code size={14} /> : <Eye size={14} />}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" title="复制全文" onClick={copy}>
                    {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                  </Button>
                  <Button variant="ghost" size="sm" title={`下载 .${format === 'markdown' ? 'md' : 'txt'}`} onClick={download}>
                    <Download size={14} />
                  </Button>
                </div>
              ) : undefined}
            >
              {error && (
                <div className="mb-3 whitespace-pre-wrap rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">
                  识别失败:{error}
                </div>
              )}
              {running && !result && !error && (
                <div className="flex items-center gap-2 py-6 text-sm text-tx3"><Spinner className="h-4 w-4" />{phase === 'upload' ? '上传中' : '识别中'}…</div>
              )}
              {result && (
                format === 'markdown' && preview
                  ? <Markdown text={result} />
                  : <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-tx">{result}</pre>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
