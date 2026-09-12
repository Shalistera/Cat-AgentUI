// 沙盒 settings + access policy. Stored as one JSON blob in app_settings so
// the admin page can save it atomically; the executor reads it per call.
import { getSetting, setSetting } from '../db/index.js';
import { config } from '../config.js';

export const SANDBOX_SETTINGS_KEY = 'sandbox';

export interface SandboxSettings {
  /** Master switch. Off = run_command is never offered to any model. */
  enabled: boolean;
  /** Pause for the person's allow/deny before every command (see tool-confirm). */
  confirm: boolean;
  accessMode: 'shared' | 'restricted';
  /** Only for accessMode 'restricted'; admins are always allowed. */
  allowedUserIds: string[];
  timeoutSec: number;
  memoryMb: number;
  /** systemd CPUQuota percentage: 100 = one core. */
  cpuPercent: number;
  maxPids: number;
  /** Per stream (stdout / stderr) cap handed back to the model. */
  maxOutputChars: number;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: false,
  confirm: true,
  accessMode: 'shared',
  allowedUserIds: [],
  timeoutSec: 60,
  memoryMb: 512,
  cpuPercent: 100,
  maxPids: 64,
  maxOutputChars: 30_000,
};

function clamp(n: unknown, def: number, min: number, max: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

export function normalizeSandboxSettings(raw: Partial<SandboxSettings> | null | undefined): SandboxSettings {
  const d = DEFAULT_SANDBOX_SETTINGS;
  const r = raw ?? {};
  return {
    enabled: !!r.enabled,
    confirm: r.confirm === undefined ? d.confirm : !!r.confirm,
    accessMode: r.accessMode === 'restricted' ? 'restricted' : 'shared',
    allowedUserIds: Array.isArray(r.allowedUserIds) ? r.allowedUserIds.filter((x): x is string => typeof x === 'string').slice(0, 500) : [],
    timeoutSec: clamp(r.timeoutSec, d.timeoutSec, 5, config.maxSandboxTimeoutSec),
    memoryMb: clamp(r.memoryMb, d.memoryMb, 64, 16_384),
    cpuPercent: clamp(r.cpuPercent, d.cpuPercent, 10, 800),
    maxPids: clamp(r.maxPids, d.maxPids, 8, 4_096),
    maxOutputChars: clamp(r.maxOutputChars, d.maxOutputChars, 2_000, 200_000),
  };
}

export function getSandboxSettings(): SandboxSettings {
  return normalizeSandboxSettings(getSetting<Partial<SandboxSettings> | null>(SANDBOX_SETTINGS_KEY, null));
}

export function saveSandboxSettings(patch: Partial<SandboxSettings>): SandboxSettings {
  const next = normalizeSandboxSettings({ ...getSandboxSettings(), ...patch });
  setSetting(SANDBOX_SETTINGS_KEY, next);
  return next;
}

export interface SandboxUser { id: string; role: string }

/** Policy only — whether the host can actually run anything is env.ts's call. */
export function userMayUseSandbox(user: SandboxUser, s: SandboxSettings = getSandboxSettings()): boolean {
  if (!s.enabled) return false;
  if (user.role === 'admin') return true;
  if (s.accessMode === 'shared') return true;
  return s.allowedUserIds.includes(user.id);
}
