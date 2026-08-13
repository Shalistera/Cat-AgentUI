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
- **MCP 工具**:stdio / Streamable HTTP / SSE 三种传输,支持全员共享或指定用户访问,对话中按需启用,工具调用过程完整可见
- **多用户**:首个注册用户自动成为管理员;管理端可建用户、停用、重置密码;可关闭开放注册
- **用量看板**:管理员可查看每用户/每模型/每日的 tokens、请求数与绘图量;用户可见自己的用量
- **高级聊天体验**:Markdown、代码高亮 + 一键复制、KaTeX 公式、GFM 表格、图片理解(视觉模型)、编辑重发、重新生成、自动标题
- **安全**:异步有界 scrypt 队列、HttpOnly 会话 Cookie、CSRF 防护、登录限速、MCP capability ACL、API Key AES-256-GCM 加密存储且永不回传前端
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
| `MAX_ATTACHMENTS_PER_MESSAGE` | 每条消息最多附件数 | `4` |
| `MAX_MESSAGE_ATTACHMENT_MB` | 每条消息附件原始字节总量 | `20` |
| `MAX_MESSAGE_TEXT_CHARS` | 每条消息文字字符上限 | `64000` |
| `MAX_CONTEXT_MESSAGES` | 发给模型的最近消息条数 | `40` |
| `MAX_CONTEXT_TEXT_CHARS` | 模型上下文文字字符预算 | `240000` |
| `MAX_CONTEXT_IMAGE_MB` | 模型上下文图片原始字节预算 | `24` |
| `MAX_CONTEXT_IMAGES` | 模型上下文图片数量预算 | `6` |
| `MAX_CONTEXT_IMAGE_MB_PER_USER` | 单用户同时驻留的上下文图片字节预算 | `48` |
| `MAX_CONTEXT_IMAGE_MB_GLOBAL` | 全站同时驻留的上下文图片字节预算 | `96` |
| `DEFAULT_MODEL_OUTPUT_TOKENS` | 未单独设置时发送给模型的输出 token 上限 | `8192` |
| `MAX_MODEL_OUTPUT_TOKENS` | 单次模型输出 token 硬上限 | `65536` |
| `MAX_TURN_OUTPUT_CHARS` | 单轮回复累计字符硬上限(含思考和工具结果) | `500000` |
| `CHAT_TURN_TIMEOUT_SECONDS` | 普通文本对话单轮总超时 | `900` |
| `CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS` | Provider 流连续无事件的空闲超时 | `120` |
| `MAX_USER_UPLOAD_MB` | 单用户附件存储配额 | `512` |
| `MAX_USER_IMAGE_MB` | 单用户生成图片存储配额 | `1024` |
| `MAX_TOTAL_STORAGE_MB` | 全站附件与生成图片总配额 | `10240` |
| `MAX_GENERATED_IMAGE_MB` | 单张生成图片大小上限 | `20` |
| `MAX_CHAT_CONCURRENCY_PER_USER` | 单用户并发对话数 | `2` |
| `MAX_CHAT_CONCURRENCY_GLOBAL` | 全站并发对话数 | `20` |
| `MAX_IMAGE_CONCURRENCY_PER_USER` | 单用户并发绘图数 | `1` |
| `MAX_IMAGE_CONCURRENCY_GLOBAL` | 全站并发绘图数 | `4` |
| `PASSWORD_CONCURRENCY` | scrypt 同时执行数 | `2` |
| `PASSWORD_QUEUE_MAX` | scrypt 等待队列长度 | `32` |
| `MAX_TOOL_ITERATIONS` | 单次回复最多 MCP 工具轮数 | `10` |

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
node scripts/mock-openai.mjs   # 本地假 OpenAI(:4141/v1),无需真实 Key 即可联调
                               # 提供对话流式、工具调用、生图 / 改图(images/generations 与 images/edits)
```

## 🗄️ 数据与迁移

- 数据库为 SQLite(WAL 模式),文件在 `data/cat-agentui.db`,10-20 人并发完全够用;schema 由 [Drizzle ORM](https://orm.drizzle.team) 管理,迁移文件在 `server/drizzle/`
- 备份:直接备份 `data/` 目录 + `.env`(密钥用 `SECRET_KEY` 加密,两者需成对保存)
- 导出:`npm run db:export -w server` 生成全量 JSON,便于日后迁移到 PostgreSQL 等

### 从 Open WebUI 迁移

**方式一(推荐):管理后台 → 数据迁移**,上传 webui.db 即可,支持试运行预览、可选填写服务器上的
Open WebUI data 目录来搬运附件图片。

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
