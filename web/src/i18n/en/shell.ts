// App shell: sidebar, settings dialog, login, projects, bookmarks, release notes.
// Keys are the Chinese source strings passed to t().
export default {
  // ---- shared words ----
  '取消': 'Cancel',
  '确认': 'Confirm',
  '保存': 'Save',
  '关闭': 'Close',
  '删除': 'Delete',
  '创建': 'Create',
  '重命名': 'Rename',
  '名称': 'Name',
  '内容': 'Content',
  '描述': 'Description',
  '退出': 'Sign out',
  '收起': 'Collapse',
  '展开': 'Expand',
  '我': 'Me',
  '添加一行': 'Add row',
  '删除此行': 'Remove row',
  '拖动排序': 'Drag to reorder',
  '操作失败': 'Something went wrong',
  '保存失败': 'Failed to save',
  '删除失败': 'Failed to delete',
  '上传失败': 'Upload failed',
  '读取失败': 'Failed to load',
  '修改失败': 'Failed to update',
  '移动失败': 'Failed to move',

  // ---- studios / navigation ----
  '绘图工坊': 'Image Studio',
  '绘图': 'Images',
  'OCR 工坊': 'OCR Studio',
  'PPT 工坊': 'PPT Studio',
  '翻译工坊': 'Translation Studio',
  '翻译': 'Translate',
  '工坊': 'Studios',
  '全部工坊': 'All studios',
  '全部工坊 / 钉选': 'All studios / pin',
  '钉到图标栏': 'Pin to the icon row',
  '从图标栏移除': 'Unpin from the icon row',
  '前移': 'Move up',
  '后移': 'Move down',
  '钉选的工坊显示在侧栏图标栏,按这里的顺序排列。':
    'Pinned studios appear in the sidebar icon row, in the order set here.',
  '没有绘图工坊访问权限': 'No access to Image Studio',
  '绘图工坊需要管理员单独开通,请联系管理员为你的账号开启后再来创作。':
    'Image Studio has to be enabled for your account. Ask an admin to turn it on, then come back.',

  // ---- announcement ----
  '关闭公告(内容更新后会再次显示)': 'Dismiss (it reappears when the announcement changes)',

  // ---- sidebar ----
  '返回首页': 'Go to home',
  '收起侧栏': 'Collapse sidebar',
  '打开侧栏': 'Open sidebar',
  '展开侧栏': 'Show sidebar',
  '新建对话': 'New chat',
  '新对话': 'New chat',
  '临时对话:不写入历史记录,闲置 24 小时后自动删除':
    'Temporary chat: never saved to history, deleted after 24 hours idle',
  '收藏的消息': 'Bookmarked messages',
  '搜索对话与消息': 'Search chats and messages',
  '搜索标题与消息正文。\n支持过滤:project:项目名、pinned:true、archived:true(默认不搜归档)':
    'Searches titles and message bodies.\nFilters: project:<name>, pinned:true, archived:true (archived chats are excluded by default)',
  '搜索结果': 'Results',
  '搜索中…': 'Searching…',
  '没有匹配的对话或消息': 'No matching chats or messages',
  '置顶': 'Pinned',
  '取消置顶': 'Unpin',
  '今天': 'Today',
  '昨天': 'Yesterday',
  '近一周': 'Past week',
  '更早': 'Older',
  '已归档': 'Archived',
  '归档': 'Archive',
  '取消归档': 'Unarchive',
  '收起归档对话': 'Hide archived chats',
  '展开归档对话': 'Show archived chats',
  '还没有对话记录': 'No chats yet',
  '更多操作': 'More actions',
  '重命名对话': 'Rename chat',
  '删除对话': 'Delete chat',
  '确定删除「{title}」?此操作不可恢复。': 'Delete "{title}"? This cannot be undone.',
  '导出 Markdown': 'Export as Markdown',
  '导出 JSON': 'Export as JSON',
  '移动到项目': 'Move to project',
  '移出项目': 'Remove from project',
  '已移入「{name}」': 'Moved to "{name}"',
  '已移出项目': 'Removed from the project',
  '已取消归档': 'Unarchived',
  '已归档,可在侧栏底部或搜索 archived:true 找回':
    'Archived — find it at the bottom of the sidebar or search archived:true',
  '加载对话列表失败': 'Failed to load your chats',
  '查看全部项目': 'View all projects',
  '新建项目': 'New project',
  '在项目中新建对话': 'New chat in this project',
  '项目内还没有对话': 'No chats in this project yet',
  '把常用的要求和资料放进项目,项目里的对话会自动用上。':
    'Put recurring instructions and reference files in a project, and its chats pick them up automatically.',
  '{owner} 共享的项目': 'Shared by {owner}',
  '账号菜单': 'Account menu',
  '管理员': 'Admin',
  '用户': 'User',
  '设置': 'Settings',
  '管理后台': 'Admin',
  '固定为另一种主题;要跟随系统请到「设置 → 外观」':
    'Pin the other theme. To match the system, go to Settings → Appearance',
  '切换到浅色主题': 'Switch to light theme',
  '切换到深色主题': 'Switch to dark theme',
  '退出登录': 'Sign out',

  // ---- release notes ----
  '查看更新日志': "See what's new",
  '更新日志 · v{version}': "What's new · v{version}",
  '构建时间': 'Built',

  // ---- settings: sections ----
  '设置分区': 'Settings sections',
  '账号': 'Account',
  '对话偏好': 'Chat preferences',
  '外观': 'Appearance',
  '登录设备': 'Signed-in devices',
  '我的用量': 'My usage',
  '附件存储': 'Attachment storage',

  // ---- settings: account ----
  '个人资料': 'Profile',
  '用户名不可修改;昵称会显示在界面各处。':
    'Your username cannot be changed; your display name is what appears around the app.',
  '用户名': 'Username',
  '昵称': 'Display name',
  '未设置': 'Not set',
  '保存资料': 'Save profile',
  '资料已保存': 'Saved',
  '修改密码': 'Change password',
  '新密码至少 8 位;修改后其他设备会被登出,当前设备保持登录。':
    'New passwords need at least 8 characters. Changing it signs out your other devices; this one stays signed in.',
  '原密码': 'Current password',
  '新密码': 'New password',
  '确认新密码': 'Confirm new password',
  '至少 8 位字符': 'At least 8 characters',
  '两次输入的新密码不一致': 'The new passwords do not match',
  '新密码至少 8 位': 'The new password needs at least 8 characters',
  '密码已修改': 'Password changed',

  // ---- settings: chat preferences ----
  '全局自定义指令': 'Custom instructions',
  '告诉模型关于你的情况和你希望它怎么回复,会自动加在每次对话的系统提示前面;单个对话的系统提示可以覆盖它。':
    'Tell the model about yourself and how you want it to reply. This goes before every chat\'s system prompt, and a chat\'s own system prompt can override it.',
  '例如:\n我是后端工程师,主要用 Go 和 PostgreSQL。\n回答请用中文,先给结论再解释;代码示例不要省略错误处理;不确定的地方明确说不确定。':
    'For example:\nI am a backend engineer working mostly in Go and PostgreSQL.\nLead with the conclusion, then explain. Keep error handling in code samples. Say so when you are unsure.',
  '不影响绘图、OCR、翻译等工坊。': 'Does not affect the Image, OCR or Translation studios.',
  '已保存,之后的每次对话都会带上': 'Saved — every new chat will include it',
  '跟随账号保存,在任何设备上都生效。': 'Saved to your account and applied on every device.',
  '智能工具': 'Agent tools',
  '允许助手使用管理员开放的能力:联网搜索、把长内容写成文件、在沙盒里运行代码、生成图片、调用技能或子代理。文件显示在「文件」标签里,生成的图片直接显示在对话中。':
    'Let the assistant use the capabilities your admin has enabled: web search, writing long content to files, running code in a sandbox, generating images, and calling skills or subagents. Files appear under the Files tab; generated images appear inline in the chat.',
  '标题自动加 emoji': 'Start chat titles with an emoji',
  '开启后,自动生成的对话标题会以一个匹配主题的 emoji 开头':
    'Auto-generated chat titles begin with an emoji that fits the topic',
  '每次调用 MCP 工具前都询问我': 'Ask me before every MCP tool call',
  '开启后,模型每次想调用任何 MCP 工具都会先暂停,由你点「允许」或「拒绝」。关闭时只有管理员标记为需确认的服务器才会询问':
    'The model pauses before every MCP tool call and waits for you to allow or deny it. When off, only servers your admin marked as needing confirmation will ask.',
  '快捷指令在新对话页直接编辑;模型收藏与排序在输入框的模型选择器里调整;翻译场景在翻译工坊页面管理。':
    'Quick prompts are edited on the new-chat page, model favorites and ordering in the composer\'s model picker, and translation styles on the Translation Studio page.',
  '后台完成通知': 'Notifications when work finishes',
  '只在这台设备的这个浏览器上生效;通知权限由浏览器管理。':
    'Applies to this browser on this device only; the permission itself is managed by your browser.',
  '切到别的标签页或窗口时,完成后弹系统通知':
    'Show a system notification when work finishes while you are in another tab or window',
  '当前浏览器不支持系统通知': 'This browser does not support system notifications',
  '浏览器已拒绝本站的通知权限,需要在站点设置中重新允许':
    'Your browser blocked notifications for this site; allow them again in its site settings',
  '浏览器已拒绝本站的通知权限,请在地址栏的站点设置里重新允许':
    'Your browser blocked notifications for this site. Allow them again from the site settings in the address bar.',
  '未获得通知权限': 'Notification permission was not granted',
  '回复生成、批量绘图、PPT 生成完成时通知;点击通知直接回到对应页面。标签页标题上的 ● 提示不受影响':
    'Notifies you when a reply, a batch of images or a deck is done; clicking the notification takes you straight back. The ● marker in the tab title is unaffected.',

  // ---- settings: appearance ----
  '主题': 'Theme',
  '保存在本机浏览器,立即生效。「跟随系统」会随 iOS / Android / macOS / Windows 的深浅色设置实时切换。':
    'Stored in this browser and applied right away. "Match system" follows the light/dark setting on iOS, Android, macOS and Windows as it changes.',
  '跟随系统': 'Match system',
  '浅色': 'Light',
  '深色': 'Dark',
  '当前系统为深色': 'System is dark',
  '当前系统为浅色': 'System is light',

  // ---- settings: devices ----
  '当前账号在哪些浏览器上保持着登录。发现不认识的设备,先退出它,再修改密码。':
    'Browsers where this account is still signed in. If you do not recognise one, sign it out and then change your password.',
  '退出其他设备': 'Sign out other devices',
  '除当前浏览器外,所有已登录的设备都需要重新登录。':
    'Every signed-in device except this browser will have to sign in again.',
  '已退出 {n} 台其他设备': 'Signed out {n} other device(s)',
  '没有其他已登录的设备': 'No other devices are signed in',
  '该设备已退出登录': 'That device has been signed out',
  '加载失败(服务端可能还是旧版本)': 'Failed to load (the server may still be an older version)',
  '当前设备': 'This device',
  '最近活动 {last} · 登录于 {created}': 'Last active {last} · signed in {created}',
  '未知设备': 'Unknown device',
  '浏览器': 'browser',
  '微信': 'WeChat',

  // ---- settings: usage ----
  '最近 30 天的 Token 消耗与请求统计。': 'Token usage and request counts over the last 30 days.',
  '用量数据加载失败': 'Failed to load usage data',
  '加载用量数据失败': 'Failed to load usage data',
  '总 Tokens': 'Total tokens',
  '折算成本': 'Estimated cost',
  '按各模型当前单价估算': 'Estimated from each model\'s current rate',
  '请求次数': 'Requests',
  '生成图片': 'Generate image',
  '本月配额': 'This month\'s quota',
  '已用': 'Used',
  ' tokens,每月 1 日重新计算': ' tokens, reset on the 1st of each month',
  ' tokens,每月 1 日重新计算;本月配额已用完':
    ' tokens, reset on the 1st of each month — this month\'s quota is used up',
  '近 30 天每日 Tokens': 'Daily tokens, last 30 days',
  '按模型统计': 'By model',
  '暂无数据': 'No data yet',
  '模型': 'Model',
  '次数': 'Requests',

  // ---- settings: storage ----
  '上传到对话里的文件都计入这个配额。': 'Every file you upload to a chat counts towards this quota.',
  '附件列表加载失败': 'Failed to load your attachments',
  '加载附件列表失败': 'Failed to load your attachments',
  ',共 {n} 个文件': ' · {n} file(s)',
  ',其中 ': ' · ',
  ' 在 {n} 段对话里': ' across {n} chat(s)',
  ';配额已满,新附件无法上传': ' — quota full, new attachments cannot be uploaded',
  '还没有上传过附件': 'No attachments uploaded yet',
  '按对话': 'By chat',
  '按文件': 'By file',
  '切换排序': 'Change sorting',
  '占用最多在前': 'Largest first',
  '最久没用在前': 'Least recently used first',
  '大文件排在前面': 'Largest files first',
  '附件都还没发进对话': 'No attachments have been sent in a chat yet',
  '不再需要的对话可以整段删除,附件会一起释放;很久不用的老对话也还占着空间。':
    'Delete a whole chat you no longer need and its attachments go with it. Old chats nobody opens still take up space.',
  '打开这段对话': 'Open this chat',
  '未命名对话': 'Untitled chat',
  '未命名文件': 'Untitled file',
  ' · {count} 个附件 · 最后活跃 {date}': ' · {count} attachment(s) · last active {date}',
  '删除这段对话': 'Delete this chat',
  '确定要删掉这段对话吗?「{name}」及其中 {count} 个附件({size})会一起删除。':
    'Delete this chat? "{name}" and its {count} attachment(s) ({size}) go with it.',
  '再确认一次': 'One more check',
  '真的要删掉「{name}」吗?对话内容和附件删除后无法恢复。':
    'Really delete "{name}"? The messages and attachments cannot be recovered.',
  '已删除对话,释放 {size}': 'Chat deleted, {size} freed',
  '删除附件': 'Delete attachment',
  '删除「{name}」({size})?此操作不可撤销。': 'Delete "{name}" ({size})? This cannot be undone.',
  '附件已删除': 'Attachment deleted',
  '在对话「{title}」中': 'In chat "{title}"',
  '去对话删除': 'Delete in chat',

  // ---- login ----
  '初始化管理员账号': 'Set up the admin account',
  '登录 {brand}': 'Sign in to {brand}',
  '创建账号': 'Create an account',
  '这是第一次启动,注册的首个账号将自动获得管理员权限。':
    'This is the first start-up, so the first account you register becomes the administrator.',
  '请输入你的账号信息以继续。': 'Enter your credentials to continue.',
  '填写下列信息完成注册。': 'Fill in the details below to register.',
  '密码': 'Password',
  '确认密码': 'Confirm password',
  '请稍候…': 'Please wait…',
  '创建管理员账号': 'Create admin account',
  '登录': 'Sign in',
  '注册': 'Sign up',
  '返回登录': 'Back to sign in',
  '还没有账号?': 'No account yet?',
  '已有账号?': 'Already have an account?',
  '两次输入的密码不一致': 'The passwords do not match',
  '已创建管理员账号,欢迎使用': 'Admin account created — welcome',

  // ---- error reset ----
  '页面遇到了问题': 'Something went wrong with this page',
  '如果你是从旧面板(如 Open WebUI)迁移过来的用户,浏览器里残留的旧登录信息(Cookies)可能导致页面无法正常打开。':
    'If you came from an older panel such as Open WebUI, leftover sign-in cookies in your browser can stop this page from loading.',
  '点击下面的按钮清除本站的登录状态与缓存,然后重新登录即可。':
    'Use the button below to clear this site\'s sign-in state and cache, then sign in again.',
  '清除登录信息,重新登录': 'Clear sign-in data and sign in again',
  '先试试直接返回首页': 'Try going back to the home page first',

  // ---- bookmarks ----
  '收藏': 'Bookmarks',
  '{n} 条收藏的消息': '{n} bookmarked message(s)',
  '筛选收藏': 'Filter bookmarks',
  '还没有收藏': 'No bookmarks yet',
  '在任意消息的操作栏点击书签图标,就会收进这里,方便以后快速找回。':
    'Click the bookmark icon on any message and it lands here for later.',
  '没有匹配的收藏': 'No matching bookmarks',
  '打开所在对话并定位到这条消息': 'Open the chat at this message',
  '打开对话': 'Open chat',
  '取消收藏': 'Remove bookmark',
  '(无文字内容)': '(no text content)',
  '展开全文': 'Show more',

  // ---- projects list ----
  '项目': 'Projects',
  '把常用的要求和参考资料放进项目,里面的每个对话都会自动用上':
    'Put recurring instructions and reference files in a project, and every chat inside it uses them',
  '加载项目列表失败': 'Failed to load your projects',
  '还没有项目': 'No projects yet',
  '项目就像一个文件夹:把给 AI 的固定要求和参考资料放进去,之后在项目里开的每个对话都会自动带上这些内容,不用每次重复说。':
    'A project works like a folder: put your standing instructions for the AI and your reference files in it, and every chat you start there carries them automatically.',
  '项目就像一个文件夹:把给 AI 的固定要求(比如「用中文回答、语气正式」)和参考资料放进去,之后在项目里开的每个对话都会自动带上这些内容,不用每次重复说。':
    'A project works like a folder: put your standing instructions for the AI (say, "answer in English, keep the tone formal") and your reference files in it, and every chat you start there carries them automatically.',
  '已共享给所有人': 'Shared with everyone',
  '已共享给 {n} 位成员': 'Shared with {n} member(s)',
  '{owner} 共享 · {role}': 'Shared by {owner} · {role}',
  '暂无描述': 'No description',
  '{n} 个对话': '{n} chat(s)',
  '{n} 份资料': '{n} file(s)',
  '创建项目失败': 'Failed to create the project',
  '项目名称': 'Project name',
  '例如:季度复盘、API 集成…': 'e.g. Quarterly review, API integration…',

  // ---- project page ----
  '项目不存在或已被删除': 'This project does not exist or was deleted',
  '回到对话': 'Back to chat',
  '共享设置': 'Sharing',
  '编辑名称与描述': 'Edit name and description',
  '删除项目': 'Delete project',
  '将删除项目「{name}」及其全部资料。项目里的对话会保留,只是以后不再自动带上项目的要求和资料。':
    'This deletes the project "{name}" and all of its reference files. Its chats stay, but they will no longer pick up the project\'s instructions and files.',
  '项目已删除': 'Project deleted',
  '共享给{scope}': 'Shared with {scope}',
  ' · {n} 位成员': ' · {n} member(s)',
  '由 {owner} 共享': 'Shared by {owner}',
  '项目内对话': 'Chats in this project',
  '还没有对话': 'No chats yet',
  '在上方输入框说点什么,就会在这个项目里开启第一个对话。':
    'Say something in the composer above to start the first chat in this project.',
  '项目指令': 'Project instructions',
  '写给 AI 的固定要求,项目里的每个对话都会自动遵守,不用每次重复说。':
    'Standing instructions for the AI. Every chat in this project follows them, so you never have to repeat yourself.',
  '写给 AI 的固定要求,项目里的每个对话都会自动遵守。你只有查看权限。':
    'Standing instructions for the AI, followed by every chat in this project. You have view-only access.',
  '例如:回答一律用中文,代码示例用 TypeScript,引用资料时注明文档名…':
    'e.g. Always answer in English, use TypeScript for code samples, name the file whenever you cite one…',
  '所有者还没有写项目指令。': 'The owner has not written any project instructions yet.',
  '参考资料': 'Reference files',
  '仅支持文本文件(txt / md / 代码等)。': 'Text files only (txt, md, code and the like).',
  '新建文本': 'New text file',
  '上传文档': 'Upload files',
  '上传或新建项目相关的文档、规范或笔记,模型回答时会优先依据它们。':
    'Upload or write documents, specs or notes for this project, and the model will answer from them first.',
  '这个项目还没有参考资料。': 'This project has no reference files yet.',
  '{name} · {chars} 字符': '{name} · {chars} characters',
  '{name} · {chars} 字符 · 点击编辑': '{name} · {chars} characters · click to edit',
  '删除文档': 'Delete file',
  '将从项目资料中移除「{name}」。': 'This removes "{name}" from the project\'s reference files.',
  '{docs} 个文档 · {chars} 字符': '{docs} file(s) · {chars} characters',
  '资料不多,每次对话都整篇提供给模型':
    'Small enough that every chat gets all of it in full',
  '长上下文模型(如 Claude、Gemini)整篇读取;其他模型放不下的部分按需检索':
    'Long-context models (Claude, Gemini) read all of it; for other models the overflow is retrieved on demand',
  '放得下的文档整篇提供,其余由模型按需检索':
    'Files that fit are provided in full; the rest is retrieved on demand',
  '每个项目最多 {n} 个文档': 'A project can hold at most {n} files',
  '已添加 {n} 个文档': 'Added {n} file(s)',
  '「{name}」过大': '"{name}" is too large',
  '「{name}」不是文本文件': '"{name}" is not a text file',
  '「{name}」是空文件': '"{name}" is empty',
  '「{name}」超出单文档上限({limit} 字符)': '"{name}" exceeds the per-file limit of {limit} characters',
  '资料总量将超出上限,「{name}」未上传':
    'That would exceed the total size limit, so "{name}" was not uploaded',
  '项目指令已保存': 'Project instructions saved',
  '编辑项目': 'Edit project',
  '一句话说明这个项目是做什么的,显示在页头。':
    'One line about what this project is for; it shows in the header.',

  // ---- project sharing ----
  '共享项目': 'Share project',
  '共享的是项目指令和参考资料;每个人在项目里的对话仍然只有自己能看到。':
    'Sharing covers the project instructions and reference files. Each person\'s chats inside the project stay private to them.',
  '谁可以使用这个项目': 'Who can use this project',
  '仅自己': 'Only me',
  '所有人': 'Everyone',
  '指定成员': 'Specific people',
  '只有你能看到': 'Only you can see it',
  '下方名单里的人可以用': 'The people listed below can use it',
  '所有登录用户都可以用': 'Every signed-in user can use it',
  '额外授予编辑权限': 'Grant extra edit access',
  '成员': 'Members',
  '所有人默认只能查看和使用;在这里列出的人还可以修改项目指令、增删资料。':
    'Everyone can view and use it by default; people listed here can also change the instructions and add or remove files.',
  '「可编辑」的成员可以修改项目指令、增删资料;「可查看」只能使用。':
    'Editors can change the instructions and add or remove files; viewers can only use the project.',
  '项目设为「仅自己」时,名单会保留但不生效。':
    'While the project is set to "Only me" the list is kept but has no effect.',
  '可查看': 'Viewer',
  '可编辑': 'Editor',
  '所有者': 'Owner',
  '移除': 'Remove',
  '加载用户…': 'Loading users…',
  '添加成员…': 'Add a member…',
  '没有更多可添加的用户': 'No more users to add',
  '共享设置已保存': 'Sharing settings saved',
  '{name}({username})': '{name} ({username})',

  // ---- project documents ----
  '资料': 'Reference file',
  '编辑资料': 'Edit reference file',
  '新建资料': 'New reference file',
  '放弃修改': 'Discard changes',
  '这份资料的修改还没有保存,确定关闭吗?': 'This file has unsaved changes. Close anyway?',
  '请填写资料名称': 'Give the file a name',
  '资料内容不能为空': 'The file cannot be empty',
  '超出单文档上限({limit} 字符)': 'Exceeds the per-file limit of {limit} characters',
  '如 产品规范.md': 'e.g. product-spec.md',
  '{used} / {limit} 字符': '{used} / {limit} characters',
  '这份资料已删除,或你没有该项目的访问权限':
    'This file was deleted, or you do not have access to its project',
  '打开「{project}」的资料「{doc}」': 'Open "{doc}" from "{project}"',
  '打开「{project}」的资料「{doc}」,可修改': 'Open "{doc}" from "{project}" — you can edit it',
  '项目「{project}」的参考资料(只读)': 'Reference file in the project "{project}" (read-only)',
  '项目「{project}」的参考资料,保存后新的回答会按修改后的内容来':
    'Reference file in the project "{project}" — once saved, new answers use the updated content',
} satisfies Record<string, string>;
