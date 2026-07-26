// Export the entire database to a portable JSON file (for backup or migrating
// to another database, e.g. PostgreSQL). Files in data/uploads and data/images
// should be copied alongside.
// Usage: npm run db:export -w server
import fs from 'node:fs';
import path from 'node:path';
import { db, schema } from '../src/db/index.js';
import { config } from '../src/config.js';

const tables = {
  users: schema.users,
  sessions: schema.sessions,
  providers: schema.providers,
  models: schema.models,
  chats: schema.chats,
  messages: schema.messages,
  usageLog: schema.usageLog,
  mcpServers: schema.mcpServers,
  images: schema.images,
  uploads: schema.uploads,
  appSettings: schema.appSettings,
} as const;

const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), schemaVersion: 1 };
for (const [name, table] of Object.entries(tables)) {
  out[name] = db.select().from(table as never).all();
}

const file = path.join(config.dataDir, `export-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`导出完成: ${file}`);
console.log('注意: providers.apiKeyEnc 等密钥字段使用 .env 中的 SECRET_KEY 加密,迁移时请一并保留 .env。');
