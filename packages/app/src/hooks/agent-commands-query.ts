import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { QueryClient } from "@tanstack/react-query";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export const AGENT_COMMANDS_QUERY_ROOT = "agentCommands";

export interface AgentCommandsDraftConfig {
  provider: AgentProvider;
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export function normalizeAgentCommandsCwd(cwd: string): string {
  return normalizeWorkspacePath(cwd) ?? "";
}

export function agentCommandsQueryRoot(serverId: string) {
  return [AGENT_COMMANDS_QUERY_ROOT, serverId] as const;
}

export function sessionAgentCommandsQueryKey(input: { serverId: string; agentId: string }) {
  return [...agentCommandsQueryRoot(input.serverId), "session", input.agentId] as const;
}

export function draftAgentCommandsQueryKey(input: {
  serverId: string;
  draftConfig: AgentCommandsDraftConfig;
}) {
  const { draftConfig } = input;
  return [
    ...agentCommandsQueryRoot(input.serverId),
    "draft",
    draftConfig.provider,
    "cwd",
    normalizeAgentCommandsCwd(draftConfig.cwd),
    "mode",
    draftConfig.modeId ?? null,
    "model",
    draftConfig.model ?? null,
    "thinking",
    draftConfig.thinkingOptionId ?? null,
    "features",
    draftConfig.featureValues ?? null,
  ] as const;
}

export function isDraftAgentCommandsQueryForCwd(input: {
  queryKey: readonly unknown[];
  serverId: string;
  cwd: string;
}): boolean {
  return (
    input.queryKey[0] === AGENT_COMMANDS_QUERY_ROOT &&
    input.queryKey[1] === input.serverId &&
    input.queryKey[2] === "draft" &&
    input.queryKey[5] === normalizeAgentCommandsCwd(input.cwd)
  );
}

// Draft command queries are only enabled while the command menu is open, so timing decides who
// pays for rediscovery. "now" refetches an open menu on the spot. "next-open" marks the cache
// stale and stops there, so a burst of updates cannot restart provider discovery while the user
// is typing; the menu picks up the new commands the next time it opens.
export type DraftAgentCommandsRefreshTiming = "now" | "next-open";

export async function invalidateDraftAgentCommandsForCwd(input: {
  queryClient: QueryClient;
  serverId: string;
  cwd: string;
  timing: DraftAgentCommandsRefreshTiming;
}): Promise<void> {
  await input.queryClient.invalidateQueries({
    refetchType: input.timing === "next-open" ? "none" : undefined,
    predicate: (query) =>
      isDraftAgentCommandsQueryForCwd({
        queryKey: query.queryKey,
        serverId: input.serverId,
        cwd: input.cwd,
      }),
  });
}

export function agentCommandsQueryKey(input: {
  serverId: string;
  agentId: string;
  draftConfig?: AgentCommandsDraftConfig;
}) {
  if (input.draftConfig) {
    return draftAgentCommandsQueryKey({
      serverId: input.serverId,
      draftConfig: input.draftConfig,
    });
  }
  return sessionAgentCommandsQueryKey({ serverId: input.serverId, agentId: input.agentId });
}
