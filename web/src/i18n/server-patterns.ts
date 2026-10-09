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
];

export default serverPatterns;
