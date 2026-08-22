const revision = __APP_REVISION__ === 'unknown' ? '' : __APP_REVISION__;

export const appVersion = __APP_VERSION__;

export const appVersionLabel = revision
  ? `v${__APP_VERSION__} · ${revision}`
  : `v${__APP_VERSION__}`;

export const appVersionTitle = [
  `Cat AgentUI v${__APP_VERSION__}`,
  revision ? `Git ${revision}` : null,
  `构建时间 ${new Date(__APP_BUILD_TIME__).toLocaleString()}`,
].filter(Boolean).join('\n');

/**
 * These notes are curated from the repository's recent commit history. Keep
 * them in-product rather than deriving them at runtime: deployed instances do
 * not need GitHub access, and operators can review exactly what users see.
 */
export const recentChanges = [
  {
    date: '2026-08-22',
    items: [
      '重新生成与编辑消息不再删除历史:每个位置可保留多个版本,用左右箭头切换分支。',
      '生成回复时可继续发送消息:自动排队依次发送,支持编辑、删除与立即打断发送。',
      '输入草稿自动保存:切换对话或刷新页面后,未发送的文字和附件自动恢复。',
      '侧栏搜索升级为全文搜索:覆盖消息正文并显示摘要,支持 project: 与 pinned: 过滤。',
    ],
  },
  {
    date: '2026-08-21',
    items: [
      '对话支持 PDF、DOCX、TXT、Markdown 及其他 UTF-8 文本文档附件。',
      '支持拖放添加图片，并在拖入时显示全屏放置提示。',
    ],
  },
  {
    date: '2026-08-20',
    items: [
      '支持直接修改模型回复，并优化流式响应结束后的后台任务处理。',
      '回答后可生成快捷追问建议，HTML/SVG 代码可内联或在侧栏预览。',
    ],
  },
  {
    date: '2026-08-19',
    items: [
      '模型选择器支持收藏与个人排序，管理员可配置全局模型顺序。',
      '模型能力与排序从服务商配置中拆分，相关变更可实时刷新。',
      '修复移动端页面与服务商配置界面的多处布局问题。',
    ],
  },
  {
    date: '2026-08-16 — 08-18',
    items: [
      '消息支持删除、分支和切换模型重新生成，操作入口保持可见。',
      '自动标题支持备用模型链，并可按个人偏好添加 Emoji。',
      '联网搜索和图片生成权限可按模型配置。',
    ],
  },
  {
    date: '2026-08-12 — 08-14',
    items: [
      '新增项目工作区，项目指令与资料会自动带入项目内对话。',
      '新增按用户的月度 Token 配额、模型访问控制和后台模型排序。',
      '新增绘图作品画廊，并统一调整主要页面的视觉与交互。',
    ],
  },
] as const;
