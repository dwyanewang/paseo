import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openPluginAgentLaunch } from "./agent-launch";

export function usePluginHostNavigation(
  serverId: string,
  pluginId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () => ({
      openAgent: ({ agentId }) => navigateToAgent({ serverId, agentId }),
      openWorkspace: ({ workspaceId }) => navigateToWorkspace({ serverId, workspaceId }),
      openAgentLaunch: (request) => openPluginAgentLaunch({ serverId, pluginId, request }),
    }),
    [pluginId, serverId],
  );
}
