/**
 * Phase 12.94-D Milestone D.3.3: Offline LP-Screening Bridge (Hardened)
 *
 * Implements the offline integration bridge connecting validated Raydium AMM v4 LP evidence
 * to the candidate scanner's LP screening evaluation.
 *
 * Strict Architectural Guarantees:
 * 1. Narrowed Validated Evidence Path:
 *    Only accepts pre-validated snapshot evidence (RaydiumAmmV4SnapshotValidationSuccess or
 *    SnapshotAcquisitionEvidence with verified assertions). Arbitrary scalar input dictionaries
 *    are rejected; loose scalar inputs belong in the pure arithmetic helper.
 * 2. Complete Exact Identity Binding:
 *    Binds evidence strictly to both candidate pool ID AND token mint. Missing or mismatched
 *    identities fail closed immediately (IDENTITY_MISMATCH).
 * 3. Projection Identity Guard:
 *    bridgeLpEvidenceToScannedPool() re-validates that the candidate pool being projected matches
 *    the exact evaluated identities in the bridge result. Cross-pool / cross-mint projection
 *    fails closed to UNAVAILABLE with lpBurnPct: 0.
 * 4. Comprehensive Freshness Policy Validation:
 *    Validates maxEvidenceAgeMs, currentTimestampMs (finite positive safe integer), and
 *    clockSkewToleranceMs (finite non-negative number). Rejects NaN, Infinity, negative values.
 * 5. Distinct Unavailable Semantics & Strategy Admission Separation:
 *    Unavailable evidence is distinct from observed 0% (lpBurnPct: null vs 0.0, available: false vs true).
 *    LP-filter evaluation reports only filter-level pass/fail; full strategy admission is never claimed.
 * 6. Pure Integer Arithmetic:
 *    Preserves exact 90% comparison via BigInt cross-multiplication: 100n * (L - S) >= 90n * L.
 */

import type {
  CandidateScannerFilterEvaluation,
  CandidateScannerRejectionReason,
  ScannedPoolRecord,
} from "./CandidateScannerTypes.js";
import {
  calculateAmmV4LpInaccessibleClaims,
  type AmmV4LpAccountingSuccess,
} from "../research/pilot/RaydiumAmmLpAccounting.js";
import {
  isValidIsoCalendarTimestamp,
  validateRaydiumAmmV4Snapshot,
  type EvidenceOrigin,
  type RaydiumAmmV4SnapshotValidationSuccess,
} from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";
import { WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import type { SnapshotAcquisitionEvidence } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";

export const LP_DERIVATION_METHOD = "RAYDIUM_AMM_V4_LP_RESERVE_VS_SUPPLY" as const;
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 5000;

export type LpScreeningStatus =
  | "AVAILABLE_QUALIFIED"
  | "AVAILABLE_BELOW_THRESHOLD"
  | "IDENTITY_MISMATCH"
  | "STALE_EVIDENCE"
  | "INVALID_EVIDENCE"
  | "UNAVAILABLE";

export interface LpFreshnessPolicy {
  /** Maximum allowable age of evidence in milliseconds (must be a positive finite safe number) */
  readonly maxEvidenceAgeMs: number;
  /** Injectable current timestamp for deterministic offline testing (defaults to Date.now()) */
  readonly currentTimestampMs?: number | undefined;
  /** Clock skew tolerance in milliseconds (defaults to 5,000 ms, must be >= 0) */
  readonly clockSkewToleranceMs?: number | undefined;
}

export interface RawLpAccountingValues {
  readonly protocolLp: bigint;
  readonly circulatingSupply: bigint;
  readonly rawInaccessibleLp: bigint;
  readonly rawDenominator: bigint;
}

export interface LpBridgeScreeningResult {
  readonly status: LpScreeningStatus;
  readonly available: boolean;
  /** LP filter pass status. Note: full strategy admission is not certified by this bridge. */
  readonly passed: boolean;
  readonly lpFilterPassed: boolean;
  /** The exact candidate identities that were evaluated. Rechecked during projection. */
  readonly evaluatedCandidate: {
    readonly poolId: string;
    readonly mintAddress: string;
  };
  readonly lpBurnPct: number | null;
  readonly meetsNinetyPercentThreshold: boolean;
  readonly rawAccounting: RawLpAccountingValues | null;
  readonly derivationMethod: typeof LP_DERIVATION_METHOD | null;
  readonly retrievedAtIso: string | null;
  readonly contextSlot: number | null;
  readonly evidenceOrigin: EvidenceOrigin | null;
  readonly isSyntheticFixture: boolean | null;
  readonly metricProvenance: "DERIVED" | "UNAVAILABLE";
  readonly filterEvaluation: CandidateScannerFilterEvaluation;
  readonly diagnosticMessage: string;
  /** Explicit evidence boundary: LP bridge never claims full strategy admission */
  readonly evidenceBoundary: {
    readonly strategyGateAdmitted: false;
  };
}

export type ValidatedLpEvidenceInput =
  | RaydiumAmmV4SnapshotValidationSuccess
  | SnapshotAcquisitionEvidence
  | { readonly evidence: SnapshotAcquisitionEvidence }
  | null
  | undefined;

export type BridgedPoolProjectionResult =
  | {
      readonly ok: true;
      readonly pool: ScannedPoolRecord;
      readonly status: "AVAILABLE_QUALIFIED";
      readonly lpBurnPct: number;
      readonly metricProvenance: "DERIVED";
    }
  | {
      readonly ok: false;
      readonly pool: ScannedPoolRecord;
      readonly status: "AVAILABLE_BELOW_THRESHOLD";
      readonly lpBurnPct: number;
      readonly metricProvenance: "DERIVED";
      readonly failureReason: CandidateScannerRejectionReason;
    }
  | {
      readonly ok: false;
      readonly pool: null;
      readonly status: "UNAVAILABLE" | "INVALID_EVIDENCE" | "IDENTITY_MISMATCH" | "STALE_EVIDENCE";
      readonly lpBurnPct: null;
      readonly metricProvenance: "UNAVAILABLE";
      readonly failureReason: CandidateScannerRejectionReason;
    };

/**
 * Validates the entire LpFreshnessPolicy strictly.
 * Rejects NaN, nonfinite, non-integer, negative, or invalid parameters.
 */
export function validateLpFreshnessPolicy(policy: unknown): asserts policy is LpFreshnessPolicy {
  if (typeof policy !== "object" || policy === null) {
    throw new Error("Invalid LpFreshnessPolicy: policy must be an object");
  }
  const p = policy as Record<string, unknown>;

  // 1. maxEvidenceAgeMs: must be a positive finite safe number
  if (
    typeof p.maxEvidenceAgeMs !== "number" ||
    !Number.isFinite(p.maxEvidenceAgeMs) ||
    Number.isNaN(p.maxEvidenceAgeMs) ||
    p.maxEvidenceAgeMs <= 0
  ) {
    throw new Error(
      `Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number, got ${p.maxEvidenceAgeMs}`,
    );
  }

  // 2. currentTimestampMs: if provided, must be a positive finite safe integer timestamp
  if (p.currentTimestampMs !== undefined) {
    if (
      typeof p.currentTimestampMs !== "number" ||
      !Number.isFinite(p.currentTimestampMs) ||
      Number.isNaN(p.currentTimestampMs) ||
      !Number.isSafeInteger(p.currentTimestampMs) ||
      p.currentTimestampMs <= 0
    ) {
      throw new Error(
        `Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer timestamp, got ${p.currentTimestampMs}`,
      );
    }
  }

  // 3. clockSkewToleranceMs: if provided, must be a finite non-negative number
  if (p.clockSkewToleranceMs !== undefined) {
    if (
      typeof p.clockSkewToleranceMs !== "number" ||
      !Number.isFinite(p.clockSkewToleranceMs) ||
      Number.isNaN(p.clockSkewToleranceMs) ||
      p.clockSkewToleranceMs < 0
    ) {
      throw new Error(
        `Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number, got ${p.clockSkewToleranceMs}`,
      );
    }
  }
}

type ExtractedValidatedEvidence =
  | {
      readonly ok: true;
      readonly poolId: string;
      readonly tokenMint: string;
      readonly protocolLp: bigint;
      readonly circulatingSupply: bigint;
      readonly retrievedAtIso: string;
      readonly contextSlot: number;
      readonly evidenceOrigin: EvidenceOrigin;
      readonly isSyntheticFixture: boolean | null;
      readonly accounting: AmmV4LpAccountingSuccess;
    }
  | {
      readonly ok: false;
      readonly category: "UNAVAILABLE" | "INVALID_EVIDENCE";
      readonly error: string;
      readonly retrievedAtIso?: string | null | undefined;
      readonly contextSlot?: number | null | undefined;
      readonly evidenceOrigin?: EvidenceOrigin | null | undefined;
      readonly isSyntheticFixture?: boolean | null | undefined;
    };

function toBigIntSafe(val: unknown): bigint | null {
  if (typeof val === "bigint") return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
    return BigInt(val);
  }
  return null;
}

/**
 * Extracts and strictly verifies that the evidence input comes from the accepted validator path.
 * Rejects loose scalar dictionaries or acquisition objects with missing/omitted assertions.
 */
/**
 * Extracts and strictly verifies that the evidence input comes from the accepted validator path.
 *
 * Authoritative Rules:
 * 1. Binds quantities directly to the decoded account states (poolState.lpReserve, lpMintState.supply).
 * 2. Computes derived accounting using the exact calculateAmmV4LpInaccessibleClaims arithmetic helper.
 * 3. Rejects any inconsistency between decoded account states and validationResult.accounting summary.
 * 4. Rejects any inconsistency between decoded account states, validationResult, and acquisition wrapper accounting.
 * 5. Identifies the pool's authoritative token mint from decoded poolState.baseMint / poolState.quoteMint,
 *    and rejects requestedIdentities.expectedTokenMint if it does not match the decoded pool tokens.
 * 6. Rejects loose scalar dictionaries or acquisition objects with missing/omitted assertions.
 */
function extractValidatedEvidence(input: ValidatedLpEvidenceInput): ExtractedValidatedEvidence {
  if (input === null || input === undefined) {
    return {
      ok: false,
      category: "UNAVAILABLE",
      error: "No LP accounting evidence provided",
    };
  }

  // Handle wrapped acquisition result { evidence: ... }
  const raw: unknown =
    typeof input === "object" &&
    input !== null &&
    "evidence" in input &&
    (input as { evidence: unknown }).evidence
      ? (input as { evidence: unknown }).evidence
      : input;

  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Evidence input must be a validated snapshot or acquisition object",
    };
  }

  const obj = raw as Record<string, unknown>;

  let validationResult: Record<string, unknown> | null = null;
  let acquisitionWrapper: Record<string, unknown> | null = null;

  // Branch B: SnapshotAcquisitionEvidence
  if (
    obj.command === "RaydiumAmmV4SnapshotAcquisition" ||
    ("config" in obj && "outcomes" in obj && "contextSlots" in obj)
  ) {
    acquisitionWrapper = obj;
    const outcomes = obj.outcomes as Record<string, unknown> | undefined;
    if (!outcomes || outcomes.structuralValidationOk !== true || outcomes.retrievalOk !== true) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error:
          "Acquisition outcomes indicate structural validation or retrieval failure (or outcomes omitted)",
      };
    }

    const valRes = obj.validationResult as Record<string, unknown> | undefined;
    if (!valRes || typeof valRes !== "object" || valRes.ok !== true) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Acquisition evidence lacks a verified successful validationResult assertion",
      };
    }
    validationResult = valRes;
  } else if ("diagnostics" in obj && "accounting" in obj && "evidenceBoundary" in obj) {
    // Branch A: Direct RaydiumAmmV4SnapshotValidationSuccess
    if (obj.ok !== true) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Snapshot validation result indicates failure (ok !== true)",
      };
    }
    validationResult = obj;
  } else {
    // Branch C: Loose flat objects or unvalidated dictionaries
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error:
        "Input is an unvalidated or flat dictionary; arbitrary inputs must be validated via accepted snapshot validator",
    };
  }

  // Extract and validate diagnostics
  const diag = validationResult.diagnostics as Record<string, unknown> | undefined;
  if (!diag || typeof diag !== "object") {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Snapshot validation result missing diagnostics",
    };
  }

  const slot = diag.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Invalid context slot in snapshot diagnostics: ${slot}`,
    };
  }

  const retrievedAtIso = diag.retrievedAtIso;
  if (typeof retrievedAtIso !== "string" || !isValidIsoCalendarTimestamp(retrievedAtIso)) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Missing or invalid retrievedAtIso in snapshot diagnostics: ${retrievedAtIso}`,
    };
  }

  const evidenceOrigin = diag.evidenceOrigin as EvidenceOrigin | undefined;
  if (
    evidenceOrigin !== "CAPTURED_RPC" &&
    evidenceOrigin !== "SYNTHETIC_FIXTURE" &&
    evidenceOrigin !== "UNKNOWN"
  ) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Invalid evidenceOrigin in snapshot diagnostics: ${evidenceOrigin}`,
    };
  }

  const isSyntheticFixture =
    typeof diag.isSyntheticFixture === "boolean" ? diag.isSyntheticFixture : null;
  if (
    (evidenceOrigin === "CAPTURED_RPC" && isSyntheticFixture === true) ||
    (evidenceOrigin === "SYNTHETIC_FIXTURE" && isSyntheticFixture === false)
  ) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Contradictory provenance in snapshot diagnostics: origin ${evidenceOrigin} with isSyntheticFixture ${isSyntheticFixture}`,
    };
  }

  // 1. Authoritative Decoded Account States
  const poolState = diag.poolState as Record<string, unknown> | undefined;
  const lpMintState = diag.lpMintState as Record<string, unknown> | undefined;
  if (
    !poolState ||
    typeof poolState !== "object" ||
    !lpMintState ||
    typeof lpMintState !== "object"
  ) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Diagnostics missing decoded poolState or lpMintState account states",
    };
  }

  const poolAddress = typeof poolState.poolAddress === "string" ? poolState.poolAddress.trim() : "";
  const baseMint = typeof poolState.baseMint === "string" ? poolState.baseMint.trim() : "";
  const quoteMint = typeof poolState.quoteMint === "string" ? poolState.quoteMint.trim() : "";
  const lpMintInPool = typeof poolState.lpMint === "string" ? poolState.lpMint.trim() : "";
  const lpMintAddress =
    typeof lpMintState.mintAddress === "string" ? lpMintState.mintAddress.trim() : "";

  if (!poolAddress || !baseMint || !quoteMint || !lpMintInPool || !lpMintAddress) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Decoded account states contain missing or invalid public key fields",
    };
  }

  if (lpMintInPool !== lpMintAddress) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Decoded poolState.lpMint (${lpMintInPool}) does not match lpMintState.mintAddress (${lpMintAddress})`,
    };
  }

  const reqIdentities = (diag.requestedIdentities as Record<string, unknown> | undefined) ?? {};
  const requestedPoolId =
    typeof reqIdentities.poolId === "string" ? reqIdentities.poolId.trim() : "";
  const requestedTokenMint =
    typeof reqIdentities.expectedTokenMint === "string"
      ? reqIdentities.expectedTokenMint.trim()
      : "";

  if (!requestedPoolId) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Snapshot diagnostics missing requested poolId identity",
    };
  }

  if (!requestedTokenMint) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Snapshot diagnostics missing requested expectedTokenMint identity",
    };
  }

  if (requestedPoolId !== poolAddress) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Requested poolId (${requestedPoolId}) does not match decoded poolAddress (${poolAddress})`,
    };
  }

  // 2. Authoritative Token Mint from Decoded Pool State
  let authoritativeTokenMint: string;
  if (quoteMint === WSOL_MINT) {
    authoritativeTokenMint = baseMint;
  } else if (baseMint === WSOL_MINT) {
    authoritativeTokenMint = quoteMint;
  } else if (requestedTokenMint === baseMint || requestedTokenMint === quoteMint) {
    authoritativeTokenMint = requestedTokenMint;
  } else {
    authoritativeTokenMint = baseMint;
  }

  // If requested expectedTokenMint is specified, it MUST match the decoded pool tokens and authoritative mint
  if (requestedTokenMint !== baseMint && requestedTokenMint !== quoteMint) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Requested expectedTokenMint (${requestedTokenMint}) does not match decoded pool tokens (${baseMint} / ${quoteMint})`,
    };
  }
  if (requestedTokenMint !== authoritativeTokenMint) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Requested expectedTokenMint (${requestedTokenMint}) does not match authoritative decoded token mint (${authoritativeTokenMint})`,
    };
  }

  // 3. Authoritative LP Quantities from Decoded Account States
  const protocolLp = toBigIntSafe(poolState.lpReserve);
  const circulatingSupply = toBigIntSafe(lpMintState.supply);
  if (protocolLp === null || circulatingSupply === null) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error:
        "Decoded poolState.lpReserve or lpMintState.supply is not a valid non-negative integer",
    };
  }

  // Calculate authoritative accounting using the pure arithmetic helper
  const derivedAccounting = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);
  if (!derivedAccounting.ok) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: `Accounting derivation from decoded accounts failed: ${derivedAccounting.message}`,
    };
  }

  // 4. Inconsistency check with validationResult.accounting summary
  const valAcc = validationResult.accounting as Record<string, unknown> | undefined;
  if (!valAcc || typeof valAcc !== "object" || valAcc.ok !== true) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error: "Snapshot validation accounting assertion is missing or not ok",
    };
  }

  const valProtoLp = toBigIntSafe(valAcc.protocolLp);
  const valCircSupply = toBigIntSafe(valAcc.circulatingSupply);
  const valInacc = toBigIntSafe(valAcc.rawInaccessibleLp);
  const valDenom = toBigIntSafe(valAcc.rawDenominator);

  if (
    valProtoLp !== protocolLp ||
    valCircSupply !== circulatingSupply ||
    valInacc !== derivedAccounting.rawInaccessibleLp ||
    valDenom !== derivedAccounting.rawDenominator ||
    valAcc.meetsNinetyPercentThreshold !== derivedAccounting.meetsNinetyPercentThreshold
  ) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error:
        "Inconsistency detected: validationResult.accounting summary does not match decoded account states (poolState.lpReserve / lpMintState.supply)",
    };
  }

  // 5. Inconsistency check with acquisitionWrapper
  if (acquisitionWrapper !== null) {
    const acqAcc = acquisitionWrapper.accounting as Record<string, unknown> | undefined;
    if (!acqAcc || typeof acqAcc !== "object" || acqAcc.ok !== true) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Acquisition evidence lacks a verified successful accounting assertion",
      };
    }

    const acqProtoLp = toBigIntSafe(acqAcc.protocolLp);
    const acqCircSupply = toBigIntSafe(acqAcc.circulatingSupply);
    const acqInacc = toBigIntSafe(acqAcc.rawInaccessibleLp);
    const acqDenom = toBigIntSafe(acqAcc.rawDenominator);
    const acqOutcomes = acquisitionWrapper.outcomes as Record<string, unknown> | undefined;

    if (
      acqProtoLp !== protocolLp ||
      acqCircSupply !== circulatingSupply ||
      acqInacc !== derivedAccounting.rawInaccessibleLp ||
      acqDenom !== derivedAccounting.rawDenominator ||
      acqAcc.meetsNinetyPercentThreshold !== derivedAccounting.meetsNinetyPercentThreshold ||
      acqOutcomes?.meetsNinetyPercentThreshold !== derivedAccounting.meetsNinetyPercentThreshold
    ) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error:
          "Inconsistency detected: acquisition wrapper accounting does not match decoded account states or validationResult",
      };
    }

    const discovered = acquisitionWrapper.discoveredIdentities as
      | Record<string, unknown>
      | undefined;
    if (!discovered || discovered.poolId !== poolAddress) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Acquisition discoveredIdentities.poolId does not match decoded poolAddress",
      };
    }
    if (discovered.lpMint && discovered.lpMint !== lpMintInPool) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Acquisition discoveredIdentities.lpMint does not match decoded lpMint",
      };
    }
    if (discovered.expectedTokenMint && discovered.expectedTokenMint !== authoritativeTokenMint) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error:
          "Acquisition discoveredIdentities.expectedTokenMint does not match decoded pool token mint",
      };
    }

    const contextSlots = acquisitionWrapper.contextSlots as Record<string, unknown> | undefined;
    if (contextSlots?.batchSlot !== slot) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: `Acquisition contextSlots.batchSlot (${contextSlots?.batchSlot}) does not match validation slot (${slot})`,
      };
    }

    if (acquisitionWrapper.retrievedAtIso !== retrievedAtIso) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Acquisition retrievedAtIso does not match validation diagnostics retrievedAtIso",
      };
    }
    if (acquisitionWrapper.evidenceOrigin !== evidenceOrigin) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error: "Acquisition evidenceOrigin does not match validation diagnostics evidenceOrigin",
      };
    }
    if (acquisitionWrapper.isSyntheticFixture !== isSyntheticFixture) {
      return {
        ok: false,
        category: "INVALID_EVIDENCE",
        error:
          "Acquisition isSyntheticFixture does not match validation diagnostics isSyntheticFixture",
      };
    }
  }

  return {
    ok: true,
    poolId: poolAddress,
    tokenMint: authoritativeTokenMint,
    protocolLp,
    circulatingSupply,
    retrievedAtIso,
    contextSlot: slot,
    evidenceOrigin,
    isSyntheticFixture,
    accounting: derivedAccounting,
  };
}

function buildFilterEvaluation(
  passed: boolean,
  reason?: CandidateScannerRejectionReason | undefined,
  details?: Record<string, unknown> | undefined,
): CandidateScannerFilterEvaluation {
  return {
    filterName: "ANTI_RUG_LP_SECURITY",
    passed,
    ...(reason !== undefined ? { reason } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * Pure evaluation function for the offline LP-screening bridge.
 *
 * Connects validated Raydium AMM v4 LP evidence to the candidate scanner's
 * anti-rug evaluation criteria while maintaining strict identity binding,
 * complete freshness policy verification, and exact integer arithmetic.
 */
export function evaluateLpScreeningBridgeSync(
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  evidence: ValidatedLpEvidenceInput,
  freshnessPolicy: LpFreshnessPolicy,
): LpBridgeScreeningResult {
  // Validate entire freshness policy strictly (throws on NaN, nonfinite, negative skew)
  validateLpFreshnessPolicy(freshnessPolicy);

  // Candidate identities must be non-empty strings
  const candPoolId = typeof candidate?.poolId === "string" ? candidate.poolId.trim() : "";
  const candMintAddress =
    typeof candidate?.mintAddress === "string" ? candidate.mintAddress.trim() : "";

  const evaluatedCandidate = Object.freeze({
    poolId: candPoolId,
    mintAddress: candMintAddress,
  });

  // 1. Missing Evidence Evaluation (Fail-Closed, zero placeholder substitution)
  if (evidence === null || evidence === undefined) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_UNLOCKED_LP_RISK", {
      status: "UNAVAILABLE",
      reason: "No LP accounting evidence provided for candidate",
    });

    return {
      status: "UNAVAILABLE",
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: null,
      retrievedAtIso: null,
      contextSlot: null,
      evidenceOrigin: null,
      isSyntheticFixture: null,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: "LP accounting evidence is unavailable for candidate",
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 2. Extract and Validate Evidence from the Verified Path
  const extracted = extractValidatedEvidence(evidence);
  if (!extracted.ok) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: extracted.category,
      reason: extracted.error,
    });

    return {
      status: extracted.category,
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: null,
      retrievedAtIso: extracted.retrievedAtIso ?? null,
      contextSlot: extracted.contextSlot ?? null,
      evidenceOrigin: extracted.evidenceOrigin ?? null,
      isSyntheticFixture: extracted.isSyntheticFixture ?? null,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `LP accounting evidence is invalid: ${extracted.error}`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 3. Strict Identity Binding (Requires both pool AND token mint exact match; missing fails closed)
  if (!candPoolId || !candMintAddress) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "IDENTITY_MISMATCH",
      reason: "Candidate poolId or mintAddress is empty or invalid",
      candidatePoolId: candPoolId,
      candidateMintAddress: candMintAddress,
    });

    return {
      status: "IDENTITY_MISMATCH",
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: null,
      retrievedAtIso: extracted.retrievedAtIso,
      contextSlot: extracted.contextSlot,
      evidenceOrigin: extracted.evidenceOrigin,
      isSyntheticFixture: extracted.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: "Candidate has missing poolId or mintAddress",
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  const poolMatches = candPoolId === extracted.poolId;
  const mintMatches = candMintAddress === extracted.tokenMint;

  if (!poolMatches || !mintMatches) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "IDENTITY_MISMATCH",
      candidatePoolId: candPoolId,
      candidateMintAddress: candMintAddress,
      evidencePoolId: extracted.poolId,
      evidenceTokenMint: extracted.tokenMint,
    });

    return {
      status: "IDENTITY_MISMATCH",
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: null,
      retrievedAtIso: extracted.retrievedAtIso,
      contextSlot: extracted.contextSlot,
      evidenceOrigin: extracted.evidenceOrigin,
      isSyntheticFixture: extracted.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `Identity mismatch: candidate (${candPoolId}/${candMintAddress}) does not match evidence (${extracted.poolId}/${extracted.tokenMint})`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 4. Freshness Policy Age & Skew Evaluation
  const currentNowMs = freshnessPolicy.currentTimestampMs ?? Date.now();
  const retrievedAtMs = Date.parse(extracted.retrievedAtIso);
  const ageMs = currentNowMs - retrievedAtMs;
  const clockSkewToleranceMs =
    freshnessPolicy.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;

  if (ageMs < -clockSkewToleranceMs) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "INVALID_EVIDENCE",
      reason: `Evidence retrieval timestamp is in the future beyond tolerance: age ${ageMs}ms`,
      retrievedAtIso: extracted.retrievedAtIso,
    });

    return {
      status: "INVALID_EVIDENCE",
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: LP_DERIVATION_METHOD,
      retrievedAtIso: extracted.retrievedAtIso,
      contextSlot: extracted.contextSlot,
      evidenceOrigin: extracted.evidenceOrigin,
      isSyntheticFixture: extracted.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `LP evidence timestamp is future-dated beyond tolerance (${ageMs}ms in future)`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  if (ageMs > freshnessPolicy.maxEvidenceAgeMs) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_UNLOCKED_LP_RISK", {
      status: "STALE_EVIDENCE",
      ageMs,
      maxEvidenceAgeMs: freshnessPolicy.maxEvidenceAgeMs,
      retrievedAtIso: extracted.retrievedAtIso,
    });

    return {
      status: "STALE_EVIDENCE",
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: LP_DERIVATION_METHOD,
      retrievedAtIso: extracted.retrievedAtIso,
      contextSlot: extracted.contextSlot,
      evidenceOrigin: extracted.evidenceOrigin,
      isSyntheticFixture: extracted.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `LP evidence is stale: age ${ageMs}ms exceeds max allowed ${freshnessPolicy.maxEvidenceAgeMs}ms`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 5. Pure Integer Arithmetic LP Accounting Calculation
  const accounting = calculateAmmV4LpInaccessibleClaims(
    extracted.protocolLp,
    extracted.circulatingSupply,
  );

  if (!accounting.ok) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "INVALID_EVIDENCE",
      failureCategory: accounting.category,
      failureMessage: accounting.message,
    });

    return {
      status: "INVALID_EVIDENCE",
      available: false,
      passed: false,
      lpFilterPassed: false,
      evaluatedCandidate,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: LP_DERIVATION_METHOD,
      retrievedAtIso: extracted.retrievedAtIso,
      contextSlot: extracted.contextSlot,
      evidenceOrigin: extracted.evidenceOrigin,
      isSyntheticFixture: extracted.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `LP accounting calculation failed: ${accounting.message}`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  const rawAccounting: RawLpAccountingValues = {
    protocolLp: accounting.protocolLp,
    circulatingSupply: accounting.circulatingSupply,
    rawInaccessibleLp: accounting.rawInaccessibleLp,
    rawDenominator: accounting.rawDenominator,
  };

  // 6. Threshold Classification (Exact BigInt Comparison: 100n * (L - S) >= 90n * L)
  if (accounting.meetsNinetyPercentThreshold) {
    const filterEvaluation = buildFilterEvaluation(true, undefined, {
      status: "AVAILABLE_QUALIFIED",
      lpBurnPct: accounting.displayInaccessiblePct,
      meetsNinetyPercentThreshold: true,
      protocolLp: accounting.protocolLp.toString(),
      circulatingSupply: accounting.circulatingSupply.toString(),
      rawInaccessibleLp: accounting.rawInaccessibleLp.toString(),
    });

    return {
      status: "AVAILABLE_QUALIFIED",
      available: true,
      passed: true,
      lpFilterPassed: true,
      evaluatedCandidate,
      lpBurnPct: accounting.displayInaccessiblePct,
      meetsNinetyPercentThreshold: true,
      rawAccounting,
      derivationMethod: LP_DERIVATION_METHOD,
      retrievedAtIso: extracted.retrievedAtIso,
      contextSlot: extracted.contextSlot,
      evidenceOrigin: extracted.evidenceOrigin,
      isSyntheticFixture: extracted.isSyntheticFixture,
      metricProvenance: "DERIVED",
      filterEvaluation,
      diagnosticMessage: `LP accounting qualified: ${accounting.displayInaccessiblePct.toFixed(6)}% inaccessible (>= 90% threshold)`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 7. Available but Below 90% Threshold (e.g. Reference RAY/WSOL with 0.135682%)
  const filterEvaluation = buildFilterEvaluation(false, "REJECTED_UNLOCKED_LP_RISK", {
    status: "AVAILABLE_BELOW_THRESHOLD",
    lpBurnPct: accounting.displayInaccessiblePct,
    minLpBurnPct: 90.0,
    meetsNinetyPercentThreshold: false,
    protocolLp: accounting.protocolLp.toString(),
    circulatingSupply: accounting.circulatingSupply.toString(),
    rawInaccessibleLp: accounting.rawInaccessibleLp.toString(),
  });

  return {
    status: "AVAILABLE_BELOW_THRESHOLD",
    available: true,
    passed: false,
    lpFilterPassed: false,
    evaluatedCandidate,
    lpBurnPct: accounting.displayInaccessiblePct,
    meetsNinetyPercentThreshold: false,
    rawAccounting,
    derivationMethod: LP_DERIVATION_METHOD,
    retrievedAtIso: extracted.retrievedAtIso,
    contextSlot: extracted.contextSlot,
    evidenceOrigin: extracted.evidenceOrigin,
    isSyntheticFixture: extracted.isSyntheticFixture,
    metricProvenance: "DERIVED",
    filterEvaluation,
    diagnosticMessage: `LP accounting below threshold: ${accounting.displayInaccessiblePct.toFixed(6)}% inaccessible (< 90% threshold)`,
    evidenceBoundary: { strategyGateAdmitted: false },
  };
}

/**
 * Asynchronous evaluation function for the offline LP-screening bridge.
 *
 * Runs full synchronous account state binding and consistency checks, and
 * where appropriate, re-validates the retained raw batch RPC payload from
 * acquisition evidence against validateRaydiumAmmV4Snapshot().
 */
export async function evaluateLpScreeningBridge(
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  evidence: ValidatedLpEvidenceInput,
  freshnessPolicy: LpFreshnessPolicy,
): Promise<LpBridgeScreeningResult> {
  const syncResult = evaluateLpScreeningBridgeSync(candidate, evidence, freshnessPolicy);
  if (
    syncResult.status !== "AVAILABLE_QUALIFIED" &&
    syncResult.status !== "AVAILABLE_BELOW_THRESHOLD"
  ) {
    return syncResult;
  }

  // Check if raw batch is present in acquisition evidence requests
  const raw: unknown =
    typeof evidence === "object" &&
    evidence !== null &&
    "evidence" in evidence &&
    (evidence as { evidence: unknown }).evidence
      ? (evidence as { evidence: unknown }).evidence
      : evidence;

  if (
    typeof raw === "object" &&
    raw !== null &&
    "requests" in raw &&
    Array.isArray((raw as { requests: unknown }).requests)
  ) {
    const acq = raw as SnapshotAcquisitionEvidence;
    const req2 = acq.requests?.[1];
    if (req2 && (req2.parsedJson || req2.rawResponseBody)) {
      const hasParsedResult =
        req2.parsedJson && typeof req2.parsedJson === "object" && "result" in req2.parsedJson;
      const rawPayload = hasParsedResult
        ? (req2.parsedJson as Record<string, unknown>)
        : typeof req2.rawResponseBody === "string"
          ? (JSON.parse(req2.rawResponseBody) as Record<string, unknown>)
          : null;
      if (rawPayload) {
        const fallbackIdentities = acq.discoveredIdentities ??
          (acq.validationResult && acq.validationResult.ok
            ? acq.validationResult.diagnostics.requestedIdentities
            : null) ?? {
            poolId: syncResult.evaluatedCandidate.poolId,
            lpMint: "",
            baseVault: "",
            quoteVault: "",
            expectedTokenMint: syncResult.evaluatedCandidate.mintAddress,
          };
        const revalidated = await validateRaydiumAmmV4Snapshot(fallbackIdentities, rawPayload, {
          evidenceOrigin: acq.evidenceOrigin ?? undefined,
          isSyntheticFixture: acq.isSyntheticFixture ?? undefined,
          retrievedAtIso: acq.retrievedAtIso ?? undefined,
        });

        if (!revalidated.ok) {
          const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
            status: "INVALID_EVIDENCE",
            reason: `Retained final raw batch failed validation against accepted validator: ${revalidated.message}`,
          });

          return {
            ...syncResult,
            status: "INVALID_EVIDENCE",
            available: false,
            passed: false,
            lpFilterPassed: false,
            lpBurnPct: null,
            meetsNinetyPercentThreshold: false,
            rawAccounting: null,
            derivationMethod: null,
            metricProvenance: "UNAVAILABLE",
            filterEvaluation,
            diagnosticMessage: `Retained final raw batch failed validation: ${revalidated.message}`,
          };
        }

        // Verify revalidated accounts match authoritative claims
        if (
          revalidated.diagnostics.poolState.lpReserve !== syncResult.rawAccounting?.protocolLp ||
          revalidated.diagnostics.lpMintState.supply !== syncResult.rawAccounting?.circulatingSupply
        ) {
          const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
            status: "INVALID_EVIDENCE",
            reason:
              "Inconsistency detected: retained final raw batch accounts do not match decoded account claims",
          });

          return {
            ...syncResult,
            status: "INVALID_EVIDENCE",
            available: false,
            passed: false,
            lpFilterPassed: false,
            lpBurnPct: null,
            meetsNinetyPercentThreshold: false,
            rawAccounting: null,
            derivationMethod: null,
            metricProvenance: "UNAVAILABLE",
            filterEvaluation,
            diagnosticMessage:
              "Retained final raw batch accounts do not match decoded account claims",
          };
        }
      }
    }
  }

  return syncResult;
}

/**
 * Explicit typed projection helper that returns a discriminated union outcome.
 *
 * Boundary Guarantees:
 * - For unavailable, stale, invalid, or mismatched evidence, returns ok: false and pool: null
 *   with no normal numeric pool record (preventing unobserved data from posing as numeric 0).
 * - For genuinely observed zero and available below-threshold measurements, returns ok: false
 *   with a valid ScannedPoolRecord containing the observed percentage and metricProvenance: "DERIVED".
 * - For available qualified measurements, returns ok: true with a valid ScannedPoolRecord.
 */
export function projectBridgedLpPool(
  candidate: ScannedPoolRecord,
  bridgeResult: LpBridgeScreeningResult,
): BridgedPoolProjectionResult {
  // Identity mismatch across projection
  if (
    !bridgeResult.evaluatedCandidate ||
    candidate.poolId !== bridgeResult.evaluatedCandidate.poolId ||
    candidate.mintAddress !== bridgeResult.evaluatedCandidate.mintAddress
  ) {
    return {
      ok: false,
      pool: null,
      status: "IDENTITY_MISMATCH",
      lpBurnPct: null,
      metricProvenance: "UNAVAILABLE",
      failureReason: "REJECTED_INVALID_POOL_METADATA",
    };
  }

  if (bridgeResult.status === "AVAILABLE_QUALIFIED" && bridgeResult.lpBurnPct !== null) {
    return {
      ok: true,
      pool: {
        ...candidate,
        lpBurnPct: bridgeResult.lpBurnPct,
        metricProvenance: {
          ...candidate.metricProvenance,
          lpBurnPct: "DERIVED",
        },
      },
      status: "AVAILABLE_QUALIFIED",
      lpBurnPct: bridgeResult.lpBurnPct,
      metricProvenance: "DERIVED",
    };
  }

  if (bridgeResult.status === "AVAILABLE_BELOW_THRESHOLD" && bridgeResult.lpBurnPct !== null) {
    return {
      ok: false,
      pool: {
        ...candidate,
        lpBurnPct: bridgeResult.lpBurnPct,
        metricProvenance: {
          ...candidate.metricProvenance,
          lpBurnPct: "DERIVED",
        },
      },
      status: "AVAILABLE_BELOW_THRESHOLD",
      lpBurnPct: bridgeResult.lpBurnPct,
      metricProvenance: "DERIVED",
      failureReason: "REJECTED_UNLOCKED_LP_RISK",
    };
  }

  // Unavailable, stale, invalid, or mismatched evidence:
  // Explicit failure with no normal numeric pool record (pool: null)
  return {
    ok: false,
    pool: null,
    status: bridgeResult.status as
      | "UNAVAILABLE"
      | "INVALID_EVIDENCE"
      | "IDENTITY_MISMATCH"
      | "STALE_EVIDENCE",
    lpBurnPct: null,
    metricProvenance: "UNAVAILABLE",
    failureReason:
      (bridgeResult.filterEvaluation.reason as CandidateScannerRejectionReason) ??
      "REJECTED_UNLOCKED_LP_RISK",
  };
}

/**
 * Projects a validated bridge screening result into a ScannedPoolRecord.
 *
 * Delegates to projectBridgedLpPool() to ensure the projection boundary cannot be bypassed.
 * Returns null if evidence is unavailable, invalid, stale, or mismatched.
 * Returns updated ScannedPoolRecord only when evidence is available (qualified or below-threshold).
 */
export function bridgeLpEvidenceToScannedPool(
  pool: ScannedPoolRecord,
  bridgeResult: LpBridgeScreeningResult,
): ScannedPoolRecord | null {
  const projection = projectBridgedLpPool(pool, bridgeResult);
  return projection.pool;
}

/**
 * Checks whether LP accounting evidence is genuinely available on a candidate pool record.
 * Distinguishes observed 0% (DERIVED/OBSERVED) from unavailable data (UNAVAILABLE/missing/null).
 */
export function isLpEvidenceAvailable(pool: ScannedPoolRecord | null | undefined): boolean {
  if (!pool) return false;
  return (
    pool.metricProvenance?.lpBurnPct === "DERIVED" ||
    pool.metricProvenance?.lpBurnPct === "OBSERVED"
  );
}
