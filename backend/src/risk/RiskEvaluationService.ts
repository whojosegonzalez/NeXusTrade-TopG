import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { Repositories } from "../db/repositories/index.js";
import type { RiskResult } from "../db/schema/index.js";
import type { QuoteBudgetPlannerConfig } from "../providers/config/providerConfig.js";
import { QuoteBudgetPlanner } from "../providers/quotes/index.js";
import { RiskAssessmentWriter } from "./RiskAssessmentWriter.js";
import type { RiskCandidateSelector } from "./RiskCandidateSelector.js";
import type { RiskRuntimeConfig } from "./RiskConfig.js";
import {
  createRiskQuoteBudgetEvidence,
  type RiskEvidenceRefreshService,
} from "./RiskEvidenceRefreshService.js";
import { RiskScoringService } from "./RiskScoringService.js";

export interface RiskEvaluationSummary {
  readonly sessionId: string;
  readonly selectedCount: number;
  readonly evaluatedCount: number;
  readonly writtenCount: number;
  readonly statusUpdatedCount: number;
  readonly passCount: number;
  readonly warnCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly errorCount: number;
  readonly quoteBudgetEnabled: boolean;
  readonly quoteBudgetLimit: number | null;
  readonly quoteBudgetSelectedCount: number;
  readonly quoteBudgetNotSelectedCount: number;
  readonly dryRun: boolean;
}

export interface RiskEvaluationServiceOptions {
  readonly config: RiskRuntimeConfig;
  readonly repositories: Repositories;
  readonly selector: RiskCandidateSelector;
  readonly refreshService: RiskEvidenceRefreshService;
  readonly scoringService?: RiskScoringService;
  readonly writer?: RiskAssessmentWriter;
  readonly quoteBudgetPlannerConfig?: QuoteBudgetPlannerConfig | undefined;
  readonly clock?: () => number;
}

export class RiskEvaluationService {
  private readonly scoringService: RiskScoringService;
  private readonly writer: RiskAssessmentWriter;
  private readonly clock: () => number;

  constructor(private readonly options: RiskEvaluationServiceOptions) {
    this.scoringService = options.scoringService ?? new RiskScoringService();
    this.writer =
      options.writer ??
      new RiskAssessmentWriter({
        riskAssessments: options.repositories.riskAssessments,
        tokenRadar: options.repositories.tokenRadar,
      });
    this.clock = options.clock ?? nowMs;
  }

  async evaluate(): Promise<RiskEvaluationSummary> {
    const startedAtMs = this.clock();
    const selection = this.options.selector.selectCandidates(this.options.config, startedAtMs);
    const counts = createEmptyCounts();
    const quoteBudgetPlan = this.options.quoteBudgetPlannerConfig
      ? new QuoteBudgetPlanner(this.options.quoteBudgetPlannerConfig).plan(
          selection.candidates.map((candidate) => ({
            ...candidate,
            candidateKey: candidate.id,
            priorRiskResult: this.options.repositories.riskAssessments.getLatestRiskAssessment(
              selection.session.id,
              candidate.mintAddress,
            )?.result,
          })),
          startedAtMs,
        )
      : undefined;

    this.writeLog(selection.session.id, "Risk evaluation started.", {
      statuses: this.options.config.statuses,
      sinceHours: this.options.config.sinceHours,
      limit: this.options.config.limit,
      concurrency: this.options.config.concurrency,
      selectedCount: selection.candidates.length,
      dryRun: this.options.config.dryRun,
      discoveredFromMs: selection.discoveredFromMs,
      quoteBudget: quoteBudgetPlan
        ? {
            enabled: quoteBudgetPlan.enabled,
            candidateCount: quoteBudgetPlan.candidateCount,
            selectedCount: quoteBudgetPlan.selectedCount,
            notSelectedCount: quoteBudgetPlan.notSelectedCount,
            limit: quoteBudgetPlan.limit,
          }
        : undefined,
    });

    const outcomes = await runWithConcurrency(
      selection.candidates,
      this.options.config.concurrency,
      async (candidate) => {
        try {
          const checkedAtMs = this.clock();
          const quoteBudgetEntry = quoteBudgetPlan?.entriesByCandidateKey.get(candidate.id);
          const refresh = await this.options.refreshService.refreshCandidate(
            candidate,
            this.options.config,
            quoteBudgetPlan && quoteBudgetEntry
              ? createRiskQuoteBudgetEvidence(quoteBudgetPlan, quoteBudgetEntry)
              : undefined,
          );
          const scoring = this.scoringService.evaluate(refresh.enrichment, checkedAtMs);
          const write = this.writer.write({
            sessionId: selection.session.id,
            candidate,
            checkedAtMs,
            scoring,
            enrichment: refresh.enrichment,
            refreshWarnings: refresh.warnings,
            quoteBudget: refresh.quoteBudget,
            dryRun: this.options.config.dryRun,
          });

          this.writeLog(selection.session.id, "Risk candidate evaluated.", {
            tokenRadarId: candidate.id,
            mintAddress: candidate.mintAddress,
            score: scoring.score,
            result: scoring.result,
            flags: scoring.flags,
            dryRun: this.options.config.dryRun,
            nextStatus: write.nextStatus,
            quoteBudget: refresh.quoteBudget,
          });

          return {
            ok: true as const,
            result: scoring.result,
            wroteAssessment: write.wroteAssessment,
            updatedRadarStatus: write.updatedRadarStatus,
          };
        } catch (error) {
          this.writeLog(
            selection.session.id,
            "Risk candidate evaluation failed.",
            {
              tokenRadarId: candidate.id,
              mintAddress: candidate.mintAddress,
              error: error instanceof Error ? error.message : "Unknown risk evaluation failure.",
            },
            "ERROR",
          );

          return {
            ok: false as const,
          };
        }
      },
    );

    for (const outcome of outcomes) {
      if (!outcome.ok) {
        counts.errorCount += 1;
        continue;
      }

      counts.evaluatedCount += 1;
      counts.writtenCount += outcome.wroteAssessment ? 1 : 0;
      counts.statusUpdatedCount += outcome.updatedRadarStatus ? 1 : 0;
      incrementResultCount(counts, outcome.result);
    }

    const summary: RiskEvaluationSummary = {
      sessionId: selection.session.id,
      selectedCount: selection.candidates.length,
      evaluatedCount: counts.evaluatedCount,
      writtenCount: counts.writtenCount,
      statusUpdatedCount: counts.statusUpdatedCount,
      passCount: counts.passCount,
      warnCount: counts.warnCount,
      failCount: counts.failCount,
      unknownCount: counts.unknownCount,
      errorCount: counts.errorCount,
      quoteBudgetEnabled: quoteBudgetPlan?.enabled ?? false,
      quoteBudgetLimit: quoteBudgetPlan?.limit ?? null,
      quoteBudgetSelectedCount: quoteBudgetPlan?.selectedCount ?? selection.candidates.length,
      quoteBudgetNotSelectedCount: quoteBudgetPlan?.notSelectedCount ?? 0,
      dryRun: this.options.config.dryRun,
    };

    this.writeLog(selection.session.id, "Risk evaluation summary.", summary);

    return summary;
  }

  private writeLog(
    sessionId: string,
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
    this.options.repositories.systemLogs.createLog({
      sessionId,
      level,
      scope: "RISK",
      message,
      contextJson: stringifyJson(context),
    });
  }
}

interface MutableRiskCounts {
  evaluatedCount: number;
  writtenCount: number;
  statusUpdatedCount: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  unknownCount: number;
  errorCount: number;
}

function createEmptyCounts(): MutableRiskCounts {
  return {
    evaluatedCount: 0,
    writtenCount: 0,
    statusUpdatedCount: 0,
    passCount: 0,
    warnCount: 0,
    failCount: 0,
    unknownCount: 0,
    errorCount: 0,
  };
}

function incrementResultCount(counts: MutableRiskCounts, result: RiskResult): void {
  switch (result) {
    case "PASS":
      counts.passCount += 1;
      break;
    case "WARN":
      counts.warnCount += 1;
      break;
    case "FAIL":
      counts.failCount += 1;
      break;
    case "UNKNOWN":
      counts.unknownCount += 1;
      break;
  }
}

async function runWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  worker: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const outputs = new Array<TOutput>(inputs.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const input = inputs[currentIndex];

      if (input !== undefined) {
        outputs[currentIndex] = await worker(input);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => runWorker()),
  );

  return outputs;
}
