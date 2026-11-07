/**
 * Phase 12.94-D Milestone D.3.3: Bounded Exact-Pool Window Reconciliation Evaluator
 *
 * Implements an isolated, non-mutating, offline-tested evaluator for provider-relative
 * trade flow reconciliation across a single validated Raydium candidate pool and one
 * explicitly identified 60-second window.
 *
 * OPERATIONAL & SAFETY INVARIANTS (Audit-Hardened V2):
 * 1. Scope: Offline reconciliation evaluation for one exact pool and one 60-second window only.
 *    Does NOT enable a production proof mode or modify coordinator.advanceCoverage(),
 *    CandidateFlowProvider production defaults, or strategy admission.
 * 2. Honest Assurance Contract:
 *    - Returns reconciliation evidence under explicit provider and indexer assumptions.
 *    - Permanent invariants: isCryptographicCompletenessEstablished = false,
 *      isProductionCompletenessEstablished = false.
 *    - Acknowledges upstream index omission limitation: dropped intermediate transactions
 *      cannot be independently detected via standard JSON-RPC pagination.
 * 3. Strict Evidence Presence & Accounting:
 *    - Missing history evidence must remain unavailable; empty history cannot be assumed.
 *    - Every signature discovered in the window requires validated resolution evidence.
 *    - Signatures with ambiguous (null/missing) blockTime fail closed unless proven outside the window.
 *    - Incremental reuse requires supporting resolution/event records, not bare Set membership.
 * 4. Validated Directional Event Counting:
 *    - Trade events must be candidate-bound (exact poolId and candidateTokenMint match).
 *    - Events must belong to validated, resolved signatures within the window.
 *    - Events are deduplicated by canonical swap key (${signature}:${outerInstructionIndex}:${swapIndex}).
 *    - Approximation from non-directional event counts is prohibited. If directional evidence
 *      is missing, counts remain null.
 * 5. Cutoff Provenance & Causal Time Ordering:
 *    - Cutoff sourceMethod must provide on-chain timestamps for ON_CHAIN_BLOCK_TIME (e.g. getSignaturesForAddress,
 *      getBlockTime, getBlock). Methods returning slot numbers (e.g. getSlot) are rejected.
 *    - Synthetic checkpoints are strictly isolated under SYNTHETIC_FIXTURE provenance.
 *    - Strict causality: cutoffTimestampMs, retrievedAtMs, and observationEndMs must NOT exceed decisionTimestampMs.
 *      Zero future look-ahead allowance.
 * 6. Non-Mutating Accounting & Input Snapshotting:
 *    - Evaluation never mutates the caller's budget manager or charges projected requests.
 *    - Actual requests from acquisition receipts are reported separately from projected demand.
 *    - Caller inputs (sourceCutoff, poolContext) are snapshotted before freezing, leaving caller objects unfrozen.
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
 * Verified on-chain source cutoff evidence.
 * Explicitly specifies source method, response field, commitment, and provenance.
 */
export interface SourceCutoffEvidence {
  readonly sourceMethod:
    | "getSignaturesForAddress"
    | "getBlockTime"
    | "getBlock"
    | "getLatestBlockhash"
    | "SYNTHETIC_CHECKPOINT";
  readonly responseField: string;
  readonly commitment: "confirmed" | "finalized";
  readonly provenance: "ON_CHAIN_BLOCK_TIME" | "SYNTHETIC_FIXTURE";
  readonly slot: number;
  readonly cutoffTimestampMs: number;
  readonly retrievedAtMs: number;
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
  readonly actualRequestsDispatched: number;
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
    readonly windowSignaturesCount: number;
  };
  readonly resourceMetrics: ResourceAccountingMetrics;
  readonly providerAssumptions: readonly string[];
  readonly unresolvedUncertainties: readonly string[];
  readonly diagnosticReason: string;
  readonly isCryptographicCompletenessEstablished: false;
  readonly isProductionCompletenessEstablished: false;
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
  readonly clock?: (() => number) | undefined;
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
function cloneSourceCutoff(cutoff: SourceCutoffEvidence | null): SourceCutoffEvidence | null {
  if (!cutoff) return null;
  return {
    sourceMethod: cutoff.sourceMethod,
    responseField: cutoff.responseField,
    commitment: cutoff.commitment,
    provenance: cutoff.provenance,
    slot: cutoff.slot,
    cutoffTimestampMs: cutoff.cutoffTimestampMs,
    retrievedAtMs: cutoff.retrievedAtMs,
  };
}

/**
 * Evaluates provider-relative window reconciliation for one exact pool and one 60-second window.
 * Non-mutating: does not dispatch requests, mutate budget manager state, or freeze caller objects.
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
      windowSignaturesCount?: number | undefined;
      actualRequestsDispatched?: number | undefined;
      projectedDemand?: ProjectedDemandMetrics | undefined;
      budgetRemaining?: number | undefined;
    } = {},
  ): WindowReconciliationResult => {
    const isSufficient = flowCoverage === "SUFFICIENT";
    const defaultProjectedDemand: ProjectedDemandMetrics = {
      watermarkRequests: 0,
      paginationRequests: 0,
      unresolvedTransactionRequests: 0,
      totalProjectedRequests: 0,
      projectedPacingWaitMs: 0,
      projectedRetrievalDurationMs: 0,
      isProjectedBudgetSufficient: true,
    };

    const budgetStats = options.budgetManager?.getStats?.();
    const remainingEnrichment = budgetStats
      ? Math.max(0, budgetStats.maxEnrichmentAttempts - budgetStats.enrichmentRequests)
      : 0;

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
        windowSignaturesCount: extra.windowSignaturesCount ?? 0,
      },
      resourceMetrics: {
        actualRequestsDispatched: extra.actualRequestsDispatched ?? 0,
        projectedDemand: extra.projectedDemand ?? defaultProjectedDemand,
        budgetRemaining: extra.budgetRemaining ?? remainingEnrichment,
      },
      providerAssumptions: DEFAULT_PROVIDER_INDEX_ASSUMPTIONS,
      unresolvedUncertainties: DEFAULT_UNRESOLVED_UNCERTAINTIES,
      diagnosticReason,
      isCryptographicCompletenessEstablished: false,
      isProductionCompletenessEstablished: false,
    };
    return deepFreeze(res);
  };

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

  // Validate Provenance and Method Correspondence
  if (cutoff.provenance === "ON_CHAIN_BLOCK_TIME") {
    // getSlot returns a slot number, not a timestamp!
    if (
      cutoff.sourceMethod !== "getSignaturesForAddress" &&
      cutoff.sourceMethod !== "getBlockTime" &&
      cutoff.sourceMethod !== "getBlock"
    ) {
      return buildResult(
        "INVALID_SOURCE_CUTOFF",
        "COLLECTION_GAP",
        `INVALID_SOURCE_CUTOFF: ON_CHAIN_BLOCK_TIME provenance requires a method providing blockTime (getSignaturesForAddress, getBlockTime, getBlock), received: '${cutoff.sourceMethod}'`,
      );
    }
  } else if (cutoff.provenance === "SYNTHETIC_FIXTURE") {
    if (cutoff.sourceMethod !== "SYNTHETIC_CHECKPOINT") {
      return buildResult(
        "INVALID_SOURCE_CUTOFF",
        "COLLECTION_GAP",
        `INVALID_SOURCE_CUTOFF: SYNTHETIC_FIXTURE provenance requires SYNTHETIC_CHECKPOINT sourceMethod, received: '${cutoff.sourceMethod}'`,
      );
    }
  } else {
    return buildResult(
      "INVALID_SOURCE_CUTOFF",
      "COLLECTION_GAP",
      `INVALID_SOURCE_CUTOFF: Unsupported provenance: '${String((cutoff as unknown as Record<string, unknown>).provenance)}'`,
    );
  }

  if (
    typeof cutoff.responseField !== "string" ||
    cutoff.responseField.trim().length === 0 ||
    (cutoff.commitment !== "confirmed" && cutoff.commitment !== "finalized") ||
    typeof cutoff.slot !== "number" ||
    !Number.isFinite(cutoff.slot) ||
    !Number.isInteger(cutoff.slot) ||
    cutoff.slot < 0 ||
    typeof cutoff.cutoffTimestampMs !== "number" ||
    !Number.isFinite(cutoff.cutoffTimestampMs) ||
    !Number.isInteger(cutoff.cutoffTimestampMs) ||
    cutoff.cutoffTimestampMs <= 0 ||
    typeof cutoff.retrievedAtMs !== "number" ||
    !Number.isFinite(cutoff.retrievedAtMs) ||
    !Number.isInteger(cutoff.retrievedAtMs) ||
    cutoff.retrievedAtMs <= 0
  ) {
    return buildResult(
      "INVALID_SOURCE_CUTOFF",
      "COLLECTION_GAP",
      "INVALID_SOURCE_CUTOFF: Source cutoff evidence fields are invalid or missing required telemetry",
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

  // 5. Check Stream Gaps
  const gaps: StreamGap[] = [];
  if (options.recordedGaps) {
    gaps.push(...options.recordedGaps);
  }
  if (options.tracker) {
    gaps.push(...options.tracker.getRecordedGaps());
  }

  for (const gap of gaps) {
    if (gap.gapStartMs < windowEndMs && gap.gapEndMs > windowStartMs) {
      return buildResult(
        "STREAM_GAP",
        "COLLECTION_GAP",
        `COLLECTION_GAP: Stream gap witnessed in observation window [${gap.gapStartMs}, ${gap.gapEndMs}] (reason: ${gap.reason ?? "UNSPECIFIED"})`,
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
  }

  // 6. Check Backlog
  const hasBacklog =
    options.hasActiveBacklog === true ||
    (options.tracker &&
      options.tracker.evaluateWindow(options.decisionTimestampMs).diagnostics.hasActiveBacklog);

  if (hasBacklog) {
    return buildResult(
      "PROCESSING_BACKLOG",
      "PROCESSING_BACKLOG",
      "PROCESSING_BACKLOG: Active transaction queue backlog present at evaluation time",
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 7. Validate History Evidence Presence
  if (!options.historyResult && !options.historyRecords) {
    return buildResult(
      "MISSING_HISTORY_EVIDENCE",
      "COLLECTION_GAP",
      "MISSING_HISTORY_EVIDENCE: No history enumeration evidence was supplied. History evidence cannot be inferred or assumed empty",
      { windowStartMs, windowEndMs, evidenceAgeMs },
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
    if (options.historyResult.outcome === "BUDGET_EXHAUSTED") {
      return buildResult(
        "BUDGET_EXHAUSTED",
        "COLLECTION_GAP",
        "BUDGET_EXHAUSTED: History enumeration halted due to budget quota exhaustion",
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
    discoveredSignatures = options.historyResult.discoveredSignatures ?? [];
  } else if (options.historyRecords) {
    discoveredSignatures = options.historyRecords;
  }

  // 8. Filter Signatures in Window & Validate Timestamps
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
  if (discoveredSignatures.length > 0) {
    const anchorWitnessed =
      options.historyResult?.anchorWitnessed ??
      (options.knownAnchorSignature
        ? discoveredSignatures.some((s) => s.signature === options.knownAnchorSignature)
        : false);

    const hasPriorBoundary =
      oldestSignatureBlockTimeMs !== null && oldestSignatureBlockTimeMs <= windowStartMs;

    if (!anchorWitnessed && !hasPriorBoundary) {
      return buildResult(
        "UNWITNESSED_PRIOR_ANCHOR",
        "COLLECTION_GAP",
        `COLLECTION_GAP: History enumeration did not witness prior boundary anchor at or before window start (${windowStartMs} ms)`,
        { windowStartMs, windowEndMs, evidenceAgeMs, totalDiscovered: discoveredSignatures.length },
      );
    }
  }

  // 9. Check Transaction Resolution & Incremental Reuse
  // Map resolution status from resolution records or trade events
  const resolvedSignaturesMap = new Map<string, ResolvedSignatureRecord>();
  if (options.resolvedSignatures) {
    for (const r of options.resolvedSignatures) {
      resolvedSignaturesMap.set(r.signature, r);
    }
  }
  if (options.resolutionResult) {
    for (const r of options.resolutionResult.perSignatureResults) {
      resolvedSignaturesMap.set(r.signature, r);
    }
  }

  const tradesBySignature = new Set<string>();
  if (options.trades) {
    for (const t of options.trades) {
      tradesBySignature.add(t.signature);
    }
  }

  const alreadyResolvedSet = options.alreadyResolvedSignatures ?? new Set<string>();
  let incrementallyReusedCount = 0;
  const unresolvedSignatures: HistorySignatureRecord[] = [];

  for (const sigRec of signaturesInWindow) {
    const resRecord = resolvedSignaturesMap.get(sigRec.signature);
    const hasTradeRecord = tradesBySignature.has(sigRec.signature);

    // Incremental reuse check: membership in alreadyResolvedSignatures requires supporting resolution or trade record
    if (alreadyResolvedSet.has(sigRec.signature)) {
      if (
        (resRecord &&
          (resRecord.status === "RESOLVED" || resRecord.status === "DUPLICATE_RESOLVED")) ||
        hasTradeRecord
      ) {
        incrementallyReusedCount++;
        continue;
      }
      // Bare Set membership without resolution record fails closed as unresolved!
      unresolvedSignatures.push(sigRec);
      continue;
    }

    if (resRecord) {
      if (resRecord.status === "RESOLVED" || resRecord.status === "DUPLICATE_RESOLVED") {
        continue;
      }
      // Explicit failure status on resolution record
      return buildResult(
        "UNRESOLVED_TRANSACTIONS",
        "COLLECTION_GAP",
        `COLLECTION_GAP: Signature '${sigRec.signature}' failed resolution with status '${resRecord.status}'`,
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
        },
      );
    }

    // Has trade record?
    if (hasTradeRecord) {
      continue;
    }

    // Discovered transaction with no resolution evidence
    unresolvedSignatures.push(sigRec);
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
      },
    );
  }

  // 10. Actual Requests vs Projected Demand (Non-Mutating)
  const actualRequestsDispatched =
    (options.historyResult?.requestCount ?? (options.historyRecords ? 1 : 0)) +
    (options.resolutionResult?.totalProcessed ??
      (options.resolvedSignatures ? options.resolvedSignatures.length : 0));

  const budgetStats = options.budgetManager.getStats();
  const remainingBudget = Math.max(
    0,
    budgetStats.maxEnrichmentAttempts - budgetStats.enrichmentRequests,
  );

  // Projected demand for any unexecuted operations
  const projectedWatermark = cutoff.sourceMethod === "SYNTHETIC_CHECKPOINT" ? 0 : 0;
  const projectedPagination = 0;
  const projectedUnresolved = unresolvedSignatures.length;
  const totalProjected = projectedWatermark + projectedPagination + projectedUnresolved;

  const latencies = options.simulatedLatenciesMs ?? [];
  let projectedPacingWaitMs = 0;
  let projectedDurationMs = 0;
  for (let i = 0; i < totalProjected; i++) {
    const wait = i === 0 ? 0 : minHostPacingMs;
    const lat = latencies[i] ?? 50;
    projectedPacingWaitMs += wait;
    projectedDurationMs += wait + lat;
  }

  const projectedDemand: ProjectedDemandMetrics = {
    watermarkRequests: projectedWatermark,
    paginationRequests: projectedPagination,
    unresolvedTransactionRequests: projectedUnresolved,
    totalProjectedRequests: totalProjected,
    projectedPacingWaitMs,
    projectedRetrievalDurationMs: projectedDurationMs,
    isProjectedBudgetSufficient:
      totalProjected <= remainingBudget && !budgetStats.isStopTriggered429,
  };

  // 11. Directional Trade Event Validation & Counting
  let buys: number | null = null;
  let sells: number | null = null;
  let flowRatio: number | null = null;

  if (signaturesInWindow.length === 0) {
    // Verified Quiet Window
    buys = 0;
    sells = 0;
    flowRatio = 1.0;
  } else {
    // Active Window: Must count validated, candidate-bound, deduplicated directional events
    if (options.trades && options.trades.length > 0) {
      let countedBuys = 0;
      let countedSells = 0;
      const seenCanonicalKeys = new Set<string>();

      for (const t of options.trades) {
        // 1. Candidate Binding Validation
        if (t.poolId !== options.poolContext.poolId) {
          continue; // Trade from another pool
        }
        if (t.tokenMint !== options.poolContext.candidateTokenMint) {
          continue; // Trade for another token mint
        }

        // 2. Signature Membership Validation
        if (!signaturesInWindow.some((s) => s.signature === t.signature)) {
          continue; // Unrelated signature not discovered in window
        }

        // 3. Window Timestamp Validation
        if (t.eventTimestampMs < windowStartMs || t.eventTimestampMs > windowEndMs) {
          continue; // Outside window
        }

        // 4. Canonical Swap Identity Deduplication
        const canonicalKey = deriveCanonicalSwapKey(
          t.signature,
          t.outerInstructionIndex ?? 0,
          t.swapIndex,
        );
        if (seenCanonicalKeys.has(canonicalKey)) {
          continue; // Duplicate event!
        }
        seenCanonicalKeys.add(canonicalKey);

        // 5. Directional Counting
        if (t.side === "BUY") {
          countedBuys++;
        } else if (t.side === "SELL") {
          countedSells++;
        }
      }

      buys = countedBuys;
      sells = countedSells;
      flowRatio = sells === 0 ? (buys > 0 ? buys : 1.0) : Number((buys / sells).toFixed(2));
    } else if (options.tracker) {
      const trackerEval = options.tracker.evaluateWindow(windowEndMs);
      if (
        trackerEval.isCoverageSufficient &&
        trackerEval.recentBuys60s !== null &&
        trackerEval.recentSells60s !== null
      ) {
        buys = trackerEval.recentBuys60s;
        sells = trackerEval.recentSells60s;
        flowRatio = trackerEval.flowRatio;
      } else {
        // Tracker counts unavailable: keep null, DO NOT convert to 0
        return buildResult(
          "INSUFFICIENT_DIRECTIONAL_EVIDENCE",
          trackerEval.coverage,
          "INSUFFICIENT_DIRECTIONAL_EVIDENCE: Tracker reported non-sufficient coverage or null counts",
          {
            windowStartMs,
            windowEndMs,
            evidenceAgeMs,
            totalDiscovered: discoveredSignatures.length,
            windowSignaturesCount: signaturesInWindow.length,
            actualRequestsDispatched,
            projectedDemand,
            budgetRemaining: remainingBudget,
          },
        );
      }
    } else {
      // Discovered transactions in window, but no directional trade events provided!
      return buildResult(
        "INSUFFICIENT_DIRECTIONAL_EVIDENCE",
        "COLLECTION_GAP",
        "INSUFFICIENT_DIRECTIONAL_EVIDENCE: Directional swap events (buys/sells) were not supplied for resolved transactions in window",
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
          actualRequestsDispatched,
          projectedDemand,
          budgetRemaining: remainingBudget,
        },
      );
    }
  }

  const diagReason =
    signaturesInWindow.length === 0
      ? "RECONCILED: Verified quiet window under declared provider-relative assumptions (0 buys, 0 sells in 60s window)"
      : `RECONCILED: All ${signaturesInWindow.length} transactions in window reconciled (${buys} buys, ${sells} sells; ${incrementallyReusedCount} incrementally reused)`;

  const anchorWitnessed =
    options.historyResult?.anchorWitnessed ??
    (options.knownAnchorSignature
      ? discoveredSignatures.some((s) => s.signature === options.knownAnchorSignature)
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
    knownAnchorSignature:
      options.knownAnchorSignature ??
      options.historyResult?.knownAnchorSignature ??
      options.resolutionResult?.knownAnchorSignature ??
      null,
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
    actualRequestsDispatched,
    projectedDemand,
    budgetRemaining: remainingBudget,
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
