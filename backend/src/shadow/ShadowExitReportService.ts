import type { Repositories } from "../db/repositories/index.js";
import type { WatchlistReturnObservationRecord } from "../db/schema/index.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { ShadowRuntimeConfig } from "./ShadowConfig.js";
import { ShadowCandidateSelector } from "./ShadowCandidateSelector.js";
import { ShadowExitSimulator } from "./ShadowExitSimulator.js";
import { ShadowPortfolioSimulator } from "./ShadowPortfolioSimulator.js";
import type { ShadowCandidateResult, ShadowExitReport } from "./ShadowTypes.js";

export interface ShadowExitReportServiceOptions {
  readonly config: ShadowRuntimeConfig;
  readonly repositories: Repositories;
  readonly clock?: () => number;
}

export class ShadowExitReportService {
  private readonly clock: () => number;

  constructor(private readonly options: ShadowExitReportServiceOptions) {
    this.clock = options.clock ?? nowMs;
  }

  generate(): ShadowExitReport {
    const selection = new ShadowCandidateSelector({
      config: this.options.config,
      repositories: this.options.repositories,
      clock: this.clock,
    }).select();
    const observationsByDecisionId = this.listObservationsByDecisionId(
      selection.session.id,
      selection.candidates.map((candidate) => candidate.decision.id),
    );
    const simulation = new ShadowExitSimulator().simulate({
      config: this.options.config,
      candidates: selection.candidates,
      observationsByDecisionId,
    });
    const portfolio = new ShadowPortfolioSimulator().simulate({
      config: this.options.config,
      candidates: simulation.candidates,
    });

    return {
      generatedAtMs: this.clock(),
      session: selection.session,
      config: this.options.config,
      selectedCount: selection.candidates.length,
      skippedCount: selection.skippedReasons.length,
      skippedReasons: selection.skippedReasons,
      candidates: simulation.candidates,
      scenarioSummaries: simulation.scenarioSummaries,
      portfolio,
      recommendations: buildRecommendations(simulation.candidates),
    };
  }

  private listObservationsByDecisionId(
    sessionId: string,
    decisionIds: readonly string[],
  ): ReadonlyMap<string, readonly WatchlistReturnObservationRecord[]> {
    const observationsByDecisionId = new Map<string, WatchlistReturnObservationRecord[]>();

    for (const decisionId of decisionIds) {
      observationsByDecisionId.set(
        decisionId,
        this.options.repositories.watchlistReturns.listObservations(sessionId, {
          strategyDecisionId: decisionId,
          limit: 10_000,
        }),
      );
    }

    return observationsByDecisionId;
  }
}

function buildRecommendations(candidates: readonly ShadowCandidateResult[]): readonly string[] {
  const recommendations: string[] = [];
  const buyCandidates = candidates.filter((candidate) => candidate.decision === "BUY");
  const shadowWinners = candidates.filter(
    (candidate) =>
      candidate.decision !== "BUY" && (candidate.bestReturnPct ?? Number.NEGATIVE_INFINITY) >= 10,
  );
  const fastBuyWinners = buyCandidates.filter((candidate) =>
    candidate.observedReturns.some(
      (observed) => observed.horizonMinutes <= 5 && observed.returnPct >= 10,
    ),
  );

  if (fastBuyWinners.length > 0) {
    recommendations.push(
      "At least one BUY candidate reached +10% within 5 minutes; fast target exits are worth simulating.",
    );
  }

  if (shadowWinners.length > 0) {
    recommendations.push(
      "Some non-BUY shadow candidates reached +10%; keep researching score-50/55 inclusion before changing defaults.",
    );
  }

  if (buyCandidates.some((candidate) => (candidate.worstReturnPct ?? 0) <= -10)) {
    recommendations.push(
      "At least one BUY candidate breached -10%; stop-loss simulation should stay in the Phase 8.9 report.",
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "Collect more high-frequency observations before changing score thresholds or paper execution defaults.",
    );
  }

  return recommendations;
}
