// Lists t()/tServer() source strings that have no English entry, plus lines
// that still carry untranslated Chinese outside comments and t() calls.
//   node scripts/check-i18n.mjs            # whole src/
//   node scripts/check-i18n.mjs src/pages  # only report leftovers under a path
// Exit code 1 when any t() string lacks an English entry, or a dictionary
// file under src/i18n/en is not imported by src/i18n/index.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(webRoot, 'src');
const only = process.argv[2] ? join(webRoot, process.argv[2]) : null;
// Pure data (Chinese tag aliases for search) — not UI text.
const SKIP = new Set(['src/naiTagLibrary.ts']);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mts)$/.test(n) ? [p] : [];
  });
}

const files = walk(srcRoot);
const dict = new Set();
for (const f of files.filter((f) => f.includes(`${join('src', 'i18n', 'en')}`))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/gm)) dict.add(unescape(m[2]));
}

// A dictionary only reaches the UI once i18n/index.ts imports it.
const indexSrc = readFileSync(join(srcRoot, 'i18n', 'index.ts'), 'utf8');
let unloaded = 0;
for (const f of files.filter((f) => f.includes(`${join('src', 'i18n', 'en')}`))) {
  const name = basename(f).replace(/\.tsx?$/, '');
  if (!indexSrc.includes(`from './en/${name}'`)) {
    unloaded++;
    console.log(`not loaded  ${relative(webRoot, f)}  (import it in src/i18n/index.ts)`);
  }
}

function unescape(s) {
  return s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
}

const CJK = /[一-鿿　-〿＀-￯]/;
const T_CALL = /\b(?:t|tServer)\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$])*)`)/g;

let missing = 0;
const leftovers = [];
for (const f of files) {
  const rel = relative(webRoot, f);
  if (rel.startsWith(join('src', 'i18n')) || SKIP.has(rel)) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(T_CALL)) {
    const key = unescape(m[1] ?? m[2] ?? m[3]);
    if (!dict.has(key)) {
      missing++;
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`missing  ${rel}:${line}  ${JSON.stringify(key)}`);
    }
  }
  if (only && !f.startsWith(only)) continue;
  // Strip comments and t() calls, then flag remaining Chinese.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1').replace(T_CALL, 't()'));
  stripped.forEach((l, i) => { if (CJK.test(l)) leftovers.push(`${rel}:${i + 1}  ${l.trim().slice(0, 120)}`); });
}

if (leftovers.length) {
  console.log(`\n${leftovers.length} line(s) with Chinese outside t():`);
  for (const l of leftovers) console.log(`  ${l}`);
}
console.log(`\n${dict.size} English entries, ${missing} missing.`);
process.exit(missing || unloaded ? 1 : 0);
