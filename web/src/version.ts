import { locale, t } from './i18n';

const revision = __APP_REVISION__ === 'unknown' ? '' : __APP_REVISION__;

export const appVersion = __APP_VERSION__;

export const appVersionLabel = revision
  ? `v${__APP_VERSION__} · ${revision}`
  : `v${__APP_VERSION__}`;

export const appVersionTitle = [
  `Cat AgentUI v${__APP_VERSION__}`,
  revision ? `Git ${revision}` : null,
  `${t('构建时间')} ${new Date(__APP_BUILD_TIME__).toLocaleString(locale)}`,
].filter(Boolean).join('\n');

/**
 * These notes are curated from the repository's recent commit history. Keep
 * them in-product rather than deriving them at runtime: deployed instances do
 * not need GitHub access, and operators can review exactly what users see.
 * Write each item for the people using the app: one plain sentence about what
 * they can now do or will notice. Leave out admin-only settings, provider
 * plumbing and security internals.
 *
 * Every item needs BOTH `zh` and `en`: the release-notes dialog renders the
 * one matching the UI language, so a missing translation leaves a gap.
 */
export const recentChanges = [
  {
    date: '2026-10-09',
    items: [
      {
        zh: '界面新增英文版：在「设置 → 通用」里切换语言；非中文浏览器默认显示英文。',
        en: 'The interface now comes in English: switch languages under Settings → General. Browsers not set to Chinese get English by default.',
      },
    ],
  },
  {
    date: '2026-10-07 · v1.2.0',
    items: [
      {
        zh: '联网搜索不用再手动打开：助手会自己判断要不要用 Google 搜索，还能打开网页读原文核实，回答里标出来源；本地 Claude Code、GPT 等模型都能用。',
        en: 'Web search no longer needs a toggle: the assistant decides when to search Google, can open pages to check the original text, and cites its sources. Works with every model, including local Claude Code and GPT.',
      },
      {
        zh: '项目里的回答会标出参考了哪份资料，点资料名就能打开查看和修改。',
        en: 'Answers inside a project name the reference files they drew on; click a file name to open and edit it.',
      },
      {
        zh: 'NAI 创作室的 Tag 模式更顺手：按权重上色、快捷加减权重、中文联想 tag、一键整理，还有可收藏常用组合的「tag 库」。',
        en: 'NAI Studio\'s tag mode is easier to work in: weight-based colouring, quick weight nudges, Chinese tag suggestions, one-click tidy-up, and a tag library for saving combinations you reuse.',
      },
    ],
  },
  {
    date: '2026-10-06',
    items: [
      {
        zh: '新增 NAI 创作室：一屏完成 NovelAI V5 绘图，用中文描述就能画，支持多人站位和自定义画风。',
        en: 'New NAI Studio: NovelAI V5 image generation on one screen, promptable in plain language, with multi-character positioning and custom styles.',
      },
      {
        zh: '项目资料会尽量整篇交给模型，放不下的再按需检索；子代理也能读项目资料。',
        en: 'Reference files are handed to the model whole whenever they fit, with the rest retrieved on demand; subagents can read them too.',
      },
      {
        zh: '长对话超出长度时，较早的内容会自动压缩成摘要继续带上，不再悄悄丢失。',
        en: 'When a long chat outgrows the context window, earlier turns are summarised and carried along instead of quietly dropping out.',
      },
    ],
  },
  {
    date: '2026-09-28',
    items: [
      {
        zh: '按时间或多曲线对比时优先展示对应折线图,数据不足会说明缺口,避免改画不相关的峰值柱状图。',
        en: 'Comparisons over time or across several series now show a line chart, and say what data is missing instead of substituting an unrelated bar chart.',
      },
      {
        zh: '图表对比更能容忍多余字段和数字格式差异;填错参数时会指出具体问题,并允许模型修正一次。',
        en: 'Chart comparisons tolerate extra fields and differing number formats; bad parameters are reported precisely and the model gets one chance to fix them.',
      },
    ],
  },
  {
    date: '2026-09-26',
    items: [
      {
        zh: '更容易识别“对比两者,用时间段展示”这类图表请求,减少只回复长文的情况。',
        en: 'Requests like "compare these two over time" are recognised as chart requests more reliably, instead of coming back as a wall of text.',
      },
      {
        zh: '图表优先显示在回答顶部,减少出图前的长篇说明;截断提示和生成速度统计更准确。',
        en: 'Charts appear at the top of the answer with less preamble; truncation warnings and speed stats are more accurate.',
      },
      {
        zh: '数据比较可显示柱状图或多条折线,支持图例筛选、悬停读数和切换数据表。',
        en: 'Data comparisons can render as bars or multiple lines, with legend filtering, hover readouts and a switch to the underlying table.',
      },
      {
        zh: '移除互动画布、加密块和实验性功能入口,旧的实验开关会自动清理。',
        en: 'The interactive canvas, encrypted blocks and the experimental features entry are gone; old experiment toggles are cleaned up automatically.',
      },
      {
        zh: '回复中途断掉或返回空白时会自动补救:空白回复自动重试,写到一半断掉的会接着原文续写完。',
        en: 'Interrupted replies recover on their own: a blank reply is retried, and one cut off mid-sentence picks up where it stopped.',
      },
    ],
  },
  {
    date: '2026-09-25',
    items: [
      {
        zh: '网络断开或刷新页面不会再打断回复,模型在后台继续生成,重新打开对话就能接着看。',
        en: 'Losing your connection or reloading the page no longer interrupts a reply: it keeps generating in the background and is waiting when you reopen the chat.',
      },
      {
        zh: '模型繁忙时可自动换用备用模型回答,这段对话之后继续用它;点「切回原模型」即可换回。',
        en: 'When a model is busy, a backup model can answer and stays on for the rest of the chat; "Switch back" returns to the original.',
      },
    ],
  },
  {
    date: '2026-09-24',
    items: [
      {
        zh: '模型繁忙时更不容易失败:会自动换线路重试,等太久时还能一键改用其他模型重新生成。',
        en: 'Busy models fail less often: requests retry on another endpoint, and after a long wait you can regenerate with a different model in one click.',
      },
      {
        zh: '修复拖入图片或 PDF 时误报「当前模型不支持读取图片/PDF」的问题。',
        en: 'Fixed a false "this model cannot read images/PDFs" error when dragging in an image or PDF.',
      },
      {
        zh: '修复正常结束的回复被误标为「输出可能不完整」的问题;消息发送失败时,输入的文字和附件会留在输入框里。',
        en: 'Fixed replies that finished normally being flagged as possibly incomplete; when a message fails to send, your text and attachments stay in the composer.',
      },
    ],
  },
  {
    date: '2026-09-23 · v1.1.5',
    items: [
      {
        zh: '在普通对话里也能让模型画图,图片直接显示在对话中,每天有次数上限。',
        en: 'You can ask for images in an ordinary chat; they appear inline, up to a daily limit.',
      },
      {
        zh: '点击对话里提到的工作区文件,可以直接打开预览。',
        en: 'Workspace files mentioned in a chat open in a preview when clicked.',
      },
    ],
  },
  {
    date: '2026-09-22',
    items: [
      {
        zh: '工作区文件预览新增复制按钮,一键复制文件内容。',
        en: 'The workspace file preview has a copy button for the whole file.',
      },
      {
        zh: '模型服务出故障时会自动切换到备用线路,对话不中断。',
        en: 'If a model service fails, requests move to a backup endpoint without interrupting the chat.',
      },
    ],
  },
  {
    date: '2026-09-21',
    items: [
      {
        zh: '模型繁忙时会自动等待重试并显示进度,可随时取消;实在不行时问题和附件都会保留,点一下就能重试。',
        en: 'When a model is busy, the app waits and retries with visible progress and a cancel button; if it still fails, your question and attachments are kept for a one-click retry.',
      },
    ],
  },
  {
    date: '2026-09-20 · v1.1.2',
    items: [
      {
        zh: '每条消息可以带更多附件(默认最多 20 个)。',
        en: 'A message can carry more attachments (up to 20 by default).',
      },
      {
        zh: '长代码块可以折叠并显示总行数,短代码块的工具栏更简洁。',
        en: 'Long code blocks collapse and show their line count; short ones get a simpler toolbar.',
      },
    ],
  },
  {
    date: '2026-09-17',
    items: [
      {
        zh: '设置里新增「附件存储」:查看自己的附件占了多少空间,可按对话整理和清理。',
        en: 'New "Attachment storage" in settings: see how much space your attachments use and clear them out chat by chat.',
      },
      {
        zh: '修复手机上设置和管理后台无法往下滑的问题。',
        en: 'Fixed settings and the admin console not scrolling on phones.',
      },
    ],
  },
  {
    date: '2026-09-16',
    items: [
      {
        zh: '只有思考过程没有正文、或没有正常结束的回复,会标记「输出可能不完整」并提供重新生成。',
        en: 'A reply that is all reasoning and no answer, or that ended abnormally, is flagged as possibly incomplete with a regenerate option.',
      },
    ],
  },
  {
    date: '2026-09-15',
    items: [
      {
        zh: '模型繁忙时的提示更准确,不会再让人误以为是自己的额度用完了。',
        en: 'Busy-model messages are clearer and no longer read as if you had run out of quota.',
      },
    ],
  },
  {
    date: '2026-09-14',
    items: [
      {
        zh: '手机和平板上按回车改为换行,点发送按钮才发送;电脑上仍是回车发送。',
        en: 'On phones and tablets Enter inserts a line break and the send button sends; on desktop Enter still sends.',
      },
    ],
  },
  {
    date: '2026-09-13',
    items: [
      {
        zh: '手机上输入栏重新排布,工具按钮不会再把发送按钮挤出屏幕。',
        en: 'The mobile composer was rearranged so the tool buttons no longer push send off-screen.',
      },
      {
        zh: '输入栏去掉「画布」按钮,是否附带互动组件由模型按需决定。',
        en: 'The canvas button is gone from the composer; the model decides when to attach an interactive component.',
      },
      {
        zh: '复制回答正文时不会再带上引用编号。',
        en: 'Copying an answer no longer brings the citation numbers along.',
      },
    ],
  },
  {
    date: '2026-09-12 · v1.1.0',
    items: [
      {
        zh: '对话工作区(Beta):助手会把长文、方案、代码写成文件并直接在文件上修改;点顶栏「文件」可预览、编辑和下载。',
        en: 'Chat workspace (beta): the assistant writes long documents, plans and code into files and edits them in place; "Files" in the header previews, edits and downloads them.',
      },
      {
        zh: '助手可以在隔离环境里运行代码,帮你做数据分析、画图表、把 Markdown 转成 Word 或 PDF。',
        en: 'The assistant can run code in an isolated sandbox to analyse data, draw charts, or convert Markdown to Word or PDF.',
      },
      {
        zh: '技能:遇到匹配的任务时,助手会按预先准备好的做法完成,比如生成 Word 报告、数据分析出图、导出 PDF。',
        en: 'Skills: for tasks that match one, the assistant follows a prepared recipe — Word reports, charted data analysis, PDF exports.',
      },
      {
        zh: '子代理:复杂任务可以拆给多个子代理同时处理,对话里能看到每一步进展。',
        en: 'Subagents: complex tasks can be split across several subagents working in parallel, with their progress visible in the chat.',
      },
      {
        zh: '「设置 → 对话偏好」新增「智能工具」开关,关掉后助手只用文字回答。',
        en: 'Settings → Chat preferences has an "Agent tools" switch; turn it off and the assistant answers with text only.',
      },
      {
        zh: '联网搜索的回答每句都标出引用编号,悬停查看来源,点击直达。',
        en: 'Web-search answers carry a citation number on every sentence — hover for the source, click to open it.',
      },
    ],
  },
  {
    date: '2026-09-09',
    items: [
      {
        zh: '实验性功能新增「显示加密块」,可查看和复制 Gemini 回复附带的思考签名。',
        en: 'New experimental option "Show encrypted blocks" reveals and copies the thinking signatures attached to Gemini replies.',
      },
    ],
  },
  {
    date: '2026-09-06 · v1.0.0',
    items: [
      {
        zh: '代码块显示行号(复制时不会带上),对话区域加宽,长代码和表格更好读。',
        en: 'Code blocks show line numbers (never copied along), and the chat column is wider so long code and tables read better.',
      },
      {
        zh: '修复一长串网址或符号把对话框撑出屏幕的问题。',
        en: 'Fixed a long URL or run of symbols stretching the chat past the screen edge.',
      },
      {
        zh: '长对话里早先上传的文档不会被遗忘,续聊时模型仍能读到。',
        en: 'Documents uploaded earlier in a long chat are no longer forgotten — the model can still read them later on.',
      },
      {
        zh: '从 Open WebUI 迁移来的对话附件更完整,模型名称也更简洁。',
        en: 'Attachments on chats migrated from Open WebUI come across more completely, and model names are tidier.',
      },
      {
        zh: '部分模型可能设有每日或每周用量上限,模型选择器和新对话页会显示你已用了多少。',
        en: 'Some models have a daily or weekly usage limit; the model picker and the new-chat page show how much you have used.',
      },
    ],
  },
  {
    date: '2026-09-03 — 09-04',
    items: [
      {
        zh: '设置左下角新增「实验性功能」,收纳还在打磨中的新玩法,默认关闭,只对自己生效。',
        en: 'New "Experimental features" at the bottom left of settings collects things still being polished — off by default, and only for you.',
      },
      {
        zh: '互动画布(实验性):开启后,适合用图表或交互展示的内容,回答下方会附一个可以直接操作的小组件。',
        en: 'Interactive canvas (experimental): when it suits the content, an answer comes with a small interactive component below it.',
      },
    ],
  },
  {
    date: '2026-09-02',
    items: [
      {
        zh: '在「设置 → 对话偏好」写下你的背景和想要的回复方式,每个对话都会自动带上。',
        en: 'Describe your background and how you want replies in Settings → Chat preferences, and every chat picks it up automatically.',
      },
      {
        zh: '按 Ctrl/Cmd+F 可在当前对话里查找,逐个跳转到匹配处。',
        en: 'Ctrl/Cmd+F searches within the current chat and steps through the matches.',
      },
      {
        zh: '消息可以收藏,集中在侧栏「收藏」页查看。',
        en: 'Messages can be bookmarked and reviewed together on the Bookmarks page in the sidebar.',
      },
      {
        zh: '可以让助手在调用工具前先问你,允许后再执行。',
        en: 'You can have the assistant ask before it calls a tool and wait for your approval.',
      },
      {
        zh: '切到别的窗口时,回复、绘图、PPT 完成会弹出系统通知。',
        en: 'While you are in another window, a system notification tells you when a reply, image or deck is done.',
      },
      {
        zh: '回复里的 Mermaid 流程图、时序图会直接画出来。',
        en: 'Mermaid flowcharts and sequence diagrams in a reply are rendered inline.',
      },
      {
        zh: '点击对话里的图片可在当前页放大查看和下载。',
        en: 'Click an image in a chat to enlarge and download it without leaving the page.',
      },
    ],
  },
  {
    date: '2026-09-01',
    items: [
      {
        zh: '项目可以共享给指定成员或所有人;每个人在项目里的对话仍只有自己可见。',
        en: 'A project can be shared with chosen members or with everyone; each person\'s chats inside it stay private to them.',
      },
      {
        zh: '划词追问:选中消息里的一段文字,点「引用追问」即可针对它提问。',
        en: 'Ask about a selection: highlight part of a message and click "Quote and ask" to question just that passage.',
      },
      {
        zh: '设置里可以查看自己在哪些设备上登录,并远程退出。',
        en: 'Settings lists the devices you are signed in on and can sign them out remotely.',
      },
      {
        zh: '主题新增「跟随系统」并设为默认,自动切换深浅色。',
        en: '"Match system" is the new default theme and follows light and dark automatically.',
      },
      {
        zh: '设置改为弹窗打开,不再离开当前页面。',
        en: 'Settings opens as a dialog instead of taking you off the page.',
      },
    ],
  },
  {
    date: '2026-08-31 · v0.9.0',
    items: [
      {
        zh: '回复被截断时会提示「输出可能不完整」,并可一键重新生成。',
        en: 'A truncated reply is marked as possibly incomplete, with a one-click regenerate.',
      },
      {
        zh: '绘图工坊:模型只回文字不出图时不再报错,可以直接接着回复它。',
        en: 'Image Studio: a text-only reply with no image is no longer an error — you can just answer it.',
      },
      {
        zh: '翻译工坊新增「对照阅读」,原文和译文按段落对齐。',
        en: 'Translation Studio adds side-by-side reading, aligning source and translation paragraph by paragraph.',
      },
      {
        zh: '修复被中文引号或括号包住的加粗文字显示不出来的问题。',
        en: 'Fixed bold text not rendering when wrapped in Chinese quotation marks or brackets.',
      },
    ],
  },
  {
    date: '2026-08-30',
    items: [
      {
        zh: '修复翻译和 OCR 输出几十个字就中断的问题。',
        en: 'Fixed translation and OCR output stopping after a few dozen characters.',
      },
      {
        zh: '服务出错时显示简短的中文说明,不再弹出一整页网页代码。',
        en: 'Service errors show a short explanation instead of a full page of raw HTML.',
      },
    ],
  },
  {
    date: '2026-08-29',
    items: [
      {
        zh: '新增翻译工坊:左右对照,自动识别语言,可选快速或思考模式,也能自定义翻译风格。',
        en: 'New Translation Studio: side-by-side panes, automatic language detection, a fast or thinking mode, and custom translation styles.',
      },
      {
        zh: '侧栏工坊改为图标栏,可钉选常用工坊;设置、主题和退出收进账号菜单。',
        en: 'The studios became an icon row in the sidebar with pinning; settings, theme and sign-out moved into the account menu.',
      },
      {
        zh: '修复侧栏「新建项目」按钮点了没反应的问题。',
        en: 'Fixed the sidebar\'s "New project" button doing nothing when clicked.',
      },
    ],
  },
  {
    date: '2026-08-28',
    items: [
      {
        zh: '手机上输入框默认收成一行,点一下再展开完整工具栏。',
        en: 'On phones the composer starts as a single line and expands to the full toolbar on tap.',
      },
    ],
  },
  {
    date: '2026-08-25 · v0.8.0',
    items: [
      {
        zh: '新增 OCR 工坊:上传 PDF 或图片,识别成可复制、可下载的全文。',
        en: 'New OCR Studio: upload a PDF or image and get the full text back, ready to copy or download.',
      },
      {
        zh: '对话可以导出为 Markdown 或 JSON,入口在侧栏对话菜单。',
        en: 'Chats export to Markdown or JSON from the chat menu in the sidebar.',
      },
      {
        zh: '新增站内公告横幅,看过可以关掉。',
        en: 'New announcement banner, dismissible once you have read it.',
      },
      {
        zh: '「我的用量」可以看到大致花费。',
        en: '"My usage" now shows an estimated cost.',
      },
      {
        zh: '支持「添加到主屏幕」,像 App 一样打开。',
        en: 'Add to home screen and open it like an app.',
      },
      {
        zh: '支持语音输入和朗读回复(语音输入需 Chrome 或 Edge)。',
        en: 'Voice input and read-aloud replies (voice input needs Chrome or Edge).',
      },
      {
        zh: '修复价格金额被误显示成公式、表格里换行不生效的问题。',
        en: 'Fixed prices being rendered as formulas and line breaks being ignored inside tables.',
      },
    ],
  },
  {
    date: '2026-08-24 · v0.7.2',
    items: [
      {
        zh: '新对话页展示模型头像、名称和简介。',
        en: 'The new-chat page shows the model\'s avatar, name and description.',
      },
      {
        zh: '快捷指令可以自己新增、编辑和删除,最多 6 条。',
        en: 'Quick prompts can be added, edited and deleted, up to six of them.',
      },
    ],
  },
  {
    date: '2026-08-23 · v0.7.1',
    items: [
      {
        zh: '侧栏对话按日期分组,输入区改为两行布局。',
        en: 'Sidebar chats are grouped by date, and the composer moved to a two-row layout.',
      },
      {
        zh: '消息显示发送时间,点信息图标可查看回复统计。',
        en: 'Messages show when they were sent, and the info icon opens reply statistics.',
      },
      {
        zh: '快捷追问会跟随你提问的意图和语言。',
        en: 'Suggested follow-ups match the intent and language of your question.',
      },
      {
        zh: '修复窄屏上弹出菜单超出屏幕的问题。',
        en: 'Fixed popup menus running off the edge on narrow screens.',
      },
    ],
  },
  {
    date: '2026-08-22 · v0.7.0',
    items: [
      {
        zh: '重新生成或编辑消息会保留旧版本,用左右箭头切换。',
        en: 'Regenerating or editing a message keeps the old version; the arrows switch between them.',
      },
      {
        zh: '回复生成中也能继续发消息,会自动排队依次发送。',
        en: 'You can keep sending while a reply streams; messages queue and go out in order.',
      },
      {
        zh: '没发出去的文字和附件自动保存,切换对话或刷新后还在。',
        en: 'Unsent text and attachments are saved, and survive switching chats or reloading.',
      },
      {
        zh: '侧栏搜索可以搜到消息正文。',
        en: 'Sidebar search looks inside message bodies.',
      },
      {
        zh: '对话可以归档,收进侧栏底部。',
        en: 'Chats can be archived into a shelf at the bottom of the sidebar.',
      },
      {
        zh: '重新生成时可以让另一个模型并排作答,再选一个保留。',
        en: 'When regenerating, a second model can answer alongside the first, and you keep the one you prefer.',
      },
      {
        zh: '临时对话:不留记录,24 小时后自动删除,也可以转为正式对话。',
        en: 'Temporary chats: nothing is kept, they delete themselves after 24 hours, and you can turn one into a normal chat.',
      },
    ],
  },
  {
    date: '2026-08-21 · v0.6.5',
    items: [
      {
        zh: '对话支持上传 PDF、Word、TXT、Markdown 等文档。',
        en: 'Chats accept PDF, Word, TXT, Markdown and other documents.',
      },
      {
        zh: '可以把图片直接拖进对话框。',
        en: 'Images can be dragged straight into the composer.',
      },
    ],
  },
  {
    date: '2026-08-20',
    items: [
      {
        zh: '可以直接修改模型的回复。',
        en: 'You can edit the model\'s reply directly.',
      },
      {
        zh: '回答后会给出几条快捷追问建议。',
        en: 'Each answer comes with a few suggested follow-up questions.',
      },
      {
        zh: 'HTML/SVG 代码可以在对话里直接预览。',
        en: 'HTML and SVG code can be previewed right in the chat.',
      },
    ],
  },
  {
    date: '2026-08-19',
    items: [
      {
        zh: '模型选择器支持收藏和自定义排序。',
        en: 'The model picker supports favourites and custom ordering.',
      },
      {
        zh: '修复手机上多处页面布局问题。',
        en: 'Fixed a number of mobile layout problems.',
      },
    ],
  },
  {
    date: '2026-08-16 — 08-18',
    items: [
      {
        zh: '消息可以删除、从某条消息分出新对话,或换一个模型重新生成。',
        en: 'Messages can be deleted, branched into a new chat, or regenerated with a different model.',
      },
      {
        zh: '自动生成的对话标题可以选择带上 Emoji。',
        en: 'Auto-generated chat titles can start with an emoji if you like.',
      },
    ],
  },
  {
    date: '2026-08-12 — 08-14',
    items: [
      {
        zh: '新增项目:项目里的对话会自动带上项目指令和资料。',
        en: 'New projects: chats inside one automatically carry the project instructions and reference files.',
      },
      {
        zh: '新增绘图作品画廊,界面整体风格统一。',
        en: 'New gallery for generated images, and a more consistent look across the app.',
      },
      {
        zh: 'Gemini 模型可使用 Google 原生联网搜索。',
        en: 'Gemini models can use Google\'s native web search.',
      },
    ],
  },
  {
    date: '2026-08-04 — 08-05',
    items: [
      {
        zh: '绘图工坊:可粘贴或拖入参考图,支持快捷提示词和历史记录,离开页面也不会中断生成。',
        en: 'Image Studio: paste or drag in reference images, use quick prompts and history, and leave the page without stopping a generation.',
      },
      {
        zh: '新增 PPT 工坊:说出需求即可生成 PPT 文件。',
        en: 'New PPT Studio: describe what you need and get a PPT file.',
      },
      {
        zh: '输入栏新增「联网」开关,模型会按需上网搜索。',
        en: 'A web switch in the composer lets the model search when it needs to.',
      },
      {
        zh: '思考强度有了独立按钮,可直接拖动调节。',
        en: 'Reasoning effort has its own control you can drag to adjust.',
      },
      {
        zh: '回复或绘图完成时,浏览器标签页标题会提示。',
        en: 'The browser tab title flags a finished reply or image.',
      },
      {
        zh: 'Open WebUI 的账号和聊天记录可以迁移过来,原密码照常登录。',
        en: 'Open WebUI accounts and chat history can be migrated over, and the old passwords keep working.',
      },
    ],
  },
  {
    date: '2026-07-26 — 07-28',
    items: [
      {
        zh: '首个版本:多人共用的 AI 对话,支持流式回复、工具调用和在对话里直接生成图片。',
        en: 'First release: a shared AI chat for teams, with streaming replies, tool calls and inline image generation.',
      },
    ],
  },
] as const;
