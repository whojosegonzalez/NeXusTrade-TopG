import type { RiskResult } from "../db/schema/index.js";
import type { TokenEnrichmentSnapshot } from "@nexustrade/shared";

import type { RiskFlag } from "./RiskFlags.js";
import { evaluateAuthorityRule, type AuthorityRuleFacts } from "./rules/AuthorityRule.js";
import { evaluateLiquidityRule, type LiquidityRuleFacts } from "./rules/LiquidityRule.js";
import { evaluatePairAgeRule, type PairAgeRuleFacts } from "./rules/PairAgeRule.js";
import { evaluatePriceImpactRule, type PriceImpactRuleFacts } from "./rules/PriceImpactRule.js";
import {
  maxSeverity,
  type RiskRuleResult,
  type RiskRuleSeverity,
  type RiskScoreDeduction,
} from "./rules/RiskRuleResult.js";

export interface RiskEvaluationFacts
  extends AuthorityRuleFacts, LiquidityRuleFacts, PairAgeRuleFacts, PriceImpactRuleFacts {
  readonly tokenProgram?: string;
}

export interface RiskScoreEvaluation {
  readonly score: number;
  readonly result: RiskResult;
  readonly passed: boolean;
  readonly flags: readonly RiskFlag[];
  readonly deductions: readonly RiskScoreDeduction[];
  readonly facts: RiskEvaluationFacts;
}

export class RiskScoringService {
  evaluate(snapshot: TokenEnrichmentSnapshot, checkedAtMs: number): RiskScoreEvaluation {
    const authority = evaluateAuthorityRule(snapshot.riskEvidence);
    const liquidity = evaluateLiquidityRule(snapshot.bestPair);
    const pairAge = evaluatePairAgeRule(snapshot.bestPair, checkedAtMs);
    const priceImpact = evaluatePriceImpactRule(snapshot.buyQuote, snapshot.sellQuote);
    const ruleResults = [authority, liquidity, pairAge, priceImpact];
    const deductions = ruleResults.flatMap((result) => result.deductions);
    const score = clampScore(
      100 - deductions.reduce((total, deduction) => total + deduction.points, 0),
    );
    const result = combineResult(score, ruleResults);

    return {
      score,
      result,
      passed: result === "PASS",
      flags: uniqueFlags(ruleResults.flatMap((ruleResult) => ruleResult.flags)),
      deductions,
      facts: {
        ...authority.facts,
        ...liquidity.facts,
        ...pairAge.facts,
        ...priceImpact.facts,
        ...(snapshot.metadata?.tokenProgram
          ? { tokenProgram: snapshot.metadata.tokenProgram }
          : snapshot.identity.tokenProgram
            ? { tokenProgram: snapshot.identity.tokenProgram }
            : {}),
      },
    };
  }
}

function combineResult(score: number, ruleResults: readonly RiskRuleResult[]): RiskResult {
  const scoreResult = scoreToResult(score);
  const ruleSeverity = maxSeverity(ruleResults.map((ruleResult) => ruleResult.severity));
  const severityResult = severityToResult(ruleSeverity);

  return mostSevereResult(scoreResult, severityResult);
}

function scoreToResult(score: number): RiskResult {
  if (score >= 90) {
    return "PASS";
  }

  if (score >= 70) {
    return "WARN";
  }

  return "FAIL";
}

function severityToResult(severity: RiskRuleSeverity): RiskResult {
  if (severity === "FAIL") {
    return "FAIL";
  }

  if (severity === "WARN" || severity === "UNKNOWN") {
    return "WARN";
  }

  return "PASS";
}

function mostSevereResult(left: RiskResult, right: RiskResult): RiskResult {
  return resultWeight(right) > resultWeight(left) ? right : left;
}

function resultWeight(result: RiskResult): number {
  switch (result) {
    case "FAIL":
      return 3;
    case "WARN":
      return 2;
    case "UNKNOWN":
      return 1;
    case "PASS":
      return 0;
  }
}

function uniqueFlags(flags: readonly RiskFlag[]): readonly RiskFlag[] {
  return [...new Set(flags)];
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}
