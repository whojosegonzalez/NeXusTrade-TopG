/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Transaction Source Adapter
 *
 * Minimal, offline-tested adapter connecting injected transaction-signature
 * notifications to bounded getTransaction retrieval, decoding, and tracker ingestion.
 *
 * Operational and Safety Invariants (Audit-Corrected):
 * 1. Explicit Transport Injection: Strictly requires an injected transport (fetch).
 *    Default live networking, automated daemon wiring, and ambient subscriptions are prohibited.
 * 2. Immutable Identity Binding & Response Envelope Validation:
 *    - Validates and deep-freezes notification snapshots immediately before queueing or awaiting.
 *    - Rejects null, undefined, or non-object notifications fail-closed without throwing.
 *    - Validates returned JSON-RPC transaction signature against requested signature.
 *    - Detects slot/time contradictions between notification and response, producing zero ingested events.
 * 3. Shared Session Budget, Pacing & Capacity Reservation:
 *    - Default request purpose is CANDIDATE_ENRICHMENT, preserving reserved forward observation capacity.
 *    - Adapter enforces effective provider pacing (>= 2,500 ms) regardless of budget spacing settings.
 *    - Transport specifies redirect: "error" to prevent uncounted chained dispatches.
 * 4. Active Deduplication Protection & Workload Bounds:
 *    - Queued and in-flight signatures are strictly protected from FIFO eviction.
 *    - Completed historical signatures are bounded separately up to maxDeduplicationKeys (FIFO).
 *    - Direct processNotification calls and queued items share a unified active workload limit
 *      (pendingQueue.length + inFlightCount < maxPendingQueueSize).
 * 5. Loss Preservation, Backlog Reporting & Partial Failure Accounting:
 *    - Propagates stream processing backlog to tracker.
 *    - Records collection gaps in tracker on queue overflow, retrieval failures, and partial ingestions.
 *    - Buffers pending gaps when enqueue occurs before a tracker is supplied; flushes to tracker on intake.
 *    - Accurately classifies and reports partial ingestion failures (e.g. tracker capacity limit).
 * 6. Deadlines & Timeout Protection:
 *    - Validates constructor and per-operation numeric options (rejecting NaN, non-integers, ceiling violations).
 *    - Rechecks remaining deadline before dispatch AND immediately before tracker ingestion.
 *    - Cleans up abort listeners in all execution paths.
 * 7. Sanitized Diagnostics:
 *    - Endpoint credentials, API keys, and sensitive tokens are redacted to [REDACTED] in all error messages.
 */

import { createHash } from "node:crypto";
import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
  RaydiumAmmV4SwapNormalizationAdapter,
  type DecodeSwapOptions,
} from "./RaydiumAmmV4SwapDecoder.js";
import {
  type RollingTradeFlowTracker,
  type TradeTimestampProvenance,
  type StreamGap,
} from "./RollingTradeFlowTracker.js";
import {
  MIN_HOST_PACING_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_OVERALL_TIMEOUT_MS,
  PreDispatchError,
} from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import { sanitizeSolanaRpcUrl } from "../research/pilot/SolanaRpcLiveObservationClient.js";
import type {
  GlobalResourceBudgetManager,
  RequestPurpose,
} from "../research/prospective/GlobalResourceBudgetManager.js";

/**
 * Injected transaction-signature notification.
 */
export interface InjectedTransactionNotification {
  readonly signature: string;
  readonly slot?: number | undefined;
  readonly blockTime?: number | null | undefined;
  readonly receivedAtMs?: number | undefined;
  readonly provenance?: TradeTimestampProvenance | string | undefined;
}

export type TransactionProcessingOutcome =
  | "SUCCESS"
  | "DUPLICATE_NOTIFICATION"
  | "INVALID_NOTIFICATION"
  | "QUEUE_OVERFLOW"
  | "PRE_DISPATCH_BUDGET_DENIED"
  | "PRE_DISPATCH_DEADLINE_EXCEEDED"
  | "REQUEST_TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "RPC_ERROR"
  | "TRANSACTION_NOT_FOUND"
  | "RESPONSE_SIGNATURE_MISMATCH"
  | "CONTRADICTORY_METADATA"
  | "DECODE_FAILED"
  | "INGEST_FAILED"
  | "PARTIAL_INGEST_FAILED";

export interface TransactionSourceDiagnostics {
  readonly signature: string;
  readonly httpAttempts: number;
  readonly httpStatus?: number | undefined;
  readonly durationMs: number;
  readonly outcome: TransactionProcessingOutcome;
  readonly decodedEventsCount: number;
  readonly ingestedCount: number;
  readonly error?: string | undefined;
  readonly endpointUrl?: string | undefined;
  readonly requestSentAtMs?: number | undefined;
  readonly responseReceivedAtMs?: number | undefined;
  readonly responseSha256?: string | undefined;
}

export interface ProcessNotificationResult {
  readonly ok: boolean;
  readonly signature: string;
  readonly outcome: TransactionProcessingOutcome;
  readonly diagnostics: TransactionSourceDiagnostics;
  readonly ingestedEventsCount: number;
}

export interface EnqueueNotificationResult {
  readonly ok: boolean;
  readonly signature: string;
  readonly queued: boolean;
  readonly reason?:
    | "DUPLICATE_NOTIFICATION"
    | "INVALID_NOTIFICATION"
    | "QUEUE_OVERFLOW"
    | undefined;
}

export interface ProcessBatchResult {
  readonly totalProcessed: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
  readonly totalIngestedEvents: number;
  readonly results: readonly ProcessNotificationResult[];
}

export interface ProcessTransactionOptions {
  readonly overallTimeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RaydiumAmmV4TransactionSourceAdapterOptions {
  /** Tracked Raydium pool context. Mandatory. */
  readonly poolContext: TrackedRaydiumPoolContext;

  /** Solana RPC endpoint URL. Mandatory. */
  readonly rpcUrl: string;

  /** Shared resource budget manager. Mandatory. */
  readonly budgetManager: GlobalResourceBudgetManager;

  /** Explicitly injected transport (fetch). Mandatory; default live networking is disabled. */
  readonly transport: typeof fetch;

  /** Provider identifier for shared pacing and ceilings. Default: "SOLANA_RPC". */
  readonly providerName?: string | undefined;

  /** Request purpose for budget accounting. Default: "CANDIDATE_ENRICHMENT" (preserves reserved forward capacity). */
  readonly requestPurpose?: RequestPurpose | undefined;

  /** Minimum host pacing in ms between calls to same provider. Default: 2,500 ms (MIN_HOST_PACING_MS). */
  readonly pacingMs?: number | undefined;

  /** Per-request HTTP timeout in ms. Default: 10,000 ms. */
  readonly timeoutMs?: number | undefined;

  /** Overall deadline ceiling in ms for a process operation. Default: 60,000 ms. */
  readonly overallTimeoutMs?: number | undefined;

  /** Maximum pending notification queue capacity. Default: 100. */
  readonly maxPendingQueueSize?: number | undefined;

  /** Maximum deduplication signatures retained in completed history. Default: 1,000. */
  readonly maxDeduplicationKeys?: number | undefined;

  /** RPC commitment level. Default: "confirmed". */
  readonly commitment?: "confirmed" | "finalized" | undefined;

  /** Max supported transaction version for RPC. Default: 0. */
  readonly maxSupportedTransactionVersion?: number | undefined;

  /** Optional associated RollingTradeFlowTracker for immediate backlog propagation and gap flushing. */
  readonly tracker?: RollingTradeFlowTracker | undefined;

  /** Monotonic clock function. Default: Date.now. */
  readonly clock?: (() => number) | undefined;

  /** Sleep function for pacing waits. Default: setTimeout promise. */
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Races a pacing wait against an optional AbortSignal.
 */
async function sleepWithSignal(
  ms: number,
  sleepFn: (ms: number) => Promise<void>,
  signal?: AbortSignal | null | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new PreDispatchError("ABORTED: Request was cancelled before pacing wait");
  }
  if (!signal) {
    await sleepFn(ms);
    return;
  }
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      sleepFn(ms),
      new Promise<never>((_, reject) => {
        abortListener = () => {
          reject(new PreDispatchError("ABORTED: Request was cancelled during pacing wait"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

const VALID_PURPOSES = new Set<RequestPurpose>([
  "DISCOVERY_POLL",
  "CANDIDATE_ENRICHMENT",
  "INITIAL_QUOTE",
  "FORWARD_OBSERVATION",
  "RETRY",
]);

/**
 * Safely validates and deeply freezes an injected notification snapshot.
 * Rejects null, undefined, non-objects, and invalid signatures fail-closed without throwing.
 */
function validateAndSnapshotNotification(
  input: unknown,
):
  | { ok: true; notification: InjectedTransactionNotification }
  | { ok: false; signature: string; reason: "INVALID_NOTIFICATION" } {
  if (!input || (typeof input !== "object" && typeof input !== "string")) {
    return { ok: false, signature: "invalid", reason: "INVALID_NOTIFICATION" };
  }

  const rawSig = typeof input === "string" ? input : (input as Record<string, unknown>).signature;
  if (typeof rawSig !== "string") {
    return { ok: false, signature: "invalid", reason: "INVALID_NOTIFICATION" };
  }

  const trimmedSig = rawSig.trim();
  if (trimmedSig.length < 32 || trimmedSig.length > 128 || !BASE58_REGEX.test(trimmedSig)) {
    return { ok: false, signature: trimmedSig || "invalid", reason: "INVALID_NOTIFICATION" };
  }

  let slot: number | undefined;
  if (typeof input === "object" && (input as Record<string, unknown>).slot !== undefined) {
    const s = (input as Record<string, unknown>).slot;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0) {
      return { ok: false, signature: trimmedSig, reason: "INVALID_NOTIFICATION" };
    }
    slot = s;
  }

  let blockTime: number | null | undefined;
  if (typeof input === "object" && (input as Record<string, unknown>).blockTime !== undefined) {
    const bt = (input as Record<string, unknown>).blockTime;
    if (bt !== null && (typeof bt !== "number" || !Number.isFinite(bt) || bt <= 0)) {
      return { ok: false, signature: trimmedSig, reason: "INVALID_NOTIFICATION" };
    }
    blockTime = bt;
  }

  let receivedAtMs: number | undefined;
  if (typeof input === "object" && (input as Record<string, unknown>).receivedAtMs !== undefined) {
    const r = (input as Record<string, unknown>).receivedAtMs;
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) {
      return { ok: false, signature: trimmedSig, reason: "INVALID_NOTIFICATION" };
    }
    receivedAtMs = r;
  }

  let provenance: TradeTimestampProvenance | string | undefined;
  if (typeof input === "object" && (input as Record<string, unknown>).provenance !== undefined) {
    const p = (input as Record<string, unknown>).provenance;
    if (typeof p !== "string" || p.trim().length === 0) {
      return { ok: false, signature: trimmedSig, reason: "INVALID_NOTIFICATION" };
    }
    provenance = p.trim();
  }

  const frozenSnapshot: InjectedTransactionNotification = Object.freeze({
    signature: trimmedSig,
    slot,
    blockTime,
    receivedAtMs,
    provenance,
  });

  return { ok: true, notification: frozenSnapshot };
}

export class RaydiumAmmV4TransactionSourceAdapter {
  private readonly poolContext: TrackedRaydiumPoolContext;
  private readonly normalizationAdapter: RaydiumAmmV4SwapNormalizationAdapter;
  private readonly rpcUrl: string;
  private readonly sanitizedRpcUrl: string;
  private readonly sensitiveTokens: readonly string[];
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly underlyingTransport: typeof fetch;
  private readonly providerName: string;
  private readonly requestPurpose: RequestPurpose;
  private readonly pacingMs: number;
  private readonly timeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly maxPendingQueueSize: number;
  private readonly maxDeduplicationKeys: number;
  private readonly commitment: "confirmed" | "finalized";
  private readonly maxSupportedTransactionVersion: number;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  // Workload and active deduplication tracking
  private readonly pendingQueue: InjectedTransactionNotification[] = [];
  private readonly activeSignatures = new Set<string>(); // Queued or in-flight (protected from eviction)
  private readonly completedSignatures = new Set<string>(); // Historical completions (bounded FIFO cache)
  private inFlightCount = 0;

  // Associated tracker for immediate backlog reporting and loss flushing
  private associatedTracker?: RollingTradeFlowTracker | undefined;

  // Provider dispatch chain for safe concurrent admission
  private readonly dispatchChainByProvider = new Map<string, Promise<void>>();

  // Unprocessed gap buffer for losses occurring before or between tracker intake
  private readonly pendingGaps: StreamGap[] = [];

  // Provider dispatch tracking for effective pacing enforcement
  private readonly lastDispatchTimeByProvider = new Map<string, number>();

  // Diagnostic counters
  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalDuplicatesSkipped = 0;
  private totalQueueOverflows = 0;
  private totalDispatchedAttempts = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;

  public constructor(options: RaydiumAmmV4TransactionSourceAdapterOptions) {
    if (!options.transport) {
      throw new Error(
        "Explicit transport is required for RaydiumAmmV4TransactionSourceAdapter; default live networking is disabled",
      );
    }
    if (!options.budgetManager) {
      throw new Error(
        "Shared GlobalResourceBudgetManager is required for RaydiumAmmV4TransactionSourceAdapter",
      );
    }
    if (
      !options.rpcUrl ||
      typeof options.rpcUrl !== "string" ||
      options.rpcUrl.trim().length === 0
    ) {
      throw new Error("rpcUrl is required for RaydiumAmmV4TransactionSourceAdapter");
    }

    validateTrackedPoolContext(options.poolContext);
    this.poolContext = Object.freeze({ ...options.poolContext });
    this.normalizationAdapter = new RaydiumAmmV4SwapNormalizationAdapter(this.poolContext);

    this.rpcUrl = options.rpcUrl;
    const endpointInfo = sanitizeSolanaRpcUrl(options.rpcUrl);
    this.sanitizedRpcUrl = endpointInfo.sanitizedUrl;
    this.sensitiveTokens = Object.freeze([...endpointInfo.sensitiveTokens]);

    this.budgetManager = options.budgetManager;
    this.underlyingTransport = options.transport;
    this.providerName = options.providerName ?? "SOLANA_RPC";

    const purpose = options.requestPurpose ?? "CANDIDATE_ENRICHMENT";
    if (!VALID_PURPOSES.has(purpose)) {
      throw new Error(`Invalid requestPurpose: ${String(purpose)}`);
    }
    this.requestPurpose = purpose;

    if (
      options.pacingMs !== undefined &&
      (typeof options.pacingMs !== "number" ||
        !Number.isFinite(options.pacingMs) ||
        !Number.isInteger(options.pacingMs) ||
        options.pacingMs < 0)
    ) {
      throw new Error("pacingMs must be a non-negative integer");
    }
    this.pacingMs = Math.max(MIN_HOST_PACING_MS, options.pacingMs ?? MIN_HOST_PACING_MS);

    if (
      options.timeoutMs !== undefined &&
      (typeof options.timeoutMs !== "number" ||
        !Number.isFinite(options.timeoutMs) ||
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be a positive integer");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (
      options.overallTimeoutMs !== undefined &&
      (typeof options.overallTimeoutMs !== "number" ||
        !Number.isFinite(options.overallTimeoutMs) ||
        !Number.isInteger(options.overallTimeoutMs) ||
        options.overallTimeoutMs <= 0)
    ) {
      throw new Error("overallTimeoutMs must be a positive integer");
    }
    this.overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;

    const maxQueue = options.maxPendingQueueSize ?? 100;
    if (
      typeof maxQueue !== "number" ||
      !Number.isFinite(maxQueue) ||
      !Number.isInteger(maxQueue) ||
      maxQueue < 1
    ) {
      throw new Error("maxPendingQueueSize must be an integer >= 1");
    }
    this.maxPendingQueueSize = maxQueue;

    const maxDedup = options.maxDeduplicationKeys ?? 1000;
    if (
      typeof maxDedup !== "number" ||
      !Number.isFinite(maxDedup) ||
      !Number.isInteger(maxDedup) ||
      maxDedup < 1
    ) {
      throw new Error("maxDeduplicationKeys must be an integer >= 1");
    }
    this.maxDeduplicationKeys = maxDedup;

    this.commitment = options.commitment ?? "confirmed";
    this.maxSupportedTransactionVersion = options.maxSupportedTransactionVersion ?? 0;
    this.clock = options.clock ?? (() => Date.now());
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    if (options.tracker) {
      this.associatedTracker = options.tracker;
      this.flushPendingGaps(this.associatedTracker);
      this.updateTrackerBacklog();
    }
  }

  /**
   * Associates a RollingTradeFlowTracker with this adapter.
   * Immediately flushes any buffered loss gaps and synchronizes backlog status.
   */
  public associateTracker(tracker: RollingTradeFlowTracker): void {
    this.associatedTracker = tracker;
    this.flushPendingGaps(tracker);
    this.updateTrackerBacklog();
  }

  public getAssociatedTracker(): RollingTradeFlowTracker | undefined {
    return this.associatedTracker;
  }

  /**
   * Synchronizes active stream processing backlog state with the associated tracker.
   * Backlog is true if any queued notifications or in-flight requests remain unresolved.
   */
  private updateTrackerBacklog(): void {
    if (this.associatedTracker) {
      this.associatedTracker.recordProcessingBacklog(this.getActiveWorkload() > 0);
    }
  }

  /**
   * Waits for the previous dispatch turn to release admission.
   * Raced against remaining overall deadline and caller abort signal.
   */
  private async waitForTurn(
    prevAdmission: Promise<void>,
    remainingMs: number,
    signal?: AbortSignal | null | undefined,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new PreDispatchError("ABORTED: Request was cancelled before dispatch admission");
    }
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new PreDispatchError(
        "DEADLINE_EXCEEDED: Overall deadline exceeded before dispatch admission",
      );
    }

    let abortListener: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        prevAdmission,
        new Promise<never>((_, reject) => {
          if (signal) {
            abortListener = () => {
              reject(
                new PreDispatchError("ABORTED: Request was cancelled before dispatch admission"),
              );
            };
            signal.addEventListener("abort", abortListener, { once: true });
          }
          timer = setTimeout(() => {
            reject(
              new PreDispatchError(
                `DEADLINE_EXCEEDED: Overall deadline exceeded before dispatch admission (limit ${remainingMs}ms)`,
              ),
            );
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  public getPoolContext(): TrackedRaydiumPoolContext {
    return this.poolContext;
  }

  public getPendingQueueLength(): number {
    return this.pendingQueue.length;
  }

  public getInFlightCount(): number {
    return this.inFlightCount;
  }

  public getActiveWorkload(): number {
    return this.pendingQueue.length + this.inFlightCount;
  }

  public getDeduplicationKeysCount(): number {
    return this.activeSignatures.size + this.completedSignatures.size;
  }

  public getCompletedDeduplicationKeysCount(): number {
    return this.completedSignatures.size;
  }

  public getPendingGapsCount(): number {
    return this.pendingGaps.length;
  }

  public getMetrics(): {
    readonly totalEnqueued: number;
    readonly totalProcessed: number;
    readonly totalDuplicatesSkipped: number;
    readonly totalQueueOverflows: number;
    readonly totalDispatchedAttempts: number;
    readonly totalSuccesses: number;
    readonly totalFailures: number;
  } {
    return {
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalDuplicatesSkipped: this.totalDuplicatesSkipped,
      totalQueueOverflows: this.totalQueueOverflows,
      totalDispatchedAttempts: this.totalDispatchedAttempts,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
    };
  }

  /**
   * Sanitizes diagnostic text by redacting RPC URL credentials, query secrets, and sensitive tokens.
   */
  public sanitizeErrorMessage(text: string | undefined): string {
    if (!text) return "";
    let out = text.split(this.rpcUrl).join(this.sanitizedRpcUrl);
    for (const token of this.sensitiveTokens) {
      if (token && token.length > 0) {
        out = out.split(token).join("[REDACTED]");
      }
    }
    out = out.replace(/(?:api[-_]?key|token|secret|password|auth)=([^&\s]+)/gi, "$1=[REDACTED]");
    return out;
  }

  /**
   * Checks whether a signature is already queued, in flight, or recorded in historical deduplication cache.
   */
  public isDuplicate(signature: string): boolean {
    return this.activeSignatures.has(signature) || this.completedSignatures.has(signature);
  }

  /**
   * Records a completed signature in the bounded FIFO historical cache.
   * Evicts only from completed history, strictly protecting queued/in-flight signatures.
   */
  private recordCompletedSignature(signature: string): void {
    if (this.completedSignatures.has(signature)) return;
    if (this.completedSignatures.size >= this.maxDeduplicationKeys) {
      const oldest = this.completedSignatures.values().next().value;
      if (oldest !== undefined) {
        this.completedSignatures.delete(oldest);
      }
    }
    this.completedSignatures.add(signature);
  }

  /**
   * Creates and records a collection gap for unobserved or lost trade events,
   * protecting established tracker coverage.
   */
  private recordLossGap(
    notification: InjectedTransactionNotification,
    reason: string,
    tracker?: RollingTradeFlowTracker | undefined,
  ): void {
    const targetTracker = tracker ?? this.associatedTracker;
    const now = this.clock();
    const candidateTime =
      notification.receivedAtMs ??
      (notification.blockTime !== null && notification.blockTime !== undefined
        ? notification.blockTime * 1000
        : undefined);

    let lossStart: number;
    let lossEnd: number;

    if (candidateTime !== undefined) {
      lossStart = Math.min(candidateTime, now);
      lossEnd = Math.max(candidateTime, now);
      if (lossStart >= lossEnd) {
        lossStart = Math.max(1, lossEnd - 1_000);
      }
    } else {
      lossStart = Math.max(1, now - 1_000);
      lossEnd = now;
    }

    const gap: StreamGap = Object.freeze({
      gapStartMs: lossStart,
      gapEndMs: lossEnd,
      reason: `SOURCE_ADAPTER_LOSS:${reason}`,
    });

    if (targetTracker) {
      targetTracker.recordCollectionGap(gap);
    } else {
      this.insertAndBoundPendingGap(gap);
    }
  }

  /**
   * Bounds and coalesces pending gaps during queue buffering.
   * Enforces maxPendingQueueSize ceiling by merging closest adjacent pairs [min(start), max(end)],
   * preserving full loss window uncertainty fail-closed.
   */
  private insertAndBoundPendingGap(gap: StreamGap): void {
    if (
      gap.gapStartMs >= gap.gapEndMs ||
      gap.gapStartMs <= 0 ||
      !Number.isFinite(gap.gapStartMs) ||
      !Number.isFinite(gap.gapEndMs)
    ) {
      return;
    }

    this.pendingGaps.push(gap);
    this.pendingGaps.sort((a, b) => a.gapStartMs - b.gapStartMs || a.gapEndMs - b.gapEndMs);
    this.coalescePendingGaps();

    while (this.pendingGaps.length > this.maxPendingQueueSize) {
      let minDistance = Infinity;
      let bestMergeIndex = 0;

      for (let i = 0; i < this.pendingGaps.length - 1; i++) {
        const dist = this.pendingGaps[i + 1]!.gapStartMs - this.pendingGaps[i]!.gapEndMs;
        if (dist < minDistance) {
          minDistance = dist;
          bestMergeIndex = i;
        }
      }

      const g1 = this.pendingGaps[bestMergeIndex]!;
      const g2 = this.pendingGaps[bestMergeIndex + 1]!;
      const mergedReason = `${g1.reason ?? ""};${g2.reason ?? ""}`.slice(0, 256);

      const mergedGap: StreamGap = Object.freeze({
        gapStartMs: Math.min(g1.gapStartMs, g2.gapStartMs),
        gapEndMs: Math.max(g1.gapEndMs, g2.gapEndMs),
        reason: mergedReason,
      });

      this.pendingGaps.splice(bestMergeIndex, 2, mergedGap);
    }
  }

  private coalescePendingGaps(): void {
    if (this.pendingGaps.length <= 1) return;

    const merged: StreamGap[] = [];
    let current = this.pendingGaps[0]!;

    for (let i = 1; i < this.pendingGaps.length; i++) {
      const next = this.pendingGaps[i]!;
      if (current.gapEndMs >= next.gapStartMs) {
        const mergedReason = `${current.reason ?? ""};${next.reason ?? ""}`.slice(0, 256);
        current = Object.freeze({
          gapStartMs: Math.min(current.gapStartMs, next.gapStartMs),
          gapEndMs: Math.max(current.gapEndMs, next.gapEndMs),
          reason: mergedReason,
        });
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);

    this.pendingGaps.length = 0;
    this.pendingGaps.push(...merged);
  }

  /**
   * Flushes all buffered pending gaps into the supplied tracker.
   */
  public flushPendingGaps(tracker: RollingTradeFlowTracker): void {
    while (this.pendingGaps.length > 0) {
      const gap = this.pendingGaps.shift()!;
      tracker.recordCollectionGap(gap);
    }
  }

  /**
   * Enqueues an injected transaction notification into the bounded pending queue.
   * Snapshots and validates notification before queueing; protects active keys and bounds workload.
   */
  public enqueueNotification(
    notification: unknown,
    tracker?: RollingTradeFlowTracker | undefined,
  ): EnqueueNotificationResult {
    if (tracker) {
      this.associateTracker(tracker);
    }

    const validated = validateAndSnapshotNotification(notification);
    if (!validated.ok) {
      return {
        ok: false,
        signature: validated.signature,
        queued: false,
        reason: "INVALID_NOTIFICATION",
      };
    }

    const snapshot = validated.notification;

    if (this.isDuplicate(snapshot.signature)) {
      this.totalDuplicatesSkipped++;
      return {
        ok: false,
        signature: snapshot.signature,
        queued: false,
        reason: "DUPLICATE_NOTIFICATION",
      };
    }

    if (this.getActiveWorkload() >= this.maxPendingQueueSize) {
      this.totalQueueOverflows++;
      this.recordLossGap(snapshot, "QUEUE_OVERFLOW");
      return {
        ok: false,
        signature: snapshot.signature,
        queued: false,
        reason: "QUEUE_OVERFLOW",
      };
    }

    this.activeSignatures.add(snapshot.signature);
    this.pendingQueue.push(snapshot);
    this.totalEnqueued++;
    this.updateTrackerBacklog();

    return {
      ok: true,
      signature: snapshot.signature,
      queued: true,
    };
  }

  /**
   * Processes a single notification directly (retrieving, decoding, and ingesting).
   * Enforces deduplication, shared budget pacing, timeouts, and failure classification.
   */
  public async processNotification(
    notification: unknown,
    tracker?: RollingTradeFlowTracker | undefined,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessNotificationResult> {
    if (tracker) {
      this.associateTracker(tracker);
    }
    const targetTracker = tracker ?? this.associatedTracker;
    if (!targetTracker) {
      throw new Error(
        "RollingTradeFlowTracker must be provided to processNotification or associated with adapter",
      );
    }
    this.flushPendingGaps(targetTracker);

    const validated = validateAndSnapshotNotification(notification);
    if (!validated.ok) {
      return {
        ok: false,
        signature: validated.signature,
        outcome: "INVALID_NOTIFICATION",
        ingestedEventsCount: 0,
        diagnostics: {
          signature: validated.signature,
          httpAttempts: 0,
          durationMs: 0,
          outcome: "INVALID_NOTIFICATION",
          decodedEventsCount: 0,
          ingestedCount: 0,
          endpointUrl: this.sanitizedRpcUrl,
          error: "Signature must be a valid non-empty Base58 Solana signature string",
        },
      };
    }

    const snapshot = validated.notification;

    if (this.isDuplicate(snapshot.signature)) {
      this.totalDuplicatesSkipped++;
      return {
        ok: false,
        signature: snapshot.signature,
        outcome: "DUPLICATE_NOTIFICATION",
        ingestedEventsCount: 0,
        diagnostics: {
          signature: snapshot.signature,
          httpAttempts: 0,
          durationMs: 0,
          outcome: "DUPLICATE_NOTIFICATION",
          decodedEventsCount: 0,
          ingestedCount: 0,
          endpointUrl: this.sanitizedRpcUrl,
          error: `Transaction ${snapshot.signature} is already queued, in flight, or recorded in deduplication cache`,
        },
      };
    }

    if (this.getActiveWorkload() >= this.maxPendingQueueSize) {
      this.totalQueueOverflows++;
      this.recordLossGap(snapshot, "QUEUE_OVERFLOW", targetTracker);
      return {
        ok: false,
        signature: snapshot.signature,
        outcome: "QUEUE_OVERFLOW",
        ingestedEventsCount: 0,
        diagnostics: {
          signature: snapshot.signature,
          httpAttempts: 0,
          durationMs: 0,
          outcome: "QUEUE_OVERFLOW",
          decodedEventsCount: 0,
          ingestedCount: 0,
          endpointUrl: this.sanitizedRpcUrl,
          error: `Active workload limit (${this.maxPendingQueueSize}) exceeded; notification rejected`,
        },
      };
    }

    this.activeSignatures.add(snapshot.signature);
    return this.processNotificationInternal(snapshot, targetTracker, options);
  }

  /**
   * Pops and processes the next pending notification from the queue.
   */
  public async processNextPending(
    tracker?: RollingTradeFlowTracker | undefined,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessNotificationResult | null> {
    if (tracker) {
      this.associateTracker(tracker);
    }
    const targetTracker = tracker ?? this.associatedTracker;
    if (!targetTracker) {
      throw new Error(
        "RollingTradeFlowTracker must be provided to processNextPending or associated with adapter",
      );
    }
    this.flushPendingGaps(targetTracker);
    if (this.pendingQueue.length === 0) {
      return null;
    }
    const notification = this.pendingQueue.shift()!;
    return this.processNotificationInternal(notification, targetTracker, options);
  }

  /**
   * Drains and processes all pending notifications currently in the queue.
   * Accurately updates tracker backlog status; queue draining alone does not erase gaps.
   */
  public async processAllPending(
    tracker?: RollingTradeFlowTracker | undefined,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessBatchResult> {
    if (tracker) {
      this.associateTracker(tracker);
    }
    const targetTracker = tracker ?? this.associatedTracker;
    if (!targetTracker) {
      throw new Error(
        "RollingTradeFlowTracker must be provided to processAllPending or associated with adapter",
      );
    }
    this.flushPendingGaps(targetTracker);
    const startEpoch = this.clock();

    // Validate overallTimeoutMs override if passed
    if (options?.overallTimeoutMs !== undefined) {
      if (
        typeof options.overallTimeoutMs !== "number" ||
        !Number.isFinite(options.overallTimeoutMs) ||
        !Number.isInteger(options.overallTimeoutMs) ||
        options.overallTimeoutMs <= 0 ||
        options.overallTimeoutMs > this.overallTimeoutMs
      ) {
        return {
          totalProcessed: 0,
          totalSucceeded: 0,
          totalFailed: 0,
          totalIngestedEvents: 0,
          results: Object.freeze([]),
        };
      }
    }

    const effectiveOverallDeadline =
      startEpoch + (options?.overallTimeoutMs ?? this.overallTimeoutMs);

    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalIngestedEvents = 0;
    const results: ProcessNotificationResult[] = [];

    this.updateTrackerBacklog();

    try {
      while (this.pendingQueue.length > 0) {
        const remainingOverall = effectiveOverallDeadline - this.clock();
        if (remainingOverall <= 0) {
          break;
        }

        const res = await this.processNextPending(targetTracker, {
          overallTimeoutMs: remainingOverall,
          signal: options?.signal,
        });

        if (!res) {
          break;
        }

        totalProcessed++;
        results.push(res);
        totalIngestedEvents += res.ingestedEventsCount; // Accumulated even when res.ok === false
        if (res.ok) {
          totalSucceeded++;
        } else {
          totalFailed++;
          if (
            res.outcome === "PRE_DISPATCH_BUDGET_DENIED" ||
            res.outcome === "PRE_DISPATCH_DEADLINE_EXCEEDED"
          ) {
            break;
          }
        }
      }
    } finally {
      this.updateTrackerBacklog();
    }

    return {
      totalProcessed,
      totalSucceeded,
      totalFailed,
      totalIngestedEvents,
      results: Object.freeze(results),
    };
  }

  /**
   * Core internal processor executing single getTransaction RPC dispatch, decoding, and ingestion.
   */
  private async processNotificationInternal(
    notification: InjectedTransactionNotification,
    tracker: RollingTradeFlowTracker,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessNotificationResult> {
    this.inFlightCount++;
    this.updateTrackerBacklog();
    const startEpoch = this.clock();
    const signature = notification.signature;

    try {
      this.totalProcessed++;
      this.flushPendingGaps(tracker);

      // Validate per-operation overallTimeoutMs override against configured ceiling
      if (options?.overallTimeoutMs !== undefined) {
        if (
          typeof options.overallTimeoutMs !== "number" ||
          !Number.isFinite(options.overallTimeoutMs) ||
          !Number.isInteger(options.overallTimeoutMs) ||
          options.overallTimeoutMs <= 0
        ) {
          this.totalFailures++;
          this.recordLossGap(notification, "INVALID_OVERALL_TIMEOUT_OVERRIDE", tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: 0,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: this.sanitizeErrorMessage(
                `Invalid per-operation overallTimeoutMs override: ${String(options.overallTimeoutMs)}`,
              ),
            },
          };
        }
        if (options.overallTimeoutMs > this.overallTimeoutMs) {
          this.totalFailures++;
          this.recordLossGap(notification, "OVERALL_TIMEOUT_EXCEEDS_CEILING", tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: 0,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: this.sanitizeErrorMessage(
                `Per-operation overallTimeoutMs override (${options.overallTimeoutMs}ms) exceeds configured adapter ceiling (${this.overallTimeoutMs}ms)`,
              ),
            },
          };
        }
      }

      const overallTimeout = options?.overallTimeoutMs ?? this.overallTimeoutMs;
      const effectiveDeadlineEpoch = startEpoch + overallTimeout;

      const getRemainingEffectiveBudgetMs = (): number => {
        return effectiveDeadlineEpoch - this.clock();
      };

      let remainingBudget = getRemainingEffectiveBudgetMs();
      if (remainingBudget <= 0) {
        this.totalFailures++;
        this.recordLossGap(notification, "PRE_DISPATCH_DEADLINE_EXCEEDED", tracker);
        return {
          ok: false,
          signature,
          outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts: 0,
            durationMs: this.clock() - startEpoch,
            outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            error: "Overall deadline exceeded before dispatch",
          },
        };
      }

      // 1. Safe Dispatch Admission Under Concurrency
      const prevAdmission = this.dispatchChainByProvider.get(this.providerName);

      let releaseAdmission!: () => void;
      const currentAdmission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      this.dispatchChainByProvider.set(this.providerName, currentAdmission);

      if (prevAdmission) {
        try {
          if (options?.signal?.aborted) {
            throw new PreDispatchError("ABORTED: Request was cancelled before dispatch admission");
          }
          const waitBudgetMs = getRemainingEffectiveBudgetMs();
          if (waitBudgetMs <= 0) {
            throw new PreDispatchError(
              "DEADLINE_EXCEEDED: Overall deadline exceeded before dispatch admission",
            );
          }

          await this.waitForTurn(prevAdmission, waitBudgetMs, options?.signal);
        } catch (err) {
          // Preserve predecessor ordering: downstream successors must wait until prevAdmission completes!
          void prevAdmission.finally(() => {
            releaseAdmission();
            if (this.dispatchChainByProvider.get(this.providerName) === currentAdmission) {
              this.dispatchChainByProvider.delete(this.providerName);
            }
          });

          this.totalFailures++;
          const isAbort =
            Boolean(options?.signal?.aborted) ||
            (err instanceof PreDispatchError && err.message.includes("ABORTED"));
          const reason = isAbort ? "PACING_WAIT_CANCELLED" : "PRE_DISPATCH_DEADLINE_EXCEEDED";
          this.recordLossGap(notification, reason, tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: this.clock() - startEpoch,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: this.sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
            },
          };
        }
      }

      // Admitted to dispatch pacing: calculate wait and record attempt exclusively
      try {
        remainingBudget = getRemainingEffectiveBudgetMs();
        if (remainingBudget <= 0) {
          this.totalFailures++;
          this.recordLossGap(notification, "PRE_DISPATCH_DEADLINE_EXCEEDED", tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: this.clock() - startEpoch,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: "Overall deadline exceeded before dispatch",
            },
          };
        }

        const lastDispatch = this.lastDispatchTimeByProvider.get(this.providerName) ?? 0;
        const elapsedSinceLastDispatch = this.clock() - lastDispatch;
        const adapterWaitMs = Math.max(0, this.pacingMs - elapsedSinceLastDispatch);

        let budgetCheck = this.budgetManager.canMakeRequest(
          this.providerName,
          this.clock(),
          this.requestPurpose,
        );

        const budgetWaitMs =
          !budgetCheck.allowed &&
          budgetCheck.reason === "PROVIDER_PACING_NOT_MET" &&
          typeof budgetCheck.waitMs === "number" &&
          budgetCheck.waitMs > 0
            ? budgetCheck.waitMs
            : 0;

        const effectivePacingWaitMs = Math.max(adapterWaitMs, budgetWaitMs);

        if (effectivePacingWaitMs > 0) {
          if (effectivePacingWaitMs >= remainingBudget) {
            this.totalFailures++;
            this.recordLossGap(notification, "PACING_WAIT_EXCEEDS_DEADLINE", tracker);
            return {
              ok: false,
              signature,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              ingestedEventsCount: 0,
              diagnostics: {
                signature,
                httpAttempts: 0,
                durationMs: this.clock() - startEpoch,
                outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
                decodedEventsCount: 0,
                ingestedCount: 0,
                endpointUrl: this.sanitizedRpcUrl,
                error: `Pacing wait of ${effectivePacingWaitMs}ms would exceed remaining deadline (${remainingBudget}ms)`,
              },
            };
          }

          try {
            await sleepWithSignal(effectivePacingWaitMs, this.sleepFn, options?.signal);
          } catch (err) {
            this.totalFailures++;
            this.recordLossGap(notification, "PACING_WAIT_CANCELLED", tracker);
            return {
              ok: false,
              signature,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              ingestedEventsCount: 0,
              diagnostics: {
                signature,
                httpAttempts: 0,
                durationMs: this.clock() - startEpoch,
                outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
                decodedEventsCount: 0,
                ingestedCount: 0,
                endpointUrl: this.sanitizedRpcUrl,
                error: this.sanitizeErrorMessage(
                  `Pacing wait cancelled: ${err instanceof Error ? err.message : String(err)}`,
                ),
              },
            };
          }

          remainingBudget = getRemainingEffectiveBudgetMs();
          if (remainingBudget <= 0) {
            this.totalFailures++;
            this.recordLossGap(notification, "PRE_DISPATCH_DEADLINE_EXCEEDED", tracker);
            return {
              ok: false,
              signature,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              ingestedEventsCount: 0,
              diagnostics: {
                signature,
                httpAttempts: 0,
                durationMs: this.clock() - startEpoch,
                outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
                decodedEventsCount: 0,
                ingestedCount: 0,
                endpointUrl: this.sanitizedRpcUrl,
                error: "Overall deadline exceeded during shared pacing wait",
              },
            };
          }

          budgetCheck = this.budgetManager.canMakeRequest(
            this.providerName,
            this.clock(),
            this.requestPurpose,
          );
        }

        if (!budgetCheck.allowed) {
          this.totalFailures++;
          this.recordLossGap(notification, budgetCheck.reason ?? "BUDGET_DENIED", tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_BUDGET_DENIED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: this.clock() - startEpoch,
              outcome: "PRE_DISPATCH_BUDGET_DENIED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: this.sanitizeErrorMessage(
                `Budget denied before dispatch: ${budgetCheck.reason ?? "Ceiling reached"}`,
              ),
            },
          };
        }

        if (options?.signal?.aborted) {
          this.totalFailures++;
          this.recordLossGap(notification, "CALLER_ABORTED_BEFORE_DISPATCH", tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: this.clock() - startEpoch,
              outcome: "PRE_DISPATCH_DEADLINE_EXCEEDED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: "Request cancelled by caller before dispatch",
            },
          };
        }

        // Record attempt in shared session budget
        const recorded = this.budgetManager.recordRequestAttempt(
          this.providerName,
          this.requestPurpose,
          this.clock(),
        );

        if (!recorded) {
          this.totalFailures++;
          this.recordLossGap(notification, "BUDGET_RECORD_ATTEMPT_DENIED", tracker);
          return {
            ok: false,
            signature,
            outcome: "PRE_DISPATCH_BUDGET_DENIED",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts: 0,
              durationMs: this.clock() - startEpoch,
              outcome: "PRE_DISPATCH_BUDGET_DENIED",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              error: "Failed to record request attempt in shared session budget",
            },
          };
        }

        // Mark dispatch time
        this.lastDispatchTimeByProvider.set(this.providerName, this.clock());
      } finally {
        // Release admission for next request in chain
        releaseAdmission();
        if (this.dispatchChainByProvider.get(this.providerName) === currentAdmission) {
          this.dispatchChainByProvider.delete(this.providerName);
        }
      }

      // 3. Dispatch HTTP getTransaction with Combined Timeout Controller
      const effectiveTimeoutMs = Math.min(this.timeoutMs, remainingBudget);
      const abortController = new AbortController();
      let abortListener: (() => void) | undefined;

      if (options?.signal) {
        abortListener = () => abortController.abort(options.signal?.reason);
        options.signal.addEventListener("abort", abortListener, { once: true });
      }

      const timeoutTimer = setTimeout(() => {
        abortController.abort(
          new Error(`REQUEST_TIMEOUT: Exceeded timeout of ${effectiveTimeoutMs}ms`),
        );
      }, effectiveTimeoutMs);

      const httpAttempts = 1;
      this.totalDispatchedAttempts++;
      let httpStatus: number | undefined;
      let bodyText = "";
      let requestSentAtMs: number | undefined;
      let responseReceivedAtMs: number | undefined;

      try {
        const rpcPayload = {
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            signature,
            {
              encoding: "json",
              commitment: this.commitment,
              maxSupportedTransactionVersion: this.maxSupportedTransactionVersion,
            },
          ],
        };

        requestSentAtMs = this.clock();

        const response = await this.underlyingTransport(this.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rpcPayload),
          signal: abortController.signal,
          redirect: "error", // Prohibit silent follow-up requests
        });

        httpStatus = response.status;
        this.budgetManager.recordResponseStatus(response.status);

        if (!response.ok) {
          try {
            bodyText = await response.text();
          } catch {
            // ignore error reading error body
          }
          responseReceivedAtMs = this.clock();
          const responseSha256 =
            bodyText.length > 0 ? createHash("sha256").update(bodyText).digest("hex") : undefined;

          this.totalFailures++;
          this.recordLossGap(notification, `HTTP_ERROR_${response.status}`, tracker);
          return {
            ok: false,
            signature,
            outcome: "HTTP_ERROR",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts,
              httpStatus,
              durationMs: this.clock() - startEpoch,
              outcome: "HTTP_ERROR",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              requestSentAtMs,
              responseReceivedAtMs,
              responseSha256,
              error: this.sanitizeErrorMessage(
                `HTTP error ${response.status}: ${response.statusText}`,
              ),
            },
          };
        }

        // Keep timeout protection active through complete response body reading
        bodyText = await response.text();
        responseReceivedAtMs = this.clock();
      } catch (err) {
        this.totalFailures++;
        const isAbortOrTimeout =
          abortController.signal.aborted ||
          (err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("REQUEST_TIMEOUT")));

        const outcome: TransactionProcessingOutcome = isAbortOrTimeout
          ? "REQUEST_TIMEOUT"
          : "NETWORK_ERROR";
        const errorMsg = this.sanitizeErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
        this.recordLossGap(notification, outcome, tracker);

        return {
          ok: false,
          signature,
          outcome,
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome,
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs: responseReceivedAtMs ?? this.clock(),
            responseSha256: undefined,
            error: errorMsg,
          },
        };
      } finally {
        clearTimeout(timeoutTimer);
        if (abortListener && options?.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }
      }

      const responseSha256 = createHash("sha256").update(bodyText).digest("hex");

      // Recheck overall deadline immediately before tracker ingestion
      if (
        this.clock() >= effectiveDeadlineEpoch ||
        abortController.signal.aborted ||
        options?.signal?.aborted
      ) {
        this.totalFailures++;
        this.recordLossGap(notification, "DEADLINE_EXCEEDED_BEFORE_INGESTION", tracker);
        return {
          ok: false,
          signature,
          outcome: "REQUEST_TIMEOUT",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "REQUEST_TIMEOUT",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: `Deadline exceeded before tracker ingestion: elapsed ${this.clock() - startEpoch}ms >= limit ${effectiveTimeoutMs}ms`,
          },
        };
      }

      // 4. Parse & Validate JSON-RPC Envelope
      let rpcResponse: unknown;
      try {
        rpcResponse = JSON.parse(bodyText);
      } catch (err) {
        this.totalFailures++;
        this.recordLossGap(notification, "MALFORMED_JSON_RESPONSE", tracker);
        return {
          ok: false,
          signature,
          outcome: "MALFORMED_RESPONSE",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "MALFORMED_RESPONSE",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: this.sanitizeErrorMessage(
              `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          },
        };
      }

      if (!rpcResponse || typeof rpcResponse !== "object") {
        this.totalFailures++;
        this.recordLossGap(notification, "NON_OBJECT_RPC_RESPONSE", tracker);
        return {
          ok: false,
          signature,
          outcome: "MALFORMED_RESPONSE",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "MALFORMED_RESPONSE",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: "RPC response must be a non-null object",
          },
        };
      }

      const rpcObj = rpcResponse as Record<string, unknown>;

      if (rpcObj.jsonrpc !== "2.0") {
        this.totalFailures++;
        this.recordLossGap(notification, "INVALID_JSONRPC_VERSION", tracker);
        return {
          ok: false,
          signature,
          outcome: "MALFORMED_RESPONSE",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "MALFORMED_RESPONSE",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: `Invalid JSON-RPC version: expected '2.0', received '${String(rpcObj.jsonrpc)}'`,
          },
        };
      }

      if (rpcObj.id !== 1) {
        this.totalFailures++;
        this.recordLossGap(notification, "RPC_ID_MISMATCH", tracker);
        return {
          ok: false,
          signature,
          outcome: "MALFORMED_RESPONSE",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "MALFORMED_RESPONSE",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: `RPC response id mismatch: expected 1, received ${String(rpcObj.id)}`,
          },
        };
      }

      const hasResult = "result" in rpcObj && rpcObj.result !== undefined;
      const hasError = "error" in rpcObj && rpcObj.error !== undefined && rpcObj.error !== null;

      if (hasResult && hasError) {
        this.totalFailures++;
        this.recordLossGap(notification, "CONTRADICTORY_RPC_ENVELOPE", tracker);
        return {
          ok: false,
          signature,
          outcome: "MALFORMED_RESPONSE",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "MALFORMED_RESPONSE",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: "Contradictory JSON-RPC envelope: contains both 'result' and 'error'",
          },
        };
      }

      if (!hasResult && !hasError) {
        this.totalFailures++;
        this.recordLossGap(notification, "MISSING_RESULT_AND_ERROR", tracker);
        return {
          ok: false,
          signature,
          outcome: "MALFORMED_RESPONSE",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "MALFORMED_RESPONSE",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: "Malformed JSON-RPC envelope: contains neither 'result' nor 'error'",
          },
        };
      }

      if (hasError) {
        this.totalFailures++;
        this.recordLossGap(notification, "RPC_ERROR_RETURNED", tracker);
        return {
          ok: false,
          signature,
          outcome: "RPC_ERROR",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "RPC_ERROR",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: this.sanitizeErrorMessage(`RPC returned error: ${JSON.stringify(rpcObj.error)}`),
          },
        };
      }

      if (rpcObj.result === null) {
        this.totalFailures++;
        this.recordLossGap(notification, "TRANSACTION_NOT_FOUND", tracker);
        return {
          ok: false,
          signature,
          outcome: "TRANSACTION_NOT_FOUND",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "TRANSACTION_NOT_FOUND",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: `Transaction ${signature} not found on-chain (result: null)`,
          },
        };
      }

      // Validate returned transaction signature matches requested signature
      const payloadObj = rpcObj.result as Record<string, unknown>;
      const returnedSig = (payloadObj?.transaction as Record<string, unknown>)?.signatures;
      const primaryReturnedSig = Array.isArray(returnedSig) ? returnedSig[0] : undefined;

      if (typeof primaryReturnedSig !== "string" || primaryReturnedSig.trim() !== signature) {
        this.totalFailures++;
        this.recordLossGap(notification, "RESPONSE_SIGNATURE_MISMATCH", tracker);
        return {
          ok: false,
          signature,
          outcome: "RESPONSE_SIGNATURE_MISMATCH",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "RESPONSE_SIGNATURE_MISMATCH",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: this.sanitizeErrorMessage(
              `RPC returned signature mismatch: requested '${signature}', received '${String(primaryReturnedSig)}'`,
            ),
          },
        };
      }

      // Validate slot contradiction if supplied in notification
      if (notification.slot !== undefined) {
        const payloadSlot = payloadObj.slot;
        if (typeof payloadSlot === "number" && payloadSlot !== notification.slot) {
          this.totalFailures++;
          this.recordLossGap(notification, "CONTRADICTORY_SLOT", tracker);
          return {
            ok: false,
            signature,
            outcome: "CONTRADICTORY_METADATA",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts,
              httpStatus,
              durationMs: this.clock() - startEpoch,
              outcome: "CONTRADICTORY_METADATA",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              requestSentAtMs,
              responseReceivedAtMs,
              responseSha256,
              error: this.sanitizeErrorMessage(
                `Slot contradiction: notification specified slot ${notification.slot}, but response contains slot ${payloadSlot}`,
              ),
            },
          };
        }
      }

      // Validate blockTime contradiction if supplied in notification
      if (notification.blockTime !== undefined && notification.blockTime !== null) {
        const payloadBlockTime = payloadObj.blockTime;
        if (typeof payloadBlockTime === "number" && payloadBlockTime !== notification.blockTime) {
          this.totalFailures++;
          this.recordLossGap(notification, "CONTRADICTORY_BLOCK_TIME", tracker);
          return {
            ok: false,
            signature,
            outcome: "CONTRADICTORY_METADATA",
            ingestedEventsCount: 0,
            diagnostics: {
              signature,
              httpAttempts,
              httpStatus,
              durationMs: this.clock() - startEpoch,
              outcome: "CONTRADICTORY_METADATA",
              decodedEventsCount: 0,
              ingestedCount: 0,
              endpointUrl: this.sanitizedRpcUrl,
              requestSentAtMs,
              responseReceivedAtMs,
              responseSha256,
              error: this.sanitizeErrorMessage(
                `BlockTime contradiction: notification specified blockTime ${notification.blockTime}, but response contains blockTime ${payloadBlockTime}`,
              ),
            },
          };
        }
      }

      // 5. Decode Swaps & Ingest Into Tracker
      const decodeOptions: DecodeSwapOptions = {
        clock: this.clock,
        receiptTimestampMs: notification.receivedAtMs ?? this.clock(),
        fallbackProvenance: notification.provenance as TradeTimestampProvenance | undefined,
      };

      const ingestResult = this.normalizationAdapter.ingestTransaction(
        rpcObj.result,
        tracker,
        decodeOptions,
      );

      if (!ingestResult.decodeResult.ok) {
        this.totalFailures++;
        this.recordLossGap(
          notification,
          `DECODE_FAILED_${ingestResult.decodeResult.reason}`,
          tracker,
        );
        return {
          ok: false,
          signature,
          outcome: "DECODE_FAILED",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "DECODE_FAILED",
            decodedEventsCount: 0,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: this.sanitizeErrorMessage(
              `Decode failed [${ingestResult.decodeResult.reason}]: ${ingestResult.decodeResult.message}`,
            ),
          },
        };
      }

      const decodedEventsCount = ingestResult.decodeResult.events.length;
      const ingestedCount = ingestResult.ingestedCount;

      if (ingestedCount === 0 && ingestResult.ingestFailures.length > 0) {
        this.totalFailures++;
        const firstFailure = ingestResult.ingestFailures[0]!;
        this.recordLossGap(notification, `INGEST_FAILED_${firstFailure.reason}`, tracker);
        return {
          ok: false,
          signature,
          outcome: "INGEST_FAILED",
          ingestedEventsCount: 0,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "INGEST_FAILED",
            decodedEventsCount,
            ingestedCount: 0,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: this.sanitizeErrorMessage(
              `Tracker ingestion failed [${firstFailure.reason}]: ${firstFailure.message}`,
            ),
          },
        };
      }

      if (ingestedCount < decodedEventsCount && ingestResult.ingestFailures.length > 0) {
        // Partial ingestion failure: report failure accurately, preserve partial count, protect coverage
        this.totalFailures++;
        const firstFailure = ingestResult.ingestFailures[0]!;
        this.recordLossGap(notification, `PARTIAL_INGEST_FAILED_${firstFailure.reason}`, tracker);
        return {
          ok: false,
          signature,
          outcome: "PARTIAL_INGEST_FAILED",
          ingestedEventsCount: ingestedCount,
          diagnostics: {
            signature,
            httpAttempts,
            httpStatus,
            durationMs: this.clock() - startEpoch,
            outcome: "PARTIAL_INGEST_FAILED",
            decodedEventsCount,
            ingestedCount,
            endpointUrl: this.sanitizedRpcUrl,
            requestSentAtMs,
            responseReceivedAtMs,
            responseSha256,
            error: this.sanitizeErrorMessage(
              `Partial tracker ingestion failure: ${ingestedCount}/${decodedEventsCount} swaps ingested; failed [${firstFailure.reason}]: ${firstFailure.message}`,
            ),
          },
        };
      }

      this.totalSuccesses++;
      return {
        ok: true,
        signature,
        outcome: "SUCCESS",
        ingestedEventsCount: ingestedCount,
        diagnostics: {
          signature,
          httpAttempts,
          httpStatus,
          durationMs: this.clock() - startEpoch,
          outcome: "SUCCESS",
          decodedEventsCount,
          ingestedCount,
          endpointUrl: this.sanitizedRpcUrl,
          requestSentAtMs,
          responseReceivedAtMs,
          responseSha256,
        },
      };
    } finally {
      this.inFlightCount--;
      this.activeSignatures.delete(signature);
      this.recordCompletedSignature(signature);
      this.updateTrackerBacklog();
    }
  }
}
