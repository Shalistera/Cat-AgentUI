English | [简体中文](README.zh-CN.md)

<div align="center">
  <img src="web/public/cat.svg" alt="Cat-AgentUI" width="96" height="96" />
  <h1>Cat-AgentUI 🐈‍⬛</h1>
  <p><strong>Lightweight · Multi-user · Multi-model AI chat and image panel</strong></p>
  <p>OpenAI (compatible / Responses API) · Anthropic Claude · Google Gemini (AI Studio / Vertex) · MCP tools</p>
</div>

---

A self-hosted AI panel that deliberately stays "light": no RAG, no plugin marketplace, no features nobody uses — it just gets the chat experience, image generation, multi-user usage management and MCP right.

## ✨ Features

- **Multi-model chat**: OpenAI-compatible APIs (optionally the newer Responses API), Anthropic, Gemini (optionally Vertex AI). Every provider supports a custom API address (Base URL) and custom headers, so it fits all kinds of relays and gateways
- **Backup routes (failover)**: a single provider can hold several gateways of the same type (for example OpenRouter as primary and LiteLLM as backup), sharing one model list, one set of permissions and one usage record. Routes are used in priority order rather than load-balanced (which preserves prompt caching); if the primary route fails before any content is returned, the same request switches to the next route (a route that simply lacks the model counts too, but is not held against its circuit breaker). After enough consecutive failures a route is tripped for a while, then probed once, and restored as soon as it recovers. You can rewrite the model name prefix per route, toggle the Responses API per route, see each route's status in Admin, reset it manually, and promote a backup route to primary with one click (the two swap places)
- **Vertex multi-region and Priority PayGo**: in Vertex mode you can order several regions by priority (for example global → us → eu, where us/eu automatically use the multi-region endpoints). If one region is rate-limited or broken, the same request moves to the next region, with the same circuit-breaking and switch notices as backup routes. Priority PayGo (higher unit price, less likely to be rate-limited) is optional: off, on-when-rate-limited (after standard requests have been rate-limited 5 times in total, or after every region has been tried, the request moves to Priority and the chat notes that the priority channel is in use), or always on. When a route does not have a given model, that is remembered for an hour and the model skips that route during the period
- **Model fallback suggestion on rate limits**: when a model's provider keeps rate-limiting, and the retry wait exceeds 10 seconds or the request finally errors out, the reply recommends a model from a different provider (the first one in your personal model order, skipping image models, models without vision when the chat contains images, models without tool support when tools are in use, and models whose quota is exhausted). One click regenerates this reply with that model, and the rest of the conversation uses it as well
- **Streaming output**: SSE streamed replies, visible reasoning, stop at any time
- **Transparent per-reply stats**: elapsed time, time to first token, input/output tokens, tokens/s
- **Image Studio**: OpenAI `gpt-image-1` and the Google Nano Banana (`gemini-*-image`) family, with reference images (image-to-image / editing) and gallery management. NovelAI V5 has its own **NAI Studio** (creation panel on the left, large canvas, history column), where a Chinese description is turned into prompts automatically, with style presets and custom artist combinations, multi-character positioning and the official UC. Tag mode colors tags by weight, adds or removes `{}`/`[]` in one click, suggests tags remembered per user, and ships a Chinese vocabulary and tag bookmarks
- **Image generation inside a chat**: just pick an image model in a chat to draw; the current conversation's context and images are carried over, so you can follow up with "make it blue" or "change the background to rain". Generated images also land in the Gallery
- **Web search**: just like the official ChatGPT / Claude / Gemini apps, there is no toggle — the model decides whether to search. Gemini on Vertex uses native Google Search Grounding directly; other models (local Claude Code, OpenAI-compatible, Anthropic) and subagents use the built-in `web_search` tool, where a small admin-designated model (`gemini-3.5-flash-lite` by default) runs the Google search on their behalf and brings back key points with sources, falling back to the backup model and then to search MCPs such as Brave on error. Every grounded sentence in the answer carries a numbered citation superscript: hover for the source, click to go there. Searches actually executed by Google are counted monthly; once the cap is reached only the backup search sources are used
- **MCP tools**: stdio / Streamable HTTP / SSE transports, shared with everyone or limited to specific users, enabled per chat as needed, with the full tool call visible
- **Multi-user**: the first registered user automatically becomes an administrator; Admin can create users, deactivate them and reset passwords, and open registration can be turned off. Administrators can search and read (read-only) a user's chat history from that user's detail page (temporary chats excluded)
- **Usage dashboard**: administrators can see tokens, request counts and image counts per user / per model / per day; users can see their own usage
- **Model usage limits**: for a single model you can set a per-person daily/weekly cap on requests or tokens, and either reject or downgrade to a designated model once it is hit; users see their own remaining quota in the model picker
- **Projects**: shared project instructions and reference text files. Tool-capable models start with instructions and a compact document directory; document bodies are retrieved on demand, even on models with large context windows. `project_search` searches Chinese/English keywords and filenames, returning up to 4 passages by default (8 maximum), with source refs and character offsets; overlapping chunks cover boundaries, and results make room for multiple documents. Search can be restricted to a document ref or name. `project_read_doc` reads by ref or name from any offset, with `max_chars` controlling the length (4,000 characters by default, 15,000 maximum). Duplicate results within one turn are replaced with a short reminder. Subagents independently retrieve their evidence and return conclusions, without preloading the main chat's documents. Operators can opt the main chat back into whole-document loading with `PROJECT_INJECT_MAX_CHARS`; models without tool calls retain bounded full-document loading. With the sandbox enabled, files are also mounted read-only at `/project/`. Answers cite sources as `[document name](doc:ref)` (ref is the first 8 hex characters of the document id); clickable source tags open the document, and editors can modify it directly
- **Automatic compaction of long chats**: history is budgeted at about half the model's estimated context window, using characters as a conservative token estimate. Compaction runs before a reply when history exceeds 90% of that budget or the message-count limit. Admin → Task models provides a dedicated **Conversation compaction model**; unset follows the chat model. A summarizer with a smaller context processes the selected history in ordered batches, carrying a rolling summary and using minimum/no reasoning. Each batch checks model access and quotas, and usage is attributed to the actual provider/model, including reported usage from failed attempts. Falling back to the chat model is a separate switch, off by default to avoid unexpected costs; cancellation or the overall timeout stops all attempts. Recent messages remain verbatim, and completed summaries are stored per branch and reused until compaction is needed again. Editing/deleting messages invalidates their summaries. The summary request reformats the history and uses a different system prompt, so choosing the same model does not guarantee reuse of the normal chat's cache
- **Document attachments that persist through the whole chat**: txt / Markdown / CSV / docx are injected as text, PDFs are handed natively to vision models; documents uploaded earlier are still passed to the model when you continue the chat, even once they fall outside the replay window of recent messages
- **Advanced chat experience**: Markdown, syntax highlighting with one-click copy, KaTeX formulas, GFM tables, image understanding (vision models), edit and resend, regenerate, automatic titles
- **UI language**: the interface is available in Simplified Chinese and English, switchable under Settings → General; non-Chinese browsers default to English
- **OCR Studio**: PDF/image to text, with Gemini vision models reading PDFs directly without preprocessing; the output is continuous full text (no pagination, no page numbers) as plain text or Markdown
- **Chat export**: one click in the sidebar menu exports to Markdown (the current branch) or JSON (the full message tree)
- **Global custom instructions**: each user can set "about me / how I want replies", which is prepended to the system prompt of every chat; a single chat's own system prompt still overrides it
- **In-chat search and Bookmarks**: Ctrl/Cmd+F searches within the current chat and jumps through the hits one by one (entering from a sidebar search result scrolls there automatically); any message can be bookmarked, reviewed on the **Bookmarks** page and jumped back to in one click
- **Chat Workspace (agent-style file workflow)**: every chat comes with its own private file directory, which the model can list, read, write, patch and delete through built-in tools when it needs to — long documents, plans, code and other deliverables are written to files and revised repeatedly instead of being re-emitted in full every turn. It is seamless for the user: the panel on the right opens by itself the first time a file appears, and after that the "Files N" tab at the top of the chat toggles it. The panel previews (Markdown / code / images / PDF / sandboxed HTML), edits online, downloads and accepts drag-and-drop uploads. Users can turn off all agent capabilities at once with "smart tools" under Settings → Chat preferences. Files are deleted with the chat and count toward the storage overview
- **One-step document conversion**: the built-in `convert_file` tool converts between Markdown / HTML / Word and to PDF (weasyprint, with CJK typography). The command is a fixed script rather than something the model spells out, so it needs no per-call confirmation and does not depend on the "allow the model to run commands" switch (the Sandbox page has its own "built-in document conversion" switch, on by default). Calls to scripts shipped with a skill are likewise treated as trusted and need no confirmation; the confirmation card has a "don't ask again in this chat" checkbox
- **In-chat image generation tool**: ordinary chat models can call `generate_image` when the task calls for it, producing one image per call and showing it directly in the chat. Administrators configure the switch, the scope, several available image models (the first is the default), the per-turn count and the daily cap for regular users under **Agent capabilities → Image generation** (20 per day by default, 0 means unlimited, administrators are exempt). Tool authorization is independent of model visibility permissions, direct image model permissions and Image Studio permissions, and does not depend on the Workspace or the Sandbox. The daily count is aggregated across models by server date, and a call counts once an upstream request has been issued (including failures and cancellations), while automatic retries do not count again. The limit still holds across concurrent requests and service restarts. Usage is listed separately as "image generation tool", and the existing token, model usage, concurrency and storage limits apply as usual. For now it is text-to-image: chat history and reference images are not attached automatically.
- **Sandboxed command execution (experimental)**: on top of the Workspace, the model can run shell commands in an isolated sandbox with `run_command` — bwrap namespace isolation (read-only /usr, only this chat's workspace mounted, no network) plus systemd user instance cgroup limits (memory / CPU / process count / timeout). The **Sandbox** page in Admin offers a host environment self-check (telling you the matching apt / sysctl command for anything missing), one-click installation of Python runtime libraries (recommended presets plus custom packages, with the venv mounted read-only into the sandbox), scope and pre-execution confirmation, and an execution audit log. For host preparation see `deploy/sandbox-host-setup.sh`
- **Skills (Agent Skills)**: administrators maintain SKILL.md (frontmatter name/description plus steps) and the accompanying scripts and material in the backend, with online editing, zip import/export, enabling and scope. In a chat the model only sees a skill's name and purpose, and reads the full instructions with `load_skill` and the accompanying files with `read_skill_file` only when the task matches. The skill directory is mounted read-only inside the sandbox at `/skills/<name>/`, so its scripts can be run directly. Two examples ship with it (Markdown to Word report, and pandas + matplotlib charting)
- **Subagents**: the model can use `spawn_subagent` to delegate a self-contained subtask (reading through long material, writing a chapter from an outline, running an analysis) to a subagent that cannot see the chat history. It has the same Workspace / Skills / Sandbox tools, cannot nest, does not use MCP, returns its result as text and leaves files in the workspace. Every step of the subagent is shown live in the main chat, and its tokens are charged to the user who started it ("subagents" in the usage dashboard)
- **Agent capability master switches**: the **Agent capabilities** page in Admin sets the switches and scope (everyone / specific users) for the Workspace, Skills and Subagents in one place; for subagents you can specify the model, the per-turn count, the tool iteration count, the timeout, the returned length and whether command execution is allowed. The whole admin backend has been reworked into a window-style UI matching the settings dialog
- **Confirmation before MCP tool execution**: administrators can enable "requires user confirmation before calling" per server, so when the model wants to call a tool, the tool and its arguments are shown in the chat first for the user to allow or deny; users can also choose to be asked for every tool
- **Chart comparison**: 2–12 data points sharing one metric and one unit can be run through `compare_data`, which computes the maximum, minimum and range and renders a fixed bar chart directly. Time-series / continuous data supports multi-line charts (1–6 series, 2–120 points each, up to 600 points in total), drawn on the real horizontal axis spacing, with gaps for missing values. Legend filtering, hover/keyboard readout, switching to the data table, negative numbers and a data source note are all supported. At most one chart is shown per turn, a format error can be corrected once, and no HTML/JS is generated. The switch and scope live under **Agent capabilities** in Admin, and the personal "smart tools" switch applies. On upgrade, user settings for the old Interactive Canvas and encrypted blocks are cleaned up automatically, while the body of past chats is preserved.
- **Mermaid diagrams and an image lightbox**: ```mermaid code blocks in a reply are rendered as diagrams (you can switch back to the source and download the SVG); images in a chat open enlarged on click
- **Background completion notifications**: when you switch to another tab, a system notification fires once a reply, an image or a PPT is finished (browser permission, toggled per device)
- **Voice**: voice input (Chrome/Edge) and read-aloud replies, all using local browser capabilities with zero server cost
- **Site announcements**: administrators publish a banner announcement that every logged-in user sees in real time and can dismiss
- **Cost conversion**: once a price per million tokens is configured per model, the usage dashboard and the personal usage page show the converted cost
- **Automatic backups**: a built-in scheduled SQLite online snapshot task with rotation; Admin can back up and download manually
- **PWA**: a manifest and a full icon set are included, so phones can "add to home screen"
- **Security**: an asynchronous bounded scrypt queue, HttpOnly session cookies, CSRF protection, login rate limiting, MCP capability ACLs, and API keys stored AES-256-GCM encrypted and never returned to the frontend
- **The isolation boundary of the Sandbox and the Workspace**: inside the sandbox, seccomp forbids creating symlinks / pipes / mounts and namespace operations; on the host side, workspace files are always opened O_NOFOLLOW and the path verified by inode, writes and command execution share a per-chat mutex, and irregular files are swept after every command. Only the skill directories the user is allowed to use are mounted at /skills, and zip imports are limited by the actual number of bytes extracted
- **Resource protection**: hard budgets for attachments/context, per-user and global storage quotas, chat/image concurrency gates, and validation of provider image response size and format

## 🚀 Quick start

Requirements: Node.js ≥ 20 (22 recommended).

```bash
git clone git@github.com:Shalistera/Cat-AgentUI.git
cd Cat-AgentUI
npm install
npm run build          # Build frontend + backend
npm start              # Listens on 0.0.0.0:3000
```

Open `http://localhost:3000`, register the first account (which automatically becomes an administrator), then go to **Admin → Providers** to add a provider and pull its models, and you are ready to chat. After initialization, open registration is off by default and later accounts are created by an administrator; you can open it manually in the site settings if you need to.

### NovelAI V5 image generation

1. Add a **NovelAI V5** provider under **Admin → Providers**. Leave the API address empty to use `https://image.novelai.net`; fill in the **Persistent API Token** from your NovelAI account settings. The token uses the same server-side encrypted storage and is never sent to the browser.
2. Pull and import `nai-diffusion-5-curated` and `nai-diffusion-5-full`. Grant these two models to specific users as needed, and enable the **Image Studio** and **image models** permissions for those users.
3. Enter via **NAI Studio** in the top-right corner of the Image Studio (`/images/nai`; it opens directly for users who only have NAI models). Everything is on one screen: describe the image, pick a style, choose an aspect ratio, add characters and drag their positions if needed, then click "Generate" or press Ctrl / ⌘ + Enter. The result appears on the canvas in the middle, and the history column lists that user's NAI works, where you can see the actual prompt, load the settings, and pin the seed to keep refining. Drafts and custom styles are saved per user in the current browser; leaving the page does not stop a submitted generation, and progress is picked up again when you come back.
4. "Smart description" mode is the default: the prompt assistant uses a text model the user has access to (the default text model is selected by default; you can switch it or turn it off in the advanced settings), and you can click "Preview" to see the cleaned-up result first. It only tidies the description and the characters and never changes the artist combination; generating the same description again reuses the cleaned-up result. Text model consumption is recorded separately as "NAI prompt assistant" and consumes no Anlas. When no text model is available you can type natural language or tags directly.
5. **Tag mode** edits the raw prompt sent to NAI directly; switching over from smart description brings along the latest cleaned-up result, and the style section is collapsed by default. As you type, it first suggests tags that user has generated with before (the server counts frequency and recency from the generation parameters of their NAI works, `GET /api/images/novelai/tag-history`), then lists NAI's own tag suggestions (with usage counts) and the built-in Chinese vocabulary, so typing Chinese also suggests the matching tag. The input box colors tags by weight, and the tag at the cursor or in the selection can be strengthened / weakened, or have a layer of `{}` / `[]` added or removed with Ctrl / ⌘ + ↑↓ (adjusted in steps of 0.1 when it already has a numeric weight); all of these edits can be undone with Ctrl / ⌘ + Z, and Chinese commas, brackets and so on are converted to their ASCII equivalents automatically. "Tidy" normalizes commas and spaces, turns underscores into spaces, splits space-separated lists copied from Danbooru, and deduplicates. The "tag library" holds common tags, bookmarked tag combinations (saved per user in the current browser) and categorized vocabularies: click to add, click again to remove. If Chinese text remains, you can use the prompt assistant to convert only the Chinese fragments into tags (`POST /api/images/novelai/tagify`; nothing else is sent, and the usage is likewise recorded as "NAI prompt assistant"). The official UC (called "base filter" in the UI) defaults to Heavy and is saved separately from your custom exclusions; text that should appear in the image goes at the end of the final prompt, and `no text` is not appended when there is such text. "Open in NAI Studio" in the image details of a collection restores the description, characters, artist weights, UC and size; the seed goes back to random by default, so click "pin seed" on the canvas when you need to reproduce an image.

**Subscription allowance mode** only supports a valid Opus subscription, single-image text-to-image, at most 28 steps, and the three Normal sizes `1216×832`, `832×1216` and `1024×1024`. The defaults are 23 steps, Guidance 7 and Euler Ancestral. The server reads the latest subscription status before every generation and stops when the allowance is unknown, unavailable or below 1%. The two models under the same token share a concurrency lock within the service process. Generation requests are not retried automatically, do not switch to a backup route, and do not downgrade to an older model. The Anlas balance is for viewing only; Vibe Transfer, image-to-image, inpainting, upscaling and batch generation are not available yet.

NovelAI's public API has no confirmed atomic "cost must be 0" parameter. The pre-checks above cannot lock out other clients: if the same account exhausts its allowance on the website or in another service process at the same time, the upstream may still switch to consuming Anlas. What is implemented here is a subscription pre-check that keeps a 1% margin, not a guarantee that a Normal size is free of charge. If you need strict isolation, avoid generating concurrently with the same account from several clients.

For the API protocol and the presets, see the [official API](https://image.novelai.net/docs/index.html), [character positions](https://docs.novelai.net/en/image/multiplecharacters/), [UC presets](https://docs.novelai.net/en/image/undesiredcontent/) and the [subscription allowance explainer](https://journal.novelai.net/opus-usage-limit-explained/). Regression testing uses a local mock service: `npm run test:novelai`, which calls neither the real NAI nor your allowance; the text tools and vocabulary of tag mode are covered by `npm run test:nai-tags`.

### Running persistently with pm2 (recommended)

```bash
npx pm2 start deploy/ecosystem.config.cjs
npx pm2 save
# Start on boot (without root): run crontab -e and add
# @reboot cd /path/to/Cat-AgentUI && npx pm2 resurrect
```

### Environment variables (`.env`, generated automatically)

| Variable | Description | Default |
|------|------|------|
| `PORT` | Listening port | `3000` |
| `HOST` | Listening address | `0.0.0.0` |
| `SECRET_KEY` | Seed for session and secret encryption (generated on first start, **do not leak or lose it**) | generated |
| `DATA_DIR` | Data directory (SQLite, uploads, generated images) | `./data` |
| `COOKIE_SECURE` | Set to `true` for HTTPS deployments | `false` |
| `TRUST_PROXY` | Set to `true` behind a reverse proxy (nginx etc.) | `false` |
| `SESSION_TTL_DAYS` | Session lifetime | `30` |
| `MAX_UPLOAD_MB` | Image upload limit | `20` |
| `MAX_ATTACHMENTS_PER_MESSAGE` | Default maximum attachments per message (1–100); administrators can override it under "Admin → Storage", it takes effect immediately on save, and the OCR/image attachment checks share it | `20` |
| `MAX_MESSAGE_ATTACHMENT_MB` | Total raw bytes of attachments per message | `20` |
| `MAX_MESSAGE_TEXT_CHARS` | Character limit of the text of one message | `64000` |
| `MAX_CONTEXT_MESSAGES` | Maximum number of messages replayed verbatim (beyond that they are compacted into a summary) | `400` |
| `MAX_CONTEXT_TEXT_CHARS` | Character limit of the chat history; the actual budget is computed automatically as about half the model's context, and the smaller of the two is used | `1000000` |
| `PROJECT_INJECT_MAX_CHARS` | `0`: tool-capable models retrieve document bodies on demand. A positive value opts the main chat into full-document loading, also capped at about 15% of the estimated context. Subagents always retrieve on demand; models without tool calls retain the legacy bounded loading fallback | `0` |
| `MAX_CONTEXT_IMAGE_MB` | Raw byte budget for images in the model context | `24` |
| `MAX_CONTEXT_IMAGES` | Budget for the number of images/PDFs in the context; the larger of this value and the current per-message attachment limit is used, so one batch of attachments can always enter the context | `6` |
| `MAX_CONTEXT_IMAGE_MB_PER_USER` | Byte budget for context images resident at once for one user | `48` |
| `MAX_CONTEXT_IMAGE_MB_GLOBAL` | Byte budget for context images resident at once site-wide | `96` |
| `DEFAULT_MODEL_OUTPUT_TOKENS` | Output token limit per model request when nothing else is set; for Gemini it includes thinking and is not the model's maximum capacity | `8192` |
| `MAX_MODEL_OUTPUT_TOKENS` | Hard limit on output tokens for one model call | `65536` |
| `MAX_TURN_OUTPUT_CHARS` | Hard limit on the accumulated characters of one turn (including thinking and tool results) | `500000` |
| `CHAT_TURN_TIMEOUT_SECONDS` | Total timeout of one turn of ordinary text chat | `900` |
| `CHAT_PROVIDER_IDLE_TIMEOUT_SECONDS` | Idle timeout for a provider stream with no events | `120` |
| `PROVIDER_RETRY_MAX_WAIT_SECONDS` | Maximum total wait for retries within one request when the upstream returns 429/503/529 | `60` |
| `FAILOVER_RETRY_WAIT_SECONDS` | With backup routes configured, how long a rate-limited earlier route is waited on before moving to the next one | `10` |
| `VERTEX_REGION_RETRY_WAIT_SECONDS` | How long a rate-limited Vertex region is waited on before switching to the next region (or retrying on Priority) | `3` |
| `VERTEX_PRIORITY_AFTER_RETRIES` | With Priority PayGo set to "on when rate-limited", how many times standard requests must be rate-limited within one request before moving to Priority | `5` |
| `MAX_USER_UPLOAD_MB` | Default per-user attachment storage quota; administrators can override it under "Admin → Storage" and it takes effect immediately on save; users can see their own usage and delete attachments under "Settings → Attachment storage" | `512` |
| `MAX_USER_IMAGE_MB` | Per-user storage quota for generated images | `1024` |
| `MAX_TOTAL_STORAGE_MB` | Site-wide quota for attachments plus generated images | `10240` |
| `MAX_GENERATED_IMAGE_MB` | Size limit for a single generated image | `20` |
| `MAX_CHAT_CONCURRENCY_PER_USER` | Concurrent chats per user | `2` |
| `MAX_CHAT_CONCURRENCY_GLOBAL` | Concurrent chats site-wide | `20` |
| `MAX_IMAGE_CONCURRENCY_PER_USER` | Concurrent image generations per user (one model can only ever run one, so concurrency requires different models) | `3` |
| `MAX_IMAGE_CONCURRENCY_GLOBAL` | Concurrent image generations site-wide | `8` |
| `PASSWORD_CONCURRENCY` | Number of scrypt runs at once | `2` |
| `PASSWORD_QUEUE_MAX` | Length of the scrypt wait queue | `32` |
| `MAX_TOOL_ITERATIONS` | Maximum MCP tool iterations for one reply | `10` |
| `MAX_WORKSPACE_MB` | Total size limit of one chat's workspace | `64` |
| `MAX_WORKSPACE_FILE_MB` | Size limit of a single workspace file | `8` |
| `MAX_WORKSPACE_FILES` | File count limit of one chat's workspace | `500` |
| `MAX_SANDBOX_CONCURRENCY` | Sandbox commands running at once site-wide (1 per person) | `3` |
| `MAX_SANDBOX_TIMEOUT_SECONDS` | Upper bound an administrator can set for a single command's timeout | `600` |
| `BACKUP_INTERVAL_HOURS` | Initial default for the automatic database snapshot interval (0 = off by default); the actual policy is set under "Admin → Backup & migration" and stored in the database | `24` |
| `BACKUP_KEEP` | Initial default for the number of snapshots kept; changeable in the backend | `14` |

### Chart tool parameters and recovery

The description of `compare_data` provides minimal JSON examples for a bar chart and a line chart. Pick the fields you need per `chart` and ignore the other chart's fields and placeholder values;
the line example shows two series sharing one horizontal axis and does not depend on Python/scipy/matplotlib. The model can still use the sandbox when it genuinely needs to compute or fit data,
but an in-chat chart of known values goes straight through `compare_data`; the sandbox and skill prompts are steered by this turn's chart permission and never ask for a plotting library to be installed just to draw several series.
When the current user message explicitly asks for a particular kind of chart, or matches "comparison + shown over time", only that chart's parameters and example are offered, and the runtime also rejects a mismatched chart type.
An explicit request for a bar chart takes precedence over the time-series default; an ambiguous request keeps both options. This check can stop the wrong chart type from being used, but it cannot prove that the values, the metric or the source semantics are correct.
When the target data is missing, the original material is looked up again first; if it still cannot be obtained, a short explanation is given. A peak or a total must not be cobbled into a chart that fails to answer the change over time, and series must not be invented without a basis.
When no chart type is specified, it can be inferred from `items` or `series` being supplied on their own; when both sets of data are present, an explicit choice is required. Pure numeric strings can be converted to numbers,
while empty strings, booleans and strings with units are not treated as numbers. The data source is allowed up to 1000 characters so that links fit.
The number of data points, the order of the horizontal axis, the series lengths, missing values and units/sources are still validated; nothing is silently sorted, filled in or guessed.
A format error returns the specific fields and the model may correct itself once based on that feedback; after a success or two cumulative failures, this turn's chart tool is withdrawn, and the runtime also blocks calls past the limit.
When no chart call was made, the model is not additionally asked to rewrite the answer. The Responses API explicitly sends `strict: false` to keep the optional fields of the shared tool definition,
so that the server does not convert it to strict mode and then require fields that do not apply; Chat Completions, Anthropic and Gemini keep their own parameter protocols.
See [OpenAI's strict mode for tools](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

### Output limits and Gemini thinking

Ordinary chat uses `min(the chat's maxTokens or DEFAULT_MODEL_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_TOKENS)` for every model request.
The default request limit is 8192; tools produce several requests per turn, so the output tokens in the reply stats accumulate across them and include Gemini thinking tokens.
Gemini 3.7/3.8 Flash send the low/medium/high tiers via the native `thinkingLevel`; they cannot turn thinking off entirely, so the lowest tier uses low and hides the thinking summary.
When a high thinking tier hits the limit, you can raise `DEFAULT_MODEL_OUTPUT_TOKENS` in your deployment as needed (to 32768 or 65536, for example),
but the effective value is still bound by `MAX_MODEL_OUTPUT_TOKENS` and the provider's limits; a `maxTokens` explicitly saved on an existing chat takes precedence.
Raising the limit allows more thinking and output; it does not guarantee low latency or low cost. Chart tasks default to fetching the data first, drawing the chart next and writing a short conclusion last. When the current user message explicitly asks for a chart or matches "comparison + shown over time",
a short chart-intent hint is added for that turn; only the current user message is considered, quotes and code snippets are ignored, and requests that explicitly rule out a chart, as well as pure translation or programming requests, are skipped.
This decision does not involve another model call and does not change Vertex native search or any other agent tool; nor is a long answer sent off for conversion after it is generated.
Gemini's stream-end log includes `requestedMaxOutputTokens`, `thoughtTokens` and `answerTokens`, which makes actual truncation easy to locate. The turn-end log also records `comparisonIntentMatched`, `comparisonTarget`, `comparisonAttempts` and
`comparisonRendered`, which distinguishes an unmatched intent, an uncalled tool, and a tool that was called but drew nothing.
See [Google's thinking and output budget documentation](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

### Web search

Web search is one of the capabilities under **Admin → Agent capabilities → Web search** (on by default, subject to the user's "smart tools" switch),
and there is no toggle in the input box: search is always available and the model decides per question whether to call it.

- **Vertex Gemini**: Gemini 2.5/3.x text models carry `tools: [{ googleSearch: {} }]` directly in the
  `generateContent` request, so the search happens inside the model's own reasoning and sources are cited per sentence. Gemini 3.x
  can combine it with function tools in one request; Gemini 2.5 cannot, so when other tools are present in the same turn, the `web_search` below is used instead.
- **Other models and subagents**: the built-in function tool `web_search(query)` is provided. When it is called, the server sends one
  Google-grounded request to the "search model" (by default the first enabled Gemini provider, preferring Vertex, with the model
  `gemini-3.5-flash-lite`) and hands back the key points and numbered sources as the tool result, with the sources also shown as citation superscripts.
  The tools that the panel forwards to local Claude Code use the same `web_search`.
- **Web fetch**: the built-in function tool `web_fetch(url, focus?, offset?)` lets the model open a search result or any web page to verify the original text.
  Fetching happens on the server itself (only http/https and ports 80/443/8080/8443 are allowed; the resolved IP is checked on every connection and redirect,
  and private, loopback and reserved addresses are rejected), and the body is extracted with Readability. Short pages are returned verbatim, while for long pages the "web reading model"
  (the search model by default) first picks out the passages relevant to `focus` and verifies word for word that they really appear in the body before handing them to the chat model — usually about
  a tenth of the whole page — after which further sections of the original can be read by `offset` as needed (cached for 10 minutes). Pages the server cannot read (blocked, script-rendered, PDF)
  are read by Gemini's urlContext instead and marked as unverified. Tokens for web reading count toward "web fetch" in the usage dashboard and do not consume the Google search allowance.
- **Fallbacks**: each `web_search` tries, in order, the search model → the backup model (`gemini-3.1-flash-lite` by default, and you can point it at
  another Gemini provider such as AI Studio) → the servers marked as a "search source" under **Admin → MCP** (Brave, for example),
  with a 20-second timeout per step. A model that has failed is paused for 2 minutes, so a Vertex outage does not mean waiting for the timeout every time. Google occasionally returns key points without sources, in which case a search MCP is used to supply links for the same query (and if there is no MCP, the search is simply run again), so the model always has URLs it can open and verify.
- **Cost control**: Google search for Gemini 3.x is billed per search query actually executed (a single question often searches 2–3 times),
  and there is a shared monthly free allowance. The panel accumulates the search count of `web_search` per month, and once the "monthly Google search cap"
  (5000 by default) is reached only the backup search sources are used; regular users and administrators can have separate daily call caps (100 / unlimited by default).
  The search model's tokens count toward "web search" in the usage dashboard.

Supported models, quotas, billing and display terms are governed by the
[official Google Cloud documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/grounding/grounding-with-google-search).

MCP is shared with all logged-in users by default, which suits basic tools such as web search. Sensitive MCPs —
files, command execution, internal systems — should be changed to "only specific regular users" under
**Admin → MCP → Edit server → Scope**; administrator permission always applies implicitly.

Provider API keys, Vertex service accounts, provider custom headers and MCP env/headers are all
encrypted at rest with `SECRET_KEY` and treated as write-only (never echoed back); provider/MCP errors, tool results and model streams
are also scrubbed of secrets. Note that a stdio MCP is trusted code running under the same system account as this site. A shell, filesystem or
malicious MCP can read files and exfiltrate transformed content, and string scrubbing cannot make a real sandbox, so do not expose
untrusted local command/file tools to regular users.

## 🧰 Development

```bash
npm run dev:server     # tsx watch, :3000
npm run dev:web        # vite dev, :5173 (proxies /api → :3000)
npm run test:security  # Isolated security regression with a temporary database and mock provider/MCP
npm run test:upload-quota # Attachment quota settings and upload regression on a temporary database
npm run test:provider-retry # Simulated 429: bounded retries, cancellation, attachment retention and broken-stream protection
npm run test:stream-parser # Trailing SSE end events, chunked encoding, late endings and real stream breaks
npm run test:chat-recovery # Resuming the original generation after a disconnect, recovery on refresh, explicit stops and user isolation
npm run test:chat-fallback # Configurable model fallback, sticking with it after success, not changing the selection on failure, permissions and loop prevention
npm run test:response-integrity # Automatic route switch on an empty reply, thinking buffering, recovery limits, continuation dedup and end confirmation
npm run test:provider-failover # Backup routes: priority switching, circuit-breaker thresholds and cooldown probes, not replaying a stream that has started; Vertex region order and Priority
npm run test:data-comparison # Chart comparison: input validation, permissions, counts, message persistence and cleanup of the old experimental settings
npm run test:model-fallback   # The model recommended on sustained rate limiting: other providers, personal order, capabilities and quota
node scripts/mock-openai.mjs   # A local fake OpenAI (:4141/v1) for integration work without a real key
                               # Provides chat streaming, tool calls, and image generation / editing (images/generations and images/edits)
```

When a Gemini / Vertex stream ends, the server emits a structured `Provider stream ended` log, correlated with
`Chat turn finished` by `chatId` / `messageId`. The former records the actual `location`,
`endpointId`, `priority`, the raw `finishReason`, `transport`, `invalidEvents` and
`sinceLastByteMs`, and never the chat body or any secret. `transport=eof` with no `finishReason`
only means the connection was read to the end without a confirmed normal completion; `transport=error` means a read error;
`transport=aborted` means an explicit cancellation or a local timeout, which can be told apart with `timeout`;
`clientGone` only means the browser connection has dropped, and a resumable request is not cancelled by that flag alone.
If the server records `finishReason=STOP` and ends as `stop` while the browser still reports an incomplete reply,
check the SSE path between the browser and the panel. Upstream heartbeats count as connection activity, so the idle timeout
is not triggered merely by the absence of new tokens; the overall generation time limit still applies.

When a chat request carries a `requestId`, a broken browser connection does not cancel the background generation. The page restores the body, the retry state
and the tool confirmations of that same turn through the read-only `stream-state` endpoint until the background work really finishes,
and never replays the model request automatically. Reopening the chat continues tracking it as well; "Stop" cancels the generation by request id
through a separate endpoint. The background work is still bound by the original overall time limit, and older clients that send no `requestId` keep the cancel-on-disconnect behavior.

Vertex Priority PayGo can be set to "enable on the first failure": when the first switchable error occurs before any output,
it jumps straight to Priority, skipping the standard channel's internal retries and the other standard regions. Parameter errors, user cancellations
and streams that have already started producing output are not replayed because of this. When Priority is actually used, "requesting via the priority channel" is shown
and the reply keeps the Priority marker; models/regions that do not support Priority do not show it.

**Admin → Model settings → Model details → Automatic fallback on rate limits or an empty reply** lets you designate one
compatible fallback model per chat model. It is off by default and supports a different model from the same provider. On the first rate limit before any output, the chat frontend
automatically tries the fallback once with the same saved question and attachments; on success the current chat sticks with it and offers "switch back to the original model",
without changing the default selection for new chats. If the fallback fails, the original selection is kept, no other fallback rules are chained, and a reply that has already produced output
or run a tool is not replayed automatically. It is only enabled when the current user has permission and sufficient quota, and it does not kick in when comparing models.
So that the frontend can take over first, a primary request with a valid fallback intent returns the first busy rejection directly, rather than first exhausting that primary model's
region/Priority retries. The fallback request itself still follows its own provider's existing retry and Priority configuration.

An empty chat reply (including thinking with no body) is recovered automatically once first: it switches routes if a backup route is available,
otherwise it reconnects to the current route. If it is still empty, the configured model fallback kicks in. Thinking/signatures that have no body yet are buffered within limits,
so failed attempts are not mixed into the final answer; the usage actually returned by each attempt is still counted. Empty replies and real stream breaks count toward route health.
A pure text reply keeps its text after a real stream break and is continued once automatically, preferring the other configured routes; the recovery keeps the loading state,
shows "automatically continued and recovered" on success, and only strips the longer duplicated segment where the start of the continuation exactly matches the end of the original text.
Replies that already contain tool calls or images are not continued automatically; a user stop, a timeout, a content policy block and the output length limit do not trigger recovery.
A connection reset after a normal end signal is no longer misread as truncation.
The failure/incomplete notice is only shown once automatic recovery is exhausted, and every recovery is still bound by the original turn's time and output limits, so it cannot loop forever.

## 🗄️ Data and migration

- The database is SQLite (WAL mode), in the file `data/cat-agentui.db`, which is plenty for 10–20 concurrent people; the schema is managed by [Drizzle ORM](https://orm.drizzle.team) and the migration files are in `server/drizzle/`
- Backups: the service takes an online SQLite snapshot into `data/backups/` every 24 hours (keeping the latest 14; Admin can back up and download manually). A snapshot only contains the database, so attachments and generated images still need a full backup of the `data/` directory together with `.env` (the secrets are encrypted with `SECRET_KEY`, so the two must be kept as a pair)
- Export: `npm run db:export -w server` produces a full JSON dump, which makes a later migration to PostgreSQL or similar easier

### Migrating from Open WebUI

**Option 1 (recommended): Admin → Backup & migration.** Just upload webui.db. It supports a dry-run preview, and you can optionally fill in the
Open WebUI data directory on the server to bring the attachments over (images and documents; PDFs, legacy Office files and so on are migrated along with the text Open WebUI already extracted, and citations in replies are preserved as "reference sources").

**Option 2: the command line**

```bash
# Stop Open WebUI first, then:
npm run db:import-openwebui -w server -- \
  --db /path/to/open-webui/data/webui.db \
  --data-dir /path/to/open-webui/data     # Optional, for moving chat attachments and generated images
```

**For a large database (GB scale):** a webui.db with many embedded images easily runs to several GB — do not go through a browser upload. Slim it down on the source machine first and copy it to
this machine to run the command line:

```bash
sqlite3 webui.db "PRAGMA wal_checkpoint(TRUNCATE)"       # Merge the WAL into the main file
sqlite3 webui.db "VACUUM INTO 'webui-compact.db'"        # Drop free pages; usually much smaller
rsync webui-compact.db your-server:/tmp/                 # Copy the attachment directories (data/uploads etc.) too
```

The import commits one conversation at a time, so memory use is independent of the database size; an interruption part-way through or a single conversation failing to parse does not affect the rest, and re-running resumes.

- **Users**: the login name is the original email (lowercased), and the display name, role (admin/user) and deactivated state are carried over as-is;
  **the original passwords work directly** — bcrypt/argon2 hashes are migrated verbatim and upgraded to this site's scrypt format automatically after the first successful login.
  Open WebUI's `WEBUI_SECRET_KEY` is not needed (it only signs JWT sessions and is not involved in password hashing)
- **Chat history**: the current branch of each conversation is migrated (matching what the Open WebUI interface shows), and reasoning
  (`<details type="reasoning">` or the structured output of 0.11+), tool calls and attached images are all parsed into this site's message format
- Accounts that logged in via OAuth/LDAP and have no local password are migrated but cannot log in yet; they are listed in the report and an administrator only needs to reset the password in the backend
- `--dry-run` (report only, no writes) and `--skip-archived` (skip archived conversations) are supported; re-running is safe (existing users/conversations are skipped automatically)

## 🏗️ Architecture

```
web/     React 19 + Vite + Tailwind v4 (served by the backend after the build)
server/  Fastify 5 + better-sqlite3 + Drizzle (TypeScript, ESM)
  ├─ providers/   openai.ts · anthropic.ts · gemini.ts (unified streaming adapter interface) · failover.ts (backup route circuit breaking and switching)
  ├─ mcp/         @modelcontextprotocol/sdk client manager
  └─ routes/      auth · chats (SSE) · images · uploads · mcp · admin · providers
```

## License

MIT
