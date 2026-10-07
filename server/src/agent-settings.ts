// Agent 能力 master switches: 工作区, 图表对比, 图片生成, 技能, 子代理, 联网搜索. (沙盒 keeps its own richer
// settings in sandbox/settings.ts.) One JSON blob in app_settings so the admin
// page saves it atomically; every chat turn reads it fresh.
import { getSetting, setSetting } from './db/index.js';

export const AGENT_SETTINGS_KEY = 'agent';

export interface AccessPolicy {
  enabled: boolean;
  accessMode: 'shared' | 'restricted';
  /** Only for 'restricted'; admins are always allowed. */
  allowedUserIds: string[];
}

export interface AgentSettings {
  dataComparison: AccessPolicy;
  workspace: AccessPolicy;
  skills: AccessPolicy;
  imageGeneration: AccessPolicy & {
    /** Explicit tool grant; independent of direct model/workshop visibility. */
    modelIds: string[];
    maxPerTurn: number;
    /** Per ordinary user across all tool models, per server-local day; 0 = unlimited. */
    dailyLimit: number;
  };
  subagent: AccessPolicy & {
    /** models.id to run subagents on; '' = the parent chat's model. */
    modelId: string;
    /** How many spawn_subagent calls one assistant turn may make. */
    maxPerTurn: number;
    /** Tool rounds inside one subagent. */
    maxIterations: number;
    timeoutSec: number;
    /** Characters of the subagent's final answer handed back to the parent. */
    maxResultChars: number;
    /** May a subagent use run_command (when the sandbox itself is on)? */
    allowSandbox: boolean;
  };
  webSearch: AccessPolicy & {
    /** Gemini provider the searches run on; '' = first enabled one, Vertex preferred. */
    providerId: string;
    /** Model id on that provider, e.g. 'gemini-3.5-flash-lite'. */
    model: string;
    /** Gemini provider for the fallback model; '' = the search provider. */
    fallbackProviderId: string;
    /** Tried when the search model fails or times out; '' = none. */
    fallbackModel: string;
    /** Last resort: the search MCP designated on the MCP page (Brave). */
    mcpFallback: boolean;
    /** Google-grounded queries per calendar month; past it only the MCP is tried. 0 = unlimited. */
    monthlyLimit: number;
    /** web_search calls per ordinary user per server-local day; 0 = unlimited. */
    dailyLimit: number;
    /** The same for admins; 0 = unlimited. */
    adminDailyLimit: number;
    /** web_fetch: open pages and read their text. */
    fetchEnabled: boolean;
    /** Model that reads long pages first; '' = the search model. */
    fetchModel: string;
    /** web_fetch calls per ordinary user / admin per day; 0 = unlimited. */
    fetchDailyLimit: number;
    fetchAdminDailyLimit: number;
  };
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  dataComparison: { enabled: true, accessMode: 'shared', allowedUserIds: [] },
  workspace: { enabled: true, accessMode: 'shared', allowedUserIds: [] },
  skills: { enabled: true, accessMode: 'shared', allowedUserIds: [] },
  imageGeneration: { enabled: false, accessMode: 'shared', allowedUserIds: [], modelIds: [], maxPerTurn: 2, dailyLimit: 20 },
  subagent: {
    enabled: false, accessMode: 'shared', allowedUserIds: [],
    modelId: '', maxPerTurn: 4, maxIterations: 12, timeoutSec: 300, maxResultChars: 12_000, allowSandbox: true,
  },
  // 5000 = Google's monthly free allowance for grounded search on Gemini 3.x.
  webSearch: {
    enabled: true, accessMode: 'shared', allowedUserIds: [],
    providerId: '', model: 'gemini-3.5-flash-lite',
    fallbackProviderId: '', fallbackModel: 'gemini-3.1-flash-lite', mcpFallback: true,
    monthlyLimit: 5000, dailyLimit: 100, adminDailyLimit: 0,
    fetchEnabled: true, fetchModel: '', fetchDailyLimit: 200, fetchAdminDailyLimit: 0,
  },
};

function clamp(n: unknown, def: number, min: number, max: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function policy(raw: Partial<AccessPolicy> | undefined, def: AccessPolicy): AccessPolicy {
  return {
    enabled: raw?.enabled === undefined ? def.enabled : !!raw.enabled,
    accessMode: raw?.accessMode === 'restricted' ? 'restricted' : 'shared',
    allowedUserIds: Array.isArray(raw?.allowedUserIds)
      ? raw.allowedUserIds.filter((x): x is string => typeof x === 'string').slice(0, 500)
      : def.allowedUserIds,
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function normalizeAgentSettings(raw: DeepPartial<AgentSettings> | null | undefined): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS;
  const sub = raw?.subagent ?? {};
  const images = raw?.imageGeneration ?? {};
  const search = raw?.webSearch ?? {};
  return {
    dataComparison: policy(raw?.dataComparison as Partial<AccessPolicy>, d.dataComparison),
    workspace: policy(raw?.workspace as Partial<AccessPolicy>, d.workspace),
    skills: policy(raw?.skills as Partial<AccessPolicy>, d.skills),
    imageGeneration: {
      ...policy(images as Partial<AccessPolicy>, d.imageGeneration),
      modelIds: Array.isArray(images.modelIds)
        ? [...new Set(images.modelIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))].slice(0, 50)
        : [],
      maxPerTurn: clamp(images.maxPerTurn, d.imageGeneration.maxPerTurn, 1, 10),
      dailyLimit: clamp(images.dailyLimit, d.imageGeneration.dailyLimit, 0, 10000),
    },
    subagent: {
      ...policy(sub as Partial<AccessPolicy>, d.subagent),
      modelId: typeof sub.modelId === 'string' ? sub.modelId.slice(0, 64) : d.subagent.modelId,
      maxPerTurn: clamp(sub.maxPerTurn, d.subagent.maxPerTurn, 1, 20),
      maxIterations: clamp(sub.maxIterations, d.subagent.maxIterations, 1, 50),
      timeoutSec: clamp(sub.timeoutSec, d.subagent.timeoutSec, 30, 1800),
      maxResultChars: clamp(sub.maxResultChars, d.subagent.maxResultChars, 1000, 100_000),
      allowSandbox: sub.allowSandbox === undefined ? d.subagent.allowSandbox : !!sub.allowSandbox,
    },
    webSearch: {
      ...policy(search as Partial<AccessPolicy>, d.webSearch),
      providerId: typeof search.providerId === 'string' ? search.providerId.slice(0, 64) : d.webSearch.providerId,
      model: typeof search.model === 'string' && search.model.trim() ? search.model.trim().slice(0, 128) : d.webSearch.model,
      fallbackProviderId: typeof search.fallbackProviderId === 'string' ? search.fallbackProviderId.slice(0, 64) : d.webSearch.fallbackProviderId,
      fallbackModel: typeof search.fallbackModel === 'string' ? search.fallbackModel.trim().slice(0, 128) : d.webSearch.fallbackModel,
      mcpFallback: search.mcpFallback === undefined ? d.webSearch.mcpFallback : !!search.mcpFallback,
      monthlyLimit: clamp(search.monthlyLimit, d.webSearch.monthlyLimit, 0, 10_000_000),
      dailyLimit: clamp(search.dailyLimit, d.webSearch.dailyLimit, 0, 100_000),
      adminDailyLimit: clamp(search.adminDailyLimit, d.webSearch.adminDailyLimit, 0, 100_000),
      fetchEnabled: search.fetchEnabled === undefined ? d.webSearch.fetchEnabled : !!search.fetchEnabled,
      fetchModel: typeof search.fetchModel === 'string' ? search.fetchModel.trim().slice(0, 128) : d.webSearch.fetchModel,
      fetchDailyLimit: clamp(search.fetchDailyLimit, d.webSearch.fetchDailyLimit, 0, 100_000),
      fetchAdminDailyLimit: clamp(search.fetchAdminDailyLimit, d.webSearch.fetchAdminDailyLimit, 0, 100_000),
    },
  };
}

export function getAgentSettings(): AgentSettings {
  return normalizeAgentSettings(getSetting<DeepPartial<AgentSettings> | null>(AGENT_SETTINGS_KEY, null));
}

export function saveAgentSettings(patch: DeepPartial<AgentSettings>): AgentSettings {
  const cur = getAgentSettings();
  const next = normalizeAgentSettings({
    dataComparison: { ...cur.dataComparison, ...(patch.dataComparison ?? {}) },
    workspace: { ...cur.workspace, ...(patch.workspace ?? {}) },
    skills: { ...cur.skills, ...(patch.skills ?? {}) },
    imageGeneration: { ...cur.imageGeneration, ...(patch.imageGeneration ?? {}) },
    subagent: { ...cur.subagent, ...(patch.subagent ?? {}) },
    webSearch: { ...cur.webSearch, ...(patch.webSearch ?? {}) },
  } as DeepPartial<AgentSettings>);
  setSetting(AGENT_SETTINGS_KEY, next);
  return next;
}

export interface AgentUser { id: string; role: string }

/** Personal master switch (users.settings.agentTools): undefined = on. The
    admin policy decides what is *allowed*; this is the person opting out. */
export function userWantsAgentTools(settingsJson: string | undefined): boolean {
  if (!settingsJson) return true;
  try { return (JSON.parse(settingsJson) as { agentTools?: unknown }).agentTools !== false; }
  catch { return true; }
}

export function policyAllows(p: AccessPolicy, user: AgentUser): boolean {
  if (!p.enabled) return false;
  if (user.role === 'admin') return true;
  if (p.accessMode === 'shared') return true;
  return p.allowedUserIds.includes(user.id);
}
