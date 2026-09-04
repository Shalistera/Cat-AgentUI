import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Code, Copy, LayoutTemplate, PanelRight, RotateCw } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import { useComposerInsert, useHtmlPreview, useUi, type Theme } from '../store';
import { toast } from './ui';

/**
 * 互动画布 (experimental). With settings.canvasAnswers on, the model keeps
 * answering in Markdown and adds one ```html component when seeing beats
 * reading (CANVAS_PROMPT in server chats.ts); every ```html fence in an
 * assistant reply renders here as a live, sandboxed iframe instead of a code
 * block.
 *
 * The sandbox has no allow-same-origin, so the parent cannot measure the
 * document. Instead a script we append posts the page height up; the parent
 * only trusts messages whose source is this very frame, and clamps the value.
 * The same channel carries sendPrompt(text) — claude.ai's click-to-follow-up —
 * which lands in the composer rather than sending, so a page can never fire
 * messages on its own.
 */

const SIZE_MSG = 'caui-canvas-size';
const PROMPT_MSG = 'caui-canvas-prompt';
const PROMPT_MAX = 2000;
const MIN_H = 96;
const MAX_H = 1600; // taller pages scroll inside the frame
const INITIAL_H = 320;

// Tokens promised to the model by CANVAS_PROMPT, resolved from the live theme
// so an edit to index.css flows through without touching the prompt.
const TOKEN_MAP: [string, string][] = [
  ['--bg', '--color-bg1'], ['--bg2', '--color-bg2'], ['--fg', '--color-tx'], ['--muted', '--color-tx3'],
  ['--line', '--color-line'], ['--accent', '--color-acc'],
  ['--ok', '--color-ok'], ['--warn', '--color-warn'], ['--err', '--color-err'],
];

function themePrelude(theme: Theme): string {
  const root = getComputedStyle(document.documentElement);
  const vars = TOKEN_MAP.map(([name, src]) => `${name}:${root.getPropertyValue(src).trim() || 'inherit'}`).join(';');
  const font = getComputedStyle(document.body).fontFamily.replace(/[<>]/g, '');
  return `<meta name="color-scheme" content="${theme}">`
    + `<style>:root{${vars};--font:${font}}`
    + 'html{background:var(--bg);color:var(--fg);font-family:var(--font)}'
    // Height must come from content: a 100vh body and the frame that sizes to
    // it would otherwise chase each other upwards.
    + 'html,body{height:auto!important;min-height:0!important}</style>'
    + `<script>document.documentElement.dataset.theme=${JSON.stringify(theme)};`
    // sendPrompt: promised to the model by CANVAS_PROMPT.
    + `window.sendPrompt=function(t){parent.postMessage({type:'${PROMPT_MSG}',text:String(t==null?'':t).slice(0,${PROMPT_MAX})},'*')};</script>`;
}

// Appended after the document: the parser hoists it into <body>, so it runs
// after the page's own scripts. Observes both html and body because a page
// that pins one of them still grows through the other.
const SIZE_SCRIPT = '<script>(function(){var last=0;'
  + 'function post(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);'
  + `if(h>0&&Math.abs(h-last)>1){last=h;parent.postMessage({type:'${SIZE_MSG}',height:h},'*');}}`
  + 'var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);'
  + 'addEventListener(\'load\',post);setTimeout(post,50);setTimeout(post,600);setTimeout(post,2500);})();</script>';

/** The model's page plus our prelude (theme tokens) and the sizing script. */
export function themedCanvasDoc(code: string, theme: Theme): string {
  const prelude = themePrelude(theme);
  const head = /<head[^>]*>/i.exec(code);
  let doc: string;
  if (head) {
    const at = head.index + head[0].length;
    doc = code.slice(0, at) + prelude + code.slice(at);
  } else {
    const html = /<html[^>]*>/i.exec(code);
    if (html) {
      const at = html.index + html[0].length;
      doc = code.slice(0, at) + `<head>${prelude}</head>` + code.slice(at);
    } else {
      // The normal case now (CANVAS_PROMPT asks for fragments): give it a
      // document so the tokens apply, and a little breathing room.
      doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${prelude}</head><body style="margin:0;padding:12px 16px">${code}</body></html>`;
    }
  }
  return doc + SIZE_SCRIPT;
}

const headBtn = 'flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx2 transition-colors hover:bg-bg3 hover:text-tx';

export function CanvasAnswer({ code, streaming }: { code: string; streaming: boolean }) {
  const theme = useUi((s) => s.theme);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [height, setHeight] = useState(INITIAL_H);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Frozen while the fence is still being written: mounting a half-typed page
  // on every token would be noise, and the placeholder below says what's up.
  const src = useMemo(() => (streaming ? null : themedCanvasDoc(code, theme)), [code, theme, streaming]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const data = e.data as { type?: unknown; height?: unknown; text?: unknown } | null;
      if (!data) return;
      if (data.type === SIZE_MSG && typeof data.height === 'number' && Number.isFinite(data.height)) {
        setHeight(Math.min(MAX_H, Math.max(MIN_H, Math.ceil(data.height))));
      } else if (data.type === PROMPT_MSG && typeof data.text === 'string') {
        const text = data.text.trim().slice(0, PROMPT_MAX);
        if (!text) return;
        useComposerInsert.getState().insert(text);
        toast('已放进输入框,确认后发送', 'ok');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const highlighted = useMemo(() => {
    if (!showCode) return null;
    try { return hljs.highlight(code, { language: 'xml' }).value; } catch { return null; }
  }, [showCode, code]);

  const lines = code ? code.split('\n').length : 0;

  return (
    <div className="codeblock canvas-answer">
      <div className="codeblock-head">
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          <LayoutTemplate size={12} className={streaming ? 'animate-pulse text-acc' : 'text-tx3'} />
          互动画布
          {streaming && <span className="text-tx3">· 生成中</span>}
        </span>
        <div className="flex items-center">
          <button className={headBtn} onClick={() => setShowCode((v) => !v)}>
            {showCode ? <LayoutTemplate size={12} /> : <Code size={12} />}
            {showCode ? '画布' : '代码'}
          </button>
          {!streaming && !showCode && (
            <button className={headBtn} title="重新加载页面" onClick={() => { setHeight(INITIAL_H); setReloadKey((k) => k + 1); }}>
              <RotateCw size={12} />
            </button>
          )}
          {!streaming && (
            <button
              className={headBtn}
              title="在右侧面板打开"
              onClick={() => useHtmlPreview.getState().open(themedCanvasDoc(code, theme))}
            >
              <PanelRight size={12} />
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

      {showCode ? (
        <pre className="max-h-[32rem] overflow-auto">
          {highlighted !== null
            ? <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            : <code>{code}</code>}
        </pre>
      ) : src === null ? (
        <div className="flex items-center gap-4 bg-bg1 px-5 py-6">
          <div className="w-24 shrink-0 space-y-2" aria-hidden>
            <div className="h-2 w-full animate-pulse rounded-full bg-bg3" />
            <div className="h-2 w-3/4 animate-pulse rounded-full bg-bg3 [animation-delay:150ms]" />
            <div className="h-10 w-full animate-pulse rounded-md bg-bg3 [animation-delay:300ms]" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] text-tx2">正在生成互动页面…</div>
            <div className="mt-0.5 text-[11px] tabular-nums text-tx3">已写入 {lines} 行,完成后自动渲染</div>
          </div>
        </div>
      ) : (
        // No allow-same-origin: the page must not reach our cookies/localStorage.
        <iframe
          key={reloadKey}
          ref={frameRef}
          sandbox="allow-scripts allow-modals"
          referrerPolicy="no-referrer"
          srcDoc={src}
          title="互动画布"
          style={{ height }}
          className="block w-full border-0 bg-bg1 transition-[height] duration-150"
        />
      )}
    </div>
  );
}
