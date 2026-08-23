import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentPlanUsage,
  AgentPlanUsageBalance,
  AgentPlanUsageWindow,
} from "../../agent-sdk-types.js";

type ClaudeRateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

export interface ClaudeSdkPlanUsageInput {
  subscription_type: SDKControlGetUsageResponse["subscription_type"];
  rate_limits_available: SDKControlGetUsageResponse["rate_limits_available"];
  rate_limits: SDKControlGetUsageResponse["rate_limits"];
}

const CLAUDE_USAGE_WINDOWS: ReadonlyArray<{
  field: "five_hour" | "seven_day" | "seven_day_oauth_apps" | "seven_day_opus" | "seven_day_sonnet";
  id: string;
  label: string;
}> = [
  { field: "five_hour", id: "five_hour", label: "Session" },
  { field: "seven_day", id: "weekly", label: "Weekly" },
  { field: "seven_day_oauth_apps", id: "weekly_oauth_apps", label: "Weekly · OAuth apps" },
  { field: "seven_day_opus", id: "weekly_opus", label: "Weekly · Opus" },
  { field: "seven_day_sonnet", id: "weekly_sonnet", label: "Weekly · Sonnet" },
];

function planLabel(subscriptionType: string | null): string | null {
  if (!subscriptionType) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

function normalizedId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function remainingPct(usedPct: number | null): number | null {
  return usedPct === null ? null : Math.max(0, 100 - usedPct);
}

function modelScopedWindows(rateLimits: ClaudeRateLimits): AgentPlanUsageWindow[] {
  const taken = new Set<string>();
  return (rateLimits.model_scoped ?? []).map((limit) => {
    const baseId = `weekly_model_${normalizedId(limit.display_name)}`;
    let id = baseId;
    for (let suffix = 2; taken.has(id); suffix += 1) {
      id = `${baseId}_${suffix}`;
    }
    taken.add(id);
    return {
      id,
      label: `Weekly · ${limit.display_name}`,
      usedPct: limit.utilization,
      remainingPct: remainingPct(limit.utilization),
      resetsAt: limit.resets_at,
    };
  });
}

function extraUsageBalance(rateLimits: ClaudeRateLimits): AgentPlanUsageBalance[] {
  const extra = rateLimits.extra_usage;
  if (!extra?.is_enabled) return [];
  const unit = extra.currency?.toLowerCase() === "usd" ? "usd" : "credits";
  const remaining =
    extra.monthly_limit === null || extra.used_credits === null
      ? null
      : Math.max(0, extra.monthly_limit - extra.used_credits);
  return [
    {
      id: "extra_usage",
      label: "Extra usage",
      used: extra.used_credits,
      remaining,
      limit: extra.monthly_limit,
      unit,
      resetsAt: null,
    },
  ];
}

export function normalizeClaudeSdkPlanUsage(usage: ClaudeSdkPlanUsageInput): AgentPlanUsage {
  if (usage.rate_limits_available === false) {
    return { kind: "not_applicable" };
  }
  if (!usage.rate_limits) {
    return { kind: "unavailable" };
  }

  const windows: AgentPlanUsageWindow[] = [];
  for (const spec of CLAUDE_USAGE_WINDOWS) {
    const window = usage.rate_limits[spec.field];
    if (!window) continue;
    windows.push({
      id: spec.id,
      label: spec.label,
      usedPct: window.utilization,
      remainingPct: remainingPct(window.utilization),
      resetsAt: window.resets_at,
    });
  }
  windows.push(...modelScopedWindows(usage.rate_limits));

  const extraUsage = usage.rate_limits.extra_usage;
  const details =
    extraUsage === undefined || extraUsage === null
      ? []
      : [
          {
            id: "extra_usage_status",
            label: "Extra usage",
            value: extraUsage.is_enabled ? "Enabled" : "Disabled",
          },
        ];

  return {
    kind: "available",
    planLabel: planLabel(usage.subscription_type),
    sourceLabel: "Claude Code",
    windows,
    balances: extraUsageBalance(usage.rate_limits),
    details,
  };
}
