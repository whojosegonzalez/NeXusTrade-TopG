import type {
  ResearchInterpretationCandidate,
  ResearchMarketWindowSummary,
} from "./ResearchInterpretationTypes.js";
import { average } from "./ResearchInterpretationStats.js";

export class MarketWindowAnalysisService {
  summarize(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly marketWindowMinutes: number;
    readonly limit: number;
  }): readonly ResearchMarketWindowSummary[] {
    const windowMs = input.marketWindowMinutes * 60_000;
    const groups = new Map<string, ResearchInterpretationCandidate[]>();

    for (const candidate of input.candidates) {
      const windowStartMs = Math.floor(candidate.decidedAtMs / windowMs) * windowMs;
      const key = `${candidate.runLabel}:${windowStartMs}`;
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }

    return [...groups.entries()]
      .map(([key, candidates]) => {
        const [runLabel, rawWindowStartMs] = key.split(":");
        const windowStartMs = Number(rawWindowStartMs);
        const bestReturns = candidates
          .map((candidate) => candidate.bestReturnPct)
          .filter((value): value is number => value !== undefined);
        const worstReturns = candidates
          .map((candidate) => candidate.worstReturnPct)
          .filter((value): value is number => value !== undefined);

        return {
          runLabel: runLabel ?? "unknown",
          windowStartMs,
          windowEndMs: windowStartMs + windowMs,
          decisionCount: candidates.length,
          uniqueMints: new Set(candidates.map((candidate) => candidate.mintAddress)).size,
          targetFirstWins: candidates.filter((candidate) =>
            candidate.targetStopOutcomes.some((outcome) => outcome.ordering === "TARGET_FIRST"),
          ).length,
          ...(bestReturns.length > 0 ? { averageBestReturnPct: average(bestReturns) } : {}),
          ...(worstReturns.length > 0 ? { averageWorstReturnPct: average(worstReturns) } : {}),
        };
      })
      .sort(
        (left, right) =>
          right.targetFirstWins - left.targetFirstWins ||
          right.decisionCount - left.decisionCount ||
          left.runLabel.localeCompare(right.runLabel) ||
          left.windowStartMs - right.windowStartMs,
      )
      .slice(0, input.limit);
  }
}
