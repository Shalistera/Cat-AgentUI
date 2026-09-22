/** URL-encode Markdown delimiters too, so filenames such as "报告(终稿).md"
 * and "结果 #1%.csv" remain one intact, copyable link. */
export function workspaceFileLink(chatId: string, path: string): string {
  const encoded = encodeURIComponent(path).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const label = path.replace(/[\\[\]_*`<>]/g, '\\$&');
  return `[${label}](/chat/${encodeURIComponent(chatId)}?file=${encoded})`;
}
