import { useEffect, useRef, useState } from 'react';
import { Check, Code, Copy, Download, Eye } from 'lucide-react';
import { useUi } from '../store';

/**
 * ```mermaid fences render as a diagram. The library is ~2 MB, so it loads on
 * first use only; until then (and while the source is still streaming in) the
 * block shows the code, and a diagram that fails to parse falls back to the
 * code with the parser's message — half-typed diagrams during streaming are
 * expected to fail, so the error is quiet, not red.
 */

type MermaidApi = typeof import('mermaid').default;
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default);
  }
  return mermaidPromise;
}

let seq = 0;

const headBtn = 'flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx2 transition-colors hover:bg-bg3 hover:text-tx';

export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const theme = useUi((s) => s.theme);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const idRef = useRef(`mmd-${++seq}`);

  useEffect(() => {
    if (!code.trim()) return;
    let cancelled = false;
    // Streaming: wait for the source to settle before spending a parse on it.
    const t = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          theme: theme === 'dark' ? 'dark' : 'default',
          // strict = sanitised SVG, no click handlers / scripts from the model.
          securityLevel: 'strict',
          fontFamily: 'inherit',
        });
        // parse() throws on syntax errors without touching the DOM.
        await mermaid.parse(code);
        const r = await mermaid.render(`${idRef.current}-${Date.now()}`, code);
        if (cancelled) return;
        setSvg(r.svg);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }, streaming ? 600 : 50);
    return () => { cancelled = true; clearTimeout(t); };
  }, [code, theme, streaming]);

  const ready = svg !== null && !error;
  const showDiagram = ready && !showCode;

  function download() {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'diagram.svg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>mermaid</span>
        <div className="flex items-center">
          {ready && (
            <button className={headBtn} onClick={() => setShowCode((v) => !v)}>
              {showCode ? <Eye size={12} /> : <Code size={12} />}
              {showCode ? '图表' : '代码'}
            </button>
          )}
          {ready && (
            <button className={headBtn} title="下载 SVG" onClick={download}>
              <Download size={12} />
            </button>
          )}
          <button
            className={headBtn}
            onClick={() => {
              navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      {showDiagram ? (
        <div
          className="mermaid-host overflow-x-auto bg-bg1 px-4 py-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      ) : (
        <>
          <pre><code>{code}</code></pre>
          {error && !streaming && (
            <div className="border-t border-line bg-bg2/60 px-3 py-1.5 text-[11px] leading-relaxed text-tx3">
              图表未能渲染:{error.split('\n')[0].slice(0, 200)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
