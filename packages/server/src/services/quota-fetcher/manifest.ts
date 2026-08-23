import type {
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
  ProviderUsageFetcherManifestEntry,
} from "./provider.js";
import type { AgentSession } from "../../server/agent/agent-sdk-types.js";
import type { ProviderUsageTarget } from "../../server/agent/provider-registry.js";
import { ClaudeUsageState } from "./providers/claude-state.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { ZaiQuotaProvider } from "./providers/zai.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "codex",
    create: (options) =>
      new CodexQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
      }),
  },
  {
    providerId: "copilot",
    create: (options) => new CopilotQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "zai",
    create: (options) => new ZaiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "grok",
    create: (options) => new GrokQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "kimi",
    create: (options) => new KimiQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
  {
    providerId: "minimax",
    create: (options) => new MiniMaxQuotaProvider({ logger: options.logger, fetch: options.fetch }),
  },
];

export interface CreateProviderUsageFetchersOptions extends ProviderUsageFetcherFactoryOptions {
  targets?: ProviderUsageTarget[];
  targetProviderId?: string;
  getLiveSessions?: (providerId: string) => AgentSession[];
  claudeState?: ClaudeUsageState;
  now?: () => number;
}

const DEFAULT_CLAUDE_TARGET: ProviderUsageTarget = {
  providerId: "claude",
  displayName: "Claude",
  baseProviderId: "claude",
  iconProviderId: "claude",
};

export function createProviderUsageFetchers(
  options: CreateProviderUsageFetchersOptions,
): ProviderUsageFetcher[] {
  const staticFetchers = PROVIDER_USAGE_FETCHERS.filter(
    (entry) => !options.targetProviderId || entry.providerId === options.targetProviderId,
  ).map((entry) => entry.create(options));
  const targets = (options.targets ?? [DEFAULT_CLAUDE_TARGET]).filter(
    (target) =>
      target.baseProviderId === "claude" &&
      (!options.targetProviderId || target.providerId === options.targetProviderId),
  );
  const claudeState = options.claudeState ?? new ClaudeUsageState();
  const claudeFetchers = targets.map(
    (target) =>
      new ClaudeQuotaProvider({
        logger: options.logger,
        fetch: options.fetch,
        target,
        liveSessions: options.getLiveSessions?.(target.providerId) ?? [],
        state: claudeState,
        now: options.now,
      }),
  );
  return [...claudeFetchers, ...staticFetchers];
}
