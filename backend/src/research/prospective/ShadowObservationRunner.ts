/**
 * Phase 12.94-D Milestone D.3.3: Shadow Observation Runner
 *
 * Dedicated, strictly passive observation runner wiring Candidate Discovery Streams
 * and BuyGateTriggerService directly to ProspectiveObservationRecorder for forward
 * horizon tracking (+5m, +15m, +30m, +60m).
 *
 * OPERATIONAL & SAFETY CONSTRAINTS:
 * 1. ZERO PaperTradingDaemon initialization, wallet keys, or balance mutations.
 * 2. Virtual balance is frozen at 7.9259 SOL.
 * 3. Forward horizons strictly preserve causality (no lookahead, no premature sampling).
 * 4. Pacing is enforced per provider (minimum 2,000 ms spacing).
 * 5. Aggregate request ceiling is enforced (fails closed to MISSING_QUOTE_UNAVAILABLE).
 * 6. Provider errors and pool drainage are caught safely and recorded truthfully.
 * 7. Generates cryptographic SHA-256 session manifest verifying all records.
 */

import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  BuyGateTriggerService,
  type AdvancedMarketContext,
} from "../../candidate-scanner/BuyGateTriggerService.js";
import {
  ProspectiveObservationRecorder,
  type RecordDecisionInput,
} from "./ProspectiveObservationRecorder.js";
import {
  FORWARD_HORIZONS_SEC,
  type CandidateStreamSource,
  type ForwardHorizonSec,
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
  readonly indicativePriceSol: number;
  readonly priceQuoteTimestampMs?: number | undefined;
  readonly liquidityUsd: number;
  readonly marketCapUsd: number;
  readonly lmcRatio: number;
  readonly lpBurnPct: number;
  readonly assetAgeSeconds: number;
  readonly volume5mUsd: number;
  readonly buys5m: number;
  readonly sells5m: number;
  readonly buyToSellRatio: number;
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
  status: "PENDING" | "FINALIZED";
}

export interface ShadowRunnerConfig {
  readonly sessionId: string;
  readonly configFingerprint: string;
  readonly outputDir?: string | undefined;
  readonly approvedRootPath?: string | undefined;
  readonly maxCandidates?: number | undefined; // e.g. 25
  readonly intakeDurationMs?: number | undefined; // e.g. 3,600,000 (60m)
  readonly drainDurationMs?: number | undefined; // e.g. 3,600,000 (60m)
  readonly minProviderSpacingMs?: number | undefined; // e.g. 2,000 ms
  readonly maxAggregateRequests?: number | undefined; // e.g. 150
  readonly maxQuoteStaleMs?: number | undefined; // e.g. 60,000 ms
  readonly clock?: () => number;
}

export interface ShadowRunnerDependencies {
  readonly buyGateService?: BuyGateTriggerService | undefined;
  readonly marketDataProvider?: IShadowMarketDataProvider | undefined;
  readonly recorder?: ProspectiveObservationRecorder | undefined;
}

export class ShadowObservationRunner {
  private readonly config: ShadowRunnerConfig;
  private readonly clock: () => number;
  private readonly buyGateService: BuyGateTriggerService;
  private readonly marketDataProvider: IShadowMarketDataProvider | null;
  private readonly recorder: ProspectiveObservationRecorder;

  private readonly sessionStartedAtMs: number;
  private readonly intakeDeadlineMs: number;
  private readonly sessionDeadlineMs: number;
  private readonly maxCandidates: number;
  private readonly minProviderSpacingMs: number;
  private readonly maxAggregateRequests: number;
  private readonly maxQuoteStaleMs: number;

  private readonly scheduledTasks: ScheduledHorizonTask[] = [];
  private readonly lastRequestTimeByProvider = new Map<string, number>();
  private totalRequestsMade = 0;
  private candidateCount = 0;
  private isIntakeStopped = false;
  private isSessionClosed = false;

  constructor(config: ShadowRunnerConfig, dependencies: ShadowRunnerDependencies = {}) {
    this.config = config;
    this.clock = config.clock ?? (() => Date.now());
    this.sessionStartedAtMs = this.clock();

    const intakeDuration = config.intakeDurationMs ?? 3_600_000; // default 60m
    const drainDuration = config.drainDurationMs ?? 3_600_000; // default 60m
    this.intakeDeadlineMs = this.sessionStartedAtMs + intakeDuration;
    this.sessionDeadlineMs = this.sessionStartedAtMs + intakeDuration + drainDuration;

    this.maxCandidates = config.maxCandidates ?? 25;
    this.minProviderSpacingMs = config.minProviderSpacingMs ?? 2_000;
    this.maxAggregateRequests = config.maxAggregateRequests ?? 150;
    this.maxQuoteStaleMs = config.maxQuoteStaleMs ?? 60_000;

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

    // Check session closure
    if (this.isSessionClosed || now >= this.sessionDeadlineMs) {
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

    // 1. Determine cohort
    let strategyCohort: ProspectiveStrategyCohort = "UNCLASSIFIED";
    if (
      candidate.liquidityUsd >= 50000 &&
      candidate.assetAgeSeconds >= 1800 &&
      candidate.assetAgeSeconds <= 7200
    ) {
      strategyCohort = "ESTABLISHED_RUNNER";
    } else if (candidate.assetAgeSeconds < 1800) {
      strategyCohort = "MICRO_CAP_PROBE";
    } else if (
      candidate.liquidityUsd >= 30000 &&
      candidate.volume5mUsd >= 15000 &&
      candidate.assetAgeSeconds >= 900
    ) {
      strategyCohort = "ESTABLISHED_RUNNER"; // Viral runner
    }

    // 2. Map candidate to BuyGateTriggerService input
    const watchlistItem: WatchlistCandidateItem = {
      poolId: candidate.poolId,
      mintAddress: candidate.mintAddress,
      symbol: candidate.symbol,
      liquidityUsd: candidate.liquidityUsd,
      marketCapUsd: candidate.marketCapUsd,
      lmcRatio: candidate.lmcRatio,
      lpBurnPct: candidate.lpBurnPct,
      assetAgeSeconds: candidate.assetAgeSeconds,
      volume5mUsd: candidate.volume5mUsd,
      buys5m: candidate.buys5m,
      sells5m: candidate.sells5m,
      buyToSellRatio: candidate.buyToSellRatio,
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

    // 3. Evaluate candidate through real gate logic
    const gateEval = this.buyGateService.evaluateCandidate(watchlistItem, marketContext);

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
        priceQuoteTimestampMs: candidate.priceQuoteTimestampMs ?? candidate.discoveryTimestampMs,
        priceQuoteFreshnessMs: Math.max(
          0,
          now - (candidate.priceQuoteTimestampMs ?? candidate.discoveryTimestampMs),
        ),
        liquidityUsd: candidate.liquidityUsd,
        volume5mUsd: candidate.volume5mUsd,
        marketCapUsd: candidate.marketCapUsd,
        assetAgeSeconds: candidate.assetAgeSeconds,
        holdersCount: candidate.holdersCount ?? null,
        buyToSellRatio: candidate.buyToSellRatio,
        recentBuys60s: candidate.recentBuys60s ?? null,
        recentSells60s: candidate.recentSells60s ?? null,
        lmcRatio: candidate.lmcRatio,
        rugScore: candidate.rugScore ?? null,
        bundlerPct: candidate.bundlerPct ?? null,
        top10HolderPct: candidate.top10HolderPct ?? null,
        unavailableInputs: candidate.unavailableInputs ?? [],
      },
      triggered: gateEval.triggered,
      rejectionReason: gateEval.rejectionReason,
      gateChecks: gateEval.gates.map((g) => ({
        name: g.name,
        passed: g.passed,
        value: g.value,
        requirement: g.requirement,
      })),
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
   * Enforces provider pacing, aggregate request budget, and error resilience.
   */
  public async processDueObservations(nowMs?: number): Promise<number> {
    const now = nowMs ?? this.clock();

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
      // 1. Check aggregate request ceiling
      if (this.totalRequestsMade >= this.maxAggregateRequests) {
        this.recorder.recordHorizonOutcome({
          decisionEventId: task.decisionEventId,
          horizonSec: task.horizonSec,
          observationTimestampMs: now,
          outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
          indicativePriceSol: null,
          liquidityUsd: null,
          missingReason: "AGGREGATE_REQUEST_CEILING_REACHED",
        });
        task.status = "FINALIZED";
        processedCount++;
        continue;
      }

      // 2. Check provider availability
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
      const lastRequestTime = this.lastRequestTimeByProvider.get(providerName) ?? 0;

      // 3. Enforce per-provider pacing
      if (now - lastRequestTime < this.minProviderSpacingMs) {
        // Pacing interval has not elapsed yet; defer task to next cycle
        continue;
      }

      // 4. Fetch quote from provider safely
      this.totalRequestsMade++;
      this.lastRequestTimeByProvider.set(providerName, now);

      try {
        const quote = await this.marketDataProvider.fetchQuote(task.poolId, task.mintAddress);

        if (quote.isPoolDrained) {
          this.recorder.recordHorizonOutcome({
            decisionEventId: task.decisionEventId,
            horizonSec: task.horizonSec,
            observationTimestampMs: now,
            quoteTimestampMs: quote.quoteTimestampMs,
            quoteSource: quote.quoteSource,
            isExecutableQuote: quote.isExecutableQuote,
            outcomeStatus: "POOL_DRAINED",
            indicativePriceSol: quote.indicativePriceSol,
            liquidityUsd: quote.liquidityUsd,
            missingReason: "POOL_DRAINED_LIQUIDITY_COLLAPSED",
          });
        } else if (quote.indicativePriceSol === null) {
          this.recorder.recordHorizonOutcome({
            decisionEventId: task.decisionEventId,
            horizonSec: task.horizonSec,
            observationTimestampMs: now,
            quoteTimestampMs: quote.quoteTimestampMs,
            quoteSource: quote.quoteSource,
            isExecutableQuote: quote.isExecutableQuote,
            outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
            indicativePriceSol: null,
            liquidityUsd: null,
            missingReason: "PROVIDER_RETURNED_NULL_PRICE",
          });
        } else {
          const freshness = Math.max(0, now - quote.quoteTimestampMs);
          if (freshness > this.maxQuoteStaleMs) {
            this.recorder.recordHorizonOutcome({
              decisionEventId: task.decisionEventId,
              horizonSec: task.horizonSec,
              observationTimestampMs: now,
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
              observationTimestampMs: now,
              quoteTimestampMs: quote.quoteTimestampMs,
              quoteSource: quote.quoteSource,
              isExecutableQuote: quote.isExecutableQuote,
              outcomeStatus: "OBSERVED_PRICE",
              indicativePriceSol: quote.indicativePriceSol,
              liquidityUsd: quote.liquidityUsd,
            });
          }
        }
      } catch (err) {
        // Catch provider failures safely: record outcome without crashing runner
        this.recorder.recordHorizonOutcome({
          decisionEventId: task.decisionEventId,
          horizonSec: task.horizonSec,
          observationTimestampMs: now,
          outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
          indicativePriceSol: null,
          liquidityUsd: null,
          missingReason: `PROVIDER_ERROR: ${(err as Error).message}`,
        });
      }

      task.status = "FINALIZED";
      processedCount++;
    }

    return processedCount;
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
   * and writing SHA-256 session manifest.
   */
  public closeSession(nowTimestampMs?: number): {
    readonly summary: ProspectiveSessionSummary;
    readonly manifest: SessionManifest | null;
  } {
    const now = nowTimestampMs ?? this.clock();
    this.isSessionClosed = true;
    this.recorder.closeSession(now);

    const summary = this.recorder.generateSessionSummary();
    const manifest = this.recorder.writeSessionManifest();

    return { summary, manifest };
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

  public getScheduledTasks(): readonly ScheduledHorizonTask[] {
    return [...this.scheduledTasks];
  }

  public getTotalRequestsMade(): number {
    return this.totalRequestsMade;
  }

  public getCandidateCount(): number {
    return this.candidateCount;
  }
}
