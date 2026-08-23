import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

export function providerUsageQueryKey(serverId: string | null | undefined, agentId?: string) {
  return ["providerUsage", serverId ?? "", agentId ?? "global"] as const;
}

async function fetchProviderUsage(
  client: ProviderUsageClient,
  agentId?: string,
): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage(agentId ? { agentId } : undefined);
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  agentId?: string;
}

function nextRefreshInterval(payload: ProviderUsageListPayload | undefined): number | false {
  if (!payload) return false;
  const deadlines = payload.providers.flatMap((provider) => {
    const timestamp = provider.nextRefreshAt ? Date.parse(provider.nextRefreshAt) : Number.NaN;
    return Number.isFinite(timestamp) ? [timestamp] : [];
  });
  if (deadlines.length === 0) return false;
  return Math.max(1_000, Math.min(...deadlines) - Date.now());
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  forceRefresh: (() => Promise<void>) | null;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const isAppVisible = useAppVisible();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const supportsForceRefresh = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageForceRefresh === true,
  );
  const supportsSessionScope = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageSessionScope === true,
  );
  const scopedAgentId = supportsSessionScope ? options.agentId : undefined;
  const queryKey = useMemo(
    () => providerUsageQueryKey(serverId, scopedAgentId),
    [scopedAgentId, serverId],
  );
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return fetchProviderUsage(client, scopedAgentId);
  }, [client, scopedAgentId]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: (activeQuery) =>
      isAppVisible ? nextRefreshInterval(activeQuery.state.data) : false,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, queryClient, queryFn, queryKey]);

  const forceRefresh = useCallback(async () => {
    if (!canFetch || !client) return;
    await queryClient.fetchQuery({
      queryKey,
      queryFn: () =>
        client.listProviderUsage({
          forceRefresh: true,
          ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
        }),
      staleTime: 0,
    });
  }, [canFetch, client, queryClient, queryKey, scopedAgentId]);

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
  ]);

  return {
    view,
    refresh,
    forceRefresh: supportsForceRefresh ? forceRefresh : null,
    canFetch,
  };
}
