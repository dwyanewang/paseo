import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import type { AgentSession } from "../../server/agent/agent-sdk-types.js";
import type { ProviderUsageTarget } from "../../server/agent/provider-registry.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { ClaudeUsageState } from "./providers/claude-state.js";
import { unavailableUsage } from "./usage.js";

interface ProviderUsageAgentScope {
  providerId: string;
  session: AgentSession;
}

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  getTargets?: () => ProviderUsageTarget[];
  getAgentScope?: (agentId: string) => ProviderUsageAgentScope | null;
  getLiveSessions?: (providerId: string) => AgentSession[];
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly configuredFetchers: ProviderUsageFetcher[] | null;
  private readonly fetchApi: ProviderApiFetch | undefined;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly getTargets: () => ProviderUsageTarget[];
  private readonly getAgentScope: (agentId: string) => ProviderUsageAgentScope | null;
  private readonly getLiveSessions: (providerId: string) => AgentSession[];
  private readonly claudeState = new ClaudeUsageState();
  private readonly cached = new Map<
    string,
    { expiresAtMs: number; result: ProviderUsageListResult }
  >();
  private readonly inFlight = new Map<string, Promise<ProviderUsageListResult>>();

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.configuredFetchers = options.fetchers ?? null;
    this.fetchApi = options.fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.getTargets = options.getTargets ?? (() => []);
    this.getAgentScope = options.getAgentScope ?? (() => null);
    this.getLiveSessions = options.getLiveSessions ?? (() => []);
  }

  async listUsage(options?: {
    forceRefresh?: boolean;
    agentId?: string;
  }): Promise<ProviderUsageListResult> {
    const scopeKey = options?.agentId ? `agent:${options.agentId}` : "global";
    const nowMs = this.now();
    const cached = this.cached.get(scopeKey);
    if (!options?.forceRefresh && cached && nowMs < cached.expiresAtMs) {
      return cached.result;
    }

    const inFlight = this.inFlight.get(scopeKey);
    if (inFlight) {
      return inFlight;
    }

    const request = this.fetchFreshUsage(nowMs, options?.agentId);
    this.inFlight.set(scopeKey, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(scopeKey) === request) {
        this.inFlight.delete(scopeKey);
      }
    }
  }

  private async fetchFreshUsage(nowMs: number, agentId?: string): Promise<ProviderUsageListResult> {
    const fetchers = this.resolveFetchers(agentId);
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    const providerDeadlines = providers.flatMap((provider) => {
      const deadline = provider.nextRefreshAt ? Date.parse(provider.nextRefreshAt) : Number.NaN;
      return Number.isFinite(deadline) ? [deadline] : [];
    });
    const expiresAtMs = Math.min(nowMs + this.cacheTtlMs, ...providerDeadlines);
    const scopeKey = agentId ? `agent:${agentId}` : "global";
    this.cached.set(scopeKey, { expiresAtMs, result });
    return result;
  }

  private resolveFetchers(agentId?: string): ProviderUsageFetcher[] {
    if (this.configuredFetchers) return this.configuredFetchers;

    const agentScope = agentId ? this.getAgentScope(agentId) : null;
    if (agentId && !agentScope) return [];
    return createProviderUsageFetchers({
      logger: this.logger,
      fetch: this.fetchApi,
      targets: this.getTargets(),
      targetProviderId: agentScope?.providerId,
      getLiveSessions: (providerId) =>
        agentScope && providerId === agentScope.providerId
          ? [agentScope.session]
          : this.getLiveSessions(providerId),
      claudeState: this.claudeState,
      now: this.now,
    });
  }
}
