import type { Repositories } from "../db/repositories/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type {
  PaperSellCandidate,
  PaperSellCandidateSelector,
} from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import {
  PaperSellAccountingService,
  type PaperSellAccountingResult,
} from "./PaperSellAccountingService.js";
import { executePaperSell } from "./PaperSellAccounting.js";
import type { PaperSellQuoteContext, PaperSellQuoteService } from "./PaperSellQuoteService.js";
import {
  PaperSellValidationService,
  type PaperSellRejectionCode,
  type PaperSellValidationRejection,
} from "./PaperSellValidationService.js";

export interface PaperSellExecutionSummary {
  readonly diagnosticFailureCount?: number;
  readonly replayedCount?: number;
  readonly sessionId: string;
  readonly selectedCount: number;
  readonly evaluatedCount: number;
  readonly quotedCount: number;
  readonly refreshedPriceCount: number;
  readonly cachedFallbackCount: number;
  readonly rejectedCount: number;
  readonly failedCount: number;
  readonly closedCount: number;
  readonly orderCreatedCount: number;
  readonly fillCreatedCount: number;
  readonly cashUpdatedCount: number;
  readonly radarStatusUpdatedCount: number;
  readonly totalGrossProceedsLamports: number;
  readonly totalNetProceedsLamports: number;
  readonly totalRealizedPnlLamports: number;
  readonly totalSellFeesLamports: number;
  readonly totalSlippageLamports: number;
  readonly dryRun: boolean;
}

export interface PaperSellExecutionServiceOptions {
  readonly config: PaperSellRuntimeConfig;
  readonly repositories: Repositories;
  readonly selector: PaperSellCandidateSelector;
  readonly quoteService: PaperSellQuoteService;
  readonly validationService?: PaperSellValidationService;
  readonly accountingService?: PaperSellAccountingService;
  readonly clock?: () => number;
}

interface PaperSellCandidateResult {
  readonly quoted: boolean;
  readonly refreshedPrice: boolean;
  readonly cachedFallback: boolean;
  readonly rejected: boolean;
  readonly failed: boolean;
  readonly closed: boolean;
  readonly orderCreated: boolean;
  readonly fillCreated: boolean;
  readonly cashUpdated: boolean;
  readonly radarStatusUpdated: boolean;
  readonly grossProceedsLamports: number;
  readonly netProceedsLamports: number;
  readonly realizedPnlLamports: number;
  readonly sellFeesLamports: number;
  readonly slippageLamports: number;
  readonly rejectionCode?: string;
  readonly replayed?: boolean;
}

interface MutablePaperSellCounts {
  evaluatedCount: number;
  quotedCount: number;
  refreshedPriceCount: number;
  cachedFallbackCount: number;
  rejectedCount: number;
  failedCount: number;
  closedCount: number;
  orderCreatedCount: number;
  fillCreatedCount: number;
  cashUpdatedCount: number;
  radarStatusUpdatedCount: number;
  totalGrossProceedsLamports: number;
  totalNetProceedsLamports: number;
  totalRealizedPnlLamports: number;
  totalSellFeesLamports: number;
  totalSlippageLamports: number;
}

export class PaperSellExecutionService {
  private readonly validationService: PaperSellValidationService;
  private readonly accountingService: PaperSellAccountingService;
  private readonly clock: () => number;
  private diagnosticFailureCount = 0;

  constructor(private readonly options: PaperSellExecutionServiceOptions) {
    this.validationService = options.validationService ?? new PaperSellValidationService();
    this.accountingService = options.accountingService ?? new PaperSellAccountingService();
    this.clock = options.clock ?? nowMs;
  }

  async execute(): Promise<PaperSellExecutionSummary> {
    const selection = this.options.selector.selectCandidates(this.options.config);
    const counts = createEmptyCounts();
    let replayedCount = 0;
    this.diagnosticFailureCount = 0;
    let currentCashLamports = selection.session.currentCashLamports;
    let realizedPnlLamports = selection.session.realizedPnlLamports;

    this.writeLog(selection.session.id, "Paper sell execution started.", {
      selectedCount: selection.candidates.length,
      triggerType: selection.triggerType,
      limit: this.options.config.limit,
      slippageBps: this.options.config.slippageBps,
      baseFeeLamports: this.options.config.baseFeeLamports,
      priorityFeeLamports: this.options.config.priorityFeeLamports,
      allowCachedRadarPrice: this.options.config.allowCachedRadarPrice,
      dryRun: this.options.config.dryRun,
    });

    for (const candidate of selection.candidates) {
      try {
        const result = await this.executeCandidate({
          candidate,
          currentCashLamports,
          realizedPnlLamports,
        });

        applyCandidateResult(counts, result);
        replayedCount += result.replayed ? 1 : 0;

        if (result.closed || (this.options.config.dryRun && result.quoted && !result.rejected)) {
          currentCashLamports += result.netProceedsLamports;
          realizedPnlLamports += result.realizedPnlLamports;
        }
      } catch (error) {
        counts.evaluatedCount += 1;
        counts.failedCount += 1;
        this.writeLog(
          selection.session.id,
          "Paper sell candidate failed.",
          {
            positionId: candidate.position.id,
            mintAddress: candidate.position.mintAddress,
            error: error instanceof Error ? error.message : "Unknown paper sell failure.",
          },
          "ERROR",
        );
      }
    }

    const summary: PaperSellExecutionSummary = {
      sessionId: selection.session.id,
      selectedCount: selection.candidates.length,
      evaluatedCount: counts.evaluatedCount,
      quotedCount: counts.quotedCount,
      refreshedPriceCount: counts.refreshedPriceCount,
      cachedFallbackCount: counts.cachedFallbackCount,
      rejectedCount: counts.rejectedCount,
      failedCount: counts.failedCount,
      closedCount: counts.closedCount,
      orderCreatedCount: counts.orderCreatedCount,
      fillCreatedCount: counts.fillCreatedCount,
      cashUpdatedCount: counts.cashUpdatedCount,
      radarStatusUpdatedCount: counts.radarStatusUpdatedCount,
      totalGrossProceedsLamports: counts.totalGrossProceedsLamports,
      totalNetProceedsLamports: counts.totalNetProceedsLamports,
      totalRealizedPnlLamports: counts.totalRealizedPnlLamports,
      totalSellFeesLamports: counts.totalSellFeesLamports,
      totalSlippageLamports: counts.totalSlippageLamports,
      dryRun: this.options.config.dryRun,
    };

    this.writeLog(selection.session.id, "Paper sell execution summary.", summary);

    return { ...summary, replayedCount, diagnosticFailureCount: this.diagnosticFailureCount };
  }

  private async executeCandidate(input: {
    readonly candidate: PaperSellCandidate;
    readonly currentCashLamports: number;
    readonly realizedPnlLamports: number;
  }): Promise<PaperSellCandidateResult> {
    if (!this.options.config.dryRun) {
      const { result, replayed, radarUpdated } = await executePaperSell({
        repositories: this.options.repositories,
        candidate: input.candidate,
        config: this.options.config,
        quoteService: this.options.quoteService,
        clock: this.clock,
      });
      this.writeLog(
        input.candidate.session.id,
        replayed ? "Paper SELL result replayed." : "Paper SELL result.",
        { result, replayed },
      );
      const committed = result.state === "COMMITTED";
      return {
        replayed,
        quoted: committed && !replayed,
        refreshedPrice: committed && !replayed && result.priceSource === "REFRESHED_PRICE",
        cachedFallback: committed && !replayed && result.priceSource === "CACHED_RADAR_PRICE",
        rejected: !committed && !replayed,
        failed: false,
        closed: committed && !replayed,
        orderCreated: !replayed,
        fillCreated: committed && !replayed,
        cashUpdated: committed && !replayed,
        radarStatusUpdated: radarUpdated,
        grossProceedsLamports: replayed ? 0 : result.grossProceedsLamports,
        netProceedsLamports: replayed ? 0 : result.cashDeltaLamports,
        realizedPnlLamports: replayed ? 0 : result.realizedPnlDeltaLamports,
        sellFeesLamports: replayed ? 0 : result.feesLamports,
        slippageLamports: replayed ? 0 : result.slippageLamports,
        ...(!committed ? { rejectionCode: result.code } : {}),
      };
    }
    const sessionRejection = this.validationService.validateSession(input.candidate.session);

    if (sessionRejection) {
      return this.rejectCandidate(input.candidate, sessionRejection);
    }

    const positionRejection = this.validationService.validatePosition(input.candidate.position);

    if (positionRejection) {
      return this.rejectCandidate(input.candidate, positionRejection);
    }

    const quoteResolution = await this.options.quoteService.resolveQuote(
      input.candidate,
      this.options.config,
      this.clock(),
    );

    if (!quoteResolution.ok) {
      return this.rejectCandidate(input.candidate, quoteResolution.rejection);
    }

    const accounting = this.accountingService.calculate({
      position: input.candidate.position,
      quote: quoteResolution.quote,
      config: this.options.config,
    });

    if (!accounting) {
      return this.rejectCandidate(input.candidate, {
        code: "INSUFFICIENT_LIQUIDITY",
        message: "Sell proceeds are not positive after fees and slippage.",
        context: {
          grossProceedsLamports: quoteResolution.quote.grossProceedsLamports,
          baseFeeLamports: this.options.config.baseFeeLamports,
          priorityFeeLamports: this.options.config.priorityFeeLamports,
          slippageBps: this.options.config.slippageBps,
        },
      });
    }

    if (this.options.config.dryRun) {
      this.writeLog(input.candidate.session.id, "Paper sell dry-run candidate accepted.", {
        positionId: input.candidate.position.id,
        mintAddress: input.candidate.position.mintAddress,
        quote: quoteResolution.quote,
        accounting,
      });

      return successResult({
        quote: quoteResolution.quote,
        accounting,
        closed: false,
        orderCreated: false,
        fillCreated: false,
        cashUpdated: false,
        radarStatusUpdated: false,
      });
    }

    throw new Error("Unreachable dry-run branch");
  }

  private rejectCandidate(
    candidate: PaperSellCandidate,
    rejection: PaperSellValidationRejection,
  ): PaperSellCandidateResult {
    this.writeLog(
      candidate.session.id,
      "Paper sell candidate rejected.",
      {
        positionId: candidate.position.id,
        mintAddress: candidate.position.mintAddress,
        rejection,
        dryRun: this.options.config.dryRun,
      },
      "WARN",
    );

    return rejectedResult(rejection.code, false);
  }

  private writeLog(
    sessionId: string,
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
    if (this.options.config.suppressSystemLogs) {
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

function createEmptyCounts(): MutablePaperSellCounts {
  return {
    evaluatedCount: 0,
    quotedCount: 0,
    refreshedPriceCount: 0,
    cachedFallbackCount: 0,
    rejectedCount: 0,
    failedCount: 0,
    closedCount: 0,
    orderCreatedCount: 0,
    fillCreatedCount: 0,
    cashUpdatedCount: 0,
    radarStatusUpdatedCount: 0,
    totalGrossProceedsLamports: 0,
    totalNetProceedsLamports: 0,
    totalRealizedPnlLamports: 0,
    totalSellFeesLamports: 0,
    totalSlippageLamports: 0,
  };
}

function applyCandidateResult(
  counts: MutablePaperSellCounts,
  result: PaperSellCandidateResult,
): void {
  counts.evaluatedCount += 1;
  counts.quotedCount += result.quoted ? 1 : 0;
  counts.refreshedPriceCount += result.refreshedPrice ? 1 : 0;
  counts.cachedFallbackCount += result.cachedFallback ? 1 : 0;
  counts.rejectedCount += result.rejected ? 1 : 0;
  counts.failedCount += result.failed ? 1 : 0;
  counts.closedCount += result.closed ? 1 : 0;
  counts.orderCreatedCount += result.orderCreated ? 1 : 0;
  counts.fillCreatedCount += result.fillCreated ? 1 : 0;
  counts.cashUpdatedCount += result.cashUpdated ? 1 : 0;
  counts.radarStatusUpdatedCount += result.radarStatusUpdated ? 1 : 0;
  counts.totalGrossProceedsLamports += result.grossProceedsLamports;
  counts.totalNetProceedsLamports += result.netProceedsLamports;
  counts.totalRealizedPnlLamports += result.realizedPnlLamports;
  counts.totalSellFeesLamports += result.sellFeesLamports;
  counts.totalSlippageLamports += result.slippageLamports;
}

function successResult(input: {
  readonly quote: PaperSellQuoteContext;
  readonly accounting: PaperSellAccountingResult;
  readonly closed: boolean;
  readonly orderCreated: boolean;
  readonly fillCreated: boolean;
  readonly cashUpdated: boolean;
  readonly radarStatusUpdated: boolean;
}): PaperSellCandidateResult {
  return {
    quoted: true,
    refreshedPrice: input.quote.priceSource === "REFRESHED_PRICE",
    cachedFallback: input.quote.priceSource === "CACHED_RADAR_PRICE",
    rejected: false,
    failed: false,
    closed: input.closed,
    orderCreated: input.orderCreated,
    fillCreated: input.fillCreated,
    cashUpdated: input.cashUpdated,
    radarStatusUpdated: input.radarStatusUpdated,
    grossProceedsLamports: input.accounting.grossProceedsLamports,
    netProceedsLamports: input.accounting.netSellProceedsLamports,
    realizedPnlLamports: input.accounting.realizedPnlLamports,
    sellFeesLamports: input.accounting.sellFeesLamports,
    slippageLamports: input.accounting.sellSlippageLamports,
  };
}

function rejectedResult(
  rejectionCode: PaperSellRejectionCode,
  orderCreated: boolean,
): PaperSellCandidateResult {
  return {
    quoted: false,
    refreshedPrice: false,
    cachedFallback: false,
    rejected: true,
    failed: false,
    closed: false,
    orderCreated,
    fillCreated: false,
    cashUpdated: false,
    radarStatusUpdated: false,
    grossProceedsLamports: 0,
    netProceedsLamports: 0,
    realizedPnlLamports: 0,
    sellFeesLamports: 0,
    slippageLamports: 0,
    rejectionCode,
  };
}
