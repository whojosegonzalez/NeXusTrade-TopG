import { describe, expect, it } from "vitest";

import type {
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { ShadowThresholdAnalysisService } from "./ShadowThresholdAnalysisService.js";

describe("ShadowThresholdAnalysisService", () => {
  it("selects the earliest eligible decision per mint without looking at future returns", () => {
    const report = analyze(
      [
        decision({ id: "first", mintAddress: "mint-a", decidedAtMs: 1 }),
        decision({ id: "later", mintAddress: "mint-a", decidedAtMs: 2 }),
        decision({
          id: "hard-gate",
          mintAddress: "mint-b",
          decidedAtMs: 3,
          failedRules: ["liquidity_attractiveness"],
        }),
        decision({
          id: "missing-quote",
          mintAddress: "mint-c",
          decidedAtMs: 4,
          failedRules: ["price_impact_attractiveness"],
        }),
      ],
      [
        observation("first", 15, 11),
        observation("first", 60, 18),
        observation("later", 15, 80),
        observation("later", 60, 100),
      ],
    );

    expect(report.selectedCandidates).toHaveLength(1);
    expect(report.selectedCandidates[0]).toMatchObject({
      decisionId: "first",
      classification: "SELECTED",
    });
    expect(report.aggregate.classificationCounts).toMatchObject({
      SELECTED: 1,
      DUPLICATE_ATTENTION_SUPPRESSED: 1,
      HARD_GATE_BLOCKED: 1,
      MISSING_QUOTE_OR_PRICE_IMPACT: 1,
    });
    expect(
      report.scenarios.find(
        (scenario) =>
          scenario.targetPct === 10 && scenario.stopPct === 10 && scenario.maxHoldMinutes === 60,
      ),
    ).toMatchObject({ targetFirstCount: 1, stopFirstCount: 0 });
  });

  it("does not convert missing observations or insufficient samples into a promotion", () => {
    const report = analyze(
      [decision({ id: "no-observation", mintAddress: "mint-a", decidedAtMs: 1 })],
      [],
    );

    expect(report.selectedCandidates[0]).toMatchObject({
      classification: "NO_FORWARD_OBSERVATION",
    });
    expect(report.recommendation).toBe("COLLECT_MORE_INDEPENDENT_DATA");
    expect(report.safety).toMatchObject({
      providerCalls: false,
      databaseWrites: false,
      paperExecution: false,
      strategyDefaultsChanged: false,
    });
  });
});

function analyze(
  decisions: readonly StrategyDecisionRecord[],
  watchlistReturns: readonly WatchlistReturnObservationRecord[],
) {
  const run = {
    label: "T1",
    path: "data/archive/test/nexus_paper.db",
    sourceKind: "database",
    warnings: [],
    strategyDecisions: decisions,
    watchlistReturns,
    riskAssessments: [],
    tokenRadar: [],
    providerHealth: [],
    systemLogs: [],
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
  } as ShadowCalibrationRawRun;

  return new ShadowThresholdAnalysisService({
    archives: [],
    runs: [run],
    clock: () => 0,
  }).generate();
}

function decision(input: {
  readonly id: string;
  readonly mintAddress: string;
  readonly decidedAtMs: number;
  readonly failedRules?: readonly string[];
}): StrategyDecisionRecord {
  const failedRules = input.failedRules ?? [];
  const factors = [
    "risk_eligibility",
    "liquidity_attractiveness",
    "volume_1h_attractiveness",
    "pair_age_attractiveness",
    "price_impact_attractiveness",
  ].map((ruleName) => ({
    ruleName,
    points: ruleName === "risk_eligibility" ? 65 : 0,
    passed: !failedRules.includes(ruleName),
    warnings: failedRules.includes(ruleName) ? ["missing evidence"] : [],
  }));

  return {
    id: input.id,
    sessionId: "session-1",
    mintAddress: input.mintAddress,
    decidedAtMs: input.decidedAtMs,
    decision: "SKIP",
    strategyName: "nexustrade-v1",
    score: 65,
    reason: "baseline skip",
    inputSnapshotJson: JSON.stringify({
      strategyScore: {
        rawDecision: "SKIP",
        buyScoreThreshold: 90,
        watchScoreThreshold: 70,
        buyEligible: failedRules.length === 0,
        duplicateBuyBlocked: false,
        maxBuyCapBlocked: false,
        factors,
      },
      riskAssessment: {
        result: "PASS",
        riskFlags: [],
      },
      tokenRadar: { symbol: input.id },
    }),
    createdAtMs: input.decidedAtMs,
  };
}

function observation(
  strategyDecisionId: string,
  horizonMinutes: number,
  returnPctSol: number,
): WatchlistReturnObservationRecord {
  return {
    id: `${strategyDecisionId}-${horizonMinutes}`,
    sessionId: "session-1",
    strategyDecisionId,
    tokenRadarId: null,
    mintAddress: "mint",
    pairAddress: null,
    symbol: null,
    decision: "SKIP",
    strategyName: "nexustrade-v1",
    strategyScore: 65,
    horizonMinutes,
    baselineObservedAtMs: 0,
    baselinePriceSol: null,
    baselinePriceUsd: null,
    baselineLiquidityUsd: null,
    baselineVolume5mUsd: null,
    baselineVolume1hUsd: null,
    baselineSource: "DEXSCREENER",
    dueAtMs: horizonMinutes * 60_000,
    observedAtMs: horizonMinutes * 60_000,
    observedPriceSol: null,
    observedPriceUsd: null,
    observedLiquidityUsd: null,
    observedVolume5mUsd: null,
    observedVolume1hUsd: null,
    observedSource: "DEXSCREENER",
    returnPctSol: String(returnPctSol),
    returnPctUsd: null,
    status: "OBSERVED",
    errorCode: null,
    errorMessage: null,
    rawDataJson: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}
