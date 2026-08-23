import { describe, expect, it } from "vitest";
import { normalizeClaudeSdkPlanUsage } from "./plan-usage.js";

describe("normalizeClaudeSdkPlanUsage", () => {
  it("treats sessions without plan rate limits as authoritative not-applicable data", () => {
    expect(
      normalizeClaudeSdkPlanUsage({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      }),
    ).toEqual({ kind: "not_applicable" });
  });

  it("normalizes session, weekly, model, and extra usage data", () => {
    expect(
      normalizeClaudeSdkPlanUsage({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-08-22T12:00:00.000Z" },
          seven_day: { utilization: 11, resets_at: "2026-08-29T00:00:00.000Z" },
          model_scoped: [
            {
              display_name: "Fable",
              utilization: 7,
              resets_at: "2026-08-29T00:00:00.000Z",
            },
          ],
          extra_usage: {
            is_enabled: true,
            monthly_limit: 100,
            used_credits: 25,
            utilization: 25,
            currency: "USD",
          },
        },
      }),
    ).toEqual({
      kind: "available",
      planLabel: "Max",
      sourceLabel: "Claude Code",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct: 42,
          remainingPct: 58,
          resetsAt: "2026-08-22T12:00:00.000Z",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 11,
          remainingPct: 89,
          resetsAt: "2026-08-29T00:00:00.000Z",
        },
        {
          id: "weekly_model_fable",
          label: "Weekly · Fable",
          usedPct: 7,
          remainingPct: 93,
          resetsAt: "2026-08-29T00:00:00.000Z",
        },
      ],
      balances: [
        {
          id: "extra_usage",
          label: "Extra usage",
          used: 25,
          remaining: 75,
          limit: 100,
          unit: "usd",
          resetsAt: null,
        },
      ],
      details: [
        {
          id: "extra_usage_status",
          label: "Extra usage",
          value: "Enabled",
        },
      ],
    });
  });
});
