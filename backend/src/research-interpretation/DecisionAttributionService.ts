import type {
  ResearchDecisionAttribution,
  ResearchInterpretationBlockerCategory,
  ResearchInterpretationCandidate,
} from "./ResearchInterpretationTypes.js";

const BLOCKER_PRIORITY: readonly ResearchInterpretationBlockerCategory[] = [
  "RISK_NOT_PASS",
  "MISSING_QUOTE",
  "MISSING_AUTHORITY_EVIDENCE",
  "MISSING_PRICE_IMPACT",
  "PRICE_IMPACT_TOO_HIGH",
  "LOW_LIQUIDITY",
  "LOW_VOLUME",
  "PAIR_TOO_NEW",
  "DUPLICATE_BUY",
  "MAX_BUY_CAP",
  "SCORE_BELOW_BUY",
  "SCORE_BELOW_WATCH",
  "SCORE_THRESHOLD_ONLY",
  "UNRESOLVED_STRATEGY_GATE",
  "UNKNOWN",
];

export class DecisionAttributionService {
  explain(input: {
    readonly candidate: ResearchInterpretationCandidate;
    readonly buyScoreThreshold?: number;
    readonly watchScoreThreshold?: number;
  }): ResearchDecisionAttribution {
    const candidate = input.candidate;
    const blockerCategories = this.classifyBlockers(input);
    const firstBlockingFactor = blockerCategories[0] ?? "UNKNOWN";
    const highestImpactBlockingFactor = highestImpactBlocker(candidate, blockerCategories);
    const positiveFactors = candidate.scoreFactors.filter((factor) => factor.points > 0);
    const neutralOrNegativeFactors = candidate.scoreFactors.filter((factor) => factor.points <= 0);
    const warnings = [
      ...new Set(candidate.scoreFactors.flatMap((factor) => factor.warnings).filter(Boolean)),
    ];

    return {
      decisionId: candidate.decisionId,
      mintAddress: candidate.mintAddress,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      decision: candidate.decision,
      score: candidate.score,
      ...(candidate.riskResult ? { riskResult: candidate.riskResult } : {}),
      positiveFactors,
      neutralOrNegativeFactors,
      warnings,
      blockerCategories,
      firstBlockingFactor,
      highestImpactBlockingFactor,
      explanation: buildExplanation(candidate, firstBlockingFactor, highestImpactBlockingFactor),
    };
  }

  private classifyBlockers(input: {
    readonly candidate: ResearchInterpretationCandidate;
    readonly buyScoreThreshold?: number;
    readonly watchScoreThreshold?: number;
  }): readonly ResearchInterpretationBlockerCategory[] {
    const candidate = input.candidate;
    const categories: ResearchInterpretationBlockerCategory[] = [];

    if (candidate.riskResult && candidate.riskResult !== "PASS") {
      categories.push("RISK_NOT_PASS");
    }

    if (candidate.missingQuote) {
      categories.push("MISSING_QUOTE");
    }

    if (candidate.missingAuthorityEvidence) {
      categories.push("MISSING_AUTHORITY_EVIDENCE");
    }

    if (candidate.missingPriceImpact) {
      categories.push("MISSING_PRICE_IMPACT");
    }

    for (const factor of candidate.scoreFactors.filter((item) => !item.passed)) {
      categories.push(categoryForRuleName(factor.ruleName));
    }

    if (candidate.duplicateBuyBlocked) {
      categories.push("DUPLICATE_BUY");
    }

    if (candidate.maxBuyCapBlocked) {
      categories.push("MAX_BUY_CAP");
    }

    if (candidate.score !== null && candidate.decision === "SKIP") {
      if (input.watchScoreThreshold !== undefined && candidate.score < input.watchScoreThreshold) {
        categories.push("SCORE_BELOW_WATCH");
      } else if (
        input.buyScoreThreshold !== undefined &&
        candidate.score < input.buyScoreThreshold
      ) {
        categories.push("SCORE_BELOW_BUY");
      }
    }

    const uniqueCategories = sortByPriority([...new Set(categories)]);

    if (uniqueCategories.length > 0) {
      return uniqueCategories;
    }

    if (candidate.decision === "SKIP") {
      if (
        candidate.score !== null &&
        ((input.watchScoreThreshold !== undefined && candidate.score < input.watchScoreThreshold) ||
          (input.buyScoreThreshold !== undefined && candidate.score < input.buyScoreThreshold))
      ) {
        return ["SCORE_THRESHOLD_ONLY"];
      }

      return ["UNRESOLVED_STRATEGY_GATE"];
    }

    return ["UNKNOWN"];
  }
}

function categoryForRuleName(ruleName: string): ResearchInterpretationBlockerCategory {
  const normalized = ruleName.toLowerCase();

  if (normalized.includes("risk")) {
    return "RISK_NOT_PASS";
  }

  if (normalized.includes("liquidity")) {
    return "LOW_LIQUIDITY";
  }

  if (normalized.includes("volume")) {
    return "LOW_VOLUME";
  }

  if (normalized.includes("age")) {
    return "PAIR_TOO_NEW";
  }

  if (normalized.includes("price_impact")) {
    return "PRICE_IMPACT_TOO_HIGH";
  }

  if (normalized.includes("duplicate")) {
    return "DUPLICATE_BUY";
  }

  return "UNKNOWN";
}

function highestImpactBlocker(
  candidate: ResearchInterpretationCandidate,
  categories: readonly ResearchInterpretationBlockerCategory[],
): ResearchInterpretationBlockerCategory {
  const failedFactors = candidate.scoreFactors
    .filter((factor) => !factor.passed)
    .sort((left, right) => Math.abs(right.points) - Math.abs(left.points));

  for (const factor of failedFactors) {
    const category = categoryForRuleName(factor.ruleName);

    if (categories.includes(category)) {
      return category;
    }
  }

  return categories[0] ?? "UNKNOWN";
}

function sortByPriority(
  categories: readonly ResearchInterpretationBlockerCategory[],
): readonly ResearchInterpretationBlockerCategory[] {
  return [...categories].sort(
    (left, right) => BLOCKER_PRIORITY.indexOf(left) - BLOCKER_PRIORITY.indexOf(right),
  );
}

function buildExplanation(
  candidate: ResearchInterpretationCandidate,
  primary: ResearchInterpretationBlockerCategory,
  highestImpact: ResearchInterpretationBlockerCategory,
): string {
  const score = candidate.score === null ? "n/a" : candidate.score.toString();
  const symbol = candidate.symbol ? `${candidate.symbol} ` : "";

  return `${symbol}${candidate.decision} score=${score} primary=${primary} highestImpact=${highestImpact}`;
}
