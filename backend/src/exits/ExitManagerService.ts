import type { Repositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import { PaperSellCandidateSelector } from "../paper/PaperSellCandidateSelector.js";
import {
  PaperSellExecutionService,
  type PaperSellExecutionSummary,
} from "../paper/PaperSellExecutionService.js";
import { PaperSellQuoteService } from "../paper/PaperSellQuoteService.js";
import { buildPaperSellConfigForExit, type ExitManagerRuntimeConfig } from "./ExitManagerConfig.js";
import { ExitCandidateSelector } from "./ExitCandidateSelector.js";
import { ExitTriggerService, type ExitTriggerEvaluation } from "./ExitTriggerService.js";
import { ExitActionService, type ResolvedExitAction } from "./ExitActionService.js";
import { ExitCompletionService, type ExitCompletionResult } from "./ExitCompletionService.js";
import { DynamicRatchetService } from "./DynamicRatchetService.js";

export interface ExitManagerSummary {
  readonly diagnosticFailureCount?: number;
  readonly sessionId: string;
  readonly terminationReason: string;
  readonly trigger: string;
  readonly action: "observe" | "sell-all";
  readonly actionReason?: string;
  readonly positionsOpenBefore: number;
  readonly positionsOpenAfter: number;
  readonly positionsSelected: number;
  readonly positionsClosed: number;
  readonly sellRejected: number;
  readonly sellFailures: number;
  readonly orderCreatedCount: number;
  readonly fillCreatedCount: number;
  readonly cashUpdatedCount: number;
  readonly radarStatusUpdatedCount: number;
  readonly totalNetProceedsLamports: number;
  readonly totalRealizedPnlLamports: number;
  readonly sessionCompleted: boolean;
  readonly completionSkippedReason?: string;
  readonly dryRun: boolean;
}

export interface ExitManagerServiceOptions {
  readonly config: ExitManagerRuntimeConfig;
  readonly repositories: Repositories;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly candidateSelector?: ExitCandidateSelector;
  readonly triggerService?: ExitTriggerService;
  readonly actionService?: ExitActionService;
  readonly completionService?: ExitCompletionService;
  readonly dynamicRatchetService?: DynamicRatchetService;
}

export class ExitManagerService {
  private diagnosticFailureCount = 0;
  private readonly candidateSelector: ExitCandidateSelector;
  private readonly triggerService: ExitTriggerService;
  private readonly actionService: ExitActionService;
  private readonly completionService: ExitCompletionService;
  private readonly dynamicRatchetService: DynamicRatchetService;

  constructor(private readonly options: ExitManagerServiceOptions) {
    this.candidateSelector =
      options.candidateSelector ?? new ExitCandidateSelector(options.repositories);
    this.triggerService = options.triggerService ?? new ExitTriggerService();
    this.actionService = options.actionService ?? new ExitActionService();
    this.completionService =
      options.completionService ?? new ExitCompletionService(options.repositories);
    this.dynamicRatchetService = options.dynamicRatchetService ?? new DynamicRatchetService();
  }

  async execute(): Promise<ExitManagerSummary> {
    this.diagnosticFailureCount = 0;
    let sessionIdForFailure: string | undefined;

    try {
      const selection = this.candidateSelector.selectSession(this.options.config);
      sessionIdForFailure = selection.session.id;
      const triggerEvaluation = this.triggerService.evaluate(selection.session);
      const action = this.actionService.resolve(triggerEvaluation, this.options.config);

      this.writeLog(selection.session.id, "ExitManager started.", {
        phase: "PHASE_8_5_EXIT_MANAGER",
        dryRun: this.options.config.dryRun,
        targetAction: this.options.config.targetAction,
        drawdownAction: this.options.config.drawdownAction,
        completeSessionOnExit: this.options.config.completeSessionOnExit,
      });

      this.writeLog(selection.session.id, "ExitManager trigger evaluated.", {
        phase: "PHASE_8_5_EXIT_MANAGER",
        terminationReason: selection.session.terminationReason,
        triggerEvaluation,
        action,
        openPositionCount: selection.openPositionCount,
      });

      const sellSummary = await this.runSellAllIfNeeded({
        sessionId: selection.session.id,
        triggerEvaluation,
        action,
        openPositionCount: selection.openPositionCount,
      });
      const completion = this.completionService.completeAfterExit({
        sessionId: selection.session.id,
        config: this.options.config,
        action,
        ...(sellSummary ? { sellSummary } : {}),
      });
      const openPositionCountAfter = this.options.repositories.positions.listOpenPositions(
        selection.session.id,
      ).length;
      const summary = buildSummary({
        sessionId: selection.session.id,
        terminationReason: selection.session.terminationReason,
        triggerEvaluation,
        action,
        openPositionCountBefore: selection.openPositionCount,
        openPositionCountAfter,
        sellSummary,
        completion,
        dryRun: this.options.config.dryRun,
      });

      this.writeLog(selection.session.id, "ExitManager summary.", summary);

      return {
        ...summary,
        diagnosticFailureCount:
          this.diagnosticFailureCount + (sellSummary?.diagnosticFailureCount ?? 0),
      };
    } catch (error) {
      if (sessionIdForFailure) {
        this.writeLog(
          sessionIdForFailure,
          "ExitManager failed.",
          {
            phase: "PHASE_8_5_EXIT_MANAGER",
            error: error instanceof Error ? error.message : "Unknown ExitManager failure.",
          },
          "ERROR",
        );
      }

      throw error;
    }
  }

  private async runSellAllIfNeeded(input: {
    readonly sessionId: string;
    readonly triggerEvaluation: ExitTriggerEvaluation;
    readonly action: ResolvedExitAction;
    readonly openPositionCount: number;
  }): Promise<PaperSellExecutionSummary | undefined> {
    if (input.action.action !== "sell-all") {
      this.writeLog(input.sessionId, "ExitManager observe-only action selected.", {
        phase: "PHASE_8_5_EXIT_MANAGER",
        action: input.action,
      });
      return undefined;
    }

    if (!input.triggerEvaluation.supported) {
      this.writeLog(input.sessionId, "ExitManager sell-all skipped: unsupported trigger.", {
        phase: "PHASE_8_5_EXIT_MANAGER",
        triggerEvaluation: input.triggerEvaluation,
      });
      return undefined;
    }

    if (input.openPositionCount === 0) {
      this.writeLog(input.sessionId, "ExitManager sell-all skipped: no open positions.", {
        phase: "PHASE_8_5_EXIT_MANAGER",
        trigger: input.action.trigger,
      });
      return undefined;
    }

    this.writeLog(input.sessionId, "ExitManager sell-all started.", {
      phase: "PHASE_8_5_EXIT_MANAGER",
      trigger: input.action.trigger,
      openPositionCount: input.openPositionCount,
      dryRun: this.options.config.dryRun,
    });

    const service = new PaperSellExecutionService({
      config: buildPaperSellConfigForExit({
        config: this.options.config,
        sessionId: input.sessionId,
        trigger: input.action.trigger,
      }),
      repositories: this.options.repositories,
      selector: new PaperSellCandidateSelector(this.options.repositories),
      quoteService: new PaperSellQuoteService(this.options.marketDataService),
    });
    const summary = await service.execute();

    this.writeLog(input.sessionId, "ExitManager sell-all completed.", {
      phase: "PHASE_8_5_EXIT_MANAGER",
      trigger: input.action.trigger,
      summary,
    });

    return summary;
  }

  private writeLog(
    sessionId: string,
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
    if (this.options.config.dryRun) {
      return;
    }

    try {
      this.options.repositories.systemLogs.createLog({
        sessionId,
        level,
        scope: "EXECUTION",
        message,
        contextJson: stringifyJson(context),
      });
    } catch {
      this.diagnosticFailureCount += 1;
    }
  }
}

function buildSummary(input: {
  readonly sessionId: string;
  readonly terminationReason: string;
  readonly triggerEvaluation: ExitTriggerEvaluation;
  readonly action: ResolvedExitAction;
  readonly openPositionCountBefore: number;
  readonly openPositionCountAfter: number;
  readonly sellSummary: PaperSellExecutionSummary | undefined;
  readonly completion: ExitCompletionResult;
  readonly dryRun: boolean;
}): ExitManagerSummary {
  return {
    sessionId: input.sessionId,
    terminationReason: input.terminationReason,
    trigger: input.triggerEvaluation.supported ? input.triggerEvaluation.trigger : "none",
    action: input.action.action,
    ...(input.action.action === "observe" ? { actionReason: input.action.reason } : {}),
    positionsOpenBefore: input.openPositionCountBefore,
    positionsOpenAfter: input.openPositionCountAfter,
    positionsSelected: input.sellSummary?.selectedCount ?? 0,
    positionsClosed: input.sellSummary?.closedCount ?? 0,
    sellRejected: input.sellSummary?.rejectedCount ?? 0,
    sellFailures: input.sellSummary?.failedCount ?? 0,
    orderCreatedCount: input.sellSummary?.orderCreatedCount ?? 0,
    fillCreatedCount: input.sellSummary?.fillCreatedCount ?? 0,
    cashUpdatedCount: input.sellSummary?.cashUpdatedCount ?? 0,
    radarStatusUpdatedCount: input.sellSummary?.radarStatusUpdatedCount ?? 0,
    totalNetProceedsLamports: input.sellSummary?.totalNetProceedsLamports ?? 0,
    totalRealizedPnlLamports: input.sellSummary?.totalRealizedPnlLamports ?? 0,
    sessionCompleted: input.completion.completed,
    ...(input.completion.skippedReason
      ? { completionSkippedReason: input.completion.skippedReason }
      : {}),
    dryRun: input.dryRun,
  };
}
