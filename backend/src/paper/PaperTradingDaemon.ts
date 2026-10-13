import type { Repositories } from "../db/repositories/index.js";
import { nowMs } from "../db/utils/timestamps.js";
import { DynamicRatchetService } from "../exits/DynamicRatchetService.js";
import type {
  CohortTier,
  DynamicRatchetConfig,
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
import type { HistoricalSessionSummary, HistoricalTrade } from "@nexustrade/shared";
import type { UnresolvedTokenInventory } from "./VirtualWallet.js";

export type DaemonHaltReason =
  | "PORTFOLIO_DRAWDOWN_BREACHED"
  | "CONSECUTIVE_ERRORS_EXCEEDED"
  | "CLOCK_DRIFT_EXCEEDED"
  | "MANUAL_STOP"
  | "DURATION_ELAPSED"
  | "SCHEDULE_WINDOW_CONCLUDED";

export interface TradingScheduleConfig {
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly timeZone: string;
  readonly rawString: string;
}

export function parseScheduleString(scheduleStr: string): TradingScheduleConfig | undefined {
  const trimmed = scheduleStr.trim();
  const match = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})(?::([a-zA-Z0-9_/]+))?$/.exec(trimmed);
  if (!match) {
    console.warn(
      `[PaperDaemon] Invalid --schedule format: "${scheduleStr}". Expected HH:MM-HH:MM[:TZ] (e.g. 07:00-17:30:PDT)`,
    );
    return undefined;
  }
  const startStr = match[1];
  const endStr = match[2];
  const rawTz = match[3];
  if (!startStr || !endStr) return undefined;

  const startParts = startStr.split(":");
  const endParts = endStr.split(":");
  const sh = Number(startParts[0]);
  const sm = Number(startParts[1]);
  const eh = Number(endParts[0]);
  const em = Number(endParts[1]);

  if (
    !Number.isFinite(sh) ||
    !Number.isFinite(sm) ||
    !Number.isFinite(eh) ||
    !Number.isFinite(em)
  ) {
    return undefined;
  }

  if (sh < 0 || sh > 23 || sm < 0 || sm > 59 || eh < 0 || eh > 23 || em < 0 || em > 59) {
    console.warn(`[PaperDaemon] Invalid hour/minute in --schedule: "${scheduleStr}"`);
    return undefined;
  }
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  let timeZone = "America/Los_Angeles";
  if (rawTz) {
    const upperTz = rawTz.toUpperCase();
    if (upperTz === "PDT" || upperTz === "PST" || upperTz === "PT" || upperTz === "PACIFIC") {
      timeZone = "America/Los_Angeles";
    } else if (
      upperTz === "EDT" ||
      upperTz === "EST" ||
      upperTz === "ET" ||
      upperTz === "EASTERN"
    ) {
      timeZone = "America/New_York";
    } else if (
      upperTz === "CDT" ||
      upperTz === "CST" ||
      upperTz === "CT" ||
      upperTz === "CENTRAL"
    ) {
      timeZone = "America/Chicago";
    } else if (
      upperTz === "MDT" ||
      upperTz === "MST" ||
      upperTz === "MT" ||
      upperTz === "MOUNTAIN"
    ) {
      timeZone = "America/Denver";
    } else if (upperTz === "UTC" || upperTz === "GMT") {
      timeZone = "UTC";
    } else {
      timeZone = rawTz;
    }
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    console.warn(
      `[PaperDaemon] Unrecognized timezone "${rawTz}", falling back to "America/Los_Angeles"`,
    );
    timeZone = "America/Los_Angeles";
  }

  return {
    startMinutes,
    endMinutes,
    timeZone,
    rawString: scheduleStr,
  };
}

export function isWithinTradingSchedule(
  timestampMs: number,
  schedule: TradingScheduleConfig,
): { isWithin: boolean; currentMinutes: number; minutesUntilNext: number } {
  const date = new Date(timestampMs);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    hour12: false,
    hour: "numeric",
    minute: "numeric",
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const currentMinutes = (hour % 24) * 60 + minute;

  let isWithin = false;
  if (schedule.startMinutes <= schedule.endMinutes) {
    isWithin = currentMinutes >= schedule.startMinutes && currentMinutes < schedule.endMinutes;
  } else {
    isWithin = currentMinutes >= schedule.startMinutes || currentMinutes < schedule.endMinutes;
  }

  let minutesUntilNext = 0;
  if (!isWithin) {
    if (schedule.startMinutes <= schedule.endMinutes) {
      if (currentMinutes < schedule.startMinutes) {
        minutesUntilNext = schedule.startMinutes - currentMinutes;
      } else {
        minutesUntilNext = 24 * 60 - currentMinutes + schedule.startMinutes;
      }
    } else {
      minutesUntilNext =
        currentMinutes < schedule.startMinutes
          ? schedule.startMinutes - currentMinutes
          : 24 * 60 - currentMinutes + schedule.startMinutes;
    }
  }

  return { isWithin, currentMinutes, minutesUntilNext };
}

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
  readonly tradingSchedule?: TradingScheduleConfig | undefined;
}

export interface PaperPosition {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  entryPriceSol: number;
  initialTokensHeld?: number;
  initialCostBasisSol?: number;
  readonly cohort?: CohortTier | undefined;
  readonly ratchetConfig?: DynamicRatchetConfig | undefined;
  tokensHeld: number;
  costBasisSol: number;
  realizedProceedsSol?: number;
  readonly openedAtMs: number;
  spotPriceSol: number;
  currentPnlBps: number;
  ratchetState: PositionRatchetState;
  lastActivityMs: number;
  lastValidPriceObservedAtMs?: number | undefined;
  stagnantTicksCount: number;
  feedOutageTicksCount?: number | undefined;
  pyramided?: boolean | undefined;
  scaleInCount?: number | undefined;
  tier1ProfitTaken?: boolean | undefined;
  tier2ProfitTaken?: boolean | undefined;
  peakGainBps?: number | undefined;
  historicalPeakPriceSol?: number | undefined;
}

export interface ClosedTradeRecord {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  readonly entryPriceSol: number;
  readonly exitPriceSol: number;
  readonly costBasisSol: number;
  readonly proceedsSol: number;
  readonly realizedPnlSol: number;
  readonly realizedPnlBps: number;
  readonly peakGainBps?: number | undefined;
  readonly exitReason: string;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly finalTier?: "BASELINE" | "TIER_1" | "TIER_2" | undefined;
}

export interface UnresolvedPositionRecord {
  readonly positionId: string;
  readonly mintAddress: string;
  readonly symbol?: string | undefined;
  readonly tokensHeld: number;
  readonly costBasisSol: number;
  readonly initialCostBasisSol?: number | undefined;
  readonly initialTokensHeld?: number | undefined;
  readonly realizedProceedsSol?: number | undefined;
  readonly tier1ProfitTaken?: boolean | undefined;
  readonly tier2ProfitTaken?: boolean | undefined;
  readonly lastObservedPriceSol: number;
  readonly lastObservedAtMs: number;
  readonly reasonForMissingData: string;
  readonly estimatedLiquidationSol: number; // 0 for conservative valuation
  readonly sessionId?: string | undefined;
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
  readonly unresolvedPositions?: readonly UnresolvedPositionRecord[] | undefined;
  readonly initialPortfolioSol: number;
  readonly currentCashSol?: number | undefined;
  readonly unresolvedCostBasisSol?: number | undefined;
  readonly currentPortfolioSol: number;
  readonly totalRealizedPnlSol: number;
  readonly totalUnrealizedPnlSol: number;
  readonly maxOpenPositions: number;
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
  readonly initialUnresolvedPositions?:
    | readonly (UnresolvedPositionRecord | UnresolvedTokenInventory)[]
    | undefined;
  readonly initialBlockedMints?: readonly string[] | undefined;
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
  private readonly unresolvedPositions: UnresolvedPositionRecord[] = [];
  private readonly exitCooldowns = new Map<string, number>();

  constructor(options: PaperTradingDaemonOptions) {
    const rawDrawdownBps = options.config.maxPortfolioDrawdownBps ?? -500;
    if (
      !Number.isFinite(rawDrawdownBps) ||
      rawDrawdownBps === 0 ||
      Math.abs(rawDrawdownBps) > 10_000
    ) {
      throw new Error(
        `[PaperDaemon] [INVALID_CONFIG] maxPortfolioDrawdownBps must be a non-zero number between -10000 and 10000 bps (got ${rawDrawdownBps})`,
      );
    }
    this.config = {
      ...options.config,
      maxPortfolioDrawdownBps: -Math.abs(rawDrawdownBps),
    };
    this.scannerConfig = options.config.scannerConfig ?? CANDIDATE_SCANNER_DEFAULTS;
    this.ratchetService = options.ratchetService ?? new DynamicRatchetService();
    this.scannerEvaluator = options.scannerEvaluator ?? new CandidateScannerEvaluator();
    this.clock = options.clock ?? nowMs;

    this.currentCashSol = this.config.initialPortfolioSol;
    this.startedAtMs = this.clock();
    this.lastTickAtMs = this.startedAtMs;

    // P0-R2: Restore initial unresolved positions and block duplicate buys of their mints
    if (options.initialUnresolvedPositions && options.initialUnresolvedPositions.length > 0) {
      for (const item of options.initialUnresolvedPositions) {
        this.unresolvedPositions.push({
          positionId: item.positionId,
          mintAddress: item.mintAddress,
          tokensHeld: item.tokensHeld,
          costBasisSol: item.costBasisSol,
          initialCostBasisSol: item.initialCostBasisSol,
          initialTokensHeld: item.initialTokensHeld,
          realizedProceedsSol: item.realizedProceedsSol,
          lastObservedPriceSol: item.lastObservedPriceSol,
          lastObservedAtMs: item.lastObservedAtMs,
          reasonForMissingData: item.reasonForMissingData,
          estimatedLiquidationSol:
            "estimatedLiquidationSol" in item && typeof item.estimatedLiquidationSol === "number"
              ? item.estimatedLiquidationSol
              : 0,
          ...("tier1ProfitTaken" in item && item.tier1ProfitTaken !== undefined
            ? { tier1ProfitTaken: item.tier1ProfitTaken }
            : {}),
          ...("tier2ProfitTaken" in item && item.tier2ProfitTaken !== undefined
            ? { tier2ProfitTaken: item.tier2ProfitTaken }
            : {}),
          ...(item.symbol !== undefined ? { symbol: item.symbol } : {}),
          ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
        });
        this.exitCooldowns.set(item.mintAddress, Number.MAX_SAFE_INTEGER);
      }
    }
    if (options.initialBlockedMints && options.initialBlockedMints.length > 0) {
      for (const mint of options.initialBlockedMints) {
        this.exitCooldowns.set(mint, Number.MAX_SAFE_INTEGER);
      }
    }
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

  getCurrentCashSol(): number {
    return this.currentCashSol;
  }

  scaleInPosition(
    positionId: string,
    addOnCostBasisSol: number,
    spotPriceSol: number,
    nowTimestampMs?: number,
  ): PaperPosition | null {
    if (this.status !== "RUNNING") return null;
    const position = this.openPositions.get(positionId);
    if (!position) return null;

    // P0-06 / P0-E: Disallow scaling in after profit-taking has begun or if already pyramided
    if (position.tier1ProfitTaken || position.tier2ProfitTaken || position.pyramided) {
      return null;
    }

    if (addOnCostBasisSol <= 0 || spotPriceSol <= 0 || !Number.isFinite(spotPriceSol)) {
      return null;
    }

    if (this.currentCashSol < addOnCostBasisSol) {
      return null;
    }

    const now = nowTimestampMs ?? this.clock();
    const tokensToAdd = addOnCostBasisSol / spotPriceSol;

    const newTokensHeld = position.tokensHeld + tokensToAdd;
    const newCostBasisSol = position.costBasisSol + addOnCostBasisSol;
    const blendedEntryPriceSol = newCostBasisSol / newTokensHeld;

    // P0-E: Absolute protective stop preservation
    // Previous absolute stop price in SOL
    const oldStopFloorBps = position.ratchetState.currentStopFloorBps ?? 0;
    const oldStopPriceSol = position.entryPriceSol * (1 + oldStopFloorBps / 10_000);

    // Target stop price must not be lower than the previous absolute stop price,
    // and must provide at least blended breakeven (blendedEntryPriceSol).
    const targetStopPriceSol = Math.max(oldStopPriceSol, blendedEntryPriceSol);

    // If current spot is already at or below targetStopPriceSol, scaling in would create an immediately breached stop!
    if (spotPriceSol <= targetStopPriceSol) {
      return null; // Reject scale-in
    }

    // Rebase stop floor bps relative to the new blended cost basis.
    // Use Math.ceil to guarantee that integer bps quantization never lowers the absolute stop price in SOL.
    const rebasedStopFloorBps = Math.max(
      0,
      Math.ceil(((targetStopPriceSol - blendedEntryPriceSol) / blendedEntryPriceSol) * 10_000),
    );

    // P0-E: Preserve absolute historical high-water price separately
    const historicalPeakPriceSol = Math.max(
      position.historicalPeakPriceSol ?? position.entryPriceSol,
      position.ratchetState.peakPriceSol,
      spotPriceSol,
    );
    position.historicalPeakPriceSol = historicalPeakPriceSol;

    position.tokensHeld = newTokensHeld;
    position.costBasisSol = newCostBasisSol;
    position.initialTokensHeld = newTokensHeld;
    position.initialCostBasisSol = newCostBasisSol;

    position.entryPriceSol = blendedEntryPriceSol;
    position.spotPriceSol = spotPriceSol;
    position.currentPnlBps = Math.round(
      ((spotPriceSol - blendedEntryPriceSol) / blendedEntryPriceSol) * 10_000,
    );
    position.pyramided = true;
    position.scaleInCount = (position.scaleInCount ?? 0) + 1;
    position.lastActivityMs = now;
    position.lastValidPriceObservedAtMs = now;

    this.currentCashSol -= addOnCostBasisSol;

    // Peak price since scale-in on blended basis starts at spotPriceSol
    const rebasedPeakGainBps = Math.max(
      0,
      Math.round(((spotPriceSol - blendedEntryPriceSol) / blendedEntryPriceSol) * 10_000),
    );
    const updatedRatchetState: PositionRatchetState = {
      ...position.ratchetState,
      entryPriceSol: blendedEntryPriceSol,
      peakPriceSol: spotPriceSol,
      peakGainBps: rebasedPeakGainBps,
      currentStopFloorBps: rebasedStopFloorBps,
      armedBreakeven: true,
      lastEvaluatedAtMs: now,
    };
    position.ratchetState = updatedRatchetState;
    this.ratchetService.getStore().update(updatedRatchetState, { allowRebase: true });

    return position;
  }

  markPositionUnresolved(
    positionId: string,
    reasonForMissingData = "MISSING_PRICE_FEED",
    nowTimestampMs?: number,
  ): UnresolvedPositionRecord | null {
    const position = this.openPositions.get(positionId);
    if (!position) return null;
    this.lastTickAtMs = nowTimestampMs ?? this.clock();

    const unresolvedRecord: UnresolvedPositionRecord = {
      positionId: position.positionId,
      mintAddress: position.mintAddress,
      tokensHeld: position.tokensHeld,
      costBasisSol: position.costBasisSol,
      initialCostBasisSol: position.initialCostBasisSol ?? position.costBasisSol,
      initialTokensHeld: position.initialTokensHeld ?? position.tokensHeld,
      realizedProceedsSol: position.realizedProceedsSol ?? 0,
      ...(position.tier1ProfitTaken !== undefined
        ? { tier1ProfitTaken: position.tier1ProfitTaken }
        : {}),
      ...(position.tier2ProfitTaken !== undefined
        ? { tier2ProfitTaken: position.tier2ProfitTaken }
        : {}),
      lastObservedPriceSol: position.spotPriceSol > 0 ? position.spotPriceSol : 0,
      lastObservedAtMs: position.lastValidPriceObservedAtMs ?? position.lastActivityMs,
      reasonForMissingData,
      estimatedLiquidationSol: 0, // Conservative risk valuation
      ...(position.symbol !== undefined ? { symbol: position.symbol } : {}),
      sessionId: this.config.sessionId,
    };

    this.unresolvedPositions.push(unresolvedRecord);
    this.openPositions.delete(positionId);
    this.ratchetService.getStore().delete(positionId);

    if (this.status === "EXITING" && this.openPositions.size === 0) {
      this.status = this.haltReason ? "HALTED" : "COMPLETED";
    }

    return unresolvedRecord;
  }

  reconcileUnresolvedPosition(
    mintAddress: string,
    exitPriceSol: number,
    nowTimestampMs?: number,
    exitReason = "MANUAL_RECONCILIATION",
  ): ClosedTradeRecord | null {
    const idx = this.unresolvedPositions.findIndex((p) => p.mintAddress === mintAddress);
    if (idx < 0) return null;
    const unresolved = this.unresolvedPositions[idx]!;
    const now = nowTimestampMs ?? this.clock();
    this.lastTickAtMs = now;

    if (exitPriceSol <= 0 || !Number.isFinite(exitPriceSol)) {
      return null;
    }

    const finalProceedsSol = Number((unresolved.tokensHeld * exitPriceSol).toFixed(6));
    this.currentCashSol = Number((this.currentCashSol + finalProceedsSol).toFixed(6));

    const totalProceedsSol = Number(
      ((unresolved.realizedProceedsSol ?? 0) + finalProceedsSol).toFixed(6),
    );
    const totalCostBasisSol = unresolved.initialCostBasisSol ?? unresolved.costBasisSol;
    const totalTokensSold = unresolved.initialTokensHeld ?? unresolved.tokensHeld;
    const vwapExitPriceSol =
      totalTokensSold > 0 ? Number((totalProceedsSol / totalTokensSold).toFixed(8)) : exitPriceSol;
    const realizedPnlSol = Number((totalProceedsSol - totalCostBasisSol).toFixed(6));
    const realizedPnlBps = Math.round((realizedPnlSol / totalCostBasisSol) * 10_000);

    const closedRecord: ClosedTradeRecord = {
      positionId: unresolved.positionId,
      mintAddress: unresolved.mintAddress,
      entryPriceSol: unresolved.lastObservedPriceSol,
      exitPriceSol: vwapExitPriceSol,
      costBasisSol: totalCostBasisSol,
      proceedsSol: totalProceedsSol,
      realizedPnlSol,
      realizedPnlBps,
      peakGainBps: Math.max(realizedPnlBps, 0),
      exitReason,
      openedAtMs: unresolved.lastObservedAtMs,
      closedAtMs: now,
      finalTier: unresolved.tier2ProfitTaken
        ? "TIER_2"
        : unresolved.tier1ProfitTaken
          ? "TIER_1"
          : "BASELINE",
      ...(unresolved.symbol !== undefined ? { symbol: unresolved.symbol } : {}),
    };

    this.closedTrades.push(closedRecord);
    this.unresolvedPositions.splice(idx, 1);
    this.exitCooldowns.delete(mintAddress);

    return closedRecord;
  }

  manualExit(
    positionId: string,
    currentSpotPriceSol?: number,
    nowTimestampMs?: number,
    exitReason: string = "MANUAL_OPERATOR_EXIT",
  ): ClosedTradeRecord | null {
    const position = this.openPositions.get(positionId);
    if (!position) return null;

    const exitPriceSol = currentSpotPriceSol ?? position.spotPriceSol;
    if (exitPriceSol <= 0 || !Number.isFinite(exitPriceSol)) {
      // P0-A: Never substitute entry price or record zero-proceeds sale. Mark as unresolved!
      this.markPositionUnresolved(positionId, `INVALID_EXIT_PRICE_${exitPriceSol}`, nowTimestampMs);
      return null;
    }

    const now = nowTimestampMs ?? this.clock();
    const finalProceedsSol = position.tokensHeld * exitPriceSol;
    this.currentCashSol += finalProceedsSol;

    const totalProceedsSol = (position.realizedProceedsSol ?? 0) + finalProceedsSol;
    const totalCostBasisSol = position.initialCostBasisSol ?? position.costBasisSol;
    const totalTokensSold = position.initialTokensHeld ?? position.tokensHeld;
    const vwapExitPriceSol =
      totalTokensSold > 0 ? totalProceedsSol / totalTokensSold : exitPriceSol;
    const realizedPnlSol = totalProceedsSol - totalCostBasisSol;
    const realizedPnlBps = Math.round((realizedPnlSol / totalCostBasisSol) * 10_000);

    const finalTier = position.tier2ProfitTaken
      ? "TIER_2"
      : position.tier1ProfitTaken
        ? "TIER_1"
        : "BASELINE";

    const closedRecord: ClosedTradeRecord = {
      positionId: position.positionId,
      mintAddress: position.mintAddress,
      entryPriceSol: position.entryPriceSol,
      exitPriceSol: vwapExitPriceSol,
      costBasisSol: totalCostBasisSol,
      proceedsSol: totalProceedsSol,
      realizedPnlSol,
      realizedPnlBps,
      peakGainBps:
        position.peakGainBps ?? position.ratchetState?.peakGainBps ?? Math.max(realizedPnlBps, 0),
      exitReason,
      openedAtMs: position.openedAtMs,
      closedAtMs: now,
      finalTier,
      ...(position.symbol !== undefined ? { symbol: position.symbol } : {}),
    };

    this.closedTrades.push(closedRecord);
    this.openPositions.delete(positionId);
    this.ratchetService.getStore().delete(positionId);

    const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
    this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

    if (this.status === "EXITING" && this.openPositions.size === 0) {
      this.status = this.haltReason ? "HALTED" : "COMPLETED";
    }

    return closedRecord;
  }

  getSnapshot(): PaperTradingDaemonSnapshot {
    const openPositionsArray = Array.from(this.openPositions.values());
    const totalUnrealizedPnlSol = openPositionsArray.reduce((acc, pos) => {
      const currentValSol = pos.tokensHeld * pos.spotPriceSol;
      return acc + (currentValSol - pos.costBasisSol);
    }, 0);

    const partialRealizedFromOpenPositions = openPositionsArray.reduce((acc, pos) => {
      const initialCost = pos.initialCostBasisSol ?? pos.costBasisSol;
      const costRelieved = initialCost - pos.costBasisSol;
      const realizedProceeds = pos.realizedProceedsSol ?? 0;
      return acc + (realizedProceeds - costRelieved);
    }, 0);

    const partialRealizedFromUnresolvedPositions = this.unresolvedPositions.reduce((acc, pos) => {
      const initialCost = pos.initialCostBasisSol ?? pos.costBasisSol;
      const costRelieved = initialCost - pos.costBasisSol;
      const realizedProceeds = pos.realizedProceedsSol ?? 0;
      return acc + (realizedProceeds - costRelieved);
    }, 0);

    const totalRealizedPnlSol =
      this.closedTrades.reduce((acc, trade) => acc + trade.realizedPnlSol, 0) +
      partialRealizedFromOpenPositions +
      partialRealizedFromUnresolvedPositions;

    const totalPositionEquitySol = openPositionsArray.reduce(
      (acc, pos) => acc + pos.tokensHeld * pos.spotPriceSol,
      0,
    );

    const currentPortfolioSol = this.currentCashSol + totalPositionEquitySol;
    const unresolvedCostBasisSol = this.unresolvedPositions.reduce(
      (acc, pos) => acc + pos.costBasisSol,
      0,
    );

    return {
      sessionId: this.config.sessionId,
      status: this.status,
      ...(this.haltReason ? { haltReason: this.haltReason } : {}),
      openPositions: openPositionsArray,
      closedTrades: [...this.closedTrades],
      unresolvedPositions: [...this.unresolvedPositions],
      initialPortfolioSol: this.config.initialPortfolioSol,
      currentCashSol: this.currentCashSol,
      unresolvedCostBasisSol,
      currentPortfolioSol,
      totalRealizedPnlSol,
      totalUnrealizedPnlSol,
      maxOpenPositions: this.config.maxOpenPositions,
      consecutiveErrorCount: this.consecutiveErrorCount,
      startedAtMs: this.startedAtMs,
      lastTickAtMs: this.lastTickAtMs,
    };
  }

  public heartbeat(nowTimestampMs?: number): void {
    this.lastTickAtMs = nowTimestampMs ?? this.clock();
  }

  processScannedPool(
    pool: ScannedPoolRecord,
    nowTimestampMs?: number,
    entryPriceSolOverride?: number,
    positionSizeSolOverride?: number,
    options?: {
      bypassScannerEvaluation?: boolean;
      cohort?: CohortTier;
      ratchetConfig?: DynamicRatchetConfig;
    },
  ): boolean {
    if (this.status !== "RUNNING") return false;
    const now = nowTimestampMs ?? this.clock();

    // 1. Position Sizing & Capacity Check
    if (this.openPositions.size >= this.config.maxOpenPositions) {
      return false;
    }
    const positionSize =
      positionSizeSolOverride !== undefined ? positionSizeSolOverride : this.config.positionSizeSol;

    if (this.currentCashSol < positionSize || positionSize <= 0) {
      return false;
    }

    // 1b. Single Position Per Mint Check
    for (const openPos of this.openPositions.values()) {
      if (openPos.mintAddress === pool.mintAddress) {
        return false;
      }
    }

    // 1c. Block Re-buys of Unresolved Mints (P0-R2)
    if (this.unresolvedPositions.some((p) => p.mintAddress === pool.mintAddress)) {
      return false;
    }

    // 1d. Anti-Rebuy Cooldown Check
    const cooldownUntilMs = this.exitCooldowns.get(pool.mintAddress);
    if (cooldownUntilMs !== undefined && now < cooldownUntilMs) {
      return false;
    }

    // 2. Anti-Rug & L/MC Evaluation Check
    if (!options?.bypassScannerEvaluation) {
      const nowSec = Math.floor(now / 1000);
      const evaluation = this.scannerEvaluator.evaluate(pool, this.scannerConfig, nowSec);
      if (!evaluation.admitted) {
        return false;
      }
    }

    // 3. Execute Paper Buy
    const positionId = `pos-${pool.mintAddress}-${now}`;
    const entryPriceSol =
      entryPriceSolOverride !== undefined ? entryPriceSolOverride : pool.spotPriceUsd;

    // Discard non-positive or non-finite entry prices
    if (!entryPriceSol || entryPriceSol <= 0 || !Number.isFinite(entryPriceSol)) {
      return false;
    }

    const initialTokensHeld = positionSize / entryPriceSol;
    const initialCostBasisSol = positionSize;

    this.currentCashSol -= initialCostBasisSol;

    const ratchetState = this.ratchetService
      .getStore()
      .initPositionState(positionId, pool.mintAddress, entryPriceSol, now);

    const position: PaperPosition = {
      positionId,
      mintAddress: pool.mintAddress,
      entryPriceSol,
      initialTokensHeld,
      initialCostBasisSol,
      tokensHeld: initialTokensHeld,
      costBasisSol: initialCostBasisSol,
      realizedProceedsSol: 0,
      openedAtMs: now,
      spotPriceSol: entryPriceSol,
      historicalPeakPriceSol: entryPriceSol,
      currentPnlBps: 0,
      ratchetState,
      lastActivityMs: now,
      lastValidPriceObservedAtMs: now,
      stagnantTicksCount: 0,
      ...(pool.symbol !== undefined ? { symbol: pool.symbol } : {}),
      ...(options?.cohort !== undefined ? { cohort: options.cohort } : {}),
      ...(options?.ratchetConfig !== undefined ? { ratchetConfig: options.ratchetConfig } : {}),
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

    // P0-B: Data feed outage tripwire — an invalid spot price is an external feed outage, NOT market stagnation
    if (marketContext.spotPriceSol <= 0 || !Number.isFinite(marketContext.spotPriceSol)) {
      this.recordFeedOutageTick(positionId, now);
      return null;
    }

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

      position.historicalPeakPriceSol = Math.max(
        position.historicalPeakPriceSol ?? position.entryPriceSol,
        marketContext.spotPriceSol,
      );

      if (marketContext.spotPriceSol > 0 && Number.isFinite(marketContext.spotPriceSol)) {
        position.lastValidPriceObservedAtMs = now;
      }

      if (priceChanged || hasRecentActivity) {
        position.lastActivityMs = now;
        position.stagnantTicksCount = 0;
      } else {
        position.stagnantTicksCount += 1;
      }

      // If position has had no activity for >= 3 minutes (180,000ms), force stagnancy exit
      if (now - position.lastActivityMs >= 180_000) {
        const exitPriceSol = marketContext.spotPriceSol;
        const finalProceedsSol = position.tokensHeld * exitPriceSol;
        this.currentCashSol += finalProceedsSol;

        const totalProceedsSol = (position.realizedProceedsSol ?? 0) + finalProceedsSol;
        const totalCostBasisSol = position.initialCostBasisSol ?? position.costBasisSol;
        const totalTokensSold = position.initialTokensHeld ?? position.tokensHeld;
        const vwapExitPriceSol =
          totalTokensSold > 0 ? totalProceedsSol / totalTokensSold : exitPriceSol;
        const realizedPnlSol = totalProceedsSol - totalCostBasisSol;
        const realizedPnlBps = Math.round((realizedPnlSol / totalCostBasisSol) * 10_000);

        const closedRecord: ClosedTradeRecord = {
          positionId: position.positionId,
          mintAddress: position.mintAddress,
          entryPriceSol: position.entryPriceSol,
          exitPriceSol: vwapExitPriceSol,
          costBasisSol: totalCostBasisSol,
          proceedsSol: totalProceedsSol,
          realizedPnlSol,
          realizedPnlBps,
          exitReason: "STAGNANCY_TIMEOUT_EXIT",
          openedAtMs: position.openedAtMs,
          closedAtMs: now,
          ...(position.symbol !== undefined ? { symbol: position.symbol } : {}),
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
      const prevPrice = position.spotPriceSol;
      const singleTickDropBps =
        marketContext.singleTickDropBps ??
        (prevPrice > 0
          ? Math.round(((marketContext.spotPriceSol - prevPrice) / prevPrice) * 10_000)
          : 0);

      const enrichedContext: MarketEvaluationContext = {
        ...marketContext,
        singleTickDropBps,
      };

      const result = this.ratchetService.evaluate(
        position.ratchetState,
        enrichedContext,
        position.ratchetConfig,
      );

      // Update position pricing state & track high-water mark
      position.spotPriceSol = marketContext.spotPriceSol;
      position.currentPnlBps = result.diagnostics.currentPnlBps;
      position.peakGainBps = Math.max(
        position.peakGainBps ?? 0,
        result.diagnostics.peakGainBps ?? 0,
      );
      position.ratchetState = result.updatedState;

      // 4. Handle Partial Scale-Out or Full Sell
      if (result.action === "SELL_PARTIAL_50") {
        position.tier1ProfitTaken = true;
        const initialTokens = position.initialTokensHeld ?? position.tokensHeld;
        const initialCost = position.initialCostBasisSol ?? position.costBasisSol;
        const tokensToSell = Math.min(position.tokensHeld, initialTokens * 0.5);
        if (tokensToSell > 0) {
          const proceedsSol = tokensToSell * marketContext.spotPriceSol;
          const costRelievedSol = (tokensToSell / initialTokens) * initialCost;
          position.tokensHeld -= tokensToSell;
          position.costBasisSol -= costRelievedSol;
          position.realizedProceedsSol = (position.realizedProceedsSol ?? 0) + proceedsSol;
          this.currentCashSol += proceedsSol;
        }
      } else if (result.action === "SELL_PARTIAL_25") {
        position.tier2ProfitTaken = true;
        const initialTokens = position.initialTokensHeld ?? position.tokensHeld;
        const initialCost = position.initialCostBasisSol ?? position.costBasisSol;
        const tokensToSell = Math.min(position.tokensHeld, initialTokens * 0.25);
        if (tokensToSell > 0) {
          const proceedsSol = tokensToSell * marketContext.spotPriceSol;
          const costRelievedSol = (tokensToSell / initialTokens) * initialCost;
          position.tokensHeld -= tokensToSell;
          position.costBasisSol -= costRelievedSol;
          position.realizedProceedsSol = (position.realizedProceedsSol ?? 0) + proceedsSol;
          this.currentCashSol += proceedsSol;
        }
      } else if (result.action === "SELL_ALL") {
        const exitPriceSol = marketContext.spotPriceSol;
        const finalProceedsSol = position.tokensHeld * exitPriceSol;
        this.currentCashSol += finalProceedsSol;

        const totalProceedsSol = (position.realizedProceedsSol ?? 0) + finalProceedsSol;
        const totalCostBasisSol = position.initialCostBasisSol ?? position.costBasisSol;
        const totalTokensSold = position.initialTokensHeld ?? position.tokensHeld;
        const vwapExitPriceSol =
          totalTokensSold > 0 ? totalProceedsSol / totalTokensSold : exitPriceSol;
        const realizedPnlSol = totalProceedsSol - totalCostBasisSol;
        const realizedPnlBps = Math.round((realizedPnlSol / totalCostBasisSol) * 10_000);

        const finalTier = position.tier2ProfitTaken
          ? "TIER_2"
          : position.tier1ProfitTaken
            ? "TIER_1"
            : "BASELINE";

        const closedRecord: ClosedTradeRecord = {
          positionId: position.positionId,
          mintAddress: position.mintAddress,
          entryPriceSol: position.entryPriceSol,
          exitPriceSol: vwapExitPriceSol,
          costBasisSol: totalCostBasisSol,
          proceedsSol: totalProceedsSol,
          realizedPnlSol,
          realizedPnlBps,
          peakGainBps:
            position.peakGainBps ??
            position.ratchetState.peakGainBps ??
            Math.max(realizedPnlBps, 0),
          exitReason: result.reasonCode,
          openedAtMs: position.openedAtMs,
          closedAtMs: now,
          finalTier,
          ...(position.symbol !== undefined ? { symbol: position.symbol } : {}),
        };

        this.closedTrades.push(closedRecord);
        this.openPositions.delete(positionId);
        this.ratchetService.getStore().delete(positionId);

        const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
        this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

        if (this.status === "EXITING" && this.openPositions.size === 0) {
          this.status = this.haltReason ? "HALTED" : "COMPLETED";
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

  recordFeedOutageTick(positionId: string, nowTimestampMs?: number): void {
    const position = this.openPositions.get(positionId);
    if (!position) return;
    const now = nowTimestampMs ?? this.clock();
    this.lastTickAtMs = now;
    position.feedOutageTicksCount = (position.feedOutageTicksCount ?? 0) + 1;
    // Feed outage does NOT update position.lastActivityMs and does NOT liquidate position at stale price!
  }

  recordStagnantTick(
    positionId: string,
    validSpotPriceSol?: number,
    nowTimestampMs?: number,
  ): ClosedTradeRecord | null {
    const position = this.openPositions.get(positionId);
    if (!position) return null;
    const now = nowTimestampMs ?? this.clock();
    this.lastTickAtMs = now;

    // P0-B & P0-2: Only genuine, fresh active price feeds qualify for market stagnancy check.
    // An unavailable or stale price (> 30s) is a feed outage, NOT market stagnation.
    const spotPrice = validSpotPriceSol ?? position.spotPriceSol;
    const priceAgeMs = position.lastValidPriceObservedAtMs
      ? now - position.lastValidPriceObservedAtMs
      : now - position.lastActivityMs;
    if (
      spotPrice <= 0 ||
      !Number.isFinite(spotPrice) ||
      (validSpotPriceSol === undefined && priceAgeMs > 30_000)
    ) {
      this.recordFeedOutageTick(positionId, nowTimestampMs);
      return null;
    }

    if (validSpotPriceSol !== undefined && validSpotPriceSol > 0) {
      position.lastValidPriceObservedAtMs = now;
    }

    position.stagnantTicksCount += 1;
    position.spotPriceSol = spotPrice;

    // Check if market inactivity has reached 3 minutes (180,000ms) with valid market price
    if (now - position.lastActivityMs >= 180_000) {
      const exitPriceSol = spotPrice;
      const finalProceedsSol = position.tokensHeld * exitPriceSol;
      this.currentCashSol += finalProceedsSol;

      const totalProceedsSol = (position.realizedProceedsSol ?? 0) + finalProceedsSol;
      const totalCostBasisSol = position.initialCostBasisSol ?? position.costBasisSol;
      const totalTokensSold = position.initialTokensHeld ?? position.tokensHeld;
      const vwapExitPriceSol =
        totalTokensSold > 0 ? totalProceedsSol / totalTokensSold : exitPriceSol;
      const realizedPnlSol = totalProceedsSol - totalCostBasisSol;
      const realizedPnlBps = Math.round((realizedPnlSol / totalCostBasisSol) * 10_000);

      const finalTier = position.tier2ProfitTaken
        ? "TIER_2"
        : position.tier1ProfitTaken
          ? "TIER_1"
          : "BASELINE";

      const closedRecord: ClosedTradeRecord = {
        positionId: position.positionId,
        mintAddress: position.mintAddress,
        entryPriceSol: position.entryPriceSol,
        exitPriceSol: vwapExitPriceSol,
        costBasisSol: totalCostBasisSol,
        proceedsSol: totalProceedsSol,
        realizedPnlSol,
        realizedPnlBps,
        peakGainBps:
          position.peakGainBps ?? position.ratchetState?.peakGainBps ?? Math.max(realizedPnlBps, 0),
        exitReason: "STAGNANCY_TIMEOUT_EXIT",
        openedAtMs: position.openedAtMs,
        closedAtMs: now,
        finalTier,
        ...(position.symbol !== undefined ? { symbol: position.symbol } : {}),
      };

      this.closedTrades.push(closedRecord);
      this.openPositions.delete(positionId);
      this.ratchetService.getStore().delete(positionId);

      const cooldownMs = this.config.antiRebuyCooldownMs ?? 1800000;
      this.exitCooldowns.set(position.mintAddress, now + cooldownMs);

      if (this.status === "EXITING" && this.openPositions.size === 0) {
        this.status = this.haltReason ? "HALTED" : "COMPLETED";
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
        this.haltReason = "PORTFOLIO_DRAWDOWN_BREACHED";
        if (this.openPositions.size > 0) {
          // P0-04: Freeze new admissions and scale-ins while actively managing existing open risk
          this.status = "EXITING";
        } else {
          this.stop("PORTFOLIO_DRAWDOWN_BREACHED");
        }
      }
    }
  }

  getExitCooldowns(): ReadonlyMap<string, number> {
    return this.exitCooldowns;
  }

  getHistoricalSummary(stats?: {
    coinsWatchedCount?: number;
    missedOpportunitiesCount?: number;
  }): HistoricalSessionSummary {
    const snapshot = this.getSnapshot();
    const durationMinutes = Math.max(1, Math.round((this.lastTickAtMs - this.startedAtMs) / 60000));
    const netPnlSol = parseFloat(
      (snapshot.currentPortfolioSol - this.config.initialPortfolioSol).toFixed(4),
    );
    const netPnlPct = parseFloat(
      (
        ((snapshot.currentPortfolioSol - this.config.initialPortfolioSol) /
          this.config.initialPortfolioSol) *
        100
      ).toFixed(2),
    );

    const winsCount = this.closedTrades.filter((t) => t.realizedPnlSol > 0).length;
    const lossesCount = this.closedTrades.filter((t) => t.realizedPnlSol < 0).length;
    const scratchesCount = this.closedTrades.filter((t) => t.realizedPnlSol === 0).length;
    const totalTrades = this.closedTrades.length;
    const winRatePct =
      totalTrades > 0 ? parseFloat(((winsCount / totalTrades) * 100).toFixed(2)) : 0;

    const trades: HistoricalTrade[] = this.closedTrades.map((t) => ({
      tradeId: t.positionId,
      poolId: `pool-${t.mintAddress.slice(0, 8)}`,
      mintAddress: t.mintAddress,
      symbol: t.symbol ?? t.mintAddress.slice(0, 6).toUpperCase(),
      entryPriceSol: t.entryPriceSol,
      exitPriceSol: t.exitPriceSol,
      sizeSol: t.costBasisSol,
      enteredAt: new Date(t.openedAtMs).toISOString(),
      exitedAt: new Date(t.closedAtMs).toISOString(),
      holdDurationSeconds: Math.max(1, Math.round((t.closedAtMs - t.openedAtMs) / 1000)),
      peakGainBps: t.peakGainBps ?? Math.max(t.realizedPnlBps, 0),
      finalPnlBps: t.realizedPnlBps,
      finalPnlSol: parseFloat(t.realizedPnlSol.toFixed(4)),
      exitReason: t.exitReason,
      finalTier:
        t.finalTier ??
        (t.realizedPnlBps >= 5000 ? "TIER_2" : t.realizedPnlBps >= 1500 ? "TIER_1" : "BASELINE"),
    }));

    return {
      sessionId: this.config.sessionId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt: new Date(this.lastTickAtMs).toISOString(),
      durationMinutes,
      startingCapitalSol: this.config.initialPortfolioSol,
      endingCapitalSol: parseFloat(snapshot.currentPortfolioSol.toFixed(4)),
      netPnlSol,
      netPnlPct,
      totalTrades,
      buysCount: totalTrades + this.openPositions.size,
      sellsCount: totalTrades,
      winsCount,
      lossesCount,
      scratchesCount,
      winRatePct,
      coinsWatchedCount: stats?.coinsWatchedCount ?? 0,
      missedOpportunitiesCount: stats?.missedOpportunitiesCount ?? 0,
      trades,
    };
  }
}
