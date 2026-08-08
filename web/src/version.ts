const revision = __APP_REVISION__ === 'unknown' ? '' : __APP_REVISION__;

export const appVersionLabel = revision
  ? `v${__APP_VERSION__} · ${revision}`
  : `v${__APP_VERSION__}`;

export const appVersionTitle = [
  `Cat AgentUI v${__APP_VERSION__}`,
  revision ? `Git ${revision}` : null,
  `构建时间 ${new Date(__APP_BUILD_TIME__).toLocaleString()}`,
].filter(Boolean).join('\n');
