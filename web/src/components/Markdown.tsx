import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
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

// Convert \[...\] / \(...\) LaTeX delimiters to $$...$$ / $...$ outside code spans & fences.
function normalizeMath(src: string): string {
  if (!src.includes('\\[') && !src.includes('\\(')) return src;
  const segments = src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return segments.map((seg, i) => {
    if (i % 2 === 1) return seg; // code segment
    return seg
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`);
  }).join('');
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      if (code.length < 8000) return hljs.highlightAuto(code).value;
    } catch { /* fall through */ }
    return null;
  }, [lang, code]);

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'code'}</span>
        <button
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tx2 transition-colors hover:bg-bg3 hover:text-tx"
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
      {html !== null
        ? <pre><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        : <pre><code>{code}</code></pre>}
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const normalized = useMemo(() => normalizeMath(text), [text]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre({ children }) {
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
            return <CodeBlock lang={lang} code={code} />;
          },
          a({ children, href }) {
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});
