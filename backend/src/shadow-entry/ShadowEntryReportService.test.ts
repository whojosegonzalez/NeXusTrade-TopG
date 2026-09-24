import { describe, expect, it } from "vitest";

import type {
  SessionRecord,
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import { defaultShadowEntryConfig } from "./ShadowEntryConfig.js";
import { loadCandidates } from "./ShadowEntryCandidateLoader.js";
import { ShadowEntryReportService } from "./ShadowEntryReportService.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";

const now = 1_800_000_000_000;

describe("ShadowEntryReportService", () => {
  it("reports baseline, recovery-after-drawdown, improvement, readiness, and safety boundaries", () => {
    const runs = [
      rawRun("RunA", {
        strategyDecisions: [
          decision("buy_1", "mint_a", "BUY", 65, 1, {}),
          decision("watch_recovery", "mint_b", "WATCH", 60, 2, {}),
          decision("watch_failed", "mint_c", "WATCH", 60, 3, {}),
        ],
        watchlistReturns: [
          observation("buy_1", "mint_a", "BUY", 1, 2),
          observation("buy_1", "mint_a", "BUY", 3, 12),
          observation("watch_recovery", "mint_b", "WATCH", 1, -12),
          observation("watch_recovery", "mint_b", "WATCH", 3, 2),
          observation("watch_recovery", "mint_b", "WATCH", 5, 18),
          observation("watch_failed", "mint_c", "WATCH", 1, -12),
          observation("watch_failed", "mint_c", "WATCH", 3, -8),
          observation("watch_failed", "mint_c", "WATCH", 5, -15),
        ],
      }),
    ];
    const config = {
      ...defaultShadowEntryConfig(),
      profileIds: ["P001", "P006"] as const,
      sourceDecisions: ["BUY", "WATCH", "SKIP"] as const,
      minScore: 50,
      confirmationHorizonsMinutes: [1],
      confirmationMinReturnPcts: [0],
      earlyDrawdownModes: ["require_recovery"] as const,
      recoveryConfirmationReturnPcts: [0],
      recoveryWindowMinutes: [3],
      targetPcts: [10],
      stopPcts: [10],
      maxHoldMinutes: [15],
    };
    const report = new ShadowEntryReportService({
      config,
      runs,
      candidates: loadCandidates(runs, config),
      clock: () => now,
    }).generate();

    expect(report.aggregate).toMatchObject({
      runCount: 1,
      observedDecisionCount: 3,
      uniqueMintCount: 3,
      orderCount: 0,
      fillCount: 0,
      positionCount: 0,
    });
    expect(report.baselineReproduction).toMatchObject({
      applicable: false,
      passed: true,
    });
    expect(report.normalizedProfiles.some((row) => row.profileKey === "P001@v1")).toBe(true);
    expect(report.profiles.some((row) => row.profileKey === "P006@v1")).toBe(true);
    expect(
      report.candidates.some((candidate) => candidate.outcome === "WOULD_ENTER_AFTER_RECOVERY"),
    ).toBe(true);
    expect(
      report.candidates.some((candidate) => candidate.outcome === "FAILED_RECOVERY_AFTER_DRAWDOWN"),
    ).toBe(true);
    expect(report.improvementVsBaseline.map((row) => row.profileId)).toContain("P006");
    expect(report.readinessByProfile.map((row) => row.status)).not.toContain(
      "READY_FOR_PAPER_REVIEW",
    );
    expect(report.readinessByProfile.map((row) => row.status)).not.toContain("PROMISING");
    expect(report.readinessByProfile.every((row) => row.confidence)).toBe(true);
    expect(report.recommendations.map((item) => item.recommendation).join(" ")).toContain(
      "paper execution remains disabled",
    );
  });
});

function rawRun(
  label: string,
  input: {
    readonly strategyDecisions: readonly StrategyDecisionRecord[];
    readonly watchlistReturns: readonly WatchlistReturnObservationRecord[];
  },
): ShadowCalibrationRawRun {
  return {
    label,
    path: `data/${label}/nexus_paper.db`,
    sourceKind: "database",
    warnings: [],
    session: sessionRecord(`session_${label}`),
    strategyDecisions: input.strategyDecisions,
    watchlistReturns: input.watchlistReturns,
    riskAssessments: [],
    tokenRadar: [],
    providerHealth: [],
    systemLogs: [],
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
  };
}

function sessionRecord(id: string): SessionRecord {
  return {
    id,
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now - 60 * 60_000,
    endedAtMs: null,
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    targetProfitLamports: null,
    targetProfitBps: null,
    maxDrawdownLamports: null,
    realizedPnlLamports: 0,
    unrealizedPnlLamports: 0,
    terminationReason: "NOT_TERMINATED",
    configSnapshotJson: "{}",
    createdAtMs: now - 60 * 60_000,
    updatedAtMs: now - 60 * 60_000,
  };
}

function decision(
  id: string,
  mintAddress: string,
  decisionValue: StrategyDecisionRecord["decision"],
  score: number,
  order: number,
  options: {
    readonly duplicateBuyBlocked?: boolean;
    readonly missingQuote?: boolean;
  },
): StrategyDecisionRecord {
  return {
    id,
    sessionId: "session_test",
    mintAddress,
    decidedAtMs: now + order,
    decision: decisionValue,
    strategyName: "phase8_92_test",
    score,
    reason: "test decision",
    inputSnapshotJson: JSON.stringify({
      tokenRadar: {
        symbol: mintAddress.toUpperCase(),
        liquidityUsd: "10000",
        volume1hUsd: "50000",
        ageSeconds: 3600,
      },
      riskAssessment: {
        result: "PASS",
        riskFlags: options.missingQuote ? ["MISSING_QUOTE"] : [],
      },
      strategyScore: {
        buyEligible: true,
        duplicateBuyBlocked: options.duplicateBuyBlocked ?? false,
        maxBuyCapBlocked: false,
        factors: [
          {
            ruleName: "test_factor",
            points: score,
            passed: true,
            reason: "test",
            warnings: [],
          },
        ],
      },
    }),
    createdAtMs: now + order,
  };
}

function observation(
  strategyDecisionId: string,
  mintAddress: string,
  decisionValue: StrategyDecisionRecord["decision"],
  horizonMinutes: number,
  returnPct: number,
): WatchlistReturnObservationRecord {
  return {
    id: `${strategyDecisionId}_${horizonMinutes}`,
    sessionId: "session_test",
    strategyDecisionId,
    mintAddress,
    decision: decisionValue,
    strategyName: "phase8_92_test",
    horizonMinutes,
    baselineObservedAtMs: now,
    baselineSource: "TEST",
    dueAtMs: now + horizonMinutes * 60_000,
    status: "OBSERVED",
    returnPctSol: returnPct.toString(),
    returnPctUsd: null,
    createdAtMs: now,
    updatedAtMs: now,
  } as WatchlistReturnObservationRecord;
}
