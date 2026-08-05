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
- **MCP 工具**:stdio / Streamable HTTP / SSE 三种传输,管理端配置 + 连接测试,对话中按需启用,工具调用过程完整可见
- **多用户**:首个注册用户自动成为管理员;管理端可建用户、停用、重置密码;可关闭开放注册
- **用量看板**:管理员可查看每用户/每模型/每日的 tokens、请求数与绘图量;用户可见自己的用量
- **高级聊天体验**:Markdown、代码高亮 + 一键复制、KaTeX 公式、GFM 表格、图片理解(视觉模型)、编辑重发、重新生成、自动标题
- **安全**:scrypt 密码哈希、HttpOnly 会话 Cookie、CSRF 防护、登录限速、API Key AES-256-GCM 加密存储且永不回传前端

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

## 🧰 开发

```bash
npm run dev:server     # tsx watch, :3000
npm run dev:web        # vite dev, :5173(代理 /api → :3000)
node scripts/mock-openai.mjs   # 本地假 OpenAI(:4141/v1),无需真实 Key 即可联调
                               # 提供对话流式、工具调用、生图 / 改图(images/generations 与 images/edits)
```

## 🗄️ 数据与迁移

- 数据库为 SQLite(WAL 模式),文件在 `data/cat-agentui.db`,10-20 人并发完全够用;schema 由 [Drizzle ORM](https://orm.drizzle.team) 管理,迁移文件在 `server/drizzle/`
- 备份:直接备份 `data/` 目录 + `.env`(密钥用 `SECRET_KEY` 加密,两者需成对保存)
- 导出:`npm run db:export -w server` 生成全量 JSON,便于日后迁移到 PostgreSQL 等

### 从 Open WebUI 迁移

```bash
# 先停掉 Open WebUI,然后:
npm run db:import-openwebui -w server -- \
  --db /path/to/open-webui/data/webui.db \
  --data-dir /path/to/open-webui/data     # 可选,用于搬运聊天附件与生成图片
```

- **用户**:登录名 = 原邮箱(小写),显示名、角色(admin/user)、停用状态照搬;
  **原密码直接可用**——bcrypt/argon2 哈希原样迁入,首次登录成功后自动升级为本站 scrypt 格式
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
