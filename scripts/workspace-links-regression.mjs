// Verify the server's Markdown links survive rendering and resolve to the
// exact same file in the client, including characters with URL/Markdown meaning.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { workspaceFileLink } from '../server/src/workspace-link.ts';
import { normalizeWorkspacePath, resolveWorkspaceLink, workspaceFileHref } from '../web/src/workspaceLinks.ts';

const origin = 'https://o.tot.re';
const chatId = 'workspace-link-test';
const paths = [
  '第一章_死人不该有心跳.md',
  '小说/第二章 (终稿).md',
  'data/结果 #1% + & = ?.csv',
  'a)b[引用]*_`<备注>.md',
  'literal%2Fname.md',
];

for (const path of paths) {
  const links = [];
  renderToStaticMarkup(createElement(ReactMarkdown, {
    components: { a: ({ href, children }) => { links.push({ href, children }); return createElement('a', { href }, children); } },
  }, workspaceFileLink(chatId, path)));
  assert.equal(links.length, 1, `one intact Markdown link: ${path}`);
  assert.equal(links[0].children, path, `readable filename: ${path}`);
  assert.equal(links[0].href, workspaceFileHref(chatId, path));
  for (const href of [links[0].href, origin + links[0].href]) {
    assert.deepEqual(resolveWorkspaceLink(href, origin), { chatId, path });
  }
}

for (const path of paths.slice(0, 3)) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  for (const href of [encoded, `./${encoded}`, `/chat/${encoded}`, `${origin}/chat/${encoded}`]) {
    assert.deepEqual(resolveWorkspaceLink(href, origin, chatId), { chatId, path }, `legacy file URL: ${href}`);
  }
}

for (const href of [
  'https://example.com/chat/report.md',
  'https://example.com/chat/other?file=report.md',
  '//example.com/chat/report.md',
  '/chat/another-chat',
  '/api/chats/other/workspace/file?path=report.md',
  '#report.md',
  'javascript:alert(1)',
  'data:text/html,report.md',
  '/chat/%invalid.md',
  '/chat/workspace-link-test?file=..%2Fsecret.md',
  '/chat/workspace-link-test?file=%2Fetc%2Fpasswd',
]) assert.equal(resolveWorkspaceLink(href, origin, chatId), null, `not a workspace link: ${href}`);

assert.equal(resolveWorkspaceLink('/chat/report.md', origin), null, 'legacy links need an explicit chat context');
assert.equal(normalizeWorkspacePath('./小说//第一章.md'), '小说/第一章.md');
for (const path of ['../private.md', 'data/../private.md', '.env', '/etc/passwd', 'C:\\secrets.txt', 'bad\0.md']) {
  assert.equal(normalizeWorkspacePath(path), null);
}
console.log('PASS: Markdown → URL → exact workspace file; legacy links; external URLs and invalid paths.');
