import { describe, expect, it } from "vitest";

import type { ProviderHealthRecord } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import {
  formatTerminalRunText,
  mergeProviderPressureSummaries,
  summarizeProviderHealthRows,
  type TerminalRunSummary,
} from "./TerminalRunSummary.js";

describe("TerminalRunSummary", () => {
  it("summarizes provider health rows by provider and status", () => {
    const summary = summarizeProviderHealthRows([
      providerHealth("JUPITER", "RATE_LIMITED"),
      providerHealth("JUPITER", "RATE_LIMITED", { quoteSource: "SKIPPED_COOLDOWN" }),
      providerHealth("JUPITER", "OK"),
      providerHealth("DEXSCREENER", "OK"),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.statusCounts.OK).toBe(2);
    expect(summary.statusCounts.RATE_LIMITED).toBe(2);
    expect(summary.liveRows).toBe(3);
    expect(summary.routerRows).toBe(1);
    expect(summary.providers.find((provider) => provider.provider === "JUPITER")).toMatchObject({
      total: 3,
      rateLimitedCount: 2,
      liveRateLimitedCount: 1,
      routerCooldownSkips: 1,
    });
  });

  it("merges provider pressure across stages and formats it", () => {
    const merged = mergeProviderPressureSummaries([
      summarizeProviderHealthRows([providerHealth("JUPITER", "RATE_LIMITED")]),
      summarizeProviderHealthRows([providerHealth("JUPITER", "DEGRADED")]),
    ]);

    expect(merged.total).toBe(2);
    expect(merged.statusCounts.RATE_LIMITED).toBe(1);
    expect(merged.statusCounts.DEGRADED).toBe(1);
    expect(formatTerminalRunText(createRunSummary(merged))).toContain("Provider pressure total");
  });
});

function providerHealth(
  provider: string,
  status: ProviderHealthRecord["status"],
  context?: Readonly<Record<string, unknown>>,
): ProviderHealthRecord {
  return {
    id: `${provider}_${status}_${context?.quoteSource ?? "live"}`,
    sessionId: null,
    provider,
    timestampMs: 1_800_000_000_000,
    status,
    latencyMs: 10,
    rateLimited: status === "RATE_LIMITED",
    errorMessage: null,
    creditsUsed: null,
    contextJson: context ? stringifyJson(context) : null,
  };
}

function createRunSummary(
  providerPressure: TerminalRunSummary["providerPressure"],
): TerminalRunSummary {
  return {
    runId: "terminal_test",
    mode: "PAPER",
    shadowOnly: true,
    safetyStatus: "PASS",
    startedAtMs: 1_800_000_000_000,
    endedAtMs: 1_800_000_000_100,
    durationMs: 100,
    intervalMs: 60_000,
    cycleCount: 0,
    cycles: [],
    providerPressure,
    stopped: false,
  };
}
