import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { WatchlistReturnRuntimeConfig } from "../watchlist/WatchlistReturnConfig.js";
import {
  WatchlistReturnRunner,
  type WatchlistReturnSummary,
} from "../watchlist/WatchlistReturnRunner.js";
import { resolveShadowSourceDecisions, type ShadowRuntimeConfig } from "./ShadowConfig.js";

export interface ShadowObservationRunnerOptions {
  readonly config: ShadowRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly clock?: () => number;
}

export class ShadowObservationRunner {
  constructor(private readonly options: ShadowObservationRunnerOptions) {}

  async run(): Promise<WatchlistReturnSummary> {
    const runner = new WatchlistReturnRunner({
      config: toWatchlistConfig(this.options.config),
      repositories: this.options.repositories,
      marketDataService: this.options.marketDataService,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    });

    return runner.run();
  }
}

export function toWatchlistConfig(config: ShadowRuntimeConfig): WatchlistReturnRuntimeConfig {
  return {
    once: config.once,
    dryRun: config.dryRun,
    json: config.json,
    sinceHours: config.sinceHours,
    limit: config.limit,
    horizonsMinutes: config.horizonsMinutes,
    sourceDecisions: resolveShadowSourceDecisions(config),
    minScore: config.includeShadowScores ? config.shadowScoreMin : 0,
    maxLateMinutes: config.maxLateMinutes,
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
  };
}
