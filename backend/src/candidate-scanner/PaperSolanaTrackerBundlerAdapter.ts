/**
 * Phase 12.94-D: Isolated Offline PAPER Solana Tracker Bundler Proxy Adapter
 *
 * Side-effect-free adapter bridging parsed Solana Tracker bundler snapshots
 * (`SolanaTrackerBundlerSnapshot`) to Gate 11 candidate evaluation exclusively
 * in offline PAPER_SIMULATION or BACKTEST execution contexts.
 *
 * ARCHITECTURAL CONTRACT & SAFETY INVARIANTS:
 * 1. Strict Execution Boundary:
 *    - Explicitly requires `executionContext: "PAPER_SIMULATION" | "BACKTEST"`.
 *    - Production or undefined contexts are rejected fail-closed (`EXECUTION_CONTEXT_PROHIBITED`)
 *      with `bundlerPct: undefined`.
 *    - No automatic environment-based enablement; default runtime remains quarantined.
 * 2. Launch-Allocation Metric Integrity:
 *    - Maps ONLY valid, normalized `initialPct` ($[0.0, 1.0]$) to `bundlerPct`.
 *    - Requires both raw percentages ($[0, 100]$) and normalized fractions ($[0.0, 1.0]$) to be finite,
 *      non-negative, and strictly in exact agreement (`normalized === raw / 100`) without epsilon or rounding.
 *    - Rejects contradictory, missing, or malformed values fail-closed (`CONTRADICTORY_METRIC_VALUES`,
 *      `MALFORMED_REQUIRED_METRICS`). Does NOT reconstruct raw provider fields from normalized fractions.
 *    - Preserves `currentHoldingPct` separately; NEVER substitutes current holdings for initial allocation.
 *    - Never replaces missing or invalid current holdings with zero. Preserves genuine reported zero.
 * 3. Exact Identity Binding:
 *    - Binds token-level evidence strictly to the requested canonical base58 token mint.
 *    - Rejects mint mismatches fail-closed (`IDENTITY_MISMATCH`).
 *    - Does NOT fabricate pool-specific provenance for token-level evidence.
 * 4. Retrieval Freshness & Causality:
 *    - Validates safe non-negative integer `evaluationTimeMs` and `localRetrievedAtMs`.
 *    - Enforces temporal causality: `evaluationTimeMs >= localRetrievedAtMs`. Future-dated evidence
 *      fails closed (`FUTURE_DATED_EVIDENCE`).
 *    - Enforces local retrieval age limit: `evaluationTimeMs - localRetrievedAtMs <= maxAllowedRetrievalAgeMs`.
 *      Stale evidence fails closed (`STALE_RETRIEVAL_EVIDENCE`).
 *    - Note on Freshness: This measures client-side local retrieval freshness only; upstream provider
 *      measurement age remains null when unknown. Historical captures support dated replay only.
 * 5. Full Provenance Disclosure & Contract Validation:
 *    - Validates consumed provenance fields against the parsed-snapshot contract, including source
 *      classification (`PROVIDER_REPORTED_UNVERIFIED`) and `totalBundlersCount`.
 *    - Preserves provider identity ("SOLANA_TRACKER"), mint, timestamps, raw percentages, and
 *      normalized fractions under policy classification `PAPER_PROXY_UNVERIFIED_LAUNCH_ALLOCATION`.
 *    - Explicitly flags detection accuracy, deployer attribution, Jito equivalence, and historical
 *      launch completeness as unverified (false).
 * 6. Gate Independence:
 *    - Passing Gate 11 alone never admits a candidate. All other buy gates remain intact.
 */

import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";
import type { SolanaTrackerBundlerSnapshot } from "./SolanaTrackerBundlerParser.js";

export type PaperBundlerExecutionContext = "PAPER_SIMULATION" | "BACKTEST";

export type PaperBundlerFailureStatus =
  | "EXECUTION_CONTEXT_PROHIBITED"
  | "INVALID_TARGET_MINT"
  | "IDENTITY_MISMATCH"
  | "INVALID_EVALUATION_TIME"
  | "INVALID_MAX_AGE_LIMIT"
  | "FUTURE_DATED_EVIDENCE"
  | "STALE_RETRIEVAL_EVIDENCE"
  | "MISSING_OR_INVALID_SNAPSHOT"
  | "INVALID_PROVENANCE_CONTRACT"
  | "CONTRADICTORY_METRIC_VALUES"
  | "MALFORMED_REQUIRED_METRICS";

export interface PaperBundlerProvenance {
  readonly provider: "SOLANA_TRACKER";
  readonly dataSource: "PROVIDER_REPORTED_UNVERIFIED";
  readonly requestedMint: string;
  readonly totalBundlersCount: number;
  readonly localRetrievedAtMs: number;
  readonly evaluationTimeMs: number;
  readonly retrievalAgeMs: number;
  readonly upstreamSnapshotTimeMs: null;
  readonly reportedRawInitialPct: number;
  readonly reportedRawCurrentPct: number;
  readonly initialPct: number;
  readonly currentHoldingPct: number;
  readonly policyClassification: "PAPER_PROXY_UNVERIFIED_LAUNCH_ALLOCATION";
  readonly isProviderAccuracyVerified: false;
  readonly isDeployerAttributionVerified: false;
  readonly isJitoEquivalenceVerified: false;
  readonly isLaunchHistoryComplete: false;
  readonly isProductionCompletenessEstablished: false;
}

export interface PaperBundlerAdaptationSuccess {
  readonly success: true;
  readonly status: "QUALIFIED_PAPER_PROXY";
  readonly bundlerPct: number;
  readonly currentHoldingPct: number;
  readonly initialPct: number;
  readonly provenance: PaperBundlerProvenance;
  readonly marketContextPatch: {
    readonly bundlerPct: number;
  };
}

export interface PaperBundlerAdaptationFailure {
  readonly success: false;
  readonly status: PaperBundlerFailureStatus;
  readonly bundlerPct: undefined;
  readonly currentHoldingPct?: undefined;
  readonly initialPct?: undefined;
  readonly provenance?: undefined;
  readonly marketContextPatch: {
    readonly bundlerPct: undefined;
  };
}

export type PaperBundlerAdaptationResult =
  | PaperBundlerAdaptationSuccess
  | PaperBundlerAdaptationFailure;

export interface AdaptPaperBundlerOptions {
  readonly targetMint: string;
  readonly snapshot: SolanaTrackerBundlerSnapshot | null | undefined;
  readonly evaluationTimeMs: number;
  readonly executionContext: PaperBundlerExecutionContext;
  readonly maxAllowedRetrievalAgeMs: number;
}

function isValidRawPercentage(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 100;
}

function isValidNormalizedFraction(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 1.0;
}

function fractionsAgree(normalized: number, rawPct: number): boolean {
  return normalized === rawPct / 100;
}

/**
 * Pure adapter connecting a parsed Solana Tracker bundler snapshot to Gate 11 evaluation
 * under an explicit PAPER or BACKTEST execution context.
 */
export function adaptPaperBundlerSnapshot(
  options: AdaptPaperBundlerOptions,
): PaperBundlerAdaptationResult {
  // 1. Strict Execution Boundary Check
  const allowedContexts: ReadonlySet<string> = new Set(["PAPER_SIMULATION", "BACKTEST"]);
  if (!allowedContexts.has(options.executionContext)) {
    return {
      success: false,
      status: "EXECUTION_CONTEXT_PROHIBITED",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 2. Target Mint Validation
  if (typeof options.targetMint !== "string" || !isCanonicalSolanaBase58(options.targetMint)) {
    return {
      success: false,
      status: "INVALID_TARGET_MINT",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 3. Evaluation Timestamp Validation
  if (
    typeof options.evaluationTimeMs !== "number" ||
    !Number.isSafeInteger(options.evaluationTimeMs) ||
    options.evaluationTimeMs < 0
  ) {
    return {
      success: false,
      status: "INVALID_EVALUATION_TIME",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 4. Age Limit Validation (must be positive safe integer)
  if (
    typeof options.maxAllowedRetrievalAgeMs !== "number" ||
    !Number.isSafeInteger(options.maxAllowedRetrievalAgeMs) ||
    options.maxAllowedRetrievalAgeMs <= 0
  ) {
    return {
      success: false,
      status: "INVALID_MAX_AGE_LIMIT",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 5. Snapshot Presence and Type Validation
  const snapshot = options.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return {
      success: false,
      status: "MISSING_OR_INVALID_SNAPSHOT",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 6. Identity Binding (Exact Mint Match)
  if (snapshot.requestedMint !== options.targetMint) {
    return {
      success: false,
      status: "IDENTITY_MISMATCH",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 7. Local Retrieval Timestamp & Causality Check
  const localRetrievedAtMs = snapshot.localRetrievedAtMs;
  if (
    typeof localRetrievedAtMs !== "number" ||
    !Number.isSafeInteger(localRetrievedAtMs) ||
    localRetrievedAtMs < 0
  ) {
    return {
      success: false,
      status: "MISSING_OR_INVALID_SNAPSHOT",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  if (options.evaluationTimeMs < localRetrievedAtMs) {
    return {
      success: false,
      status: "FUTURE_DATED_EVIDENCE",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 8. Retrieval Freshness Check
  const retrievalAgeMs = options.evaluationTimeMs - localRetrievedAtMs;
  if (retrievalAgeMs > options.maxAllowedRetrievalAgeMs) {
    return {
      success: false,
      status: "STALE_RETRIEVAL_EVIDENCE",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 9. Consumed Provenance Fields Contract Validation
  if (
    snapshot.provider !== "SOLANA_TRACKER" ||
    snapshot.dataSource !== "PROVIDER_REPORTED_UNVERIFIED" ||
    typeof snapshot.totalBundlersCount !== "number" ||
    !Number.isSafeInteger(snapshot.totalBundlersCount) ||
    snapshot.totalBundlersCount < 0 ||
    snapshot.upstreamSnapshotTimeMs !== null ||
    snapshot.isProviderAccuracyVerified !== false ||
    snapshot.isLaunchHistoryComplete !== false ||
    snapshot.isProductionCompletenessEstablished !== false
  ) {
    return {
      success: false,
      status: "INVALID_PROVENANCE_CONTRACT",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 10. Metric Integrity: Validate Raw and Normalized Values
  const rawInitial = snapshot.reportedRawInitialPct;
  const initialPct = snapshot.initialPct;
  const rawCurrent = snapshot.reportedRawCurrentPct;
  const currentHoldingPct = snapshot.currentHoldingPct;

  // Reject missing, non-finite, out-of-range, NaN, Infinity without manufacturing values
  if (
    !isValidRawPercentage(rawInitial) ||
    !isValidNormalizedFraction(initialPct) ||
    !isValidRawPercentage(rawCurrent) ||
    !isValidNormalizedFraction(currentHoldingPct)
  ) {
    return {
      success: false,
      status: "MALFORMED_REQUIRED_METRICS",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // Require normalized values to agree with raw percentages divided by 100
  if (!fractionsAgree(initialPct, rawInitial) || !fractionsAgree(currentHoldingPct, rawCurrent)) {
    return {
      success: false,
      status: "CONTRADICTORY_METRIC_VALUES",
      bundlerPct: undefined,
      marketContextPatch: { bundlerPct: undefined },
    };
  }

  // 11. Construct Strictly Validated Provenance
  const provenance: PaperBundlerProvenance = Object.freeze({
    provider: "SOLANA_TRACKER",
    dataSource: "PROVIDER_REPORTED_UNVERIFIED",
    requestedMint: snapshot.requestedMint,
    totalBundlersCount: snapshot.totalBundlersCount,
    localRetrievedAtMs,
    evaluationTimeMs: options.evaluationTimeMs,
    retrievalAgeMs,
    upstreamSnapshotTimeMs: null,
    reportedRawInitialPct: rawInitial,
    reportedRawCurrentPct: rawCurrent,
    initialPct,
    currentHoldingPct,
    policyClassification: "PAPER_PROXY_UNVERIFIED_LAUNCH_ALLOCATION",
    isProviderAccuracyVerified: false,
    isDeployerAttributionVerified: false,
    isJitoEquivalenceVerified: false,
    isLaunchHistoryComplete: false,
    isProductionCompletenessEstablished: false,
  });

  return Object.freeze({
    success: true,
    status: "QUALIFIED_PAPER_PROXY",
    bundlerPct: initialPct,
    currentHoldingPct,
    initialPct,
    provenance,
    marketContextPatch: Object.freeze({
      bundlerPct: initialPct,
    }),
  });
}
