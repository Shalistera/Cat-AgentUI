// One-click MCP presets — the admin installs a known npm-published MCP server
// into DATA_DIR/mcp-packages and gets a ready-to-use mcp_servers row without
// touching commands/args/env by hand. Packages are installed once (no npx at
// every spawn, no network dependence at connect time) and launched with the
// same node binary that runs Cat-AgentUI.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema, now, getSetting, setSetting } from '../db/index.js';
import { newId } from '../crypto.js';
import { encryptSecretRecord } from '../secrets.js';
import { invalidateServer, testServer } from './manager.js';

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  pkg: string;
  /** Extra CLI args appended after the package entry file. */
  args: string[];
  /** Env var the API key is stored under (encrypted). */
  apiKeyEnv: string;
  /** Where the admin obtains an API key. */
  keyUrl: string;
  /** Presets that provide web search are auto-designated as the 联网搜索 source. */
  search: boolean;
}

export const PRESETS: readonly McpPreset[] = [
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Brave 官方 MCP 服务器:网页、新闻、图片、视频搜索与 AI 摘要。免费档每月 2000 次查询。',
    pkg: '@brave/brave-search-mcp-server',
    args: ['--transport', 'stdio'],
    apiKeyEnv: 'BRAVE_API_KEY',
    keyUrl: 'https://brave.com/search/api/',
    search: true,
  },
];

const PRESET_SERVERS_KEY = 'mcpPresetServerIds'; // Record<presetId, serverId>
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export const packagesDir = path.join(config.dataDir, 'mcp-packages');

function presetById(id: string): McpPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

function presetServerIds(): Record<string, string> {
  return getSetting<Record<string, string>>(PRESET_SERVERS_KEY, {});
}

function pkgDir(preset: McpPreset): string {
  return path.join(packagesDir, 'node_modules', ...preset.pkg.split('/'));
}

/** Installed version + absolute entry file, or null when not (fully) installed. */
function installedInfo(preset: McpPreset): { version: string; entry: string } | null {
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir(preset), 'package.json'), 'utf8'));
    const bin = pkgJson.bin;
    const rel: string | undefined = typeof bin === 'string' ? bin
      : bin && typeof bin === 'object' ? Object.values(bin as Record<string, string>)[0]
      : pkgJson.main;
    if (!rel) return null;
    const entry = path.join(pkgDir(preset), rel);
    if (!fs.existsSync(entry)) return null;
    return { version: String(pkgJson.version ?? '?'), entry };
  } catch {
    return null;
  }
}

export interface PresetStatus {
  id: string;
  name: string;
  description: string;
  pkg: string;
  apiKeyEnv: string;
  keyUrl: string;
  search: boolean;
  installedVersion: string | null;
  /** The mcp_servers row created by this preset, if it still exists. */
  serverId: string | null;
}

export function presetStatuses(): PresetStatus[] {
  const ids = presetServerIds();
  return PRESETS.map((p) => {
    const serverId = ids[p.id];
    const exists = serverId
      ? !!db.select({ id: schema.mcpServers.id }).from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get()
      : false;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      pkg: p.pkg,
      apiKeyEnv: p.apiKeyEnv,
      keyUrl: p.keyUrl,
      search: p.search,
      installedVersion: installedInfo(p)?.version ?? null,
      serverId: exists ? serverId : null,
    };
  });
}

/** Locate npm's CLI next to the running node so a service unit with a bare
 * PATH (or a node outside /usr/bin) still installs with the matching npm. */
function npmInvocation(): { file: string; argv: string[] } {
  const nodeDir = path.dirname(process.execPath);
  const cli = path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { file: process.execPath, argv: [cli] };
  const sibling = path.join(nodeDir, 'npm');
  if (fs.existsSync(sibling)) return { file: sibling, argv: [] };
  return { file: 'npm', argv: [] };
}

function runNpm(args: string[]): Promise<void> {
  const { file, argv } = npmInvocation();
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  return new Promise((resolve, reject) => {
    execFile(file, [...argv, ...args], {
      cwd: packagesDir, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const detail = String(stderr || err.message).split('\n').filter(Boolean).slice(-6).join('\n');
      reject(new Error(`npm 安装失败:${detail}`));
    });
  });
}

let installing: Promise<unknown> | null = null;

async function installPackage(preset: McpPreset): Promise<{ version: string; entry: string }> {
  if (installing) throw new Error('已有安装任务在进行中,请稍候');
  const run = (async () => {
    fs.mkdirSync(packagesDir, { recursive: true, mode: 0o700 });
    const manifest = path.join(packagesDir, 'package.json');
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(manifest, JSON.stringify({ name: 'cat-agentui-mcp-packages', private: true }, null, 2));
    }
    await runNpm(['install', '--no-audit', '--no-fund', '--omit=dev', '--save', `${preset.pkg}@latest`]);
    const info = installedInfo(preset);
    if (!info) throw new Error('安装完成但未找到可执行入口');
    return info;
  })();
  installing = run;
  try { return await run; } finally { installing = null; }
}

export interface InstallOptions {
  apiKey?: string;
  /** Re-run npm install even when the package is already present (upgrade). */
  reinstall?: boolean;
  setAsSearch?: boolean;
}

/**
 * Install (if needed), create or refresh the server row, optionally designate
 * it as the search source, then run a connection test. The test outcome is
 * returned rather than thrown so the UI can show a usable row with an error.
 */
export async function installPreset(presetId: string, opts: InstallOptions): Promise<{
  serverId: string;
  version: string;
  test: Awaited<ReturnType<typeof testServer>>;
}> {
  const preset = presetById(presetId);
  if (!preset) throw new Error('未知的预设');

  const existingInfo = installedInfo(preset);
  const info = existingInfo && !opts.reinstall ? existingInfo : await installPackage(preset);

  const ids = presetServerIds();
  let serverId = ids[preset.id];
  const row = serverId
    ? db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, serverId)).get()
    : undefined;

  const launch = { command: process.execPath, args: JSON.stringify([info.entry, ...preset.args]) };
  if (row) {
    const patch: Record<string, unknown> = { ...launch, transport: 'stdio', url: null };
    if (opts.apiKey) patch.envEnc = encryptSecretRecord({ [preset.apiKeyEnv]: opts.apiKey });
    db.update(schema.mcpServers).set(patch).where(eq(schema.mcpServers.id, row.id)).run();
    serverId = row.id;
    await invalidateServer(serverId);
  } else {
    if (!opts.apiKey) throw new Error(`请填写 ${preset.name} 的 API Key`);
    serverId = newId();
    db.insert(schema.mcpServers).values({
      id: serverId,
      name: preset.name,
      transport: 'stdio',
      ...launch,
      envEnc: encryptSecretRecord({ [preset.apiKeyEnv]: opts.apiKey }),
      url: null,
      headersEnc: encryptSecretRecord({}),
      enabled: 1,
      accessMode: 'shared',
      createdAt: now(),
    }).run();
    setSetting(PRESET_SERVERS_KEY, { ...ids, [preset.id]: serverId });
  }

  if (opts.setAsSearch ?? preset.search) setSetting('searchMcpServerId', serverId);

  const test = await testServer(serverId);
  return { serverId, version: info.version, test };
}
