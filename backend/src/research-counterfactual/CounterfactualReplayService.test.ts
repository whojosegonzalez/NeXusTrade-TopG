import { describe, expect, it } from "vitest";

import { CounterfactualReplayService } from "./CounterfactualReplayService.js";
import { dedupeCounterfactualCandidates } from "./CounterfactualRunner.js";
import type {
  CounterfactualCandidate,
  CounterfactualScenarioDefinition,
} from "./CounterfactualTypes.js";

const service = new CounterfactualReplayService();

describe("CounterfactualReplayService", () => {
  it("reproduces a stored threshold-only SKIP and promotes it at 65/60", () => {
    const candidate = buildCandidate({ score: 65, decision: "SKIP" });
    const baseline = service.replayBaseline(candidate);
    const result = service.replayScenario({
      candidate,
      baseline,
      scenario: scenario("SCORE_THRESHOLD_65_60", "thresholds"),
    });

    expect(baseline.fidelity).toBe("REPRODUCED");
    expect(baseline.baselineDecision).toBe("SKIP");
    expect(result).toMatchObject({
      evidenceQuality: "DIRECT",
      outcome: "PROMOTED_TO_BUY",
      counterfactualDecision: "BUY",
    });
  });

  it("reports a remaining gate rather than inventing a BUY", () => {
    const candidate = buildCandidate({
      score: 95,
      decision: "SKIP",
      failedRules: ["risk_eligibility", "liquidity_attractiveness"],
    });
    const baseline = service.replayBaseline(candidate);
    const result = service.replayScenario({
      candidate,
      baseline,
      scenario: scenario("RISK_ELIGIBILITY_OVERRIDE", "gates"),
    });

    expect(result).toMatchObject({
      evidenceQuality: "GATE_OVERRIDE",
      outcome: "BLOCKED_BY_ANOTHER_GATE",
      counterfactualDecision: "SKIP",
    });
    expect(result.remainingBlockers).toContain("liquidity_attractiveness");
  });

  it("does not evaluate a scenario when the stored thresholds are absent", () => {
    const candidate = buildCandidate({ score: 80, decision: "BUY", omitThresholds: true });
    const baseline = service.replayBaseline(candidate);
    const result = service.replayScenario({
      candidate,
      baseline,
      scenario: scenario("SCORE_THRESHOLD_75_70", "thresholds"),
    });

    expect(baseline.fidelity).toBe("NOT_REPLAYABLE");
    expect(result.outcome).toBe("NOT_EVALUABLE");
  });

  it("does not turn missing quote evidence into a price-impact pass", () => {
    const candidate = buildCandidate({
      score: 95,
      decision: "SKIP",
      failedRules: ["price_impact_attractiveness"],
    });
    const withMissingQuote: CounterfactualCandidate = {
      ...candidate,
      attribution: {
        ...candidate.attribution,
        missingQuote: true,
        missingPriceImpact: true,
      },
    };
    const baseline = service.replayBaseline(withMissingQuote);
    const result = service.replayScenario({
      candidate: withMissingQuote,
      baseline,
      scenario: scenario("PRICE_IMPACT_GATE_OVERRIDE", "gates"),
    });

    expect(result).toMatchObject({ evidenceQuality: "NOT_EVALUABLE", outcome: "NOT_EVALUABLE" });
  });
});

describe("dedupeCounterfactualCandidates", () => {
  it("selects best_per_mint using stored score rather than future returns", () => {
    const lowerScore = {
      ...buildCandidate({ score: 65, decision: "SKIP" }),
      decisionId: "lower_score",
      bestReturnPct: 900,
    };
    const higherScore = {
      ...buildCandidate({ score: 70, decision: "WATCH" }),
      decisionId: "higher_score",
      bestReturnPct: -90,
      decidedAtMs: 2,
    };

    expect(dedupeCounterfactualCandidates([lowerScore, higherScore], "best_per_mint")).toEqual([
      higherScore,
    ]);
  });
});

function buildCandidate(input: {
  readonly score: number;
  readonly decision: "BUY" | "WATCH" | "SKIP";
  readonly failedRules?: readonly string[];
  readonly omitThresholds?: boolean;
}): CounterfactualCandidate {
  const failedRules = input.failedRules ?? [];
  const factors = [
    "risk_eligibility",
    "liquidity_attractiveness",
    "volume_1h_attractiveness",
    "pair_age_attractiveness",
    "price_impact_attractiveness",
  ].map((ruleName) => ({
    ruleName,
    points: ruleName === "risk_eligibility" ? input.score : 0,
    passed: !failedRules.includes(ruleName),
    warnings: [],
  }));

  return {
    runLabel: "T1",
    decisionId: "decision_1",
    mintAddress: "mint_1",
    decidedAtMs: 1,
    decision: input.decision,
    score: input.score,
    attribution: {
      storedScore: input.score,
      factorTotal: input.score,
      factors,
      rawDecision: input.score >= 90 ? "BUY" : input.score >= 70 ? "WATCH" : "SKIP",
      ...(input.omitThresholds ? {} : { buyScoreThreshold: 90, watchScoreThreshold: 70 }),
      buyEligible: failedRules.length === 0,
      duplicateBuyBlocked: false,
      maxBuyCapBlocked: false,
      riskFlags: [],
      missingQuote: false,
      missingAuthorityEvidence: false,
      missingPriceImpact: false,
      blockingFactors: failedRules,
    },
    observedPoints: [],
  };
}

function scenario(
  id: CounterfactualScenarioDefinition["id"],
  category: CounterfactualScenarioDefinition["category"],
): CounterfactualScenarioDefinition {
  return { id, label: id, category, description: id };
}
