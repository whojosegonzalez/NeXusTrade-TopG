import { describe, expect, it } from "vitest";

import type { ReturnPoint, ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { ShadowCalibrationReport } from "../shadow-calibration/ShadowCalibrationTypes.js";
import type { ShadowEntryCandidate, ShadowEntryReport } from "../shadow-entry/ShadowEntryTypes.js";
import {
  createEmptyProviderPressureSummary,
  mergeProviderPressureSummaries,
  summarizeProviderHealthRows,
  type TerminalRunSummary,
} from "../terminal-runner/TerminalRunSummary.js";
import type { ProviderHealthRecord } from "../db/schema/index.js";
import { defaultResearchAggregateConfig } from "./ResearchAggregateConfig.js";
import { CrossRunResearchService } from "./CrossRunResearchService.js";
import type { ResearchArchiveMetadata } from "./ResearchAggregateTypes.js";

describe("CrossRunResearchService", () => {
  it("validates one-session archives and aggregates threshold outcomes", () => {
    const config = {
      ...defaultResearchAggregateConfig(),
      runSources: [
        { label: "RunA", path: "data/archive/run-a" },
        { label: "RunB", path: "data/archive/run-b" },
      ],
      targetPcts: [10],
      stopPcts: [10],
      thresholdProfiles: [
        {
          id: "BUY55",
          version: "v1",
          label: "BUY >= 55",
          buyScoreThreshold: 55,
          watchScoreThreshold: 50,
        },
      ],
    };
    const archives = [archive("RunA", "session_a", 2), archive("RunB", "session_b", 1)];
    const candidates = [
      candidate("RunA", "decision_a1", "mint_a", 60, [
        { horizonMinutes: 1, returnPct: 5 },
        { horizonMinutes: 3, returnPct: 12 },
      ]),
      candidate("RunA", "decision_a2", "mint_b", 58, [{ horizonMinutes: 1, returnPct: 11 }]),
      candidate("RunB", "decision_b1", "mint_c", 57, [
        { horizonMinutes: 1, returnPct: -11 },
        { horizonMinutes: 3, returnPct: 20 },
      ]),
    ];
    const { runValidations, crossRun } = new CrossRunResearchService().generate({
      config,
      archives,
      shadowCalibration: shadowCalibrationReport(["RunA", "RunB"]),
      shadowEntries: shadowEntryReport({
        observedDecisionCount: 3,
        uniqueMintCount: 3,
      }),
      candidates,
    });

    expect(runValidations).toHaveLength(2);
    expect(runValidations[0]).toMatchObject({
      label: "RunA",
      oneSession: true,
      scannerStoredCount: 2,
      strategyWrittenCount: 2,
      validForPromotion: true,
    });
    expect(crossRun.providerPressure.find((row) => row.provider === "JUPITER")).toMatchObject({
      rateLimitedPercent: 50,
      liveRateLimitedPercent: 50,
    });
    expect(crossRun.thresholdComparisons[0]).toMatchObject({
      profileId: "BUY55",
      observedBuyCount: 3,
      uniqueBuyMints: 3,
      targetHitRates: {
        "10": 100,
      },
      drawdownFirstRates: {
        "10": 33.33333333333333,
      },
    });
    expect(crossRun.concentration).toMatchObject({
      targetFirstWinCount: 2,
      maxSingleRunWinSharePct: 100,
      dominantRunLabel: "RunA",
    });
  });

  it("marks old pre-patch archives invalid when top-level sessionId is missing", () => {
    const config = {
      ...defaultResearchAggregateConfig(),
      runSources: [{ label: "Old", path: "data/archive/old" }],
    };
    const baseArchive = archive("Old", "session_old", 1);
    const terminalSummaryWithoutSession = { ...baseArchive.terminalSummary };
    delete terminalSummaryWithoutSession.sessionId;
    const oldArchive = {
      ...baseArchive,
      terminalSummary: terminalSummaryWithoutSession,
    };
    const { runValidations } = new CrossRunResearchService().generate({
      config,
      archives: [oldArchive],
      shadowCalibration: shadowCalibrationReport(["Old"]),
      shadowEntries: shadowEntryReport({
        observedDecisionCount: 0,
        uniqueMintCount: 0,
      }),
      candidates: [],
    });

    expect(runValidations[0]?.validForPromotion).toBe(false);
    expect(runValidations[0]?.warnings.join(" ")).toMatch(/pre-patch/i);
  });
});

function archive(label: string, sessionId: string, scannerStored: number): ResearchArchiveMetadata {
  const terminalSummary = terminalSummaryFor(label, sessionId, scannerStored);

  return {
    label,
    inputPath: `data/archive/${label}`,
    resolvedPath: `U:/Projects/NeXusTrade-Otis/data/archive/${label}`,
    databasePath: `U:/Projects/NeXusTrade-Otis/data/archive/${label}/nexus_paper.db`,
    runnerJsonPath: `U:/Projects/NeXusTrade-Otis/data/archive/${label}/runner-output/${label}.json`,
    terminalSummary,
    warnings: [],
  };
}

function terminalSummaryFor(
  label: string,
  sessionId: string,
  scannerStored: number,
): TerminalRunSummary {
  return {
    runId: `terminal_${label}`,
    sessionId,
    mode: "PAPER",
    shadowOnly: true,
    safetyStatus: "PASS",
    startedAtMs: 1_800_000_000_000,
    endedAtMs: 1_800_000_001_000,
    durationMs: 1_000,
    intervalMs: 60_000,
    cycleCount: 1,
    cycles: [
      {
        cycleNumber: 1,
        startedAtMs: 1_800_000_000_000,
        endedAtMs: 1_800_000_001_000,
        durationMs: 1_000,
        status: "SUCCESS",
        stages: [
          {
            name: "scanner",
            status: "SUCCESS",
            startedAtMs: 1_800_000_000_000,
            endedAtMs: 1_800_000_000_010,
            durationMs: 10,
            summary: "scanner",
            counts: { sessionId, stored: scannerStored },
            providerPressure: createEmptyProviderPressureSummary(),
            recoverableFailure: false,
          },
          {
            name: "strategy",
            status: "SUCCESS",
            startedAtMs: 1_800_000_000_010,
            endedAtMs: 1_800_000_000_020,
            durationMs: 10,
            summary: "strategy",
            counts: { sessionId, written: 2 },
            providerPressure: createEmptyProviderPressureSummary(),
            recoverableFailure: false,
          },
        ],
        providerPressure: createEmptyProviderPressureSummary(),
      },
    ],
    providerPressure: mergeProviderPressureSummaries([
      summarizeProviderHealthRows([
        providerHealth("JUPITER", "OK"),
        providerHealth("JUPITER", "RATE_LIMITED"),
      ]),
    ]),
    stopped: false,
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

function candidate(
  runLabel: string,
  decisionId: string,
  mintAddress: string,
  score: number,
  observedPoints: readonly ReturnPoint[],
): ShadowEntryCandidate {
  const best = observedPoints.slice().sort((left, right) => right.returnPct - left.returnPct)[0];
  const worst = observedPoints.slice().sort((left, right) => left.returnPct - right.returnPct)[0];

  return {
    runLabel,
    decisionId,
    mintAddress,
    decidedAtMs: 1_800_000_000_000,
    decision: "WATCH",
    score,
    attribution: attribution(),
    observedPoints,
    ...(best ? { bestReturnPct: best.returnPct } : {}),
    ...(worst ? { worstReturnPct: worst.returnPct } : {}),
    duplicateBuyBlocked: false,
    repeatedMintDecision: false,
    repeatedAttentionStrength: "NONE",
    repeatedAttentionReasons: [],
    repeatedAttentionSourceCount: 1,
    firstAttentionAtMs: 1_800_000_000_000,
    lastAttentionAtMs: 1_800_000_000_000,
    missingQuote: false,
  };
}

function attribution(): ScoreAttribution {
  return {
    storedScore: 60,
    factorTotal: 60,
    factors: [],
    buyEligible: true,
    duplicateBuyBlocked: false,
    maxBuyCapBlocked: false,
    riskFlags: [],
    missingQuote: false,
    missingAuthorityEvidence: false,
    missingPriceImpact: false,
    blockingFactors: [],
  };
}

function shadowCalibrationReport(labels: readonly string[]): ShadowCalibrationReport {
  return {
    generatedAtMs: 1_800_000_000_000,
    config: {} as ShadowCalibrationReport["config"],
    runs: labels.map((label) => ({
      label,
      path: `data/archive/${label}/nexus_paper.db`,
      sourceKind: "database",
      sessionId: `session_${label.toLowerCase().replace("run", "")}`,
      mechanicallyValid: true,
      warnings: [],
      tokenRadarRows: 1,
      riskRows: 1,
      strategyRows: 1,
      observedReturnRows: 1,
      providerHealthRows: 1,
      orderCount: 0,
      fillCount: 0,
      positionCount: 0,
    })),
    aggregate: {
      runCount: labels.length,
      databaseRunCount: labels.length,
      reportOnlyRunCount: 0,
      observedDecisionCount: 0,
      uniqueMintCount: 0,
      orderCount: 0,
      fillCount: 0,
      positionCount: 0,
    },
    decisionOutcomes: [],
    uniqueMintOutcomes: [],
    scenarioPortfolioGrid: [],
    confirmationResults: [],
    filterAnalysis: [],
    recommendations: [],
    nextTestPlan: [],
  };
}

function shadowEntryReport(input: {
  readonly observedDecisionCount: number;
  readonly uniqueMintCount: number;
}): ShadowEntryReport {
  return {
    generatedAtMs: 1_800_000_000_000,
    config: {} as ShadowEntryReport["config"],
    runs: [],
    aggregate: {
      runCount: 2,
      observedDecisionCount: input.observedDecisionCount,
      uniqueMintCount: input.uniqueMintCount,
      orderCount: 0,
      fillCount: 0,
      positionCount: 0,
    },
    normalizedProfiles: [],
    profiles: [],
    baselineReproduction: {} as ShadowEntryReport["baselineReproduction"],
    improvementVsBaseline: [],
    candidates: [],
    scenarioGrid: [],
    bestExitByProfile: [],
    portfolioSummaries: [],
    readinessByProfile: [],
    recommendations: [],
    nextTestPlan: [],
  };
}
