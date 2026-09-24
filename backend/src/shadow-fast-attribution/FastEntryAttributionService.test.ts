import { describe, expect, it } from "vitest";

import type {
  StrategyDecisionRecord,
  TokenRadarRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { FastEntryAttributionService } from "./FastEntryAttributionService.js";

describe("FastEntryAttributionService", () => {
  it("extracts only stored or pre-decision facts before attaching fast-exit labels", () => {
    const report = analyze([
      run("T1", [decision("first", "mint-a", 100)], targetObservations("first"), [
        radar("mint-a", 50),
        radar("mint-a", 101),
      ]),
      run("T2", [decision("stop", "mint-b", 100)], stopObservations("stop")),
      run("T3", [decision("hold", "mint-c", 100)], holdObservations("hold")),
    ]);

    const first = report.candidates.find((candidate) => candidate.decisionId === "first");
    expect(first).toMatchObject({ primaryLabel: "TARGET_FIRST", classification: "SELECTED" });
    expect(
      first?.features.find((feature) => feature.key === "prior_token_radar_count"),
    ).toMatchObject({
      value: 1,
      source: { availability: "AVAILABLE_AT_DECISION_TIME" },
    });
    expect(report.safety).toMatchObject({
      databaseAccess: "READ_ONLY_ARCHIVES",
      providerCalls: false,
      databaseWrites: false,
      sessionCreation: false,
      paperExecution: false,
      walletLoaded: false,
      transactionSigning: false,
      transactionSubmission: false,
    });
    expect(report.recommendation).toBe("NO_DEFENSIBLE_HYPOTHESIS");
  });

  it("keeps future returns and later duplicate decisions out of F65E membership and features", () => {
    const report = analyze([
      run(
        "T1",
        [decision("first", "mint-a", 100), decision("later", "mint-a", 101)],
        [...targetObservations("first"), ...stopObservations("later")],
      ),
    ]);

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      decisionId: "first",
      primaryLabel: "TARGET_FIRST",
    });
    expect(report.aggregate.labelCounts).toMatchObject({ TARGET_FIRST: 1, STOP_FIRST: 0 });
  });

  it("emits a full successor contract only for a fixed, independent single-fact predicate", () => {
    const report = analyze(
      ["T1", "T2", "T3"].map((label) =>
        run(
          label,
          [
            decision(`${label}-target`, `${label}-target`, 100, "PREFERRED"),
            decision(`${label}-stop`, `${label}-stop`, 101, "OTHER"),
          ],
          [...targetObservations(`${label}-target`), ...stopObservations(`${label}-stop`)],
        ),
      ),
      {
        profileId: "F65P",
        version: "v1",
        featureKey: "token_source",
        expectedValue: "PREFERRED",
        rationale: "Synthetic safety fixture only.",
      },
    );

    expect(report.recommendation).toBe("PRE_REGISTER_SUCCESSOR_HYPOTHESIS");
    expect(report.successor).toMatchObject({
      profileId: "F65P",
      version: "v1",
      featureKey: "token_source",
    });
    expect(report.successor?.collectionContract).toHaveLength(3);
    expect(report.successor?.promotionGates).toHaveLength(3);
  });
});

function analyze(
  runs: readonly ShadowCalibrationRawRun[],
  registeredHypothesis?: {
    readonly profileId: string;
    readonly version: string;
    readonly featureKey: string;
    readonly expectedValue: string;
    readonly rationale: string;
  },
) {
  return new FastEntryAttributionService({
    archives: [],
    runs,
    clock: () => 0,
    ...(registeredHypothesis ? { registeredHypothesis } : {}),
  }).generate();
}

function run(
  label: string,
  strategyDecisions: readonly StrategyDecisionRecord[],
  watchlistReturns: readonly WatchlistReturnObservationRecord[],
  tokenRadar: readonly TokenRadarRecord[] = [],
): ShadowCalibrationRawRun {
  return {
    label,
    path: `data/archive/${label}/nexus_paper.db`,
    sourceKind: "database",
    warnings: [],
    strategyDecisions,
    watchlistReturns,
    riskAssessments: [],
    tokenRadar,
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
  source = "DEXSCREENER",
): StrategyDecisionRecord {
  return {
    id,
    sessionId: "session",
    mintAddress,
    decidedAtMs,
    decision: "SKIP",
    strategyName: "test",
    score: 65,
    reason: "baseline skip",
    inputSnapshotJson: JSON.stringify({
      tokenRadar: {
        symbol: id,
        source,
        priceSol: "0.0001",
        priceUsd: "0.01",
        liquidityUsd: "10000",
        volume5mUsd: "500",
        volume1hUsd: "6000",
        ageSeconds: 1000,
      },
      riskAssessment: { result: "PASS", riskFlags: [] },
      strategyScore: {
        rawDecision: "SKIP",
        buyScoreThreshold: 90,
        watchScoreThreshold: 70,
        buyEligible: true,
        duplicateBuyBlocked: false,
        maxBuyCapBlocked: false,
        facts: { buyPriceImpactPct: 0.1, sellPriceImpactPct: 0.2, maxPriceImpactPct: 0.2 },
        factors: [
          "risk_eligibility",
          "liquidity_attractiveness",
          "volume_1h_attractiveness",
          "pair_age_attractiveness",
          "price_impact_attractiveness",
          "duplicate_buy_protection",
        ].map((ruleName) => ({
          ruleName,
          points: ruleName === "risk_eligibility" ? 40 : 5,
          passed: true,
          warnings: [],
        })),
      },
    }),
    createdAtMs: decidedAtMs,
  };
}

function targetObservations(decisionId: string): readonly WatchlistReturnObservationRecord[] {
  return [
    observation(decisionId, 3, 11),
    observation(decisionId, 5, 12),
    observation(decisionId, 15, 13),
  ];
}

function stopObservations(decisionId: string): readonly WatchlistReturnObservationRecord[] {
  return [
    observation(decisionId, 3, -16),
    observation(decisionId, 5, -10),
    observation(decisionId, 15, -8),
  ];
}

function holdObservations(decisionId: string): readonly WatchlistReturnObservationRecord[] {
  return [
    observation(decisionId, 3, 2),
    observation(decisionId, 5, 3),
    observation(decisionId, 15, 4),
  ];
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
    mintAddress: "mint",
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

function radar(mintAddress: string, firstSeenAtMs: number): TokenRadarRecord {
  return {
    id: `radar-${firstSeenAtMs}`,
    sessionId: "session",
    mintAddress,
    symbol: null,
    name: null,
    pairAddress: null,
    source: "DEXSCREENER",
    firstSeenAtMs,
    discoveredAtMs: firstSeenAtMs,
    priceUsd: null,
    priceSol: null,
    liquidityUsd: null,
    volume5mUsd: null,
    volume1hUsd: null,
    ageSeconds: null,
    status: "DISCOVERED",
    notes: null,
    rawDataJson: null,
    createdAtMs: firstSeenAtMs,
    updatedAtMs: firstSeenAtMs,
  };
}
