/**
 * Phase 12.94-D Milestone D.3.3: Authentic Rolling 60-Second Trade Flow Tracker
 *
 * Implements bounded, in-memory rolling 60-second buy/sell count aggregation
 * from injected timestamped trade events, with strict coverage verification,
 * deduplication, and integration with RetestGateEvaluator.
 *
 * Requirements:
 * 1. Binds trade events strictly to exact candidate poolId and tokenMint.
 * 2. Defines BUY and SELL relative to candidate token:
 *    - BUY: trader swaps quote token for candidate token (candidate token bought/received).
 *    - SELL: trader swaps candidate token for quote token (candidate token sold/given).
 * 3. Stable event identifiers: e.g. `${signature}:${swapIndex}` distinguishing multiple swaps in one tx.
 * 4. Recalculates latest 60-second window whenever evaluated; no fixed evaluation intervals.
 * 5. Handles duplicates, out-of-order arrivals, boundaries, and invalid timestamps explicitly.
 * 6. Preserves event timestamps separately from local receipt times, with provenance.
 * 7. Distinguishes complete coverage from warm-up (< 60s), stale data, and collection gaps.
 * 8. Returns unavailable counts (null) when coverage is insufficient. Reports zero only for
 *    a sufficiently observed window containing no qualifying trades.
 * 9. Narrow integration path to RetestGateEvaluator (unavailable flow never confirms entry).
 * 10. Bounded storage: automatic eviction of expired events and max capacity ceilings.
 */

import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";
import type { RetestSpotInfo } from "./RetestGateEvaluator.js";

export type TradeSide = "BUY" | "SELL";

export type TradeTimestampProvenance =
  | "ON_CHAIN_BLOCK_TIME"
  | "HOST_OBSERVED"
  | "SYNTHETIC_FIXTURE";

export interface TradeEvent {
  /** Stable identifier distinguishing multiple swaps within one transaction: e.g. `${signature}:${swapIndex}` */
  readonly eventId: string;
  readonly signature: string;
  readonly swapIndex: number;
  readonly poolId: string;
  readonly tokenMint: string;
  readonly side: TradeSide;
  readonly slot: number;
  readonly blockTimeSec: number | null;
  /** Authoritative event timestamp in milliseconds */
  readonly eventTimestampMs: number;
  /** Host local receipt timestamp in milliseconds */
  readonly receiptTimestampMs: number;
  readonly timestampProvenance: TradeTimestampProvenance;
  readonly tokenAmount?: bigint | number | undefined;
  readonly solAmount?: bigint | number | undefined;
}

export type IngestTradeFailureReason =
  | "INVALID_EVENT_OBJECT"
  | "MISSING_EVENT_ID"
  | "IDENTITY_MISMATCH_POOL"
  | "IDENTITY_MISMATCH_MINT"
  | "INVALID_SIDE"
  | "INVALID_TIMESTAMP"
  | "FUTURE_DATED_TIMESTAMP"
  | "DUPLICATE_EVENT";

export type IngestTradeResult =
  | { readonly ok: true; readonly eventId: string }
  | { readonly ok: false; readonly reason: IngestTradeFailureReason; readonly message: string };

export type FlowCoverageStatus =
  | "SUFFICIENT"
  | "WARM_UP"
  | "COLLECTION_GAP"
  | "STALE_DATA"
  | "UNINITIALIZED";

export interface StreamGap {
  readonly gapStartMs: number;
  readonly gapEndMs: number;
  readonly reason?: string | undefined;
}

export interface RollingFlowEvaluationResult {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly evaluationTimestampMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly coverage: FlowCoverageStatus;
  readonly isCoverageSufficient: boolean;
  /** Null if coverage is not SUFFICIENT */
  readonly recentBuys60s: number | null;
  /** Null if coverage is not SUFFICIENT */
  readonly recentSells60s: number | null;
  /** Flow ratio: buys / Math.max(1, sells), or null if unavailable */
  readonly flowRatio: number | null;
  readonly diagnostics: {
    readonly totalEventsIngested: number;
    readonly deduplicatedEventsCount: number;
    readonly eventsInWindowCount: number;
    readonly trackingDurationMs: number;
    readonly gapCount: number;
    readonly timeSinceLastEventMs: number | null;
    readonly timeSinceLastHeartbeatMs: number | null;
  };
}

export interface RollingTradeFlowTrackerOptions {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly trackingStartedMs?: number | undefined;
  readonly windowDurationMs?: number | undefined; // Default: 60_000 ms (60 seconds)
  readonly maxStreamInactivityMs?: number | undefined; // Default: 15_000 ms (15 seconds)
  readonly maxFutureSkewMs?: number | undefined; // Default: 5_000 ms (5 seconds)
  readonly retentionWindowMs?: number | undefined; // Default: 180_000 ms (3 minutes)
  readonly maxEventsRetained?: number | undefined; // Default: 2_000 events
  readonly clock?: (() => number) | undefined;
}

export class RollingTradeFlowTracker {
  private readonly poolId: string;
  private readonly tokenMint: string;
  private readonly windowDurationMs: number;
  private readonly maxStreamInactivityMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly retentionWindowMs: number;
  private readonly maxEventsRetained: number;
  private readonly clock: () => number;

  private trackingStartedMs: number;
  private lastEventTimestampMs = 0;
  private lastHeartbeatMs = 0;
  private lastObservedSlot: number | null = null;

  private readonly events: TradeEvent[] = [];
  private readonly seenEventIds = new Set<string>();
  private readonly recordedGaps: StreamGap[] = [];

  private totalEventsIngested = 0;
  private deduplicatedEventsCount = 0;

  constructor(options: RollingTradeFlowTrackerOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[ROLLING_FLOW_INIT] Options must be an object");
    }
    if (!options.poolId || !isCanonicalSolanaBase58(options.poolId)) {
      throw new Error(
        `[ROLLING_FLOW_INIT] Invalid or non-canonical poolId: '${String(options.poolId)}'`,
      );
    }
    if (!options.tokenMint || !isCanonicalSolanaBase58(options.tokenMint)) {
      throw new Error(
        `[ROLLING_FLOW_INIT] Invalid or non-canonical tokenMint: '${String(options.tokenMint)}'`,
      );
    }

    this.poolId = options.poolId;
    this.tokenMint = options.tokenMint;
    this.clock = options.clock ?? Date.now;
    this.trackingStartedMs = options.trackingStartedMs ?? this.clock();
    this.windowDurationMs = Math.max(10_000, options.windowDurationMs ?? 60_000);
    this.maxStreamInactivityMs = Math.max(5_000, options.maxStreamInactivityMs ?? 15_000);
    this.maxFutureSkewMs = Math.max(1_000, options.maxFutureSkewMs ?? 5_000);
    this.retentionWindowMs = Math.max(
      this.windowDurationMs * 2,
      options.retentionWindowMs ?? 180_000,
    );
    this.maxEventsRetained = Math.max(100, options.maxEventsRetained ?? 2_000);
  }

  public getPoolId(): string {
    return this.poolId;
  }

  public getTokenMint(): string {
    return this.tokenMint;
  }

  public getTrackingStartedMs(): number {
    return this.trackingStartedMs;
  }

  public getEventsCount(): number {
    return this.events.length;
  }

  public getLastObservedSlot(): number | null {
    return this.lastObservedSlot;
  }

  /**
   * Resets tracking start time to a specific epoch millisecond.
   */
  public setTrackingStartedMs(timestampMs: number): void {
    if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs <= 0) {
      throw new Error(`[INVALID_TRACKING_START] Invalid timestamp: ${timestampMs}`);
    }
    this.trackingStartedMs = timestampMs;
  }

  /**
   * Records a stream heartbeat checkpoint.
   * Proves continuous stream liveness when trade volume is low or zero.
   */
  public recordHeartbeat(heartbeatMs: number, slot?: number | undefined): void {
    if (typeof heartbeatMs !== "number" || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
      return;
    }
    this.lastHeartbeatMs = Math.max(this.lastHeartbeatMs, heartbeatMs);
    if (typeof slot === "number" && Number.isFinite(slot) && slot > 0) {
      this.lastObservedSlot = slot;
    }
  }

  /**
   * Explicitly records an unobserved stream outage or collection gap.
   */
  public recordCollectionGap(gap: StreamGap): void {
    if (!gap || typeof gap !== "object") return;
    if (
      typeof gap.gapStartMs !== "number" ||
      typeof gap.gapEndMs !== "number" ||
      !Number.isFinite(gap.gapStartMs) ||
      !Number.isFinite(gap.gapEndMs) ||
      gap.gapStartMs > gap.gapEndMs
    ) {
      return;
    }
    this.recordedGaps.push(gap);
  }

  /**
   * Ingests an authentic or synthetic trade event.
   * Validates identity binding, timestamp sanity, and stable event deduplication.
   */
  public ingestTrade(event: TradeEvent): IngestTradeResult {
    if (!event || typeof event !== "object") {
      return {
        ok: false,
        reason: "INVALID_EVENT_OBJECT",
        message: "Trade event must be a non-null object",
      };
    }

    if (!event.eventId || typeof event.eventId !== "string" || event.eventId.trim().length === 0) {
      return {
        ok: false,
        reason: "MISSING_EVENT_ID",
        message: "Trade event must have a non-empty stable eventId",
      };
    }

    // Strict identity binding
    if (event.poolId !== this.poolId) {
      return {
        ok: false,
        reason: "IDENTITY_MISMATCH_POOL",
        message: `Event poolId '${event.poolId}' does not match tracked pool '${this.poolId}'`,
      };
    }

    if (event.tokenMint !== this.tokenMint) {
      return {
        ok: false,
        reason: "IDENTITY_MISMATCH_MINT",
        message: `Event tokenMint '${event.tokenMint}' does not match tracked mint '${this.tokenMint}'`,
      };
    }

    if (event.side !== "BUY" && event.side !== "SELL") {
      return {
        ok: false,
        reason: "INVALID_SIDE",
        message: `Trade side must be 'BUY' or 'SELL', received: '${String(event.side)}'`,
      };
    }

    if (
      typeof event.eventTimestampMs !== "number" ||
      !Number.isFinite(event.eventTimestampMs) ||
      event.eventTimestampMs <= 0
    ) {
      return {
        ok: false,
        reason: "INVALID_TIMESTAMP",
        message: `Event timestamp must be a positive finite integer, received: ${event.eventTimestampMs}`,
      };
    }

    const currentNow = this.clock();
    if (event.eventTimestampMs > currentNow + this.maxFutureSkewMs) {
      return {
        ok: false,
        reason: "FUTURE_DATED_TIMESTAMP",
        message: `Event timestamp ${event.eventTimestampMs} exceeds allowable future skew (${currentNow + this.maxFutureSkewMs})`,
      };
    }

    // Deduplication check
    if (this.seenEventIds.has(event.eventId)) {
      this.deduplicatedEventsCount++;
      return {
        ok: false,
        reason: "DUPLICATE_EVENT",
        message: `Event '${event.eventId}' has already been ingested and deduplicated`,
      };
    }

    this.seenEventIds.add(event.eventId);
    this.totalEventsIngested++;
    this.lastEventTimestampMs = Math.max(this.lastEventTimestampMs, event.eventTimestampMs);
    if (typeof event.slot === "number" && Number.isFinite(event.slot) && event.slot > 0) {
      this.lastObservedSlot = Math.max(this.lastObservedSlot ?? 0, event.slot);
    }

    // Insert in chronological order (binary insert or linear scan from end since events usually arrive mostly sorted)
    this.insertChronologically(event);

    return { ok: true, eventId: event.eventId };
  }

  /**
   * Evaluates the latest 60-second rolling window.
   * Dynamic recalculation: does not impose a 60-second evaluation interval.
   */
  public evaluateWindow(evaluationTimestampMs?: number | undefined): RollingFlowEvaluationResult {
    const nowMs = evaluationTimestampMs ?? this.clock();
    const windowStartMs = nowMs - this.windowDurationMs;
    const windowEndMs = nowMs;

    // Prune expired events and gaps beyond retention window
    this.pruneExpired(nowMs);

    // Determine coverage
    const coverage = this.determineCoverage(nowMs, windowStartMs, windowEndMs);
    const isCoverageSufficient = coverage === "SUFFICIENT";

    let recentBuys60s: number | null = null;
    let recentSells60s: number | null = null;
    let flowRatio: number | null = null;
    let eventsInWindowCount = 0;

    if (isCoverageSufficient) {
      let buys = 0;
      let sells = 0;

      for (const e of this.events) {
        if (e.eventTimestampMs >= windowStartMs && e.eventTimestampMs <= windowEndMs) {
          eventsInWindowCount++;
          if (e.side === "BUY") {
            buys++;
          } else if (e.side === "SELL") {
            sells++;
          }
        }
      }

      recentBuys60s = buys;
      recentSells60s = sells;
      flowRatio = sells === 0 ? (buys > 0 ? buys : 1.0) : Number((buys / sells).toFixed(2));
    }

    const timeSinceLastEventMs =
      this.lastEventTimestampMs > 0 ? Math.max(0, nowMs - this.lastEventTimestampMs) : null;
    const timeSinceLastHeartbeatMs =
      this.lastHeartbeatMs > 0 ? Math.max(0, nowMs - this.lastHeartbeatMs) : null;

    return {
      poolId: this.poolId,
      tokenMint: this.tokenMint,
      evaluationTimestampMs: nowMs,
      windowStartMs,
      windowEndMs,
      coverage,
      isCoverageSufficient,
      recentBuys60s,
      recentSells60s,
      flowRatio,
      diagnostics: {
        totalEventsIngested: this.totalEventsIngested,
        deduplicatedEventsCount: this.deduplicatedEventsCount,
        eventsInWindowCount,
        trackingDurationMs: Math.max(0, nowMs - this.trackingStartedMs),
        gapCount: this.recordedGaps.length,
        timeSinceLastEventMs,
        timeSinceLastHeartbeatMs,
      },
    };
  }

  /**
   * Convenience integration bridge to construct RetestSpotInfo for RetestGateEvaluator.
   * Guarantees that unavailable flow results yield null buy/sell counts, preventing
   * false entry confirmation while preserving crater and timeout protections.
   */
  public createRetestSpotInfo(
    baseSpot: {
      readonly spotPriceSol: number;
      readonly spotPriceUsd?: number | null | undefined;
      readonly liquidityUsd?: number | null | undefined;
    },
    evaluationTimestampMs?: number | undefined,
  ): RetestSpotInfo {
    const flowResult = this.evaluateWindow(evaluationTimestampMs);
    return {
      spotPriceSol: baseSpot.spotPriceSol,
      spotPriceUsd: baseSpot.spotPriceUsd,
      liquidityUsd: baseSpot.liquidityUsd,
      recentBuys60s: flowResult.recentBuys60s,
      recentSells60s: flowResult.recentSells60s,
      flowCoverage: flowResult.coverage,
    };
  }

  private determineCoverage(
    nowMs: number,
    windowStartMs: number,
    windowEndMs: number,
  ): FlowCoverageStatus {
    // 1. Uninitialized
    if (this.trackingStartedMs <= 0) {
      return "UNINITIALIZED";
    }

    // 2. Warm-up: elapsed tracking duration is less than the required window
    if (nowMs - this.trackingStartedMs < this.windowDurationMs) {
      return "WARM_UP";
    }

    // 3. Collection Gaps: check if any recorded outage intersects [windowStartMs, windowEndMs]
    for (const gap of this.recordedGaps) {
      if (gap.gapStartMs <= windowEndMs && gap.gapEndMs >= windowStartMs) {
        return "COLLECTION_GAP";
      }
    }

    // 4. Stale Data: check stream liveness
    // Stream is active if a heartbeat, event, or recent connection occurred within maxStreamInactivityMs
    const latestActivityMs = Math.max(
      this.lastHeartbeatMs,
      this.lastEventTimestampMs,
      this.trackingStartedMs,
    );
    if (nowMs - latestActivityMs > this.maxStreamInactivityMs) {
      return "STALE_DATA";
    }

    return "SUFFICIENT";
  }

  private insertChronologically(event: TradeEvent): void {
    if (
      this.events.length === 0 ||
      event.eventTimestampMs >= this.events[this.events.length - 1]!.eventTimestampMs
    ) {
      this.events.push(event);
      return;
    }

    // Find insertion index from end
    let i = this.events.length - 1;
    while (i >= 0 && this.events[i]!.eventTimestampMs > event.eventTimestampMs) {
      i--;
    }
    this.events.splice(i + 1, 0, event);
  }

  private pruneExpired(nowMs: number): void {
    const cutoffMs = nowMs - this.retentionWindowMs;

    // Prune events older than retention cutoff
    let removeCount = 0;
    while (
      removeCount < this.events.length &&
      this.events[removeCount]!.eventTimestampMs < cutoffMs
    ) {
      const expiredEvent = this.events[removeCount]!;
      this.seenEventIds.delete(expiredEvent.eventId);
      removeCount++;
    }

    if (removeCount > 0) {
      this.events.splice(0, removeCount);
    }

    // Enforce max capacity ceiling
    if (this.events.length > this.maxEventsRetained) {
      const excess = this.events.length - this.maxEventsRetained;
      for (let j = 0; j < excess; j++) {
        this.seenEventIds.delete(this.events[j]!.eventId);
      }
      this.events.splice(0, excess);
    }

    // Prune gaps that are completely older than retention cutoff
    let gapRemoveCount = 0;
    while (
      gapRemoveCount < this.recordedGaps.length &&
      this.recordedGaps[gapRemoveCount]!.gapEndMs < cutoffMs
    ) {
      gapRemoveCount++;
    }
    if (gapRemoveCount > 0) {
      this.recordedGaps.splice(0, gapRemoveCount);
    }
  }
}
