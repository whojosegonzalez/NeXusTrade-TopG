import type { QuoteResult } from "@nexustrade/shared";

import type { RiskRuleResult } from "./RiskRuleResult.js";

export interface PriceImpactRuleFacts {
  readonly buyPriceImpactPct?: number;
  readonly sellPriceImpactPct?: number;
  readonly maxPriceImpactPct?: number;
}

export interface PriceImpactRuleResult extends RiskRuleResult {
  readonly facts: PriceImpactRuleFacts;
}

export function evaluatePriceImpactRule(
  buyQuote: QuoteResult | undefined,
  sellQuote: QuoteResult | undefined,
): PriceImpactRuleResult {
  const buyPriceImpactPct = buyQuote?.estimatedPriceImpactPct;
  const sellPriceImpactPct = sellQuote?.estimatedPriceImpactPct;
  const impacts = [buyPriceImpactPct, sellPriceImpactPct].filter(
    (impact): impact is number => impact !== undefined,
  );

  if (impacts.length === 0) {
    return {
      severity: "WARN",
      flags: ["MISSING_QUOTE"],
      deductions: [
        {
          flag: "MISSING_QUOTE",
          points: 10,
          reason: "Buy and sell quote price impact evidence is missing.",
        },
      ],
      facts: {},
    };
  }

  const maxPriceImpactPct = Math.max(...impacts);
  const missingQuoteDeduction =
    buyQuote === undefined || sellQuote === undefined
      ? [
          {
            flag: "MISSING_QUOTE" as const,
            points: 10,
            reason: "One quote side is missing.",
          },
        ]
      : [];

  if (maxPriceImpactPct > 15) {
    return {
      severity: "FAIL",
      flags: ["HIGH_PRICE_IMPACT", ...missingQuoteDeduction.map((deduction) => deduction.flag)],
      deductions: [
        {
          flag: "HIGH_PRICE_IMPACT",
          points: 30,
          reason: "Quote price impact is above 15%.",
        },
        ...missingQuoteDeduction,
      ],
      facts: {
        ...(buyPriceImpactPct !== undefined ? { buyPriceImpactPct } : {}),
        ...(sellPriceImpactPct !== undefined ? { sellPriceImpactPct } : {}),
        maxPriceImpactPct,
      },
    };
  }

  if (maxPriceImpactPct >= 5) {
    return {
      severity: "WARN",
      flags: ["MEDIUM_PRICE_IMPACT", ...missingQuoteDeduction.map((deduction) => deduction.flag)],
      deductions: [
        {
          flag: "MEDIUM_PRICE_IMPACT",
          points: 10,
          reason: "Quote price impact is between 5% and 15%.",
        },
        ...missingQuoteDeduction,
      ],
      facts: {
        ...(buyPriceImpactPct !== undefined ? { buyPriceImpactPct } : {}),
        ...(sellPriceImpactPct !== undefined ? { sellPriceImpactPct } : {}),
        maxPriceImpactPct,
      },
    };
  }

  return {
    severity: missingQuoteDeduction.length > 0 ? "WARN" : "PASS",
    flags: missingQuoteDeduction.map((deduction) => deduction.flag),
    deductions: missingQuoteDeduction,
    facts: {
      ...(buyPriceImpactPct !== undefined ? { buyPriceImpactPct } : {}),
      ...(sellPriceImpactPct !== undefined ? { sellPriceImpactPct } : {}),
      maxPriceImpactPct,
    },
  };
}
