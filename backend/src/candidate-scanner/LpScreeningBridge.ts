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

import { createHash } from "node:crypto";
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
  type RaydiumAmmV4SnapshotIdentities,
  type RaydiumAmmV4SnapshotValidationResult,
  type RaydiumAmmV4SnapshotValidationSuccess,
} from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";
import { WSOL_MINT, isCanonicalSolanaBase58 } from "../research/pilot/RaydiumAmmParser.js";
export { isCanonicalSolanaBase58 };
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
 * Detects if an input evidence is an acquisition wrapper or contains HTTP transport records.
 */
export function isAcquisitionEvidence(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const raw: unknown =
    "evidence" in input && (input as { evidence: unknown }).evidence
      ? (input as { evidence: unknown }).evidence
      : input;
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return (
    obj.command === "RaydiumAmmV4SnapshotAcquisition" ||
    ("config" in obj && "outcomes" in obj && "contextSlots" in obj) ||
    ("requests" in obj && Array.isArray((obj as { requests: unknown }).requests))
  );
}

/**
 * Deep equality helper for verifying cached JSON against parsed stored response body.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

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
 * 6. Rejects loose scalar dictionaries or acquisition objects on direct extraction (acquisition evidence
 *    must be evaluated through evaluateLpScreeningBridge).
 */
function extractValidatedEvidence(input: ValidatedLpEvidenceInput): ExtractedValidatedEvidence {
  if (input === null || input === undefined) {
    return {
      ok: false,
      category: "UNAVAILABLE",
      error: "No LP accounting evidence provided",
    };
  }

  // Acquisition evidence must be evaluated via evaluateLpScreeningBridge with raw response validation
  if (isAcquisitionEvidence(input)) {
    return {
      ok: false,
      category: "INVALID_EVIDENCE",
      error:
        "Acquisition evidence requires raw-response revalidation via evaluateLpScreeningBridge; direct extraction is prohibited",
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

  // 2. Reject Acquisition Evidence on Synchronous Path
  // "Keep acquisition evidence on one authoritative public evaluation path.
  // The exported synchronous helper must not provide an alternate path that bypasses required raw-response checks."
  if (isAcquisitionEvidence(evidence)) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "INVALID_EVIDENCE",
      reason:
        "Acquisition evidence requires raw-response revalidation via evaluateLpScreeningBridge; synchronous helper does not evaluate raw transport evidence",
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
      derivationMethod: null,
      retrievedAtIso: null,
      contextSlot: null,
      evidenceOrigin: null,
      isSyntheticFixture: null,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage:
        "Acquisition evidence must be evaluated asynchronously via evaluateLpScreeningBridge to verify raw response hashes and decoded accounts",
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 3. Extract and Validate Evidence from the Verified Path
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

function buildInvalidEvidenceResult(
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  message: string,
): LpBridgeScreeningResult {
  const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
    status: "INVALID_EVIDENCE",
    reason: message,
  });

  return {
    status: "INVALID_EVIDENCE",
    available: false,
    passed: false,
    lpFilterPassed: false,
    evaluatedCandidate: { poolId: candidate.poolId, mintAddress: candidate.mintAddress },
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
    diagnosticMessage: `LP accounting evidence is invalid: ${message}`,
    evidenceBoundary: { strategyGateAdmitted: false },
  };
}

/**
 * Authoritative evaluation path for acquisition evidence.
 *
 * Rules:
 * 1. Stored response body (rawResponseBody) is the authoritative representation.
 * 2. Verifies storedResponseSha256 and wireResponseSha256.
 * 3. Catches malformed JSON safely without throwing and returns INVALID_EVIDENCE.
 * 4. Compares retained parsedJson with the decoded response and rejects divergence.
 * 5. Revalidates the decoded accounts via the accepted validator validateRaydiumAmmV4Snapshot.
 * 6. Rejects slot disagreements between recorded response slot and reported context slots.
 * 7. Rejects quantity and identity disagreements.
 * 8. Evaluates freshness and the 90% threshold.
 */
async function evaluateAcquisitionEvidenceAsync(
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  evidence: ValidatedLpEvidenceInput,
  freshnessPolicy: LpFreshnessPolicy,
): Promise<LpBridgeScreeningResult> {
  const candPoolId = typeof candidate?.poolId === "string" ? candidate.poolId.trim() : "";
  const candMintAddress =
    typeof candidate?.mintAddress === "string" ? candidate.mintAddress.trim() : "";

  const evaluatedCandidate = Object.freeze({
    poolId: candPoolId,
    mintAddress: candMintAddress,
  });

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
      retrievedAtIso: null,
      contextSlot: null,
      evidenceOrigin: null,
      isSyntheticFixture: null,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: "Candidate has missing poolId or mintAddress",
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // Unwrap wrapped acquisition evidence
  const raw: unknown =
    typeof evidence === "object" &&
    evidence !== null &&
    "evidence" in evidence &&
    (evidence as { evidence: unknown }).evidence
      ? (evidence as { evidence: unknown }).evidence
      : evidence;

  if (typeof raw !== "object" || raw === null) {
    return buildInvalidEvidenceResult(evaluatedCandidate, "Acquisition evidence is not an object");
  }

  const acq = raw as SnapshotAcquisitionEvidence;

  // 1. Verify acquisition outcomes
  const outcomes = acq.outcomes as Record<string, unknown> | undefined;
  if (!outcomes || outcomes.structuralValidationOk !== true || outcomes.retrievalOk !== true) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      "Acquisition outcomes indicate structural validation or retrieval failure (or outcomes omitted)",
    );
  }

  // 1b. Verify validationResult and accounting assertions
  const valRes = acq.validationResult as unknown as Record<string, unknown> | undefined;
  if (!valRes || typeof valRes !== "object" || valRes.ok !== true) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      "Acquisition evidence lacks a verified successful validationResult assertion",
    );
  }

  const acqAcc = acq.accounting as unknown as Record<string, unknown> | undefined;
  if (!acqAcc || typeof acqAcc !== "object" || acqAcc.ok !== true) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      "Acquisition evidence lacks a verified successful accounting assertion",
    );
  }

  // 2. Verify requests array
  if (!Array.isArray(acq.requests) || acq.requests.length < 2) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      "Acquisition evidence missing required HTTP requests record [getAccountInfo, getMultipleAccounts]",
    );
  }

  const req1 = acq.requests[0];
  const req2 = acq.requests[1];

  if (!req2 || typeof req2 !== "object") {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      "Acquisition request 2 record is missing or invalid",
    );
  }

  if (req2.method !== "getMultipleAccounts") {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Acquisition request 2 method must be getMultipleAccounts, received '${req2.method}'`,
    );
  }

  // 3. Stored response body is authoritative
  if (typeof req2.rawResponseBody !== "string" || req2.rawResponseBody.trim().length === 0) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      "Acquisition evidence request 2 missing rawResponseBody string",
    );
  }

  // 4. Verify storedResponseSha256 and wireResponseSha256
  const computedStoredSha256 = createHash("sha256").update(req2.rawResponseBody).digest("hex");

  if (
    typeof req2.storedResponseSha256 !== "string" ||
    req2.storedResponseSha256 !== computedStoredSha256
  ) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Stored response hash mismatch for request 2: expected '${req2.storedResponseSha256}', computed '${computedStoredSha256}'`,
    );
  }

  if (!req2.wasRedacted) {
    if (
      typeof req2.wireResponseSha256 !== "string" ||
      req2.wireResponseSha256 !== req2.storedResponseSha256 ||
      req2.wireResponseSha256 !== computedStoredSha256
    ) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        `Wire response hash mismatch for unredacted request 2: wire '${req2.wireResponseSha256}' does not match stored hash '${req2.storedResponseSha256}'`,
      );
    }
  } else {
    if (
      typeof req2.wireResponseSha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(req2.wireResponseSha256)
    ) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        "Invalid wireResponseSha256 format for redacted request 2",
      );
    }
  }

  // Verify Request 1 if rawResponseBody is retained
  if (req1 && typeof req1.rawResponseBody === "string" && req1.rawResponseBody.length > 0) {
    const computedReq1Sha256 = createHash("sha256").update(req1.rawResponseBody).digest("hex");
    if (req1.storedResponseSha256 !== computedReq1Sha256) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        `Stored response hash mismatch for request 1: expected '${req1.storedResponseSha256}', computed '${computedReq1Sha256}'`,
      );
    }
    if (!req1.wasRedacted && req1.wireResponseSha256 !== req1.storedResponseSha256) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        `Wire response hash mismatch for unredacted request 1: wire '${req1.wireResponseSha256}' does not match stored hash '${req1.storedResponseSha256}'`,
      );
    }
  }

  // 5. Safely parse rawResponseBody
  let decodedPayload: Record<string, unknown>;
  try {
    decodedPayload = JSON.parse(req2.rawResponseBody);
    if (typeof decodedPayload !== "object" || decodedPayload === null) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        "Decoded request 2 payload is not a valid JSON object",
      );
    }
  } catch (parseErr) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Malformed JSON in stored response body for request 2: ${(parseErr as Error).message}`,
    );
  }

  // 6. If parsedJson is retained, reject disagreement between cache and decoded stored response
  if (req2.parsedJson !== null && req2.parsedJson !== undefined) {
    if (typeof req2.parsedJson !== "object") {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        "Retained parsedJson in request 2 must be an object",
      );
    }
    if (!deepEqual(req2.parsedJson, decodedPayload)) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        "Retained parsedJson disagrees with decoded rawResponseBody in request 2",
      );
    }
  }

  // 7. Validate through accepted validator
  const identities: RaydiumAmmV4SnapshotIdentities = acq.discoveredIdentities ??
    (acq.validationResult && acq.validationResult.ok
      ? acq.validationResult.diagnostics.requestedIdentities
      : null) ?? {
      poolId: candPoolId,
      lpMint: "",
      baseVault: "",
      quoteVault: "",
      expectedTokenMint: candMintAddress,
    };

  let revalidated: RaydiumAmmV4SnapshotValidationResult;
  try {
    revalidated = await validateRaydiumAmmV4Snapshot(identities, decodedPayload, {
      evidenceOrigin: acq.evidenceOrigin ?? undefined,
      isSyntheticFixture: acq.isSyntheticFixture ?? undefined,
      retrievedAtIso: acq.retrievedAtIso ?? undefined,
    });
  } catch (valErr) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Revalidation against accepted validator threw error: ${(valErr as Error).message}`,
    );
  }

  if (!revalidated.ok) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Retained final raw batch failed validation against accepted validator: ${revalidated.message}`,
    );
  }

  // 8. Reject context slot inconsistency
  const recordedSlot = revalidated.diagnostics.slot;
  const acqBatchSlot = acq.contextSlots?.batchSlot;
  const valResultSlot =
    acq.validationResult && acq.validationResult.ok ? acq.validationResult.diagnostics.slot : null;

  if (acqBatchSlot !== undefined && acqBatchSlot !== recordedSlot) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Context slot inconsistency: acquisition wrapper batchSlot (${acqBatchSlot}) disagrees with recorded response slot (${recordedSlot})`,
    );
  }

  if (valResultSlot !== null && valResultSlot !== recordedSlot) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Context slot inconsistency: validationResult slot (${valResultSlot}) disagrees with recorded response slot (${recordedSlot})`,
    );
  }

  // 9. Reject quantity inconsistency
  const decodedPool = revalidated.diagnostics.poolState;
  const decodedLpMint = revalidated.diagnostics.lpMintState;

  const derivedAccounting = calculateAmmV4LpInaccessibleClaims(
    decodedPool.lpReserve,
    decodedLpMint.supply,
  );

  if (!derivedAccounting.ok) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Accounting calculation failed on recorded accounts: ${derivedAccounting.message}`,
    );
  }

  if (acq.validationResult && acq.validationResult.ok) {
    const valAcc = acq.validationResult.accounting;
    if (
      toBigIntSafe(valAcc.protocolLp) !== derivedAccounting.protocolLp ||
      toBigIntSafe(valAcc.circulatingSupply) !== derivedAccounting.circulatingSupply ||
      toBigIntSafe(valAcc.rawInaccessibleLp) !== derivedAccounting.rawInaccessibleLp ||
      toBigIntSafe(valAcc.rawDenominator) !== derivedAccounting.rawDenominator ||
      valAcc.meetsNinetyPercentThreshold !== derivedAccounting.meetsNinetyPercentThreshold
    ) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        "Inconsistency detected: validationResult.accounting summary does not match recorded accounts",
      );
    }
  }

  if (acq.accounting) {
    const acqAcc = acq.accounting;
    if (
      toBigIntSafe(acqAcc.protocolLp) !== derivedAccounting.protocolLp ||
      toBigIntSafe(acqAcc.circulatingSupply) !== derivedAccounting.circulatingSupply ||
      toBigIntSafe(acqAcc.rawInaccessibleLp) !== derivedAccounting.rawInaccessibleLp ||
      toBigIntSafe(acqAcc.rawDenominator) !== derivedAccounting.rawDenominator ||
      acqAcc.meetsNinetyPercentThreshold !== derivedAccounting.meetsNinetyPercentThreshold ||
      (acq.outcomes &&
        acq.outcomes.meetsNinetyPercentThreshold !== derivedAccounting.meetsNinetyPercentThreshold)
    ) {
      return buildInvalidEvidenceResult(
        evaluatedCandidate,
        "Inconsistency detected: acquisition.accounting wrapper does not match recorded accounts",
      );
    }
  }

  // 10. Reject identity mismatch
  if (decodedPool.poolAddress !== candPoolId) {
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
      retrievedAtIso: null,
      contextSlot: recordedSlot,
      evidenceOrigin: revalidated.diagnostics.evidenceOrigin,
      isSyntheticFixture: revalidated.diagnostics.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation: buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
        status: "IDENTITY_MISMATCH",
        candidatePoolId: candPoolId,
        evidencePoolId: decodedPool.poolAddress,
      }),
      diagnosticMessage: `Identity mismatch: candidate poolId (${candPoolId}) does not match recorded pool address (${decodedPool.poolAddress})`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  if (decodedPool.baseMint !== candMintAddress && decodedPool.quoteMint !== candMintAddress) {
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
      retrievedAtIso: null,
      contextSlot: recordedSlot,
      evidenceOrigin: revalidated.diagnostics.evidenceOrigin,
      isSyntheticFixture: revalidated.diagnostics.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation: buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
        status: "IDENTITY_MISMATCH",
        candidateMintAddress: candMintAddress,
        evidenceBaseMint: decodedPool.baseMint,
        evidenceQuoteMint: decodedPool.quoteMint,
      }),
      diagnosticMessage: `Identity mismatch: candidate mintAddress (${candMintAddress}) does not match decoded pool baseMint (${decodedPool.baseMint}) or quoteMint (${decodedPool.quoteMint})`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  if (acq.config?.poolId && acq.config.poolId !== candPoolId) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Acquisition config.poolId (${acq.config.poolId}) does not match candidate poolId (${candPoolId})`,
    );
  }

  if (acq.config?.expectedTokenMint && acq.config.expectedTokenMint !== candMintAddress) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Acquisition config.expectedTokenMint (${acq.config.expectedTokenMint}) does not match candidate mint (${candMintAddress})`,
    );
  }

  if (acq.discoveredIdentities?.poolId && acq.discoveredIdentities.poolId !== candPoolId) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Acquisition discoveredIdentities.poolId (${acq.discoveredIdentities.poolId}) does not match candidate poolId (${candPoolId})`,
    );
  }

  if (
    acq.discoveredIdentities?.expectedTokenMint &&
    acq.discoveredIdentities.expectedTokenMint !== candMintAddress
  ) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Acquisition discoveredIdentities.expectedTokenMint (${acq.discoveredIdentities.expectedTokenMint}) does not match candidate mint (${candMintAddress})`,
    );
  }

  // 11. Freshness evaluation
  const currentNowMs = freshnessPolicy.currentTimestampMs ?? Date.now();
  const retrievedAtIso = revalidated.diagnostics.retrievedAtIso;

  if (!retrievedAtIso || !isValidIsoCalendarTimestamp(retrievedAtIso)) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Missing or invalid retrievedAtIso in revalidated diagnostics: ${retrievedAtIso}`,
    );
  }

  if (acq.retrievedAtIso && acq.retrievedAtIso !== retrievedAtIso) {
    return buildInvalidEvidenceResult(
      evaluatedCandidate,
      `Acquisition retrievedAtIso (${acq.retrievedAtIso}) does not match validation diagnostics retrievedAtIso (${retrievedAtIso})`,
    );
  }

  const retrievedAtMs = Date.parse(retrievedAtIso);
  const ageMs = currentNowMs - retrievedAtMs;
  const clockSkewToleranceMs =
    freshnessPolicy.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;

  if (ageMs < -clockSkewToleranceMs) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "INVALID_EVIDENCE",
      reason: `Evidence retrieval timestamp is in the future beyond tolerance: age ${ageMs}ms`,
      retrievedAtIso,
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
      retrievedAtIso,
      contextSlot: recordedSlot,
      evidenceOrigin: revalidated.diagnostics.evidenceOrigin,
      isSyntheticFixture: revalidated.diagnostics.isSyntheticFixture,
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
      retrievedAtIso,
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
      retrievedAtIso,
      contextSlot: recordedSlot,
      evidenceOrigin: revalidated.diagnostics.evidenceOrigin,
      isSyntheticFixture: revalidated.diagnostics.isSyntheticFixture,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `LP evidence is stale: age ${ageMs}ms exceeds maxEvidenceAgeMs ${freshnessPolicy.maxEvidenceAgeMs}ms`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  // 12. Threshold Result
  const rawAccounting: RawLpAccountingValues = {
    protocolLp: derivedAccounting.protocolLp,
    circulatingSupply: derivedAccounting.circulatingSupply,
    rawInaccessibleLp: derivedAccounting.rawInaccessibleLp,
    rawDenominator: derivedAccounting.rawDenominator,
  };

  if (derivedAccounting.meetsNinetyPercentThreshold) {
    const filterEvaluation = buildFilterEvaluation(true, undefined, {
      status: "AVAILABLE_QUALIFIED",
      lpBurnPct: derivedAccounting.displayInaccessiblePct,
      meetsNinetyPercentThreshold: true,
      protocolLp: derivedAccounting.protocolLp.toString(),
      circulatingSupply: derivedAccounting.circulatingSupply.toString(),
      rawInaccessibleLp: derivedAccounting.rawInaccessibleLp.toString(),
    });

    return {
      status: "AVAILABLE_QUALIFIED",
      available: true,
      passed: true,
      lpFilterPassed: true,
      evaluatedCandidate,
      lpBurnPct: derivedAccounting.displayInaccessiblePct,
      meetsNinetyPercentThreshold: true,
      rawAccounting,
      derivationMethod: LP_DERIVATION_METHOD,
      retrievedAtIso,
      contextSlot: recordedSlot,
      evidenceOrigin: revalidated.diagnostics.evidenceOrigin,
      isSyntheticFixture: revalidated.diagnostics.isSyntheticFixture,
      metricProvenance: "DERIVED",
      filterEvaluation,
      diagnosticMessage: `LP accounting qualified: ${derivedAccounting.displayInaccessiblePct.toFixed(6)}% inaccessible (>= 90% threshold)`,
      evidenceBoundary: { strategyGateAdmitted: false },
    };
  }

  const filterEvaluation = buildFilterEvaluation(false, "REJECTED_UNLOCKED_LP_RISK", {
    status: "AVAILABLE_BELOW_THRESHOLD",
    lpBurnPct: derivedAccounting.displayInaccessiblePct,
    minLpBurnPct: 90.0,
    meetsNinetyPercentThreshold: false,
    protocolLp: derivedAccounting.protocolLp.toString(),
    circulatingSupply: derivedAccounting.circulatingSupply.toString(),
    rawInaccessibleLp: derivedAccounting.rawInaccessibleLp.toString(),
  });

  return {
    status: "AVAILABLE_BELOW_THRESHOLD",
    available: true,
    passed: false,
    lpFilterPassed: false,
    evaluatedCandidate,
    lpBurnPct: derivedAccounting.displayInaccessiblePct,
    meetsNinetyPercentThreshold: false,
    rawAccounting,
    derivationMethod: LP_DERIVATION_METHOD,
    retrievedAtIso,
    contextSlot: recordedSlot,
    evidenceOrigin: revalidated.diagnostics.evidenceOrigin,
    isSyntheticFixture: revalidated.diagnostics.isSyntheticFixture,
    metricProvenance: "DERIVED",
    filterEvaluation,
    diagnosticMessage: `LP accounting below threshold: ${derivedAccounting.displayInaccessiblePct.toFixed(6)}% inaccessible (< 90% threshold)`,
    evidenceBoundary: { strategyGateAdmitted: false },
  };
}

/**
 * Asynchronous evaluation function for the offline LP-screening bridge.
 *
 * Authoritative Evaluation Architecture:
 * 1. For Acquisition Evidence (SnapshotAcquisitionEvidence):
 *    Executes the single authoritative async acquisition evaluation path.
 *    - Uses the retained rawResponseBody as the authoritative recorded representation.
 *    - Verifies storedResponseSha256 and wireResponseSha256.
 *    - Catches malformed JSON safely without throwing, returning INVALID_EVIDENCE.
 *    - Compares retained parsedJson with the decoded response and rejects divergence.
 *    - Revalidates the decoded accounts via the accepted validator validateRaydiumAmmV4Snapshot.
 *    - Rejects slot disagreements between recorded response slot and reported context slots.
 *    - Rejects quantity and identity disagreements.
 *    - Evaluates freshness and the 90% threshold.
 * 2. For Direct Snapshot Validation Results (RaydiumAmmV4SnapshotValidationSuccess):
 *    Evaluates decoded accounts and freshness via the synchronous path.
 */
export async function evaluateLpScreeningBridge(
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  evidence: ValidatedLpEvidenceInput,
  freshnessPolicy: LpFreshnessPolicy,
): Promise<LpBridgeScreeningResult> {
  // Validate entire freshness policy strictly (throws on NaN, nonfinite, negative skew)
  validateLpFreshnessPolicy(freshnessPolicy);

  // Missing evidence fails closed to UNAVAILABLE
  if (evidence === null || evidence === undefined) {
    return evaluateLpScreeningBridgeSync(candidate, evidence, freshnessPolicy);
  }

  // Acquisition evidence MUST run through authoritative async raw-response evaluation path
  if (isAcquisitionEvidence(evidence)) {
    return evaluateAcquisitionEvidenceAsync(candidate, evidence, freshnessPolicy);
  }

  // Direct snapshot validation result runs through synchronous evaluator
  return evaluateLpScreeningBridgeSync(candidate, evidence, freshnessPolicy);
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
