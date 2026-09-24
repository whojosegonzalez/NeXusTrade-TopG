import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import { PaperSellCandidateSelector } from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import {
  PaperSellExecutionService,
  type PaperSellExecutionSummary,
} from "./PaperSellExecutionService.js";
import { PaperSellQuoteService } from "./PaperSellQuoteService.js";

export interface PaperSellRunnerOptions {
  readonly config: PaperSellRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
}

export class PaperSellRunner {
  constructor(private readonly options: PaperSellRunnerOptions) {}

  async run(): Promise<PaperSellExecutionSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<PaperSellExecutionSummary> {
    return new PaperSellExecutionService({
      config: this.options.config,
      repositories: this.options.repositories,
      selector: new PaperSellCandidateSelector(this.options.repositories),
      quoteService: new PaperSellQuoteService(this.options.marketDataService),
    }).execute();
  }
}
