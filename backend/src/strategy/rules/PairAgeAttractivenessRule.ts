import type { StrategyRuntimeConfig } from "../StrategyConfig.js";
import type { StrategyRuleResult } from "./StrategyRuleResult.js";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

export function evaluatePairAgeAttractivenessRule(
  pairAgeSeconds: number | undefined,
  config: StrategyRuntimeConfig,
): StrategyRuleResult {
  if (pairAgeSeconds === undefined) {
    return {
      ruleName: "pair_age_attractiveness",
      points: 0,
      passed: false,
      warnings: ["Pair age is missing."],
      reason: "Pair age is unavailable.",
    };
  }

  const minPairAgeSeconds = config.minPairAgeMinutes * SECONDS_PER_MINUTE;
  const points =
    pairAgeSeconds > SECONDS_PER_DAY ? 10 : pairAgeSeconds >= minPairAgeSeconds ? 5 : 0;
  const passed = pairAgeSeconds >= minPairAgeSeconds;

  return {
    ruleName: "pair_age_attractiveness",
    points,
    passed,
    warnings: passed
      ? []
      : [`Pair age ${pairAgeSeconds}s is below ${config.minPairAgeMinutes} minutes.`],
    reason: `Pair age seconds=${pairAgeSeconds}.`,
  };
}
