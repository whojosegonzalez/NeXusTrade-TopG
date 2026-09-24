import { describe, expect, it } from "vitest";

import type {
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { FastShadowValidationService } from "./FastShadowValidationService.js";

describe("FastShadowValidationService", () => {
  it("reconstructs F65E selection before calculating exact on-time fast exits", () => {
    const report = new FastShadowValidationService({
      archives: [],
      runs: [
        run(
          [decision("selected", "mint-a", 0), decision("out-of-band", "mint-b", 1, 70)],
          [
            observation("selected", 3, 12),
            observation("selected", 5, 8),
            observation("selected", 15, 20),
          ],
        ),
      ],
      clock: () => 0,
    }).generate();

    const primary = report.scenarios.find((scenario) => scenario.scenario.name === "PRIMARY");
    expect(report.aggregate).toMatchObject({ selectedCount: 1, selectedWith15mCoverageCount: 1 });
    expect(report.aggregate.coverage).toEqual([
      { horizonMinutes: 3, exactOnTimeCount: 1, lateCount: 0, missingCount: 0 },
      { horizonMinutes: 5, exactOnTimeCount: 1, lateCount: 0, missingCount: 0 },
      { horizonMinutes: 15, exactOnTimeCount: 1, lateCount: 0, missingCount: 0 },
    ]);
    expect(primary).toMatchObject({ targetFirstCount: 1, stopFirstCount: 0, evaluableCount: 1 });
    expect(report.safety).toMatchObject({
      providerCalls: false,
      databaseWrites: false,
      paperExecution: false,
    });
  });
});

function run(
  strategyDecisions: readonly StrategyDecisionRecord[],
  watchlistReturns: readonly WatchlistReturnObservationRecord[],
): ShadowCalibrationRawRun {
  return {
    label: "one",
    path: "data/archive/phase9.28/one/nexus_paper.db",
    sourceKind: "database",
    warnings: [],
    strategyDecisions,
    watchlistReturns,
    riskAssessments: [],
    tokenRadar: [],
    providerHealth: [],
    systemLogs: [],
    orderCount: 0,
    fillCount: 0,
    positionCount: 0,
  };
}

function decision(
  id: string,
  mintAddress: string,
  decidedAtMs: number,
  score = 65,
): StrategyDecisionRecord {
  return {
    id,
    sessionId: "session",
    mintAddress,
    decidedAtMs,
    decision: "SKIP",
    strategyName: "test",
    score,
    reason: "test",
    inputSnapshotJson: JSON.stringify({
      tokenRadar: { symbol: id, priceSol: "0.0001", priceUsd: "0.01" },
      riskAssessment: { result: "PASS", riskFlags: [] },
      strategyScore: {
        rawDecision: "SKIP",
        buyScoreThreshold: 90,
        watchScoreThreshold: 70,
        buyEligible: true,
        factors: [
          "risk_eligibility",
          "liquidity_attractiveness",
          "volume_1h_attractiveness",
          "pair_age_attractiveness",
          "price_impact_attractiveness",
        ].map((ruleName) => ({ ruleName, points: 1, passed: true, warnings: [] })),
      },
    }),
    createdAtMs: decidedAtMs,
  };
}

function observation(
  strategyDecisionId: string,
  horizonMinutes: 3 | 5 | 15,
  returnPct: number,
): WatchlistReturnObservationRecord {
  const dueAtMs = horizonMinutes * 60_000;
  return {
    id: `${strategyDecisionId}-${horizonMinutes}`,
    sessionId: "session",
    strategyDecisionId,
    tokenRadarId: null,
    mintAddress: "mint-a",
    pairAddress: null,
    symbol: null,
    decision: "SKIP",
    strategyName: "test",
    strategyScore: 65,
    horizonMinutes,
    baselineObservedAtMs: 0,
    baselinePriceSol: "0.0001",
    baselinePriceUsd: "0.01",
    baselineLiquidityUsd: null,
    baselineVolume5mUsd: null,
    baselineVolume1hUsd: null,
    baselineSource: "TEST",
    dueAtMs,
    observedAtMs: dueAtMs,
    observedPriceSol: null,
    observedPriceUsd: null,
    observedLiquidityUsd: null,
    observedVolume5mUsd: null,
    observedVolume1hUsd: null,
    observedSource: "TEST",
    returnPctSol: String(returnPct),
    returnPctUsd: null,
    status: "OBSERVED",
    errorCode: null,
    errorMessage: null,
    rawDataJson: null,
    createdAtMs: dueAtMs,
    updatedAtMs: dueAtMs,
  };
}
