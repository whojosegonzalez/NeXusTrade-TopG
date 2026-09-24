import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import { defaultWatchlistReturnConfig } from "../watchlist/WatchlistReturnConfig.js";
import { WatchlistReturnRunner } from "../watchlist/WatchlistReturnRunner.js";
import { FastShadowCandidateSelector } from "./FastShadowCandidateSelector.js";
import {
  FAST_SHADOW_HORIZONS,
  FAST_SHADOW_MAX_LATE_MINUTES,
  fastShadowProfile,
  type FastShadowObservationSummary,
  type FastShadowRuntimeConfig,
} from "./FastShadowTypes.js";

export interface FastShadowObservationRunnerOptions {
  readonly config: FastShadowRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly clock?: () => number;
}

export class FastShadowObservationRunner {
  constructor(private readonly options: FastShadowObservationRunnerOptions) {}

  async runOnce(): Promise<FastShadowObservationSummary> {
    const session = this.options.repositories.sessions.getSessionById(
      this.options.config.sessionId,
    );
    if (!session || session.mode !== "PAPER" || session.status !== "RUNNING") {
      throw new Error("Fast shadow observation requires an existing PAPER RUNNING session.");
    }
    const selection = new FastShadowCandidateSelector().select(
      this.options.repositories.strategyDecisions.listStrategyDecisions(session.id, {
        limit: 1_000,
      }),
    );
    const watchlist =
      selection.selectedDecisionIds.length === 0
        ? {
            alreadyScheduledCount: 0,
            scheduledCount: 0,
            dueCount: 0,
            observedCount: 0,
            missedCount: 0,
            failedCount: 0,
            dryRun: this.options.config.dryRun,
          }
        : await new WatchlistReturnRunner({
            config: {
              ...defaultWatchlistReturnConfig(),
              once: true,
              dryRun: this.options.config.dryRun,
              json: this.options.config.json,
              sessionId: session.id,
              limit: 100,
              horizonsMinutes: FAST_SHADOW_HORIZONS,
              maxLateMinutes: FAST_SHADOW_MAX_LATE_MINUTES,
            },
            repositories: this.options.repositories,
            marketDataService: this.options.marketDataService,
            strategyDecisionIds: selection.selectedDecisionIds,
            ...(this.options.clock ? { clock: this.options.clock } : {}),
          }).runOnce();

    return {
      sessionId: session.id,
      profileKey: fastShadowProfile.key,
      eligibleCount:
        selection.classificationCounts.SELECTED +
        selection.classificationCounts.DUPLICATE_MINT_SUPPRESSED +
        selection.classificationCounts.SESSION_CAP_SUPPRESSED,
      selectedCount: selection.selected.length,
      capSuppressedCount: selection.classificationCounts.SESSION_CAP_SUPPRESSED,
      duplicateMintSuppressedCount: selection.classificationCounts.DUPLICATE_MINT_SUPPRESSED,
      alreadyScheduledCount: watchlist.alreadyScheduledCount,
      scheduledCount: watchlist.scheduledCount,
      dueCount: watchlist.dueCount,
      observedCount: watchlist.observedCount,
      missedCount: watchlist.missedCount,
      failedCount: watchlist.failedCount,
      dryRun: watchlist.dryRun,
      classificationCounts: selection.classificationCounts,
    };
  }
}
