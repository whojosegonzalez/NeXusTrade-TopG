import type { StrategyRuntimeConfig } from "../StrategyConfig.js";
import type { StrategyRuleResult } from "./StrategyRuleResult.js";

export function evaluatePriceImpactAttractivenessRule(
  maxPriceImpactPct: number | undefined,
  config: StrategyRuntimeConfig,
): StrategyRuleResult {
  if (maxPriceImpactPct === undefined) {
    return {
      ruleName: "price_impact_attractiveness",
      points: 0,
      passed: true,
      warnings: ["Price impact is missing; no strategy points awarded."],
      reason: "Price impact is unavailable.",
    };
  }

  const points = maxPriceImpactPct < 2 ? 10 : maxPriceImpactPct <= 5 ? 5 : 0;
  const passed = maxPriceImpactPct <= config.maxPriceImpactPct;

  return {
    ruleName: "price_impact_attractiveness",
    points,
    passed,
    warnings: passed
      ? []
      : [`Price impact ${maxPriceImpactPct}% is above ${config.maxPriceImpactPct}%.`],
    reason: `Max price impact pct=${maxPriceImpactPct}.`,
  };
}
