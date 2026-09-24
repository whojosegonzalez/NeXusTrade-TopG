import type { StrategyRuntimeConfig } from "../StrategyConfig.js";
import type { StrategyRuleResult } from "./StrategyRuleResult.js";

export function evaluateLiquidityAttractivenessRule(
  liquidityUsd: number | undefined,
  config: StrategyRuntimeConfig,
): StrategyRuleResult {
  if (liquidityUsd === undefined) {
    return {
      ruleName: "liquidity_attractiveness",
      points: 0,
      passed: false,
      warnings: ["Liquidity USD is missing."],
      reason: "Liquidity is unavailable.",
    };
  }

  const points = liquidityUsd > 50_000 ? 20 : liquidityUsd > 25_000 ? 10 : 0;
  const passed = liquidityUsd >= config.minLiquidityUsd;

  return {
    ruleName: "liquidity_attractiveness",
    points,
    passed,
    warnings: passed ? [] : [`Liquidity ${liquidityUsd} is below ${config.minLiquidityUsd}.`],
    reason: `Liquidity USD=${liquidityUsd}.`,
  };
}
