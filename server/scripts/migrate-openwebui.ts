// CLI wrapper for the Open WebUI importer (also available in 管理后台 → 数据迁移).
//
// Usage:
//   npm run db:import-openwebui -w server -- --db /path/to/webui.db [options]
//
// Options:
//   --db <path>          Open WebUI 的 webui.db(必填)
//   --data-dir <path>    Open WebUI 的 data 目录(可选,用于搬运聊天附件/生成图片)
//   --dry-run            只报告将要迁移的内容,不写入
//   --skip-archived      跳过已归档的会话(默认全部迁入)
import { importOpenwebui } from '../src/openwebui-import.js';
import { runMigrations } from '../src/db/index.js';

function parseArgs(argv: string[]) {
  const out: { db?: string; dataDir?: string; dryRun: boolean; skipArchived: boolean } = {
    dryRun: false, skipArchived: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-archived') out.skipArchived = true;
    else { console.error(`未知参数: ${a}`); process.exit(1); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) {
  console.error('用法: npm run db:import-openwebui -w server -- --db /path/to/webui.db [--data-dir /path/to/open-webui/data] [--dry-run] [--skip-archived]');
  process.exit(1);
}

console.log(`源库: ${args.db}`);

let report;
try {
  // The CLI is commonly the first command run against a fresh Cat-AgentUI
  // data directory. The HTTP import route is initialized by server startup,
  // but the standalone command must create/upgrade the target schema itself.
  runMigrations();
  report = importOpenwebui({
    dbPath: args.db, dataDir: args.dataDir, dryRun: args.dryRun, skipArchived: args.skipArchived,
  });
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

console.log(`发现 ${report.sourceUsers} 个用户,${report.sourceChats} 个会话${args.skipArchived ? '(已跳过归档)' : ''}`);
console.log('');
console.log(`用户: 新迁入 ${report.users.migrated},合并到已有账号 ${report.users.merged},改名 ${report.users.renamed.length}`);
if (report.users.renamed.length) {
  console.log(`  ⚠ 以下账号无邮箱且用户名与他人冲突,已改名(不合并,避免聊天记录错归):`);
  for (const n of report.users.renamed) console.log(`    - ${n}`);
}
if (report.users.noPassword.length) {
  console.log(`  ⚠ 以下账号在 Open WebUI 中无本地密码(OAuth/LDAP 登录),已迁入但暂不可登录,请管理员在后台重置密码:`);
  for (const n of report.users.noPassword) console.log(`    - ${n}`);
}
console.log(`会话: 迁入 ${report.chats.migrated},已存在跳过 ${report.chats.existing},无法解析/无归属跳过 ${report.chats.skipped}`);
console.log(`消息: ${report.messages.migrated} 条`);
console.log(`附件: 复制 ${report.files.copied},内联解码 ${report.files.inlined},缺失 ${report.files.missing.length},带文本提取 ${report.files.withText},仅可下载 ${report.files.unreadable.length}`);
if (report.files.unreadable.length) {
  console.log('  以下附件没有模型可读的内容(原文件已迁入,可下载):');
  for (const n of report.files.unreadable.slice(0, 20)) console.log(`    - ${n}`);
  if (report.files.unreadable.length > 20) console.log(`    … 另 ${report.files.unreadable.length - 20} 个`);
}
if (report.files.missing.length && !args.dataDir) {
  console.log('  提示: 传入 --data-dir /path/to/open-webui/data 可搬运附件文件');
}
if (report.errors.length) {
  console.log(`  ⚠ 部分会话处理失败已跳过(修正后重跑即可续传):`);
  for (const e of report.errors) console.log(`    - ${e}`);
}

if (args.dryRun) {
  console.log('\n(dry-run,未写入任何数据)');
} else {
  console.log('\n迁移完成 ✅');
  console.log('迁入用户用原来的邮箱 + 原密码即可登录;首次登录后密码会自动升级为本站格式。');
}
