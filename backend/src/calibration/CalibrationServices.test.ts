import { describe, expect, it } from "vitest";

import type {
  ProviderHealthRecord,
  StrategyDecisionRecord,
  WatchlistReturnObservationRecord,
} from "../db/schema/index.js";
import type { CalibrationDecisionAnalysis } from "./CalibrationTypes.js";
import { ForwardReturnAnalyzer } from "./ForwardReturnAnalyzer.js";
import { ProviderImpactAnalyzer } from "./ProviderImpactAnalyzer.js";
import { ScoreAttributionService } from "./ScoreAttributionService.js";
import { ThresholdComparisonService } from "./ThresholdComparisonService.js";

describe("ScoreAttributionService", () => {
  it("explains stored strategy score factors", () => {
    const decision = strategyDecision({
      score: 65,
      inputSnapshotJson: JSON.stringify({
        tokenRadar: {
          symbol: "PROV",
          liquidityUsd: "27667.46",
          volume1hUsd: "101886.6",
          ageSeconds: 8928,
        },
        riskAssessment: {
          result: "WARN",
          riskFlags: ["MISSING_AUTHORITY_EVIDENCE"],
        },
        strategyScore: {
          rawDecision: "SKIP",
          buyEligible: true,
          duplicateBuyBlocked: false,
          maxBuyCapBlocked: false,
          facts: {
            maxPriceImpactPct: 0.02,
          },
          factors: [
            factor("risk_eligibility", 20, true),
            factor("liquidity_attractiveness", 10, true),
            factor("volume_1h_attractiveness", 20, true),
            factor("pair_age_attractiveness", 5, true),
            factor("price_impact_attractiveness", 10, true),
            factor("duplicate_buy_protection", 0, true),
          ],
        },
      }),
    });

    const attribution = new ScoreAttributionService().explain(decision);

    expect(attribution.factorTotal).toBe(65);
    expect(attribution.storedScore).toBe(65);
    expect(attribution.symbol).toBe("PROV");
    expect(attribution.liquidityUsd).toBe(27667.46);
    expect(attribution.missingAuthorityEvidence).toBe(true);
    expect(attribution.missingQuote).toBe(false);
  });
});

describe("ForwardReturnAnalyzer", () => {
  it("calculates observed-horizon MFE, MAE, targets, and drawdowns", () => {
    const analyzer = new ForwardReturnAnalyzer({
      horizonsMinutes: [3, 5, 15, 30, 60],
      maxHoldMinutes: 60,
      targetPcts: [10, 25],
      drawdownPcts: [10, 25],
    });

    const result = analyzer.analyze([
      observation(3, -5),
      observation(5, 12),
      observation(15, -30),
      observation(30, 40),
      observation(120, 100),
    ]);

    expect(result.bestReturnPct).toBe(40);
    expect(result.bestHorizonMinutes).toBe(30);
    expect(result.worstReturnPct).toBe(-30);
    expect(result.worstHorizonMinutes).toBe(15);
    expect(result.targetHits.map((event) => event.thresholdPct)).toEqual([10, 25]);
    expect(result.drawdownBreaches.map((event) => event.thresholdPct)).toEqual([10, 25]);
  });
});

describe("ProviderImpactAnalyzer", () => {
  it("calculates provider rates and quote-impact score groups", () => {
    const impact = new ProviderImpactAnalyzer().analyze(
      [
        providerHealth("JUPITER", "OK"),
        providerHealth("JUPITER", "RATE_LIMITED"),
        providerHealth("DEXSCREENER", "OK"),
      ],
      [
        analysis({ score: 65, missingQuote: false, bestReturnPct: 12 }),
        analysis({ score: 55, missingQuote: true, bestReturnPct: 4 }),
      ],
    );

    expect(impact.providers.find((provider) => provider.provider === "JUPITER")).toMatchObject({
      total: 2,
      okPercent: 50,
      rateLimitedPercent: 50,
    });
    expect(impact.averageScoreWithQuote).toBe(65);
    expect(impact.averageScoreWithoutQuote).toBe(55);
    expect(impact.target10HitRateWithQuote).toBe(100);
    expect(impact.target10HitRateWithoutQuote).toBe(0);
  });
});

describe("ThresholdComparisonService", () => {
  it("does not turn ineligible or duplicate candidates into simulated BUYs", () => {
    const result = new ThresholdComparisonService().compare(
      [
        analysis({ score: 65, buyEligible: true, bestReturnPct: 12 }),
        analysis({ score: 65, buyEligible: false, bestReturnPct: 40 }),
        analysis({ score: 65, buyEligible: true, duplicateBuyBlocked: true, bestReturnPct: 40 }),
      ],
      [{ buyScoreThreshold: 65, watchScoreThreshold: 60 }],
      [10],
    );

    expect(result[0]).toMatchObject({
      buyCount: 1,
      observedBuyCount: 1,
      watchCount: 2,
      skipCount: 0,
      uniqueBuyMints: 1,
    });
    expect(result[0]?.targetHitRatesByPct["10"]).toBe(100);
  });
});

function factor(ruleName: string, points: number, passed: boolean) {
  return {
    ruleName,
    points,
    passed,
    reason: `${ruleName} reason`,
    warnings: [],
  };
}

function strategyDecision(overrides: Partial<StrategyDecisionRecord>): StrategyDecisionRecord {
  return {
    id: "decision_test",
    sessionId: "session_test",
    mintAddress: "mint_test",
    decidedAtMs: 1,
    decision: "SKIP",
    strategyName: "test",
    score: 0,
    reason: "test",
    inputSnapshotJson: null,
    createdAtMs: 1,
    ...overrides,
  } as StrategyDecisionRecord;
}

function observation(
  horizonMinutes: number,
  returnPctSol: number,
): WatchlistReturnObservationRecord {
  return {
    status: "OBSERVED",
    horizonMinutes,
    returnPctSol: returnPctSol.toString(),
    returnPctUsd: null,
  } as WatchlistReturnObservationRecord;
}

function providerHealth(
  provider: string,
  status: ProviderHealthRecord["status"],
): ProviderHealthRecord {
  return {
    provider,
    status,
  } as ProviderHealthRecord;
}

function analysis(input: {
  readonly score: number;
  readonly missingQuote?: boolean;
  readonly buyEligible?: boolean;
  readonly duplicateBuyBlocked?: boolean;
  readonly bestReturnPct?: number;
}): CalibrationDecisionAnalysis {
  return {
    datasetLabel: "test",
    decisionId: `decision_${input.score}_${input.bestReturnPct ?? 0}`,
    mintAddress: `mint_${input.score}_${input.bestReturnPct ?? 0}`,
    decidedAtMs: 1,
    decision: "SKIP",
    score: input.score,
    reason: "test",
    attribution: {
      storedScore: input.score,
      factorTotal: input.score,
      factors: [],
      buyEligible: input.buyEligible ?? true,
      duplicateBuyBlocked: input.duplicateBuyBlocked ?? false,
      maxBuyCapBlocked: false,
      riskFlags: input.missingQuote ? ["MISSING_QUOTE"] : [],
      missingQuote: input.missingQuote ?? false,
      missingAuthorityEvidence: false,
      missingPriceImpact: false,
      blockingFactors: [],
    },
    returns: {
      observedPoints:
        input.bestReturnPct === undefined
          ? []
          : [{ horizonMinutes: 5, returnPct: input.bestReturnPct }],
      ...(input.bestReturnPct !== undefined
        ? {
            bestReturnPct: input.bestReturnPct,
            bestHorizonMinutes: 5,
            worstReturnPct: input.bestReturnPct,
            worstHorizonMinutes: 5,
          }
        : {}),
      targetHits:
        input.bestReturnPct !== undefined && input.bestReturnPct >= 10
          ? [{ thresholdPct: 10, horizonMinutes: 5, returnPct: input.bestReturnPct }]
          : [],
      drawdownBreaches: [],
      ambiguousTargetStopOrdering: false,
    },
  };
}
