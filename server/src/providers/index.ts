import { and, asc, eq } from 'drizzle-orm';
import type { ChatAdapter, ProviderRuntimeConfig, ProviderType } from '../types.js';
import { config } from '../config.js';
import { decryptSecret } from '../crypto.js';
import { db, schema } from '../db/index.js';
import { interjectionSupported } from '../interjection.js';
import { decryptSecretRecord, providerExtraHeaders } from '../secrets.js';
import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';
import { claudeCodeAdapter } from './claude-code.js';
import { novelaiAdapter } from './novelai.js';
import { withFailover } from './failover.js';
import { priorityModel, vertexLines } from './vertex.js';

const rawAdapters: Record<ProviderType, ChatAdapter> = {
  novelai: novelaiAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  'claude-code': claudeCodeAdapter,
};

const adapters: Record<ProviderType, ChatAdapter> = {
  // Subscription-only generation must never be replayed onto another line.
  novelai: novelaiAdapter,
  openai: withFailover(openaiAdapter),
  anthropic: withFailover(anthropicAdapter),
  gemini: withFailover(geminiAdapter),
  // One local process, no lines to fail over to — and a retried stream
  // would restart a run that may be parked on tool calls.
  'claude-code': claudeCodeAdapter,
};

/** The adapter callers use: walks the provider's backup lines on failure. */
export function getAdapter(type: string): ChatAdapter {
  const a = adapters[type as ProviderType];
  if (!a) throw new Error(`未知的 Provider 类型: ${type}`);
  return a;
}

/** The bare vendor adapter, for testing one specific line. */
export function getRawAdapter(type: string): ChatAdapter {
  const a = rawAdapters[type as ProviderType];
  if (!a) throw new Error(`未知的 Provider 类型: ${type}`);
  return a;
}

export interface ProviderRow {
  id: string;
  type: string;
  baseUrl: string | null;
  apiKeyEnc: string | null;
  useResponses: number;
  useVertex: number;
  vertexProject: string | null;
  vertexLocation: string | null;
  vertexPriority?: string | null;
  vertexSaJsonEnc: string | null;
  extraHeaders: string;
  extraHeadersEnc: string | null;
  failoverThreshold?: number;
  failoverCooldownSeconds?: number;
  primaryName?: string | null;
  stripModelPrefix?: string;
  addModelPrefix?: string;
}

export type EndpointRow = typeof schema.providerEndpoints.$inferSelect;
export type VertexAccountRow = typeof schema.providerVertexAccounts.$inferSelect;

export function primaryLineKey(providerId: string): string {
  return `${providerId}:primary`;
}

/** A backup line's config: same vendor type as the provider, its own
 * gateway address, key and headers, always API-key auth (never Vertex). */
export function endpointRuntimeConfig(base: ProviderRuntimeConfig, e: EndpointRow): ProviderRuntimeConfig {
  return {
    id: base.id,
    type: base.type,
    baseUrl: e.baseUrl,
    apiKey: e.apiKeyEnc ? decryptSecret(e.apiKeyEnc) : null,
    useResponses: e.useResponses === null ? base.useResponses : !!e.useResponses,
    useVertex: false,
    vertexProject: null,
    vertexLocation: null,
    vertexSaJson: null,
    extraHeaders: decryptSecretRecord(e.extraHeadersEnc, '备用线路自定义 Headers'),
    endpointId: e.id,
    endpointName: e.name,
    stripModelPrefix: e.stripModelPrefix,
    addModelPrefix: e.addModelPrefix,
  };
}

function enabledEndpoints(providerId: string): EndpointRow[] {
  return db.select().from(schema.providerEndpoints)
    .where(and(eq(schema.providerEndpoints.providerId, providerId), eq(schema.providerEndpoints.enabled, 1)))
    .orderBy(asc(schema.providerEndpoints.priority), asc(schema.providerEndpoints.createdAt))
    .all();
}

/** 追加 is offered on this provider's text models: every line it may route
 * a reply to has to take it, backups included. */
export function providerTakesInterjections(row: { id: string; type: string; baseUrl: string | null }): boolean {
  const urls = row.type === 'anthropic' ? [row.baseUrl, ...enabledEndpoints(row.id).map((e) => e.baseUrl)] : [];
  return interjectionSupported(row.type, urls, config.interjectionAnthropicHosts);
}

function usesVertex(row: ProviderRow): boolean {
  return row.type === 'gemini' && !!row.useVertex;
}

/** A provider's backup Vertex accounts in the admin's order, disabled ones
 * included (they keep their place in the line names). */
export function vertexAccountsOf(providerId: string): VertexAccountRow[] {
  return db.select().from(schema.providerVertexAccounts)
    .where(eq(schema.providerVertexAccounts.providerId, providerId))
    .orderBy(asc(schema.providerVertexAccounts.priority), asc(schema.providerVertexAccounts.createdAt))
    .all();
}

/** The provider's own line only — what the admin "test" and model listing use.
 * For Vertex that is the first location in the admin's order. */
export function toPrimaryRuntimeConfig(row: ProviderRow, accounts?: VertexAccountRow[]): ProviderRuntimeConfig {
  const vertex = usesVertex(row) ? vertexLines(row, accounts ?? vertexAccountsOf(row.id))[0] : null;
  return {
    id: row.id,
    type: row.type as ProviderType,
    baseUrl: row.baseUrl,
    apiKey: row.apiKeyEnc ? decryptSecret(row.apiKeyEnc) : null,
    useResponses: !!row.useResponses,
    useVertex: !!row.useVertex,
    vertexProject: row.vertexProject,
    vertexLocation: vertex ? vertex.location : row.vertexLocation,
    vertexPriority: vertex?.priority,
    vertexSaJson: row.vertexSaJsonEnc ? decryptSecret(row.vertexSaJsonEnc) : null,
    extraHeaders: providerExtraHeaders(row),
    endpointName: vertex ? vertex.name : row.primaryName || '主线路',
    stripModelPrefix: row.stripModelPrefix ?? '',
    addModelPrefix: row.addModelPrefix ?? '',
  };
}

/** The backup accounts, the Vertex locations after the first and the
 * Priority fallback: same model ids, another capacity pool. */
function vertexFallbacks(row: ProviderRow, primary: ProviderRuntimeConfig, accounts: VertexAccountRow[]): ProviderRuntimeConfig[] {
  if (!usesVertex(row)) return [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return vertexLines(row, accounts).slice(1).flatMap((v): ProviderRuntimeConfig[] => {
    let account: Partial<ProviderRuntimeConfig> = {};
    if (v.account) {
      // Its own credentials and the project in its own JSON: the provider's
      // project ID setting belongs to the provider's service account.
      try {
        account = { vertexSaJson: decryptSecret(byId.get(v.account)!.saJsonEnc), vertexProject: null, backupAccount: true };
      } catch {
        return []; // unusable secret: leave the line out rather than fail every request
      }
    }
    return [{
      ...primary,
      ...account,
      vertexLocation: v.location,
      vertexPriority: v.priority,
      endpointId: v.key,
      endpointName: v.name,
      servesModel: v.onlyPriorityModels ? priorityModel : undefined,
      escalateAfterBusy: v.onlyPriorityModels ? config.vertexPriorityAfterBusy : undefined,
      escalateOnFailure: v.onlyPriorityModels && row.vertexPriority === 'first_failure' || undefined,
    }];
  });
}

/** The provider's line plus its enabled backups, ready for getAdapter(). With
 * a backup behind it, a line's busy-retry wait is capped so the user is not
 * left staring at a countdown while a working line sits idle; the last line
 * tried keeps the full budget since nothing comes after it (see failover.ts).
 * Hopping between Vertex lines (locations, backup accounts) is cheaper
 * still — same model, no gateway in between — so those lines give up sooner. */
export function toRuntimeConfig(row: ProviderRow): ProviderRuntimeConfig {
  const accounts = usesVertex(row) ? vertexAccountsOf(row.id) : [];
  const primary = toPrimaryRuntimeConfig(row, accounts);
  const backups = [
    ...vertexFallbacks(row, primary, accounts),
    ...enabledEndpoints(row.id).map((e) => endpointRuntimeConfig(primary, e)),
  ];
  if (!backups.length) return primary;
  const lines = [primary, ...backups];
  for (let i = 0; i < lines.length - 1; i++) {
    lines[i].retryBudgetMs = lines[i].useVertex && lines[i + 1].useVertex
      ? Math.min(config.vertexRegionRetryWaitMs, config.failoverRetryWaitMs)
      : config.failoverRetryWaitMs;
  }
  primary.fallbacks = backups;
  primary.failoverThreshold = row.failoverThreshold ?? 3;
  primary.failoverCooldownMs = (row.failoverCooldownSeconds ?? 60) * 1000;
  return primary;
}
