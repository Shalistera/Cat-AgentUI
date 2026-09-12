// Agent 能力 master switches: 工作区, 技能, 子代理. (沙盒 keeps its own richer
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
  workspace: AccessPolicy;
  skills: AccessPolicy;
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
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  workspace: { enabled: true, accessMode: 'shared', allowedUserIds: [] },
  skills: { enabled: true, accessMode: 'shared', allowedUserIds: [] },
  subagent: {
    enabled: false, accessMode: 'shared', allowedUserIds: [],
    modelId: '', maxPerTurn: 4, maxIterations: 12, timeoutSec: 300, maxResultChars: 12_000, allowSandbox: true,
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
  return {
    workspace: policy(raw?.workspace as Partial<AccessPolicy>, d.workspace),
    skills: policy(raw?.skills as Partial<AccessPolicy>, d.skills),
    subagent: {
      ...policy(sub as Partial<AccessPolicy>, d.subagent),
      modelId: typeof sub.modelId === 'string' ? sub.modelId.slice(0, 64) : d.subagent.modelId,
      maxPerTurn: clamp(sub.maxPerTurn, d.subagent.maxPerTurn, 1, 20),
      maxIterations: clamp(sub.maxIterations, d.subagent.maxIterations, 1, 50),
      timeoutSec: clamp(sub.timeoutSec, d.subagent.timeoutSec, 30, 1800),
      maxResultChars: clamp(sub.maxResultChars, d.subagent.maxResultChars, 1000, 100_000),
      allowSandbox: sub.allowSandbox === undefined ? d.subagent.allowSandbox : !!sub.allowSandbox,
    },
  };
}

export function getAgentSettings(): AgentSettings {
  return normalizeAgentSettings(getSetting<DeepPartial<AgentSettings> | null>(AGENT_SETTINGS_KEY, null));
}

export function saveAgentSettings(patch: DeepPartial<AgentSettings>): AgentSettings {
  const cur = getAgentSettings();
  const next = normalizeAgentSettings({
    workspace: { ...cur.workspace, ...(patch.workspace ?? {}) },
    skills: { ...cur.skills, ...(patch.skills ?? {}) },
    subagent: { ...cur.subagent, ...(patch.subagent ?? {}) },
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
