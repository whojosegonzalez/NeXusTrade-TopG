import { describe, expect, it } from "vitest";

import type { RiskAssessmentRecord, StrategyDecisionRecord } from "../../db/schema/index.js";
import { evaluateDuplicateBuyRule } from "./DuplicateBuyRule.js";
import { evaluateLiquidityAttractivenessRule } from "./LiquidityAttractivenessRule.js";
import { evaluatePairAgeAttractivenessRule } from "./PairAgeAttractivenessRule.js";
import { evaluatePriceImpactAttractivenessRule } from "./PriceImpactAttractivenessRule.js";
import { evaluateRiskEligibilityRule } from "./RiskEligibilityRule.js";
import { evaluateVolumeRule } from "./VolumeRule.js";
import { defaultStrategyConfig } from "../StrategyConfig.js";

describe("strategy rules", () => {
  it("scores risk PASS and eligible WARN while blocking dangerous risk", () => {
    expect(evaluateRiskEligibilityRule(createRisk("PASS"), [])).toMatchObject({
      points: 40,
      buyEligible: true,
    });
    expect(
      evaluateRiskEligibilityRule(createRisk("WARN"), [
        "MISSING_AUTHORITY_EVIDENCE",
        "MISSING_QUOTE",
      ]),
    ).toMatchObject({
      points: 20,
      buyEligible: true,
      eligibleWarn: true,
    });
    expect(evaluateRiskEligibilityRule(createRisk("WARN"), ["LOW_LIQUIDITY"])).toMatchObject({
      points: 0,
      buyEligible: false,
      ineligibleFlags: ["LOW_LIQUIDITY"],
    });
    expect(evaluateRiskEligibilityRule(createRisk("FAIL"), ["MISSING_PAIR"])).toMatchObject({
      points: 0,
      buyEligible: false,
    });
    expect(evaluateRiskEligibilityRule(createRisk("UNKNOWN"), [])).toMatchObject({
      points: 0,
      buyEligible: false,
    });
  });

  it("scores liquidity, volume, age, and price impact attractiveness", () => {
    const config = defaultStrategyConfig();

    expect(evaluateLiquidityAttractivenessRule(60_000, config)).toMatchObject({
      points: 20,
      passed: true,
    });
    expect(evaluateLiquidityAttractivenessRule(30_000, config)).toMatchObject({
      points: 10,
      passed: true,
    });
    expect(evaluateVolumeRule(60_000, config)).toMatchObject({
      points: 20,
      passed: true,
    });
    expect(evaluateVolumeRule(20_000, config)).toMatchObject({
      points: 10,
      passed: true,
    });
    expect(evaluatePairAgeAttractivenessRule(25 * 60 * 60, config)).toMatchObject({
      points: 10,
      passed: true,
    });
    expect(evaluatePairAgeAttractivenessRule(60 * 60, config)).toMatchObject({
      points: 5,
      passed: true,
    });
    expect(evaluatePriceImpactAttractivenessRule(1.5, config)).toMatchObject({
      points: 10,
      passed: true,
    });
    expect(evaluatePriceImpactAttractivenessRule(4, config)).toMatchObject({
      points: 5,
      passed: true,
    });
  });

  it("detects duplicate BUY history", () => {
    expect(evaluateDuplicateBuyRule([], false)).toMatchObject({
      duplicateBuy: false,
      passed: true,
    });
    expect(evaluateDuplicateBuyRule([createDecision("BUY")], false)).toMatchObject({
      duplicateBuy: true,
      passed: false,
    });
    expect(evaluateDuplicateBuyRule([], true)).toMatchObject({
      duplicateBuy: true,
      passed: false,
    });
  });
});

function createRisk(result: RiskAssessmentRecord["result"]): RiskAssessmentRecord {
  return {
    id: "risk_1",
    sessionId: "session_1",
    tokenRadarId: "radar_1",
    mintAddress: "Mint1111111111111111111111111111111111111111",
    checkedAtMs: 1,
    score: result === "PASS" ? 95 : 70,
    result,
    passed: result === "PASS",
    mintAuthorityDisabled: null,
    freezeAuthorityDisabled: null,
    tokenProgram: null,
    topHoldersPercent: null,
    liquidityUsd: null,
    riskFlagsJson: "[]",
    rawProviderDataJson: null,
    createdAtMs: 1,
  };
}

function createDecision(decision: StrategyDecisionRecord["decision"]): StrategyDecisionRecord {
  return {
    id: "decision_1",
    sessionId: "session_1",
    mintAddress: "Mint1111111111111111111111111111111111111111",
    decidedAtMs: 1,
    decision,
    strategyName: "phase6_first_pass",
    score: 100,
    reason: "test",
    inputSnapshotJson: "{}",
    createdAtMs: 1,
  };
}
