// English replacements for DYNAMIC server messages (template literals), used by
// tServer after an exact dictionary lookup misses. Regexes are anchored and
// deliberately few: only messages users hit often (quota, per-model usage
// limits, provider rate limits, size/count limits, endpoint failover).
// `$1`-style groups carry the numbers and names through untranslated.
//
// This file lives OUTSIDE ./en/ on purpose — index.ts globs ./en/*.ts as
// dictionaries.
const serverPatterns: [RegExp, string][] = [
  // ---- monthly token quota (quota.ts, routes/chats.ts) ----
  [/^本月 token 配额已用完\(已用 (.+?) \/ 上限 (.+?)\),下月 1 日自动恢复,如有需要请联系管理员调整$/,
    'Monthly token quota used up ($1 of $2). It resets on the 1st of next month — contact an admin if you need more.'],
  [/^本月 token 配额已用完,已自动切换到基础模型「(.+?)」$/,
    'Monthly token quota used up — switched to the basic model "$1".'],

  // ---- per-model daily/weekly usage limits (quota.ts) ----
  [/^「(.+?)」今日 token 用量已达上限\(已用 (.+?) \/ 上限 (.+?)\),明天 0 点后恢复,请换用其他模型$/,
    'Daily token limit reached for "$1" ($2 of $3). It resets after midnight — use another model.'],
  [/^「(.+?)」本周 token 用量已达上限\(已用 (.+?) \/ 上限 (.+?)\),下周一 0 点后恢复,请换用其他模型$/,
    'Weekly token limit reached for "$1" ($2 of $3). It resets Monday after midnight — use another model.'],
  [/^「(.+?)」今日使用次数已达上限\((.+?) \/ (.+?) 次\),明天 0 点后恢复,请换用其他模型$/,
    'Daily request limit reached for "$1" ($2 of $3). It resets after midnight — use another model.'],
  [/^「(.+?)」本周使用次数已达上限\((.+?) \/ (.+?) 次\),下周一 0 点后恢复,请换用其他模型$/,
    'Weekly request limit reached for "$1" ($2 of $3). It resets Monday after midnight — use another model.'],

  // ---- provider rate limits / upstream errors (providers/sse.ts) ----
  [/^(.+?) 的上游模型服务当前繁忙（被限流），已自动等待重试仍未成功，请稍后再试。$/,
    '$1 is rate-limiting us right now; waiting and retrying didn\'t help. Please try again shortly.'],
  [/^(.+?): 上游返回了错误 \((\d+)\),请稍后再试$/,
    '$1: the upstream returned an error ($2) — please try again shortly.'],

  // ---- endpoint failover notices (routes/chats.ts) ----
  [/^线路「(.+?)」暂时不可用\((.+?)\),已切换到「(.+?)」$/,
    'Endpoint "$1" is temporarily unavailable ($2) — switched to "$3".'],
  [/^图片生成线路「(.+?)」暂时不可用\((.+?)\),已切换到「(.+?)」$/,
    'Image endpoint "$1" is temporarily unavailable ($2) — switched to "$3".'],
  [/^MCP 服务器「(.+?)」连接失败: (.+)$/, 'Couldn\'t connect to MCP server "$1": $2'],
  [/^Provider「(.+?)」不支持图像生成$/, 'Provider "$1" doesn\'t support image generation'],

  // ---- size / count limits (routes/chats.ts, uploads, ocr, images, projects) ----
  [/^消息文字超过 (.+?) 字符限制$/, 'Message text exceeds the $1 character limit'],
  [/^每条消息最多添加 (\d+) 个附件$/, 'At most $1 attachments per message'],
  [/^每次最多添加 (\d+) 个附件$/, 'At most $1 attachments at a time'],
  [/^附件总大小超过 (\d+) MB 限制$/, 'The attachments exceed the $1 MB limit'],
  [/^单次回复超过 (.+?) 字符限制$/, 'The reply exceeds the $1 character limit'],
  [/^每条回复最多追加 (\d+) 条消息$/, 'At most $1 messages can be added to one reply'],
  [/^单个文件不能超过 (\d+) MB$/, 'A single file can\'t exceed $1 MB'],
  [/^工作区已达 (\d+) MB 上限,请先删除一些文件$/, 'The workspace has hit its $1 MB limit — delete some files first'],
  [/^工作区文件数不能超过 (\d+) 个$/, 'The workspace can\'t hold more than $1 files'],
  [/^参数错误:单个文档不能超过 (.+?) 字符$/, 'Invalid request: a single document can\'t exceed $1 characters'],
  [/^每个项目最多 (\d+) 个文档$/, 'At most $1 documents per project'],
  [/^项目资料总量超出上限\((.+?) 字符\),请删减后再(?:上传|保存)$/,
    'The project\'s reference files exceed the limit ($1 characters) — trim them first'],

  // ---- chat turn timeouts (routes/chats.ts) ----
  [/^Provider 连续 (\d+) 秒没有返回数据$/, 'The provider sent no data for $1s'],
  [/^对话生成超过 (\d+) 秒总时限$/, 'The reply exceeded the $1s total time limit'],

  // ---- 本地 Claude Code plan usage (routes/providers.ts) ----
  [/^读取 Claude 用量失败:(.+)$/, 'Couldn\'t read the Claude plan usage: $1'],

  // ---- system update (system-update.ts): errors and job log lines ----
  [/^仓库 (.+?) 的所有者不是运行服务的用户,git 拒绝操作;请让服务以仓库所有者的身份运行\(systemd 单元的 User=\),或把仓库 chown 给服务用户$/,
    'The checkout $1 is owned by a different user than the one running the service, so git refuses to touch it. Run the service as the checkout\'s owner (User= in the systemd unit), or chown the checkout to the service user'],
  [/^(.+?) 不是 git 仓库的检出\(例如复制文件或解压部署的\),无法在面板里更新$/,
    '$1 isn\'t a git checkout (it was probably deployed by copying files or unpacking an archive), so it can\'t be updated from the panel'],
  [/^(.+?) 在另一个 git 仓库\((.+?)\)里面,无法在面板里更新$/, '$1 sits inside another git repository ($2), so it can\'t be updated from the panel'],
  [/^仓库 (.+?) 属于另一个用户\(uid (\d+)\),服务以 uid (\d+) 运行;从面板更新会留下属主不同的文件。请让服务以仓库所有者的身份运行\(systemd 单元的 User=\),或把仓库 chown 给服务用户$/,
    'The checkout $1 belongs to another user (uid $2) while the service runs as uid $3; updating from the panel would leave files owned by the wrong user. Run the service as the checkout\'s owner (User= in the systemd unit), or chown the checkout to the service user'],
  [/^无法读取 git 仓库:(.+)$/, 'Couldn\'t read the git repository: $1'],
  [/^分支 (.+?) 没有设置上游分支,无法在面板里更新$/, 'Branch $1 has no upstream set, so it can\'t be updated from the panel'],
  [/^拉取远端失败:(.+)$/, 'Fetching from the remote failed: $1'],
  [/^新版本没有通过启动自检\(退出码 (.+?)\)$/, 'The new version failed its startup self-test (exit code $1)'],
  [/^(.+?) 失败\(退出码 (.+?)\)$/, '$1 failed (exit code $2)'],
  [/^(.+?) 失败\(npm 报告了错误\)$/, '$1 failed (npm reported an error)'],
  [/^(.+?) 超时\((\d+) 秒\),已终止$/, '$1 timed out after $2s and was stopped'],
  [/^数据库已快照:(.+)$/, 'Database snapshot taken: $1'],
  [/^等待 (\d+) 个进行中的任务结束…$/, 'Waiting for $1 running task(s) to finish…'],
  [/^回滚到 (\S+)…$/, 'Rolling back to $1…'],
  [/^回滚失败:(.+)$/, 'Rollback failed: $1'],
  [/^切换前端文件失败:(.+)$/, 'Swapping in the new frontend failed: $1'],
  [/^服务已重启,当前版本 (\S+)$/, 'Service restarted, now on $1'],
  [/^仓库 (.+?) 属于 root,服务以 uid (\d+) 运行,面板不能直接改动代码。要从面板更新,请在服务器上安装更新助手:(.+)$/,
    'The checkout $1 belongs to root while the service runs as uid $2, so the panel can\'t change the code itself. To update from the panel, install the update helper on the server: $3'],
  [/^仓库检出的分支不是更新助手配置的分支\((.+)\)$/, 'The checked-out branch isn\'t the one the update helper is configured for ($1)'],
  [/^更新助手的配置有误:(.+)$/, 'The update helper\'s configuration is wrong: $1'],
  [/^更新助手出错:(.+)$/, 'The update helper failed: $1'],
  [/^更新助手没有响应,请检查 (\S+) 是否已启用$/, 'The update helper didn\'t respond; check that $1 is enabled'],
  [/^无法把请求交给更新助手:(.+)$/, 'Couldn\'t hand the request to the update helper: $1'],
  [/^交给更新助手 (\S+)$/, 'Handed over to the update helper $1'],
  [/^重启后运行的版本是 (\S+),不是要更新到的 (\S+)$/, 'After the restart the service runs $1, not $2 as intended'],
];

export default serverPatterns;
