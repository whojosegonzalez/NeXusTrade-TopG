import type { Repositories } from "../db/repositories/index.js";
import { StrategyCandidateSelector } from "./StrategyCandidateSelector.js";
import type { StrategyRuntimeConfig } from "./StrategyConfig.js";
import {
  StrategyEvaluationService,
  type StrategyEvaluationSummary,
} from "./StrategyEvaluationService.js";

export interface StrategyRunnerOptions {
  readonly config: StrategyRuntimeConfig;
  readonly repositories: Repositories;
}

export class StrategyRunner {
  constructor(private readonly options: StrategyRunnerOptions) {}

  async run(): Promise<StrategyEvaluationSummary> {
    return this.runOnce();
  }

  async runOnce(): Promise<StrategyEvaluationSummary> {
    return new StrategyEvaluationService({
      config: this.options.config,
      repositories: this.options.repositories,
      selector: new StrategyCandidateSelector(this.options.repositories),
    }).evaluate();
  }
}
