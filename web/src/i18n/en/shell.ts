// App shell: sidebar, settings dialog, login, projects, bookmarks, release notes.
// Keys are the Chinese source strings passed to t().
export default {
  '允许跨项目检索资料': 'Allow reference searches from other chats',
  '拥有本项目访问权限的用户,可在其他对话或项目中明确要求搜索这里的参考资料。每轮单独授权,例如「搜索项目资料中的报销规定」。': 'People with access to this project can explicitly request its references from other chats or projects. Each turn needs a new request, for example: “Search project references for the reimbursement policy.”',

  "项目设置": "Project settings",
  "项目对话共享工作区": "Share a workspace across project chats",
  "开启后,同一用户在本项目中的对话共用文件,每位成员各自独立。已有文件自动合并,同名且内容不同的文件另存保留。关闭后恢复各对话工作区,项目文件保留供下次开启。": "When enabled, each user shares files across their own chats in this project. Each member has separate files. Existing files are merged automatically; files with the same name but different contents are kept as separate copies. Turning this off restores individual chat workspaces; project files remain available when it is enabled again.",
  "你的项目对话共用一个工作区": "Your chats in this project share one workspace",
  "将删除项目「{name}」、全部资料和各成员的项目工作区。项目里的对话及各对话独立工作区会保留。": "Delete “{name}”, all reference documents and every member’s project workspace. Chats and their individual workspaces will be kept.",
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
  '固定为另一种主题;要跟随系统请到「设置 → 通用」':
    'Pin the other theme. To match the system, go to Settings → General',
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
  '通用': 'General',
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
  '回复生成、批量绘图、PPT 生成完成时通知;点击通知直接回到对应页面。标签页标题和图标上的完成标记不受影响':
    'Notifies you when a reply, a batch of images or a deck is done; clicking the notification takes you straight back. The marker on the tab title and icon works either way.',
  'iPhone / iPad 上的 Safari 网页不支持系统通知': 'Safari on iPhone / iPad does not support system notifications for websites',
  '重新允许:电脑上点地址栏左侧的站点信息图标 →「通知」改为「允许」,再刷新页面;手机 Chrome:右上角 ⋮ →「设置」→「网站设置」→「通知」。':
    'To allow them again: on a computer, click the site info icon at the left of the address bar → set Notifications to Allow, then reload. In Chrome on a phone: ⋮ at the top right → Settings → Site settings → Notifications.',
  '手机上切到别的 App 后,浏览器可能暂停页面,提醒不一定及时。':
    'On a phone, the browser may pause the page once you switch to another app, so notifications can arrive late.',
  '没看到通知?检查系统的勿扰模式和浏览器的通知设置。': 'No notification? Check Do Not Disturb and your browser’s notification settings.',
  '测试通知': 'Test notification',
  '通知已开启,回复完成时会这样提醒你。': 'Notifications are on. This is how you will hear about finished replies.',
  '发送测试通知': 'Send a test notification',

  // ---- finished-work markers & the 开启通知 banner ----
  '回复完成': 'Reply finished',
  '等你确认': 'Waiting for you',
  '等你回复': 'Waiting for your reply',
  '出错了': 'Something failed',
  '已完成': 'Done',
  '刚才的任务完成时你不在这个页面。开启系统通知,下次完成时会直接提醒你。':
    'Something finished while you were away from this page. Turn on system notifications to be told next time.',
  '不用了': 'No thanks',
  '开启通知': 'Turn on notifications',
  '已开启:切到别的页面时,完成后会弹系统通知': 'Turned on: you will get a system notification when work finishes while you are elsewhere',
  '浏览器拒绝了通知权限;以后可以在地址栏左侧的站点设置里重新允许':
    'The browser blocked notifications; you can allow them again later from the site settings at the left of the address bar',

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
  '把给 AI 的固定要求和参考资料放进项目,项目里的对话会自动遵循这些要求,并按需查阅资料,不用每次重复提供。':
    'Keep standing instructions and reference files in a project. Chats follow those instructions and consult the files as needed, so you do not have to provide them again.',
  '把固定要求(比如「用中文回答、语气正式」)和参考资料放进项目,项目里的对话会自动遵循这些要求,并按需查阅资料。':
    'Keep standing instructions (say, "answer in English, keep the tone formal") and reference files in a project. Chats follow those instructions and consult the files as needed.',
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
  '没有未归档的对话': 'No unarchived chats',
  '归档失败': 'Could not archive the chat',
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
  '资料按需检索:先提供目录,模型需要时再搜索和阅读相关内容。请使用支持工具调用的模型。':
    'Files are retrieved on demand: the model starts with a directory, then searches and reads relevant content as needed. Use a model that supports tool calls.',
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

  // ---- 添加到桌面 (install guide, phone card, in-app browser hint) ----
  '添加到桌面': 'Add to home screen',
  '添加到主屏幕': 'Add to Home Screen',
  '添加到程序坞': 'Add to Dock',
  '安装为应用': 'Install as app',
  '安装应用': 'Install app',
  '在浏览器中打开': 'Open in a browser',
  '先在浏览器中打开': 'Open in a browser first',
  '分享': 'Share',
  '独立窗口打开,不和其他网页标签混在一起;任务栏 / 程序坞图标上会显示完成数量。':
    'Opens in its own window, apart from your other tabs; the taskbar / Dock icon shows how many things have finished.',
  '从桌面图标一点就开,全屏显示,不用在浏览器标签里找。':
    'Opens full-screen from an icon on your home screen, with no hunting through browser tabs.',
  '点浏览器里的{share}按钮(找不到的话,换 Safari 打开本页)':
    'Tap the browser’s {share} button (can’t find it? Open this page in Safari instead)',
  '选{add}': 'Choose {add}',
  '点右上角{add}': 'Tap {add} at the top right',
  '点地址栏旁边的{more}(工具栏上直接有分享按钮的话跳过这步)':
    'Tap {more} next to the address bar (skip this if the toolbar already shows a Share button)',
  '点{share}': 'Tap {share}',
  '往下滑,点{add}': 'Scroll down and tap {add}',
  '确认「作为网页 App 打开」是打开的,点右上角{add}': 'Make sure “Open as Web App” is on, then tap {add} at the top right',
  '点{share}按钮(iPhone 在屏幕底部,iPad 在右上角)': 'Tap the {share} button (at the bottom on iPhone, top right on iPad)',
  '企业微信': 'WeCom',
  '钉钉': 'DingTalk',
  '飞书': 'Feishu',
  '微博': 'Weibo',
  '当前 App': 'this app',
  '「{app}」里打开的网页不能添加到桌面,先换到手机自带的浏览器:':
    'Pages opened inside {app} cannot be added to the home screen. Switch to your phone’s own browser first:',
  '点右上角的{more}': 'Tap {more} at the top right',
  '选{open}': 'Choose {open}',
  '在 Safari 中打开': 'Open in Safari',
  '在浏览器打开': 'Open in Browser',
  '(各 App 的叫法略有不同)': ' (the wording varies by app)',
  '在浏览器里登录后,再按提示添加到桌面': 'Sign in there, then follow the prompt to add it to your home screen',
  '打开浏览器菜单(右上角{dots}或底部{menu})': 'Open the browser menu ({dots} at the top right or {menu} at the bottom)',
  // Chinese browsers name the item three ways; English ones say one of two.
  '找{desktop}、{home}或{install}': 'Look for {desktop} or {install}',
  '如果提示没有权限,到手机设置里允许浏览器「创建桌面快捷方式」':
    'If it says permission is missing, allow the browser to create home screen shortcuts in your phone’s settings',
  '用 Chrome 或 Edge 打开本站可以一键安装;华为、小米等手机自带的浏览器入口名称略有不同。':
    'Chrome and Edge install it in one tap; the built-in browsers on Huawei, Xiaomi and other phones name the menu item slightly differently.',
  '当前环境不支持复制,请手动复制地址栏里的链接': 'Copying is not available here; copy the link from the address bar instead',
  '复制失败,请手动复制地址栏里的链接': 'Could not copy; copy the link from the address bar instead',
  '复制链接': 'Copy link',
  '已添加到桌面': 'Added to your home screen',
  '现在就是以 App 方式打开的,不需要再添加。': 'You are already using it as an app; there is nothing to add.',
  '这台设备已经添加过了,从桌面或应用列表里的图标打开即可。':
    'Already added on this device; open it from the icon on your home screen or in your app list.',
  '点下面的按钮,在弹出的窗口里确认即可。装好后会出现在桌面和应用列表里。':
    'Tap the button below and confirm in the window that pops up. It then appears on your home screen and in your app list.',
  '点下面的按钮,在浏览器弹出的窗口里确认即可。': 'Click the button below and confirm in the window your browser shows.',
  '点屏幕顶部菜单栏的{file}': 'Click {file} in the menu bar at the top of the screen',
  '选{dock},再点{add}': 'Choose {dock}, then click {add}',
  '当前浏览器不支持安装。用 Chrome 或 Edge 打开本站,地址栏右侧会出现安装图标。':
    'This browser cannot install sites. Open it in Chrome or Edge and an install icon appears at the right of the address bar.',
  '在手机上用:把链接发到手机,打开就能看到添加步骤': 'On your phone: send yourself this link; opening it shows the steps',
  '把这份引导发给同事': 'Share these steps with a colleague',
  '在浏览器中打开,体验更完整': 'Open it in a browser for the full experience',
  '添加到主屏幕,用起来像 App': 'Add it to your Home Screen and use it like an app',
  '添加到桌面,用起来像 App': 'Add it to your home screen and use it like an app',
  '现在是 App 里自带的浏览器,不能添加到桌面。': 'This is an app’s built-in browser, which cannot add sites to the home screen.',
  '以后再说': 'Not now',
  '怎么打开': 'Show me how',
  '看看怎么添加': 'Show me how',
  '建议先点右上角「···」,选「在 Safari 中打开」,再登录。之后可以把本站添加到主屏幕。':
    'Tip: tap “···” at the top right and choose “Open in Safari” before signing in. Then you can add the site to your Home Screen.',
  '建议先点右上角「···」,选「在浏览器打开」,再登录。之后可以把本站添加到桌面。':
    'Tip: tap “···” at the top right and choose “Open in Browser” before signing in. Then you can add the site to your home screen.',
  '知道了': 'Got it',
} satisfies Record<string, string>;
