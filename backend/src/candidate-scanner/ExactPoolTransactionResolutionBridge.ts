/**
 * Phase 12.94-D Milestone D.3.3: Bounded Exact-Pool Transaction Resolution Bridge
 *
 * Consumes witnessed on-chain history enumeration results and resolves discovered transaction
 * signatures through the accepted Raydium AMM v4 transaction-source adapter into decoded swap
 * events and trade flow tracker ingestion.
 *
 * Operational and Safety Invariants:
 * 1. Exact Candidate Binding & Provenance:
 *    - Bound exclusively to a validated TrackedRaydiumPoolContext.
 *    - Verifies that adapter and tracker match the target pool ID.
 *    - Rejects enumeration results without candidatePoolId matching target pool ID.
 *    - Rejects enumeration results if connectionEpoch does not match expected epoch.
 * 2. Unwitnessed Anchor Rejection:
 *    - Strictly rejects enumeration results without positive boundary anchor proof
 *      (anchorWitnessed: true and outcome: "ANCHOR_WITNESSED") before making any transaction requests.
 * 3. Accepted Adapter Ingestion Path:
 *    - Resolves signatures exclusively via adapter.processNotification().
 *    - No duplicate or independent getTransaction queries outside the adapter path.
 *    - Preserves shared CANDIDATE_ENRICHMENT accounting, host pacing (>= 2500ms), capacity
 *      reservation, and session ceilings managed by the shared GlobalResourceBudgetManager.
 * 4. Honest Duplicate Resolution:
 *    - An adapter DUPLICATE_NOTIFICATION outcome alone does not prove prior successful resolution.
 *    - Classified as DUPLICATE_RESOLVED only when matching prior evidence is explicitly supplied
 *      in priorSuccessfulSignatures; otherwise classified as DUPLICATE_UNRESOLVED and counted as failed.
 * 5. Partial Ingestion & Error Preservation:
 *    - Preserves partial-ingestion counts when an adapter result reports PARTIAL_INGEST_FAILED.
 *    - Decode failures, unavailable transactions, and budget denials are never classified as success.
 * 6. Workload & Deadline Bounds:
 *    - Bounds transactions processed up to maxTransactionsToProcess (default: 25).
 *    - Enforces total operation deadline (operationDeadlineMs, default: 30,000ms).
 *    - Rechecks cancellation, deadline, lifecycle status, and connection epoch around all awaited work.
 *    - Zero automatic retries and no background polling.
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

  /**
   * Set of signatures previously verified as successfully resolved for this candidate pool.
   * If adapter reports DUPLICATE_NOTIFICATION, it is classified as DUPLICATE_RESOLVED
   * only if included here; otherwise classified as DUPLICATE_UNRESOLVED.
   */
  readonly priorSuccessfulSignatures?: ReadonlySet<string> | readonly string[] | undefined;
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
  private readonly priorSuccessfulSignatures: ReadonlySet<string>;

  public constructor(options: TransactionResolutionBridgeOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Options object is required");
    }

    validateTrackedPoolContext(options.poolContext);
    this.poolContext = options.poolContext;

    if (!options.adapter) {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Explicit transaction source adapter is required");
    }
    if (options.adapter.getPoolContext().poolId !== this.poolContext.poolId) {
      throw new Error(
        `[RESOLUTION_BRIDGE_INIT] Adapter pool ID (${options.adapter.getPoolContext().poolId}) does not match bridge pool ID (${this.poolContext.poolId})`,
      );
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
    this.tracker = options.tracker;

    if (!options.budgetManager) {
      throw new Error("[RESOLUTION_BRIDGE_INIT] Shared GlobalResourceBudgetManager is required");
    }
    this.budgetManager = options.budgetManager;

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

    if (options.priorSuccessfulSignatures) {
      if (options.priorSuccessfulSignatures instanceof Set) {
        this.priorSuccessfulSignatures = new Set(options.priorSuccessfulSignatures);
      } else if (Array.isArray(options.priorSuccessfulSignatures)) {
        this.priorSuccessfulSignatures = new Set(options.priorSuccessfulSignatures);
      } else {
        throw new Error(
          "[RESOLUTION_BRIDGE_INIT] priorSuccessfulSignatures must be a Set or Array of signature strings",
        );
      }
    } else {
      this.priorSuccessfulSignatures = new Set<string>();
    }
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
    const effectiveDeadlineMs = callOverrides?.operationDeadlineMs ?? this.operationDeadlineMs;
    const deadlineEpoch = startTime + effectiveDeadlineMs;
    const effectiveMaxTx = callOverrides?.maxTransactionsToProcess ?? this.maxTransactionsToProcess;
    const isCancelledProbe = callOverrides?.isCancelled ?? this.isCancelled;
    const signal = callOverrides?.signal ?? this.signal;

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

    // 1. Provenance and Binding Validation
    if (!enumerationResult || typeof enumerationResult !== "object") {
      return createResult(
        "PROVENANCE_MISMATCH",
        [],
        {
          totalDiscovered: 0,
          totalProcessed: 0,
          totalResolved: 0,
          totalFailed: 0,
          totalDuplicatesUnresolved: 0,
          totalDuplicatesResolved: 0,
          totalIngestedSwaps: 0,
        },
        "Enumeration result is missing or not an object",
      );
    }

    if (enumerationResult.candidatePoolId !== this.poolContext.poolId) {
      return createResult(
        "PROVENANCE_MISMATCH",
        [],
        {
          totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          totalProcessed: 0,
          totalResolved: 0,
          totalFailed: 0,
          totalDuplicatesUnresolved: 0,
          totalDuplicatesResolved: 0,
          totalIngestedSwaps: 0,
        },
        `Candidate pool ID mismatch: enumeration result pool (${enumerationResult.candidatePoolId}) does not match bridge pool (${this.poolContext.poolId})`,
      );
    }

    if (
      enumerationResult.connectionEpoch !== undefined &&
      enumerationResult.connectionEpoch !== this.expectedEpoch
    ) {
      return createResult(
        "PROVENANCE_MISMATCH",
        [],
        {
          totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          totalProcessed: 0,
          totalResolved: 0,
          totalFailed: 0,
          totalDuplicatesUnresolved: 0,
          totalDuplicatesResolved: 0,
          totalIngestedSwaps: 0,
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
          totalDiscovered: enumerationResult.discoveredSignatures?.length ?? 0,
          totalProcessed: 0,
          totalResolved: 0,
          totalFailed: 0,
          totalDuplicatesUnresolved: 0,
          totalDuplicatesResolved: 0,
          totalIngestedSwaps: 0,
        },
        `Enumeration result does not contain a witnessed anchor (outcome: ${enumerationResult.outcome}, anchorWitnessed: ${String(enumerationResult.anchorWitnessed)}); resolution rejected`,
      );
    }

    // 3. Pre-execution State Checks
    if (isCancelledProbe?.() || signal?.aborted) {
      return createResult(
        "OPERATION_CANCELLED",
        [],
        {
          totalDiscovered: enumerationResult.discoveredSignatures.length,
          totalProcessed: 0,
          totalResolved: 0,
          totalFailed: 0,
          totalDuplicatesUnresolved: 0,
          totalDuplicatesResolved: 0,
          totalIngestedSwaps: 0,
        },
        "Resolution operation cancelled by caller before processing",
      );
    }

    if (this.clock() >= deadlineEpoch) {
      return createResult(
        "OPERATION_DEADLINE_EXCEEDED",
        [],
        {
          totalDiscovered: enumerationResult.discoveredSignatures.length,
          totalProcessed: 0,
          totalResolved: 0,
          totalFailed: 0,
          totalDuplicatesUnresolved: 0,
          totalDuplicatesResolved: 0,
          totalIngestedSwaps: 0,
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
            totalDiscovered: enumerationResult.discoveredSignatures.length,
            totalProcessed: 0,
            totalResolved: 0,
            totalFailed: 0,
            totalDuplicatesUnresolved: 0,
            totalDuplicatesResolved: 0,
            totalIngestedSwaps: 0,
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
            totalDiscovered: enumerationResult.discoveredSignatures.length,
            totalProcessed: 0,
            totalResolved: 0,
            totalFailed: 0,
            totalDuplicatesUnresolved: 0,
            totalDuplicatesResolved: 0,
            totalIngestedSwaps: 0,
          },
          `Coordinator epoch mismatch (expected: ${this.expectedEpoch}, current: ${initialEpoch})`,
        );
      }
    }

    // 4. Chronological Replay Ordering (Oldest First)
    // Discovered signatures are newest-first (descending slot); reverse to resolve chronologically.
    const discoveredList: readonly HistorySignatureRecord[] =
      enumerationResult.discoveredSignatures ?? [];
    const totalDiscovered = discoveredList.length;

    if (totalDiscovered === 0) {
      // Quiet period: anchor was witnessed immediately with 0 intervening transactions
      return createResult("ALL_RESOLVED", [], {
        totalDiscovered: 0,
        totalProcessed: 0,
        totalResolved: 0,
        totalFailed: 0,
        totalDuplicatesUnresolved: 0,
        totalDuplicatesResolved: 0,
        totalIngestedSwaps: 0,
      });
    }

    const chronologicalSignatures = [...discoveredList].reverse();
    const boundedSignatures = chronologicalSignatures.slice(0, effectiveMaxTx);

    const perSigResults: ResolvedSignatureRecord[] = [];
    let totalProcessed = 0;
    let totalResolved = 0;
    let totalFailed = 0;
    let totalDuplicatesUnresolved = 0;
    let totalDuplicatesResolved = 0;
    let totalIngestedSwaps = 0;
    let prematureTerminationOutcome: ResolutionBridgeOutcome | null = null;
    let terminationError: string | undefined = undefined;

    for (const record of boundedSignatures) {
      // Pre-await checks before dispatching next transaction
      if (isCancelledProbe?.() || signal?.aborted) {
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

      const remainingBudgetMs = Math.max(0, deadlineEpoch - this.clock());
      const notification: InjectedTransactionNotification = {
        signature: record.signature,
        slot: record.slot,
        blockTime: record.blockTime,
        receivedAtMs: this.clock(),
        provenance: "ON_CHAIN_BLOCK_TIME",
      };

      totalProcessed++;

      // Dispatch retrieval and decoding through accepted transaction source adapter
      const adapterResult = await this.adapter.processNotification(notification, this.tracker, {
        overallTimeoutMs: remainingBudgetMs,
        signal,
      });

      // Post-await state validation: recheck before inspecting or accepting resolution outcome
      if (isCancelledProbe?.() || signal?.aborted) {
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

      const postNow = this.clock();
      if (postNow >= deadlineEpoch) {
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
        if (postStatus !== "SUBSCRIBED") {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "LIFECYCLE_CANCELLED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: adapterResult.diagnostics?.decodedEventsCount ?? 0,
            ingestedEventsCount: adapterResult.ingestedEventsCount,
            error: `Coordinator transitioned to ${postStatus} during transaction processing`,
          });
          totalFailed++;
          prematureTerminationOutcome = "LIFECYCLE_CANCELLED";
          terminationError = `Coordinator transitioned to ${postStatus} during processing; remaining transactions abandoned`;
          break;
        }
        const postEpoch = this.lifecycleTarget.getConnectionEpoch();
        if (postEpoch !== this.expectedEpoch) {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "LIFECYCLE_CANCELLED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: adapterResult.diagnostics?.decodedEventsCount ?? 0,
            ingestedEventsCount: adapterResult.ingestedEventsCount,
            error: `Coordinator epoch transitioned to ${postEpoch} during transaction processing`,
          });
          totalFailed++;
          prematureTerminationOutcome = "LIFECYCLE_CANCELLED";
          terminationError = `Coordinator epoch changed to ${postEpoch} during processing; remaining transactions abandoned`;
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
        totalIngestedSwaps += ingestedCount;
      } else if (adapterResult.outcome === "DUPLICATE_NOTIFICATION") {
        if (this.priorSuccessfulSignatures.has(record.signature)) {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "DUPLICATE_RESOLVED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: ingestedCount,
          });
          totalDuplicatesResolved++;
          totalResolved++;
        } else {
          perSigResults.push({
            signature: record.signature,
            slot: record.slot,
            blockTime: record.blockTime,
            status: "DUPLICATE_UNRESOLVED",
            adapterOutcome: adapterResult.outcome,
            decodedEventsCount: decodedCount,
            ingestedEventsCount: ingestedCount,
            error:
              "Duplicate reported by adapter without matching prior resolution evidence for this candidate",
          });
          totalDuplicatesUnresolved++;
          totalFailed++;
        }
      } else if (adapterResult.outcome === "PARTIAL_INGEST_FAILED") {
        // Preserve partial-ingestion counts without classifying as successful recovery
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
        totalIngestedSwaps += ingestedCount;
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
          error: adapterResult.diagnostics?.error ?? "Deadline exceeded during adapter processing",
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
  }
}
