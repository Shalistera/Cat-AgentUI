import { createContext, memo, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkFriendly from 'remark-cjk-friendly';
import rehypeKatex from 'rehype-katex';
import { Check, ChevronDown, ChevronRight, Code, Copy, Eye, PanelRight } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { useHtmlPreview } from '../store';
import { MermaidBlock } from './Mermaid';
import { useLightbox } from './Lightbox';
import { WorkspaceFileLink } from './WorkspaceFileLink';
import { resolveWorkspaceLink } from '../workspaceLinks';

for (const [name, lang] of Object.entries({
  javascript, typescript, python, java, c, cpp, csharp, go, rust, json, yaml,
  xml, css, bash, sql, markdown, php, ruby, kotlin, swift, diff, dockerfile, ini, plaintext,
})) hljs.registerLanguage(name, lang);
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['golang'], { languageName: 'go' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['c++', 'cc', 'h', 'hpp'], { languageName: 'cpp' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['rb'], { languageName: 'ruby' });
hljs.registerAliases(['kt'], { languageName: 'kotlin' });
hljs.registerAliases(['toml'], { languageName: 'ini' });
hljs.registerAliases(['text', 'txt', 'plain'], { languageName: 'plaintext' });

// Currency-looking dollars: "$0.0770", "$1,234.56", "$5" — a "$" directly followed by a
// number that is NOT itself closed by another "$" (so "$5$" stays math). Escaping them keeps
// remark-math from pairing two prices in one line into a bogus inline formula.
const CURRENCY_RE = /(^|[^\\$\w])\$(?=\d[\d,]*(?:\.\d+)?(?![\d,.]*\$))/g;

// Outside code spans & fences: convert \[...\] / \(...\) LaTeX delimiters to $$...$$ / $...$,
// and escape currency "$" so remark-math leaves it alone.
function normalizeMath(src: string): string {
  if (!src.includes('$') && !src.includes('\\[') && !src.includes('\\(')) return src;
  const segments = src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return segments.map((seg, i) => {
    if (i % 2 === 1) return seg; // code segment
    return seg
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`)
      .replace(CURRENCY_RE, '$1\\$');
  }).join('');
}

// react-markdown escapes raw HTML (no rehype-raw on purpose), so a model's "<br>" — common
// inside table cells, where Markdown has no other way to break a line — would show literally.
// Turn just those nodes into proper line breaks.
type MdNode = { type: string; value?: string; children?: MdNode[] };
function remarkBrToBreak() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.type === 'html' && /^<br\s*\/?>$/i.test((child.value ?? '').trim())) {
          child.type = 'break';
          delete child.value;
        } else walk(child);
      }
    };
    walk(tree);
  };
}

const headBtn = 'flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx2 transition-colors hover:bg-bg3 hover:text-tx';

const PREVIEWABLE_LANGS = new Set(['html', 'htm', 'svg']);
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  const headToggleRef = useRef<HTMLButtonElement>(null);
  const returnToHead = useRef(false);
  // Snapshot of the code at the moment preview was toggled on (null = source view).
  // Freezing it keeps the sandboxed iframe from reloading on every streamed token.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const canPreview = PREVIEWABLE_LANGS.has(lang.toLowerCase());
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      if (code.length < 8000) return hljs.highlightAuto(code).value;
    } catch { /* fall through */ }
    return null;
  }, [lang, code]);
  // The gutter is a sibling column, not part of the <pre>: highlight.js spans
  // can straddle newlines, so the code is never split per line, and numbers
  // stay out of what a person selects and copies.
  const lineCount = Math.max(1, code.split('\n').length);
  // Keep the expand control if a previously folded block becomes shorter.
  const canCollapse = lineCount > 5 || collapsed;
  const showFooter = lineCount > 15;

  const toggle = (fromBottom = false) => {
    returnToHead.current = fromBottom && !collapsed;
    setCollapsed((v) => !v);
  };
  useLayoutEffect(() => {
    if (!collapsed || !returnToHead.current) return;
    returnToHead.current = false;
    // The footer just disappeared. Restore both reading position and keyboard
    // focus to this block instead of leaving the reader in another message.
    headToggleRef.current?.focus({ preventScroll: true });
    headToggleRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [collapsed]);

  const toolbar = (bottom = false) => (
      <div className={`codeblock-head relative gap-2 ${bottom ? 'codeblock-foot flex-row-reverse' : ''}`}>
        {/* A full-bar button underneath independent action buttons avoids
            nested buttons and makes the empty space keyboard-accessible too. */}
        {canCollapse && <button
          ref={bottom ? undefined : headToggleRef}
          type="button" className="absolute inset-0 cursor-pointer rounded-[inherit] hover:bg-bg3/40 focus-visible:outline-2 focus-visible:outline-acc focus-visible:-outline-offset-2"
          aria-label={`${collapsed ? '展开' : '折叠'} ${lang || 'code'} 代码块`}
          aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggle(bottom)}
        />}
        <span className="pointer-events-none relative min-w-0 truncate">{lang || 'code'} · {lineCount} 行</span>
        <div className={`relative flex shrink-0 items-center ${bottom ? '' : 'flex-row-reverse'}`}>
          <div className="flex items-center">
          {canPreview && (
            <button
              type="button" className={headBtn}
              onClick={() => { setPreviewSrc(previewSrc === null ? code : null); setCollapsed(false); }}
            >
              {previewSrc === null ? <Eye size={12} /> : <Code size={12} />}
              {previewSrc === null ? '预览' : '代码'}
            </button>
          )}
          {canPreview && (
            <button
              type="button" className={headBtn}
              title="在右侧面板预览"
              aria-label="在右侧面板预览"
              onClick={() => {
                useHtmlPreview.getState().open(code);
                setPreviewSrc(null); // 弹出后行内回到代码视图
              }}
            >
              <PanelRight size={12} />
            </button>
          )}
          </div>
          <button
            type="button" className={headBtn}
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
          {canCollapse && <button
            type="button" className={headBtn}
            aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggle(bottom)}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {collapsed ? '展开' : '折叠'}
          </button>}
        </div>
      </div>
  );

  return (
    <div className="codeblock">
      {toolbar()}
      {collapsed && <div className="px-4 py-2 text-xs text-tx3">已折叠 {lineCount} 行代码</div>}
      <div id={bodyId} hidden={collapsed}>
      {previewSrc !== null
        // No allow-same-origin: previewed HTML must not reach our cookies/localStorage.
        ? <iframe sandbox="allow-scripts allow-modals" srcDoc={previewSrc} title="HTML 预览" className="block h-[420px] w-full border-0 bg-white" />
        : (
          <div className="codeblock-body">
            <div className="codeblock-gutter" aria-hidden>
              {Array.from({ length: lineCount }, (_, i) => <span key={i}>{i + 1}</span>)}
            </div>
            {html !== null
              ? <pre><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
              : <pre><code>{code}</code></pre>}
          </div>
        )}
        {showFooter && toolbar(true)}
      </div>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

const MarkdownContext = createContext({ streaming: false });

// Keep the renderer identity stable: an inline `pre` component remounts every
// streamed token, losing the user's fold/preview state.
function MarkdownPre({ children }: { children?: ReactNode }) {
  const { streaming } = useContext(MarkdownContext);
  const child = Array.isArray(children) ? children[0] : children;
  let lang = '';
  let code = '';
  if (child && typeof child === 'object' && 'props' in child) {
    const props = (child as { props: { className?: string; children?: ReactNode } }).props;
    lang = /language-([\w+-]+)/.exec(props.className || '')?.[1] ?? '';
    code = extractText(props.children).replace(/\n$/, '');
  } else {
    code = extractText(children);
  }
  if (lang.toLowerCase() === 'mermaid') return <MermaidBlock code={code} streaming={streaming} />;
  return <CodeBlock lang={lang} code={code} />;
}

export interface Citation { uri: string; title: string }

/** Match a link against the source list loosely: scheme, trailing slash,
    fragment and case of the host don't count. */
function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
  } catch { return u.trim().replace(/\/+$/, '').toLowerCase(); }
}
function citationIndex(href: string, citations: Citation[]): number {
  const key = normalizeUrl(href);
  return citations.findIndex((c) => normalizeUrl(c.uri) === key);
}

/** Superscript source chip: `[n](cite:n)` rendered as ⁿ linking to source n. */
function CiteChip({ n, citations }: { n: number; citations: Citation[] }) {
  const c = citations[n - 1];
  if (!c) return null;
  let host = '';
  try { host = new URL(c.uri).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const label = /vertexaisearch\.cloud\.google\.com$/i.test(host) ? c.title : (c.title || host);
  return (
    // The number is painted by CSS (::before, from data-n) rather than being
    // a text node: text selected in the browser then never picks the chips
    // up, so copied prose stays clean in every browser — user-select:none
    // alone still leaks into the clipboard on some (Safari).
    <a
      href={c.uri} target="_blank" rel="noopener noreferrer"
      title={label}
      className="cite-chip"
      data-n={n}
      aria-label={`来源 ${n}:${label}`}
    />
  );
}

export const Markdown = memo(function Markdown({ text, streaming = false, citations, workspaceChatId }: {
  text: string; streaming?: boolean;
  /** Google 搜索 sources, 1-based in `cite:n` links (see citations.ts). */
  citations?: Citation[];
  /** Context for legacy replies that linked directly to a relative filename. */
  workspaceChatId?: string;
}) {
  const normalized = useMemo(() => normalizeMath(text), [text]);
  return (
    <MarkdownContext.Provider value={{ streaming }}>
    <div className="md">
      <ReactMarkdown
        // remark-cjk-friendly: CommonMark's flanking rule treats CJK quotes/brackets as punctuation, so
        // `执行**“先说”**的动作` (no spaces around **) never becomes <strong>. Models write it that way
        // all the time; the plugin relaxes the rule for CJK text without touching Latin behaviour.
        remarkPlugins={[remarkGfm, remarkMath, remarkCjkFriendly, remarkBrToBreak]}
        rehypePlugins={[[rehypeKatex, { strict: false }]]}
        // keep our internal cite: scheme; everything else goes through the default sanitiser
        urlTransform={(url) => (url.startsWith('cite:') ? url : defaultUrlTransform(url))}
        components={{
          pre: MarkdownPre,
          a({ children, href }) {
            if (typeof href === 'string' && href.startsWith('cite:') && citations) {
              const n = Number(href.slice(5));
              return Number.isInteger(n) && n > 0 ? <CiteChip n={n} citations={citations} /> : null;
            }
            // MCP search: the model links the sentence to a result URL; a link
            // that matches one of the sources becomes the same numbered chip.
            if (typeof href === 'string' && citations?.length) {
              const idx = citationIndex(href, citations);
              if (idx >= 0) return <CiteChip n={idx + 1} citations={citations} />;
            }
            if (href) {
              const file = resolveWorkspaceLink(href, window.location.origin, workspaceChatId);
              if (file) return <WorkspaceFileLink chatId={file.chatId} path={file.path}>{children}</WorkspaceFileLink>;
            }
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          img({ src, alt }) {
            const url = typeof src === 'string' ? src : '';
            if (!url) return null;
            return (
              <img
                src={url} alt={alt ?? ''} loading="lazy"
                className="cursor-zoom-in"
                onClick={() => useLightbox.getState().open(url, alt ?? '')}
              />
            );
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
    </MarkdownContext.Provider>
  );
});
