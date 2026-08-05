// The PPT feature deliberately has no sandbox and no headless browser: the
// model writes a structured deck spec (JSON), and pptxgenjs assembles the
// .pptx from it in-process — pure string/zip work that takes milliseconds and
// a few MB of RAM. The spec is the stored artifact; the file is rebuilt on
// every download.
import { z } from 'zod';
// pptxgenjs ships CJS + ESM builds and CJS-flavoured types; depending on the
// loader (tsx in dev, node in prod) the default import lands on either the
// class itself or a namespace wrapping it. Unwrap at runtime, re-type by hand.
import PptxGenJSImport from 'pptxgenjs';
type PptxGenJSInstance = InstanceType<typeof PptxGenJSImport.default>;
type PptxCtor = new () => PptxGenJSInstance;
const asAny = PptxGenJSImport as unknown as PptxCtor & { default?: PptxCtor };
const PptxGenJS: PptxCtor = asAny.default ?? asAny;

const short = z.string().min(1).max(200);
const para = z.string().min(1).max(600);

const pointSchema = z.object({
  text: para,
  sub: z.array(para).max(6).optional(),
});

const slideSchema = z.discriminatedUnion('layout', [
  z.object({ layout: z.literal('cover'), title: short, subtitle: short.optional(), notes: para.optional() }),
  z.object({ layout: z.literal('section'), title: short, subtitle: para.optional(), notes: para.optional() }),
  z.object({ layout: z.literal('bullets'), title: short, points: z.array(pointSchema).min(1).max(8), notes: para.optional() }),
  z.object({
    layout: z.literal('twoCol'),
    title: short,
    columns: z.array(z.object({ heading: short, points: z.array(para).min(1).max(6) })).length(2),
    notes: para.optional(),
  }),
  z.object({
    layout: z.literal('table'),
    title: short,
    headers: z.array(short).min(2).max(5),
    rows: z.array(z.array(z.string().max(200)).min(2).max(5)).min(1).max(10),
    notes: para.optional(),
  }),
  z.object({ layout: z.literal('quote'), quote: para, author: short.optional(), notes: para.optional() }),
  z.object({ layout: z.literal('end'), title: short, subtitle: short.optional(), notes: para.optional() }),
]);

export const deckSpecSchema = z.object({
  title: short,
  subtitle: short.optional(),
  accent: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
  slides: z.array(slideSchema).min(2).max(30),
});

export type DeckSpec = z.infer<typeof deckSpecSchema>;
export type DeckSlide = z.infer<typeof slideSchema>;

export function buildDeckPrompt(topic: string, slideCount: number): string {
  return [
    '你是一位专业的演示文稿设计师。根据用户的要求,产出一份幻灯片内容规格。',
    '',
    '输出要求:只输出一个 JSON 对象,不要 markdown 代码块、不要任何解释文字。',
    'JSON 结构如下(TypeScript 记法):',
    '{',
    '  "title": string,          // 演示文稿标题',
    '  "subtitle"?: string,',
    '  "accent"?: string,        // 主题色,6 位十六进制(不带 #),根据主题气质挑选,例如 "1F4FD8"',
    '  "slides": Slide[]',
    '}',
    'Slide 为以下几种之一(用 layout 字段区分):',
    '- { "layout": "cover", "title": string, "subtitle"?: string }            // 封面,必须是第 1 页',
    '- { "layout": "section", "title": string, "subtitle"?: string }         // 章节分隔页',
    '- { "layout": "bullets", "title": string, "points": [{ "text": string, "sub"?: string[] }] }  // 要点页,points 3-5 条为宜',
    '- { "layout": "twoCol", "title": string, "columns": [{ "heading": string, "points": string[] }, { "heading": string, "points": string[] }] }  // 左右对比,恰好 2 列',
    '- { "layout": "table", "title": string, "headers": string[], "rows": string[][] }  // 表格,rows 每行长度与 headers 一致',
    '- { "layout": "quote", "quote": string, "author"?: string }             // 引言页',
    '- { "layout": "end", "title": string, "subtitle"?: string }             // 结尾页,必须是最后 1 页',
    '每页都可以加 "notes": string(演讲者备注,口语化的一两句提词)。',
    '',
    `目标页数:约 ${slideCount} 页(含封面和结尾)。内容语言跟随用户主题的语言。`,
    '内容要具体、有信息量,避免空话;适当穿插 section/twoCol/table/quote 让版式有节奏,不要全是 bullets。',
    '',
    `用户的要求:${topic}`,
  ].join('\n');
}

// Models love to wrap JSON in fences or preface it with a sentence — take the
// outermost braces and let zod be the judge of what's inside.
export function parseDeckSpec(raw: string): DeckSpec {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 内容');
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('模型返回的 JSON 无法解析,请重试或换一个模型');
  }
  const parsed = deckSpecSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`模型返回的内容不符合规格(${issue?.path.join('.')}: ${issue?.message}),请重试`);
  }
  return parsed.data;
}

// ---- pptx rendering ----
// 16:9 canvas is 10 × 5.625 inches. One accent colour + ink/grey neutrals,
// mirroring the app's own design language.

const INK = '14181F';
const GREY = '55606F';
const LIGHT = 'F1F3F6';
const WHITE = 'FFFFFF';

export async function renderDeckPptx(spec: DeckSpec): Promise<Buffer> {
  const accent = (spec.accent ?? '1F4FD8').toUpperCase();
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 10, height: 5.625 });
  pptx.layout = 'WIDE';
  pptx.title = spec.title;

  const footerOpts = {
    x: 0.55, y: 5.22, w: 8.9, h: 0.3, fontSize: 9, color: GREY,
    fontFace: 'Arial', align: 'left' as const,
  };

  spec.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    if (s.notes) slide.addNotes(s.notes);

    const header = (title: string) => {
      slide.addText(title, {
        x: 0.55, y: 0.35, w: 8.9, h: 0.7, fontSize: 24, bold: true, color: INK, align: 'left',
      });
      slide.addShape('rect', { x: 0.58, y: 1.05, w: 0.9, h: 0.06, fill: { color: accent } });
    };
    const footer = () => {
      slide.addText(spec.title, footerOpts);
      slide.addText(String(i + 1), { ...footerOpts, align: 'right' });
    };

    switch (s.layout) {
      case 'cover': {
        slide.background = { color: accent };
        slide.addShape('rect', { x: 0.8, y: 1.7, w: 1.1, h: 0.08, fill: { color: WHITE } });
        slide.addText(s.title, {
          x: 0.75, y: 2.0, w: 8.5, h: 1.2, fontSize: 34, bold: true, color: WHITE, align: 'left',
        });
        if (s.subtitle) {
          slide.addText(s.subtitle, {
            x: 0.78, y: 3.2, w: 8.4, h: 0.6, fontSize: 15, color: WHITE, transparency: 15, align: 'left',
          });
        }
        break;
      }
      case 'section': {
        slide.addShape('rect', { x: 0, y: 0, w: 0.25, h: 5.625, fill: { color: accent } });
        slide.addText(String(i + 1).padStart(2, '0'), {
          x: 0.8, y: 1.35, w: 2, h: 0.8, fontSize: 40, bold: true, color: accent, transparency: 45,
        });
        slide.addText(s.title, { x: 0.78, y: 2.3, w: 8.4, h: 0.9, fontSize: 28, bold: true, color: INK });
        if (s.subtitle) {
          slide.addText(s.subtitle, { x: 0.8, y: 3.25, w: 8.2, h: 0.9, fontSize: 14, color: GREY });
        }
        footer();
        break;
      }
      case 'bullets': {
        header(s.title);
        const runs = s.points.flatMap((p) => [
          {
            text: p.text,
            options: {
              fontSize: 15, color: INK, bullet: { code: '2022', indent: 14 },
              paraSpaceBefore: 8, paraSpaceAfter: 2,
            },
          },
          ...(p.sub ?? []).map((t) => ({
            text: t,
            options: {
              fontSize: 12.5, color: GREY, bullet: { code: '2013', indent: 12 },
              indentLevel: 1, paraSpaceBefore: 3,
            },
          })),
        ]);
        slide.addText(runs, { x: 0.55, y: 1.3, w: 8.9, h: 3.7, align: 'left', valign: 'top' });
        footer();
        break;
      }
      case 'twoCol': {
        header(s.title);
        s.columns.forEach((col, ci) => {
          const x = ci === 0 ? 0.55 : 5.15;
          slide.addShape('roundRect', {
            x, y: 1.35, w: 4.3, h: 3.55, fill: { color: LIGHT }, rectRadius: 0.06,
          });
          slide.addText(col.heading, {
            x: x + 0.25, y: 1.55, w: 3.8, h: 0.45, fontSize: 15, bold: true, color: accent,
          });
          slide.addText(
            col.points.map((t) => ({
              text: t,
              options: {
                fontSize: 12.5, color: INK, bullet: { code: '2022', indent: 12 },
                paraSpaceBefore: 6,
              },
            })),
            { x: x + 0.25, y: 2.05, w: 3.85, h: 2.7, valign: 'top' },
          );
        });
        footer();
        break;
      }
      case 'table': {
        header(s.title);
        const cols = s.headers.length;
        slide.addTable(
          [
            s.headers.map((h) => ({
              text: h,
              options: { bold: true, color: WHITE, fill: { color: accent }, fontSize: 12.5 },
            })),
            ...s.rows.map((r) => Array.from({ length: cols }, (_, ci) => ({
              text: r[ci] ?? '', options: { fontSize: 12, color: INK },
            }))),
          ],
          {
            x: 0.55, y: 1.35, w: 8.9, colW: Array.from({ length: cols }, () => 8.9 / cols),
            border: { type: 'solid', color: 'E4E7EC', pt: 0.75 },
            rowH: 0.36, valign: 'middle', margin: 0.06,
          },
        );
        footer();
        break;
      }
      case 'quote': {
        slide.addText('“', {
          x: 0.7, y: 0.7, w: 1.6, h: 1.4, fontSize: 96, bold: true, color: accent, transparency: 30,
        });
        slide.addText(s.quote, {
          x: 1.2, y: 1.9, w: 7.6, h: 1.8, fontSize: 20, italic: true, color: INK, align: 'center',
        });
        if (s.author) {
          slide.addText(`— ${s.author}`, {
            x: 1.2, y: 3.7, w: 7.6, h: 0.5, fontSize: 13, color: GREY, align: 'center',
          });
        }
        footer();
        break;
      }
      case 'end': {
        slide.background = { color: INK };
        slide.addShape('rect', { x: 0.8, y: 2.0, w: 1.1, h: 0.08, fill: { color: accent } });
        slide.addText(s.title, {
          x: 0.75, y: 2.3, w: 8.5, h: 1.0, fontSize: 30, bold: true, color: WHITE,
        });
        if (s.subtitle) {
          slide.addText(s.subtitle, {
            x: 0.78, y: 3.3, w: 8.4, h: 0.6, fontSize: 14, color: WHITE, transparency: 25,
          });
        }
        break;
      }
    }
  });

  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
