import type { Repositories } from "../db/repositories/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { QuoteBudgetPlannerConfig } from "../providers/config/providerConfig.js";
import { RiskCandidateSelector } from "./RiskCandidateSelector.js";
import type { RiskRuntimeConfig } from "./RiskConfig.js";
import { RiskEvaluationService, type RiskEvaluationSummary } from "./RiskEvaluationService.js";
import { RiskEvidenceRefreshService } from "./RiskEvidenceRefreshService.js";

export interface RiskRunnerOptions {
  readonly config: RiskRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly quoteBudgetPlannerConfig?: QuoteBudgetPlannerConfig | undefined;
}

export class RiskRunner {
  constructor(private readonly options: RiskRunnerOptions) {}

  async run(): Promise<RiskEvaluationSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<RiskEvaluationSummary> {
    return new RiskEvaluationService({
      config: this.options.config,
      repositories: this.options.repositories,
      selector: new RiskCandidateSelector(this.options.repositories),
      refreshService: new RiskEvidenceRefreshService(this.options.marketDataService),
      ...(this.options.quoteBudgetPlannerConfig
        ? { quoteBudgetPlannerConfig: this.options.quoteBudgetPlannerConfig }
        : {}),
    }).evaluate();
  }
}
