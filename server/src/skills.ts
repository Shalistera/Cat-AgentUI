// 技能 (Agent Skills) — packaged know-how the model pulls in on demand.
//
// Layout on disk: data/skills/<slug>/SKILL.md (+ any scripts / reference
// files). The prompt only ever carries each skill's name and description;
// the model calls load_skill to read the full instructions and
// read_skill_file for anything the instructions point at. Inside the 沙盒 the
// same tree is mounted read-only at /skills so scripts can be executed.
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { db, schema, now } from './db/index.js';
import { newId } from './crypto.js';
import type { ToolDef } from './types.js';

export const skillsRoot = path.join(config.dataDir, 'skills');
export const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_MD_CHARS = 60_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const READ_WINDOW = 20_000;
const MAX_DEPTH = 6;

export class SkillError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

type SkillRow = typeof schema.skills.$inferSelect;

// Every mutation of the skills tree (create / edit / import / delete) goes
// through one queue: two imports of the same slug, or a delete racing an
// edit, would otherwise leave a row without a directory or vice versa.
let mutationChain: Promise<unknown> = Promise.resolve();
export function withSkillsLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.catch(() => { /* keep the chain alive */ });
  return run;
}

/** Drain a zip entry with a hard byte ceiling; the central-directory size is
    attacker-controlled, so count what actually comes out. */
function readZipEntry(file: { nodeStream(): NodeJS.ReadableStream }, cap: number, label: string): Promise<Buffer> {
  // jszip's stream is a legacy readable (no async iterator): wire events.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    const stream = file.nodeStream() as NodeJS.ReadableStream & { destroy?: () => void; pause?: () => void };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      try { stream.pause?.(); stream.destroy?.(); } catch { /* ignore */ }
      reject(err);
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      n += chunk.length;
      if (n > cap) { fail(new SkillError(`文件过大:${label}(超过 ${Math.round(cap / 1048576)} MB)`, 413)); return; }
      chunks.push(chunk);
    });
    stream.on('error', (err: Error) => fail(err));
    stream.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
  });
}

export interface SkillFile { path: string; size: number }

// ---- naming & paths ----

// Agent Skills: lowercase letters, digits and hyphens, ≤64 chars, no leading/trailing hyphen.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function skillDir(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new SkillError('技能名只能用小写字母、数字和连字符,不超过 64 个字符');
  return path.join(skillsRoot, slug);
}

function resolveInSkill(slug: string, rel: string): { abs: string; rel: string } {
  const root = skillDir(slug);
  const raw = String(rel ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw.length > 200) throw new SkillError('文件路径为空或过长');
  if (raw.startsWith('/')) throw new SkillError('只能使用技能目录内的相对路径');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new SkillError('文件路径含有非法字符');
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length || segments.length > MAX_DEPTH) throw new SkillError('文件路径不合法');
  for (const seg of segments) {
    if (seg === '..' || seg.startsWith('.')) throw new SkillError('文件路径不合法');
    if (seg.length > 120) throw new SkillError('文件名过长');
  }
  const abs = path.resolve(root, ...segments);
  if (!abs.startsWith(root + path.sep)) throw new SkillError('文件路径越界');
  return { abs, rel: segments.join('/') };
}

// ---- frontmatter ----

export interface Frontmatter { name: string; description: string; body: string }

/** Minimal YAML frontmatter reader: `key: value` lines (quoted or bare),
    which is all the spec requires. Anything else is left for the body. */
export function parseSkillMd(text: string): Frontmatter {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new SkillError('SKILL.md 必须以 YAML frontmatter 开头(--- name / description ---)');
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fields[kv[1]] = v;
  }
  const name = (fields.name ?? '').trim();
  const description = (fields.description ?? '').trim();
  if (!SLUG_RE.test(name)) throw new SkillError('frontmatter 的 name 只能用小写字母、数字和连字符,不超过 64 个字符');
  if (!description) throw new SkillError('frontmatter 缺少 description');
  if (description.length > 1024) throw new SkillError('description 不能超过 1024 个字符');
  return { name, description, body: m[2] };
}

export function composeSkillMd(name: string, description: string, body: string): string {
  const q = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());
  return `---\nname: ${name}\ndescription: ${q(description)}\n---\n\n${body.replace(/^\s+/, '')}`;
}

// ---- files ----

export function listSkillFiles(slug: string): { files: SkillFile[]; bytes: number } {
  const root = skillDir(slug);
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = (dir: string, relDir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(path.join(dir, e.name), rel, depth + 1); }
      else if (e.isFile()) {
        let st: fs.Stats;
        try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
        files.push({ path: rel, size: st.size });
        bytes += st.size;
      }
    }
  };
  walk(root, '', 0);
  return { files, bytes };
}

function assertBudget(slug: string, addBytes: number, addFiles: number) {
  const { files, bytes } = listSkillFiles(slug);
  if (files.length + addFiles > MAX_FILES) throw new SkillError(`一个技能最多 ${MAX_FILES} 个文件`, 413);
  if (bytes + addBytes > MAX_TOTAL_BYTES) throw new SkillError('技能目录超过 64 MB 上限', 413);
}

export function writeSkillFile(slug: string, rel: string, data: Buffer | string): { rel: string; size: number } {
  const { abs, rel: cleaned } = resolveInSkill(slug, rel);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (buf.length > MAX_FILE_BYTES) throw new SkillError('单个文件不能超过 8 MB', 413);
  let existing = 0;
  try { existing = fs.statSync(abs).size; } catch { /* new */ }
  assertBudget(slug, buf.length - existing, existing ? 0 : 1);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, abs);
  return { rel: cleaned, size: buf.length };
}

export function readSkillFileText(slug: string, rel: string): string {
  const { abs, rel: cleaned } = resolveInSkill(slug, rel);
  let buf: Buffer;
  try { buf = fs.readFileSync(abs); } catch { throw new SkillError(`文件不存在:${cleaned}`, 404); }
  if (buf.subarray(0, 8000).includes(0)) throw new SkillError(`「${cleaned}」是二进制文件,无法以文本读取`);
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

export function deleteSkillFile(slug: string, rel: string): void {
  const { abs, rel: cleaned } = resolveInSkill(slug, rel);
  if (cleaned === SKILL_FILE) throw new SkillError('SKILL.md 不能删除;要删除整个技能请用删除技能');
  try { fs.rmSync(abs, { recursive: true, force: false }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SkillError(`文件不存在:${cleaned}`, 404);
    throw err;
  }
}

// ---- rows ----

function rowToDto(r: SkillRow) {
  let allowed: string[] = [];
  try { allowed = JSON.parse(r.allowedUserIds); } catch { /* ignore */ }
  const { files, bytes } = listSkillFiles(r.slug);
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, enabled: !!r.enabled,
    accessMode: r.accessMode as 'shared' | 'restricted', allowedUserIds: allowed,
    fileCount: files.length, bytes, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}
export type SkillDto = ReturnType<typeof rowToDto>;

export function listSkills(): SkillDto[] {
  return db.select().from(schema.skills).all().map(rowToDto);
}

export function getSkill(id: string): SkillDto | null {
  const r = db.select().from(schema.skills).where(eq(schema.skills.id, id)).get();
  return r ? rowToDto(r) : null;
}

function skillBySlug(slug: string): SkillRow | undefined {
  return db.select().from(schema.skills).where(eq(schema.skills.slug, slug)).get();
}

/** Create or replace a skill from SKILL.md text. `expectId` pins an update to
    an existing row so an edit cannot silently rename onto another skill. */
export function saveSkillMd(text: string, expectId?: string): Promise<SkillDto> {
  return withSkillsLock(() => saveSkillMdLocked(text, expectId));
}

function saveSkillMdLocked(text: string, expectId?: string): SkillDto {
  if (text.length > MAX_SKILL_MD_CHARS) throw new SkillError('SKILL.md 过长(上限 6 万字符)');
  const fm = parseSkillMd(text);
  const existing = skillBySlug(fm.name);
  const ts = now();
  if (expectId) {
    const row = db.select().from(schema.skills).where(eq(schema.skills.id, expectId)).get();
    if (!row) throw new SkillError('技能不存在', 404);
    if (existing && existing.id !== expectId) throw new SkillError(`已有另一个名为「${fm.name}」的技能`, 409);
    if (row.slug !== fm.name) {
      // rename: move the directory along with the row
      fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
      if (fs.existsSync(skillDir(row.slug))) fs.renameSync(skillDir(row.slug), skillDir(fm.name));
    }
    fs.mkdirSync(skillDir(fm.name), { recursive: true, mode: 0o700 });
    writeSkillFile(fm.name, SKILL_FILE, text);
    db.update(schema.skills).set({ slug: fm.name, name: fm.name, description: fm.description, updatedAt: ts })
      .where(eq(schema.skills.id, expectId)).run();
    return getSkill(expectId)!;
  }
  if (existing) throw new SkillError(`已有名为「${fm.name}」的技能`, 409);
  fs.mkdirSync(skillDir(fm.name), { recursive: true, mode: 0o700 });
  writeSkillFile(fm.name, SKILL_FILE, text);
  const id = newId();
  db.insert(schema.skills).values({
    id, slug: fm.name, name: fm.name, description: fm.description, enabled: 1,
    accessMode: 'shared', allowedUserIds: '[]', createdAt: ts, updatedAt: ts,
  }).run();
  return getSkill(id)!;
}

export function updateSkillMeta(id: string, patch: { enabled?: boolean; accessMode?: 'shared' | 'restricted'; allowedUserIds?: string[] }): SkillDto {
  const row = db.select().from(schema.skills).where(eq(schema.skills.id, id)).get();
  if (!row) throw new SkillError('技能不存在', 404);
  const set: Partial<SkillRow> = { updatedAt: now() };
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  if (patch.accessMode) set.accessMode = patch.accessMode;
  if (patch.allowedUserIds) set.allowedUserIds = JSON.stringify(patch.allowedUserIds.slice(0, 500));
  db.update(schema.skills).set(set).where(eq(schema.skills.id, id)).run();
  return getSkill(id)!;
}

export function deleteSkill(id: string): Promise<void> {
  return withSkillsLock(() => {
    const row = db.select().from(schema.skills).where(eq(schema.skills.id, id)).get();
    if (!row) throw new SkillError('技能不存在', 404);
    db.delete(schema.skills).where(eq(schema.skills.id, id)).run();
    try { fs.rmSync(skillDir(row.slug), { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

/** Import a zip: the archive may hold SKILL.md at its root or inside one
    top-level folder (how "download as zip" packs things). Files land under
    the slug from the frontmatter; an existing skill of that name is replaced
    when `replace` is set. */
export function importSkillZip(buf: Buffer, replace: boolean): Promise<SkillDto> {
  return withSkillsLock(() => importSkillZipLocked(buf, replace));
}

async function importSkillZipLocked(buf: Buffer, replace: boolean): Promise<SkillDto> {
  const JSZip = (await import('jszip')).default;
  let zip: InstanceType<typeof JSZip>;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new SkillError('不是有效的 zip 文件'); }
  if (Object.keys(zip.files).length > MAX_FILES * 4) throw new SkillError(`zip 条目过多(上限 ${MAX_FILES} 个文件)`, 413);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !n.split('/').some((s) => s.startsWith('.') || s === '__MACOSX'));
  const skillMd = names.find((n) => n === SKILL_FILE) ?? names.find((n) => n.split('/').length === 2 && n.endsWith(`/${SKILL_FILE}`));
  if (!skillMd) throw new SkillError('zip 里没有找到 SKILL.md(需在根目录或唯一的一层文件夹内)');
  const prefix = skillMd.slice(0, skillMd.length - SKILL_FILE.length);
  const entries = names.filter((n) => n.startsWith(prefix)).map((n) => ({ zipPath: n, rel: n.slice(prefix.length) }));
  if (entries.length > MAX_FILES) throw new SkillError(`一个技能最多 ${MAX_FILES} 个文件`, 413);
  const mdText = (await readZipEntry(zip.file(skillMd)!, MAX_SKILL_MD_CHARS * 4, SKILL_FILE)).toString('utf8');
  if (mdText.length > MAX_SKILL_MD_CHARS) throw new SkillError('SKILL.md 过长(上限 6 万字符)');
  const fm = parseSkillMd(mdText);
  const existing = skillBySlug(fm.name);
  if (existing && !replace) throw new SkillError(`已有名为「${fm.name}」的技能;勾选「覆盖」可替换`, 409);
  // Stage into a fresh directory, validate every path, then swap in.
  const dir = skillDir(fm.name);
  const staging = `${dir}.import-${process.pid}-${Date.now()}`;
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let total = 0;
  try {
    for (const e of entries) {
      const { abs, rel } = (() => {
        // reuse the path rules by resolving against the final dir, then re-root
        const r = resolveInSkill(fm.name, e.rel);
        return { abs: path.join(staging, r.rel), rel: r.rel };
      })();
      const data = await readZipEntry(zip.file(e.zipPath)!, MAX_FILE_BYTES, rel);
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw new SkillError('技能目录超过 64 MB 上限', 413);
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
      fs.writeFileSync(abs, data, { mode: 0o600 });
    }
    fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  const ts = now();
  if (existing) {
    db.update(schema.skills).set({ name: fm.name, description: fm.description, updatedAt: ts }).where(eq(schema.skills.id, existing.id)).run();
    return getSkill(existing.id)!;
  }
  const id = newId();
  db.insert(schema.skills).values({
    id, slug: fm.name, name: fm.name, description: fm.description, enabled: 1,
    accessMode: 'shared', allowedUserIds: '[]', createdAt: ts, updatedAt: ts,
  }).run();
  return getSkill(id)!;
}

export async function exportSkillZip(slug: string): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const root = skillDir(slug);
  for (const f of listSkillFiles(slug).files) zip.file(`${slug}/${f.path}`, fs.readFileSync(path.join(root, f.path)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Rows whose directory vanished, or directories with no row: reconcile on boot. */
export function reconcileSkills(): void {
  fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
  for (const r of db.select().from(schema.skills).all()) {
    if (!fs.existsSync(path.join(skillDir(r.slug), SKILL_FILE))) {
      console.warn(`[skills] ${r.slug}: SKILL.md missing on disk, disabling`);
      db.update(schema.skills).set({ enabled: 0 }).where(eq(schema.skills.id, r.id)).run();
    }
  }
}

// ---- access ----

export interface SkillUser { id: string; role: string }

/** Enabled skills this person may use (admins: all enabled). */
export function skillsFor(user: SkillUser): SkillRow[] {
  return db.select().from(schema.skills).where(eq(schema.skills.enabled, 1)).all().filter((r) => {
    if (user.role === 'admin' || r.accessMode === 'shared') return true;
    try { return (JSON.parse(r.allowedUserIds) as string[]).includes(user.id); } catch { return false; }
  });
}

// ---- model-facing ----

export const LOAD_SKILL_TOOL = 'load_skill';
export const READ_SKILL_FILE_TOOL = 'read_skill_file';

export const SKILL_TOOL_DEFS: ToolDef[] = [
  {
    name: LOAD_SKILL_TOOL,
    description: '读取一个技能的完整说明(SKILL.md)以及它附带的文件清单。当任务与技能清单中某项的描述匹配时,先调用它再动手。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名,须与技能清单中的名称一致' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: READ_SKILL_FILE_TOOL,
    description: '读取技能目录里某个文本文件的内容(说明里引用的参考资料、模板、脚本源码等)。长文件分段返回。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        path: { type: 'string', description: '文件在技能目录内的相对路径,如 reference/style.md' },
        offset: { type: 'integer', description: '起始字符位置,默认 0' },
      },
      required: ['name', 'path'],
      additionalProperties: false,
    },
  },
];

export function isSkillTool(name: string): boolean {
  return name === LOAD_SKILL_TOOL || name === READ_SKILL_FILE_TOOL;
}

export function buildSkillsPrompt(rows: SkillRow[], sandboxActive: boolean): string {
  const lines = rows.map((r) => `- ${r.slug}:${r.description}`).join('\n');
  return [
    '[技能]',
    `以下是可用的技能(仅名称与用途;完整步骤未载入)。当用户的任务与某个技能的用途匹配时,先用 load_skill 读取它的完整说明,再严格按说明操作;需要说明里提到的文件时用 read_skill_file 读取。与任何技能无关的任务不必调用。${sandboxActive ? '技能目录在沙盒内只读挂载于 /skills/<技能名>/,说明里的脚本可以直接用 run_command 执行,例如 python3 /skills/<技能名>/scripts/xxx.py。' : ''}`,
    lines,
  ].join('\n');
}

export function callSkillTool(user: SkillUser, name: string, argsJson: string): { result: string; isError: boolean } {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* empty */ }
  const skillName = typeof args.name === 'string' ? args.name.trim() : '';
  if (!skillName) return { result: '缺少 name 参数', isError: true };
  const row = skillsFor(user).find((r) => r.slug === skillName);
  if (!row) return { result: `没有名为「${skillName}」的可用技能,请核对技能清单`, isError: true };
  try {
    if (name === LOAD_SKILL_TOOL) {
      const md = readSkillFileText(row.slug, SKILL_FILE);
      const files = listSkillFiles(row.slug).files.filter((f) => f.path !== SKILL_FILE);
      const fileList = files.length
        ? `\n\n附带文件(用 read_skill_file 读取文本;沙盒内路径 /skills/${row.slug}/…):\n${files.map((f) => `- ${f.path}`).join('\n')}`
        : '';
      return { result: `<skill name=${JSON.stringify(row.slug)}>\n${md.trim()}\n</skill>${fileList}`, isError: false };
    }
    const rel = typeof args.path === 'string' ? args.path : '';
    if (!rel) return { result: '缺少 path 参数', isError: true };
    const text = readSkillFileText(row.slug, rel);
    const offset = Math.max(0, Math.min(Number(args.offset) || 0, text.length));
    const slice = text.slice(offset, offset + READ_WINDOW);
    const end = offset + slice.length;
    const tail = end < text.length ? `</file>\n(未完,继续读取请传 offset=${end})` : '</file>';
    return { result: `<file skill=${JSON.stringify(row.slug)} path=${JSON.stringify(rel)} chars=${text.length} range="${offset}-${end}">\n${slice}\n${tail}`, isError: false };
  } catch (err) {
    if (err instanceof SkillError) return { result: err.message, isError: true };
    return { result: `读取技能失败:${(err as Error).message}`, isError: true };
  }
}

// ---- sample ----

export const SAMPLE_SKILLS: { slug: string; files: Record<string, string> }[] = [
  {
    slug: 'docx-report',
    files: {
      'SKILL.md': `---
name: docx-report
description: 把 Markdown 内容整理成排版规范的 Word 报告(.docx),用户要求"导出 Word / docx / 可打印的报告"时使用;也适用于把工作区里已有的 .md 文件转成 docx。
---

# Word 报告

## 何时使用
用户明确要 Word / docx 文件,或要"能直接发给别人的报告"。

## 步骤
1. 先把报告正文写成工作区里的 Markdown 文件(如 \`报告.md\`),结构:一级标题为报告名,二级标题为章节;表格用 GFM 表格;不要用 HTML。
2. 用 pandoc 转换(沙盒里已提供):
   \`\`\`
   pandoc 报告.md -o 报告.docx --from gfm
   \`\`\`
   如需目录再加 \`--toc\`;需要固定样式时使用本技能自带的模板:
   \`\`\`
   pandoc 报告.md -o 报告.docx --from gfm --reference-doc /skills/docx-report/reference.docx
   \`\`\`
   (只有当 reference.docx 存在时才这样做;可先用 read_skill_file 或 load_skill 的文件清单确认。)
3. 命令成功后在回复里告诉用户文件名,并用两三句话概括报告要点。不要把全文再贴一遍。

## 注意
- pandoc 报错 "reference-doc" 相关,说明模板缺失,去掉该参数重试。
- 中文字体由系统字体决定,不要在 Markdown 里写字体名。
`,
    },
  },
  {
    slug: 'data-chart',
    files: {
      'SKILL.md': `---
name: data-chart
description: 用 Python(pandas + matplotlib)分析工作区里的 CSV/Excel 数据并生成图表 PNG,用户要求统计、汇总、画图、趋势对比时使用。
---

# 数据图表

## 步骤
1. 先用 workspace_read 看数据前几行确认列名与格式(Excel 用 \`python3 /skills/data-chart/scripts/peek.py 文件.xlsx\`)。
2. 把分析脚本写进工作区(如 \`analyze.py\`),再用 run_command 执行。脚本要求:
   - 读取用 pandas;中文列名照常使用。
   - 画图前设置中文字体:\`plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'Droid Sans Fallback', 'DejaVu Sans']\`,并 \`plt.rcParams['axes.unicode_minus'] = False\`。
   - 保存为 PNG(\`plt.savefig('图表.png', dpi=150, bbox_inches='tight')\`),不要 \`plt.show()\`。
   - 只 print 关键统计结果,不要打印整张表。
3. 回复里说明生成了哪个图片文件、几句话解读结论。用户可在工作区面板直接预览 PNG。

## 常见问题
- \`No module named openpyxl\`:说明管理员未安装该库,改用 CSV 或告知用户。
- 图上中文是方块:检查上面的字体设置;若仍不行,改用英文标签并说明原因。
`,
      'scripts/peek.py': `#!/usr/bin/env python3
"""Print the first rows and dtypes of a CSV / Excel file."""
import sys
import pandas as pd

path = sys.argv[1]
df = pd.read_excel(path) if path.lower().endswith(('.xlsx', '.xls')) else pd.read_csv(path)
print(f"{len(df)} 行 × {len(df.columns)} 列")
print(df.dtypes.to_string())
print(df.head(8).to_string())
`,
    },
  },
];

SAMPLE_SKILLS.push({
  slug: 'pdf-export',
  files: {
    'SKILL.md': `---
name: pdf-export
description: 把 Markdown 或 HTML 内容排版成 PDF 文件(中文排版正常),用户要求"导出 PDF / 可打印 / 发 PDF 给我"时使用;也可把工作区里已有的 .md 转成 PDF。
---

# 导出 PDF

## 何时使用
用户明确要 PDF,或要"能直接打印/发给别人的版本"。如果用户要的是 Word,用 docx-report。

## 步骤
1. 把正文写成工作区里的 Markdown 文件(如 \`报告.md\`):一级标题为文档名,二级标题分章节,表格用 GFM 表格。
2. 执行本技能自带的脚本,一步转成 PDF(内部是 Markdown → HTML → weasyprint,自带中文样式表):
   \`\`\`
   python3 /skills/pdf-export/scripts/md2pdf.py 报告.md 报告.pdf
   \`\`\`
   已经是 HTML 的内容用 \`--html 页面.html 输出.pdf\`。想要横版加 \`--landscape\`。
3. 成功后告诉用户文件名并用两三句概括内容;用户可在工作区面板直接预览 PDF。

## 注意
- 报错 \`No module named weasyprint\` / \`markdown\`:管理员尚未安装这两个运行库,告诉用户并改用 docx-report。
- 报错提到 \`libpango\` / \`cairo\`:宿主机缺系统库,告诉用户让管理员看沙盒自检页。
- 中文字体由样式表指定 Noto Sans CJK,Droid Sans Fallback 兜底,不要在 Markdown 里写字体。
`,
    'scripts/md2pdf.py': `#!/usr/bin/env python3
# Markdown / HTML -> PDF with a CJK-friendly stylesheet.
#   md2pdf.py INPUT.md OUTPUT.pdf [--landscape]
#   md2pdf.py --html INPUT.html OUTPUT.pdf [--landscape]
import sys, pathlib

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = {a for a in sys.argv[1:] if a.startswith('--')}
if len(args) != 2:
    print('用法: md2pdf.py 输入.md 输出.pdf [--landscape] | md2pdf.py --html 输入.html 输出.pdf'); sys.exit(2)
src, out = pathlib.Path(args[0]), pathlib.Path(args[1])

try:
    from weasyprint import HTML, CSS
except ImportError:
    print('缺少 weasyprint:请管理员在 沙盒 → Python 运行库 中安装 weasyprint', file=sys.stderr); sys.exit(1)

if '--html' in flags:
    body = src.read_text(encoding='utf-8')
else:
    try:
        import markdown
    except ImportError:
        print('缺少 markdown:请管理员在 沙盒 → Python 运行库 中安装 markdown', file=sys.stderr); sys.exit(1)
    body = markdown.markdown(src.read_text(encoding='utf-8'), extensions=['tables', 'fenced_code', 'toc', 'sane_lists'])

css = pathlib.Path(__file__).with_name('style.css').read_text(encoding='utf-8')
if '--landscape' in flags:
    css += '\\n@page { size: A4 landscape; }'
html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + src.stem + '</title></head><body>' + body + '</body></html>'
HTML(string=html, base_url=str(src.parent.resolve())).write_pdf(str(out), stylesheets=[CSS(string=css)])
print('已生成 ' + str(out) + ' (' + str(out.stat().st_size) + ' 字节)')
`,
    'scripts/style.css': `@page { size: A4; margin: 2cm 1.8cm; @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #888; } }
html { font-family: "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Droid Sans Fallback", "DejaVu Sans", sans-serif; font-size: 10.5pt; line-height: 1.7; color: #222; }
h1 { font-size: 20pt; margin: 0 0 14pt; padding-bottom: 6pt; border-bottom: 1.5pt solid #333; }
h2 { font-size: 14pt; margin: 18pt 0 8pt; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; }
p { margin: 0 0 8pt; text-align: justify; }
ul, ol { margin: 0 0 8pt 1.4em; padding: 0; }
li { margin: 2pt 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; font-size: 9.5pt; }
th, td { border: 0.6pt solid #999; padding: 4pt 6pt; vertical-align: top; }
th { background: #f0f0f0; font-weight: 600; }
tr { page-break-inside: avoid; }
code { font-family: "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace; font-size: 9pt; background: #f4f4f4; padding: 0 3pt; border-radius: 2pt; }
pre { background: #f4f4f4; padding: 8pt; border-radius: 3pt; font-size: 8.5pt; white-space: pre-wrap; word-break: break-all; }
pre code { background: none; padding: 0; }
blockquote { margin: 8pt 0; padding: 4pt 12pt; border-left: 3pt solid #bbb; color: #555; }
img { max-width: 100%; }
hr { border: 0; border-top: 0.6pt solid #bbb; margin: 12pt 0; }
a { color: #1f4fd8; text-decoration: none; }
`,
  },
});

export function importSampleSkills(): Promise<SkillDto[]> {
  return withSkillsLock(() => {
    const out: SkillDto[] = [];
    for (const s of SAMPLE_SKILLS) {
      if (skillBySlug(s.slug)) continue;
      const dto = saveSkillMdLocked(s.files['SKILL.md']);
      for (const [rel, content] of Object.entries(s.files)) {
        if (rel !== SKILL_FILE) writeSkillFile(s.slug, rel, content);
      }
      out.push(getSkill(dto.id)!);
    }
    return out;
  });
}
