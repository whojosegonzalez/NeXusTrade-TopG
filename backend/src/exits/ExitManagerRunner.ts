import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { ExitManagerRuntimeConfig } from "./ExitManagerConfig.js";
import { ExitManagerService, type ExitManagerSummary } from "./ExitManagerService.js";

export interface ExitManagerRunnerOptions {
  readonly config: ExitManagerRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
}

export class ExitManagerRunner {
  constructor(private readonly options: ExitManagerRunnerOptions) {}

  async run(): Promise<ExitManagerSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<ExitManagerSummary> {
    return new ExitManagerService(this.options).execute();
  }
}
