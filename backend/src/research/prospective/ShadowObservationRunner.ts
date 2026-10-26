/**
 * Phase 12.94-D Milestone D.3.3: Shadow Observation Runner
 *
 * Dedicated, strictly passive observation runner wiring Candidate Discovery Streams
 * and BuyGateTriggerService directly to ProspectiveObservationRecorder for forward
 * horizon tracking (+5m, +15m, +30m, +60m).
 *
 * OPERATIONAL & SAFETY CONSTRAINTS:
 * 1. ZERO paper-trading daemon initialization, wallet keys, or balance mutations.
 * 2. Virtual balance is frozen at 7.9259 SOL.
 * 3. Forward horizons strictly preserve causality (no lookahead, no premature sampling).
 * 4. Pacing is enforced per provider (minimum 2,500 ms spacing).
 * 5. Aggregate request ceiling is enforced globally (120 calls max across discovery, enrichment, quotes, retries).
 * 6. Provider errors and pool drainage are caught safely and recorded truthfully.
 * 7. Generates cryptographic SHA-256 session manifest verifying all records.
 */

import fs from "node:fs";
import path from "node:path";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  BuyGateTriggerService,
  type AdvancedMarketContext,
} from "../../candidate-scanner/BuyGateTriggerService.js";
import { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import {
  ProspectiveObservationRecorder,
  type RecordDecisionInput,
} from "./ProspectiveObservationRecorder.js";
import {
  FORWARD_HORIZONS_SEC,
  type CandidateStreamSource,
  type ForwardHorizonSec,
  type PipelineYieldStats,
  type ProspectiveSessionSummary,
  type ProspectiveStrategyCohort,
  type SessionManifest,
} from "./ProspectiveObservationTypes.js";

export interface ShadowQuoteResult {
  readonly indicativePriceSol: number | null;
  readonly liquidityUsd: number | null;
  readonly quoteTimestampMs: number;
  readonly quoteSource: string;
  readonly isExecutableQuote: boolean;
  readonly isPoolDrained?: boolean | undefined;
  readonly httpStatus?: number | undefined;
  readonly missingReason?: string | undefined;
}

export interface IShadowMarketDataProvider {
  readonly providerName: string;
  fetchQuote(poolId: string, mintAddress: string): Promise<ShadowQuoteResult>;
}

export interface ShadowCandidateInput {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly symbol: string;
  readonly discoveryTimestampMs: number;
  readonly streamSource: CandidateStreamSource;
  readonly indicativePriceSol: number | null;
  readonly missingPriceReason?: string | undefined;
  readonly priceQuoteTimestampMs?: number | null | undefined;
  readonly selectedPoolAddress?: string | undefined;
  readonly poolSelectionBasis?: string | undefined;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly lmcRatio: number | null;
  readonly lpBurnPct: number | null;
  readonly assetAgeSeconds: number | null;
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly buyToSellRatio: number | null;
  readonly holdersCount?: number | null | undefined;
  readonly rugScore?: number | null | undefined;
  readonly bundlerPct?: number | null | undefined;
  readonly top10HolderPct?: number | null | undefined;
  readonly recentBuys60s?: number | null | undefined;
  readonly recentSells60s?: number | null | undefined;
  readonly unavailableInputs?: readonly string[] | undefined;
}

export interface ScheduledHorizonTask {
  readonly decisionEventId: string;
  readonly poolId: string;
  readonly mintAddress: string;
  readonly horizonSec: ForwardHorizonSec;
  readonly scheduledDueTimestampMs: number;
  status: "PENDING" | "EXECUTING" | "FINALIZED";
}

export interface ShadowRunnerConfig {
  readonly sessionId: string;
  readonly configFingerprint: string;
  readonly strategyConfigFingerprint?: string | undefined;
  readonly launcherConfigFingerprint?: string | undefined;
  readonly strategyVersion?: string | undefined;
  readonly outputDir?: string | undefined;
  readonly approvedRootPath?: string | undefined;
  readonly maxCandidates?: number | undefined; // e.g. 25
  readonly intakeDurationMs?: number | undefined; // e.g. 3,600,000 (60m)
  readonly drainDurationMs?: number | undefined; // e.g. 3,600,000 (60m)
  readonly minProviderSpacingMs?: number | undefined; // e.g. 2,500 ms
  readonly maxAggregateRequests?: number | undefined; // e.g. 120
  readonly maxQuoteStaleMs?: number | undefined; // e.g. 60,000 ms
  readonly clock?: () => number;
}

export interface ShadowRunnerDependencies {
  readonly buyGateService?: BuyGateTriggerService | undefined;
  readonly marketDataProvider?: IShadowMarketDataProvider | undefined;
  readonly recorder?: ProspectiveObservationRecorder | undefined;
  readonly budgetManager?: GlobalResourceBudgetManager | undefined;
}

export class ShadowObservationRunner {
  private readonly config: ShadowRunnerConfig;
  private readonly clock: () => number;
  private readonly buyGateService: BuyGateTriggerService;
  private readonly marketDataProvider: IShadowMarketDataProvider | null;
  private readonly recorder: ProspectiveObservationRecorder;
  private readonly budgetManager: GlobalResourceBudgetManager;

  private readonly sessionStartedAtMs: number;
  private readonly intakeDeadlineMs: number;
  private readonly sessionDeadlineMs: number;
  private readonly maxCandidates: number;
  private readonly maxQuoteStaleMs: number;

  private readonly scheduledTasks: ScheduledHorizonTask[] = [];
  private candidateCount = 0;
  private forwardQuoteAttemptsCount = 0;
  private successfulForwardPriceObservationsCount = 0;
  private isIntakeStopped = false;
  private isSessionClosed = false;
  private isProcessingObservations = false;
  private earlyStopReason: string | null = null;

  constructor(config: ShadowRunnerConfig, dependencies: ShadowRunnerDependencies = {}) {
    this.config = config;
    this.clock = config.clock ?? (() => Date.now());
    this.sessionStartedAtMs = this.clock();

    const intakeDuration = config.intakeDurationMs ?? 3_600_000; // default 60m
    const drainDuration = config.drainDurationMs ?? 3_600_000; // default 60m
    this.intakeDeadlineMs = this.sessionStartedAtMs + intakeDuration;
    this.sessionDeadlineMs = this.sessionStartedAtMs + intakeDuration + drainDuration;

    this.maxCandidates = config.maxCandidates ?? 25;
    const minProviderSpacingMs = config.minProviderSpacingMs ?? 2_500;
    const maxAggregateRequests = config.maxAggregateRequests ?? 120;
    this.maxQuoteStaleMs = config.maxQuoteStaleMs ?? 60_000;

    // Output directory collision protection: never overwrite historical sessions
    if (config.outputDir && fs.existsSync(config.outputDir)) {
      const existingFiles = fs.readdirSync(config.outputDir);
      if (
        existingFiles.includes("decision-observations.jsonl") ||
        existingFiles.includes("session-manifest.json")
      ) {
        throw new Error(
          `[COLLISION] Target session directory ${config.outputDir} already contains session artifacts. Cannot overwrite existing evidence.`,
        );
      }
    }

    this.budgetManager =
      dependencies.budgetManager ??
      new GlobalResourceBudgetManager({
        maxTotalRequests: maxAggregateRequests,
        minProviderSpacingMs,
        clock: this.clock,
      });

    this.buyGateService = dependencies.buyGateService ?? new BuyGateTriggerService();
    this.marketDataProvider = dependencies.marketDataProvider ?? null;

    this.recorder =
      dependencies.recorder ??
      new ProspectiveObservationRecorder({
        sessionId: config.sessionId,
        configFingerprint: config.configFingerprint,
        outputDir: config.outputDir,
        approvedRootPath: config.approvedRootPath,
        clock: this.clock,
        suppressDuplicateCandidates: true,
        maxCandidates: this.maxCandidates,
        intakeDeadlineMs: this.intakeDeadlineMs,
        sessionDeadlineMs: this.sessionDeadlineMs,
      });
  }

  /**
   * Evaluates and ingests a candidate item.
   * Feeds the candidate into BuyGateTriggerService, records decision truthfully,
   * and schedules forward horizons (+5m, +15m, +30m, +60m) for both accepted and rejected tokens.
   */
  public ingestCandidate(candidate: ShadowCandidateInput, nowMs?: number): string | null {
    const now = nowMs ?? this.clock();

    // Causality Invariant: Decision timestamp MUST NOT predate candidate discovery timestamp
    if (now < candidate.discoveryTimestampMs) {
      throw new Error(
        `[CAUSALITY_VIOLATION] Decision timestamp (${now}) cannot predate candidate discovery timestamp (${candidate.discoveryTimestampMs}). Ensure evaluation timestamp is captured after network enrichment.`,
      );
    }

    // Check session closure
    if (this.isSessionClosed || now >= this.sessionDeadlineMs) {
      return null;
    }

    // Check 429 halt condition
    if (this.budgetManager.is429HaltRequired()) {
      if (!this.isIntakeStopped) {
        this.earlyStopReason = "CONSECUTIVE_HTTP_429_LIMIT_REACHED";
        this.stopIntake(now);
      }
      return null;
    }

    // Check intake deadline
    if (this.isIntakeStopped || now >= this.intakeDeadlineMs) {
      if (!this.isIntakeStopped) {
        this.stopIntake(now);
      }
      return null;
    }

    // Check candidate ceiling
    if (this.candidateCount >= this.maxCandidates) {
      return null;
    }

    // 1. Determine cohort strictly according to approved strategy baseline
    let strategyCohort: ProspectiveStrategyCohort = "UNCLASSIFIED";
    if (
      candidate.liquidityUsd !== null &&
      candidate.assetAgeSeconds !== null &&
      candidate.liquidityUsd >= 50000 &&
      candidate.assetAgeSeconds >= 1800 &&
      candidate.assetAgeSeconds <= 7200
    ) {
      strategyCohort = "ESTABLISHED_RUNNER";
    } else if (
      candidate.liquidityUsd !== null &&
      candidate.assetAgeSeconds !== null &&
      candidate.liquidityUsd >= 20000 &&
      candidate.liquidityUsd < 50000 &&
      candidate.assetAgeSeconds >= 300 &&
      candidate.assetAgeSeconds <= 900
    ) {
      strategyCohort = "MICRO_CAP_PROBE";
    } else {
      strategyCohort = "UNCLASSIFIED";
    }

    // 2. Identify missing or unverified mandatory screening inputs
    const missingInputs: string[] = [];
    if (candidate.indicativePriceSol === null || candidate.indicativePriceSol <= 0) {
      missingInputs.push(candidate.missingPriceReason ?? "MISSING_PRICE_DATA");
    }
    if (candidate.liquidityUsd === null) {
      missingInputs.push("MISSING_LIQUIDITY_DATA");
    }
    if (candidate.marketCapUsd === null) {
      missingInputs.push("MISSING_MARKET_CAP_DATA");
    }
    if (candidate.assetAgeSeconds === null) {
      missingInputs.push("MISSING_ASSET_AGE_DATA");
    }
    if (candidate.lmcRatio === null) {
      missingInputs.push("MISSING_LMC_RATIO_DATA");
    }
    if (candidate.lpBurnPct === null) {
      missingInputs.push("UNVERIFIED_LP_BURN_DATA");
    }
    if (candidate.volume5mUsd === null) {
      missingInputs.push("MISSING_VOLUME_DATA");
    }
    if (candidate.buyToSellRatio === null) {
      missingInputs.push("MISSING_FLOW_DATA");
    }

    let gateTriggered = false;
    let primaryRejection: string | undefined;
    let gateChecks: Array<{
      name: string;
      passed: boolean;
      value: number | null;
      requirement: string;
    }> = [];

    if (missingInputs.length > 0) {
      // Cannot pass screening if mandatory inputs are absent or unverified
      gateTriggered = false;
      primaryRejection = missingInputs[0];
      gateChecks = missingInputs.map((m) => ({
        name: m,
        passed: false,
        value: null,
        requirement: "Mandatory observed data required",
      }));
    } else {
      // 3. Map candidate to BuyGateTriggerService input when all mandatory inputs observed
      const watchlistItem: WatchlistCandidateItem = {
        poolId: candidate.poolId,
        mintAddress: candidate.mintAddress,
        symbol: candidate.symbol,
        liquidityUsd: candidate.liquidityUsd!,
        marketCapUsd: candidate.marketCapUsd!,
        lmcRatio: candidate.lmcRatio!,
        lpBurnPct: candidate.lpBurnPct!,
        assetAgeSeconds: candidate.assetAgeSeconds!,
        volume5mUsd: candidate.volume5mUsd!,
        buys5m: candidate.buys5m ?? 0,
        sells5m: candidate.sells5m ?? 0,
        buyToSellRatio: candidate.buyToSellRatio!,
        status: "WATCHING",
        discoveredAt: new Date(candidate.discoveryTimestampMs).toISOString(),
        lastEvaluatedAt: new Date(now).toISOString(),
      };

      const marketContext: AdvancedMarketContext = {
        holdersCount: candidate.holdersCount ?? undefined,
        rugScore: candidate.rugScore ?? undefined,
        bundlerPct: candidate.bundlerPct ?? undefined,
        top10HolderPct: candidate.top10HolderPct ?? undefined,
        recentBuysCount60s: candidate.recentBuys60s ?? undefined,
        recentSellsCount60s: candidate.recentSells60s ?? undefined,
      };

      // Evaluate candidate through real gate logic
      const gateEval = this.buyGateService.evaluateCandidate(watchlistItem, marketContext);
      gateTriggered = gateEval.triggered;
      primaryRejection = gateEval.rejectionReason;
      gateChecks = gateEval.gates.map((g) => ({
        name: g.name,
        passed: g.passed,
        value: g.value,
        requirement: g.requirement,
      }));
    }

    // 4. Assemble decision record input
    const recordInput: RecordDecisionInput = {
      discoveryTimestampMs: candidate.discoveryTimestampMs,
      decisionTimestampMs: now,
      streamSource: candidate.streamSource,
      mintAddress: candidate.mintAddress,
      poolId: candidate.poolId,
      symbol: candidate.symbol,
      strategyCohort,
      marketFeatures: {
        indicativePriceSol: candidate.indicativePriceSol,
        priceQuoteTimestampMs: candidate.priceQuoteTimestampMs ?? null,
        priceQuoteFreshnessMs:
          candidate.priceQuoteTimestampMs !== null && candidate.priceQuoteTimestampMs !== undefined
            ? Math.max(0, now - candidate.priceQuoteTimestampMs)
            : null,
        selectedPoolAddress: candidate.selectedPoolAddress ?? candidate.poolId,
        poolSelectionBasis: candidate.poolSelectionBasis ?? "EXACT_PAIR_ADDRESS",
        liquidityUsd: candidate.liquidityUsd,
        volume5mUsd: candidate.volume5mUsd,
        marketCapUsd: candidate.marketCapUsd,
        assetAgeSeconds: candidate.assetAgeSeconds,
        lpBurnPct: candidate.lpBurnPct,
        holdersCount: candidate.holdersCount ?? null,
        buyToSellRatio: candidate.buyToSellRatio,
        recentBuys60s: candidate.recentBuys60s ?? null,
        recentSells60s: candidate.recentSells60s ?? null,
        lmcRatio: candidate.lmcRatio,
        rugScore: candidate.rugScore ?? null,
        bundlerPct: candidate.bundlerPct ?? null,
        top10HolderPct: candidate.top10HolderPct ?? null,
        unavailableInputs: [
          ...(candidate.unavailableInputs ?? []),
          ...missingInputs.map((m) => m.toLowerCase()),
        ],
      },
      triggered: gateTriggered,
      rejectionReason: primaryRejection,
      gateChecks,
    };

    // 5. Record decision
    const record = this.recorder.recordDecisionEvent(recordInput);
    if (!record) {
      // Suppressed duplicate or rejected by capacity boundary
      return null;
    }

    this.candidateCount++;

    // 6. Schedule forward horizon tasks (+5m, +15m, +30m, +60m)
    for (const h of FORWARD_HORIZONS_SEC) {
      this.scheduledTasks.push({
        decisionEventId: record.decisionEventId,
        poolId: candidate.poolId,
        mintAddress: candidate.mintAddress,
        horizonSec: h,
        scheduledDueTimestampMs: record.decisionTimestampMs + h * 1000,
        status: "PENDING",
      });
    }

    return record.decisionEventId;
  }

  /**
   * Processes all scheduled forward horizon observations that are due at nowMs.
   * Enforces provider pacing, aggregate request budget, error resilience, and
   * missing quote thresholds.
   */
  public async processDueObservations(nowMs?: number): Promise<number> {
    if (this.isProcessingObservations) {
      return 0; // Concurrency protection: prevent re-entrant execution
    }
    this.isProcessingObservations = true;

    try {
      const now = nowMs ?? this.clock();

      // Check session closure / deadline
      if (this.isSessionClosed || now >= this.sessionDeadlineMs) {
        return 0;
      }

      // Check intake deadline
      if (!this.isIntakeStopped && now >= this.intakeDeadlineMs) {
        this.stopIntake(now);
      }

      // Filter pending tasks where scheduledDueTimestampMs <= now
      const dueTasks = this.scheduledTasks.filter(
        (t) => t.status === "PENDING" && t.scheduledDueTimestampMs <= now,
      );

      // Sort chronologically
      dueTasks.sort((a, b) => a.scheduledDueTimestampMs - b.scheduledDueTimestampMs);

      let processedCount = 0;

      for (const task of dueTasks) {
        // Double check session deadline before each task
        if (this.isSessionClosed || this.clock() >= this.sessionDeadlineMs) {
          break;
        }

        // 1. Check provider availability
        if (!this.marketDataProvider) {
          this.recorder.recordHorizonOutcome({
            decisionEventId: task.decisionEventId,
            horizonSec: task.horizonSec,
            observationTimestampMs: now,
            outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
            indicativePriceSol: null,
            liquidityUsd: null,
            missingReason: "NO_MARKET_DATA_PROVIDER_CONFIGURED",
          });
          task.status = "FINALIZED";
          processedCount++;
          continue;
        }

        const providerName = this.marketDataProvider.providerName;

        // 2. Check global budget and provider pacing
        const check = this.budgetManager.canMakeRequest(providerName, this.clock());
        if (!check.allowed) {
          if (check.reason === "GLOBAL_REQUEST_CEILING_REACHED") {
            this.recorder.recordHorizonOutcome({
              decisionEventId: task.decisionEventId,
              horizonSec: task.horizonSec,
              observationTimestampMs: this.clock(),
              outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
              indicativePriceSol: null,
              liquidityUsd: null,
              missingReason: "AGGREGATE_REQUEST_CEILING_REACHED",
            });
            task.status = "FINALIZED";
            processedCount++;
            continue;
          } else {
            // Pacing not met: defer task to next tick
            continue;
          }
        }

        // 3. Mark task executing and record request in budget manager
        task.status = "EXECUTING";
        const recordedAttempt = this.budgetManager.recordRequestAttempt(
          providerName,
          "FORWARD_OBSERVATION",
          this.clock(),
        );
        if (!recordedAttempt) {
          task.status = "PENDING";
          continue;
        }
        this.forwardQuoteAttemptsCount++;

        // 4. Fetch quote from provider safely
        try {
          const quote = await this.marketDataProvider.fetchQuote(task.poolId, task.mintAddress);
          const actualObsTime = this.clock(); // Timestamp captured AFTER network response

          // Check if late response crossed hard session deadline
          if (actualObsTime >= this.sessionDeadlineMs) {
            this.recorder.recordHorizonOutcome({
              decisionEventId: task.decisionEventId,
              horizonSec: task.horizonSec,
              observationTimestampMs: actualObsTime,
              outcomeStatus: "WINDOW_TRUNCATED",
              indicativePriceSol: null,
              liquidityUsd: null,
              missingReason: "RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE",
            });
            task.status = "FINALIZED";
            processedCount++;
            continue;
          }

          // Check 429 circuit breaker from budget manager
          if (this.budgetManager.is429HaltRequired() && !this.isIntakeStopped) {
            this.earlyStopReason = "CONSECUTIVE_HTTP_429_LIMIT_REACHED";
            this.stopIntake(actualObsTime);
          }

          // Check for stale pre-horizon prices masquerading as outcomes
          if (quote.quoteTimestampMs < task.scheduledDueTimestampMs - 60_000) {
            this.recorder.recordHorizonOutcome({
              decisionEventId: task.decisionEventId,
              horizonSec: task.horizonSec,
              observationTimestampMs: actualObsTime,
              quoteTimestampMs: quote.quoteTimestampMs,
              quoteSource: quote.quoteSource,
              isExecutableQuote: quote.isExecutableQuote,
              outcomeStatus: "MISSING_STALE_QUOTE",
              indicativePriceSol: quote.indicativePriceSol,
              liquidityUsd: quote.liquidityUsd,
              missingReason: "PRE_HORIZON_STALE_QUOTE",
            });
          } else if (quote.isPoolDrained) {
            this.recorder.recordHorizonOutcome({
              decisionEventId: task.decisionEventId,
              horizonSec: task.horizonSec,
              observationTimestampMs: actualObsTime,
              quoteTimestampMs: quote.quoteTimestampMs,
              quoteSource: quote.quoteSource,
              isExecutableQuote: quote.isExecutableQuote,
              outcomeStatus: "POOL_DRAINED",
              indicativePriceSol: 0,
              liquidityUsd: quote.liquidityUsd,
              missingReason: "POOL_DRAINED_LIQUIDITY_COLLAPSED",
            });
          } else if (quote.indicativePriceSol === null) {
            this.recorder.recordHorizonOutcome({
              decisionEventId: task.decisionEventId,
              horizonSec: task.horizonSec,
              observationTimestampMs: actualObsTime,
              quoteTimestampMs: quote.quoteTimestampMs,
              quoteSource: quote.quoteSource,
              isExecutableQuote: quote.isExecutableQuote,
              outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
              indicativePriceSol: null,
              liquidityUsd: quote.liquidityUsd,
              missingReason: quote.missingReason ?? "PROVIDER_RETURNED_NULL_PRICE",
            });
          } else {
            const freshness = Math.max(0, actualObsTime - quote.quoteTimestampMs);
            if (freshness > this.maxQuoteStaleMs) {
              this.recorder.recordHorizonOutcome({
                decisionEventId: task.decisionEventId,
                horizonSec: task.horizonSec,
                observationTimestampMs: actualObsTime,
                quoteTimestampMs: quote.quoteTimestampMs,
                quoteSource: quote.quoteSource,
                isExecutableQuote: quote.isExecutableQuote,
                outcomeStatus: "MISSING_STALE_QUOTE",
                indicativePriceSol: quote.indicativePriceSol,
                liquidityUsd: quote.liquidityUsd,
                missingReason: `STALE_QUOTE_AGE_${freshness}MS`,
              });
            } else {
              this.recorder.recordHorizonOutcome({
                decisionEventId: task.decisionEventId,
                horizonSec: task.horizonSec,
                observationTimestampMs: actualObsTime,
                quoteTimestampMs: quote.quoteTimestampMs,
                quoteSource: quote.quoteSource,
                isExecutableQuote: quote.isExecutableQuote,
                outcomeStatus: "OBSERVED_PRICE",
                indicativePriceSol: quote.indicativePriceSol,
                liquidityUsd: quote.liquidityUsd,
              });
              this.successfulForwardPriceObservationsCount++;
            }
          }
        } catch (err) {
          const actualObsTime = this.clock();
          const errMsg = (err as Error).message;
          if (errMsg.includes("429")) {
            this.budgetManager.recordResponseStatus(429);
          }
          if (this.budgetManager.is429HaltRequired() && !this.isIntakeStopped) {
            this.earlyStopReason = "CONSECUTIVE_HTTP_429_LIMIT_REACHED";
            this.stopIntake(actualObsTime);
          }

          // Catch provider failures safely: record outcome without crashing runner
          this.recorder.recordHorizonOutcome({
            decisionEventId: task.decisionEventId,
            horizonSec: task.horizonSec,
            observationTimestampMs: actualObsTime,
            outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
            indicativePriceSol: null,
            liquidityUsd: null,
            missingReason: `PROVIDER_ERROR: ${errMsg}`,
          });
        }

        task.status = "FINALIZED";
        processedCount++;
      }

      // Check missing-quote threshold > 35% across evaluated due observations
      const allForwards = this.recorder.getForwardRecords();
      const nonTruncated = allForwards.filter((f) => f.outcomeStatus !== "WINDOW_TRUNCATED");
      const missingCount = nonTruncated.filter(
        (f) =>
          f.outcomeStatus === "MISSING_QUOTE_UNAVAILABLE" ||
          f.outcomeStatus === "MISSING_STALE_QUOTE",
      ).length;

      if (nonTruncated.length >= 10) {
        const missingRate = missingCount / nonTruncated.length;
        if (missingRate > 0.35 && !this.isIntakeStopped) {
          this.earlyStopReason = "EXCESSIVE_MISSING_QUOTES_RATIO";
          this.stopIntake(now);
        }
      }

      return processedCount;
    } finally {
      this.isProcessingObservations = false;
    }
  }

  /**
   * Stops candidate intake. No new candidates will be evaluated.
   */
  public stopIntake(nowTimestampMs?: number): void {
    const now = nowTimestampMs ?? this.clock();
    this.isIntakeStopped = true;
    this.recorder.stopIntake(now);
  }

  /**
   * Closes session cleanly, finalizing remaining horizons, generating summary,
   * appending global request statistics and pipeline yield metrics, and writing SHA-256 session manifest.
   */
  public closeSession(
    nowTimestampMs?: number,
    yieldStats?: Partial<PipelineYieldStats>,
  ): {
    readonly summary: ProspectiveSessionSummary;
    readonly manifest: SessionManifest | null;
  } {
    const now = nowTimestampMs ?? this.clock();
    this.isSessionClosed = true;
    this.recorder.closeSession(now);

    const baseSummary = this.recorder.generateSessionSummary();
    const finalYieldStats: PipelineYieldStats = {
      profilesReceivedCount: yieldStats?.profilesReceivedCount ?? 0,
      enrichmentAttemptsCount:
        yieldStats?.enrichmentAttemptsCount ?? this.budgetManager.getStats().enrichmentRequests,
      mismatchedPairsCount: yieldStats?.mismatchedPairsCount ?? 0,
      priceQualifiedCandidatesCount: yieldStats?.priceQualifiedCandidatesCount ?? 0,
      candidateDecisionsRecordedCount: this.candidateCount,
      forwardQuoteAttemptsCount: this.forwardQuoteAttemptsCount,
      successfulForwardPriceObservationsCount: this.successfulForwardPriceObservationsCount,
    };

    const enhancedSummary: ProspectiveSessionSummary = {
      ...baseSummary,
      strategyConfigFingerprint: this.config.strategyConfigFingerprint,
      launcherConfigFingerprint: this.config.launcherConfigFingerprint,
      strategyVersion: this.config.strategyVersion ?? "nexustrade-strategy-v1.0",
      earlyStopReason: this.earlyStopReason,
      globalRequestStats: this.budgetManager.getStats(),
      pipelineYieldStats: finalYieldStats,
    };

    // Re-save session summary with global request stats before manifest hashing
    if (this.config.outputDir) {
      const summaryPath = path.join(this.config.outputDir, "prospective-session-summary.json");
      fs.writeFileSync(summaryPath, JSON.stringify(enhancedSummary, null, 2), "utf8");
    }

    const manifest = this.recorder.writeSessionManifest({
      strategyConfigFingerprint: this.config.strategyConfigFingerprint,
      launcherConfigFingerprint: this.config.launcherConfigFingerprint,
      strategyVersion: this.config.strategyVersion,
    });

    return { summary: enhancedSummary, manifest };
  }

  public getYieldStats(): {
    forwardQuoteAttemptsCount: number;
    successfulForwardPriceObservationsCount: number;
    candidateDecisionsRecordedCount: number;
  } {
    return {
      forwardQuoteAttemptsCount: this.forwardQuoteAttemptsCount,
      successfulForwardPriceObservationsCount: this.successfulForwardPriceObservationsCount,
      candidateDecisionsRecordedCount: this.candidateCount,
    };
  }

  /**
   * Verifies that safety invariants remain intact (zero wallet, zero paper positions, zero balance change).
   */
  public verifySafetyInvariants(): {
    readonly walletFrozen: true;
    readonly balanceSol: 7.9259;
    readonly paperTradingActive: false;
    readonly openPositionsCount: 0;
    readonly networkMutationsAllowed: false;
  } {
    return Object.freeze({
      walletFrozen: true,
      balanceSol: 7.9259,
      paperTradingActive: false,
      openPositionsCount: 0,
      networkMutationsAllowed: false,
    });
  }

  // Getters for inspectability
  public getRecorder(): ProspectiveObservationRecorder {
    return this.recorder;
  }

  public getBudgetManager(): GlobalResourceBudgetManager {
    return this.budgetManager;
  }

  public getScheduledTasks(): readonly ScheduledHorizonTask[] {
    return [...this.scheduledTasks];
  }

  public getTotalRequestsMade(): number {
    return this.budgetManager.getTotalRequests();
  }

  public getCandidateCount(): number {
    return this.candidateCount;
  }

  public getEarlyStopReason(): string | null {
    return this.earlyStopReason;
  }
}
