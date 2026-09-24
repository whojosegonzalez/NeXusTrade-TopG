import { describe, expect, it } from "vitest";

import { defaultTerminalRunnerConfig } from "./TerminalRunnerConfig.js";
import {
  createEmptyProviderPressureSummary,
  summarizeProviderHealthRows,
  type TerminalStageName,
  type TerminalStageResult,
} from "./TerminalRunSummary.js";
import { TerminalRunner, type TerminalStageExecutor } from "./TerminalRunner.js";
import type { ProviderHealthRecord } from "../db/schema/index.js";

describe("TerminalRunner", () => {
  it("runs the default stage order once", async () => {
    let now = 1_800_000_000_000;
    const calls: TerminalStageName[] = [];
    const runner = new TerminalRunner({
      config: defaultTerminalRunnerConfig(),
      stageExecutor: {
        runStage: async (name) => {
          calls.push(name);
          now += 10;
          return stageResult(name, "SUCCESS");
        },
      },
      sessionId: "session_terminal_test",
      clock: () => now,
    });

    const summary = await runner.run();

    expect(summary.cycleCount).toBe(1);
    expect(summary.sessionId).toBe("session_terminal_test");
    expect(summary.safetyStatus).toBe("PASS");
    expect(calls).toEqual([
      "scanner",
      "risk",
      "strategy",
      "fast_shadow_observe",
      "birdeye_enrichment",
      "shadow_observe",
      "shadow_exits",
      "shadow_calibration",
      "shadow_entries",
      "watchlist_returns",
      "analytics_report",
      "calibration_report",
    ]);
  });

  it("loops for a fixed cycle count and sleeps between cycles", async () => {
    let now = 1_800_000_000_000;
    const sleeps: number[] = [];
    const stageExecutor = createSingleStageExecutor(() => {
      now += 10;
      return stageResult("scanner", "SUCCESS");
    });
    const runner = new TerminalRunner({
      config: {
        ...defaultTerminalRunnerConfig(),
        once: false,
        cycles: 2,
        intervalMs: 1_000,
      },
      stageExecutor,
      stageNames: ["scanner"],
      clock: () => now,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        now += delayMs;
      },
    });

    const summary = await runner.run();

    expect(summary.cycleCount).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("continues after recoverable stage failures", async () => {
    const stageExecutor: TerminalStageExecutor = {
      runStage: async (name) =>
        name === "scanner"
          ? stageResult(name, "FAILED", {
              recoverableFailure: true,
              errorMessage: "No PAPER session with rows was found.",
            })
          : stageResult(name, "SUCCESS"),
    };
    const runner = new TerminalRunner({
      config: defaultTerminalRunnerConfig(),
      stageExecutor,
      stageNames: ["scanner", "risk"],
    });

    const summary = await runner.run();

    expect(summary.safetyStatus).toBe("PASS");
    expect(summary.cycles[0]?.status).toBe("PARTIAL");
    expect(summary.cycles[0]?.stages).toHaveLength(2);
  });

  it("stops immediately on fatal safety failures", async () => {
    const stageExecutor: TerminalStageExecutor = {
      runStage: async (name) =>
        stageResult(name, "FAILED", {
          recoverableFailure: false,
          errorMessage: "live mode attempted",
        }),
    };
    const runner = new TerminalRunner({
      config: defaultTerminalRunnerConfig(),
      stageExecutor,
      stageNames: ["scanner", "risk"],
    });

    const summary = await runner.run();

    expect(summary.safetyStatus).toBe("FAILED");
    expect(summary.fatalErrorMessage).toBe("live mode attempted");
    expect(summary.cycles[0]?.status).toBe("FAILED");
    expect(summary.cycles[0]?.stages).toHaveLength(1);
  });

  it("rolls provider pressure up from stages to cycle and run", async () => {
    const runner = new TerminalRunner({
      config: defaultTerminalRunnerConfig(),
      stageExecutor: createSingleStageExecutor(() =>
        stageResult("scanner", "SUCCESS", {
          providerPressure: summarizeProviderHealthRows([
            providerHealth("JUPITER", "RATE_LIMITED"),
            providerHealth("DEXSCREENER", "OK"),
          ]),
        }),
      ),
      stageNames: ["scanner"],
    });

    const summary = await runner.run();

    expect(summary.providerPressure.total).toBe(2);
    expect(summary.providerPressure.statusCounts.RATE_LIMITED).toBe(1);
    expect(summary.cycles[0]?.providerPressure.total).toBe(2);
  });

  it("emits compact progress messages for cycles and stages", async () => {
    let now = 1_800_000_000_000;
    const progress: string[] = [];
    const runner = new TerminalRunner({
      config: defaultTerminalRunnerConfig(),
      stageExecutor: createSingleStageExecutor(() => {
        now += 10;
        return stageResult("scanner", "SUCCESS");
      }),
      stageNames: ["scanner"],
      clock: () => now,
      progress: (message) => progress.push(message),
    });

    await runner.run();

    expect(progress).toEqual([
      "[2027-01-15T08:00:00.000Z] Cycle 1 started.",
      "[2027-01-15T08:00:00.000Z] Cycle 1 stage scanner started.",
      "[2027-01-15T08:00:00.010Z] Cycle 1 stage scanner SUCCESS: scanner SUCCESS",
      "[2027-01-15T08:00:00.010Z] Cycle 1 complete: SUCCESS durationMs=10.",
    ]);
  });
});

function createSingleStageExecutor(
  runStage: (name: TerminalStageName) => TerminalStageResult,
): TerminalStageExecutor {
  return {
    runStage: async (name) => runStage(name),
  };
}

function stageResult(
  name: TerminalStageName,
  status: TerminalStageResult["status"],
  overrides: Partial<TerminalStageResult> = {},
): TerminalStageResult {
  return {
    name,
    status,
    startedAtMs: 1_800_000_000_000,
    endedAtMs: 1_800_000_000_010,
    durationMs: 10,
    summary: `${name} ${status}`,
    counts: {},
    providerPressure: createEmptyProviderPressureSummary(),
    recoverableFailure: false,
    ...overrides,
  };
}

function providerHealth(
  provider: string,
  status: ProviderHealthRecord["status"],
): ProviderHealthRecord {
  return {
    id: `${provider}_${status}`,
    sessionId: null,
    provider,
    timestampMs: 1_800_000_000_000,
    status,
    latencyMs: 10,
    rateLimited: status === "RATE_LIMITED",
    errorMessage: null,
    creditsUsed: null,
    contextJson: null,
  };
}
