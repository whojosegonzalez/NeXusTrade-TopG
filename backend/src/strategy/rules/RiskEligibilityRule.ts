import type { RiskAssessmentRecord } from "../../db/schema/index.js";
import type { RiskFlag } from "../../risk/RiskFlags.js";
import type { StrategyRuleResult } from "./StrategyRuleResult.js";

export const ELIGIBLE_WARN_FLAGS = ["MISSING_QUOTE", "MISSING_AUTHORITY_EVIDENCE"] as const;

export interface RiskEligibilityRuleResult extends StrategyRuleResult {
  readonly buyEligible: boolean;
  readonly eligibleWarn: boolean;
  readonly ineligibleFlags: readonly RiskFlag[];
}

export function evaluateRiskEligibilityRule(
  riskAssessment: RiskAssessmentRecord,
  riskFlags: readonly RiskFlag[],
): RiskEligibilityRuleResult {
  if (riskAssessment.result === "PASS") {
    return {
      ruleName: "risk_eligibility",
      points: 40,
      passed: true,
      buyEligible: true,
      eligibleWarn: false,
      ineligibleFlags: [],
      warnings: [],
      reason: "Risk result is PASS.",
    };
  }

  if (riskAssessment.result === "WARN") {
    const ineligibleFlags = riskFlags.filter((flag) => !isEligibleWarnFlag(flag));
    const buyEligible = ineligibleFlags.length === 0;

    return {
      ruleName: "risk_eligibility",
      points: buyEligible ? 20 : 0,
      passed: buyEligible,
      buyEligible,
      eligibleWarn: buyEligible,
      ineligibleFlags,
      warnings: buyEligible
        ? ["Risk WARN contains only eligible incomplete-evidence flags."]
        : [`Risk WARN contains ineligible flags: ${ineligibleFlags.join(",")}.`],
      reason: buyEligible
        ? "Risk WARN is eligible because all flags are incomplete-evidence flags."
        : `Risk WARN is ineligible because of ${ineligibleFlags.join(",")}.`,
    };
  }

  return {
    ruleName: "risk_eligibility",
    points: 0,
    passed: false,
    buyEligible: false,
    eligibleWarn: false,
    ineligibleFlags: riskFlags,
    warnings: [`Risk result ${riskAssessment.result} is not BUY-eligible.`],
    reason: `Risk result is ${riskAssessment.result}.`,
  };
}

function isEligibleWarnFlag(flag: RiskFlag): boolean {
  return ELIGIBLE_WARN_FLAGS.includes(flag as (typeof ELIGIBLE_WARN_FLAGS)[number]);
}
