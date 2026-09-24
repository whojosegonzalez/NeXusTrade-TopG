import type {
  ResearchBlockerSummary,
  ResearchDecisionAttribution,
  ResearchInterpretationBlockerCategory,
  ResearchInterpretationCandidate,
} from "./ResearchInterpretationTypes.js";
import { countByDecision, summarizeCandidateGroup } from "./ResearchInterpretationStats.js";

export class BlockerAnalysisService {
  summarize(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly attributions: readonly ResearchDecisionAttribution[];
    readonly targetPcts: readonly number[];
    readonly stopPcts: readonly number[];
    readonly limit: number;
  }): readonly ResearchBlockerSummary[] {
    const candidatesByDecisionId = new Map(
      input.candidates.map((candidate) => [candidate.decisionId, candidate] as const),
    );
    const groups = new Map<
      ResearchInterpretationBlockerCategory,
      ResearchInterpretationCandidate[]
    >();

    for (const attribution of input.attributions) {
      const candidate = candidatesByDecisionId.get(attribution.decisionId);

      if (!candidate) {
        continue;
      }

      const blocker = attribution.firstBlockingFactor;
      groups.set(blocker, [...(groups.get(blocker) ?? []), candidate]);
    }

    return [...groups.entries()]
      .map(([blocker, candidates]) => {
        const summary = summarizeCandidateGroup(
          blocker,
          candidates,
          input.targetPcts,
          input.stopPcts,
        );

        return {
          ...summary,
          blocker,
          decisionCounts: countByDecision(candidates),
        };
      })
      .sort(
        (left, right) =>
          right.count - left.count ||
          (right.averageBestReturnPct ?? Number.NEGATIVE_INFINITY) -
            (left.averageBestReturnPct ?? Number.NEGATIVE_INFINITY) ||
          left.blocker.localeCompare(right.blocker),
      )
      .slice(0, input.limit);
  }
}
