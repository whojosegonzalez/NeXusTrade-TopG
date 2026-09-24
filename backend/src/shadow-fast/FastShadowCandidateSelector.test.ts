import { describe, expect, it } from "vitest";

import type { StrategyDecisionRecord } from "../db/schema/index.js";
import { FastShadowCandidateSelector } from "./FastShadowCandidateSelector.js";

describe("FastShadowCandidateSelector", () => {
  it("selects only stored 90/70 SKIP facts, deterministically suppressing duplicates and caps", () => {
    const selector = new FastShadowCandidateSelector();
    const selection = selector.select(
      [
        decision({ id: "first", mint: "mint-a", at: 1 }),
        decision({ id: "duplicate", mint: "mint-a", at: 2 }),
        decision({ id: "second", mint: "mint-b", at: 3 }),
        decision({ id: "bad-risk", mint: "mint-c", at: 4, riskResult: "WARN" }),
      ],
      1,
    );

    expect(selection.selectedDecisionIds).toEqual(["first"]);
    expect(selection.classificationCounts).toMatchObject({
      SELECTED: 1,
      DUPLICATE_MINT_SUPPRESSED: 1,
      SESSION_CAP_SUPPRESSED: 1,
      HARD_GATE_BLOCKED: 1,
    });
  });

  it("does not use a future return to make a candidate eligible", () => {
    const selector = new FastShadowCandidateSelector();
    const original = decision({ id: "missing-quote", mint: "mint-a", at: 1, missingQuote: true });
    const result = selector.select([original]);
    expect(result.selected).toHaveLength(0);
    expect(result.candidates[0]).toMatchObject({
      classification: "MISSING_PRICE_OR_QUOTE_EVIDENCE",
    });
  });
});

function decision(input: {
  readonly id: string;
  readonly mint: string;
  readonly at: number;
  readonly riskResult?: "PASS" | "WARN";
  readonly missingQuote?: boolean;
}): StrategyDecisionRecord {
  const riskResult = input.riskResult ?? "PASS";
  const missingQuote = input.missingQuote ?? false;
  return {
    id: input.id,
    sessionId: "session",
    mintAddress: input.mint,
    decidedAtMs: input.at,
    decision: "SKIP",
    strategyName: "test",
    score: 65,
    reason: "test",
    inputSnapshotJson: JSON.stringify({
      tokenRadar: { symbol: input.id, priceSol: "0.0001", priceUsd: "0.01" },
      riskAssessment: { result: riskResult, riskFlags: missingQuote ? ["MISSING_QUOTE"] : [] },
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
        ].map((ruleName) => ({
          ruleName,
          points: 1,
          passed: !missingQuote || ruleName !== "price_impact_attractiveness",
          warnings:
            missingQuote && ruleName === "price_impact_attractiveness" ? ["missing quote"] : [],
        })),
      },
    }),
    createdAtMs: input.at,
  };
}
