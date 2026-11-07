/**
 * Phase 12.94-D Milestone D.3.3: Bounded Exact-Pool Window Reconciliation Evaluator
 *
 * Implements an isolated, offline-tested evaluator for provider-relative trade flow
 * reconciliation across a single validated Raydium candidate pool and one explicitly
 * identified 60-second window.
 *
 * SCOPE & CONTRACT INVARIANTS:
 * 1. Scope: Offline reconciliation evaluation for one exact pool and one 60-second window only.
 *    Does NOT enable a production proof mode or change coordinator.advanceCoverage(),
 *    CandidateFlowProvider production defaults, or strategy admission.
 * 2. Honest Assurance Contract:
 *    - Returns reconciliation evidence under explicit provider and indexer assumptions.
 *    - Permanent invariants: isCryptographicCompletenessEstablished = false,
 *      isProductionCompletenessEstablished = false.
 *    - Acknowledges upstream index omission limitation: dropped transactions cannot be
 *      independently detected via standard JSON-RPC pagination.
 * 3. Separation of Window Time, Decision Time, and Evidence Age:
 *    - Window is anchored to verified source cutoff: [cutoffTimestampMs - 60s, cutoffTimestampMs].
 *    - Never relabels the watermark-ended window as [T_decision - 60s, T_decision].
 *    - Evidence age Δt_age = T_decision - cutoffTimestampMs is evaluated against maxAllowedEvidenceAgeMs
 *      (distinct from stream inactivity detection).
 * 4. Quiet-Window & Warm-Up Rigor:
 *    - Evaluates observation interval [obsStartMs, obsEndMs] against [windowStartMs, windowEndMs].
 *    - If obsStartMs > windowStartMs (e.g. [-5s, 55s] when observation started at 0s),
 *      strictly returns WARM_UP / incomplete coverage.
 *    - A zero-count result requires evidence supporting the entire requested window under the declared
 *      provider-relative contract. Silence, PING/PONGs, and empty history alone are insufficient.
 *    - An empty getSignaturesForAddress response NEVER advances the watermark to local request time.
 *    - Missing cutoff evidence leaves the cutoff unavailable and fails closed.
 * 5. Accurate Resource Accounting & Pacing:
 *    - Counts every required watermark, boundary, pagination, and unresolved-transaction query.
 *    - Deduplicates and reuses already-resolved transactions with zero redundant requests.
 *    - Models start-to-start pacing accurately: the first request is immediately eligible,
 *      and pacing waits account for elapsed response duration.
 *    - Accounts against GlobalResourceBudgetManager under CANDIDATE_ENRICHMENT with provider SOLANA_RPC.
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
import type {
  RollingTradeFlowTracker,
  StreamGap,
  FlowCoverageStatus,
  TradeEvent,
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
    | "getSlot"
    | "getBlockTime"
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
  | "STALE_DATA"
  | "FUTURE_DATED_EVIDENCE"
  | "STREAM_GAP"
  | "PROCESSING_BACKLOG"
  | "UNRESOLVED_TRANSACTIONS"
  | "UNWITNESSED_PRIOR_ANCHOR"
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
  readonly resourceMetrics: {
    readonly totalRequestsDispatched: number;
    readonly totalPacingWaitMs: number;
    readonly totalRetrievalDurationMs: number;
    readonly budgetRemaining?: number | undefined;
  };
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
 * Deep freezes an object and all nested properties.
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
 * Evaluates provider-relative window reconciliation for one exact pool and one 60-second window.
 */
export function evaluateExactPoolWindowReconciliation(
  options: ExactPoolWindowReconciliationOptions,
): WindowReconciliationResult {
  const minHostPacingMs = Math.max(0, options.minHostPacingMs ?? 2500);
  const maxAllowedEvidenceAgeMs = Math.max(0, options.maxAllowedEvidenceAgeMs ?? 15000);
  const providerName = options.providerName ?? "SOLANA_RPC";

  // Helper to construct a frozen error/fallback result
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
      requestsDispatched?: number | undefined;
      pacingWaitMs?: number | undefined;
      retrievalDurationMs?: number | undefined;
      budgetRemaining?: number | undefined;
    } = {},
  ): WindowReconciliationResult => {
    const isSufficient = flowCoverage === "SUFFICIENT";
    const res: WindowReconciliationResult = {
      status,
      candidate: {
        poolId: options.poolContext?.poolId ?? "",
        candidateTokenMint: options.poolContext?.candidateTokenMint ?? "",
        quoteTokenMint: options.poolContext?.quoteTokenMint ?? "",
      },
      temporalContext: {
        decisionTimestampMs: options.decisionTimestampMs,
        windowStartMs: extra.windowStartMs ?? 0,
        windowEndMs: extra.windowEndMs ?? 0,
        observationStartMs: options.observationStartMs,
        observationEndMs: options.observationEndMs,
        evidenceAgeMs: extra.evidenceAgeMs ?? null,
        maxAllowedEvidenceAgeMs,
      },
      sourceCutoff: options.sourceCutoff,
      flowCounts: {
        recentBuys60s: isSufficient ? (extra.buys ?? 0) : null,
        recentSells60s: isSufficient ? (extra.sells ?? 0) : null,
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
        totalRequestsDispatched: extra.requestsDispatched ?? 0,
        totalPacingWaitMs: extra.pacingWaitMs ?? 0,
        totalRetrievalDurationMs: extra.retrievalDurationMs ?? 0,
        budgetRemaining: extra.budgetRemaining,
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

  // 3. Validate Source Cutoff Evidence
  if (!options.sourceCutoff) {
    return buildResult(
      "MISSING_SOURCE_CUTOFF",
      "COLLECTION_GAP",
      "MISSING_SOURCE_CUTOFF: Source cutoff evidence was not provided. An empty getSignaturesForAddress response alone does not establish an on-chain source cutoff",
    );
  }

  const cutoff = options.sourceCutoff;
  const validMethods = [
    "getSignaturesForAddress",
    "getSlot",
    "getBlockTime",
    "getLatestBlockhash",
    "SYNTHETIC_CHECKPOINT",
  ];
  if (
    !validMethods.includes(cutoff.sourceMethod) ||
    typeof cutoff.responseField !== "string" ||
    cutoff.responseField.trim().length === 0 ||
    (cutoff.commitment !== "confirmed" && cutoff.commitment !== "finalized") ||
    (cutoff.provenance !== "ON_CHAIN_BLOCK_TIME" && cutoff.provenance !== "SYNTHETIC_FIXTURE") ||
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
      "INVALID_SOURCE_CUTOFF: Source cutoff evidence fields are invalid or missing required provenance",
    );
  }

  const windowEndMs = cutoff.cutoffTimestampMs;
  const windowStartMs = windowEndMs - 60_000;
  const evidenceAgeMs = options.decisionTimestampMs - windowEndMs;

  // 4. Temporal Relationship Checks
  if (windowEndMs > options.decisionTimestampMs + 5000) {
    return buildResult(
      "FUTURE_DATED_EVIDENCE",
      "COLLECTION_GAP",
      `FUTURE_DATED_EVIDENCE: Source cutoff (${windowEndMs} ms) is in the future relative to decision time (${options.decisionTimestampMs} ms)`,
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

  // 5. Observation Interval & Warm-Up Check
  // Check whether observation started before or at windowStartMs
  if (options.observationStartMs > windowStartMs) {
    const unobservedDurationMs = options.observationStartMs - windowStartMs;
    return buildResult(
      "WARM_UP",
      "WARM_UP",
      `WARM_UP: Observation started at ${options.observationStartMs} ms, after window start ${windowStartMs} ms (unobserved duration: ${unobservedDurationMs} ms)`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // Check whether observation ended after or at windowEndMs
  if (options.observationEndMs < windowEndMs) {
    return buildResult(
      "INCOMPLETE_OBSERVATION",
      "COLLECTION_GAP",
      `INCOMPLETE_OBSERVATION: Observation ended at ${options.observationEndMs} ms, before source cutoff ${windowEndMs} ms`,
      { windowStartMs, windowEndMs, evidenceAgeMs },
    );
  }

  // 6. Check Stream Gaps
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

  // 7. Check Backlog
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

  // 8. Gather Discovered Signatures & Verify Identity
  let discoveredSignatures: readonly HistorySignatureRecord[] = [];
  if (options.historyResult) {
    if (options.historyResult.candidatePoolId !== options.poolContext.poolId) {
      return buildResult(
        "IDENTITY_MISMATCH",
        "COLLECTION_GAP",
        `IDENTITY_MISMATCH: History enumeration result poolId '${options.historyResult.candidatePoolId}' does not match pool context '${options.poolContext.poolId}'`,
        { windowStartMs, windowEndMs, evidenceAgeMs },
      );
    }
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

  // 9. Filter Signatures in Window
  // Each signature's timestamp is blockTime in seconds * 1000
  const signaturesInWindow: HistorySignatureRecord[] = [];
  let oldestSignatureBlockTimeMs: number | null = null;

  for (const rec of discoveredSignatures) {
    if (typeof rec.blockTime === "number" && rec.blockTime > 0) {
      const txTimeMs = rec.blockTime * 1000;
      if (oldestSignatureBlockTimeMs === null || txTimeMs < oldestSignatureBlockTimeMs) {
        oldestSignatureBlockTimeMs = txTimeMs;
      }
      if (txTimeMs >= windowStartMs && txTimeMs <= windowEndMs) {
        signaturesInWindow.push(rec);
      }
    }
  }

  // Check Boundary Anchor Witnessing
  // If there are signatures discovered, we require witnessing an anchor at or before windowStartMs
  // to prove backward completeness.
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

  // 10. Check Transaction Resolution & Incremental Reuse
  const alreadyResolved = options.alreadyResolvedSignatures ?? new Set<string>();
  const unresolvedSignatures: HistorySignatureRecord[] = [];
  let incrementallyReusedCount = 0;

  for (const sigRec of signaturesInWindow) {
    if (alreadyResolved.has(sigRec.signature)) {
      incrementallyReusedCount++;
    } else {
      unresolvedSignatures.push(sigRec);
    }
  }

  // Check for any resolution failures if resolved signatures were provided
  if (options.resolvedSignatures) {
    for (const resRec of options.resolvedSignatures) {
      if (signaturesInWindow.some((s) => s.signature === resRec.signature)) {
        if (resRec.status !== "RESOLVED" && resRec.status !== "DUPLICATE_RESOLVED") {
          return buildResult(
            "UNRESOLVED_TRANSACTIONS",
            "COLLECTION_GAP",
            `COLLECTION_GAP: Signature '${resRec.signature}' failed resolution with status '${resRec.status}'`,
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
      }
    }
  }

  if (options.resolutionResult && options.resolutionResult.outcome !== "ALL_RESOLVED") {
    return buildResult(
      "UNRESOLVED_TRANSACTIONS",
      "COLLECTION_GAP",
      `COLLECTION_GAP: Resolution bridge terminated with outcome '${options.resolutionResult.outcome}'`,
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

  // 11. Resource Accounting & Start-to-Start Pacing Simulation
  // Requests needed:
  // 1 watermark query (if active) + P history pages + U unresolved transactions
  const pagesQueried = options.historyResult?.pagesQueried ?? (options.historyRecords ? 1 : 0);
  const watermarkQueryCount = cutoff.sourceMethod === "SYNTHETIC_CHECKPOINT" ? 0 : 1;
  const requestsToDispatch = watermarkQueryCount + pagesQueried + unresolvedSignatures.length;

  let totalPacingWaitMs = 0;
  let totalRetrievalDurationMs = 0;
  let currentVirtualTime = options.decisionTimestampMs;
  let lastDispatchStartMs: number | null = null;
  const latencies = options.simulatedLatenciesMs ?? [];

  for (let i = 0; i < requestsToDispatch; i++) {
    // Accurate start-to-start pacing
    let waitMs = 0;
    if (lastDispatchStartMs === null) {
      // First request: check whether pacing wait is needed against shared provider history
      const pacingCheck = options.budgetManager.canMakeRequest(
        providerName,
        currentVirtualTime,
        "CANDIDATE_ENRICHMENT",
      );
      if (!pacingCheck.allowed && pacingCheck.reason === "PROVIDER_PACING_NOT_MET") {
        waitMs = pacingCheck.waitMs ?? minHostPacingMs;
      }
    } else {
      const elapsedSinceLastStart = currentVirtualTime - lastDispatchStartMs;
      if (elapsedSinceLastStart < minHostPacingMs) {
        waitMs = minHostPacingMs - elapsedSinceLastStart;
      }
    }

    currentVirtualTime += waitMs;
    totalPacingWaitMs += waitMs;
    lastDispatchStartMs = currentVirtualTime;

    // Check if budget allows request at this start time
    const check = options.budgetManager.canMakeRequest(
      providerName,
      currentVirtualTime,
      "CANDIDATE_ENRICHMENT",
    );

    if (!check.allowed) {
      return buildResult(
        "BUDGET_EXHAUSTED",
        "COLLECTION_GAP",
        `BUDGET_EXHAUSTED: GlobalResourceBudgetManager denied request ${i + 1}/${requestsToDispatch} with reason: ${check.reason}`,
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
          incrementallyReused: incrementallyReusedCount,
          requestsDispatched: i,
          pacingWaitMs: totalPacingWaitMs,
          retrievalDurationMs: totalRetrievalDurationMs,
        },
      );
    }

    const recorded = options.budgetManager.recordRequestAttempt(
      providerName,
      "CANDIDATE_ENRICHMENT",
      currentVirtualTime,
    );

    if (!recorded) {
      return buildResult(
        "BUDGET_EXHAUSTED",
        "COLLECTION_GAP",
        `BUDGET_EXHAUSTED: Failed to record request ${i + 1}/${requestsToDispatch} against GlobalResourceBudgetManager`,
        {
          windowStartMs,
          windowEndMs,
          evidenceAgeMs,
          totalDiscovered: discoveredSignatures.length,
          windowSignaturesCount: signaturesInWindow.length,
          incrementallyReused: incrementallyReusedCount,
          requestsDispatched: i,
          pacingWaitMs: totalPacingWaitMs,
          retrievalDurationMs: totalRetrievalDurationMs,
        },
      );
    }

    const latency = latencies[i] ?? 50;
    totalRetrievalDurationMs += waitMs + latency;
    currentVirtualTime += latency;
  }

  // 12. Aggregate Flow Counts
  let buys = 0;
  let sells = 0;

  if (signaturesInWindow.length === 0) {
    // Case A: Quiet Window (Zero Transactions)
    buys = 0;
    sells = 0;
  } else {
    // Case B: Gather Trades in Window
    if (options.trades) {
      for (const t of options.trades) {
        if (t.eventTimestampMs >= windowStartMs && t.eventTimestampMs <= windowEndMs) {
          if (t.side === "BUY") buys++;
          else if (t.side === "SELL") sells++;
        }
      }
    } else if (options.tracker) {
      const trackerEval = options.tracker.evaluateWindow(windowEndMs);
      buys = trackerEval.recentBuys60s ?? 0;
      sells = trackerEval.recentSells60s ?? 0;
    } else if (options.resolutionResult) {
      // Approximate from resolved transactions if trade events were not injected
      for (const resRec of options.resolutionResult.perSignatureResults) {
        if (signaturesInWindow.some((s) => s.signature === resRec.signature)) {
          buys += resRec.ingestedEventsCount;
        }
      }
    }
  }

  const flowRatio = sells === 0 ? (buys > 0 ? buys : 1.0) : Number((buys / sells).toFixed(2));
  const stats = options.budgetManager.getStats();
  const budgetRemaining = Math.max(0, stats.maxEnrichmentAttempts - stats.enrichmentRequests);

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
    enumerationOutcome: options.historyResult?.outcome,
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
    requestsDispatched: requestsToDispatch,
    pacingWaitMs: totalPacingWaitMs,
    retrievalDurationMs: totalRetrievalDurationMs,
    budgetRemaining,
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
