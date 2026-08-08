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

打开 `http://localhost:3000`,注册第一个账号(自动成为管理员),然后进入 **管理后台 → 模型服务** 添加 Provider、拉取模型即可开聊。

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
| `MAX_MODEL_OUTPUT_TOKENS` | 单次模型输出 token 硬上限 | `65536` |
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
