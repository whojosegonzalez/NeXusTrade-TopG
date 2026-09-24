import type {
  ResearchDecisionAttribution,
  ResearchOpportunityRow,
  ResearchTokenSummary,
  ResearchInterpretationCandidate,
} from "./ResearchInterpretationTypes.js";

export class OpportunityAnalysisService {
  highScoringSkips(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly attributions: readonly ResearchDecisionAttribution[];
    readonly minScore: number;
    readonly limit: number;
  }): readonly ResearchOpportunityRow[] {
    const attributionsByDecisionId = attributionMap(input.attributions);

    return input.candidates
      .filter((candidate) => candidate.decision === "SKIP")
      .filter((candidate) => (candidate.score ?? -1) >= input.minScore)
      .map((candidate) => toOpportunityRow(candidate, attributionsByDecisionId))
      .sort(
        (left, right) =>
          (right.bestReturnPct ?? Number.NEGATIVE_INFINITY) -
            (left.bestReturnPct ?? Number.NEGATIVE_INFINITY) ||
          (right.score ?? -1) - (left.score ?? -1) ||
          left.mintAddress.localeCompare(right.mintAddress),
      )
      .slice(0, input.limit);
  }

  tokenSummaries(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly attributions: readonly ResearchDecisionAttribution[];
    readonly limit: number;
  }): readonly ResearchTokenSummary[] {
    const attributionsByDecisionId = attributionMap(input.attributions);
    const byMint = new Map<string, ResearchInterpretationCandidate[]>();

    for (const candidate of input.candidates) {
      byMint.set(candidate.mintAddress, [...(byMint.get(candidate.mintAddress) ?? []), candidate]);
    }

    return [...byMint.entries()]
      .map(([mintAddress, candidates]) => {
        const sortedByTime = [...candidates].sort(
          (left, right) => left.decidedAtMs - right.decidedAtMs,
        );
        const first = sortedByTime[0] as ResearchInterpretationCandidate;
        const latest = sortedByTime[sortedByTime.length - 1] as ResearchInterpretationCandidate;
        const highestScore = candidates.reduce<number | null>(
          (highest, candidate) =>
            candidate.score === null
              ? highest
              : Math.max(highest ?? candidate.score, candidate.score),
          null,
        );
        const primaryBlockersSeen = [
          ...new Set(
            candidates
              .map(
                (candidate) =>
                  attributionsByDecisionId.get(candidate.decisionId)?.firstBlockingFactor,
              )
              .filter((value): value is NonNullable<typeof value> => value !== undefined),
          ),
        ];

        return {
          mintAddress,
          ...(first.symbol ? { symbol: first.symbol } : {}),
          decisionCount: candidates.length,
          runs: [...new Set(candidates.map((candidate) => candidate.runLabel))].sort(),
          firstDecision: first.decision,
          latestDecision: latest.decision,
          highestScore,
          ...optionalBest(candidates),
          ...optionalWorst(candidates),
          repeatedAttentionStrength: strongestRepeatedAttention(candidates),
          primaryBlockersSeen,
        };
      })
      .sort(
        (left, right) =>
          (right.bestReturnPct ?? Number.NEGATIVE_INFINITY) -
            (left.bestReturnPct ?? Number.NEGATIVE_INFINITY) ||
          right.decisionCount - left.decisionCount ||
          left.mintAddress.localeCompare(right.mintAddress),
      )
      .slice(0, input.limit);
  }
}

function toOpportunityRow(
  candidate: ResearchInterpretationCandidate,
  attributionsByDecisionId: ReadonlyMap<string, ResearchDecisionAttribution>,
): ResearchOpportunityRow {
  const attribution = attributionsByDecisionId.get(candidate.decisionId);

  return {
    runLabel: candidate.runLabel,
    decisionId: candidate.decisionId,
    mintAddress: candidate.mintAddress,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    decision: candidate.decision,
    score: candidate.score,
    decidedAtMs: candidate.decidedAtMs,
    primaryBlocker: attribution?.firstBlockingFactor ?? "UNKNOWN",
    highestImpactBlocker: attribution?.highestImpactBlockingFactor ?? "UNKNOWN",
    ...(candidate.bestReturnPct !== undefined ? { bestReturnPct: candidate.bestReturnPct } : {}),
    ...(candidate.worstReturnPct !== undefined ? { worstReturnPct: candidate.worstReturnPct } : {}),
    ...(candidate.riskResult ? { riskResult: candidate.riskResult } : {}),
    missingQuote: candidate.missingQuote,
    repeatedAttentionStrength: candidate.repeatedAttentionStrength,
    ...(candidate.liquidityUsd !== undefined ? { liquidityUsd: candidate.liquidityUsd } : {}),
    ...(candidate.volume1hUsd !== undefined ? { volume1hUsd: candidate.volume1hUsd } : {}),
    ...(candidate.ageSeconds !== undefined ? { ageSeconds: candidate.ageSeconds } : {}),
  };
}

function attributionMap(
  attributions: readonly ResearchDecisionAttribution[],
): ReadonlyMap<string, ResearchDecisionAttribution> {
  return new Map(attributions.map((attribution) => [attribution.decisionId, attribution]));
}

function optionalBest(candidates: readonly ResearchInterpretationCandidate[]): {
  readonly bestReturnPct?: number;
} {
  const values = candidates
    .map((candidate) => candidate.bestReturnPct)
    .filter((value): value is number => value !== undefined);

  return values.length > 0 ? { bestReturnPct: Math.max(...values) } : {};
}

function optionalWorst(candidates: readonly ResearchInterpretationCandidate[]): {
  readonly worstReturnPct?: number;
} {
  const values = candidates
    .map((candidate) => candidate.worstReturnPct)
    .filter((value): value is number => value !== undefined);

  return values.length > 0 ? { worstReturnPct: Math.min(...values) } : {};
}

function strongestRepeatedAttention(
  candidates: readonly ResearchInterpretationCandidate[],
): ResearchInterpretationCandidate["repeatedAttentionStrength"] {
  const rank = {
    NONE: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
  } as const;

  return candidates.reduce<ResearchInterpretationCandidate["repeatedAttentionStrength"]>(
    (best, candidate) =>
      rank[candidate.repeatedAttentionStrength] > rank[best]
        ? candidate.repeatedAttentionStrength
        : best,
    "NONE",
  );
}
