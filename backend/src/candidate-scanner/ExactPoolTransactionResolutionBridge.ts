/**
 * Phase 12.94-D Milestone D.3.3: Bounded Exact-Pool Transaction Resolution Bridge
 *
 * Consumes witnessed on-chain history enumeration results and resolves discovered transaction
 * signatures through the accepted Raydium AMM v4 transaction-source adapter into decoded swap
 * events and trade flow tracker ingestion.
 *
 * Operational and Safety Invariants (Audit-Harden V2):
 * 1. Complete Immutable Candidate Binding & Provenance:
 *    - Clones and freezes candidate pool context on intake; caller mutations after construction
 *      cannot alter bridge validation.
 *    - Enforces full 8-field identity comparison against adapter context (`poolId`, `candidateTokenMint`,
 *      `quoteTokenMint`, `baseVault`, `quoteVault`, `baseMint`, `quoteMint`, `orientation`).
 *    - Verifies both tracker pool ID and token mint against pool context.
 *    - Rejects candidatePoolId or connectionEpoch mismatches fail-closed before any requests.
 *    - Explicitly requires a valid non-negative integer connectionEpoch in enumeration results;
 *      omitting connectionEpoch fails closed with PROVENANCE_MISMATCH.
 * 2. Unwitnessed Anchor Rejection:
 *    - Strictly rejects enumeration results without positive boundary anchor proof
 *      (anchorWitnessed: true and outcome: "ANCHOR_WITNESSED") before making any transaction requests.
 * 3. Shared Resource Configuration & Accounting Invariants:
 *    - Verifies that the adapter shares the identical GlobalResourceBudgetManager instance.
 *    - Verifies that adapter uses canonical providerName="SOLANA_RPC" and requestPurpose="CANDIDATE_ENRICHMENT".
 *    - Request accounting remains strictly owned by the adapter so requests are counted exactly once.
 * 4. Pre-Dispatch & Pre-Ingestion Lifecycle/Cancellation Enforcement:
 *    - Combines constructor and per-call cancellation conditions; a fresh per-call signal cannot
 *      override an already-aborted constructor signal.
 *    - Checks caller cancellation, deadline, coordinator status, and connection epoch:
 *      a) Before dispatch after pacing waits (via adapter validateState callback).
 *      b) Immediately before tracker ingestion (via adapter validateState callback).
 *      c) Immediately post-await around in-flight adapter operations.
 *    - Disallows HTTP dispatch and tracker ingestion after lifecycle invalidation.
 *    - Preserves all work that actually occurred in aggregate counts (totalIngestedSwaps) even when
 *      the operation terminates with cancellation or failure.
 * 5. Ceiling Invariant for Per-Call Limits:
 *    - Validates per-call maxTransactionsToProcess and operationDeadlineMs as positive safe integers.
 *    - Per-call options may reduce constructor ceilings, but can never raise them.
 * 6. Conservative Duplicate Resolution:
 *    - Bare signature allowlists and prior-evidence success shortcuts are prohibited.
 *    - An adapter DUPLICATE_NOTIFICATION outcome is conservatively classified as DUPLICATE_UNRESOLVED
 *      and counted as failed without crediting recovery, because prior resolution results do not
 *      establish successful swap ingestion into the current tracker instance.
 *    - Preserves all work actually ingested into the current tracker without false success promotion.
 * 7. Production Completeness Separation:
 *    - Does NOT advance a persisted verified cursor.
 *    - Does NOT clear tracker stream gaps.
 *    - Does NOT call coverage-advancement methods.
 *    - Permanently returns isProductionCompletenessEstablished = false.
 */

import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import type {
  RaydiumAmmV4TransactionSourceAdapter,
  TransactionProcessingOutcome,
  InjectedTransactionNotification,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import type { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import type { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type {
  HistoryEnumerationResult,
  EnumerationLifecycleTarget,
  HistorySignatureRecord,
} from "./ExactPoolHistoryEnumerator.js";

/**
 * Deep freezes an object and its nested properties.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (
      val !== null &&
      (typeof val === "object" || typeof val === "function") &&
      !Object.isFrozen(val)
    ) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Resolution status for an individual transaction signature.
 */
export type SignatureResolutionStatus =
  | "RESOLVED"
  | "DUPLICATE_RESOLVED"
  | "DUPLICATE_UNRESOLVED"
  | "FAILED_DECODE"
  | "FAILED_INGEST"
  | "PARTIAL_INGEST"
  | "TRANSACTION_UNAVAILABLE"
  | "BUDGET_DENIED"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "LIFECYCLE_CANCELLED"
  | "ADAPTER_ERROR";

/**
 * Bounded immutable resolution record for a single discovered transaction signature.
 */
export interface ResolvedSignatureRecord {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly status: SignatureResolutionStatus;
  readonly adapterOutcome?: TransactionProcessingOutcome | undefined;
  readonly decodedEventsCount: number;
  readonly ingestedEventsCount: number;
  readonly error?: string | undefined;
}

/**
 * Overall outcome of an exact-pool transaction resolution bridge execution.
 */
export type ResolutionBridgeOutcome =
  | "ALL_RESOLVED"
  | "PARTIAL_RESOLUTION"
  | "UNWITNESSED_ANCHOR_REJECTED"
  | "PROVENANCE_MISMATCH"
  | "LIFECYCLE_CANCELLED"
  | "OPERATION_CANCELLED"
  | "OPERATION_DEADLINE_EXCEEDED"
  | "BUDGET_EXHAUSTED"
  | "MAX_TRANSACTIONS_EXCEEDED";

/**
 * Complete immutable result contract for exact-pool transaction resolution.
 * Note: isProductionCompletenessEstablished is permanently literal `false`.
 */
export interface TransactionResolutionResult {
  readonly outcome: ResolutionBridgeOutcome;
  readonly candidatePoolId: string;
  readonly connectionEpoch: number;
  readonly anchorWitnessed: boolean;
  readonly knownAnchorSignature: string;
  readonly frozenTargetSignature: string | null;
  readonly totalDiscoveredSignatures: number;
  readonly totalProcessed: number;
  readonly totalResolved: number;
  readonly totalFailed: number;
  readonly totalDuplicatesUnresolved: number;
  readonly totalDuplicatesResolved: number;
  readonly totalIngestedSwaps: number;
  readonly perSignatureResults: readonly ResolvedSignatureRecord[];
  readonly isProductionCompletenessEstablished: false;
  readonly error?: string | undefined;
  readonly durationMs: number;
}

/**
 * Configuration options for ExactPoolTransactionResolutionBridge.
 */
export interface TransactionResolutionBridgeOptions {
  /** Validated candidate pool context. Mandatory. */
  readonly poolContext: TrackedRaydiumPoolContext;

  /** Accepted transaction source adapter. Mandatory. */
  readonly adapter: RaydiumAmmV4TransactionSourceAdapter;

  /** Associated trade flow tracker. Mandatory. */
  readonly tracker: RollingTradeFlowTracker;

  /** Shared resource budget manager. Mandatory. */
  readonly budgetManager: GlobalResourceBudgetManager;

  /** Optional lifecycle target for coordinator status and epoch monitoring. */
  readonly lifecycleTarget?: EnumerationLifecycleTarget | undefined;

  /** Expected coordinator connection epoch. Default: 0. */
  readonly expectedEpoch?: number | undefined;

  /** Monotonic clock function. Default: Date.now. */
  readonly clock?: (() => number) | undefined;

  /** Maximum transactions to process in one resolution run. Default: 25. */
  readonly maxTransactionsToProcess?: number | undefined;

  /** Maximum overall wall-clock deadline in ms. Default: 30,000 ms. */
  readonly operationDeadlineMs?: number | undefined;

  /** Optional caller cancellation probe. */
  readonly isCancelled?: (() => boolean) | undefined;

  /** Optional caller cancellation AbortSignal. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Per-operation overrides passed to resolve().
 */
export interface TransactionResolutionCallOptions {
  readonly maxTransactionsToProcess?: number | undefined;
  readonly operationDeadlineMs?: number | undefined;
  readonly isCancelled?: (() => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class ExactPoolTransactionResolutionBridge {
  private readonly poolContext: TrackedRaydiumPoolContext;
  private readonly adapter: RaydiumAmmV4TransactionSourceAdapter;
  private readonly tracker: RollingTradeFlowTracker;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly lifecycleTarget?: EnumerationLifecycleTarget | undefined;
  private readonly expectedEpoch: number;
  private readonly clock: () => number;
  private readonly maxTransactionsToProcess: number;
  private readonly operationDeadlineMs: number;
  private readonly isCancelled?: (() => boolean) | undefined;
  private readonly signal?: AbortSignal | undefined;

  public constructor(options: TransactionResolutionBridgeOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Options object is required");
    }

    if (!options.poolContext || typeof options.poolContext !== "object") {
      throw new Error("[POOL_CONTEXT_INVALID] Pool context must be a non-null object");
    }
    validateTrackedPoolContext(options.poolContext);

    // Snapshot and deep freeze poolContext immediately to prevent external mutation
    this.poolContext = Object.freeze({
      poolId: String(options.poolContext.poolId),
      candidateTokenMint: String(options.poolContext.candidateTokenMint),
      quoteTokenMint: String(options.poolContext.quoteTokenMint),
      baseVault: String(options.poolContext.baseVault),
      quoteVault: String(options.poolContext.quoteVault),
      baseMint: String(options.poolContext.baseMint),
      quoteMint: String(options.poolContext.quoteMint),
      orientation: options.poolContext.orientation,
    });

    if (!options.adapter) {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Explicit transaction source adapter is required");
    }

    // Verify all 8 context identity fields against adapter
    const adapterCtx = options.adapter.getPoolContext();
    const contextFields = [
      "poolId",
      "candidateTokenMint",
      "quoteTokenMint",
      "baseVault",
      "quoteVault",
      "baseMint",
      "quoteMint",
      "orientation",
    ] as const;

    for (const field of contextFields) {
      if (adapterCtx[field] !== this.poolContext[field]) {
        if (field === "poolId") {
          throw new Error(
            `[RESOLUTION_BRIDGE_INIT] Adapter pool ID (${adapterCtx.poolId}) does not match bridge pool ID (${this.poolContext.poolId})`,
          );
        }
        throw new Error(
          `[RESOLUTION_BRIDGE_INIT] Adapter pool context field '${field}' (${String(adapterCtx[field])}) does not match bridge pool context (${String(this.poolContext[field])})`,
        );
      }
    }
    this.adapter = options.adapter;

    if (!options.tracker) {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Explicit RollingTradeFlowTracker is required");
    }
    if (options.tracker.getPoolId() !== this.poolContext.poolId) {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] Tracker pool ID (${options.tracker.getPoolId()}) does not match bridge pool ID (${this.poolContext.poolId})`,
      );
    }
    if (options.tracker.getTokenMint() !== this.poolContext.candidateTokenMint) {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] Tracker token mint (${options.tracker.getTokenMint()}) does not match bridge candidateTokenMint (${this.poolContext.candidateTokenMint})`,
      );
    }
    this.tracker = options.tracker;

    if (!options.budgetManager) {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Shared GlobalResourceBudgetManager is required");
    }
    this.budgetManager = options.budgetManager;

    // Verify shared resource configuration
    if (options.adapter.getBudgetManager() !== this.budgetManager) {
      throw new Error(
        "[RESOLUTION_BRIDGE_INIT] Adapter must share the identical GlobalResourceBudgetManager instance supplied to the bridge",
      );
    }
    if (options.adapter.getProviderName() !== "SOLANA_RPC") {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] Adapter providerName must be canonical 'SOLANA_RPC', received: '${options.adapter.getProviderName()}'`,
      );
    }
    if (options.adapter.getRequestPurpose() !== "CANDIDATE_ENRICHMENT") {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] Adapter requestPurpose must be 'CANDIDATE_ENRICHMENT', received: '${options.adapter.getRequestPurpose()}'`,
      );
    }

    this.lifecycleTarget = options.lifecycleTarget;
    this.expectedEpoch =
      options.expectedEpoch ??
      (options.lifecycleTarget ? options.lifecycleTarget.getConnectionEpoch() : 0);

    this.clock = options.clock ?? Date.now;

    const maxTx = options.maxTransactionsToProcess ?? 25;
    if (typeof maxTx !== "number" || !Number.isSafeInteger(maxTx) || maxTx <= 0 || maxTx > 100) {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] maxTransactionsToProcess must be a positive integer <= 100, received: ${String(maxTx)}`,
      );
    }
    this.maxTransactionsToProcess = maxTx;

    const deadline = options.operationDeadlineMs ?? 30_000;
    if (
      typeof deadline !== "number" ||
      !Number.isSafeInteger(deadline) ||
      deadline <= 0 ||
      deadline > 120_000
    ) {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] operationDeadlineMs must be a positive integer <= 120000, received: ${String(deadline)}`,
      );
    }
    this.operationDeadlineMs = deadline;

    this.isCancelled = options.isCancelled;
    this.signal = options.signal;
  }

  /**
   * Returns the bound candidate pool context.
   */
  public getPoolContext(): TrackedRaydiumPoolContext {
    return this.poolContext;
  }

  /**
   * Resolves witnessed enumeration results by dispatching discovered signatures through
   * the accepted transaction source adapter in chronological (oldest-first) order.
   */
  public async resolve(
    enumerationResult: HistoryEnumerationResult,
    callOverrides?: TransactionResolutionCallOptions,
  ): Promise<TransactionResolutionResult> {
    const startTime = this.clock();

    // Validate per-call overrides: must be positive safe integers that never exceed constructor ceilings
    let effectiveDeadlineMs = this.operationDeadlineMs;
    if (callOverrides?.operationDeadlineMs !== undefined) {
      const overrideDeadline = callOverrides.operationDeadlineMs;
      if (
        typeof overrideDeadline !== "number" ||
        !Number.isFinite(overrideDeadline) ||
        !Number.isSafeInteger(overrideDeadline) ||
        overrideDeadline <= 0
      ) {
        throw new Error(
          `[RESOLUTION_CALL_INVALID] per-call operationDeadlineMs must be a positive safe integer, received: ${String(overrideDeadline)}`,
        );
      }
      effectiveDeadlineMs = Math.min(this.operationDeadlineMs, overrideDeadline);
    }
    const deadlineEpoch = startTime + effectiveDeadlineMs;

    let effectiveMaxTx = this.maxTransactionsToProcess;
    if (callOverrides?.maxTransactionsToProcess !== undefined) {
      const overrideTx = callOverrides.maxTransactionsToProcess;
      if (
        typeof overrideTx !== "number" ||
        !Number.isFinite(overrideTx) ||
        !Number.isSafeInteger(overrideTx) ||
        overrideTx <= 0
      ) {
        throw new Error(
          `[RESOLUTION_CALL_INVALID] per-call maxTransactionsToProcess must be a positive safe integer, received: ${String(overrideTx)}`,
        );
      }
      effectiveMaxTx = Math.min(this.maxTransactionsToProcess, overrideTx);
    }

    // Combine constructor and per-call cancellation probes
    const isCancelledCombined = (): boolean => {
      if (this.isCancelled?.()) return true;
      if (callOverrides?.isCancelled?.()) return true;
      if (this.signal?.aborted) return true;
      if (callOverrides?.signal?.aborted) return true;
      return false;
    };

    // Combine cancellation signals into composite controller
    const compositeController = new AbortController();
    const handleAbort = (reason?: unknown) => {
      if (!compositeController.signal.aborted) {
        compositeController.abort(reason ?? new Error("OPERATION_CANCELLED"));
      }
    };

    if (this.signal?.aborted) {
      handleAbort(this.signal.reason);
    } else if (callOverrides?.signal?.aborted) {
      handleAbort(callOverrides.signal.reason);
    } else if (isCancelledCombined()) {
      handleAbort(new Error("OPERATION_CANCELLED"));
    }

    const onConstructorAbort = () => handleAbort(this.signal?.reason);
    const onCallAbort = () => handleAbort(callOverrides?.signal?.reason);

    if (this.signal && !this.signal.aborted) {
      this.signal.addEventListener("abort", onConstructorAbort, { once: true });
    }
    if (callOverrides?.signal && !callOverrides.signal.aborted) {
      callOverrides.signal.addEventListener("abort", onCallAbort, { once: true });
    }

    const emptyCounts = {
      totalDiscovered: 0,
      totalProcessed: 0,
      totalResolved: 0,
      totalFailed: 0,
      totalDuplicatesUnresolved: 0,
      totalDuplicatesResolved: 0,
      totalIngestedSwaps: 0,
    };

    const createResult = (
      outcome: ResolutionBridgeOutcome,
      perSigResults: readonly ResolvedSignatureRecord[],
      counts: {
        totalDiscovered: number;
        totalProcessed: number;
        totalResolved: number;
        totalFailed: number;
        totalDuplicatesUnresolved: number;
        totalDuplicatesResolved: number;
        totalIngestedSwaps: number;
      },
      errorMsg?: string,
    ): TransactionResolutionResult => {
      return deepFreeze({
        outcome,
        candidatePoolId: this.poolContext.poolId,
        connectionEpoch: this.expectedEpoch,
        anchorWitnessed: enumerationResult?.anchorWitnessed ?? false,
        knownAnchorSignature: enumerationResult?.knownAnchorSignature ?? "",
        frozenTargetSignature: enumerationResult?.frozenTargetSignature ?? null,
        totalDiscoveredSignatures: counts.totalDiscovered,
        totalProcessed: counts.totalProcessed,
        totalResolved: counts.totalResolved,
        totalFailed: counts.totalFailed,
        totalDuplicatesUnresolved: counts.totalDuplicatesUnresolved,
        totalDuplicatesResolved: counts.totalDuplicatesResolved,
        totalIngestedSwaps: counts.totalIngestedSwaps,
        perSignatureResults: deepFreeze([...perSigResults]),
        isProductionCompletenessEstablished: false,
        ...(errorMsg ? { error: errorMsg } : {}),
        durationMs: Math.max(0, this.clock() - startTime),
      });
    };

    try {
      // 1. Provenance and Binding Validation
      if (!enumerationResult || typeof enumerationResult !== "object") {
        return createResult(
          "PROVENANCE_MISMATCH",
          [],
          emptyCounts,
          "Enumeration result is missing or not an object",
        );
      }

      if (enumerationResult.candidatePoolId !== this.poolContext.poolId) {
        return createResult(
          "PROVENANCE_MISMATCH",
          [],
          {
            ...emptyCounts,
            totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          },
          `Candidate pool ID mismatch: enumeration result pool (${enumerationResult.candidatePoolId}) does not match bridge pool (${this.poolContext.poolId})`,
        );
      }

      // Explicitly require connectionEpoch as a valid non-negative integer
      if (
        typeof enumerationResult.connectionEpoch !== "number" ||
        !Number.isFinite(enumerationResult.connectionEpoch) ||
        !Number.isSafeInteger(enumerationResult.connectionEpoch) ||
        enumerationResult.connectionEpoch < 0
      ) {
        return createResult(
          "PROVENANCE_MISMATCH",
          [],
          {
            ...emptyCounts,
            totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          },
          "Enumeration result must explicitly specify a valid non-negative integer connectionEpoch",
        );
      }

      if (enumerationResult.connectionEpoch !== this.expectedEpoch) {
        return createResult(
          "PROVENANCE_MISMATCH",
          [],
          {
            ...emptyCounts,
            totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          },
          `Connection epoch mismatch: enumeration epoch (${enumerationResult.connectionEpoch}) does not match resolution expected epoch (${this.expectedEpoch})`,
        );
      }

      // 2. Witnessed Anchor Verification
      if (!enumerationResult.anchorWitnessed || enumerationResult.outcome !== "ANCHOR_WITNESSED") {
        return createResult(
          "UNWITNESSED_ANCHOR_REJECTED",
          [],
          {
            ...emptyCounts,
            totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          },
          `Enumeration result does not contain a witnessed anchor (outcome: ${enumerationResult.outcome}, anchorWitnessed: ${String(enumerationResult.anchorWitnessed)}); resolution rejected`,
        );
      }

      // 3. Pre-execution State Checks
      if (isCancelledCombined()) {
        return createResult(
          "OPERATION_CANCELLED",
          [],
          {
            ...emptyCounts,
            totalDiscovered: enumerationResult.discoveredSignatures.length,
          },
          "Resolution operation cancelled by caller before processing",
        );
      }

      if (this.clock() >= deadlineEpoch) {
        return createResult(
          "OPERATION_DEADLINE_EXCEEDED",
          [],
          {
            ...emptyCounts,
            totalDiscovered: enumerationResult.discoveredSignatures.length,
          },
          `Operation deadline exceeded before processing (${effectiveDeadlineMs}ms)`,
        );
      }

      if (this.lifecycleTarget) {
        const initialStatus = this.lifecycleTarget.getStatus();
        if (initialStatus !== "SUBSCRIBED") {
          return createResult(
            "LIFECYCLE_CANCELLED",
            [],
            {
              ...emptyCounts,
              totalDiscovered: enumerationResult.discoveredSignatures.length,
            },
            `Coordinator is not SUBSCRIBED (current: ${initialStatus})`,
          );
        }
        const initialEpoch = this.lifecycleTarget.getConnectionEpoch();
        if (initialEpoch !== this.expectedEpoch) {
          return createResult(
            "LIFECYCLE_CANCELLED",
            [],
            {
              ...emptyCounts,
              totalDiscovered: enumerationResult.discoveredSignatures.length,
            },
            `Coordinator epoch mismatch (expected: ${this.expectedEpoch}, current: ${initialEpoch})`,
          );
        }
      }

      // 4. Chronological Replay Ordering (Oldest First)
      const discoveredList: readonly HistorySignatureRecord[] =
        enumerationResult.discoveredSignatures ?? [];
      const totalDiscovered = discoveredList.length;

      if (totalDiscovered === 0) {
        return createResult("ALL_RESOLVED", [], emptyCounts);
      }

      const chronologicalSignatures = [...discoveredList].reverse();
      const boundedSignatures = chronologicalSignatures.slice(0, effectiveMaxTx);

      const perSigResults: ResolvedSignatureRecord[] = [];
      let totalProcessed = 0;
      let totalResolved = 0;
      let totalFailed = 0;
      let totalDuplicatesUnresolved = 0;
      const totalDuplicatesResolved = 0;
      let totalIngestedSwaps = 0;
      let prematureTerminationOutcome: ResolutionBridgeOutcome | null = null;
      let terminationError: string | undefined = undefined;

      for (const record of boundedSignatures) {
        // Pre-await checks before dispatching next transaction
        if (isCancelledCombined()) {
          prematureTerminationOutcome = "OPERATION_CANCELLED";
          terminationError = "Resolution operation cancelled by caller";
          break;
        }

        const preNow = this.clock();
        if (preNow >= deadlineEpoch) {
          prematureTerminationOutcome = "OPERATION_DEADLINE_EXCEEDED";
          terminationError = `Operation deadline exceeded (${effectiveDeadlineMs}ms)`;
          break;
        }

        if (this.lifecycleTarget) {
          const preStatus = this.lifecycleTarget.getStatus();
          if (preStatus !== "SUBSCRIBED") {
            prematureTerminationOutcome = "LIFECYCLE_CANCELLED";
            terminationError = `Coordinator status transitioned to ${preStatus}`;
            break;
          }
          const preEpoch = this.lifecycleTarget.getConnectionEpoch();
          if (preEpoch !== this.expectedEpoch) {
            prematureTerminationOutcome = "LIFECYCLE_CANCELLED";
            terminationError = `Coordinator epoch changed to ${preEpoch} (expected: ${this.expectedEpoch})`;
            break;
          }
        }

        const remainingBudgetMs = Math.max(0, Math.min(60_000, deadlineEpoch - this.clock()));
        const notification: InjectedTransactionNotification = {
          signature: record.signature,
          slot: record.slot,
          blockTime: record.blockTime,
          receivedAtMs: this.clock(),
          provenance: "ON_CHAIN_BLOCK_TIME",
        };

        totalProcessed++;

        // Validity probe passed to adapter: verified after waits (before dispatch) and immediately before ingestion
        const validateState = () => {
          if (isCancelledCombined()) {
            throw new Error("OPERATION_CANCELLED: Caller cancelled");
          }
          if (this.clock() >= deadlineEpoch) {
            throw new Error(
              `OPERATION_DEADLINE_EXCEEDED: Operation deadline expired (${effectiveDeadlineMs}ms)`,
            );
          }
          if (this.lifecycleTarget) {
            const status = this.lifecycleTarget.getStatus();
            if (status !== "SUBSCRIBED") {
              throw new Error(`LIFECYCLE_CANCELLED: Coordinator transitioned to ${status}`);
            }
            const epoch = this.lifecycleTarget.getConnectionEpoch();
            if (epoch !== this.expectedEpoch) {
              throw new Error(
                `LIFECYCLE_CANCELLED: Coordinator epoch changed to ${epoch} (expected: ${this.expectedEpoch})`,
              );
            }
          }
        };

        // Dispatch retrieval and decoding through accepted transaction source adapter
        const adapterResult = await this.adapter.processNotification(notification, this.tracker, {
          overallTimeoutMs: remainingBudgetMs,
          signal: compositeController.signal,
          validateState,
        });

        // Always preserve all work that actually occurred in aggregate counts
        if (adapterResult.ingestedEventsCount > 0) {
          totalIngestedSwaps += adapterResult.ingestedEventsCount;
        }

        // Post-await state validation: recheck before inspecting or accepting resolution outcome
        const adapterError = adapterResult.diagnostics?.error ?? "";
        const isCancelled =
          isCancelledCombined() ||
          compositeController.signal.aborted ||
          adapterError.includes("OPERATION_CANCELLED");

        if (isCancelled) {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "CANCELLED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: adapterResult.diagnostics?.decodedEventsCount ?? 0,
            ingestedEventsCount: adapterResult.ingestedEventsCount,
            error: "Cancelled by caller during transaction processing",
          });
          totalFailed++;
          prematureTerminationOutcome = "OPERATION_CANCELLED";
          terminationError = "Resolution operation cancelled by caller during processing";
          break;
        }

        const isDeadlineExceeded =
          this.clock() >= deadlineEpoch || adapterError.includes("OPERATION_DEADLINE_EXCEEDED");

        if (isDeadlineExceeded) {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "DEADLINE_EXCEEDED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: adapterResult.diagnostics?.decodedEventsCount ?? 0,
            ingestedEventsCount: adapterResult.ingestedEventsCount,
            error: `Operation deadline exceeded during transaction processing (${effectiveDeadlineMs}ms)`,
          });
          totalFailed++;
          prematureTerminationOutcome = "OPERATION_DEADLINE_EXCEEDED";
          terminationError = `Operation deadline exceeded during processing (${effectiveDeadlineMs}ms)`;
          break;
        }

        if (this.lifecycleTarget) {
          const postStatus = this.lifecycleTarget.getStatus();
          const postEpoch = this.lifecycleTarget.getConnectionEpoch();
          const isLifecycleInvalid =
            postStatus !== "SUBSCRIBED" ||
            postEpoch !== this.expectedEpoch ||
            adapterError.includes("LIFECYCLE_CANCELLED");

          if (isLifecycleInvalid) {
            perSigResults.push({
              signature: record.signature,
              slot: record.slot,
              blockTime: record.blockTime,
              status: "LIFECYCLE_CANCELLED",
              adapterOutcome: adapterResult.outcome,
              decodedEventsCount: adapterResult.diagnostics?.decodedEventsCount ?? 0,
              ingestedEventsCount: adapterResult.ingestedEventsCount,
              error: `Coordinator lifecycle invalidated during transaction processing (status: ${postStatus}, epoch: ${postEpoch})`,
            });
            totalFailed++;
            prematureTerminationOutcome = "LIFECYCLE_CANCELLED";
            terminationError = `Coordinator lifecycle invalidated during processing; remaining transactions abandoned`;
            break;
          }
        }

        // 5. Honest Outcome Mapping & Diagnostic Preservation
        const decodedCount = adapterResult.diagnostics?.decodedEventsCount ?? 0;
        const ingestedCount = adapterResult.ingestedEventsCount;

        if (adapterResult.ok && adapterResult.outcome === "SUCCESS") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "RESOLVED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: ingestedCount,
          });
          totalResolved++;
        } else if (adapterResult.outcome === "DUPLICATE_NOTIFICATION") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "DUPLICATE_UNRESOLVED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: 0,
            error:
              "Duplicate notification reported by adapter; conservative duplicate policy does not credit recovery without direct tracker ingestion",
          });
          totalDuplicatesUnresolved++;
          totalFailed++;
        } else if (adapterResult.outcome === "PARTIAL_INGEST_FAILED") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "PARTIAL_INGEST",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: ingestedCount,
            error:
              adapterResult.diagnostics?.error ?? "Partial ingestion failure reported by adapter",
          });
          totalFailed++;
        } else if (adapterResult.outcome === "DECODE_FAILED") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "FAILED_DECODE",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: 0,
            error: adapterResult.diagnostics?.error ?? "Swap decoding failed",
          });
          totalFailed++;
        } else if (adapterResult.outcome === "INGEST_FAILED") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "FAILED_INGEST",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: 0,
            error: adapterResult.diagnostics?.error ?? "Tracker ingestion failed",
          });
          totalFailed++;
        } else if (adapterResult.outcome === "TRANSACTION_NOT_FOUND") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "TRANSACTION_UNAVAILABLE",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: 0,
            ingestedEventsCount: 0,
            error: "Transaction not found on RPC node",
          });
          totalFailed++;
        } else if (adapterResult.outcome === "PRE_DISPATCH_BUDGET_DENIED") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "BUDGET_DENIED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: 0,
            ingestedEventsCount: 0,
            error: adapterResult.diagnostics?.error ?? "Budget manager denied request",
          });
          totalFailed++;
          prematureTerminationOutcome = "BUDGET_EXHAUSTED";
          terminationError = "Budget manager denied request under CANDIDATE_ENRICHMENT";
          break;
        } else if (
          adapterResult.outcome === "PRE_DISPATCH_DEADLINE_EXCEEDED" ||
          adapterResult.outcome === "REQUEST_TIMEOUT"
        ) {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "DEADLINE_EXCEEDED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: 0,
            ingestedEventsCount: 0,
            error:
              adapterResult.diagnostics?.error ?? "Deadline exceeded during adapter processing",
          });
          totalFailed++;
          prematureTerminationOutcome = "OPERATION_DEADLINE_EXCEEDED";
          terminationError = "Operation deadline exceeded during adapter processing";
          break;
        } else {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "ADAPTER_ERROR",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: ingestedCount,
            error: adapterResult.diagnostics?.error ?? `Adapter error: ${adapterResult.outcome}`,
          });
          totalFailed++;
        }
      }

      const counts = {
        totalDiscovered,
        totalProcessed,
        totalResolved,
        totalFailed,
        totalDuplicatesUnresolved,
        totalDuplicatesResolved,
        totalIngestedSwaps,
      };

      if (prematureTerminationOutcome !== null) {
        return createResult(prematureTerminationOutcome, perSigResults, counts, terminationError);
      }

      if (totalResolved === totalDiscovered) {
        return createResult("ALL_RESOLVED", perSigResults, counts);
      }

      if (totalProcessed < totalDiscovered && totalResolved === totalProcessed) {
        return createResult(
          "MAX_TRANSACTIONS_EXCEEDED",
          perSigResults,
          counts,
          `Processed maximum configured transactions (${effectiveMaxTx} of ${totalDiscovered} discovered)`,
        );
      }

      return createResult(
        "PARTIAL_RESOLUTION",
        perSigResults,
        counts,
        `Resolved ${totalResolved} of ${totalDiscovered} discovered transactions (${totalFailed} failed or unresolved duplicates)`,
      );
    } finally {
      if (this.signal) {
        this.signal.removeEventListener("abort", onConstructorAbort);
      }
      if (callOverrides?.signal) {
        callOverrides.signal.removeEventListener("abort", onCallAbort);
      }
    }
  }
}
