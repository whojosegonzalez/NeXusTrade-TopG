/**
 * Phase 12.94-D Milestone D.3.3: Authentic Rolling 60-Second Trade Flow Tracker
 *
 * Implements bounded, in-memory rolling 60-second buy/sell count aggregation
 * from injected timestamped trade events, with strict coverage verification,
 * deduplication, and integration with RetestGateEvaluator.
 *
 * Requirements & Audited Safeguards:
 * 1. Complete window coverage verification:
 *    - Rejects recent-heartbeat false passes. Requires continuous, gapless observation
 *      across the entire [now - 60s, now] window with maximum inactivity ceilings.
 *    - Separates trade time from observation timeline: trade events populate counts
 *      within the window, but NEVER fabricate observation checkpoints or bridge silence gaps.
 *    - Accounts for processing backlog, collection gaps, warm-up, and silence intervals.
 * 2. Strict capacity bounds on events, deduplication, and gap metadata:
 *    - Enforces max retention capacity during ingestion.
 *    - Never silently drops active-window events; records capacity loss and marks coverage
 *      unavailable until the affected interval has fully expired.
 *    - Bounds gap metadata during insertion: coalesces overlapping intervals and conservatively
 *      merges closest adjacent intervals to enforce maxGapsRetained without discarding missing-data information.
 * 3. Immutable snapshotting & input validation:
 *    - Snapshots and freezes accepted events and gap records to prevent external caller mutation.
 *    - Derives and validates canonical swap identity (${signature}:${outerInstructionIndex}:${swapIndex})
 *      preventing double-counting via altered eventId labels.
 *    - Strictly validates all configuration options (rejects NaN, Infinity, non-integers, out-of-range).
 *    - Validates signature, indices, slot, timestamps, provenance, and temporal coherence.
 *    - Cross-validates eventTimestampMs, receiptTimestampMs, blockTimeSec, and provenance.
 *    - Rejects evaluateWindow arguments that are NaN, negative, or non-integer.
 * 4. Narrow integration with RetestGateEvaluator:
 *    - Unavailable flow never produces entry confirmation.
 *    - Distinguishes honest zero (sufficient coverage, zero trades) from unavailable flow.
 */

import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";
import { type FlowCoverageStatus, type RetestSpotInfo } from "./RetestGateEvaluator.js";

export type { FlowCoverageStatus } from "./RetestGateEvaluator.js";

export type TradeSide = "BUY" | "SELL";

export type TradeTimestampProvenance =
  | "ON_CHAIN_BLOCK_TIME"
  | "HOST_OBSERVED"
  | "SYNTHETIC_FIXTURE";

export interface TradeEvent {
  /** Stable identifier: e.g. `${signature}:${swapIndex}` or `${signature}:${outerInstructionIndex}:${swapIndex}` */
  readonly eventId: string;
  readonly signature: string;
  readonly swapIndex: number;
  readonly outerInstructionIndex?: number | undefined;
  readonly poolId: string;
  readonly tokenMint: string;
  readonly side: TradeSide;
  readonly slot: number;
  readonly blockTimeSec: number | null;
  /** Authoritative event timestamp in integer milliseconds */
  readonly eventTimestampMs: number;
  /** Host local receipt timestamp in integer milliseconds */
  readonly receiptTimestampMs: number;
  readonly timestampProvenance: TradeTimestampProvenance;
  readonly tokenAmount?: bigint | number | undefined;
  readonly solAmount?: bigint | number | undefined;
}

export type IngestTradeFailureReason =
  | "INVALID_EVENT_OBJECT"
  | "MISSING_EVENT_ID"
  | "INVALID_SIGNATURE"
  | "INVALID_SWAP_INDEX"
  | "INVALID_INSTRUCTION_INDEX"
  | "IDENTITY_MISMATCH_POOL"
  | "IDENTITY_MISMATCH_MINT"
  | "INVALID_SIDE"
  | "INVALID_TIMESTAMP"
  | "INVALID_RECEIPT_TIMESTAMP"
  | "FUTURE_DATED_RECEIPT_TIMESTAMP"
  | "CONTRADICTORY_TIMESTAMPS"
  | "INVALID_SLOT"
  | "INVALID_PROVENANCE"
  | "FUTURE_DATED_TIMESTAMP"
  | "DUPLICATE_EVENT"
  | "CAPACITY_EXCEEDED";

export type IngestTradeResult =
  | { readonly ok: true; readonly eventId: string; readonly canonicalSwapKey: string }
  | { readonly ok: false; readonly reason: IngestTradeFailureReason; readonly message: string };

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
    readonly latestCapacityLossMs: number | null;
    readonly hasActiveBacklog: boolean;
  };
}

export interface RollingTradeFlowTrackerOptions {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly trackingStartedMs?: number | undefined;
  readonly windowDurationMs?: number | undefined; // Must be exactly 60_000 ms if provided
  readonly maxStreamInactivityMs?: number | undefined; // Default: 15_000 ms (15 seconds)
  readonly maxFutureSkewMs?: number | undefined; // Default: 5_000 ms (5 seconds)
  readonly retentionWindowMs?: number | undefined; // Default: 180_000 ms (3 minutes)
  readonly maxEventsRetained?: number | undefined; // Default: 2_000 events
  readonly maxGapsRetained?: number | undefined; // Default: 100 gaps
  readonly maxDeduplicationKeys?: number | undefined; // Default: 5_000 keys
  readonly clock?: (() => number) | undefined;
}

export function deriveCanonicalSwapKey(
  signature: string,
  outerInstructionIndex: number,
  swapIndex: number,
): string {
  return `${signature}:${outerInstructionIndex}:${swapIndex}`;
}

export class RollingTradeFlowTracker {
  private readonly poolId: string;
  private readonly tokenMint: string;
  private readonly windowDurationMs: number = 60_000;
  private readonly maxStreamInactivityMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly retentionWindowMs: number;
  private readonly maxEventsRetained: number;
  private readonly maxGapsRetained: number;
  private readonly maxDeduplicationKeys: number;
  private readonly clock: () => number;

  private trackingStartedMs: number;
  private lastEventTimestampMs = 0;
  private lastHeartbeatMs = 0;
  private lastObservedSlot: number | null = null;
  private lastObservationTimestampMs: number;
  private hasActiveBacklog = false;
  private latestCapacityLossTimestampMs: number | null = null;

  private readonly events: TradeEvent[] = [];
  private readonly seenEventIds = new Set<string>();
  private readonly seenSwapKeys = new Set<string>();
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

    if (options.windowDurationMs !== undefined) {
      if (
        typeof options.windowDurationMs !== "number" ||
        !Number.isFinite(options.windowDurationMs) ||
        !Number.isInteger(options.windowDurationMs) ||
        options.windowDurationMs !== 60_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid windowDurationMs: ${String(options.windowDurationMs)}. The strategy requires an exact 60,000 ms window for recentBuys60s/recentSells60s.`,
        );
      }
    }

    if (options.trackingStartedMs !== undefined) {
      if (
        typeof options.trackingStartedMs !== "number" ||
        !Number.isFinite(options.trackingStartedMs) ||
        !Number.isInteger(options.trackingStartedMs) ||
        options.trackingStartedMs <= 0
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid trackingStartedMs: expected positive finite integer, received: ${String(options.trackingStartedMs)}`,
        );
      }
    }

    if (options.maxStreamInactivityMs !== undefined) {
      if (
        typeof options.maxStreamInactivityMs !== "number" ||
        !Number.isFinite(options.maxStreamInactivityMs) ||
        !Number.isInteger(options.maxStreamInactivityMs) ||
        options.maxStreamInactivityMs < 1_000 ||
        options.maxStreamInactivityMs > 60_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid maxStreamInactivityMs: expected integer between 1,000 and 60,000, received: ${String(options.maxStreamInactivityMs)}`,
        );
      }
    }

    if (options.maxFutureSkewMs !== undefined) {
      if (
        typeof options.maxFutureSkewMs !== "number" ||
        !Number.isFinite(options.maxFutureSkewMs) ||
        !Number.isInteger(options.maxFutureSkewMs) ||
        options.maxFutureSkewMs < 1_000 ||
        options.maxFutureSkewMs > 60_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid maxFutureSkewMs: expected integer between 1,000 and 60,000, received: ${String(options.maxFutureSkewMs)}`,
        );
      }
    }

    if (options.retentionWindowMs !== undefined) {
      if (
        typeof options.retentionWindowMs !== "number" ||
        !Number.isFinite(options.retentionWindowMs) ||
        !Number.isInteger(options.retentionWindowMs) ||
        options.retentionWindowMs < 120_000 ||
        options.retentionWindowMs > 3_600_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid retentionWindowMs: expected integer between 120,000 and 3,600,000, received: ${String(options.retentionWindowMs)}`,
        );
      }
    }

    if (options.maxEventsRetained !== undefined) {
      if (
        typeof options.maxEventsRetained !== "number" ||
        !Number.isFinite(options.maxEventsRetained) ||
        !Number.isInteger(options.maxEventsRetained) ||
        options.maxEventsRetained < 10 ||
        options.maxEventsRetained > 100_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid maxEventsRetained: expected integer between 10 and 100,000, received: ${String(options.maxEventsRetained)}`,
        );
      }
    }

    if (options.maxGapsRetained !== undefined) {
      if (
        typeof options.maxGapsRetained !== "number" ||
        !Number.isFinite(options.maxGapsRetained) ||
        !Number.isInteger(options.maxGapsRetained) ||
        options.maxGapsRetained < 2 ||
        options.maxGapsRetained > 10_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid maxGapsRetained: expected integer between 2 and 10,000, received: ${String(options.maxGapsRetained)}`,
        );
      }
    }

    if (options.maxDeduplicationKeys !== undefined) {
      if (
        typeof options.maxDeduplicationKeys !== "number" ||
        !Number.isFinite(options.maxDeduplicationKeys) ||
        !Number.isInteger(options.maxDeduplicationKeys) ||
        options.maxDeduplicationKeys < 50 ||
        options.maxDeduplicationKeys > 200_000
      ) {
        throw new Error(
          `[ROLLING_FLOW_INIT] Invalid maxDeduplicationKeys: expected integer between 50 and 200,000, received: ${String(options.maxDeduplicationKeys)}`,
        );
      }
    }

    this.poolId = options.poolId;
    this.tokenMint = options.tokenMint;
    this.clock = options.clock ?? Date.now;
    this.trackingStartedMs = options.trackingStartedMs ?? this.clock();
    this.lastObservationTimestampMs = this.trackingStartedMs;
    this.windowDurationMs = 60_000;
    this.maxStreamInactivityMs = options.maxStreamInactivityMs ?? 15_000;
    this.maxFutureSkewMs = options.maxFutureSkewMs ?? 5_000;
    this.retentionWindowMs = Math.max(120_000, options.retentionWindowMs ?? 180_000);
    this.maxEventsRetained = options.maxEventsRetained ?? 2_000;
    this.maxGapsRetained = options.maxGapsRetained ?? 100;
    this.maxDeduplicationKeys = options.maxDeduplicationKeys ?? 5_000;
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

  public getGapsCount(): number {
    return this.recordedGaps.length;
  }

  public getLastObservedSlot(): number | null {
    return this.lastObservedSlot;
  }

  public getLastObservationTimestampMs(): number {
    return this.lastObservationTimestampMs;
  }

  /**
   * Resets tracking start time to a specific epoch millisecond.
   */
  public setTrackingStartedMs(timestampMs: number): void {
    if (
      typeof timestampMs !== "number" ||
      !Number.isFinite(timestampMs) ||
      !Number.isInteger(timestampMs) ||
      timestampMs <= 0
    ) {
      throw new Error(`[INVALID_TRACKING_START] Invalid timestamp: ${timestampMs}`);
    }
    this.trackingStartedMs = timestampMs;
    this.lastObservationTimestampMs = timestampMs;
  }

  /**
   * Records a stream heartbeat checkpoint.
   * Proves continuous stream liveness across the requested window.
   */
  public recordHeartbeat(
    heartbeatMs: number,
    slot?: number | undefined,
    options?: { readonly isBacklogged?: boolean | undefined },
  ): void {
    if (
      typeof heartbeatMs !== "number" ||
      !Number.isFinite(heartbeatMs) ||
      !Number.isInteger(heartbeatMs) ||
      heartbeatMs <= 0
    ) {
      return;
    }

    const currentNow = this.clock();
    if (heartbeatMs > currentNow + this.maxFutureSkewMs) {
      return;
    }

    if (options?.isBacklogged !== undefined) {
      this.hasActiveBacklog = Boolean(options.isBacklogged);
    }

    // Check for silence gap prior to this heartbeat
    this.updateObservationTimeline(heartbeatMs);

    this.lastHeartbeatMs = Math.max(this.lastHeartbeatMs, heartbeatMs);
    if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0) {
      this.lastObservedSlot = slot;
    }
  }

  /**
   * Explicitly records an observation checkpoint to prove stream liveness.
   */
  public recordObservationCheckpoint(checkpointMs: number): void {
    if (
      typeof checkpointMs !== "number" ||
      !Number.isFinite(checkpointMs) ||
      !Number.isInteger(checkpointMs) ||
      checkpointMs <= 0
    ) {
      return;
    }
    const currentNow = this.clock();
    if (checkpointMs > currentNow + this.maxFutureSkewMs) {
      return;
    }
    this.updateObservationTimeline(checkpointMs);
  }

  /**
   * Explicitly records a completed, gapless observed time range (e.g. from a verified block range poll).
   */
  public recordCompletedRange(rangeStartMs: number, rangeEndMs: number): void {
    if (
      typeof rangeStartMs !== "number" ||
      typeof rangeEndMs !== "number" ||
      !Number.isFinite(rangeStartMs) ||
      !Number.isFinite(rangeEndMs) ||
      !Number.isInteger(rangeStartMs) ||
      !Number.isInteger(rangeEndMs) ||
      rangeStartMs > rangeEndMs ||
      rangeStartMs <= 0
    ) {
      return;
    }

    if (rangeStartMs - this.lastObservationTimestampMs > this.maxStreamInactivityMs) {
      this.insertAndBoundGap(
        this.lastObservationTimestampMs,
        rangeStartMs,
        "STREAM_INACTIVITY_BEFORE_RANGE",
      );
    }
    this.lastObservationTimestampMs = Math.max(this.lastObservationTimestampMs, rangeEndMs);
  }

  /**
   * Explicitly records an unobserved stream outage or collection gap.
   * Copies, freezes, and bounds the gap record.
   */
  public recordCollectionGap(gap: StreamGap): void {
    if (!gap || typeof gap !== "object") return;
    if (
      typeof gap.gapStartMs !== "number" ||
      typeof gap.gapEndMs !== "number" ||
      !Number.isFinite(gap.gapStartMs) ||
      !Number.isFinite(gap.gapEndMs) ||
      !Number.isInteger(gap.gapStartMs) ||
      !Number.isInteger(gap.gapEndMs) ||
      gap.gapStartMs > gap.gapEndMs ||
      gap.gapStartMs <= 0
    ) {
      return;
    }
    this.insertAndBoundGap(gap.gapStartMs, gap.gapEndMs, gap.reason);
  }

  /**
   * Explicitly sets stream processing backlog state.
   */
  public recordProcessingBacklog(isBacklogged: boolean): void {
    this.hasActiveBacklog = Boolean(isBacklogged);
  }

  /**
   * Ingests an authentic or synthetic trade event.
   * Enforces strict validation, temporal coherence, canonical coordinate deduplication,
   * storage bounds, capacity-loss recording, and immutable snapshot freezing.
   *
   * CRITICAL GUARANTEE: Ingesting trade events populates candidate trade counts,
   * but NEVER updates the observation timeline or fabricates stream coverage.
   */
  public ingestTrade(event: TradeEvent): IngestTradeResult {
    if (!event || typeof event !== "object") {
      return {
        ok: false,
        reason: "INVALID_EVENT_OBJECT",
        message: "Trade event must be a non-null object",
      };
    }

    if (
      !event.signature ||
      typeof event.signature !== "string" ||
      event.signature.trim().length === 0
    ) {
      return {
        ok: false,
        reason: "INVALID_SIGNATURE",
        message: "Trade event must have a non-empty signature string",
      };
    }

    if (
      typeof event.swapIndex !== "number" ||
      !Number.isFinite(event.swapIndex) ||
      !Number.isInteger(event.swapIndex) ||
      event.swapIndex < 0
    ) {
      return {
        ok: false,
        reason: "INVALID_SWAP_INDEX",
        message: `Trade event swapIndex must be a non-negative integer, received: ${String(event.swapIndex)}`,
      };
    }

    const outerInstructionIndex = event.outerInstructionIndex ?? 0;
    if (
      typeof outerInstructionIndex !== "number" ||
      !Number.isFinite(outerInstructionIndex) ||
      !Number.isInteger(outerInstructionIndex) ||
      outerInstructionIndex < 0
    ) {
      return {
        ok: false,
        reason: "INVALID_INSTRUCTION_INDEX",
        message: `Trade event outerInstructionIndex must be a non-negative integer, received: ${String(outerInstructionIndex)}`,
      };
    }

    if (!event.eventId || typeof event.eventId !== "string" || event.eventId.trim().length === 0) {
      return {
        ok: false,
        reason: "MISSING_EVENT_ID",
        message: "Trade event must have a non-empty eventId",
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
      typeof event.slot !== "number" ||
      !Number.isFinite(event.slot) ||
      !Number.isInteger(event.slot) ||
      event.slot < 0
    ) {
      return {
        ok: false,
        reason: "INVALID_SLOT",
        message: `Trade slot must be a non-negative integer, received: ${String(event.slot)}`,
      };
    }

    if (
      typeof event.receiptTimestampMs !== "number" ||
      !Number.isFinite(event.receiptTimestampMs) ||
      !Number.isInteger(event.receiptTimestampMs) ||
      event.receiptTimestampMs <= 0
    ) {
      return {
        ok: false,
        reason: "INVALID_RECEIPT_TIMESTAMP",
        message: `Trade receiptTimestampMs must be a positive finite integer, received: ${String(event.receiptTimestampMs)}`,
      };
    }

    const currentNow = this.clock();
    if (event.receiptTimestampMs > currentNow + this.maxFutureSkewMs) {
      return {
        ok: false,
        reason: "FUTURE_DATED_RECEIPT_TIMESTAMP",
        message: `Receipt timestamp ${event.receiptTimestampMs} exceeds current clock plus allowable skew (${currentNow + this.maxFutureSkewMs})`,
      };
    }

    if (
      typeof event.eventTimestampMs !== "number" ||
      !Number.isFinite(event.eventTimestampMs) ||
      !Number.isInteger(event.eventTimestampMs) ||
      event.eventTimestampMs <= 0
    ) {
      return {
        ok: false,
        reason: "INVALID_TIMESTAMP",
        message: `Event timestamp must be a positive finite integer, received: ${String(event.eventTimestampMs)}`,
      };
    }

    if (event.eventTimestampMs > currentNow + this.maxFutureSkewMs) {
      return {
        ok: false,
        reason: "FUTURE_DATED_TIMESTAMP",
        message: `Event timestamp ${event.eventTimestampMs} exceeds allowable future skew (${currentNow + this.maxFutureSkewMs})`,
      };
    }

    // Temporal relationship: trade execution time cannot be significantly in the future relative to local receipt time
    if (event.eventTimestampMs > event.receiptTimestampMs + this.maxFutureSkewMs) {
      return {
        ok: false,
        reason: "CONTRADICTORY_TIMESTAMPS",
        message: `eventTimestampMs (${event.eventTimestampMs}) cannot exceed receiptTimestampMs (${event.receiptTimestampMs}) plus future skew`,
      };
    }

    if (
      event.timestampProvenance !== "ON_CHAIN_BLOCK_TIME" &&
      event.timestampProvenance !== "HOST_OBSERVED" &&
      event.timestampProvenance !== "SYNTHETIC_FIXTURE"
    ) {
      return {
        ok: false,
        reason: "INVALID_PROVENANCE",
        message: `Invalid or missing timestampProvenance: '${String(event.timestampProvenance)}'`,
      };
    }

    // Provenance temporal consistency
    if (event.timestampProvenance === "ON_CHAIN_BLOCK_TIME") {
      if (
        typeof event.blockTimeSec !== "number" ||
        !Number.isFinite(event.blockTimeSec) ||
        !Number.isInteger(event.blockTimeSec) ||
        event.blockTimeSec <= 0
      ) {
        return {
          ok: false,
          reason: "INVALID_TIMESTAMP",
          message: "ON_CHAIN_BLOCK_TIME provenance requires positive integer blockTimeSec",
        };
      }
      const blockTimeMs = event.blockTimeSec * 1000;
      if (Math.abs(event.eventTimestampMs - blockTimeMs) > 2_000) {
        return {
          ok: false,
          reason: "CONTRADICTORY_TIMESTAMPS",
          message: `eventTimestampMs (${event.eventTimestampMs}) contradicts blockTimeSec (${event.blockTimeSec}) by > 2000ms`,
        };
      }
    } else if (event.timestampProvenance === "HOST_OBSERVED") {
      if (
        Math.abs(event.eventTimestampMs - event.receiptTimestampMs) >
        this.maxFutureSkewMs + 5_000
      ) {
        return {
          ok: false,
          reason: "CONTRADICTORY_TIMESTAMPS",
          message: `HOST_OBSERVED eventTimestampMs (${event.eventTimestampMs}) contradicts receiptTimestampMs (${event.receiptTimestampMs})`,
        };
      }
    } else if (event.timestampProvenance === "SYNTHETIC_FIXTURE") {
      if (
        event.blockTimeSec !== null &&
        Math.abs(event.eventTimestampMs - event.blockTimeSec * 1000) > 2_000
      ) {
        return {
          ok: false,
          reason: "CONTRADICTORY_TIMESTAMPS",
          message: `Synthetic eventTimestampMs contradicts blockTimeSec by > 2000ms`,
        };
      }
    }

    // Derive stable canonical swap identity coordinates
    const canonicalSwapKey = deriveCanonicalSwapKey(
      event.signature,
      outerInstructionIndex,
      event.swapIndex,
    );

    // Deduplication check across canonical coordinates AND supplied eventId
    if (this.seenSwapKeys.has(canonicalSwapKey) || this.seenEventIds.has(event.eventId)) {
      this.deduplicatedEventsCount++;
      return {
        ok: false,
        reason: "DUPLICATE_EVENT",
        message: `Event '${event.eventId}' (canonical '${canonicalSwapKey}') has already been ingested and deduplicated`,
      };
    }

    // Prune expired entries before capacity evaluation
    this.pruneExpired(currentNow);

    // Enforce storage capacity limits during ingestion
    if (this.events.length >= this.maxEventsRetained) {
      this.recordCapacityLoss(event.eventTimestampMs, "MAX_EVENTS_RETAINED_REACHED");
      return {
        ok: false,
        reason: "CAPACITY_EXCEEDED",
        message: `Maximum event capacity (${this.maxEventsRetained}) reached; active-window event rejected and capacity loss recorded`,
      };
    }

    if (this.seenSwapKeys.size >= this.maxDeduplicationKeys) {
      this.recordCapacityLoss(event.eventTimestampMs, "MAX_DEDUP_KEYS_REACHED");
      return {
        ok: false,
        reason: "CAPACITY_EXCEEDED",
        message: `Maximum deduplication key capacity (${this.maxDeduplicationKeys}) reached; event rejected and capacity loss recorded`,
      };
    }

    // NOTE: ingestTrade explicitly DOES NOT update the observation timeline.
    // Stream liveness must be proven via continuous heartbeats/checkpoints.

    // Create an immutable frozen snapshot to prevent caller mutation of ingested state
    const frozenEvent: TradeEvent = Object.freeze({
      eventId: event.eventId,
      signature: event.signature,
      swapIndex: event.swapIndex,
      outerInstructionIndex,
      poolId: event.poolId,
      tokenMint: event.tokenMint,
      side: event.side,
      slot: event.slot,
      blockTimeSec: event.blockTimeSec ?? null,
      eventTimestampMs: event.eventTimestampMs,
      receiptTimestampMs: event.receiptTimestampMs,
      timestampProvenance: event.timestampProvenance,
      tokenAmount: event.tokenAmount,
      solAmount: event.solAmount,
    });

    this.seenSwapKeys.add(canonicalSwapKey);
    this.seenEventIds.add(frozenEvent.eventId);
    this.totalEventsIngested++;
    this.lastEventTimestampMs = Math.max(this.lastEventTimestampMs, frozenEvent.eventTimestampMs);
    if (frozenEvent.slot > 0) {
      this.lastObservedSlot = Math.max(this.lastObservedSlot ?? 0, frozenEvent.slot);
    }

    // Insert in chronological order
    this.insertChronologically(frozenEvent);

    return { ok: true, eventId: frozenEvent.eventId, canonicalSwapKey };
  }

  /**
   * Evaluates the latest 60-second rolling window.
   * Dynamic recalculation: does not impose a 60-second evaluation interval.
   */
  public evaluateWindow(evaluationTimestampMs?: number | undefined): RollingFlowEvaluationResult {
    if (evaluationTimestampMs !== undefined) {
      if (
        typeof evaluationTimestampMs !== "number" ||
        !Number.isFinite(evaluationTimestampMs) ||
        !Number.isInteger(evaluationTimestampMs) ||
        evaluationTimestampMs <= 0
      ) {
        throw new Error(
          `[EVALUATE_WINDOW] Invalid evaluationTimestampMs: expected positive finite integer, received: ${String(evaluationTimestampMs)}`,
        );
      }
    }

    const nowMs = evaluationTimestampMs ?? this.clock();
    const windowStartMs = nowMs - this.windowDurationMs;
    const windowEndMs = nowMs;

    // Prune expired events and gaps beyond retention window
    this.pruneExpired(nowMs);

    // Check observation timeline up to nowMs
    if (nowMs - this.lastObservationTimestampMs > this.maxStreamInactivityMs) {
      this.insertAndBoundGap(
        this.lastObservationTimestampMs,
        nowMs,
        "STREAM_INACTIVITY_AT_EVALUATION",
      );
    }

    // Determine coverage across [windowStartMs, windowEndMs]
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
        latestCapacityLossMs: this.latestCapacityLossTimestampMs,
        hasActiveBacklog: this.hasActiveBacklog,
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

  private updateObservationTimeline(observationMs: number): void {
    if (observationMs < this.lastObservationTimestampMs) {
      // Out-of-order observation from earlier timestamp; does not bridge forward silence
      return;
    }

    // If silence exceeded maxStreamInactivityMs, an unobserved gap occurred
    if (observationMs - this.lastObservationTimestampMs > this.maxStreamInactivityMs) {
      this.insertAndBoundGap(
        this.lastObservationTimestampMs,
        observationMs,
        "STREAM_INACTIVITY_GAP",
      );
    }

    this.lastObservationTimestampMs = Math.max(this.lastObservationTimestampMs, observationMs);
  }

  private recordCapacityLoss(lossTimestampMs: number, reason: string): void {
    this.latestCapacityLossTimestampMs = Math.max(
      this.latestCapacityLossTimestampMs ?? 0,
      lossTimestampMs,
    );
    this.insertAndBoundGap(
      lossTimestampMs,
      lossTimestampMs + this.windowDurationMs,
      `CAPACITY_LOSS:${reason}`,
    );
  }

  private insertAndBoundGap(startMs: number, endMs: number, reason?: string): void {
    if (startMs >= endMs || startMs <= 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return;
    }

    // 1. First prune expired gaps beyond retention window
    const nowMs = this.clock();
    const cutoffMs = nowMs - this.retentionWindowMs;
    this.pruneExpiredGaps(cutoffMs);

    // 2. Insert new gap
    const newGap: StreamGap = Object.freeze({
      gapStartMs: startMs,
      gapEndMs: endMs,
      reason: reason ?? undefined,
    });
    this.recordedGaps.push(newGap);

    // 3. Sort gaps chronologically by gapStartMs
    this.recordedGaps.sort((a, b) => a.gapStartMs - b.gapStartMs || a.gapEndMs - b.gapEndMs);

    // 4. Coalesce overlapping or touching gaps
    this.coalesceOverlappingGaps();

    // 5. Enforce maxGapsRetained ceiling: merge closest adjacent pairs until length <= maxGapsRetained
    while (this.recordedGaps.length > this.maxGapsRetained) {
      let minDistance = Infinity;
      let bestMergeIndex = 0;

      for (let i = 0; i < this.recordedGaps.length - 1; i++) {
        const dist = this.recordedGaps[i + 1]!.gapStartMs - this.recordedGaps[i]!.gapEndMs;
        if (dist < minDistance) {
          minDistance = dist;
          bestMergeIndex = i;
        }
      }

      const g1 = this.recordedGaps[bestMergeIndex]!;
      const g2 = this.recordedGaps[bestMergeIndex + 1]!;
      const mergedReason =
        g1.reason && g2.reason && g1.reason !== g2.reason
          ? `${g1.reason}; ${g2.reason}`
          : (g1.reason ?? g2.reason);

      const mergedGap: StreamGap = Object.freeze({
        gapStartMs: g1.gapStartMs,
        gapEndMs: Math.max(g1.gapEndMs, g2.gapEndMs),
        reason: mergedReason,
      });

      this.recordedGaps.splice(bestMergeIndex, 2, mergedGap);
    }
  }

  private coalesceOverlappingGaps(): void {
    if (this.recordedGaps.length <= 1) return;

    const merged: StreamGap[] = [];
    let current = this.recordedGaps[0]!;

    for (let i = 1; i < this.recordedGaps.length; i++) {
      const next = this.recordedGaps[i]!;
      if (current.gapEndMs >= next.gapStartMs) {
        // Overlapping or touching: merge
        const mergedReason =
          current.reason && next.reason && current.reason !== next.reason
            ? `${current.reason}; ${next.reason}`
            : (current.reason ?? next.reason);
        current = Object.freeze({
          gapStartMs: current.gapStartMs,
          gapEndMs: Math.max(current.gapEndMs, next.gapEndMs),
          reason: mergedReason,
        });
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    this.recordedGaps.length = 0;
    this.recordedGaps.push(...merged);
  }

  private pruneExpiredGaps(cutoffMs: number): void {
    let removeCount = 0;
    while (
      removeCount < this.recordedGaps.length &&
      this.recordedGaps[removeCount]!.gapEndMs < cutoffMs
    ) {
      removeCount++;
    }
    if (removeCount > 0) {
      this.recordedGaps.splice(0, removeCount);
    }
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

    // 2. Warm-up: elapsed tracking duration is less than the required 60s window
    if (nowMs - this.trackingStartedMs < this.windowDurationMs) {
      return "WARM_UP";
    }

    // 3. Processing Backlog
    if (this.hasActiveBacklog) {
      return "PROCESSING_BACKLOG";
    }

    // 4. Capacity Loss affecting window
    if (
      this.latestCapacityLossTimestampMs !== null &&
      this.latestCapacityLossTimestampMs >= windowStartMs
    ) {
      return "CAPACITY_LOSS";
    }

    // 5. Collection Gaps intersecting [windowStartMs, windowEndMs]
    for (const gap of this.recordedGaps) {
      if (gap.gapStartMs < windowEndMs && gap.gapEndMs > windowStartMs) {
        return "COLLECTION_GAP";
      }
    }

    // 6. Stale Data: silence since last observation exceeds threshold
    if (nowMs - this.lastObservationTimestampMs > this.maxStreamInactivityMs) {
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
      const canonicalKey = deriveCanonicalSwapKey(
        expiredEvent.signature,
        expiredEvent.outerInstructionIndex ?? 0,
        expiredEvent.swapIndex,
      );
      this.seenSwapKeys.delete(canonicalKey);
      removeCount++;
    }

    if (removeCount > 0) {
      this.events.splice(0, removeCount);
    }

    // Prune expired gaps
    this.pruneExpiredGaps(cutoffMs);
  }
}
