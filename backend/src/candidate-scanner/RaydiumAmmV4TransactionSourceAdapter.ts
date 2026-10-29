/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Transaction Source Adapter
 *
 * Minimal, offline-tested adapter connecting injected transaction-signature
 * notifications to bounded getTransaction retrieval, decoding, and tracker ingestion.
 *
 * Operational and Safety Invariants:
 * 1. Explicit Transport Injection: Strictly requires an injected transport (fetch).
 *    Default live networking, automated daemon wiring, and ambient subscriptions are prohibited.
 * 2. Strict Identity Binding: Binds all processing strictly to the exact tracked
 *    pool context (poolId, baseVault, quoteVault, baseMint, quoteMint, candidateTokenMint).
 * 3. Shared Session Budget & Pacing: Meters every outbound HTTP dispatch through the
 *    shared GlobalResourceBudgetManager. LP and trade retrieval on the same provider
 *    strictly share pacing (>= 2,500 ms) and session request ceilings.
 * 4. Dispatched Failure Counting & Pre-Dispatch Reconciliation: Dispatched attempts are
 *    counted regardless of HTTP outcome (network error, 500, 429, timeout, stalled body).
 *    Pre-dispatch budget denials and deadline expirations prevent dispatch and remain uncounted.
 * 5. Deadlines & Timeout Protection: Preserves request timeout and overall deadline
 *    through response-body reading and any shared pacing waits. Stalled response streams
 *    are terminated promptly via AbortController.
 * 6. Bounded Backlog & Deduplication: Strictly bounds pending notification queue size and
 *    deduplication keys (FIFO eviction). Duplicate notifications never trigger duplicate
 *    fetches or trade counts.
 * 7. Zero Heuristic Retries / Fallback: Strictly 1 getTransaction call per unique signature.
 *    No automatic retries, fallback providers, or hidden discovery requests.
 * 8. Explicit Processing Outcomes: Missing transactions, decode failures, malformed responses,
 *    timeouts, queue overflows, and budget denials are returned as explicit, typed outcomes.
 * 9. Fail-Closed Coverage Guarantee: Successful retrieval, an empty queue, or notification
 *    receipt alone NEVER establishes complete 60-second window coverage. Coverage remains
 *    strictly dependent on separately verified source checkpoints or completed ranges.
 * 10. Honest Throughput Limits: At >= 2,500 ms spacing, a single provider endpoint sustains
 *     at most 24 requests/minute. Active pools (> 24 trades/min) cannot achieve full coverage
 *     via getTransaction without dedicated high-throughput RPC tiers or log-only decoding.
 */

import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
  RaydiumAmmV4SwapNormalizationAdapter,
  type DecodeSwapOptions,
} from "./RaydiumAmmV4SwapDecoder.js";
import {
  type RollingTradeFlowTracker,
  type TradeTimestampProvenance,
} from "./RollingTradeFlowTracker.js";
import {
  MIN_HOST_PACING_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_OVERALL_TIMEOUT_MS,
  PreDispatchError,
} from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
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
  | "DECODE_FAILED"
  | "INGEST_FAILED";

export interface TransactionSourceDiagnostics {
  readonly signature: string;
  readonly httpAttempts: number;
  readonly httpStatus?: number | undefined;
  readonly durationMs: number;
  readonly outcome: TransactionProcessingOutcome;
  readonly decodedEventsCount: number;
  readonly ingestedCount: number;
  readonly error?: string | undefined;
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

  /** Request purpose for budget accounting. Default: "FORWARD_OBSERVATION". */
  readonly requestPurpose?: RequestPurpose | undefined;

  /** Minimum host pacing in ms between calls to same provider. Default: 2,500 ms (MIN_HOST_PACING_MS). */
  readonly pacingMs?: number | undefined;

  /** Per-request HTTP timeout in ms. Default: 10,000 ms. */
  readonly timeoutMs?: number | undefined;

  /** Overall deadline ceiling in ms for a process operation. Default: 60,000 ms. */
  readonly overallTimeoutMs?: number | undefined;

  /** Maximum pending notification queue capacity. Default: 100. */
  readonly maxPendingQueueSize?: number | undefined;

  /** Maximum deduplication signatures retained. Default: 1,000. */
  readonly maxDeduplicationKeys?: number | undefined;

  /** RPC commitment level. Default: "confirmed". */
  readonly commitment?: "confirmed" | "finalized" | undefined;

  /** Max supported transaction version for RPC. Default: 0. */
  readonly maxSupportedTransactionVersion?: number | undefined;

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

/**
 * Validates a signature string for basic Solana signature structure (non-empty Base58).
 */
function isValidSignatureString(sig: unknown): sig is string {
  if (typeof sig !== "string") return false;
  const trimmed = sig.trim();
  if (trimmed.length < 32 || trimmed.length > 128) return false;
  return BASE58_REGEX.test(trimmed);
}

export class RaydiumAmmV4TransactionSourceAdapter {
  private readonly poolContext: TrackedRaydiumPoolContext;
  private readonly normalizationAdapter: RaydiumAmmV4SwapNormalizationAdapter;
  private readonly rpcUrl: string;
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

  private readonly pendingQueue: InjectedTransactionNotification[] = [];
  private readonly seenSignatures = new Set<string>();

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
    if (!options.rpcUrl || options.rpcUrl.trim().length === 0) {
      throw new Error("rpcUrl is required for RaydiumAmmV4TransactionSourceAdapter");
    }

    validateTrackedPoolContext(options.poolContext);
    this.poolContext = Object.freeze({ ...options.poolContext });
    this.normalizationAdapter = new RaydiumAmmV4SwapNormalizationAdapter(this.poolContext);

    this.rpcUrl = options.rpcUrl;
    this.budgetManager = options.budgetManager;
    this.underlyingTransport = options.transport;
    this.providerName = options.providerName ?? "SOLANA_RPC";
    this.requestPurpose = options.requestPurpose ?? "FORWARD_OBSERVATION";
    this.pacingMs = Math.max(MIN_HOST_PACING_MS, options.pacingMs ?? MIN_HOST_PACING_MS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;

    const maxQueue = options.maxPendingQueueSize ?? 100;
    if (!Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new Error("maxPendingQueueSize must be an integer >= 1");
    }
    this.maxPendingQueueSize = maxQueue;

    const maxDedup = options.maxDeduplicationKeys ?? 1000;
    if (!Number.isInteger(maxDedup) || maxDedup < 1) {
      throw new Error("maxDeduplicationKeys must be an integer >= 1");
    }
    this.maxDeduplicationKeys = maxDedup;

    this.commitment = options.commitment ?? "confirmed";
    this.maxSupportedTransactionVersion = options.maxSupportedTransactionVersion ?? 0;
    this.clock = options.clock ?? (() => Date.now());
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public getPoolContext(): TrackedRaydiumPoolContext {
    return this.poolContext;
  }

  public getPendingQueueLength(): number {
    return this.pendingQueue.length;
  }

  public getDeduplicationKeysCount(): number {
    return this.seenSignatures.size;
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

  public isDuplicate(signature: string): boolean {
    return this.seenSignatures.has(signature);
  }

  private recordSeenSignature(signature: string): void {
    if (this.seenSignatures.has(signature)) return;
    if (this.seenSignatures.size >= this.maxDeduplicationKeys) {
      // Bounded FIFO eviction
      const oldest = this.seenSignatures.values().next().value;
      if (oldest !== undefined) {
        this.seenSignatures.delete(oldest);
      }
    }
    this.seenSignatures.add(signature);
  }

  /**
   * Enqueues an injected transaction notification into the bounded pending queue.
   * Rejects invalid signatures, duplicates, and queue overflow fail-closed.
   */
  public enqueueNotification(
    notification: string | InjectedTransactionNotification,
  ): EnqueueNotificationResult {
    const normalized: InjectedTransactionNotification =
      typeof notification === "string" ? { signature: notification } : notification;

    if (!isValidSignatureString(normalized.signature)) {
      return {
        ok: false,
        signature: typeof normalized?.signature === "string" ? normalized.signature : "invalid",
        queued: false,
        reason: "INVALID_NOTIFICATION",
      };
    }

    if (this.isDuplicate(normalized.signature)) {
      this.totalDuplicatesSkipped++;
      return {
        ok: false,
        signature: normalized.signature,
        queued: false,
        reason: "DUPLICATE_NOTIFICATION",
      };
    }

    if (this.pendingQueue.length >= this.maxPendingQueueSize) {
      this.totalQueueOverflows++;
      return {
        ok: false,
        signature: normalized.signature,
        queued: false,
        reason: "QUEUE_OVERFLOW",
      };
    }

    this.recordSeenSignature(normalized.signature);
    this.pendingQueue.push(normalized);
    this.totalEnqueued++;

    return {
      ok: true,
      signature: normalized.signature,
      queued: true,
    };
  }

  /**
   * Processes a single notification directly (retrieving, decoding, and ingesting).
   * Enforces deduplication, shared budget pacing, timeouts, and failure classification.
   */
  public async processNotification(
    notification: string | InjectedTransactionNotification,
    tracker: RollingTradeFlowTracker,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessNotificationResult> {
    const normalized: InjectedTransactionNotification =
      typeof notification === "string" ? { signature: notification } : notification;

    if (!isValidSignatureString(normalized.signature)) {
      return {
        ok: false,
        signature: typeof normalized?.signature === "string" ? normalized.signature : "invalid",
        outcome: "INVALID_NOTIFICATION",
        ingestedEventsCount: 0,
        diagnostics: {
          signature: typeof normalized?.signature === "string" ? normalized.signature : "invalid",
          httpAttempts: 0,
          durationMs: 0,
          outcome: "INVALID_NOTIFICATION",
          decodedEventsCount: 0,
          ingestedCount: 0,
          error: "Signature must be a valid non-empty Base58 Solana signature string",
        },
      };
    }

    if (this.isDuplicate(normalized.signature)) {
      this.totalDuplicatesSkipped++;
      return {
        ok: false,
        signature: normalized.signature,
        outcome: "DUPLICATE_NOTIFICATION",
        ingestedEventsCount: 0,
        diagnostics: {
          signature: normalized.signature,
          httpAttempts: 0,
          durationMs: 0,
          outcome: "DUPLICATE_NOTIFICATION",
          decodedEventsCount: 0,
          ingestedCount: 0,
          error: `Transaction ${normalized.signature} has already been processed or enqueued`,
        },
      };
    }

    this.recordSeenSignature(normalized.signature);
    return this.processNotificationInternal(normalized, tracker, options);
  }

  /**
   * Pops and processes the next pending notification from the queue.
   */
  public async processNextPending(
    tracker: RollingTradeFlowTracker,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessNotificationResult | null> {
    if (this.pendingQueue.length === 0) {
      return null;
    }
    const notification = this.pendingQueue.shift()!;
    return this.processNotificationInternal(notification, tracker, options);
  }

  /**
   * Drains and processes all pending notifications currently in the queue.
   * Stops early if overall deadline is exceeded or budget is denied.
   */
  public async processAllPending(
    tracker: RollingTradeFlowTracker,
    options?: ProcessTransactionOptions,
  ): Promise<ProcessBatchResult> {
    const startEpoch = this.clock();
    const effectiveOverallDeadline =
      startEpoch + (options?.overallTimeoutMs ?? this.overallTimeoutMs);

    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalIngestedEvents = 0;
    const results: ProcessNotificationResult[] = [];

    while (this.pendingQueue.length > 0) {
      const remainingOverall = effectiveOverallDeadline - this.clock();
      if (remainingOverall <= 0) {
        break;
      }

      const res = await this.processNextPending(tracker, {
        overallTimeoutMs: remainingOverall,
        signal: options?.signal,
      });

      if (!res) {
        break;
      }

      totalProcessed++;
      results.push(res);
      if (res.ok) {
        totalSucceeded++;
        totalIngestedEvents += res.ingestedEventsCount;
      } else {
        totalFailed++;
        if (
          res.outcome === "PRE_DISPATCH_BUDGET_DENIED" ||
          res.outcome === "PRE_DISPATCH_DEADLINE_EXCEEDED"
        ) {
          // Stop batch immediately on global budget exhaustion or deadline expiry
          break;
        }
      }
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
    this.totalProcessed++;
    const startEpoch = this.clock();
    const signature = notification.signature;
    const overallTimeout = options?.overallTimeoutMs ?? this.overallTimeoutMs;
    const effectiveDeadlineEpoch = startEpoch + overallTimeout;

    const getRemainingEffectiveBudgetMs = (): number => {
      return effectiveDeadlineEpoch - this.clock();
    };

    let remainingBudget = getRemainingEffectiveBudgetMs();
    if (remainingBudget <= 0) {
      this.totalFailures++;
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
          error: "Overall deadline exceeded before dispatch",
        },
      };
    }

    // 1. Shared Pacing & Pre-dispatch Budget Check
    let budgetCheck = this.budgetManager.canMakeRequest(
      this.providerName,
      this.clock(),
      this.requestPurpose,
    );

    if (
      !budgetCheck.allowed &&
      budgetCheck.reason === "PROVIDER_PACING_NOT_MET" &&
      typeof budgetCheck.waitMs === "number" &&
      budgetCheck.waitMs > 0
    ) {
      if (budgetCheck.waitMs >= remainingBudget) {
        this.totalFailures++;
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
            error: `Pacing wait of ${budgetCheck.waitMs}ms would exceed remaining deadline (${remainingBudget}ms)`,
          },
        };
      }

      try {
        await sleepWithSignal(budgetCheck.waitMs, this.sleepFn, options?.signal);
      } catch (err) {
        this.totalFailures++;
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
            error: `Pacing wait cancelled: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      remainingBudget = getRemainingEffectiveBudgetMs();
      if (remainingBudget <= 0) {
        this.totalFailures++;
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
          error: `Budget denied before dispatch: ${budgetCheck.reason ?? "Ceiling reached"}`,
        },
      };
    }

    if (options?.signal?.aborted) {
      this.totalFailures++;
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
          error: "Request cancelled by caller before dispatch",
        },
      };
    }

    // 2. Record Attempt in Shared Session Budget
    const recorded = this.budgetManager.recordRequestAttempt(
      this.providerName,
      this.requestPurpose,
      this.clock(),
    );

    if (!recorded) {
      this.totalFailures++;
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
          error: "Failed to record request attempt in shared session budget",
        },
      };
    }

    // 3. Dispatch HTTP getTransaction with Combined Timeout Controller
    const effectiveTimeoutMs = Math.min(this.timeoutMs, remainingBudget);
    const abortController = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener(
        "abort",
        () => abortController.abort(options.signal?.reason),
        { once: true },
      );
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

      const response = await this.underlyingTransport(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcPayload),
        signal: abortController.signal,
      });

      httpStatus = response.status;
      this.budgetManager.recordResponseStatus(response.status);

      if (!response.ok) {
        try {
          await response.text();
        } catch {
          // ignore error reading error body
        }
        this.totalFailures++;
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
            error: `HTTP error ${response.status}: ${response.statusText}`,
          },
        };
      }

      // Keep timeout protection active through complete response body reading
      bodyText = await response.text();
    } catch (err) {
      this.totalFailures++;
      const isAbortOrTimeout =
        abortController.signal.aborted ||
        (err instanceof Error &&
          (err.name === "AbortError" || err.message.includes("REQUEST_TIMEOUT")));

      const outcome: TransactionProcessingOutcome = isAbortOrTimeout
        ? "REQUEST_TIMEOUT"
        : "NETWORK_ERROR";
      const errorMsg = err instanceof Error ? err.message : String(err);

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
          error: errorMsg,
        },
      };
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }

    // 4. Parse JSON-RPC Payload
    let rpcResponse: unknown;
    try {
      rpcResponse = JSON.parse(bodyText);
    } catch (err) {
      this.totalFailures++;
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
          error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    if (!rpcResponse || typeof rpcResponse !== "object") {
      this.totalFailures++;
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
          error: "RPC response must be a non-null object",
        },
      };
    }

    const rpcObj = rpcResponse as Record<string, unknown>;

    if (rpcObj.error !== undefined && rpcObj.error !== null) {
      this.totalFailures++;
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
          error: `RPC returned error: ${JSON.stringify(rpcObj.error)}`,
        },
      };
    }

    if (rpcObj.result === null || rpcObj.result === undefined) {
      this.totalFailures++;
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
          error: `Transaction ${signature} not found on-chain (result: null)`,
        },
      };
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
          error: `Decode failed [${ingestResult.decodeResult.reason}]: ${ingestResult.decodeResult.message}`,
        },
      };
    }

    const decodedEventsCount = ingestResult.decodeResult.events.length;
    const ingestedCount = ingestResult.ingestedCount;

    if (ingestedCount === 0 && ingestResult.ingestFailures.length > 0) {
      this.totalFailures++;
      const firstFailure = ingestResult.ingestFailures[0]!;
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
          error: `Tracker ingestion failed [${firstFailure.reason}]: ${firstFailure.message}`,
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
      },
    };
  }
}
