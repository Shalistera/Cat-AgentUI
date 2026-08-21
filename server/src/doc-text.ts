import fs from 'node:fs';
import { config } from './config.js';
import { DOCX_MIME, type OwnedMedia } from './storage.js';

// Text-bearing chat attachments (txt/md/csv/json/docx/…) are flattened into
// the prompt as plain text — same philosophy as project docs, and the only
// shape every provider accepts. PDFs never come through here: they ride to
// vision models as native document blocks.

/** Per-document cap. The overall context budget still applies on top. */
const DOC_CHAR_CAP = config.maxMessageTextChars;

export async function extractDocText(media: OwnedMedia): Promise<string> {
  let text: string;
  if (media.mime === DOCX_MIME) {
    // Lazy import: mammoth is only paid for when a docx actually shows up.
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ path: media.filePath });
    text = r.value;
  } else {
    text = await fs.promises.readFile(media.filePath, 'utf8');
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (text.length > DOC_CHAR_CAP) {
    text = `${text.slice(0, DOC_CHAR_CAP)}\n…(文档过长,已截断,共 ${text.length.toLocaleString()} 字符)`;
  }
  return text;
}

/** Wrap extracted content the way project knowledge does, so models see one
    consistent document convention across the app. */
export function wrapDocAttachment(name: string | undefined, text: string): string {
  return `<attachment name=${JSON.stringify(name || '未命名文档')}>\n${text || '(空文档)'}\n</attachment>`;
}
