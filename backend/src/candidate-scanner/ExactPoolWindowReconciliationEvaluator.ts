/**
 * Phase 12.94-D Milestone D.3.3: Bounded Exact-Pool Window Reconciliation Evaluator
 *
 * Implements an isolated, non-mutating, offline-tested evaluator for provider-relative
 * trade flow reconciliation across a single validated Raydium candidate pool and one
 * explicitly identified 60-second window.
 *
 * OPERATIONAL & SAFETY INVARIANTS (Audit-Hardened V4):
 * 1. Scope: Offline reconciliation evaluation for one exact pool and one 60-second window only.
 *    Does NOT enable a production proof mode or modify coordinator.advanceCoverage(),
 *    CandidateFlowProvider production defaults, or strategy admission.
 * 2. Honest Assurance Contract:
 *    - Returns reconciliation evidence under explicit provider and indexer assumptions.
 *    - Permanent invariants: isCryptographicCompletenessEstablished = false,
 *      isProductionCompletenessEstablished = false.
 *    - Acknowledges upstream index omission limitation: dropped intermediate transactions
 *      cannot be independently detected via standard JSON-RPC pagination.
 * 3. Terminal Evidence Outcome Validation:
 *    - History and resolution results must conclude with accepted terminal outcomes
 *      (ANCHOR_WITNESSED for history, ALL_RESOLVED for resolution).
 *    - Explicit failure evidence (e.g. FETCH_ERROR, BUDGET_EXHAUSTED, PARTIAL_RESOLUTION)
 *      takes precedence over optimistic flags or empty record arrays.
 *    - Raw fixture arrays are not presented as completed acquisition receipts.
 * 4. Mandatory Resolution Evidence & Conflicting Record Rejection:
 *    - Explicit resolution evidence is MANDATORY for each in-window signature.
 *      Event presence or alreadyResolvedSignatures membership alone cannot establish completeness.
 *    - Conflicting resolution records (e.g. FAILED_DECODE overwritten by RESOLVED) are rejected fail-closed.
 *      Failure records cannot be overwritten by later success records.
 * 5. Cutoff Content & Payload Validation:
 *    - For ON_CHAIN_BLOCK_TIME provenance, supporting response content (responsePayload) and
 *      relevant request binding (requestContext) are MANDATORY.
 *    - Validates responseField against RPC schema (rejecting arbitrary strings such as 'banana').
 *    - Validates extracted timestamp, slot alignment, and candidate poolId binding.
 *    - Explicitly synthetic checkpoints (SYNTHETIC_FIXTURE) remain isolated.
 * 6. Non-Mutating Accounting & Evidenced Dispatch Reporting:
 *    - Evaluation consumes read-only snapshots and never calls tracker.evaluateWindow().
 *    - Stream inactivity at evaluation time is detected read-only against tracker.getLastObservationTimestampMs().
 *    - Actual requests dispatched are reported ONLY when fully evidenced across all required operations;
 *      pre-dispatch denials (e.g. PRE_DISPATCH_DEADLINE_EXCEEDED) are counted as 0 dispatches,
 *      and ambiguous/unsupported statuses report null (unknown) rather than partial counts.
 *    - Projected demand preserves known unresolved demand separately from actual attempts.
 */

import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import type {
  HistorySignatureRecord,
  HistoryEnumerationResult,
  HistoryEnumerationOutcome,
} from "./ExactPoolHistoryEnumerator.js";
import type {
  TransactionResolutionResult,
  ResolutionBridgeOutcome,
  ResolvedSignatureRecord,
} from "./ExactPoolTransactionResolutionBridge.js";
import {
  deriveCanonicalSwapKey,
  type RollingTradeFlowTracker,
  type StreamGap,
  type FlowCoverageStatus,
  type TradeEvent,
} from "./RollingTradeFlowTracker.js";
import type { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { CandidateFlowResult } from "./CandidateFlowProvider.js";

/**
 * Optional request context passed with cutoff evidence to verify slot and poolId binding.
 */
export interface SourceCutoffRequestContext {
  readonly slot?: number | undefined;
  readonly address?: string | undefined;
}

/**
 * Verified on-chain source cutoff evidence.
 * Explicitly specifies source method, response field, commitment, provenance, and optional payload.
 */
export interface SourceCutoffEvidence {
  readonly sourceMethod:
    | "getSignaturesForAddress"
    | "getBlockTime"
    | "getBlock"
    | "SYNTHETIC_CHECKPOINT";
  readonly responseField: string;
  readonly commitment: "confirmed" | "finalized";
  readonly provenance: "ON_CHAIN_BLOCK_TIME" | "SYNTHETIC_FIXTURE";
  readonly slot: number;
  readonly cutoffTimestampMs: number;
  readonly retrievedAtMs: number;
  readonly responsePayload?: unknown | undefined;
  readonly requestContext?: SourceCutoffRequestContext | undefined;
}

/**
 * Typed evaluation status of an exact-pool window reconciliation run.
 */
export type WindowReconciliationStatus =
  | "RECONCILED"
  | "WARM_UP"
  | "INCOMPLETE_OBSERVATION"
  | "MISSING_SOURCE_CUTOFF"
  | "INVALID_SOURCE_CUTOFF"
  | "MISSING_HISTORY_EVIDENCE"
  | "AMBIGUOUS_TIMESTAMP"
  | "STALE_DATA"
  | "FUTURE_DATED_EVIDENCE"
  | "STREAM_GAP"
  | "PROCESSING_BACKLOG"
  | "UNRESOLVED_TRANSACTIONS"
  | "UNWITNESSED_PRIOR_ANCHOR"
  | "INSUFFICIENT_DIRECTIONAL_EVIDENCE"
  | "IDENTITY_MISMATCH"
  | "BUDGET_EXHAUSTED"
  | "INVALID_INPUT";

/**
 * Standard provider and indexer assumptions explicitly underpinning provider-relative reconciliation.
 */
export const DEFAULT_PROVIDER_INDEX_ASSUMPTIONS: readonly string[] = Object.freeze([
  "RPC node address index for target pool is complete and unlagged up to source cutoff slot/time",
  "RPC getSignaturesForAddress returns all historical transactions mentioning pool without omission",
  "Node current slot/time is provider-reported telemetry, not independent cryptographic proof of address index completeness",
  "Standard RPC pagination satisfies anchor witnessing without verifying omission of intermediate transactions",
  "Reconciliation evidence is provider-relative and does not constitute cryptographic or ledger certainty",
]);

/**
 * Known limitations and unresolved uncertainties associated with provider-relative evidence.
 */
export const DEFAULT_UNRESOLVED_UNCERTAINTIES: readonly string[] = Object.freeze([
  "Upstream index omission: dropped intermediate transactions are undetectable via ordinary JSON-RPC pagination",
  "Intra-slot micro-ordering: transactions within the same slot lack microsecond execution order in getTransaction",
  "Solana blockTime resolution is integer seconds; millisecond conversion represents second-level truncation",
]);

/**
 * Projected demand metrics for unexecuted requests (calculated on an isolated snapshot).
 */
export interface ProjectedDemandMetrics {
  readonly watermarkRequests: number;
  readonly paginationRequests: number;
  readonly unresolvedTransactionRequests: number;
  readonly totalProjectedRequests: number;
  readonly projectedPacingWaitMs: number;
  readonly projectedRetrievalDurationMs: number;
  readonly isProjectedBudgetSufficient: boolean;
}

/**
 * Resource accounting metrics separating actual receipts from projected demand.
 */
export interface ResourceAccountingMetrics {
  readonly actualRequestsDispatched: number | null;
  readonly projectedDemand: ProjectedDemandMetrics;
  readonly budgetRemaining: number;
}

/**
 * Immutable result of an exact-pool window reconciliation evaluation.
 */
export interface WindowReconciliationResult {
  readonly status: WindowReconciliationStatus;
  readonly candidate: {
    readonly poolId: string;
    readonly candidateTokenMint: string;
    readonly quoteTokenMint: string;
  };
  readonly temporalContext: {
    readonly decisionTimestampMs: number;
    readonly windowStartMs: number;
    readonly windowEndMs: number;
    readonly observationStartMs: number;
    readonly observationEndMs: number;
    readonly evidenceAgeMs: number | null;
    readonly maxAllowedEvidenceAgeMs: number;
  };
  readonly sourceCutoff: SourceCutoffEvidence | null;
  readonly flowCounts: {
    readonly recentBuys60s: number | null;
    readonly recentSells60s: number | null;
    readonly flowRatio: number | null;
  };
  readonly flowCoverage: FlowCoverageStatus;
  readonly isCoverageSufficient: boolean;
  readonly underlyingOutcomes: {
    readonly enumerationOutcome?: HistoryEnumerationOutcome | undefined;
    readonly resolutionOutcome?: ResolutionBridgeOutcome | undefined;
    readonly anchorWitnessed: boolean;
    readonly knownAnchorSignature: string | null;
    readonly frozenTargetSignature: string | null;
    readonly totalDiscoveredSignatures: number;
    readonly totalResolvedTransactions: number;
    readonly incrementallyReusedCount: number;
    readonly windowSignaturesCount: number | null;
  };
  readonly resourceMetrics: ResourceAccountingMetrics;
  readonly providerAssumptions: readonly string[];
  readonly unresolvedUncertainties: readonly string[];
  readonly diagnosticReason: string;
  readonly isCryptographicCompletenessEstablished: false;
  readonly isProductionCompletenessEstablished: false;
  readonly paperQuietStreamQualified?: boolean | undefined;
  readonly paperQualificationReason?: string | undefined;
  readonly paperValidatedEpoch?: number | undefined;
}

export type ExecutionEnvironment = "PRODUCTION" | "PAPER_SIMULATION" | "BACKTEST";

export interface PaperQuietStreamPolicyOptions {
  readonly enabled: boolean;
  readonly executionContext: ExecutionEnvironment;
}

/**
 * Configuration options for evaluateExactPoolWindowReconciliation.
 */
export interface ExactPoolWindowReconciliationOptions {
  readonly poolContext: TrackedRaydiumPoolContext;
  readonly decisionTimestampMs: number;
  readonly observationStartMs: number;
  readonly observationEndMs: number;
  readonly sourceCutoff: SourceCutoffEvidence | null;
  readonly tracker?: RollingTradeFlowTracker | undefined;
  readonly recordedGaps?: readonly StreamGap[] | undefined;
  readonly hasActiveBacklog?: boolean | undefined;
  readonly knownAnchorSignature?: string | undefined;
  readonly expectedConnectionEpoch?: number | undefined;
  readonly historyResult?: HistoryEnumerationResult | undefined;
  readonly historyRecords?: readonly HistorySignatureRecord[] | undefined;
  readonly alreadyResolvedSignatures?: ReadonlySet<string> | undefined;
  readonly resolutionResult?: TransactionResolutionResult | undefined;
  readonly resolvedSignatures?: readonly ResolvedSignatureRecord[] | undefined;
  readonly trades?: readonly TradeEvent[] | undefined;
  readonly budgetManager: GlobalResourceBudgetManager;
  readonly providerName?: string | undefined; // default: "SOLANA_RPC"
  readonly minHostPacingMs?: number | undefined; // default: 2,500 ms
  readonly maxAllowedEvidenceAgeMs?: number | undefined; // default: 15,000 ms
  readonly simulatedLatenciesMs?: readonly number[] | undefined;
  readonly historyRetrievedAtMs?: number | undefined;
  readonly resolutionRetrievedAtMs?: number | undefined;
  readonly acquisitionCompletedAtMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly paperQuietStreamPolicy?: PaperQuietStreamPolicyOptions | undefined;
}

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
 * Clones a SourceCutoffEvidence object to ensure caller-owned references remain unfrozen.
 */
export function cloneSourceCutoff(
  cutoff: SourceCutoffEvidence | null,
): SourceCutoffEvidence | null {
  if (!cutoff) return null;
  let clonedPayload: unknown = undefined;
  if (cutoff.responsePayload !== undefined) {
    try {
      clonedPayload = JSON.parse(JSON.stringify(cutoff.responsePayload));
    } catch {
      clonedPayload = cutoff.responsePayload;
    }
  }
  return {
    sourceMethod: cutoff.sourceMethod,
    responseField: cutoff.responseField,
    commitment: cutoff.commitment,
    provenance: cutoff.provenance,
    slot: cutoff.slot,
    cutoffTimestampMs: cutoff.cutoffTimestampMs,
    retrievedAtMs: cutoff.retrievedAtMs,
    responsePayload: clonedPayload,
    requestContext: cutoff.requestContext ? { ...cutoff.requestContext } : undefined,
  };
}

/**
 * Deterministically validates cutoff provenance, method, responseField, requestContext,
 * and optional injected response payload.
 */
function validateAndExtractSourceCutoff(
  cutoff: SourceCutoffEvidence,
  poolContext: TrackedRaydiumPoolContext,
): { valid: true } | { valid: false; reason: string } {
  // 1. Provenance and Method Correspondence
  if (cutoff.provenance === "ON_CHAIN_BLOCK_TIME") {
    if (
      cutoff.sourceMethod !== "getSignaturesForAddress" &&
      cutoff.sourceMethod !== "getBlockTime" &&
      cutoff.sourceMethod !== "getBlock"
    ) {
      return {
        valid: false,
        reason: `ON_CHAIN_BLOCK_TIME provenance requires a blockTime-providing method (getSignaturesForAddress, getBlockTime, getBlock), received: '${cutoff.sourceMethod}'`,
      };
    }

    // MANDATORY Supporting evidence for ON_CHAIN_BLOCK_TIME
    if (cutoff.responsePayload === undefined || cutoff.responsePayload === null) {
      return {
        valid: false,
        reason: "ON_CHAIN_BLOCK_TIME cutoff requires supporting responsePayload",
      };
    }
    if (cutoff.requestContext === undefined || cutoff.requestContext === null) {
      return {
        valid: false,
        reason: "ON_CHAIN_BLOCK_TIME cutoff requires supporting requestContext",
      };
    }

    // Validate requestContext binding
    if (cutoff.sourceMethod === "getBlockTime" || cutoff.sourceMethod === "getBlock") {
      if (
        typeof cutoff.requestContext.slot !== "number" ||
        cutoff.requestContext.slot !== cutoff.slot
      ) {
        return {
          valid: false,
          reason: `requestContext slot (${String(cutoff.requestContext.slot)}) must match cutoff slot (${cutoff.slot}) for ${cutoff.sourceMethod}`,
        };
      }
    } else if (cutoff.sourceMethod === "getSignaturesForAddress") {
      if (cutoff.requestContext.address !== poolContext.poolId) {
        return {
          valid: false,
          reason: `requestContext address ('${String(cutoff.requestContext.address)}') must match candidate poolId ('${poolContext.poolId}')`,
        };
      }
      if (cutoff.requestContext.slot !== undefined && cutoff.requestContext.slot !== cutoff.slot) {
        return {
          valid: false,
          reason: `requestContext slot (${cutoff.requestContext.slot}) does not match cutoff slot (${cutoff.slot})`,
        };
      }
    }
  } else if (cutoff.provenance === "SYNTHETIC_FIXTURE") {
    if (cutoff.sourceMethod !== "SYNTHETIC_CHECKPOINT") {
      return {
        valid: false,
        reason: `SYNTHETIC_FIXTURE provenance requires SYNTHETIC_CHECKPOINT sourceMethod, received: '${cutoff.sourceMethod}'`,
      };
    }
  } else {
    return {
      valid: false,
      reason: `Unsupported provenance: '${String((cutoff as unknown as Record<string, unknown>).provenance)}'`,
    };
  }

  // 2. Validate responseField for the specific sourceMethod
  // Do NOT accept arbitrary strings like "banana"!
  const trimmedField = cutoff.responseField?.trim() ?? "";
  if (!trimmedField) {
    return { valid: false, reason: "responseField must be a non-empty string" };
  }

  switch (cutoff.sourceMethod) {
    case "getBlockTime":
      if (trimmedField !== "result") {
        return {
          valid: false,
          reason: `Invalid responseField for getBlockTime: expected 'result', received '${trimmedField}'`,
        };
      }
      break;
    case "getSignaturesForAddress":
      if (trimmedField !== "result[0].blockTime" && trimmedField !== "result[0]") {
        return {
          valid: false,
          reason: `Invalid responseField for getSignaturesForAddress: expected 'result[0].blockTime', received '${trimmedField}'`,
        };
      }
      break;
    case "getBlock":
      if (trimmedField !== "result.blockTime" && trimmedField !== "result") {
        return {
          valid: false,
          reason: `Invalid responseField for getBlock: expected 'result.blockTime', received '${trimmedField}'`,
        };
      }
      break;
    case "SYNTHETIC_CHECKPOINT":
      if (trimmedField !== "syntheticTimestampMs" && trimmedField !== "checkpoint") {
        return {
          valid: false,
          reason: `Invalid responseField for SYNTHETIC_CHECKPOINT: expected 'syntheticTimestampMs' or 'checkpoint', received '${trimmedField}'`,
        };
      }
      break;
  }

  // 3. Telemetry ranges
  if (cutoff.commitment !== "confirmed" && cutoff.commitment !== "finalized") {
    return {
      valid: false,
      reason: `Invalid commitment: expected 'confirmed' | 'finalized', received '${cutoff.commitment}'`,
    };
  }
  if (
    typeof cutoff.slot !== "number" ||
    !Number.isFinite(cutoff.slot) ||
    !Number.isInteger(cutoff.slot) ||
    cutoff.slot < 0
  ) {
    return {
      valid: false,
      reason: `Invalid slot: expected non-negative integer, received ${cutoff.slot}`,
    };
  }
  if (
    typeof cutoff.cutoffTimestampMs !== "number" ||
    !Number.isFinite(cutoff.cutoffTimestampMs) ||
    !Number.isInteger(cutoff.cutoffTimestampMs) ||
    cutoff.cutoffTimestampMs <= 0
  ) {
    return {
      valid: false,
      reason: `Invalid cutoffTimestampMs: expected positive integer, received ${cutoff.cutoffTimestampMs}`,
    };
  }
  if (
    typeof cutoff.retrievedAtMs !== "number" ||
    !Number.isFinite(cutoff.retrievedAtMs) ||
    !Number.isInteger(cutoff.retrievedAtMs) ||
    cutoff.retrievedAtMs <= 0
  ) {
    return {
      valid: false,
      reason: `Invalid retrievedAtMs: expected positive integer, received ${cutoff.retrievedAtMs}`,
    };
  }

  // 4. Response payload validation (if supplied)
  if (cutoff.responsePayload !== undefined) {
    const payload = cutoff.responsePayload;
    if (payload === null || (typeof payload !== "object" && typeof payload !== "number")) {
      return {
        valid: false,
        reason: "responsePayload must be a non-null object, array, or numeric value",
      };
    }

    if (typeof payload === "object" && payload !== null) {
      const payloadObj = payload as Record<string, unknown>;
      if (payloadObj.error) {
        return {
          valid: false,
          reason: `responsePayload contains RPC error: ${JSON.stringify(payloadObj.error)}`,
        };
      }
    }

    if (cutoff.sourceMethod === "getBlockTime") {
      let val: unknown = payload;
      if (typeof payload === "object" && payload !== null && "result" in payload) {
        val = (payload as Record<string, unknown>).result;
      }
      if (typeof val !== "number" || !Number.isFinite(val)) {
        return {
          valid: false,
          reason: `getBlockTime responsePayload missing numeric timestamp result: received ${String(val)}`,
        };
      }
      if (val * 1000 !== cutoff.cutoffTimestampMs) {
        return {
          valid: false,
          reason: `getBlockTime response value (${val}s = ${val * 1000}ms) does not match cutoffTimestampMs (${cutoff.cutoffTimestampMs}ms)`,
        };
      }
    } else if (cutoff.sourceMethod === "getSignaturesForAddress") {
      let arr: unknown = payload;
      if (typeof payload === "object" && payload !== null && "result" in payload) {
        arr = (payload as Record<string, unknown>).result;
      }
      if (!Array.isArray(arr) || arr.length === 0) {
        return {
          valid: false,
          reason: "getSignaturesForAddress responsePayload result must be a non-empty array",
        };
      }
      const first = arr[0] as Record<string, unknown>;
      if (!first || typeof first !== "object") {
        return {
          valid: false,
          reason: "getSignaturesForAddress responsePayload[0] is not an object",
        };
      }
      if (typeof first.blockTime !== "number" || !Number.isFinite(first.blockTime)) {
        return {
          valid: false,
          reason: "getSignaturesForAddress responsePayload[0].blockTime is missing or non-numeric",
        };
      }
      if (first.blockTime * 1000 !== cutoff.cutoffTimestampMs) {
        return {
          valid: false,
          reason: `getSignaturesForAddress response blockTime (${first.blockTime}s = ${first.blockTime * 1000}ms) does not match cutoffTimestampMs (${cutoff.cutoffTimestampMs}ms)`,
        };
      }
      if (typeof first.slot === "number" && first.slot !== cutoff.slot) {
        return {
          valid: false,
          reason: `getSignaturesForAddress response slot (${first.slot}) does not match cutoff slot (${cutoff.slot})`,
        };
      }
    } else if (cutoff.sourceMethod === "getBlock") {
      let blockObj: unknown = payload;
      if (typeof payload === "object" && payload !== null && "result" in payload) {
        blockObj = (payload as Record<string, unknown>).result;
      }
      if (!blockObj || typeof blockObj !== "object") {
        return { valid: false, reason: "getBlock responsePayload result is not an object" };
      }
      const b = blockObj as Record<string, unknown>;
      if (typeof b.blockTime !== "number" || !Number.isFinite(b.blockTime)) {
        return {
          valid: false,
          reason: "getBlock responsePayload result.blockTime is missing or non-numeric",
        };
      }
      if (b.blockTime * 1000 !== cutoff.cutoffTimestampMs) {
        return {
          valid: false,
          reason: `getBlock response blockTime (${b.blockTime}s = ${b.blockTime * 1000}ms) does not match cutoffTimestampMs (${cutoff.cutoffTimestampMs}ms)`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Evaluates provider-relative window reconciliation for one exact pool and one 60-second window.
 * Non-mutating: does not dispatch requests, mutate budget manager state, mutate tracker state,
 * or freeze caller objects.
 */
export function evaluateExactPoolWindowReconciliation(
  options: ExactPoolWindowReconciliationOptions,
): WindowReconciliationResult {
  const minHostPacingMs = Math.max(0, options.minHostPacingMs ?? 2500);
  const maxAllowedEvidenceAgeMs = Math.max(0, options.maxAllowedEvidenceAgeMs ?? 15000);

  // Snapshot caller-owned inputs before freezing
  const sourceCutoffSnapshot = cloneSourceCutoff(options.sourceCutoff);
  const candidateSnapshot = {
    poolId: options.poolContext?.poolId ?? "",
    candidateTokenMint: options.poolContext?.candidateTokenMint ?? "",
    quoteTokenMint: options.poolContext?.quoteTokenMint ?? "",
  };

  const budgetStats = options.budgetManager?.getStats?.();
  const remainingBudget = budgetStats
    ? Math.max(0, budgetStats.maxEnrichmentAttempts - budgetStats.enrichmentRequests)
    : 0;

  // Projected demand calculation helper (non-mutating on isolated snapshot)
  const calculateProjectedDemand = (
    unresolvedCount: number,
    needsPagination: boolean,
  ): ProjectedDemandMetrics => {
    const watermarkRequests = 0;
    const paginationRequests = needsPagination ? 1 : 0;
    const unresolvedTransactionRequests = unresolvedCount;
    const totalProjectedRequests =
      watermarkRequests + paginationRequests + unresolvedTransactionRequests;

    const latencies = options.simulatedLatenciesMs ?? [];
    let projectedPacingWaitMs = 0;
    let projectedRetrievalDurationMs = 0;
    for (let i = 0; i < totalProjectedRequests; i++) {
      const wait = i === 0 ? 0 : minHostPacingMs;
      const lat = latencies[i] ?? 50;
      projectedPacingWaitMs += wait;
      projectedRetrievalDurationMs += wait + lat;
    }

    const isStop = budgetStats?.isStopTriggered429 === true;
    const isBudgetSufficient =
      !isStop &&
      totalProjectedRequests <= remainingBudget &&
      (totalProjectedRequests > 0 || !needsPagination);

    return {
      watermarkRequests,
      paginationRequests,
      unresolvedTransactionRequests,
      totalProjectedRequests,
      projectedPacingWaitMs,
      projectedRetrievalDurationMs,
      isProjectedBudgetSufficient: isBudgetSufficient,
    };
  };

  // Actual requests dispatched calculation helper (from fully evidenced receipts only)
  const computeActualRequestsDispatched = (): number | null => {
    let historyDispatches: number | null = null;
    if (options.historyResult && typeof options.historyResult.requestCount === "number") {
      historyDispatches = options.historyResult.requestCount;
    }

    let resolutionDispatches: number | null = null;
    if (options.resolutionResult) {
      const res = options.resolutionResult;
      const totalProcessed = typeof res.totalProcessed === "number" ? res.totalProcessed : 0;
      const perSigResults = res.perSignatureResults;
      const perSigLength = Array.isArray(perSigResults) ? perSigResults.length : 0;

      // Close unknown accounting: totalProcessed is nonzero but perSignatureResults is empty or partial.
      // Missing records prevent establishing the total -> return null.
      if (totalProcessed > 0 && perSigLength === 0) {
        return null;
      }
      if (totalProcessed > perSigLength) {
        return null;
      }

      if (Array.isArray(perSigResults)) {
        let count = 0;
        let isResolutionFullyEvidenced = true;

        for (const sigRes of perSigResults) {
          // Pre-dispatch denials & duplicate notifications did not dispatch an HTTP attempt:
          const isPreDispatch =
            sigRes.adapterOutcome === "PRE_DISPATCH_BUDGET_DENIED" ||
            sigRes.adapterOutcome === "PRE_DISPATCH_DEADLINE_EXCEEDED" ||
            sigRes.adapterOutcome === "DUPLICATE_NOTIFICATION" ||
            sigRes.adapterOutcome === "INVALID_NOTIFICATION" ||
            sigRes.adapterOutcome === "QUEUE_OVERFLOW" ||
            sigRes.status === "DUPLICATE_RESOLVED" ||
            sigRes.status === "DUPLICATE_UNRESOLVED" ||
            sigRes.status === "BUDGET_DENIED";

          if (isPreDispatch) {
            continue;
          }

          // Explicit post-dispatch outcomes:
          // Note: ADAPTER_ERROR without explicit adapterOutcome or attempt evidence is NOT post-dispatch.
          const isPostDispatch =
            sigRes.adapterOutcome === "SUCCESS" ||
            sigRes.adapterOutcome === "REQUEST_TIMEOUT" ||
            sigRes.adapterOutcome === "NETWORK_ERROR" ||
            sigRes.adapterOutcome === "HTTP_ERROR" ||
            sigRes.adapterOutcome === "MALFORMED_RESPONSE" ||
            sigRes.adapterOutcome === "RPC_ERROR" ||
            sigRes.adapterOutcome === "TRANSACTION_NOT_FOUND" ||
            sigRes.adapterOutcome === "RESPONSE_SIGNATURE_MISMATCH" ||
            sigRes.adapterOutcome === "CONTRADICTORY_METADATA" ||
            sigRes.adapterOutcome === "DECODE_FAILED" ||
            sigRes.adapterOutcome === "INGEST_FAILED" ||
            sigRes.adapterOutcome === "PARTIAL_INGEST_FAILED" ||
            sigRes.status === "RESOLVED" ||
            sigRes.status === "FAILED_DECODE" ||
            sigRes.status === "FAILED_INGEST" ||
            sigRes.status === "PARTIAL_INGEST" ||
            sigRes.status === "TRANSACTION_UNAVAILABLE";

          if (isPostDispatch) {
            count++;
          } else {
            // Ambiguous status without explicit diagnostics/attempt evidence (e.g. DEADLINE_EXCEEDED or ADAPTER_ERROR without adapterOutcome)
            isResolutionFullyEvidenced = false;
            break;
          }
        }

        if (isResolutionFullyEvidenced) {
          resolutionDispatches = count;
        }
      } else if (totalProcessed === 0) {
        resolutionDispatches = 0;
      }
    } else if (
      options.historyResult?.discoveredSignatures?.length === 0 ||
      options.historyRecords?.length === 0
    ) {
      // Quiet window where 0 signatures were discovered in history: resolution dispatches = 0
      resolutionDispatches = 0;
    }

    if (historyDispatches !== null && resolutionDispatches !== null) {
      return historyDispatches + resolutionDispatches;
    }
    return null;
  };

  // Helper to construct a frozen result with cloned objects
  const buildResult = (
    status: WindowReconciliationStatus,
    flowCoverage: FlowCoverageStatus,
    diagnosticReason: string,
    extra: {
      windowStartMs?: number | undefined;
      windowEndMs?: number | undefined;
      evidenceAgeMs?: number | null | undefined;
      buys?: number | null | undefined;
      sells?: number | null | undefined;
      flowRatio?: number | null | undefined;
      enumerationOutcome?: HistoryEnumerationOutcome | undefined;
      resolutionOutcome?: ResolutionBridgeOutcome | undefined;
      anchorWitnessed?: boolean | undefined;
      knownAnchorSignature?: string | null | undefined;
      frozenTargetSignature?: string | null | undefined;
      totalDiscovered?: number | undefined;
      totalResolved?: number | undefined;
      incrementallyReused?: number | undefined;
      windowSignaturesCount?: number | null | undefined;
      actualRequestsDispatched?: number | null | undefined;
      projectedDemand?: ProjectedDemandMetrics | undefined;
      budgetRemaining?: number | undefined;
      unresolvedCount?: number | undefined;
      needsPagination?: boolean | undefined;
      paperQuietStreamQualified?: boolean | undefined;
      paperQualificationReason?: string | undefined;
      paperValidatedEpoch?: number | undefined;
    } = {},
  ): WindowReconciliationResult => {
    const isSufficient = flowCoverage === "SUFFICIENT";
    const projectedDemand =
      extra.projectedDemand ??
      calculateProjectedDemand(extra.unresolvedCount ?? 0, extra.needsPagination ?? false);

    const res: WindowReconciliationResult = {
      status,
      candidate: candidateSnapshot,
      temporalContext: {
        decisionTimestampMs: options.decisionTimestampMs,
        windowStartMs: extra.windowStartMs ?? 0,
        windowEndMs: extra.windowEndMs ?? 0,
        observationStartMs: options.observationStartMs,
        observationEndMs: options.observationEndMs,
        evidenceAgeMs: extra.evidenceAgeMs ?? null,
        maxAllowedEvidenceAgeMs,
      },
      sourceCutoff: sourceCutoffSnapshot,
      flowCounts: {
        recentBuys60s: isSufficient ? (extra.buys ?? null) : null,
        recentSells60s: isSufficient ? (extra.sells ?? null) : null,
        flowRatio: isSufficient ? (extra.flowRatio ?? null) : null,
      },
      flowCoverage,
      isCoverageSufficient: isSufficient,
      underlyingOutcomes: {
        enumerationOutcome: extra.enumerationOutcome ?? options.historyResult?.outcome,
        resolutionOutcome: extra.resolutionOutcome ?? options.resolutionResult?.outcome,
        anchorWitnessed:
          extra.anchorWitnessed ??
          options.historyResult?.anchorWitnessed ??
          options.resolutionResult?.anchorWitnessed ??
          false,
        knownAnchorSignature:
          extra.knownAnchorSignature ??
          options.knownAnchorSignature ??
          options.historyResult?.knownAnchorSignature ??
          options.resolutionResult?.knownAnchorSignature ??
          null,
        frozenTargetSignature:
          extra.frozenTargetSignature ??
          options.historyResult?.frozenTargetSignature ??
          options.resolutionResult?.frozenTargetSignature ??
          null,
        totalDiscoveredSignatures:
          extra.totalDiscovered ??
          options.historyResult?.discoveredSignatures?.length ??
          options.historyRecords?.length ??
          0,
        totalResolvedTransactions:
          extra.totalResolved ??
          options.resolutionResult?.totalResolved ??
          options.resolvedSignatures?.length ??
          0,
        incrementallyReusedCount: extra.incrementallyReused ?? 0,
        windowSignaturesCount:
          extra.windowSignaturesCount !== undefined ? extra.windowSignaturesCount : null,
      },
      resourceMetrics: {
        actualRequestsDispatched:
          extra.actualRequestsDispatched !== undefined
            ? extra.actualRequestsDispatched
            : computeActualRequestsDispatched(),
        projectedDemand,
        budgetRemaining: extra.budgetRemaining ?? remainingBudget,
      },
      providerAssumptions: DEFAULT_PROVIDER_INDEX_ASSUMPTIONS,
      unresolvedUncertainties: DEFAULT_UNRESOLVED_UNCERTAINTIES,
      diagnosticReason,
      isCryptographicCompletenessEstablished: false,
      isProductionCompletenessEstablished: false,
      paperQuietStreamQualified: extra.paperQuietStreamQualified ?? false,
      ...(extra.paperQualificationReason
        ? { paperQualificationReason: extra.paperQualificationReason }
        : {}),
      ...(extra.paperValidatedEpoch !== undefined
        ? { paperValidatedEpoch: extra.paperValidatedEpoch }
        : {}),
    };
    return deepFreeze(res);
  };

  // Snapshot nested policy options immediately so caller mutation cannot change authorization
  const paperPolicySnapshot: PaperQuietStreamPolicyOptions | undefined =
    options.paperQuietStreamPolicy
      ? Object.freeze({
          enabled: Boolean(options.paperQuietStreamPolicy.enabled),
          executionContext: options.paperQuietStreamPolicy.executionContext,
        })
      : undefined;

  // 1. Validate Candidate Pool Context
  try {
    validateTrackedPoolContext(options.poolContext);
  } catch (err) {
    return buildResult(
      "INVALID_INPUT",
      "COLLECTION_GAP",
      `INVALID_POOL_CONTEXT: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Validate Timestamps
  if (
    typeof options.decisionTimestampMs !== "number" ||
    !Number.isFinite(options.decisionTimestampMs) ||
    !Number.isInteger(options.decisionTimestampMs) ||
    options.decisionTimestampMs <= 0 ||
    typeof options.observationStartMs !== "number" ||
    !Number.isFinite(options.observationStartMs) ||
    !Number.isInteger(options.observationStartMs) ||
    options.observationStartMs < 0 ||
    typeof options.observationEndMs !== "number" ||
    !Number.isFinite(options.observationEndMs) ||
    !Number.isInteger(options.observationEndMs) ||
    options.observationEndMs <= 0
  ) {
    return buildResult(
      "INVALID_INPUT",
      "COLLECTION_GAP",
      "INVALID_TIMESTAMPS: decisionTimestampMs, observationStartMs, and observationEndMs must be positive finite integers",
    );
  }

  if (options.observationStartMs > options.observationEndMs) {
    return buildResult(
      "INVALID_INPUT",
      "COLLECTION_GAP",
      `INVALID_TIMESTAMPS: observationStartMs (${options.observationStartMs}) cannot exceed observationEndMs (${options.observationEndMs})`,
    );
  }

  // Strict Causal Ordering: observation end cannot be in the future relative to decision time
  if (options.observationEndMs > options.decisionTimestampMs) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `CAUSALITY_VIOLATION: Observation end (${options.observationEndMs} ms) is in the future relative to decision time (${options.decisionTimestampMs} ms)`,
    );
  }

  // 3. Validate Source Cutoff Evidence
  if (!options.sourceCutoff) {
    return buildResult(
      "MISSING_SOURCE_CUTOFF",
      "COLLECTION_GAP",
      "MISSING_SOURCE_CUTOFF: Source cutoff evidence was not provided. An empty getSignaturesForAddress response alone does not establish an on-chain source cutoff",
    );
  }

  const cutoff = options.sourceCutoff;
  const cutoffValidation = validateAndExtractSourceCutoff(cutoff, options.poolContext);
  if (!cutoffValidation.valid) {
    return buildResult(
      "INVALID_SOURCE_CUTOFF",
      "COLLECTION_GAP",
      `INVALID_SOURCE_CUTOFF: ${cutoffValidation.reason}`,
    );
  }

  const windowEndMs = cutoff.cutoffTimestampMs;
  const windowStartMs = windowEndMs - 60_000;
  const evidenceAgeMs = options.decisionTimestampMs - windowEndMs;

  // Strict Causal Invariants: Cutoff time and retrieval time cannot be after decision time
  if (windowEndMs > options.decisionTimestampMs) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `CAUSALITY_VIOLATION: Source cutoff timestamp (${windowEndMs} ms) is in the future relative to decision time (${options.decisionTimestampMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (cutoff.retrievedAtMs > options.decisionTimestampMs) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `CAUSALITY_VIOLATION: Cutoff evidence retrieval timestamp (${cutoff.retrievedAtMs} ms) is after decision time (${options.decisionTimestampMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (
    typeof options.historyRetrievedAtMs === "number" &&
    options.historyRetrievedAtMs > options.decisionTimestampMs
  ) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `CAUSALITY_VIOLATION: History enumeration evidence retrieval timestamp (${options.historyRetrievedAtMs} ms) is after decision time (${options.decisionTimestampMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (
    typeof options.resolutionRetrievedAtMs === "number" &&
    options.resolutionRetrievedAtMs > options.decisionTimestampMs
  ) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `CAUSALITY_VIOLATION: Transaction resolution evidence retrieval timestamp (${options.resolutionRetrievedAtMs} ms) is after decision time (${options.decisionTimestampMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (
    typeof options.acquisitionCompletedAtMs === "number" &&
    options.acquisitionCompletedAtMs > options.decisionTimestampMs
  ) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `CAUSALITY_VIOLATION: Acquisition completed timestamp (${options.acquisitionCompletedAtMs} ms) is after decision time (${options.decisionTimestampMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (evidenceAgeMs > maxAllowedEvidenceAgeMs) {
    return buildResult(
      "STALE_DATA",
      "STALE_DATA",
      `STALE_DATA: Source cutoff age (${evidenceAgeMs} ms) exceeds max allowed evidence age (${maxAllowedEvidenceAgeMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 4. Observation Interval & Warm-Up Check
  if (options.observationStartMs > windowStartMs) {
    const unobservedDurationMs = options.observationStartMs - windowStartMs;
    return buildResult(
      "WARM_UP",
      "WARM_UP",
      `WARM_UP: Observation started at ${options.observationStartMs} ms, after window start ${windowStartMs} ms (unobserved duration: ${unobservedDurationMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (options.observationEndMs < windowEndMs) {
    return buildResult(
      "INCOMPLETE_OBSERVATION",
      "COLLECTION_GAP",
      `INCOMPLETE_OBSERVATION: Observation ended at ${options.observationEndMs} ms, before source cutoff ${windowEndMs} ms`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 5. Check Stream Gaps & Stream Inactivity (Read-Only, Never Mutates Tracker)
  // 5A. Non-waivable recorded gaps: any recorded collection loss (disconnect, buffer loss, capacity loss, overflow)
  // or caller-supplied gap strictly fails closed immediately, regardless of its reason string.
  const recordedGaps: StreamGap[] = [];
  if (options.recordedGaps) {
    recordedGaps.push(...options.recordedGaps);
  }
  if (options.tracker) {
    recordedGaps.push(...options.tracker.getRecordedGaps());
  }

  const intersectingRecordedGaps = recordedGaps.filter(
    (gap) => gap.gapStartMs < windowEndMs && gap.gapEndMs > windowStartMs,
  );

  if (intersectingRecordedGaps.length > 0) {
    const recordedLossGap = intersectingRecordedGaps[0]!;
    return buildResult(
      "STREAM_GAP",
      "COLLECTION_GAP",
      `COLLECTION_GAP: Stream gap witnessed in observation window [${recordedLossGap.gapStartMs}, ${recordedLossGap.gapEndMs}] (reason: ${recordedLossGap.reason ?? "UNSPECIFIED"})`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 5B. Check locally generated stream inactivity heuristic (read-only without calling evaluateWindow())
  let pendingGeneratedInactivityGap: {
    readonly gapStartMs: number;
    readonly gapEndMs: number;
  } | null = null;
  if (options.tracker) {
    const lastObsMs = options.tracker.getLastObservationTimestampMs();
    const inactivityThresholdMs = 15_000;
    if (windowEndMs - lastObsMs > inactivityThresholdMs) {
      const isPaperQuietOptedIn = Boolean(
        paperPolicySnapshot?.enabled &&
        (paperPolicySnapshot.executionContext === "PAPER_SIMULATION" ||
          paperPolicySnapshot.executionContext === "BACKTEST"),
      );

      if (!isPaperQuietOptedIn) {
        // Default / production / non-PAPER context: fails closed immediately
        return buildResult(
          "STREAM_GAP",
          "COLLECTION_GAP",
          `COLLECTION_GAP: Stream gap witnessed in observation window [${lastObsMs}, ${windowEndMs}] (reason: STREAM_INACTIVITY_AT_EVALUATION)`,
          { windowStartMs, windowEndMs, evidenceAgeMs },
        );
      }

      // Defer ONLY this locally derived evaluation-time heuristic under explicit PAPER opt-in
      pendingGeneratedInactivityGap = {
        gapStartMs: lastObsMs,
        gapEndMs: windowEndMs,
      };
    }
  }

  // 6. Check Backlog (Read-Only, Never Mutates Tracker)
  const trackerBacklog = Boolean(
    (options.tracker as unknown as { readonly hasActiveBacklog?: boolean })?.hasActiveBacklog,
  );
  const hasBacklog = options.hasActiveBacklog === true || trackerBacklog;

  if (hasBacklog) {
    return buildResult(
      "PROCESSING_BACKLOG",
      "PROCESSING_BACKLOG",
      "PROCESSING_BACKLOG: Active transaction queue backlog present at evaluation time",
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 7. Validate History Evidence Presence and Terminal Outcome
  // For PAPER quiet stream qualification, require completed historyResult enumeration receipt.
  // Empty fixture arrays (e.g. historyRecords: []) cannot substitute for acquisition evidence.
  if (pendingGeneratedInactivityGap !== null) {
    if (!options.historyResult) {
      return buildResult(
        "STREAM_GAP",
        "COLLECTION_GAP",
        "COLLECTION_GAP: PAPER quiet stream qualification requires completed historyResult enumeration receipt (empty historyRecords fixture cannot substitute for acquisition evidence)",
        { windowStartMs, windowEndMs, evidenceAgeMs, needsPagination: true },
      );
    }
  }

  if (!options.historyResult && !options.historyRecords) {
    return buildResult(
      "MISSING_HISTORY_EVIDENCE",
      "COLLECTION_GAP",
      "MISSING_HISTORY_EVIDENCE: No history enumeration evidence was supplied. History evidence cannot be inferred or assumed empty",
      { windowStartMs, windowEndMs, evidenceAgeMs, needsPagination: true },
    );
  }

  let discoveredSignatures: readonly HistorySignatureRecord[] = [];
  let enumerationOutcome: HistoryEnumerationOutcome | undefined;

  if (options.historyResult) {
    if (options.historyResult.candidatePoolId !== options.poolContext.poolId) {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        `IDENTITY_MISMATCH: History enumeration result poolId '${options.historyResult.candidatePoolId}' does not match pool context '${options.poolContext.poolId}'`,
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    enumerationOutcome = options.historyResult.outcome;

    // Validate terminal enumeration outcomes: only ANCHOR_WITNESSED is accepted completion
    if (options.historyResult.outcome === "BUDGET_EXHAUSTED") {
      return buildResult(
        "BUDGET_EXHAUSTED",
        "COLLECTION_GAP",
        "BUDGET_EXHAUSTED: History enumeration halted due to budget quota exhaustion",
        { windowStartMs, windowEndMs, evidenceAgeMs, needsPagination: true },
      );
    }
    if (options.historyResult.outcome === "ANCHOR_NOT_FOUND") {
      return buildResult(
        "UNWITNESSED_PRIOR_ANCHOR",
        "COLLECTION_GAP",
        "UNWITNESSED_PRIOR_ANCHOR: History enumeration did not find boundary anchor before pagination exhausted",
        { windowStartMs, windowEndMs, evidenceAgeMs, needsPagination: true },
      );
    }
    if (options.historyResult.outcome !== "ANCHOR_WITNESSED") {
      return buildResult(
        "INCOMPLETE_OBSERVATION",
        "COLLECTION_GAP",
        `INCOMPLETE_OBSERVATION: History enumeration did not complete successfully (outcome: '${options.historyResult.outcome}', error: '${options.historyResult.error ?? "NONE"}')`,
        { windowStartMs, windowEndMs, evidenceAgeMs, needsPagination: true },
      );
    }

    if (options.historyResult.anchorWitnessed !== true) {
      return buildResult(
        "UNWITNESSED_PRIOR_ANCHOR",
        "COLLECTION_GAP",
        "UNWITNESSED_PRIOR_ANCHOR: History enumeration reported anchorWitnessed=false",
        { windowStartMs, windowEndMs, evidenceAgeMs, needsPagination: true },
      );
    }

    discoveredSignatures = options.historyResult.discoveredSignatures ?? [];
  } else if (options.historyRecords) {
    discoveredSignatures = options.historyRecords;
  }

  // 8. Validate Resolution Result (if supplied)
  if (options.resolutionResult) {
    if (options.resolutionResult.candidatePoolId !== options.poolContext.poolId) {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        `IDENTITY_MISMATCH: Resolution result poolId '${options.resolutionResult.candidatePoolId}' does not match pool context '${options.poolContext.poolId}'`,
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    if (options.resolutionResult.outcome === "BUDGET_EXHAUSTED") {
      return buildResult(
        "BUDGET_EXHAUSTED",
        "COLLECTION_GAP",
        "BUDGET_EXHAUSTED: Transaction resolution halted due to budget quota exhaustion",
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    if (options.resolutionResult.outcome === "UNWITNESSED_ANCHOR_REJECTED") {
      return buildResult(
        "UNWITNESSED_PRIOR_ANCHOR",
        "COLLECTION_GAP",
        "UNWITNESSED_PRIOR_ANCHOR: Transaction resolution rejected due to unwitnessed anchor",
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    if (options.resolutionResult.outcome === "PROVENANCE_MISMATCH") {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        "IDENTITY_MISMATCH: Transaction resolution reported provenance mismatch",
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    if (options.resolutionResult.outcome !== "ALL_RESOLVED") {
      return buildResult(
        "UNRESOLVED_TRANSACTIONS",
        "COLLECTION_GAP",
        `UNRESOLVED_TRANSACTIONS: Transaction resolution did not resolve all transactions (outcome: '${options.resolutionResult.outcome}', error: '${options.resolutionResult.error ?? "NONE"}')`,
        { windowStartMs, windowEndMs, evidenceAgeMs, unresolvedCount: 1 },
      );
    }
  }

  // 9. Cross-Evidence Consistency Validation
  const effectiveAnchorSig =
    options.knownAnchorSignature ??
    options.historyResult?.knownAnchorSignature ??
    options.resolutionResult?.knownAnchorSignature ??
    null;

  if (
    options.historyResult?.knownAnchorSignature &&
    options.resolutionResult?.knownAnchorSignature &&
    options.historyResult.knownAnchorSignature !== options.resolutionResult.knownAnchorSignature
  ) {
    return buildResult(
      "IDENTITY_MISMATCH",
      "COLLECTION_GAP",
      `IDENTITY_MISMATCH: History knownAnchorSignature ('${options.historyResult.knownAnchorSignature}') does not match resolution knownAnchorSignature ('${options.resolutionResult.knownAnchorSignature}')`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (
    options.historyResult?.connectionEpoch !== undefined &&
    options.resolutionResult?.connectionEpoch !== undefined &&
    options.historyResult.connectionEpoch !== options.resolutionResult.connectionEpoch
  ) {
    return buildResult(
      "IDENTITY_MISMATCH",
      "COLLECTION_GAP",
      `IDENTITY_MISMATCH: History connectionEpoch (${options.historyResult.connectionEpoch}) does not match resolution connectionEpoch (${options.resolutionResult.connectionEpoch})`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (
    options.expectedConnectionEpoch !== undefined &&
    options.historyResult?.connectionEpoch !== undefined &&
    options.historyResult.connectionEpoch !== options.expectedConnectionEpoch
  ) {
    return buildResult(
      "IDENTITY_MISMATCH",
      "COLLECTION_GAP",
      `IDENTITY_MISMATCH: History connectionEpoch (${options.historyResult.connectionEpoch}) does not match expected operation epoch (${options.expectedConnectionEpoch})`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (
    options.expectedConnectionEpoch !== undefined &&
    options.resolutionResult?.connectionEpoch !== undefined &&
    options.resolutionResult.connectionEpoch !== options.expectedConnectionEpoch
  ) {
    return buildResult(
      "IDENTITY_MISMATCH",
      "COLLECTION_GAP",
      `IDENTITY_MISMATCH: Resolution connectionEpoch (${options.resolutionResult.connectionEpoch}) does not match expected operation epoch (${options.expectedConnectionEpoch})`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  if (pendingGeneratedInactivityGap !== null) {
    if (
      options.historyResult?.connectionEpoch === undefined ||
      !Number.isSafeInteger(options.historyResult.connectionEpoch) ||
      options.historyResult.connectionEpoch < 0
    ) {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        "IDENTITY_MISMATCH: PAPER quiet stream qualification requires historyResult with a valid non-negative connectionEpoch",
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
  }

  if (
    options.historyResult?.frozenTargetSignature &&
    options.resolutionResult?.frozenTargetSignature &&
    options.historyResult.frozenTargetSignature !== options.resolutionResult.frozenTargetSignature
  ) {
    return buildResult(
      "IDENTITY_MISMATCH",
      "COLLECTION_GAP",
      `IDENTITY_MISMATCH: History frozenTargetSignature ('${options.historyResult.frozenTargetSignature}') does not match resolution frozenTargetSignature ('${options.resolutionResult.frozenTargetSignature}')`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 10. Filter Signatures in Window & Validate Timestamps
  const signaturesInWindow: HistorySignatureRecord[] = [];
  let oldestSignatureBlockTimeMs: number | null = null;

  for (const rec of discoveredSignatures) {
    if (rec.blockTime === null || rec.blockTime === undefined || !Number.isFinite(rec.blockTime)) {
      // Ambiguous timestamp: cannot prove whether inside or outside window
      return buildResult(
        "AMBIGUOUS_TIMESTAMP",
        "COLLECTION_GAP",
        `AMBIGUOUS_TIMESTAMP: History record for signature '${rec.signature}' has null or missing blockTime`,
        { windowStartMs, windowEndMs, evidenceAgeMs, totalDiscovered: discoveredSignatures.length },
      );
    }

    const txTimeMs = rec.blockTime * 1000;
    if (oldestSignatureBlockTimeMs === null || txTimeMs < oldestSignatureBlockTimeMs) {
      oldestSignatureBlockTimeMs = txTimeMs;
    }
    if (txTimeMs >= windowStartMs && txTimeMs <= windowEndMs) {
      signaturesInWindow.push(rec);
    }
  }

  // Check Boundary Anchor Witnessing
  if (discoveredSignatures.length > 0 || options.historyResult) {
    const anchorWitnessed =
      options.historyResult?.anchorWitnessed ??
      (effectiveAnchorSig
        ? discoveredSignatures.some((s) => s.signature === effectiveAnchorSig)
        : false);

    const anchorRec =
      options.historyResult?.anchorRecord ??
      (effectiveAnchorSig
        ? discoveredSignatures.find((s) => s.signature === effectiveAnchorSig)
        : undefined);

    const anchorBlockTimeMs =
      anchorRec && typeof anchorRec.blockTime === "number" && Number.isFinite(anchorRec.blockTime)
        ? anchorRec.blockTime * 1000
        : null;

    const hasPriorBoundary =
      (anchorBlockTimeMs !== null && anchorBlockTimeMs <= windowStartMs) ||
      (oldestSignatureBlockTimeMs !== null && oldestSignatureBlockTimeMs <= windowStartMs);

    if (!anchorWitnessed || !hasPriorBoundary) {
      return buildResult(
        "UNWITNESSED_PRIOR_ANCHOR",
        "COLLECTION_GAP",
        `COLLECTION_GAP: History enumeration did not witness prior boundary anchor at or before window start (${windowStartMs} ms)`,
        { windowStartMs, windowEndMs, evidenceAgeMs, totalDiscovered: discoveredSignatures.length },
      );
    }
  }

  // 11. Normalize Evidence into Validated Per-Signature Map (Rejecting Contradictions & Overwriting)
  const resolutionRecordsMap = new Map<string, ResolvedSignatureRecord>();
  let hasContradictoryResolutionEvidence = false;
  let contradictoryEvidenceReason = "";

  const addResolutionRecord = (record: ResolvedSignatureRecord) => {
    if (!record || typeof record !== "object" || !record.signature) return;
    const sig = record.signature;
    const existing = resolutionRecordsMap.get(sig);
    if (existing) {
      const isContradictory =
        existing.status !== record.status ||
        existing.slot !== record.slot ||
        existing.blockTime !== record.blockTime ||
        existing.decodedEventsCount !== record.decodedEventsCount ||
        existing.ingestedEventsCount !== record.ingestedEventsCount;

      if (isContradictory) {
        hasContradictoryResolutionEvidence = true;
        contradictoryEvidenceReason = `Conflicting resolution records supplied for signature '${sig}' (${existing.status} vs ${record.status})`;
        // Failure must not disappear: preserve failure record
        const isExistingFailure =
          existing.status !== "RESOLVED" && existing.status !== "DUPLICATE_RESOLVED";
        const isIncomingFailure =
          record.status !== "RESOLVED" && record.status !== "DUPLICATE_RESOLVED";
        if (isIncomingFailure && !isExistingFailure) {
          resolutionRecordsMap.set(sig, record);
        }
        return;
      }
    }
    resolutionRecordsMap.set(sig, record);
  };

  if (options.resolutionResult) {
    for (const r of options.resolutionResult.perSignatureResults) {
      addResolutionRecord(r);
    }
  }
  if (options.resolvedSignatures) {
    for (const r of options.resolvedSignatures) {
      addResolutionRecord(r);
    }
  }

  if (hasContradictoryResolutionEvidence) {
    return buildResult(
      "UNRESOLVED_TRANSACTIONS",
      "COLLECTION_GAP",
      `CONTRADICTORY_EVIDENCE: ${contradictoryEvidenceReason}`,
      { windowStartMs, windowEndMs, evidenceAgeMs, unresolvedCount: 1 },
    );
  }

  // 12. Gather trade events from options.trades or read-only from options.tracker
  const candidateTrades: readonly TradeEvent[] =
    options.trades ??
    (options.tracker as unknown as { readonly events?: readonly TradeEvent[] })?.events ??
    [];

  const tradesBySignature = new Map<string, TradeEvent[]>();
  for (const t of candidateTrades) {
    if (!t || typeof t !== "object" || !t.signature) continue;
    const list = tradesBySignature.get(t.signature) ?? [];
    list.push(t);
    tradesBySignature.set(t.signature, list);
  }

  const alreadyResolvedSet = options.alreadyResolvedSignatures ?? new Set<string>();
  let incrementallyReusedCount = 0;
  const unresolvedSignatures: HistorySignatureRecord[] = [];
  const validatedEventsForWindow: TradeEvent[] = [];

  for (const sigRec of signaturesInWindow) {
    const sig = sigRec.signature;
    const resRecord = resolutionRecordsMap.get(sig);

    // CRITICAL: Explicit resolution evidence is MANDATORY for each in-window signature!
    // Event presence or alreadyResolvedSignatures membership alone cannot establish completeness.
    if (!resRecord) {
      unresolvedSignatures.push(sigRec);
      continue;
    }

    // 1. Explicit failure on resolution record takes precedence over optimistic flags or trade presence!
    if (resRecord.status !== "RESOLVED" && resRecord.status !== "DUPLICATE_RESOLVED") {
      return buildResult(
        "UNRESOLVED_TRANSACTIONS",
        "COLLECTION_GAP",
        `UNRESOLVED_TRANSACTIONS: Signature '${sig}' failed resolution with status '${resRecord.status}' (error: '${resRecord.error ?? "NONE"}')`,
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
          unresolvedCount: 1,
        },
      );
    }
    if (resRecord.slot !== sigRec.slot) {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        `IDENTITY_MISMATCH: Resolution record slot (${resRecord.slot}) does not match history record slot (${sigRec.slot}) for signature '${sig}'`,
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    if (resRecord.blockTime !== null && resRecord.blockTime !== sigRec.blockTime) {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        `IDENTITY_MISMATCH: Resolution record blockTime (${resRecord.blockTime}) does not match history record blockTime (${sigRec.blockTime}) for signature '${sig}'`,
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }

    // 2. Validate trade events for this signature
    const sigTrades = tradesBySignature.get(sig) ?? [];
    const validSigEvents: TradeEvent[] = [];
    const seenSigCanonicalKeys = new Set<string>();
    let hasInvalidEvent = false;
    let invalidEventReason = "";

    for (const t of sigTrades) {
      if (t.poolId !== options.poolContext.poolId) {
        hasInvalidEvent = true;
        invalidEventReason = `Trade poolId '${t.poolId}' does not match candidate poolId '${options.poolContext.poolId}'`;
        continue;
      }
      if (t.tokenMint !== options.poolContext.candidateTokenMint) {
        hasInvalidEvent = true;
        invalidEventReason = `Trade tokenMint '${t.tokenMint}' does not match candidate tokenMint '${options.poolContext.candidateTokenMint}'`;
        continue;
      }
      if (t.side !== "BUY" && t.side !== "SELL") {
        hasInvalidEvent = true;
        invalidEventReason = `Trade side '${String(t.side)}' is not BUY or SELL`;
        continue;
      }
      if (
        typeof t.eventTimestampMs !== "number" ||
        !Number.isFinite(t.eventTimestampMs) ||
        Number.isNaN(t.eventTimestampMs) ||
        !Number.isInteger(t.eventTimestampMs) ||
        t.eventTimestampMs <= 0
      ) {
        hasInvalidEvent = true;
        invalidEventReason = `Trade event timestamp is invalid: ${String(t.eventTimestampMs)}`;
        continue;
      }
      if (t.eventTimestampMs > options.decisionTimestampMs) {
        hasInvalidEvent = true;
        invalidEventReason = `Trade event timestamp (${t.eventTimestampMs} ms) is in the future relative to decision time (${options.decisionTimestampMs} ms)`;
        continue;
      }
      if (t.receiptTimestampMs !== undefined) {
        if (
          typeof t.receiptTimestampMs !== "number" ||
          !Number.isFinite(t.receiptTimestampMs) ||
          t.receiptTimestampMs > options.decisionTimestampMs
        ) {
          hasInvalidEvent = true;
          invalidEventReason = `Trade receipt timestamp (${String(t.receiptTimestampMs)} ms) is invalid or after decision time (${options.decisionTimestampMs} ms)`;
          continue;
        }
      }
      if (t.eventTimestampMs < windowStartMs || t.eventTimestampMs > windowEndMs) {
        continue;
      }

      const txBlockTimeSec = sigRec.blockTime!;
      const eventBlockTimeSec = Math.floor(t.eventTimestampMs / 1000);
      if (Math.abs(eventBlockTimeSec - txBlockTimeSec) > 1) {
        hasInvalidEvent = true;
        invalidEventReason = `Trade event timestamp (${t.eventTimestampMs} ms -> ${eventBlockTimeSec}s) is inconsistent with transaction blockTime (${txBlockTimeSec}s)`;
        continue;
      }

      if (t.slot !== undefined && t.slot !== sigRec.slot) {
        hasInvalidEvent = true;
        invalidEventReason = `Trade slot (${t.slot}) does not match transaction slot (${sigRec.slot})`;
        continue;
      }

      const key = deriveCanonicalSwapKey(t.signature, t.outerInstructionIndex ?? 0, t.swapIndex);
      if (seenSigCanonicalKeys.has(key)) {
        continue;
      }
      seenSigCanonicalKeys.add(key);
      validSigEvents.push(t);
    }

    // Filtering away invalid evidence must not manufacture verified zero activity
    if (hasInvalidEvent && validSigEvents.length === 0) {
      return buildResult(
        "INSUFFICIENT_DIRECTIONAL_EVIDENCE",
        "COLLECTION_GAP",
        `INSUFFICIENT_DIRECTIONAL_EVIDENCE: Signature '${sig}' supplied invalid trade evidence that was rejected (${invalidEventReason})`,
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
        },
      );
    }

    // 3. Completeness check between resolution record and directional trade events
    const expectedEventsCount = resRecord.decodedEventsCount;
    if (expectedEventsCount > 0) {
      if (validSigEvents.length !== expectedEventsCount) {
        return buildResult(
          "INSUFFICIENT_DIRECTIONAL_EVIDENCE",
          "COLLECTION_GAP",
          `INSUFFICIENT_DIRECTIONAL_EVIDENCE: Signature '${sig}' expected ${expectedEventsCount} decoded event(s) from resolution, but found ${validSigEvents.length} valid candidate-bound event(s)`,
          {
            windowStartMs,
            windowEndMs,
            evidenceAgeMs,
            totalDiscovered: discoveredSignatures.length,
            windowSignaturesCount: signaturesInWindow.length,
          },
        );
      }
    } else {
      // Genuinely zero relevant swaps for this pool
      if (validSigEvents.length > 0) {
        return buildResult(
          "INSUFFICIENT_DIRECTIONAL_EVIDENCE",
          "COLLECTION_GAP",
          `INSUFFICIENT_DIRECTIONAL_EVIDENCE: Signature '${sig}' reported 0 decoded events, but ${validSigEvents.length} trade event(s) were supplied`,
          { windowStartMs, windowEndMs, evidenceAgeMs },
        );
      }
    }

    if (alreadyResolvedSet.has(sig)) {
      incrementallyReusedCount++;
    }
    validatedEventsForWindow.push(...validSigEvents);
  }

  if (unresolvedSignatures.length > 0) {
    return buildResult(
      "UNRESOLVED_TRANSACTIONS",
      "COLLECTION_GAP",
      `UNRESOLVED_TRANSACTIONS: Discovered signature '${unresolvedSignatures[0]!.signature}' lacks validated resolution evidence`,
      {
        windowStartMs,
        windowEndMs,
        evidenceAgeMs,
        totalDiscovered: discoveredSignatures.length,
        windowSignaturesCount: signaturesInWindow.length,
        incrementallyReused: incrementallyReusedCount,
        unresolvedCount: unresolvedSignatures.length,
      },
    );
  }

  // 13. Directional Aggregation from Normalized Evidence Map
  let buys: number | null = null;
  let sells: number | null = null;
  let flowRatio: number | null = null;

  if (signaturesInWindow.length === 0) {
    // Verified Quiet Window
    buys = 0;
    sells = 0;
    flowRatio = 1.0;
  } else {
    let countedBuys = 0;
    let countedSells = 0;

    for (const t of validatedEventsForWindow) {
      if (t.side === "BUY") {
        countedBuys++;
      } else if (t.side === "SELL") {
        countedSells++;
      }
    }

    buys = countedBuys;
    sells = countedSells;
    flowRatio = sells === 0 ? (buys > 0 ? buys : 1.0) : Number((buys / sells).toFixed(2));
  }

  if (pendingGeneratedInactivityGap) {
    if (discoveredSignatures.length > 0 || signaturesInWindow.length > 0) {
      // Non-quiet: transactions existed on-chain that the stream missed! Fails closed to STREAM_GAP
      return buildResult(
        "STREAM_GAP",
        "COLLECTION_GAP",
        `COLLECTION_GAP: Stream inactivity accompanied by unobserved on-chain transactions (${discoveredSignatures.length} discovered since anchor, ${signaturesInWindow.length} in window)`,
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
        },
      );
    }

    const validatedEpoch =
      options.historyResult?.connectionEpoch ?? options.expectedConnectionEpoch ?? 0;

    const paperQualificationReason =
      "PAPER_QUIET_STREAM_QUALIFIED: zero stream notifications confirmed by complete RPC enumeration witnessing prior anchor under declared provider-relative assumptions (0 buys, 0 sells in 60s window)";

    return buildResult(
      "RECONCILED",
      "SUFFICIENT",
      `RECONCILED: Verified quiet window under declared provider-relative assumptions (0 buys, 0 sells in 60s window; ${paperQualificationReason})`,
      {
        windowStartMs,
        windowEndMs,
        evidenceAgeMs,
        buys: 0,
        sells: 0,
        flowRatio: 1.0,
        enumerationOutcome,
        resolutionOutcome: options.resolutionResult?.outcome,
        anchorWitnessed: true,
        knownAnchorSignature: effectiveAnchorSig,
        frozenTargetSignature:
          options.historyResult?.frozenTargetSignature ??
          options.resolutionResult?.frozenTargetSignature ??
          null,
        totalDiscovered: 0,
        totalResolved: 0,
        incrementallyReused: incrementallyReusedCount,
        windowSignaturesCount: 0,
        unresolvedCount: 0,
        paperQuietStreamQualified: true,
        paperQualificationReason,
        paperValidatedEpoch: validatedEpoch,
      },
    );
  }

  const diagReason =
    signaturesInWindow.length === 0
      ? "RECONCILED: Verified quiet window under declared provider-relative assumptions (0 buys, 0 sells in 60s window)"
      : `RECONCILED: All ${signaturesInWindow.length} transactions in window reconciled (${buys} buys, ${sells} sells; ${incrementallyReusedCount} incrementally reused)`;

  const anchorWitnessed =
    options.historyResult?.anchorWitnessed ??
    (effectiveAnchorSig
      ? discoveredSignatures.some((s) => s.signature === effectiveAnchorSig)
      : discoveredSignatures.length === 0);

  return buildResult("RECONCILED", "SUFFICIENT", diagReason, {
    windowStartMs,
    windowEndMs,
    evidenceAgeMs,
    buys,
    sells,
    flowRatio,
    enumerationOutcome,
    resolutionOutcome: options.resolutionResult?.outcome,
    anchorWitnessed,
    knownAnchorSignature: effectiveAnchorSig,
    frozenTargetSignature:
      options.historyResult?.frozenTargetSignature ??
      options.resolutionResult?.frozenTargetSignature ??
      null,
    totalDiscovered: discoveredSignatures.length,
    totalResolved:
      signaturesInWindow.length > 0
        ? (options.resolutionResult?.totalResolved ?? signaturesInWindow.length)
        : 0,
    incrementallyReused: incrementallyReusedCount,
    windowSignaturesCount: signaturesInWindow.length,
    unresolvedCount: 0,
  });
}

/**
 * Converts a WindowReconciliationResult into a CandidateFlowResult for evaluation.
 *
 * SAFETY INVARIANT:
 * In production mode (allowSyntheticCompletenessProofs: false), provider-relative reconciliation
 * evidence is NEVER promoted to SUFFICIENT flow counts. Counts strictly remain null and coverage
 * remains COLLECTION_GAP.
 */
export function toCandidateFlowResult(
  reconciliationResult: WindowReconciliationResult,
  options?: { readonly allowSyntheticCompletenessProofs?: boolean } | undefined,
): CandidateFlowResult {
  const targetPool = reconciliationResult.candidate.poolId;
  const targetMint = reconciliationResult.candidate.candidateTokenMint;
  const evaluationTimestampMs = reconciliationResult.temporalContext.decisionTimestampMs;

  const allowProofs = options?.allowSyntheticCompletenessProofs === true;

  if (!allowProofs) {
    // Production Mode: strictly return unavailable counts
    return Object.freeze({
      poolAddress: targetPool,
      tokenMint: targetMint,
      recentBuys60s: null,
      recentSells60s: null,
      flowCoverage: "COLLECTION_GAP",
      isCoverageSufficient: false,
      diagnosticReason:
        "PRODUCTION_COVERAGE_PROTECTED: Provider-relative reconciliation evidence is not promoted to production SUFFICIENT flow without operator review",
      evaluationTimestampMs,
    });
  }

  // Offline Synthetic Test Fixture Mode:
  if (reconciliationResult.status === "RECONCILED" && reconciliationResult.isCoverageSufficient) {
    return Object.freeze({
      poolAddress: targetPool,
      tokenMint: targetMint,
      recentBuys60s: reconciliationResult.flowCounts.recentBuys60s,
      recentSells60s: reconciliationResult.flowCounts.recentSells60s,
      flowCoverage: "SUFFICIENT",
      isCoverageSufficient: true,
      diagnosticReason: reconciliationResult.diagnosticReason,
      evaluationTimestampMs,
    });
  }

  return Object.freeze({
    poolAddress: targetPool,
    tokenMint: targetMint,
    recentBuys60s: null,
    recentSells60s: null,
    flowCoverage: reconciliationResult.flowCoverage,
    isCoverageSufficient: false,
    diagnosticReason: reconciliationResult.diagnosticReason,
    evaluationTimestampMs,
  });
}
