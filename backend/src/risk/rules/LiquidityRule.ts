import type { DexPairSnapshot } from "@nexustrade/shared";

import type { RiskRuleResult } from "./RiskRuleResult.js";

export interface LiquidityRuleFacts {
  readonly liquidityUsd?: number;
}

export interface LiquidityRuleResult extends RiskRuleResult {
  readonly facts: LiquidityRuleFacts;
}

export function evaluateLiquidityRule(bestPair: DexPairSnapshot | undefined): LiquidityRuleResult {
  if (!bestPair) {
    return {
      severity: "FAIL",
      flags: ["MISSING_PAIR"],
      deductions: [
        {
          flag: "MISSING_PAIR",
          points: 40,
          reason: "Best pair is missing.",
        },
      ],
      facts: {},
    };
  }

  if (bestPair.liquidityUsd === undefined) {
    return {
      severity: "FAIL",
      flags: ["MISSING_LIQUIDITY"],
      deductions: [
        {
          flag: "MISSING_LIQUIDITY",
          points: 40,
          reason: "Liquidity USD is missing.",
        },
      ],
      facts: {},
    };
  }

  if (bestPair.liquidityUsd < 2_000) {
    return {
      severity: "FAIL",
      flags: ["LOW_LIQUIDITY"],
      deductions: [
        {
          flag: "LOW_LIQUIDITY",
          points: 40,
          reason: "Liquidity is below $2,000.",
        },
      ],
      facts: {
        liquidityUsd: bestPair.liquidityUsd,
      },
    };
  }

  if (bestPair.liquidityUsd < 10_000) {
    return {
      severity: "WARN",
      flags: ["MEDIUM_LIQUIDITY"],
      deductions: [
        {
          flag: "MEDIUM_LIQUIDITY",
          points: 15,
          reason: "Liquidity is between $2,000 and $10,000.",
        },
      ],
      facts: {
        liquidityUsd: bestPair.liquidityUsd,
      },
    };
  }

  return {
    severity: "PASS",
    flags: [],
    deductions: [],
    facts: {
      liquidityUsd: bestPair.liquidityUsd,
    },
  };
}
