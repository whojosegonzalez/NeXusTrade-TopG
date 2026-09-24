import type { Repositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type {
  PaperExecutionCandidate,
  PaperExecutionCandidateSelector,
} from "./PaperExecutionCandidateSelector.js";
import type { PaperExchangeRuntimeConfig } from "./PaperExchangeConfig.js";
import { buildPaperQuote } from "./PaperFillFactory.js";
import { executePaperBuy } from "./PaperBuyAccounting.js";

export interface PaperExecutionSummary {
  readonly diagnosticFailureCount: number;
  readonly replayedCount: number;
  readonly sessionId: string;
  readonly selectedCount: number;
  readonly evaluatedCount: number;
  readonly executedCount: number;
  readonly rejectedCount: number;
  readonly failedCount: number;
  readonly orderCreatedCount: number;
  readonly fillCreatedCount: number;
  readonly openedPositionCount: number;
  readonly cashUpdatedCount: number;
  readonly radarStatusUpdatedCount: number;
  readonly duplicatePositionRejectedCount: number;
  readonly insufficientCashRejectedCount: number;
  readonly missingPriceRejectedCount: number;
  readonly missingRiskAssessmentCount: number;
  readonly dryRun: boolean;
}

export interface PaperExecutionServiceOptions {
  readonly config: PaperExchangeRuntimeConfig;
  readonly repositories: Repositories;
  readonly selector: PaperExecutionCandidateSelector;
  readonly clock?: () => number;
}

interface MutablePaperExecutionCounts {
  evaluatedCount: number;
  executedCount: number;
  rejectedCount: number;
  failedCount: number;
  orderCreatedCount: number;
  fillCreatedCount: number;
  openedPositionCount: number;
  cashUpdatedCount: number;
  radarStatusUpdatedCount: number;
  duplicatePositionRejectedCount: number;
  insufficientCashRejectedCount: number;
  missingPriceRejectedCount: number;
}

export class PaperExecutionService {
  private readonly clock: () => number;
  private diagnosticFailureCount = 0;

  constructor(private readonly options: PaperExecutionServiceOptions) {
    this.clock = options.clock ?? nowMs;
  }

  async execute(): Promise<PaperExecutionSummary> {
    const selection = this.options.selector.selectCandidates(this.options.config);
    const counts = createEmptyCounts();
    let replayedCount = 0;
    this.diagnosticFailureCount = 0;
    let availableCashLamports = selection.session.currentCashLamports;

    this.writeLog(selection.session.id, "Paper execution started.", {
      selectedCount: selection.candidates.length,
      missingRiskAssessmentCount: selection.missingRiskAssessmentCount,
      buySolLamports: this.options.config.buySolLamports,
      limit: this.options.config.limit,
      baseFeeLamports: this.options.config.baseFeeLamports,
      priorityFeeLamports: this.options.config.priorityFeeLamports,
      slippageBps: this.options.config.slippageBps,
      dryRun: this.options.config.dryRun,
    });

    for (const candidate of selection.candidates) {
      try {
        const result = this.executeCandidate(candidate, availableCashLamports);
        replayedCount += result.replayed ? 1 : 0;

        counts.evaluatedCount += 1;
        counts.executedCount += result.executed ? 1 : 0;
        counts.rejectedCount += result.rejected ? 1 : 0;
        counts.orderCreatedCount += result.orderCreated ? 1 : 0;
        counts.fillCreatedCount += result.fillCreated ? 1 : 0;
        counts.openedPositionCount += result.openedPosition ? 1 : 0;
        counts.cashUpdatedCount += result.cashUpdated ? 1 : 0;
        counts.radarStatusUpdatedCount += result.radarStatusUpdated ? 1 : 0;
        counts.duplicatePositionRejectedCount +=
          result.rejectionReason === "OPEN_POSITION_EXISTS" ? 1 : 0;
        counts.insufficientCashRejectedCount +=
          result.rejectionReason === "INSUFFICIENT_CASH" ? 1 : 0;
        counts.missingPriceRejectedCount += result.rejectionReason === "MISSING_PRICE_SOL" ? 1 : 0;

        if (result.executed) {
          availableCashLamports -= result.totalCostLamports;
        }
      } catch (error) {
        counts.evaluatedCount += 1;
        counts.failedCount += 1;
        this.writeLog(
          selection.session.id,
          "Paper execution candidate failed.",
          {
            tokenRadarId: candidate.tokenRadar.id,
            mintAddress: candidate.tokenRadar.mintAddress,
            error: error instanceof Error ? error.message : "Unknown paper execution failure.",
          },
          "ERROR",
        );
      }
    }

    const summary: PaperExecutionSummary = {
      diagnosticFailureCount: this.diagnosticFailureCount,
      replayedCount,
      sessionId: selection.session.id,
      selectedCount: selection.candidates.length,
      evaluatedCount: counts.evaluatedCount,
      executedCount: counts.executedCount,
      rejectedCount: counts.rejectedCount,
      failedCount: counts.failedCount,
      orderCreatedCount: counts.orderCreatedCount,
      fillCreatedCount: counts.fillCreatedCount,
      openedPositionCount: counts.openedPositionCount,
      cashUpdatedCount: counts.cashUpdatedCount,
      radarStatusUpdatedCount: counts.radarStatusUpdatedCount,
      duplicatePositionRejectedCount: counts.duplicatePositionRejectedCount,
      insufficientCashRejectedCount: counts.insufficientCashRejectedCount,
      missingPriceRejectedCount: counts.missingPriceRejectedCount,
      missingRiskAssessmentCount: selection.missingRiskAssessmentCount,
      dryRun: this.options.config.dryRun,
    };

    this.writeLog(selection.session.id, "Paper execution summary.", summary);

    return { ...summary, diagnosticFailureCount: this.diagnosticFailureCount };
  }

  private executeCandidate(
    candidate: PaperExecutionCandidate,
    availableCashLamports: number,
  ): {
    readonly executed: boolean;
    readonly rejected: boolean;
    readonly orderCreated: boolean;
    readonly fillCreated: boolean;
    readonly openedPosition: boolean;
    readonly cashUpdated: boolean;
    readonly radarStatusUpdated: boolean;
    readonly totalCostLamports: number;
    readonly rejectionReason?: string;
    readonly replayed?: boolean;
  } {
    if (!this.options.config.dryRun) {
      const { result, replayed } = executePaperBuy({
        repositories: this.options.repositories,
        candidate,
        config: this.options.config,
        clock: this.clock,
      });
      this.writeLog(
        candidate.tokenRadar.sessionId,
        replayed ? "Paper BUY result replayed." : "Paper BUY result.",
        { result, replayed },
      );
      const committed = result.state === "COMMITTED";
      return {
        replayed,
        executed: committed && !replayed,
        rejected: !committed && !replayed,
        orderCreated: !replayed,
        fillCreated: committed && !replayed,
        openedPosition: committed && !replayed,
        cashUpdated: committed && !replayed,
        radarStatusUpdated: committed && !replayed,
        totalCostLamports: committed && !replayed ? -result.cashDeltaLamports : 0,
        ...(!committed ? { rejectionReason: result.code } : {}),
      };
    }
    const quote = buildPaperQuote({ candidate, config: this.options.config });
    let reason: PaperRejectionReason | undefined;
    if (!quote) reason = "MISSING_PRICE_SOL";
    else if (
      this.options.repositories.positions.getBlockingPositionByMint(
        candidate.tokenRadar.sessionId,
        candidate.tokenRadar.mintAddress,
      )
    )
      reason = "OPEN_POSITION_EXISTS";
    else if (availableCashLamports < quote.totalCostLamports) reason = "INSUFFICIENT_CASH";
    if (reason || !quote) {
      this.writeLog(
        candidate.tokenRadar.sessionId,
        "Paper execution dry-run candidate rejected.",
        { reason },
        "WARN",
      );
      return rejectedResult(reason ?? "MISSING_PRICE_SOL", false);
    }
    this.writeLog(candidate.tokenRadar.sessionId, "Paper execution dry-run candidate accepted.", {
      totalCostLamports: quote.totalCostLamports,
    });
    return {
      executed: true,
      rejected: false,
      orderCreated: false,
      fillCreated: false,
      openedPosition: false,
      cashUpdated: false,
      radarStatusUpdated: false,
      totalCostLamports: quote.totalCostLamports,
    };
  }

  private writeLog(
    sessionId: string,
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
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

type PaperRejectionReason = "INSUFFICIENT_CASH" | "OPEN_POSITION_EXISTS" | "MISSING_PRICE_SOL";

function createEmptyCounts(): MutablePaperExecutionCounts {
  return {
    evaluatedCount: 0,
    executedCount: 0,
    rejectedCount: 0,
    failedCount: 0,
    orderCreatedCount: 0,
    fillCreatedCount: 0,
    openedPositionCount: 0,
    cashUpdatedCount: 0,
    radarStatusUpdatedCount: 0,
    duplicatePositionRejectedCount: 0,
    insufficientCashRejectedCount: 0,
    missingPriceRejectedCount: 0,
  };
}

function rejectedResult(
  reason: PaperRejectionReason,
  orderCreated: boolean,
): {
  readonly executed: false;
  readonly rejected: true;
  readonly orderCreated: boolean;
  readonly fillCreated: false;
  readonly openedPosition: false;
  readonly cashUpdated: false;
  readonly radarStatusUpdated: false;
  readonly totalCostLamports: 0;
  readonly rejectionReason: PaperRejectionReason;
} {
  return {
    executed: false,
    rejected: true,
    orderCreated,
    fillCreated: false,
    openedPosition: false,
    cashUpdated: false,
    radarStatusUpdated: false,
    totalCostLamports: 0,
    rejectionReason: reason,
  };
}
