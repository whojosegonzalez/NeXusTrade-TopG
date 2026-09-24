import type { DexPairSnapshot } from "@nexustrade/shared";

import type { RiskRuleResult } from "./RiskRuleResult.js";

export interface PairAgeRuleFacts {
  readonly pairAgeSeconds?: number;
}

export interface PairAgeRuleResult extends RiskRuleResult {
  readonly facts: PairAgeRuleFacts;
}

export function evaluatePairAgeRule(
  bestPair: DexPairSnapshot | undefined,
  checkedAtMs: number,
): PairAgeRuleResult {
  if (!bestPair?.pairCreatedAt) {
    return {
      severity: "FAIL",
      flags: ["MISSING_PAIR"],
      deductions: [
        {
          flag: "MISSING_PAIR",
          points: 30,
          reason: "Pair creation time is missing.",
        },
      ],
      facts: {},
    };
  }

  const pairAgeSeconds = Math.max(
    0,
    Math.floor((checkedAtMs - bestPair.pairCreatedAt.getTime()) / 1000),
  );

  if (pairAgeSeconds < 5 * 60) {
    return {
      severity: "FAIL",
      flags: ["PAIR_TOO_NEW"],
      deductions: [
        {
          flag: "PAIR_TOO_NEW",
          points: 30,
          reason: "Pair age is below 5 minutes.",
        },
      ],
      facts: {
        pairAgeSeconds,
      },
    };
  }

  if (pairAgeSeconds <= 30 * 60) {
    return {
      severity: "WARN",
      flags: ["PAIR_YOUNG"],
      deductions: [
        {
          flag: "PAIR_YOUNG",
          points: 10,
          reason: "Pair age is between 5 and 30 minutes.",
        },
      ],
      facts: {
        pairAgeSeconds,
      },
    };
  }

  return {
    severity: "PASS",
    flags: [],
    deductions: [],
    facts: {
      pairAgeSeconds,
    },
  };
}
