import type { Repositories } from "../db/repositories/index.js";
import { nowMs } from "../db/utils/timestamps.js";
import { DynamicRatchetService } from "../exits/DynamicRatchetService.js";
import type {
  MarketEvaluationContext,
  PositionRatchetState,
  RatchetEvaluationResult,
} from "../exits/DynamicRatchetTypes.js";
import { CandidateScannerEvaluator } from "../candidate-scanner/CandidateScannerEvaluator.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import type {
  CandidateScannerRuntimeConfig,
  ScannedPoolRecord,
} from "../candidate-scanner/CandidateScannerTypes.js";

export type DaemonHaltReason =
  | "PORTFOLIO_DRAWDOWN_BREACHED"
  | "CONSECUTIVE_ERRORS_EXCEEDED"
  | "CLOCK_DRIFT_EXCEEDED"
  | "MANUAL_STOP"
  | "DURATION_ELAPSED";

export interface PaperTradingDaemonConfig {
  readonly sessionId: string;
  readonly durationHours: number;
  readonly maxOpenPositions: number;
  readonly positionSizeSol: number;
  readonly initialPortfolioSol: number;
  readonly maxPortfolioDrawdownBps: number; // default -500 (-5.0%)
  readonly maxConsecutiveErrors: number; // default 3
  readonly maxClockDriftMs: number; // default 5000 (5s)
  readonly pollIntervalMs: number; // default 1000ms
  readonly dryRun: boolean;
  readonly scannerConfig?: CandidateScannerRuntimeConfig;
}

export interface PaperPosition {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly entryPriceSol: number;
  readonly tokensHeld: number;
  readonly costBasisSol: number;
  readonly openedAtMs: number;
  spotPriceSol: number;
  currentPnlBps: number;
  ratchetState: PositionRatchetState;
}

export interface ClosedTradeRecord {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly entryPriceSol: number;
  readonly exitPriceSol: number;
  readonly costBasisSol: number;
  readonly proceedsSol: number;
  readonly realizedPnlSol: number;
  readonly realizedPnlBps: number;
  readonly exitReason: string;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
}

export interface PaperTradingDaemonSnapshot {
  readonly sessionId: string;
  readonly status: "RUNNING" | "STOPPED" | "HALTED";
  readonly haltReason?: DaemonHaltReason | undefined;
  readonly openPositions: readonly PaperPosition[];
  readonly closedTrades: readonly ClosedTradeRecord[];
  readonly initialPortfolioSol: number;
  readonly currentPortfolioSol: number;
  readonly totalRealizedPnlSol: number;
  readonly totalUnrealizedPnlSol: number;
  readonly consecutiveErrorCount: number;
  readonly startedAtMs: number;
  readonly lastTickAtMs: number;
}

export interface PaperTradingDaemonOptions {
  readonly config: PaperTradingDaemonConfig;
  readonly repositories?: Repositories;
  readonly ratchetService?: DynamicRatchetService;
  readonly scannerEvaluator?: CandidateScannerEvaluator;
  readonly clock?: () => number;
}

export class PaperTradingDaemon {
  private readonly config: PaperTradingDaemonConfig;
  private readonly scannerConfig: CandidateScannerRuntimeConfig;
  private readonly ratchetService: DynamicRatchetService;
  private readonly scannerEvaluator: CandidateScannerEvaluator;
  private readonly clock: () => number;

  private isRunning = false;
  private haltReason: DaemonHaltReason | undefined;
  private consecutiveErrorCount = 0;
  private readonly startedAtMs: number;
  private lastTickAtMs: number;

  private currentCashSol: number;
  private readonly openPositions = new Map<string, PaperPosition>();
  private readonly closedTrades: ClosedTradeRecord[] = [];

  constructor(options: PaperTradingDaemonOptions) {
    this.config = options.config;
    this.scannerConfig = options.config.scannerConfig ?? CANDIDATE_SCANNER_DEFAULTS;
    this.ratchetService = options.ratchetService ?? new DynamicRatchetService();
    this.scannerEvaluator = options.scannerEvaluator ?? new CandidateScannerEvaluator();
    this.clock = options.clock ?? nowMs;

    this.currentCashSol = this.config.initialPortfolioSol;
    this.startedAtMs = this.clock();
    this.lastTickAtMs = this.startedAtMs;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.haltReason = undefined;
  }

  stop(reason: DaemonHaltReason = "MANUAL_STOP"): void {
    this.isRunning = false;
    this.haltReason = reason;
  }

  getSnapshot(): PaperTradingDaemonSnapshot {
    const openPositionsArray = Array.from(this.openPositions.values());
    const totalUnrealizedPnlSol = openPositionsArray.reduce((acc, pos) => {
      const currentValSol = pos.tokensHeld * pos.spotPriceSol;
      return acc + (currentValSol - pos.costBasisSol);
    }, 0);

    const totalRealizedPnlSol = this.closedTrades.reduce(
      (acc, trade) => acc + trade.realizedPnlSol,
      0,
    );

    const totalPositionEquitySol = openPositionsArray.reduce(
      (acc, pos) => acc + pos.tokensHeld * pos.spotPriceSol,
      0,
    );

    const currentPortfolioSol = this.currentCashSol + totalPositionEquitySol;

    return {
      sessionId: this.config.sessionId,
      status: this.isRunning ? "RUNNING" : this.haltReason ? "HALTED" : "STOPPED",
      ...(this.haltReason ? { haltReason: this.haltReason } : {}),
      openPositions: openPositionsArray,
      closedTrades: [...this.closedTrades],
      initialPortfolioSol: this.config.initialPortfolioSol,
      currentPortfolioSol,
      totalRealizedPnlSol,
      totalUnrealizedPnlSol,
      consecutiveErrorCount: this.consecutiveErrorCount,
      startedAtMs: this.startedAtMs,
      lastTickAtMs: this.lastTickAtMs,
    };
  }

  processScannedPool(pool: ScannedPoolRecord, nowTimestampMs?: number): boolean {
    if (!this.isRunning) return false;
    const now = nowTimestampMs ?? this.clock();

    // 1. Position Sizing & Capacity Check
    if (this.openPositions.size >= this.config.maxOpenPositions) {
      return false;
    }
    if (this.currentCashSol < this.config.positionSizeSol) {
      return false;
    }

    // 2. Anti-Rug & L/MC Evaluation Check
    const nowSec = Math.floor(now / 1000);
    const evaluation = this.scannerEvaluator.evaluate(pool, this.scannerConfig, nowSec);
    if (!evaluation.admitted) {
      return false;
    }

    // 3. Execute Paper Buy
    const positionId = `pos-${pool.mintAddress}-${now}`;
    const entryPriceSol = pool.spotPriceUsd; // Using unit price
    const tokensHeld = this.config.positionSizeSol / entryPriceSol;
    const costBasisSol = this.config.positionSizeSol;

    this.currentCashSol -= costBasisSol;

    const ratchetState = this.ratchetService
      .getStore()
      .initPositionState(positionId, pool.mintAddress, entryPriceSol, now);

    const position: PaperPosition = {
      positionId,
      mintAddress: pool.mintAddress,
      entryPriceSol,
      tokensHeld,
      costBasisSol,
      openedAtMs: now,
      spotPriceSol: entryPriceSol,
      currentPnlBps: 0,
      ratchetState,
    };

    this.openPositions.set(positionId, position);
    return true;
  }

  tickPosition(
    positionId: string,
    marketContext: MarketEvaluationContext,
    nowTimestampMs?: number,
  ): RatchetEvaluationResult | null {
    if (!this.isRunning) return null;
    const now = nowTimestampMs ?? this.clock();
    this.lastTickAtMs = now;

    const position = this.openPositions.get(positionId);
    if (!position) return null;

    try {
      // 1. Clock Drift Safety Tripwire
      if (Math.abs(now - marketContext.currentTimestampMs) > this.config.maxClockDriftMs) {
        this.stop("CLOCK_DRIFT_EXCEEDED");
        throw new Error(
          `Clock drift violation: diff ${Math.abs(now - marketContext.currentTimestampMs)}ms > max ${this.config.maxClockDriftMs}ms`,
        );
      }

      // 2. Evaluate Dynamic Ratchet Stop-Loss Engine
      const result = this.ratchetService.evaluate(position.ratchetState, marketContext);

      // Update position pricing state
      position.spotPriceSol = marketContext.spotPriceSol;
      position.currentPnlBps = result.diagnostics.currentPnlBps;
      position.ratchetState = result.updatedState;

      // 3. If Sell Triggered, Execute Market Close
      if (result.action === "SELL_ALL") {
        const exitPriceSol = marketContext.spotPriceSol;
        const proceedsSol = position.tokensHeld * exitPriceSol;
        const realizedPnlSol = proceedsSol - position.costBasisSol;
        const realizedPnlBps = Math.round(
          ((exitPriceSol - position.entryPriceSol) / position.entryPriceSol) * 10_000,
        );

        this.currentCashSol += proceedsSol;

        const closedRecord: ClosedTradeRecord = {
          positionId: position.positionId,
          mintAddress: position.mintAddress,
          entryPriceSol: position.entryPriceSol,
          exitPriceSol,
          costBasisSol: position.costBasisSol,
          proceedsSol,
          realizedPnlSol,
          realizedPnlBps,
          exitReason: result.reasonCode,
          openedAtMs: position.openedAtMs,
          closedAtMs: now,
        };

        this.closedTrades.push(closedRecord);
        this.openPositions.delete(positionId);
        this.ratchetService.getStore().delete(positionId);
      }

      // 4. Portfolio Drawdown Circuit Breaker
      this.checkPortfolioCircuitBreakers();

      this.consecutiveErrorCount = 0;
      return result;
    } catch (err) {
      this.consecutiveErrorCount += 1;
      if (this.consecutiveErrorCount >= this.config.maxConsecutiveErrors) {
        this.stop("CONSECUTIVE_ERRORS_EXCEEDED");
      }
      throw err;
    }
  }

  private checkPortfolioCircuitBreakers(): void {
    const snapshot = this.getSnapshot();
    const portfolioPnlBps = Math.round(
      ((snapshot.currentPortfolioSol - snapshot.initialPortfolioSol) /
        snapshot.initialPortfolioSol) *
        10_000,
    );

    if (portfolioPnlBps <= this.config.maxPortfolioDrawdownBps) {
      this.stop("PORTFOLIO_DRAWDOWN_BREACHED");
    }
  }
}
