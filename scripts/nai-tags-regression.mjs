// Tag 模式 text tools: emphasis steps, tidy, toggles, typing helpers and the 词库 search.
import assert from 'node:assert/strict';
import {
  addMissing, analyze, appendTags, cjkPieces, diffEdit, duplicateCount, emphasize, promptTags, removeTag,
  rememberTags, replaceRanges, tagKey, tidyPrompt, toHalfWidth, tokenAt, topLevel, usedTags, weightAt,
} from '../web/src/naiTags.ts';
import { searchLibrary, zhLabel, TAG_LIBRARY } from '../web/src/naiTagLibrary.ts';

/** Apply an emphasize() result and return [text, selection]. */
function step(text, selStart, selEnd, dir) {
  const r = emphasize(text, selStart, selEnd, dir);
  if (typeof r === 'string') return r;
  const next = text.slice(0, r.start) + r.insert + text.slice(r.end);
  return [next, next.slice(r.selStart, r.selEnd), r.selStart];
}
const caretIn = (text, word) => text.indexOf(word) + 1;

// Caret steps: [[tag]] ← [tag] ← tag → {tag} → {{tag}}, other tags untouched.
let s = '1girl, white hair, smile';
let r = step(s, caretIn(s, 'white'), caretIn(s, 'white'), 1);
assert.equal(r[0], '1girl, {white hair}, smile');
r = step(r[0], r[2], r[2], 1);
assert.equal(r[0], '1girl, {{white hair}}, smile', 'repeated presses keep stepping');
r = step(r[0], r[2], r[2], -1);
r = step(r[0], r[2], r[2], -1);
assert.equal(r[0], s, 'stepping back down removes the braces');
r = step(r[0], r[2], r[2], -1);
assert.equal(r[0], '1girl, [white hair], smile');
assert.equal(step('[[x]]', 2, 2, 1)[0], '[x]');
assert.equal(step('{[x]}', 2, 2, 1)[0], '{x}', 'mixed brackets collapse to their net level');

// Numeric weights move in 0.1 steps and vanish at 1.
assert.equal(step('a, 1.2::rain::, b', 9, 9, 1)[0], 'a, 1.3::rain::, b');
assert.equal(step('1.1::rain::', 6, 6, -1)[0], 'rain');
assert.equal(step('0.9::rain::', 6, 6, 1)[0], 'rain');

// A tag inside a multi-tag group gets its own braces; the group stays intact.
s = '{white hair, red eyes}, smile';
r = step(s, caretIn(s, 'red'), caretIn(s, 'red'), 1);
assert.equal(r[0], '{white hair, {red eyes}}, smile');
s = '1.2::rain, night::';
assert.equal(step(s, caretIn(s, 'night'), caretIn(s, 'night'), 1)[0], '1.2::rain, {night}::');

// Selections wrap exactly what's selected; the core stays selected for the next press.
s = 'a, white hair, red eyes, b';
r = step(s, s.indexOf('white'), s.indexOf(', b'), 1);
assert.deepEqual(r.slice(0, 2), ['a, {white hair, red eyes}, b', 'white hair, red eyes']);
r = step(r[0], r[2], r[2] + r[1].length, 1);
assert.equal(r[0], 'a, {{white hair, red eyes}}, b');
r = step(r[0], r[2], r[2] + r[1].length, -1);
assert.equal(r[0], 'a, {white hair, red eyes}, b');
assert.match(step('a}, b', 0, 5, 1), /括号不完整/);
assert.match(step('a, , b', 2, 2, 1), /光标/);
assert.match(step('sign, Text: OPEN', 13, 13, 1), /画面文字/);
s = 'a, {b}, c';
assert.equal(step(s, s.indexOf('{'), s.indexOf('}') + 1, 1)[0], 'a, {{b}}, c', 'selected braces count as its own');

// Weights and bracket errors for the highlighter.
const a = analyze('{{a}}, [b], 1.5::c::, d}, {e');
assert.equal(weightAt(a, 3), 1.05 * 1.05);
assert.equal(weightAt(a, 9), 1 / 1.05);
assert.equal(weightAt(a, 18), 1.5);
assert.equal(weightAt(a, 23), 1);
assert.deepEqual(a.errors, [23, 26], 'stray } and unclosed { are flagged');
assert.deepEqual(analyze('x, Text: {hi').errors, [], 'nothing after Text: is syntax');
assert.equal(analyze('2girls, v1.2::x').spans.length, 0, 'a number inside a word is not a weight');

// Tags in their remembered form.
assert.deepEqual(promptTags('{{Long_Hair}}, 1.2::blue eyes::, o_o, ^_^, 雨天, she walks along the long road.'),
  ['long hair', 'blue eyes', 'o_o', '^_^']);
assert.equal(tagKey('  Hatsune_Miku_(cosplay) '), 'hatsune miku (cosplay)');
const used = usedTags({ basePrompt: '1girl, smile', negativePrompt: 'hat', artists: [{ tag: 'artist:Foo' }], characters: [{ prompt: 'girl, smile', negativePrompt: 'glasses' }] });
assert.deepEqual(used, { tags: ['1girl', 'smile', 'girl', 'smile', 'artist:foo'], negative: ['hat', 'glasses'] });
const h = rememberTags({ tags: [{ tag: 'smile', count: 3, score: 0.5, last: 1 }, { tag: 'cat', count: 9, score: 1.2, last: 1 }], negative: [] }, used, 5);
assert.deepEqual(h.tags.map(t => [t.tag, t.count]), [['smile', 4], ['cat', 9], ['1girl', 1], ['girl', 1], ['artist:foo', 1]]);

// Toggling tags from the library.
assert.equal(appendTags('', 'smile'), 'smile, ');
assert.equal(appendTags('1girl, ', 'smile'), '1girl, smile, ');
assert.equal(appendTags('1girl', 'smile'), '1girl, smile, ');
assert.equal(appendTags('sign, Text: OPEN', 'smile'), 'sign, smile, Text: OPEN', 'Text: stays last');
assert.equal(removeTag('a, b, c', 'b'), 'a, c');
assert.equal(removeTag('a, b, c', 'a'), 'b, c');
assert.equal(removeTag('a, b, c', 'c'), 'a, b');
assert.equal(removeTag('a, b, ', 'b'), 'a, ');
assert.equal(removeTag('a, {{B}}, c, b', 'b'), 'a, c', 'every occurrence goes, emphasis included');
assert.equal(removeTag('{white hair, red eyes}, x', 'white hair'), '{red eyes}, x');
assert.equal(removeTag('x, {white hair, red eyes}', 'red eyes'), 'x, {white hair}');
assert.equal(removeTag('a\nb\nc', 'b'), 'a\nc');
assert.deepEqual(topLevel('a, {b, c}, 1.2::d, e::, f'), ['a', '{b, c}', '1.2::d, e::', 'f']);
assert.deepEqual(addMissing('1girl, smile', 'Smile, {red eyes}, 1girl, maid'), { text: '1girl, smile, {red eyes}, maid, ', added: 2 });

// 「整理」 and duplicates.
assert.deepEqual(tidyPrompt('1girl，long_hair,,  smile ,{ red eyes },smile\n\n o_o , Text: 你好，世界'),
  { text: '1girl, long hair, smile, {red eyes}\no_o, Text: 你好，世界', removed: 1 });
assert.deepEqual(tidyPrompt('{a, b}, {a, c}'), { text: '{a, b}, {a, c}', removed: 0 }, 'groups are never split');
assert.equal(duplicateCount('a, b, A, {b}, long_hair, long hair'), 2);
assert.equal(tidyPrompt('1girl solo long_hair hatsune_miku_(cosplay) o_o').text, '1girl, solo, long hair, hatsune miku (cosplay), o_o', 'Danbooru copy-paste becomes a list');
assert.equal(tidyPrompt('{long_hair blue_eyes}, smile').text, '{long hair, blue eyes}, smile');
assert.equal(tidyPrompt('a girl with long_hair').text, 'a girl with long hair', 'prose is not split');

// Typing helpers.
assert.deepEqual(toHalfWidth('白发，红眼'), { text: '白发, 红眼', caret: 6 });
assert.deepEqual(toHalfWidth('a，', 2), { text: 'a, ', caret: 3 });
assert.deepEqual(toHalfWidth('a， b', 1), { text: 'a, b', caret: 1 });
assert.deepEqual(toHalfWidth('【x】：（y）'), { text: '[x]:(y)', caret: 7 });
assert.deepEqual(tokenAt('a, {{whi', 8), { start: 5, query: 'whi' });
assert.deepEqual(tokenAt('a, 1.2::whi', 11), { start: 8, query: 'whi' });
assert.deepEqual(diffEdit('a，b', 'a, b'), { start: 1, end: 2, insert: ', ', selStart: 3, selEnd: 3 });

// 「转成 tag」 replaces only the CJK pieces, keeping their emphasis.
s = '1girl, {双马尾}, red eyes, 坐在窗边';
const segs = cjkPieces(s);
assert.deepEqual(segs.map(x => x.text), ['{双马尾}', '坐在窗边']);
assert.deepEqual(replaceRanges(s, segs, new Map([['{双马尾}', '{twintails}'], ['坐在窗边', 'sitting, window']])),
  { text: '1girl, {twintails}, red eyes, sitting, window', replaced: 2 });

// The 词库.
assert.equal(searchLibrary('双马')[0].tag, 'twintails');
assert.equal(searchLibrary('白发')[0].tag, 'white hair');
assert(searchLibrary('twin').some(t => t.tag === 'twintails'));
assert(searchLibrary('白色长发').some(t => t.tag === 'long hair'), 'a longer phrase finds the words it contains');
assert.equal(zhLabel('white hair'), '白发');
const all = TAG_LIBRARY.flatMap(c => c.tags.map(t => t.tag));
assert.equal(new Set(all).size, all.length, 'no tag is listed twice');
for (const t of all) assert.equal(t, tagKey(t), `${t} is already in its compared form`);

console.log(`NAI tag tools passed (${all.length} library tags).`);
