import { defaultAnalyticsConfig } from "../analytics/AnalyticsConfig.js";
import { AnalyticsReportService } from "../analytics/AnalyticsReportService.js";
import { defaultCalibrationConfig } from "../calibration/CalibrationConfig.js";
import { CalibrationReportService } from "../calibration/CalibrationReportService.js";
import { CalibrationRepository } from "../calibration/CalibrationRepository.js";
import { BirdeyeSelectiveEnrichmentService } from "../providers/birdeye/BirdeyeSelectiveEnrichmentService.js";
import type { ProviderConfig } from "../providers/config/providerConfig.js";
import type { Repositories } from "../db/repositories/index.js";
import type { ProviderHealthRepository } from "../db/repositories/ProviderHealthRepository.js";
import { defaultRiskConfig } from "../risk/RiskConfig.js";
import { RiskRunner } from "../risk/RiskRunner.js";
import { defaultScannerConfig } from "../scanner/ScannerConfig.js";
import { ScannerRunner } from "../scanner/ScannerRunner.js";
import { defaultShadowCalibrationConfig } from "../shadow-calibration/ShadowCalibrationConfig.js";
import { ShadowCalibrationReportService } from "../shadow-calibration/ShadowCalibrationReportService.js";
import { loadShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import { defaultShadowEntryConfig } from "../shadow-entry/ShadowEntryConfig.js";
import { loadShadowEntryRuns } from "../shadow-entry/ShadowEntryCandidateLoader.js";
import { ShadowEntryReportService } from "../shadow-entry/ShadowEntryReportService.js";
import { defaultShadowConfig } from "../shadow/ShadowConfig.js";
import { ShadowExitReportService } from "../shadow/ShadowExitReportService.js";
import { ShadowObservationRunner } from "../shadow/ShadowObservationRunner.js";
import { defaultFastShadowConfig } from "../shadow-fast/FastShadowConfig.js";
import { FastShadowObservationRunner } from "../shadow-fast/FastShadowObservationRunner.js";
import { defaultStrategyConfig } from "../strategy/StrategyConfig.js";
import { StrategyRunner } from "../strategy/StrategyRunner.js";
import { defaultWatchlistReturnConfig } from "../watchlist/WatchlistReturnConfig.js";
import { WatchlistReturnRunner } from "../watchlist/WatchlistReturnRunner.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";
import {
  createEmptyProviderPressureSummary,
  summarizeProviderHealthRows,
  type TerminalStageName,
  type TerminalStageResult,
  type TerminalStageStatus,
} from "./TerminalRunSummary.js";

export interface TerminalStageRunnerOptions {
  readonly repositories: Repositories;
  readonly registry: ProviderRegistry;
  readonly providerConfig: ProviderConfig;
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly databasePath: string;
  readonly sessionId: string;
  readonly clock?: () => number;
}

interface StageBodyResult {
  readonly status: TerminalStageStatus;
  readonly summary: string;
  readonly counts: Readonly<Record<string, number | string | boolean | null>>;
}

export class TerminalStageRunner {
  private readonly clock: () => number;

  constructor(private readonly options: TerminalStageRunnerOptions) {
    this.clock = options.clock ?? Date.now;
  }

  async runStage(name: TerminalStageName): Promise<TerminalStageResult> {
    const startedAtMs = this.clock();

    try {
      const result = await this.runStageBody(name);
      const endedAtMs = this.clock();

      return {
        name,
        ...result,
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        providerPressure: this.providerPressureBetween(startedAtMs, endedAtMs),
        recoverableFailure: false,
      };
    } catch (error) {
      const endedAtMs = this.clock();
      const message = error instanceof Error ? error.message : `Unknown ${name} failure.`;
      const recoverable = isRecoverableStageError(message);

      return {
        name,
        status: recoverable ? "EMPTY" : "FAILED",
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        summary: recoverable ? "No eligible rows for this stage." : "Stage failed.",
        counts: {},
        providerPressure: this.providerPressureBetween(startedAtMs, endedAtMs),
        recoverableFailure: recoverable,
        errorMessage: message,
      };
    }
  }

  private async runStageBody(name: TerminalStageName): Promise<StageBodyResult> {
    switch (name) {
      case "scanner":
        return this.runScanner();
      case "risk":
        return this.runRisk();
      case "strategy":
        return this.runStrategy();
      case "fast_shadow_observe":
        return this.runFastShadowObserve();
      case "birdeye_enrichment":
        return this.runBirdeyeEnrichment();
      case "shadow_observe":
        return this.runShadowObserve();
      case "shadow_exits":
        return this.runShadowExits();
      case "shadow_calibration":
        return this.runShadowCalibration();
      case "shadow_entries":
        return this.runShadowEntries();
      case "watchlist_returns":
        return this.runWatchlistReturns();
      case "analytics_report":
        return this.runAnalyticsReport();
      case "calibration_report":
        return this.runCalibrationReport();
    }
  }

  private async runScanner(): Promise<StageBodyResult> {
    const result = await new ScannerRunner({
      config: {
        ...defaultScannerConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      registry: this.options.registry,
      marketDataService: this.options.marketDataService,
      clock: this.clock,
    }).runOnce();

    return {
      status: result.discoveredCount === 0 && result.storedCount === 0 ? "EMPTY" : "SUCCESS",
      summary: `discovered=${result.discoveredCount} unique=${result.uniqueCount} stored=${result.storedCount} errors=${result.errorCount}`,
      counts: {
        sessionId: result.sessionId,
        discovered: result.discoveredCount,
        unique: result.uniqueCount,
        duplicates: result.duplicateCount,
        enriched: result.enrichedCount,
        stored: result.storedCount,
        errors: result.errorCount,
        dryRun: result.dryRun,
      },
    };
  }

  private async runRisk(): Promise<StageBodyResult> {
    const result = await new RiskRunner({
      config: {
        ...defaultRiskConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      marketDataService: this.options.marketDataService,
      quoteBudgetPlannerConfig: this.options.providerConfig.quoteResilience.planner,
    }).runOnce();

    return {
      status: result.evaluatedCount === 0 ? "EMPTY" : "SUCCESS",
      summary: `selected=${result.selectedCount} evaluated=${result.evaluatedCount} quoteBudgetSelected=${result.quoteBudgetSelectedCount} quoteBudgetNotSelected=${result.quoteBudgetNotSelectedCount} PASS=${result.passCount} WARN=${result.warnCount} FAIL=${result.failCount} errors=${result.errorCount}`,
      counts: {
        sessionId: result.sessionId,
        selected: result.selectedCount,
        evaluated: result.evaluatedCount,
        PASS: result.passCount,
        WARN: result.warnCount,
        FAIL: result.failCount,
        UNKNOWN: result.unknownCount,
        written: result.writtenCount,
        statusUpdated: result.statusUpdatedCount,
        quoteBudgetEnabled: result.quoteBudgetEnabled,
        quoteBudgetLimit: result.quoteBudgetLimit,
        quoteBudgetSelected: result.quoteBudgetSelectedCount,
        quoteBudgetNotSelected: result.quoteBudgetNotSelectedCount,
        errors: result.errorCount,
      },
    };
  }

  private async runStrategy(): Promise<StageBodyResult> {
    const result = await new StrategyRunner({
      config: {
        ...defaultStrategyConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
    }).runOnce();

    return {
      status: result.evaluatedCount === 0 ? "EMPTY" : "SUCCESS",
      summary: `selected=${result.selectedCount} evaluated=${result.evaluatedCount} BUY=${result.buyCount} WATCH=${result.watchCount} SKIP=${result.skipCount} errors=${result.errorCount}`,
      counts: {
        sessionId: result.sessionId,
        selected: result.selectedCount,
        evaluated: result.evaluatedCount,
        BUY: result.buyCount,
        WATCH: result.watchCount,
        SKIP: result.skipCount,
        HOLD: result.holdCount,
        SELL: result.sellCount,
        written: result.writtenCount,
        statusUpdated: result.statusUpdatedCount,
        duplicateBuyBlocked: result.duplicateBuyBlockedCount,
        maxBuyCapBlocked: result.maxBuyCapBlockedCount,
        errors: result.errorCount,
      },
    };
  }

  private async runBirdeyeEnrichment(): Promise<StageBodyResult> {
    const result = await new BirdeyeSelectiveEnrichmentService({
      sessionId: this.options.sessionId,
      repositories: this.options.repositories,
      registry: this.options.registry,
      config: this.options.providerConfig.birdeye,
    }).enrich();

    return {
      status: result.selectedCount === 0 ? "EMPTY" : "SUCCESS",
      summary: `selected=${result.selectedCount} priceOk=${result.priceOkCount} overviewOk=${result.overviewOkCount} skipped=${result.skippedCount} errors=${result.errorCount}`,
      counts: {
        sessionId: result.sessionId,
        selected: result.selectedCount,
        priceOk: result.priceOkCount,
        overviewOk: result.overviewOkCount,
        skipped: result.skippedCount,
        errors: result.errorCount,
      },
    };
  }

  private async runShadowObserve(): Promise<StageBodyResult> {
    const result = await new ShadowObservationRunner({
      config: {
        ...defaultShadowConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      marketDataService: this.options.marketDataService,
      clock: this.clock,
    }).run();

    return {
      status:
        result.selectedStrategyDecisions === 0 &&
        result.scheduledCount === 0 &&
        result.dueCount === 0
          ? "EMPTY"
          : "SUCCESS",
      summary: `selected=${result.selectedStrategyDecisions} scheduled=${result.scheduledCount} due=${result.dueCount} observed=${result.observedCount} failed=${result.failedCount}`,
      counts: {
        sessionId: result.sessionId,
        selectedStrategyDecisions: result.selectedStrategyDecisions,
        scheduled: result.scheduledCount,
        alreadyScheduled: result.alreadyScheduledCount,
        due: result.dueCount,
        observed: result.observedCount,
        missed: result.missedCount,
        failed: result.failedCount,
        dryRun: result.dryRun,
      },
    };
  }

  private async runFastShadowObserve(): Promise<StageBodyResult> {
    const result = await new FastShadowObservationRunner({
      config: {
        ...defaultFastShadowConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      marketDataService: this.options.marketDataService,
      clock: this.clock,
    }).runOnce();

    return {
      status:
        result.selectedCount === 0 && result.scheduledCount === 0 && result.dueCount === 0
          ? "EMPTY"
          : "SUCCESS",
      summary: `profile=${result.profileKey} eligible=${result.eligibleCount} selected=${result.selectedCount} scheduled=${result.scheduledCount} due=${result.dueCount} observed=${result.observedCount} missed=${result.missedCount} failed=${result.failedCount}`,
      counts: {
        sessionId: result.sessionId,
        profile: result.profileKey,
        eligible: result.eligibleCount,
        selected: result.selectedCount,
        capSuppressed: result.capSuppressedCount,
        duplicateMintSuppressed: result.duplicateMintSuppressedCount,
        scheduled: result.scheduledCount,
        alreadyScheduled: result.alreadyScheduledCount,
        due: result.dueCount,
        observed: result.observedCount,
        missed: result.missedCount,
        failed: result.failedCount,
        dryRun: result.dryRun,
      },
    };
  }

  private runShadowExits(): StageBodyResult {
    const report = new ShadowExitReportService({
      config: {
        ...defaultShadowConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      clock: this.clock,
    }).generate();

    return {
      status: report.selectedCount === 0 ? "EMPTY" : "SUCCESS",
      summary: `selected=${report.selectedCount} skipped=${report.skippedCount} scenarios=${report.scenarioSummaries.length} pnlPct=${report.portfolio.pnlPct}`,
      counts: {
        sessionId: report.session.id,
        selected: report.selectedCount,
        skipped: report.skippedCount,
        candidates: report.candidates.length,
        scenarios: report.scenarioSummaries.length,
        portfolioTrades: report.portfolio.trades.length,
        simulatedPnlSol: report.portfolio.pnlSol,
        simulatedPnlPct: report.portfolio.pnlPct,
        goalReached: report.portfolio.goalReached,
      },
    };
  }

  private runShadowCalibration(): StageBodyResult {
    const config = {
      ...defaultShadowCalibrationConfig(),
      once: true,
      sessionId: this.options.sessionId,
      dbSources: [
        {
          label: "active",
          path: this.options.databasePath,
        },
      ],
    };
    const loadedRuns = loadShadowCalibrationRuns(config);

    try {
      const report = new ShadowCalibrationReportService({
        config,
        runs: loadedRuns.runs,
        clock: this.clock,
      }).generate();

      return {
        status: report.aggregate.observedDecisionCount === 0 ? "EMPTY" : "SUCCESS",
        summary: `runs=${report.aggregate.runCount} observedDecisions=${report.aggregate.observedDecisionCount} uniqueMints=${report.aggregate.uniqueMintCount} recommendations=${report.recommendations.length}`,
        counts: {
          runs: report.aggregate.runCount,
          databaseRuns: report.aggregate.databaseRunCount,
          reportOnlyRuns: report.aggregate.reportOnlyRunCount,
          observedDecisions: report.aggregate.observedDecisionCount,
          uniqueMints: report.aggregate.uniqueMintCount,
          orders: report.aggregate.orderCount,
          fills: report.aggregate.fillCount,
          positions: report.aggregate.positionCount,
          recommendations: report.recommendations.length,
        },
      };
    } finally {
      loadedRuns.close();
    }
  }

  private runShadowEntries(): StageBodyResult {
    const config = {
      ...defaultShadowEntryConfig(),
      once: true,
      sessionId: this.options.sessionId,
      dbSources: [
        {
          label: "active",
          path: this.options.databasePath,
        },
      ],
    };
    const loadedRuns = loadShadowEntryRuns(config);

    try {
      const report = new ShadowEntryReportService({
        config,
        runs: loadedRuns.runs,
        candidates: loadedRuns.candidates,
        clock: this.clock,
      }).generate();
      const promotionCandidates = report.readinessByProfile.filter(
        (row) => row.status === "CANDIDATE_FOR_PROMOTION",
      ).length;
      const promisingResearch = report.readinessByProfile.filter(
        (row) => row.status === "PROMISING_RESEARCH",
      ).length;

      return {
        status: report.aggregate.observedDecisionCount === 0 ? "EMPTY" : "SUCCESS",
        summary: `runs=${report.aggregate.runCount} observedDecisions=${report.aggregate.observedDecisionCount} uniqueMints=${report.aggregate.uniqueMintCount} promotionCandidates=${promotionCandidates}`,
        counts: {
          runs: report.aggregate.runCount,
          observedDecisions: report.aggregate.observedDecisionCount,
          uniqueMints: report.aggregate.uniqueMintCount,
          orders: report.aggregate.orderCount,
          fills: report.aggregate.fillCount,
          positions: report.aggregate.positionCount,
          normalizedProfiles: report.normalizedProfiles.length,
          promotionCandidates,
          promisingResearch,
          recommendations: report.recommendations.length,
        },
      };
    } finally {
      loadedRuns.close();
    }
  }

  private async runWatchlistReturns(): Promise<StageBodyResult> {
    const result = await new WatchlistReturnRunner({
      config: {
        ...defaultWatchlistReturnConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      marketDataService: this.options.marketDataService,
      clock: this.clock,
    }).runOnce();

    return {
      status:
        result.selectedStrategyDecisions === 0 &&
        result.scheduledCount === 0 &&
        result.dueCount === 0
          ? "EMPTY"
          : "SUCCESS",
      summary: `selected=${result.selectedStrategyDecisions} scheduled=${result.scheduledCount} due=${result.dueCount} observed=${result.observedCount} failed=${result.failedCount}`,
      counts: {
        sessionId: result.sessionId,
        selectedStrategyDecisions: result.selectedStrategyDecisions,
        scheduled: result.scheduledCount,
        alreadyScheduled: result.alreadyScheduledCount,
        due: result.dueCount,
        observed: result.observedCount,
        missed: result.missedCount,
        failed: result.failedCount,
        dryRun: result.dryRun,
      },
    };
  }

  private runAnalyticsReport(): StageBodyResult {
    const report = new AnalyticsReportService({
      config: {
        ...defaultAnalyticsConfig(),
        once: true,
        sessionId: this.options.sessionId,
      },
      repositories: this.options.repositories,
      clock: this.clock,
    }).generate();

    return {
      status:
        report.funnel.tokenRadarTotal === 0 && report.funnel.strategyDecisionTotal === 0
          ? "EMPTY"
          : "SUCCESS",
      summary: `radar=${report.funnel.tokenRadarTotal} risk=${report.funnel.riskAssessmentTotal} strategy=${report.funnel.strategyDecisionTotal} missedOpportunities=${report.missedOpportunities.length}`,
      counts: {
        sessionId: report.session.id,
        tokenRadar: report.funnel.tokenRadarTotal,
        risk: report.funnel.riskAssessmentTotal,
        strategy: report.funnel.strategyDecisionTotal,
        orders: report.funnel.orderTotal,
        fills: report.funnel.fillTotal,
        watchlistReturns: report.funnel.watchlistReturnTotal,
        missedOpportunities: report.missedOpportunities.length,
        nearMisses: report.nearMisses.length,
        providerHealthRows: report.providerHealth.reduce((total, row) => total + row.total, 0),
      },
    };
  }

  private runCalibrationReport(): StageBodyResult {
    const config = {
      ...defaultCalibrationConfig(),
      once: true,
      sessionId: this.options.sessionId,
    };
    const report = new CalibrationReportService({
      config,
      repositories: [
        new CalibrationRepository({
          label: "active",
          path: this.options.databasePath,
          repositories: this.options.repositories,
        }),
      ],
      clock: this.clock,
    }).generate();
    const totals = report.datasets.reduce(
      (accumulator, dataset) => ({
        strategyRows: accumulator.strategyRows + dataset.counts.strategyRows,
        observedReturnRows: accumulator.observedReturnRows + dataset.counts.observedReturnRows,
        providerHealthRows: accumulator.providerHealthRows + dataset.counts.providerHealthRows,
      }),
      {
        strategyRows: 0,
        observedReturnRows: 0,
        providerHealthRows: 0,
      },
    );

    return {
      status: totals.strategyRows === 0 && totals.observedReturnRows === 0 ? "EMPTY" : "SUCCESS",
      summary: `datasets=${report.datasets.length} strategyRows=${totals.strategyRows} observedReturns=${totals.observedReturnRows} recommendations=${report.recommendations.length}`,
      counts: {
        datasets: report.datasets.length,
        strategyRows: totals.strategyRows,
        observedReturns: totals.observedReturnRows,
        providerHealthRows: totals.providerHealthRows,
        recommendations: report.recommendations.length,
      },
    };
  }

  private providerPressureBetween(startedAtMs: number, endedAtMs: number) {
    return summarizeProviderHealthRows(
      listProviderHealthDelta(this.options.repositories.providerHealth, startedAtMs, endedAtMs),
    );
  }
}

function listProviderHealthDelta(
  repository: ProviderHealthRepository,
  startedAtMs: number,
  endedAtMs: number,
) {
  if (endedAtMs < startedAtMs) {
    return [];
  }

  return repository.listProviderHealth({
    fromMs: startedAtMs,
    toMs: endedAtMs,
    limit: 10_000,
  });
}

function isRecoverableStageError(message: string): boolean {
  return (
    !isSafetyBoundaryError(message) &&
    (/No PAPER session with/i.test(message) ||
      /Run .* first or pass --session-id/i.test(message) ||
      /No eligible/i.test(message))
  );
}

function isSafetyBoundaryError(message: string): boolean {
  return /live mode|wallet|sign|submit|transaction submission|paper execution|LIVE/i.test(message);
}

export function createSkippedStageResult(
  name: TerminalStageName,
  timestampMs: number,
  summary: string,
): TerminalStageResult {
  return {
    name,
    status: "SKIPPED",
    startedAtMs: timestampMs,
    endedAtMs: timestampMs,
    durationMs: 0,
    summary,
    counts: {},
    providerPressure: createEmptyProviderPressureSummary(),
    recoverableFailure: false,
  };
}
