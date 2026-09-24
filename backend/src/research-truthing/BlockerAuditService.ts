import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import { STRATEGY_DEFAULTS } from "../strategy/StrategyConfig.js";
import type {
  ResearchTruthingBlockerAudit,
  ResearchTruthingBlockerAuditRow,
  ResearchTruthingStrategyThresholds,
} from "./ResearchTruthingTypes.js";

const DEFAULT_THRESHOLDS: ResearchTruthingStrategyThresholds = {
  watchScoreThreshold: STRATEGY_DEFAULTS.watchScoreThreshold,
  buyScoreThreshold: STRATEGY_DEFAULTS.buyScoreThreshold,
  source: "CURRENT_DEFAULT",
};

export class BlockerAuditService {
  summarize(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly limit: number;
    readonly thresholdsByRun?: ReadonlyMap<string, ResearchTruthingStrategyThresholds>;
  }): ResearchTruthingBlockerAudit {
    const skipWithNoBlockers = input.candidates.filter(
      (candidate) => candidate.decision === "SKIP" && candidate.blockingFactors.length === 0,
    );
    const classifiedRows = skipWithNoBlockers.map((candidate) =>
      classifyNoBlockerSkip(
        candidate,
        input.thresholdsByRun?.get(candidate.runLabel) ?? DEFAULT_THRESHOLDS,
      ),
    );
    const examples = [...classifiedRows]
      .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
      .slice(0, input.limit);

    return {
      skipWithNoBlockers: skipWithNoBlockers.length,
      scoreThresholdOnly: classifiedRows.filter(
        (row) => row.classification === "SCORE_THRESHOLD_ONLY",
      ).length,
      unresolvedStrategyGate: classifiedRows.filter(
        (row) => row.classification === "UNRESOLVED_STRATEGY_GATE",
      ).length,
      insufficientArchiveEvidence: classifiedRows.filter(
        (row) => row.classification === "INSUFFICIENT_ARCHIVE_EVIDENCE",
      ).length,
      highScoringSkips: input.candidates.filter(
        (candidate) => candidate.decision === "SKIP" && (candidate.score ?? -1) >= 65,
      ).length,
      riskPassSkips: input.candidates.filter(
        (candidate) => candidate.decision === "SKIP" && candidate.riskResult === "PASS",
      ).length,
      quoteAvailableImpactMissing: input.candidates.filter(
        (candidate) => !candidate.missingQuote && candidate.missingPriceImpact,
      ).length,
      thresholdSourceCounts: countThresholdSources(classifiedRows),
      examples,
    };
  }
}

function classifyNoBlockerSkip(
  candidate: ResearchInterpretationCandidate,
  thresholds: ResearchTruthingStrategyThresholds,
): ResearchTruthingBlockerAuditRow {
  const score = candidate.score;
  const hasAttribution = candidate.scoreFactors.length > 0;
  const classification =
    !hasAttribution || score === null
      ? "INSUFFICIENT_ARCHIVE_EVIDENCE"
      : score < thresholds.watchScoreThreshold
        ? "SCORE_THRESHOLD_ONLY"
        : "UNRESOLVED_STRATEGY_GATE";

  return {
    runLabel: candidate.runLabel,
    decisionId: candidate.decisionId,
    mintAddress: candidate.mintAddress,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    decision: candidate.decision,
    score: candidate.score,
    watchScoreThreshold: thresholds.watchScoreThreshold,
    buyScoreThreshold: thresholds.buyScoreThreshold,
    thresholdSource: thresholds.source,
    classification,
    reason: explainClassification(classification, score, thresholds),
  };
}

function explainClassification(
  classification: ResearchTruthingBlockerAuditRow["classification"],
  score: number | null,
  thresholds: ResearchTruthingStrategyThresholds,
): string {
  if (classification === "SCORE_THRESHOLD_ONLY") {
    return `Score ${score ?? "n/a"} was below WATCH ${thresholds.watchScoreThreshold} / BUY ${thresholds.buyScoreThreshold} gates (${thresholds.source}).`;
  }

  if (classification === "UNRESOLVED_STRATEGY_GATE") {
    return `Score ${score ?? "n/a"} was not enough to explain SKIP without blockers; inspect strategy snapshot in Phase 9.4A.2 or later counterfactual work.`;
  }

  return "Archived strategy snapshot did not contain enough attribution to classify the skip reason.";
}

function countThresholdSources(
  rows: readonly ResearchTruthingBlockerAuditRow[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[row.thresholdSource] = (counts[row.thresholdSource] ?? 0) + 1;
  }

  return counts;
}
