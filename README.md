<div align="center">
  <img src="web/public/cat.svg" alt="Cat-AgentUI" width="96" height="96" />
  <h1>Cat-AgentUI 🐈‍⬛</h1>
  <p><strong>轻量 · 多用户 · 多模型 AI 对话与绘图面板</strong></p>
  <p>OpenAI(兼容/Responses API)· Anthropic Claude · Google Gemini(AI Studio / Vertex)· MCP 工具</p>
</div>

---

一个刻意保持"轻"的自托管 AI 面板:没有 RAG、没有插件市场、没有用不上的功能——只把对话体验、绘图、多用户用量管理和 MCP 做到位。

## ✨ 功能

- **多模型对话**:OpenAI 兼容 API(可选新版 Responses API)、Anthropic、Gemini(可选 Vertex AI),每个 Provider 均可自定义 API 地址(Base URL)与自定义 Header,适配各类中转/网关
- **流式输出**:SSE 流式回复、思考过程(reasoning)展示、随时停止
- **每条回复的透明统计**:耗时、首字延迟、输入/输出 tokens、tokens/s
- **绘图工坊**:OpenAI `gpt-image-1` 与 Google Nano Banana(`gemini-*-image`)系列,支持参考图(图生图/编辑)、画廊管理
- **对话内直接出图**:在对话里直接选绘图模型即可作画,自动带上当前对话的上下文与图片,可以接着说「换成蓝色」「把背景改成雨天」;生成的图片同样进入画廊
- **联网搜索**:Vertex AI 上的 Gemini 2.5/3.x 可直接使用原生 Google Search Grounding,无需 Brave MCP;回答里每句有依据的话后面带编号引用角标,悬停看来源、点击直达,底部来源列表同一编号;其他 Provider 仍可回退到管理员指定的搜索 MCP。Gemini 3.x 上原生搜索与工作区/MCP/项目等函数工具直接同请求挂载,搜索发生在模型自己的推理里(最快,句级引用最准);Gemini 2.5 的 Vertex 接口不允许两者同请求,有其他工具时 Google 搜索改为一个 `google_search` 函数工具,模型调用时服务端另发一次带 grounding 的请求取回要点与来源
- **MCP 工具**:stdio / Streamable HTTP / SSE 三种传输,支持全员共享或指定用户访问,对话中按需启用,工具调用过程完整可见
- **多用户**:首个注册用户自动成为管理员;管理端可建用户、停用、重置密码;可关闭开放注册;管理员可在用户详情页搜索并只读查看该用户的对话记录(临时对话除外)
- **用量看板**:管理员可查看每用户/每模型/每日的 tokens、请求数与绘图量;用户可见自己的用量
- **模型使用限制**:可为单个模型设置每人每日/每周的请求次数或 tokens 上限,达到后拒绝或降级到指定模型;用户在模型选择器可见自己的已用额度
- **文档附件贯穿整段对话**:txt / Markdown / CSV / docx 以文本注入,PDF 原生交给视觉模型;早前上传的文档即使超出最近消息回放范围,续聊时仍会带给模型
- **高级聊天体验**:Markdown、代码高亮 + 一键复制、KaTeX 公式、GFM 表格、图片理解(视觉模型)、编辑重发、重新生成、自动标题
- **OCR 工坊**:PDF/图片转文字,Gemini 视觉模型直读 PDF 无需预处理;输出连续全文(不分页、不带页码),可选纯文本或 Markdown
- **对话导出**:侧栏菜单一键导出为 Markdown(当前分支)或 JSON(完整消息树)
- **全局自定义指令**:每位用户可设置「关于我 / 希望怎么回复」,自动加在所有对话的系统提示前,单个对话的系统提示仍可覆盖
- **对话内查找与收藏**:Ctrl/Cmd+F 在当前对话内搜索并逐个跳转(从侧栏搜索结果进入时自动定位);任意消息可收藏,集中在「收藏」页回看并一键跳回原处
- **对话工作区(Agent 式文件工作流)**:每个对话自带一个私有文件目录,模型在需要时通过内置工具列出、读取、写入、局部替换、删除其中的文件——长文、方案、代码等成果写成文件并反复修改,而不是每轮整篇重出;对用户无感:第一次出文件时右侧面板自动弹出,之后由对话顶部的「文件 N」标签开合,面板可预览(Markdown / 代码 / 图片 / PDF / HTML 沙箱)、在线编辑、下载、拖拽上传;用户可在设置 → 对话偏好用「智能工具」一键关闭全部 Agent 能力;文件随对话删除,占用计入存储概览
- **文档转换一步到位**:内置 `convert_file` 工具,Markdown / HTML / Word 互转与转 PDF(weasyprint,中文排版),命令是固定脚本而非模型拼写,不需要逐条确认,也不依赖「允许模型执行命令」开关(沙盒页单独的「内置文档转换」开关,默认开);技能自带脚本的调用同样视为可信免确认;确认卡片可勾选「本对话内不再询问」
- **沙盒命令执行(实验性)**:在工作区基础上,模型可用 `run_command` 在隔离沙盒里执行 shell 命令——bwrap 命名空间隔离(只读 /usr、只挂本对话工作区、无网络)加 systemd 用户实例 cgroup 限额(内存 / CPU / 进程数 / 超时);管理后台「沙盒」页提供宿主机环境自检(缺什么给出对应 apt / sysctl 命令)、Python 运行库一键安装(推荐库预设 + 自定义包,venv 只读挂进沙盒)、访问范围与执行前确认、执行审计;宿主机准备见 `deploy/sandbox-host-setup.sh`
- **技能(Agent Skills)**:管理员在后台维护 SKILL.md(frontmatter name/description + 步骤)与附带脚本/资料,支持在线编辑、zip 导入导出、启用与访问范围;对话里模型只看到技能名称与用途,任务匹配时才用 `load_skill` 读取完整说明、`read_skill_file` 读附带文件,技能目录在沙盒内只读挂载于 `/skills/<name>/` 可直接执行脚本;自带两个示例(Markdown 转 Word 报告、pandas + matplotlib 出图)
- **子代理**:模型可用 `spawn_subagent` 把独立子任务(通读长材料、按大纲写某章、跑一遍分析)委派给看不到对话历史的子代理,它拥有同样的工作区 / 技能 / 沙盒工具,不能嵌套、不用 MCP,结果以文字回给主对话、文件留在工作区;主对话里实时显示子代理的每一步;token 记入发起用户(用量看板「子代理」)
- **Agent 能力总控**:管理后台「Agent 能力」页统一设置工作区、技能、子代理的开关与访问范围(全员 / 指定用户),子代理可指定模型、每轮次数、工具轮数、超时、回传长度与是否允许执行命令;管理后台整体改为与设置弹窗同构的窗口式界面
- **MCP 工具执行前确认**:管理员可按服务器开启「调用前需用户确认」,模型想调用时先在对话里展示工具与参数,由用户允许或拒绝;用户也可选择对所有工具都先询问
- **互动画布(实验性)**:在「设置 → 实验性功能」开启后,模型照常用文字回答,只在「看比读更清楚」的内容上按需附一个可交互组件(HTML / Canvas / JS),以沙箱 iframe 在对话里渲染并跟随主题;组件内按钮可把追问放进输入框
- **Mermaid 图表与图片灯箱**:回复里的 ```mermaid 代码块直接渲染成图(可切回源码、下载 SVG);对话中的图片点击放大预览
- **后台完成通知**:切到其他标签页时,回复、绘图、PPT 完成后弹系统通知(浏览器权限,按设备开关)
- **语音**:语音输入(Chrome/Edge)与回复朗读,全部使用浏览器本地能力,零服务器开销
- **站内公告**:管理员发布横幅公告,所有登录用户实时可见,可自行关闭
- **成本折算**:按模型配置每百万 tokens 单价后,用量看板与个人用量页显示折算费用
- **自动备份**:内置 SQLite 在线快照定时任务 + 轮转,管理后台可手动备份与下载
- **PWA**:附带清单与全套图标,手机可「添加到主屏幕」
- **安全**:异步有界 scrypt 队列、HttpOnly 会话 Cookie、CSRF 防护、登录限速、MCP capability ACL、API Key AES-256-GCM 加密存储且永不回传前端
- **沙盒与工作区的隔离边界**:沙盒内 seccomp 禁止创建符号链接 / 管道 / 挂载与命名空间操作;宿主侧读取工作区文件一律 O_NOFOLLOW 打开后按 inode 校验路径,写入与命令执行共用对话级互斥锁,每次命令结束后清扫非常规文件;/skills 只挂载该用户有权使用的技能目录;zip 导入按实际解压字节数限量
- **资源保护**:附件/上下文硬预算、按用户与全局存储配额、对话/绘图并发闸门、Provider 图片响应大小与格式校验

## 🚀 快速开始

要求:Node.js ≥ 20(建议 22)。

```bash
git clone git@github.com:Shalistera/Cat-AgentUI.git
cd Cat-AgentUI
npm install
npm run build          # 构建前端 + 后端
npm start              # 监听 0.0.0.0:3000
```

打开 `http://localhost:3000`,注册第一个账号(自动成为管理员),然后进入 **管理后台 → 模型服务** 添加 Provider、拉取模型即可开聊。初始化完成后公开注册默认关闭,后续账号由管理员创建;需要时可在站点设置中手动开放。

### 使用 pm2 常驻(推荐)

```bash
npx pm2 start deploy/ecosystem.config.cjs
npx pm2 save
# 开机自启(无 root 时):crontab -e 添加
# @reboot cd /path/to/Cat-AgentUI && npx pm2 resurrect
```

### 环境变量(`.env`,自动生成)

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 监听端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `SECRET_KEY` | 会话与密钥加密种子(首次启动自动生成,**勿泄露/丢失**) | 自动生成 |
| `DATA_DIR` | 数据目录(SQLite、上传、生成图片) | `./data` |
| `COOKIE_SECURE` | HTTPS 部署时设为 `true` | `false` |
| `TRUST_PROXY` | 反代(nginx 等)后设为 `true` | `false` |
| `SESSION_TTL_DAYS` | 会话有效期 | `30` |
| `MAX_UPLOAD_MB` | 图片上传上限 | `20` |
| `MAX_ATTACHMENTS_PER_MESSAGE` | 每条消息最多附件数默认值(1–100);管理员可在「应用设置 → 存储空间」覆盖,保存后立即生效,OCR/绘图附件校验共用 | `20` |
| `MAX_MESSAGE_ATTACHMENT_MB` | 每条消息附件原始字节总量 | `20` |
| `MAX_MESSAGE_TEXT_CHARS` | 每条消息文字字符上限 | `64000` |
| `MAX_CONTEXT_MESSAGES` | 发给模型的最近消息条数 | `40` |
| `MAX_CONTEXT_TEXT_CHARS` | 模型上下文文字字符预算 | `240000` |
| `MAX_CONTEXT_IMAGE_MB` | 模型上下文图片原始字节预算 | `24` |
| `MAX_CONTEXT_IMAGES` | 上下文图片/PDF 数量预算;实际取此值与当前单次附件上限的较大值,保证一批附件可进入上下文 | `6` |
| `MAX_CONTEXT_IMAGE_MB_PER_USER` | 单用户同时驻留的上下文图片字节预算 | `48` |
| `MAX_CONTEXT_IMAGE_MB_GLOBAL` | 全站同时驻留的上下文图片字节预算 | `96` |
| `DEFAULT_MODEL_OUTPUT_TOKENS` | 未单独设置时发送给模型的输出 token 上限 | `8192` |
| `MAX_MODEL_OUTPUT_TOKENS` | 单次模型输出 token 硬上限 | `65536` |
| `MAX_TURN_OUTPUT_CHARS` | 单轮回复累计字符硬上限(含思考和工具结果) | `500000` |
| `CHAT_TURN_TIMEOUT_SECONDS` | 普通文本对话单轮总超时 | `900` |
| `CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS` | Provider 流连续无事件的空闲超时 | `120` |
| `MAX_USER_UPLOAD_MB` | 单用户附件存储配额默认值;管理员可在「站点设置 → 存储空间」覆盖,保存后立即生效;用户在「设置 → 附件存储」能看到自己的占用并删除附件 | `512` |
| `MAX_USER_IMAGE_MB` | 单用户生成图片存储配额 | `1024` |
| `MAX_TOTAL_STORAGE_MB` | 全站附件与生成图片总配额 | `10240` |
| `MAX_GENERATED_IMAGE_MB` | 单张生成图片大小上限 | `20` |
| `MAX_CHAT_CONCURRENCY_PER_USER` | 单用户并发对话数 | `2` |
| `MAX_CHAT_CONCURRENCY_GLOBAL` | 全站并发对话数 | `20` |
| `MAX_IMAGE_CONCURRENCY_PER_USER` | 单用户并发绘图数(同一模型始终只能跑一个,需换模型才能并发) | `3` |
| `MAX_IMAGE_CONCURRENCY_GLOBAL` | 全站并发绘图数 | `8` |
| `PASSWORD_CONCURRENCY` | scrypt 同时执行数 | `2` |
| `PASSWORD_QUEUE_MAX` | scrypt 等待队列长度 | `32` |
| `MAX_TOOL_ITERATIONS` | 单次回复最多 MCP 工具轮数 | `10` |
| `MAX_WORKSPACE_MB` | 单个对话工作区总大小上限 | `64` |
| `MAX_WORKSPACE_FILE_MB` | 工作区单个文件大小上限 | `8` |
| `MAX_WORKSPACE_FILES` | 单个对话工作区文件数上限 | `500` |
| `MAX_SANDBOX_CONCURRENCY` | 全站同时执行的沙盒命令数(每人 1 条) | `3` |
| `MAX_SANDBOX_TIMEOUT_SECONDS` | 管理员可设置的单条命令超时上限 | `600` |
| `BACKUP_INTERVAL_HOURS` | 数据库自动快照间隔的初始默认值(0 = 默认关闭);实际策略在后台「应用设置 → 数据库备份」中设置并存库 | `24` |
| `BACKUP_KEEP` | 快照保留份数的初始默认值,后台可改 | `14` |

### Vertex Gemini 原生联网搜索

将 Gemini Provider 配置为 **Vertex AI**,并启用 Gemini 2.5/3.x 文本模型的“工具调用”后,
聊天输入框会直接显示“联网”开关,不需要安装或指定 Brave MCP。后端在 Vertex
`generateContent` 请求中发送 `tools: [{ googleSearch: {} }]`,并保存/展示返回的来源。
非 Vertex 模型仍可使用 **管理后台 → MCP** 中指定的搜索服务器作为回退。

Gemini 3.x 允许在同一个 `generateContent` 请求中混用 `googleSearch` 与函数调用工具,
搜索与工作区等工具同时可用;Gemini 2.5 仍会拒绝这种组合,因此 2.5 上一旦同轮还有其他工具,
Google 搜索改由服务端桥接为 `google_search` 函数工具(多一次模型往返,略慢)。支持模型、配额、计费与展示条款以
[Google Cloud 官方说明](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-search)
为准。

MCP 默认对所有登录用户共享,适合联网搜索等基础工具。文件、命令执行或内部系统等
敏感 MCP 应在 **管理后台 → MCP → 编辑服务器 → 访问范围** 中改为“仅指定普通用户”;
管理员权限始终隐式生效。

Provider API Key、Vertex 服务账号、Provider 自定义 Headers 以及 MCP env/Headers
均使用 `SECRET_KEY` 加密落盘并按“只写不回显”处理;Provider/MCP 错误、工具结果和模型流
也会做密钥脱敏。注意:Stdio MCP 是与本站同一系统账号运行的受信任代码。Shell、文件系统或
恶意 MCP 可以读取文件并变形外传内容,不能靠字符串脱敏形成真正沙箱,因此不要向普通用户
开放不可信的本地命令/文件工具。

## 🧰 开发

```bash
npm run dev:server     # tsx watch, :3000
npm run dev:web        # vite dev, :5173(代理 /api → :3000)
npm run test:security  # 临时数据库 + Mock Provider/MCP 的隔离安全回归
npm run test:upload-quota # 临时数据库的附件配额设置与上传回归
node scripts/mock-openai.mjs   # 本地假 OpenAI(:4141/v1),无需真实 Key 即可联调
                               # 提供对话流式、工具调用、生图 / 改图(images/generations 与 images/edits)
```

## 🗄️ 数据与迁移

- 数据库为 SQLite(WAL 模式),文件在 `data/cat-agentui.db`,10-20 人并发完全够用;schema 由 [Drizzle ORM](https://orm.drizzle.team) 管理,迁移文件在 `server/drizzle/`
- 备份:服务每 24 小时自动做一次 SQLite 在线快照到 `data/backups/`(保留最近 14 份,可在管理后台手动备份/下载);快照只含数据库,附件与生成图片仍需连同 `.env` 一起做 `data/` 整目录备份(密钥用 `SECRET_KEY` 加密,两者需成对保存)
- 导出:`npm run db:export -w server` 生成全量 JSON,便于日后迁移到 PostgreSQL 等

### 从 Open WebUI 迁移

**方式一(推荐):管理后台 → 数据迁移**,上传 webui.db 即可,支持试运行预览、可选填写服务器上的
Open WebUI data 目录来搬运附件(图片与文档;PDF / 旧版 Office 等会带着 Open WebUI 已提取的文本一起迁入,回复里的引用来源保留为「参考来源」)。

**方式二:命令行**

```bash
# 先停掉 Open WebUI,然后:
npm run db:import-openwebui -w server -- \
  --db /path/to/open-webui/data/webui.db \
  --data-dir /path/to/open-webui/data     # 可选,用于搬运聊天附件与生成图片
```

**大库(GB 级)建议:** 内嵌图片多的 webui.db 动辄数 GB,别走浏览器上传——先在源机器压瘦再拷到
本机跑命令行:

```bash
sqlite3 webui.db "PRAGMA wal_checkpoint(TRUNCATE)"       # 把 WAL 合并进主文件
sqlite3 webui.db "VACUUM INTO 'webui-compact.db'"        # 去掉空闲页,通常显著变小
rsync webui-compact.db your-server:/tmp/                 # 附件目录(data/uploads 等)也一并拷
```

导入按会话逐个提交、内存占用与库大小无关;中途中断或个别会话解析失败都不影响其余,重跑即续传。

- **用户**:登录名 = 原邮箱(小写),显示名、角色(admin/user)、停用状态照搬;
  **原密码直接可用**——bcrypt/argon2 哈希原样迁入,首次登录成功后自动升级为本站 scrypt 格式。
  不需要 Open WebUI 的 `WEBUI_SECRET_KEY`(它只签 JWT 会话,不参与密码哈希)
- **聊天记录**:迁入每个会话的当前分支(与 Open WebUI 界面所见一致),推理过程
  (`<details type="reasoning">` 或 0.11+ 结构化 output)、工具调用、附件图片都会解析为本站消息格式
- OAuth/LDAP 登录且无本地密码的账号会迁入但暂不可登录,报告中会列出,管理员在后台重置密码即可
- 支持 `--dry-run`(只看报告不写入)、`--skip-archived`(跳过归档会话);重复执行安全(已存在的用户/会话自动跳过)

## 🏗️ 架构

```
web/     React 19 + Vite + Tailwind v4(构建后由后端托管)
server/  Fastify 5 + better-sqlite3 + Drizzle(TypeScript, ESM)
  ├─ providers/   openai.ts · anthropic.ts · gemini.ts(统一流式适配器接口)
  ├─ mcp/         @modelcontextprotocol/sdk 客户端管理器
  └─ routes/      auth · chats(SSE)· images · uploads · mcp · admin · providers
```

## License

MIT
