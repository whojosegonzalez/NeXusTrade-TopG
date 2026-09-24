import type { Repositories } from "../db/repositories/index.js";
import { PaperExecutionCandidateSelector } from "./PaperExecutionCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";
import { PaperExecutionService, type PaperExecutionSummary } from "./PaperExecutionService.js";

export interface PaperRunnerOptions {
  readonly config: PaperExchangeRuntimeConfig;
  readonly repositories: Repositories;
}

export class PaperRunner {
  constructor(private readonly options: PaperRunnerOptions) {}

  async run(): Promise<PaperExecutionSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<PaperExecutionSummary> {
    return new PaperExecutionService({
      config: this.options.config,
      repositories: this.options.repositories,
      selector: new PaperExecutionCandidateSelector(this.options.repositories),
    }).execute();
  }
}
