import type { StrategyRuntimeConfig } from "../StrategyConfig.js";
import type { StrategyRuleResult } from "./StrategyRuleResult.js";

export function evaluateVolumeRule(
  volume1hUsd: number | undefined,
  config: StrategyRuntimeConfig,
): StrategyRuleResult {
  if (volume1hUsd === undefined) {
    return {
      ruleName: "volume_1h_attractiveness",
      points: 0,
      passed: false,
      warnings: ["1h volume USD is missing."],
      reason: "1h volume is unavailable.",
    };
  }

  const points = volume1hUsd > 50_000 ? 20 : volume1hUsd > 10_000 ? 10 : 0;
  const passed = volume1hUsd >= config.minVolume1hUsd;

  return {
    ruleName: "volume_1h_attractiveness",
    points,
    passed,
    warnings: passed ? [] : [`1h volume ${volume1hUsd} is below ${config.minVolume1hUsd}.`],
    reason: `1h volume USD=${volume1hUsd}.`,
  };
}
