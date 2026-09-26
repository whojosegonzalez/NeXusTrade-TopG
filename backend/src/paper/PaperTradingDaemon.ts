import type { Repositories } from "../db/repositories/index.js";
import { nowMs } from "../db/utils/timestamps.js";
import { DynamicRatchetService } from "../exits/DynamicRatchetService.js";
import type {
  ExitReasonCode,
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
  readonly antiRebuyCooldownMs?: number; // default: 1800000 (30m)
  readonly uninterruptedResearchMode?: boolean; // default: false
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
  lastActivityMs: number;
  stagnantTicksCount: number;
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

export type DaemonStatus =
  | "IDLE"
  | "RUNNING"
  | "PAUSED"
  | "EXITING"
  | "COMPLETED"
  | "STOPPED"
  | "HALTED";

export interface PaperTradingDaemonSnapshot {
  readonly sessionId: string;
  readonly status: DaemonStatus;
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

  private status: DaemonStatus = "IDLE";
  private haltReason: DaemonHaltReason | undefined;
  private consecutiveErrorCount = 0;
  private readonly startedAtMs: number;
  private lastTickAtMs: number;

  private currentCashSol: number;
  private readonly openPositions = new Map<string, PaperPosition>();
  private readonly closedTrades: ClosedTradeRecord[] = [];
  private readonly exitCooldowns = new Map<string, number>();

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
    if (this.status === "RUNNING") return;
    this.status = "RUNNING";
    this.haltReason = undefined;
  }

  pause(): void {
    if (this.status === "RUNNING") {
      this.status = "PAUSED";
    }
  }

  resume(): void {
    if (this.status === "PAUSED") {
      this.status = "RUNNING";
    }
  }

  startExiting(): void {
    if (this.status === "HALTED" || this.status === "STOPPED" || this.status === "COMPLETED") {
      return;
    }
    if (this.openPositions.size === 0) {
      this.status = "COMPLETED";
    } else {
      this.status = "EXITING";
    }
  }

  stop(reason: DaemonHaltReason = "MANUAL_STOP"): void {
    this.status = reason === "MANUAL_STOP" ? "STOPPED" : "HALTED";
    this.haltReason = reason;
  }

  manualExit(
    positionId: string,
    currentSpotPriceSol?: number,
    nowTimestampMs?: number,
  ): ClosedTradeRecord | null {
    const position = this.openPositions.get(positionId);
    if (!position) return null;

    const now = nowTimestampMs ?? this.clock();
    const exitPriceSol = currentSpotPriceSol ?? position.spotPriceSol;
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
      exitReason: "MANUAL_OPERATOR_EXIT",
      openedAtMs: position.openedAtMs,
      closedAtMs: now,
    };

    this.closedTrades.push(closedRecord);
    this.openPositions.delete(positionId);
    this.ratchetService.getStore().delete(positionId);

    const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
    this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

    if (this.status === "EXITING" && this.openPositions.size === 0) {
      this.status = "COMPLETED";
    }

    return closedRecord;
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
      status: this.status,
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

  processScannedPool(
    pool: ScannedPoolRecord,
    nowTimestampMs?: number,
    entryPriceSolOverride?: number,
  ): boolean {
    if (this.status !== "RUNNING") return false;
    const now = nowTimestampMs ?? this.clock();

    // 1. Position Sizing & Capacity Check
    if (this.openPositions.size >= this.config.maxOpenPositions) {
      return false;
    }
    if (this.currentCashSol < this.config.positionSizeSol) {
      return false;
    }

    // 1b. Single Position Per Mint Check
    for (const openPos of this.openPositions.values()) {
      if (openPos.mintAddress === pool.mintAddress) {
        return false;
      }
    }

    // 1c. Anti-Rebuy Cooldown Check
    const cooldownUntilMs = this.exitCooldowns.get(pool.mintAddress);
    if (cooldownUntilMs !== undefined && now < cooldownUntilMs) {
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
    const entryPriceSol =
      entryPriceSolOverride !== undefined ? entryPriceSolOverride : pool.spotPriceUsd;

    // Discard non-positive or non-finite entry prices
    if (!entryPriceSol || entryPriceSol <= 0 || !Number.isFinite(entryPriceSol)) {
      return false;
    }

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
      lastActivityMs: now,
      stagnantTicksCount: 0,
    };

    this.openPositions.set(positionId, position);
    return true;
  }

  tickPosition(
    positionId: string,
    marketContext: MarketEvaluationContext,
    nowTimestampMs?: number,
  ): RatchetEvaluationResult | null {
    if (this.status !== "RUNNING" && this.status !== "PAUSED" && this.status !== "EXITING") {
      return null;
    }
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

      // 2. Inactivity Tracking & 5-Minute Stagnancy Timeout
      const priceChanged = Math.abs(marketContext.spotPriceSol - position.spotPriceSol) > 1e-9;
      const hasRecentActivity =
        (marketContext.recentBuysCount60s ?? 0) > 0 ||
        (marketContext.recentSellsCount60s ?? 0) > 0 ||
        !marketContext.volumeStalled3m;

      if (priceChanged || hasRecentActivity) {
        position.lastActivityMs = now;
        position.stagnantTicksCount = 0;
      } else {
        position.stagnantTicksCount += 1;
      }

      // If position has had no activity for >= 5 minutes (300,000ms), force stagnancy exit
      if (now - position.lastActivityMs >= 300_000) {
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
          exitReason: "STAGNANCY_TIMEOUT_EXIT",
          openedAtMs: position.openedAtMs,
          closedAtMs: now,
        };

        this.closedTrades.push(closedRecord);
        this.openPositions.delete(positionId);
        this.ratchetService.getStore().delete(positionId);

        const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
        this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

        if (this.status === "EXITING" && this.openPositions.size === 0) {
          this.status = "COMPLETED";
        }

        return {
          action: "SELL_ALL",
          reasonCode: "STAGNANCY_TIMEOUT_EXIT" as unknown as ExitReasonCode,
          diagnostics: {
            currentPnlBps: realizedPnlBps,
            peakGainBps: position.ratchetState.peakGainBps,
            currentStopFloorBps: position.ratchetState.currentStopFloorBps,
            activeTier: position.ratchetState.activeTier,
            drawdownState: position.ratchetState.drawdownState,
            drawdownElapsedMs: null,
            lpIntact: marketContext.lpIntact,
            buySellRatio60s:
              marketContext.recentBuysCount60s / Math.max(1, marketContext.recentSellsCount60s),
            momentum5mBps: marketContext.momentum5mBps,
          },
          updatedState: position.ratchetState,
        };
      }

      // 3. Evaluate Dynamic Ratchet Stop-Loss Engine
      const result = this.ratchetService.evaluate(position.ratchetState, marketContext);

      // Update position pricing state
      position.spotPriceSol = marketContext.spotPriceSol;
      position.currentPnlBps = result.diagnostics.currentPnlBps;
      position.ratchetState = result.updatedState;

      // 4. If Sell Triggered, Execute Market Close
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

        const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
        this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

        if (this.status === "EXITING" && this.openPositions.size === 0) {
          this.status = "COMPLETED";
        }
      }

      // 5. Portfolio Drawdown Circuit Breaker
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

  recordStagnantTick(positionId: string, nowTimestampMs?: number): ClosedTradeRecord | null {
    const position = this.openPositions.get(positionId);
    if (!position) return null;
    const now = nowTimestampMs ?? this.clock();
    this.lastTickAtMs = now;
    position.stagnantTicksCount += 1;

    // Check if inactivity has reached 5 minutes (300,000ms)
    if (now - position.lastActivityMs >= 300_000) {
      const exitPriceSol = position.spotPriceSol;
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
        exitReason: "STAGNANCY_TIMEOUT_EXIT",
        openedAtMs: position.openedAtMs,
        closedAtMs: now,
      };

      this.closedTrades.push(closedRecord);
      this.openPositions.delete(positionId);
      this.ratchetService.getStore().delete(positionId);

      const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
      this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

      if (this.status === "EXITING" && this.openPositions.size === 0) {
        this.status = "COMPLETED";
      }

      return closedRecord;
    }

    return null;
  }

  private checkPortfolioCircuitBreakers(): void {
    const snapshot = this.getSnapshot();
    const portfolioPnlBps = Math.round(
      ((snapshot.currentPortfolioSol - snapshot.initialPortfolioSol) /
        snapshot.initialPortfolioSol) *
        10_000,
    );

    if (portfolioPnlBps <= this.config.maxPortfolioDrawdownBps) {
      if (this.config.uninterruptedResearchMode) {
        this.haltReason = "PORTFOLIO_DRAWDOWN_BREACHED";
      } else {
        this.stop("PORTFOLIO_DRAWDOWN_BREACHED");
      }
    }
  }

  getExitCooldowns(): ReadonlyMap<string, number> {
    return this.exitCooldowns;
  }
}
