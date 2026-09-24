import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import { SessionCandidateSelector } from "./SessionCandidateSelector.js";
import type { SessionManagerRuntimeConfig } from "./SessionManagerConfig.js";
import { SessionManagerService, type SessionManagerSummary } from "./SessionManagerService.js";
import { PositionValuationService } from "./PositionValuationService.js";

export interface SessionManagerRunnerOptions {
  readonly config: SessionManagerRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
}

export class SessionManagerRunner {
  constructor(private readonly options: SessionManagerRunnerOptions) {}

  async run(): Promise<SessionManagerSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<SessionManagerSummary> {
    return new SessionManagerService({
      config: this.options.config,
      repositories: this.options.repositories,
      selector: new SessionCandidateSelector(this.options.repositories),
      valuationService: new PositionValuationService(this.options.marketDataService),
    }).runOnce();
  }
}
