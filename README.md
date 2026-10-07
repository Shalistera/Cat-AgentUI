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
- **备用线路(故障切换)**:一个 Provider 下可挂多条同类型网关(如主用 OpenRouter、备用 LiteLLM),共用同一份模型列表、权限与用量;按优先级顺序使用而非负载均衡(保住提示缓存),主线路在返回内容前失败即在同一请求内改走下一条(该线路没有此模型也算,但不计入熔断),连续失败达到阈值后熔断一段时间再单次试探,恢复即切回;支持按线路改写模型名前缀、单独开关 Responses API,管理后台可看各线路状态、手动重置,并可把备用线路一键设为主线路(整体对调)
- **Vertex 多区域与 Priority PayGo**:Vertex 模式可按优先级排列多个区域(如 global → us → eu,us/eu 自动使用多区域专用地址),某个区域被限流或出故障时同一请求内自动换下一个区域,熔断与切换提示同备用线路;可选 Priority PayGo(单价更高、更不易被限流):关闭、限流时启用(标准请求累计被限流 5 次或各区域都试过后改走 Priority,并在对话里提示正在使用优先通道),或始终使用;某条线路没有该模型时记住一小时,期间该模型直接跳过这条线路
- **限流兜底换模型**:模型提供方持续限流时,重试等待超过 10 秒或最终报错后,回复里会推荐一个其他服务商的模型(按个人模型排序取第一个,跳过图像模型、对话里有图片时不支持识图的、用到工具时不支持工具的和额度已用完的),一键改用它重新生成这条回复,之后的对话也改用它
- **流式输出**:SSE 流式回复、思考过程(reasoning)展示、随时停止
- **每条回复的透明统计**:耗时、首字延迟、输入/输出 tokens、tokens/s
- **绘图工坊**:OpenAI `gpt-image-1` 与 Google Nano Banana(`gemini-*-image`)系列,支持参考图(图生图/编辑)、画廊管理;NovelAI V5 有独立的「NAI 创作室」(左侧创作面板 + 大画布 + 历史栏),中文描述自动整理成提示词,支持画风预设与自定义画师组合、多人物站位、官方 UC;Tag 模式带权重上色、一键加减 `{}`/`[]`、按用户记忆的 tag 联想、中文词库和 tag 收藏
- **对话内直接出图**:在对话里直接选绘图模型即可作画,自动带上当前对话的上下文与图片,可以接着说「换成蓝色」「把背景改成雨天」;生成的图片同样进入画廊
- **联网搜索**:和 ChatGPT / Claude / Gemini 官方应用一样没有开关,模型自己判断要不要搜。Vertex 上的 Gemini 直接用原生 Google Search Grounding;其他模型(本地 Claude Code、OpenAI 兼容、Anthropic)和子代理通过内置的 `web_search` 工具,由管理员指定的小模型(默认 `gemini-3.5-flash-lite`)代为 Google 搜索并带回要点与来源,出错时依次改用备用模型和 Brave 等搜索 MCP;回答里每句有依据的话后面带编号引用角标,悬停看来源、点击直达。按月计数 Google 实际执行的搜索次数,到达上限后只用备用搜索源
- **MCP 工具**:stdio / Streamable HTTP / SSE 三种传输,支持全员共享或指定用户访问,对话中按需启用,工具调用过程完整可见
- **多用户**:首个注册用户自动成为管理员;管理端可建用户、停用、重置密码;可关闭开放注册;管理员可在用户详情页搜索并只读查看该用户的对话记录(临时对话除外)
- **用量看板**:管理员可查看每用户/每模型/每日的 tokens、请求数与绘图量;用户可见自己的用量
- **模型使用限制**:可为单个模型设置每人每日/每周的请求次数或 tokens 上限,达到后拒绝或降级到指定模型;用户在模型选择器可见自己的已用额度
- **项目**:类似 ChatGPT / Claude.ai 的项目,集中放项目指令和参考资料(文本类文件),可共享给指定成员。资料按模型上下文大小尽量整篇载入(约占上下文的 15%,按中文约 1 字 1 token 估算:1M 上下文模型约 15 万字,128K 模型约 2 万字,上限见 `PROJECT_INJECT_MAX_CHARS`),小文档优先,放不下的列成清单(附开头与小标题),由模型用 `project_search`(中英文关键词检索,结果带文档名和字符位置)与 `project_read_doc`(从任意位置读原文)按需调取;子代理同样能检索和阅读项目资料;开启沙盒时,资料还以只读文件挂载在 `/project/`,可用命令跨文档查找、处理数据。回答引用资料时,模型按 `[文档名](doc:ref)` 标注出处(ref 为文档 id 前 8 位,随资料载入和检索结果一起给出),界面显示为资料标签,点开即可查看,有编辑权限的成员可以直接修改保存
- **长对话自动压缩**:发给模型的历史按模型上下文自动定额(约占一半,按中文约 1 字 1 token 估算:1M 上下文模型约 50 万字,GPT-5 约 20 万字,128K 模型约 6 万字);对话超出时,较早的部分由当前模型压缩成摘要放在历史开头,最近的对话原样保留,回复上方会标出并可展开查看摘要。摘要按分支保存,直到再次超出才重写,历史前缀保持稳定、可以命中提示缓存;删除或修改消息后摘要作废重建。Anthropic 接入同时缓存对话历史,长对话续聊的输入大多按缓存价计费
- **文档附件贯穿整段对话**:txt / Markdown / CSV / docx 以文本注入,PDF 原生交给视觉模型;早前上传的文档即使超出最近消息回放范围,续聊时仍会带给模型
- **高级聊天体验**:Markdown、代码高亮 + 一键复制、KaTeX 公式、GFM 表格、图片理解(视觉模型)、编辑重发、重新生成、自动标题
- **OCR 工坊**:PDF/图片转文字,Gemini 视觉模型直读 PDF 无需预处理;输出连续全文(不分页、不带页码),可选纯文本或 Markdown
- **对话导出**:侧栏菜单一键导出为 Markdown(当前分支)或 JSON(完整消息树)
- **全局自定义指令**:每位用户可设置「关于我 / 希望怎么回复」,自动加在所有对话的系统提示前,单个对话的系统提示仍可覆盖
- **对话内查找与收藏**:Ctrl/Cmd+F 在当前对话内搜索并逐个跳转(从侧栏搜索结果进入时自动定位);任意消息可收藏,集中在「收藏」页回看并一键跳回原处
- **对话工作区(Agent 式文件工作流)**:每个对话自带一个私有文件目录,模型在需要时通过内置工具列出、读取、写入、局部替换、删除其中的文件——长文、方案、代码等成果写成文件并反复修改,而不是每轮整篇重出;对用户无感:第一次出文件时右侧面板自动弹出,之后由对话顶部的「文件 N」标签开合,面板可预览(Markdown / 代码 / 图片 / PDF / HTML 沙箱)、在线编辑、下载、拖拽上传;用户可在设置 → 对话偏好用「智能工具」一键关闭全部 Agent 能力;文件随对话删除,占用计入存储概览
- **文档转换一步到位**:内置 `convert_file` 工具,Markdown / HTML / Word 互转与转 PDF(weasyprint,中文排版),命令是固定脚本而非模型拼写,不需要逐条确认,也不依赖「允许模型执行命令」开关(沙盒页单独的「内置文档转换」开关,默认开);技能自带脚本的调用同样视为可信免确认;确认卡片可勾选「本对话内不再询问」
- **对话图片生成工具**:普通聊天模型可按任务需要调用 `generate_image`,每次生成一张图片并直接展示在对话中。管理员在「Agent 能力 → 图片生成」配置开关、使用范围、多个可用图片模型(首个为默认)、每轮次数及普通用户每日上限(默认 20 次,0 为不限,管理员豁免)。工具授权独立于模型可见权限、直接图像模型权限和绘图工坊权限;不依赖工作区或沙盒。每日次数按服务器日期跨模型合并统计,已发起上游请求计次(含失败/取消),自动重试不重复扣次;限制在并发请求和服务重启后仍生效。用量单列为「图片生成工具」,现有 token、模型使用、并发和存储限额照常生效。当前为文生图,不自动携带聊天历史或参考图片。
- **沙盒命令执行(实验性)**:在工作区基础上,模型可用 `run_command` 在隔离沙盒里执行 shell 命令——bwrap 命名空间隔离(只读 /usr、只挂本对话工作区、无网络)加 systemd 用户实例 cgroup 限额(内存 / CPU / 进程数 / 超时);管理后台「沙盒」页提供宿主机环境自检(缺什么给出对应 apt / sysctl 命令)、Python 运行库一键安装(推荐库预设 + 自定义包,venv 只读挂进沙盒)、访问范围与执行前确认、执行审计;宿主机准备见 `deploy/sandbox-host-setup.sh`
- **技能(Agent Skills)**:管理员在后台维护 SKILL.md(frontmatter name/description + 步骤)与附带脚本/资料,支持在线编辑、zip 导入导出、启用与访问范围;对话里模型只看到技能名称与用途,任务匹配时才用 `load_skill` 读取完整说明、`read_skill_file` 读附带文件,技能目录在沙盒内只读挂载于 `/skills/<name>/` 可直接执行脚本;自带两个示例(Markdown 转 Word 报告、pandas + matplotlib 出图)
- **子代理**:模型可用 `spawn_subagent` 把独立子任务(通读长材料、按大纲写某章、跑一遍分析)委派给看不到对话历史的子代理,它拥有同样的工作区 / 技能 / 沙盒工具,不能嵌套、不用 MCP,结果以文字回给主对话、文件留在工作区;主对话里实时显示子代理的每一步;token 记入发起用户(用量看板「子代理」)
- **Agent 能力总控**:管理后台「Agent 能力」页统一设置工作区、技能、子代理的开关与访问范围(全员 / 指定用户),子代理可指定模型、每轮次数、工具轮数、超时、回传长度与是否允许执行命令;管理后台整体改为与设置弹窗同构的窗口式界面
- **MCP 工具执行前确认**:管理员可按服务器开启「调用前需用户确认」,模型想调用时先在对话里展示工具与参数,由用户允许或拒绝;用户也可选择对所有工具都先询问
- **图表对比**:同一指标、同一单位的 2–12 项数据可通过 `compare_data` 计算最大值、最小值和极差,并直接展示固定柱状图;时间/连续数据支持多曲线折线图(1–6 条曲线,每条 2–120 点,总计最多 600 点),按真实横轴间隔绘制,缺失值断开。支持图例筛选、悬停/键盘读数、切换数据表、正负数和数据来源说明。每轮最多展示一张图,格式错误可修正一次,不生成 HTML/JS。管理后台「Agent 能力」可设置开关与访问范围,受个人「智能工具」开关控制。更新后自动清理原互动画布和加密块的用户设置,历史对话正文保留。
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

### NovelAI V5 绘图

1. 在「管理后台 → 模型服务」添加 **NovelAI V5** Provider。API 地址留空使用 `https://image.novelai.net`;填写 NovelAI 账号设置中的 **Persistent API Token**。Token 沿用服务端加密存储,不会发到浏览器。
2. 拉取并导入 `nai-diffusion-5-curated` 与 `nai-diffusion-5-full`。按需要给指定用户开放这两个模型,并开启该用户的「绘图工坊」和「图像模型」权限。
3. 从绘图工坊右上角的「NAI 创作室」进入(`/images/nai`;用户只有 NAI 模型时直接打开)。所有设置在一屏内:描述画面、点选画风、选画幅,需要时添加人物并拖动站位,然后点「生成」或 Ctrl / ⌘ + Enter。结果显示在中间画布,历史栏列出该用户的 NAI 作品,可查看实际提示词、载入设置、固定种子继续微调。草稿和自定义画风按用户保存在当前浏览器;离开页面不会停止已提交的生成,回来后自动接上进度。
4. 默认「智能描述」模式:提示词助手使用用户有权访问的文字模型(默认选默认文字模型,可在高级设置中切换或关闭),可先点「预览」查看整理结果。它只整理描述与角色,不会修改画师组合;同一描述重复出图会复用整理结果。文字模型消耗独立记录为「NAI 提示词助手」,不消耗 Anlas。没有可用文字模型时可直接输入自然语言或 tags。
5. 「Tag 模式」直接编辑发送给 NAI 的原始提示词,从智能描述切换过来会带上最新的整理结果,画风区默认收起。输入时先联想该用户生成过的 tag(服务端按其 NAI 作品的生成参数统计次数和新近程度,`GET /api/images/novelai/tag-history`),再列出 NAI 的标签建议(附使用量)和内置中文词库,输入中文也能联想到对应 tag。输入框按权重上色,光标所在或选中的 tag 可用「加强 / 减弱」或 Ctrl / ⌘ + ↑↓ 增减一层 `{}` / `[]`(已有数字权重时按 0.1 调整),这些编辑都能 Ctrl / ⌘ + Z 撤销;中文逗号、括号等自动换成英文。「整理」统一逗号和空格、下划线换成空格、拆开从 Danbooru 复制的空格分隔列表并去重。「tag 库」里有常用 tag、收藏的 tag 组合(按用户保存在当前浏览器)和分类词库,点一下加入、再点移除。仍有中文时可以用提示词助手只把中文片段转成 tag(`POST /api/images/novelai/tagify`,其余内容不发送,用量同样记为「NAI 提示词助手」)。官方 UC(界面上叫「基础过滤」)默认启用 Heavy,与自定义排除词分开保存;画面文字放在最终提示词末尾,有文字时不追加 `no text`。作品集图片详情的「在 NAI 创作室打开」会恢复描述、人物、画师权重、UC 和尺寸;种子默认改回随机,需要复现时在画布上点「固定种子」。

**订阅额度模式**仅支持有效 Opus 订阅、单张文生图、最多 28 steps,以及 `1216×832`、`832×1216`、`1024×1024` 三种 Normal 尺寸。默认 23 steps、Guidance 7、Euler Ancestral。服务端每次生成前读取最新订阅状态;额度未知、不可用或不足 1% 时停止。同一 Token 的两个模型在服务进程内共用并发锁。生成请求不自动重试、不切备用线路,也不降级到旧模型。Anlas 余额仅供查看,暂不提供 Vibe Transfer、图生图、重绘、放大或批量生成。

NovelAI 的公开 API 没有已确认的原子「费用必须为 0」参数。上述前置检查不能锁住其他客户端:若同一账号在官网或另一服务进程同时耗尽额度,上游仍可能转为消耗 Anlas。这里实现的是保留 1% 余量的订阅前置限制,不能把 Normal 尺寸本身当作零扣费保证。需要严格隔离时,应避免同一账号跨客户端并发生成。

API 协议和预设参考 [官方 API](https://image.novelai.net/docs/index.html)、[角色位置](https://docs.novelai.net/en/image/multiplecharacters/)、[UC 预设](https://docs.novelai.net/en/image/undesiredcontent/)及[订阅额度说明](https://journal.novelai.net/opus-usage-limit-explained/)。回归验证使用本地模拟服务: `npm run test:novelai`,不会调用真实 NAI 或消耗额度;Tag 模式的文本工具和词库由 `npm run test:nai-tags` 覆盖。

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
| `MAX_CONTEXT_MESSAGES` | 原样回放的消息条数上限(超出即压缩成摘要) | `400` |
| `MAX_CONTEXT_TEXT_CHARS` | 对话历史的字符上限;实际预算按模型上下文约一半自动计算,取两者较小值 | `1000000` |
| `PROJECT_INJECT_MAX_CHARS` | 项目资料整篇载入的字符上限;实际还不超过模型上下文的约 15%,放不下的部分改为按需检索 | `200000` |
| `MAX_CONTEXT_IMAGE_MB` | 模型上下文图片原始字节预算 | `24` |
| `MAX_CONTEXT_IMAGES` | 上下文图片/PDF 数量预算;实际取此值与当前单次附件上限的较大值,保证一批附件可进入上下文 | `6` |
| `MAX_CONTEXT_IMAGE_MB_PER_USER` | 单用户同时驻留的上下文图片字节预算 | `48` |
| `MAX_CONTEXT_IMAGE_MB_GLOBAL` | 全站同时驻留的上下文图片字节预算 | `96` |
| `DEFAULT_MODEL_OUTPUT_TOKENS` | 未单独设置时每次模型请求的输出 token 上限;Gemini 包含思考,不等于模型最大容量 | `8192` |
| `MAX_MODEL_OUTPUT_TOKENS` | 单次模型输出 token 硬上限 | `65536` |
| `MAX_TURN_OUTPUT_CHARS` | 单轮回复累计字符硬上限(含思考和工具结果) | `500000` |
| `CHAT_TURN_TIMEOUT_SECONDS` | 普通文本对话单轮总超时 | `900` |
| `CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS` | Provider 流连续无事件的空闲超时 | `120` |
| `PROVIDER_RETRY_MAX_WAIT_SECONDS` | 上游 429/503/529 限流时单次请求最多等待重试的总时长 | `60` |
| `FAILOVER_RETRY_WAIT_SECONDS` | 配置了备用线路时,前面的线路被限流最多等多久就改走下一条 | `10` |
| `VERTEX_REGION_RETRY_WAIT_SECONDS` | Vertex 某个区域被限流时最多等多久就换下一个区域(或 Priority 重试) | `3` |
| `VERTEX_PRIORITY_AFTER_RETRIES` | Priority PayGo 设为「限流时启用」时,一次请求里标准请求累计被限流几次就改走 Priority | `5` |
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

### 图表工具参数与恢复

`compare_data` 的说明提供柱状图和折线图的最小 JSON 示例。按 `chart` 选择需要的字段,忽略另一种图的字段和占位值;
折线示例展示两条曲线共用横轴,不依赖 Python/scipy/matplotlib。模型确需计算或拟合数据时仍可使用沙盒,
但已知数值的对话内图表直接走 `compare_data`;沙盒与技能提示按本轮图表权限引导,不会要求安装绘图库才能画多曲线。
当前用户消息明确要求某类图形,或命中“对比 + 按时间展示”时,只提供对应图形的参数和示例,运行时也会拒绝不匹配的图形。
用户明确指定柱状图优先于时序默认值;模糊请求保留两种选择。该检查能拦截错用图形,不能证明数值、指标或来源语义正确。
缺少目标数据时优先定向补查原始资料,仍取不到则简短说明;不能用峰值/总量凑成不回答时间变化的图,不能无依据补造曲线。
未指定图形时可从单独提供的 `items` 或 `series` 识别,两套数据都有时要求明确指定。纯数字字符串可转为数值,
空字符串/布尔值/带单位的字符串不会被当作数字。数据出处允许最多 1000 字以容纳链接。
数据点数、横轴顺序、曲线长度、缺失值和单位/出处仍会校验;不静默排序、补点或猜测单位。
格式错误返回具体字段,允许模型根据反馈修正一次;成功或累计两次失败后收起本轮图表工具,运行时也会拦截超限调用。
没有发出图表调用时,不会额外请求模型重写答案。Responses API 显式发送 `strict: false`,保留共享工具定义中的可选字段,
避免服务端自动转成严格模式后要求填写不适用的字段;Chat Completions、Anthropic 和 Gemini 沿用各自的参数协议。
参考:[OpenAI 工具严格模式说明](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)。

### 输出上限与 Gemini 思考

普通对话每次模型请求使用 `min(对话 maxTokens 或 DEFAULT_MODEL_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_TOKENS)`。
默认请求上限为 8192;工具会产生多轮请求,回复统计的输出 tokens 会累计各轮,并包含 Gemini 思考 tokens。
Gemini 3.7/3.8 Flash 按原生 `thinkingLevel` 发送低/中/高档;它们不能完全关闭思考,最低档使用 low 并隐藏思考摘要。
高思考档触及上限时,可按需要提高部署环境的 `DEFAULT_MODEL_OUTPUT_TOKENS`(例如 32768 或 65536),
但实际值仍受 `MAX_MODEL_OUTPUT_TOKENS` 和服务商限制;已有对话显式保存的 `maxTokens` 优先。
提高上限会允许更多思考和输出,不保证低延迟或低成本。图表任务默认先取数据、先出图、后写简短结论。当前用户消息明确要求图表或“对比 + 按时间展示”时,
会增加简短的本轮图表意图提示;只看当前用户消息,忽略引用和代码片段,跳过明确不画图或纯翻译/编程请求。
这个判断不另调模型,不改变 Vertex 原生搜索或其他 Agent 工具;生成后的长文也不会被再送去转换。
Gemini 的流结束日志包含 `requestedMaxOutputTokens`、`thoughtTokens`、`answerTokens`,便于定位实际截断。回合结束日志还会记录 `comparisonIntentMatched`、`comparisonTarget`、`comparisonAttempts`、
`comparisonRendered`,可区分意图未匹配、工具未调用和工具已调用但未出图。
参考:[Google 思考与输出预算说明](https://ai.google.dev/gemini-api/docs/generate-content/thinking)。

### 联网搜索

联网搜索是 **管理后台 → Agent 能力 → 联网搜索** 里的一项能力(默认开启,受用户「智能工具」开关控制),
输入框里没有开关:搜索始终可用,由模型按问题决定是否调用。

- **Vertex Gemini**:Gemini 2.5/3.x 文本模型在 `generateContent` 请求里直接带
  `tools: [{ googleSearch: {} }]`,搜索发生在模型自己的推理里,来源按句标注。Gemini 3.x
  可与函数工具同请求;Gemini 2.5 不允许,同轮有其他工具时改用下面的 `web_search`。
- **其他模型与子代理**:提供内置函数工具 `web_search(query)`。调用时服务端向「搜索模型」
  (默认自动选第一个启用的 Gemini 服务商、优先 Vertex,模型 `gemini-3.5-flash-lite`)发一次带
  Google grounding 的请求,把要点和编号来源作为工具结果交回,来源同时显示为引用角标。
  本地 Claude Code 通过面板转给它的工具使用同一个 `web_search`。
- **兜底**:每次 `web_search` 依次尝试 搜索模型 → 备用模型(默认 `gemini-3.1-flash-lite`,可指定
  另一个 Gemini 服务商,如 AI Studio)→ **管理后台 → MCP** 中设为「搜索源」的服务器(如 Brave),
  每步 20 秒超时;失败过的模型暂停 2 分钟,Vertex 故障时不必每次都等超时。
- **费用控制**:Gemini 3.x 的 Google 搜索按实际执行的搜索查询计费(一次提问常搜 2–3 次),
  每月有共享免费额度。面板按月累计 `web_search` 的搜索次数,到达「每月 Google 搜索上限」
  (默认 5000)后只用备用搜索源;普通用户与管理员可分别设每日调用上限(默认 100 / 不限)。
  搜索模型的 token 计入用量看板「联网搜索」。

支持模型、配额、计费与展示条款以
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
npm run test:provider-retry # 模拟 429:有限重试、取消、附件保留与断流保护
npm run test:stream-parser # SSE 末尾结束事件、分片编码、延迟结束与真实断流
npm run test:chat-recovery # 断线后恢复原生成、刷新恢复、明确停止和用户隔离
npm run test:chat-fallback # 可配置模型兜底、成功后沿用、失败不改选择、权限与防循环
npm run test:response-integrity # 空回自动换线路、思考缓冲、恢复上限、续写去重和结束确认
npm run test:provider-failover # 备用线路:优先级切换、熔断阈值与冷却试探、不重放已开始的流;Vertex 区域顺序与 Priority
npm run test:data-comparison # 图表对比:输入校验、权限、次数、消息持久化与旧实验设置清理
npm run test:model-fallback   # 持续限流时推荐换用的模型:其他服务商、按个人排序、能力与额度
node scripts/mock-openai.mjs   # 本地假 OpenAI(:4141/v1),无需真实 Key 即可联调
                               # 提供对话流式、工具调用、生图 / 改图(images/generations 与 images/edits)
```

Gemini / Vertex 流结束时,服务端输出 `Provider stream ended` 结构化日志,按
`chatId` / `messageId` 关联 `Chat turn finished`。前者记录实际 `location`、
`endpointId`、`priority`、原始 `finishReason`、`transport`、`invalidEvents` 和
`sinceLastByteMs`,不记录对话正文或密钥。`transport=eof` 且没有 `finishReason`
只表示连接读完但未确认正常完成;`transport=error` 表示读取异常;
`transport=aborted` 表示主动取消或本地超时,可结合 `timeout` 判断;
`clientGone` 只表示浏览器连接已断开,可恢复请求不会仅因该标记取消生成。
若服务端记录 `finishReason=STOP` 且最终为 `stop`,浏览器仍提示不完整,
应检查浏览器到面板之间的 SSE 链路。上游心跳也算连接活动,不会因没有新 token
而触发空闲超时;总生成时限仍然生效。

对话请求携带 `requestId` 时,浏览器连接中断不会取消后台生成。页面会通过只读
`stream-state` 接口恢复同一轮的正文、重试状态和工具确认,直到后台真正结束,
不会自动重放模型请求。重新打开对话也会继续跟踪;「停止」通过独立接口按请求标识
取消生成。后台仍受原有总时限限制,不带 `requestId` 的旧客户端保留断线取消行为。

Vertex Priority PayGo 可选择「首次失败即启用」:首次可切换线路的错误发生在输出前时,
直接跳到 Priority,跳过标准通道内部重试和其他标准区域。参数错误、用户取消和
已开始输出的流不会因此重放。实际使用 Priority 时显示「正在使用优先通道请求」,
回复保留 Priority 标识;不支持 Priority 的模型/区域不会显示该标识。

「管理后台 → 模型设置 → 模型详情 → 限流或空回时自动兜底」可给每个对话模型指定一个
兼容的兜底模型,默认关闭,支持同服务商的不同模型。对话前端在首次限流且尚未输出时
自动用同一条已保存的问题/附件尝试兜底一次;成功后当前对话沿用它,并提供「切回原模型」,
不修改新对话默认选择。兜底失败则保留原选择,不串联其他兜底规则,已输出或执行过工具的
回复不自动重放。只有当前用户有权限且额度充足时才启用;比较模型时不自动兜底。
为让前端先接管,带有效兜底意向的主请求会直接返回首次繁忙拒绝,不会先耗尽该主模型的
区域/Priority 重试。兜底请求本身仍沿用其服务商的既有重试与 Priority 配置。

对话空回(包括只有思考而没有正文)会先自动恢复一次:有可用备用线路时换线路,
否则重新连接当前线路。仍然空回时接入已配置的模型兜底。尚未有正文的思考/签名先有限缓冲,
不会把失败尝试混进最终答案;每次实际返回的用量仍计入统计。空回与真实断流会计入线路健康状态。
纯文字回复在真实断流后保留原文,自动续写一次,优先使用其他配置线路;恢复过程保持加载,
成功后显示「已自动续写恢复」,仅剔除续写开头与原文末尾完全匹配的较长重复段。
已有工具调用或图片的回复不自动续写;用户停止、超时、内容策略拦截和输出长度限制不触发恢复。
收到正常结束信号后的连接重置不再误判为截断。自动恢复耗尽后才展示失败/不完整提示,
所有恢复仍受原回合的时间和输出上限约束,不会无限循环。

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
  ├─ providers/   openai.ts · anthropic.ts · gemini.ts(统一流式适配器接口)· failover.ts(备用线路熔断切换)
  ├─ mcp/         @modelcontextprotocol/sdk 客户端管理器
  └─ routes/      auth · chats(SSE)· images · uploads · mcp · admin · providers
```

## License

MIT
