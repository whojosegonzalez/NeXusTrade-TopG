/**
 * Phase 12.94-D Milestone D.3.3: Offline LP-Screening Bridge
 *
 * Implements the offline integration bridge connecting validated Raydium AMM v4 LP evidence
 * to the candidate scanner's LP screening evaluation.
 *
 * Requirements:
 * 1. Strict Identity Binding:
 *    Binds evidence strictly to the candidate pool ID and token mint. Rejects mismatches fail-closed (IDENTITY_MISMATCH).
 * 2. Preserve Raw Accounting & Provenance:
 *    Preserves raw BigInt quantities (protocolLp, circulatingSupply, rawInaccessibleLp, rawDenominator),
 *    exact derivation method ("RAYDIUM_AMM_V4_LP_RESERVE_VS_SUPPLY"), retrieval timestamp, context slot,
 *    and origin ("CAPTURED_RPC" | "SYNTHETIC_FIXTURE" | "UNKNOWN").
 * 3. Metric Provenance Classification:
 *    Classifies valid bridged evidence as DERIVED from validated account observations
 *    (metricProvenance.lpBurnPct = "DERIVED"). Missing/invalid evidence is classified as "UNAVAILABLE".
 * 4. Explicit Status Categorization:
 *    - AVAILABLE_QUALIFIED (fresh, matching, >= 90.0%)
 *    - AVAILABLE_BELOW_THRESHOLD (fresh, matching, < 90.0%, e.g. RAY/WSOL)
 *    - IDENTITY_MISMATCH (wrong poolId or mintAddress)
 *    - STALE_EVIDENCE (age exceeds mandatory freshness policy or unverifiable timestamp)
 *    - INVALID_EVIDENCE (corrupt payload, calculation failure, or invalid structure)
 *    - UNAVAILABLE (null or undefined evidence)
 * 5. Mandatory Freshness Policy:
 *    Enforces an explicit maxEvidenceAgeMs. Historical captures are prevented from becoming current market inputs.
 * 6. Pure Integer Arithmetic:
 *    Evaluates the 90% threshold via exact BigInt cross-multiplication: 100n * (L - S) >= 90n * L.
 * 7. Fail-Closed on Missing Evidence:
 *    Missing evidence evaluates to UNAVAILABLE with passed: false. Never substitutes 100% or default pass.
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
  type EvidenceOrigin,
  type RaydiumAmmV4SnapshotValidationSuccess,
} from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";
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
  /** Maximum allowable age of evidence in milliseconds (must be a finite positive number) */
  readonly maxEvidenceAgeMs: number;
  /** Injectable current timestamp for deterministic offline testing (defaults to Date.now()) */
  readonly currentTimestampMs?: number | undefined;
  /** Clock skew tolerance in milliseconds (defaults to 5,000 ms) */
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
  readonly passed: boolean;
  readonly admitted: boolean;
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
}

export type GenericLpEvidenceShape = {
  readonly poolId?: string | undefined;
  readonly mintAddress?: string | undefined;
  readonly tokenMint?: string | undefined;
  readonly expectedTokenMint?: string | undefined;
  readonly protocolLp?: bigint | string | number | undefined;
  readonly circulatingSupply?: bigint | string | number | undefined;
  readonly retrievedAtIso?: string | null | undefined;
  readonly contextSlot?: number | null | undefined;
  readonly slot?: number | null | undefined;
  readonly evidenceOrigin?: EvidenceOrigin | undefined;
  readonly isSyntheticFixture?: boolean | null | undefined;
  readonly [key: string]: unknown;
};

export type LpEvidenceInput =
  | SnapshotAcquisitionEvidence
  | RaydiumAmmV4SnapshotValidationSuccess
  | GenericLpEvidenceShape
  | { readonly evidence: SnapshotAcquisitionEvidence }
  | null
  | undefined;

interface NormalizedEvidence {
  readonly poolId: string | null;
  readonly tokenMint: string | null;
  readonly protocolLp: bigint | null;
  readonly circulatingSupply: bigint | null;
  readonly retrievedAtIso: string | null;
  readonly contextSlot: number | null;
  readonly evidenceOrigin: EvidenceOrigin | null;
  readonly isSyntheticFixture: boolean | null;
  readonly isStructurallyValid: boolean;
  readonly structuralError: string | null;
  readonly cachedAccounting?: AmmV4LpAccountingSuccess | undefined;
}

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

function extractNormalizedEvidence(input: LpEvidenceInput): NormalizedEvidence | null {
  if (input === null || input === undefined) {
    return null;
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
      poolId: null,
      tokenMint: null,
      protocolLp: null,
      circulatingSupply: null,
      retrievedAtIso: null,
      contextSlot: null,
      evidenceOrigin: null,
      isSyntheticFixture: null,
      isStructurallyValid: false,
      structuralError: "Evidence payload is not an object",
    };
  }

  const obj = raw as Record<string, unknown>;

  // Branch A: SnapshotAcquisitionEvidence
  if (obj.command === "RaydiumAmmV4SnapshotAcquisition" || ("config" in obj && "outcomes" in obj)) {
    const config = (obj.config as Record<string, unknown> | undefined) ?? {};
    const discovered = (obj.discoveredIdentities as Record<string, unknown> | undefined) ?? {};
    const outcomes = (obj.outcomes as Record<string, unknown> | undefined) ?? {};
    const contextSlots = (obj.contextSlots as Record<string, unknown> | undefined) ?? {};
    const accountingObj = (obj.accounting as Record<string, unknown> | undefined) ?? {};
    const validationResult = (obj.validationResult as Record<string, unknown> | undefined) ?? {};

    const poolId =
      (typeof discovered.poolId === "string" ? discovered.poolId : null) ??
      (typeof config.poolId === "string" ? config.poolId : null);

    const tokenMint =
      (typeof discovered.expectedTokenMint === "string" ? discovered.expectedTokenMint : null) ??
      (typeof config.expectedTokenMint === "string" ? config.expectedTokenMint : null);

    const contextSlot =
      typeof contextSlots.batchSlot === "number"
        ? contextSlots.batchSlot
        : typeof contextSlots.bootstrapSlot === "number"
          ? contextSlots.bootstrapSlot
          : null;

    const retrievedAtIso = typeof obj.retrievedAtIso === "string" ? obj.retrievedAtIso : null;
    const evidenceOrigin = (
      typeof obj.evidenceOrigin === "string" ? obj.evidenceOrigin : null
    ) as EvidenceOrigin | null;
    const isSyntheticFixture =
      typeof obj.isSyntheticFixture === "boolean" ? obj.isSyntheticFixture : null;

    const isStructurallyValid =
      outcomes.structuralValidationOk !== false &&
      outcomes.retrievalOk !== false &&
      validationResult.ok !== false &&
      accountingObj.ok !== false;

    const structuralError =
      typeof obj.failureReason === "string"
        ? obj.failureReason
        : isStructurallyValid
          ? null
          : "Acquisition structural validation failed";

    const protocolLp = toBigIntSafe(accountingObj.protocolLp);
    const circulatingSupply = toBigIntSafe(accountingObj.circulatingSupply);

    return {
      poolId,
      tokenMint,
      protocolLp,
      circulatingSupply,
      retrievedAtIso,
      contextSlot,
      evidenceOrigin,
      isSyntheticFixture,
      isStructurallyValid,
      structuralError,
    };
  }

  // Branch B: RaydiumAmmV4SnapshotValidationSuccess (from validateRaydiumAmmV4Snapshot)
  if ("diagnostics" in obj && "accounting" in obj && "evidenceBoundary" in obj) {
    const diag = (obj.diagnostics as Record<string, unknown> | undefined) ?? {};
    const reqIdentities = (diag.requestedIdentities as Record<string, unknown> | undefined) ?? {};
    const accountingObj = (obj.accounting as Record<string, unknown> | undefined) ?? {};

    const poolId = typeof reqIdentities.poolId === "string" ? reqIdentities.poolId : null;
    const tokenMint =
      typeof reqIdentities.expectedTokenMint === "string" ? reqIdentities.expectedTokenMint : null;
    const contextSlot = typeof diag.slot === "number" ? diag.slot : null;
    const retrievedAtIso = typeof diag.retrievedAtIso === "string" ? diag.retrievedAtIso : null;
    const evidenceOrigin = (
      typeof diag.evidenceOrigin === "string" ? diag.evidenceOrigin : null
    ) as EvidenceOrigin | null;
    const isSyntheticFixture =
      typeof diag.isSyntheticFixture === "boolean" ? diag.isSyntheticFixture : null;

    const protocolLp = toBigIntSafe(accountingObj.protocolLp);
    const circulatingSupply = toBigIntSafe(accountingObj.circulatingSupply);

    return {
      poolId,
      tokenMint,
      protocolLp,
      circulatingSupply,
      retrievedAtIso,
      contextSlot,
      evidenceOrigin,
      isSyntheticFixture,
      isStructurallyValid: obj.ok === true && protocolLp !== null && circulatingSupply !== null,
      structuralError: obj.ok === true ? null : "Snapshot validation result indicates failure",
    };
  }

  // Branch C: Generic LP evidence shape
  const poolId = typeof obj.poolId === "string" ? obj.poolId : null;
  const tokenMint =
    typeof obj.tokenMint === "string"
      ? obj.tokenMint
      : typeof obj.mintAddress === "string"
        ? obj.mintAddress
        : typeof obj.expectedTokenMint === "string"
          ? obj.expectedTokenMint
          : null;

  const protocolLp = toBigIntSafe(obj.protocolLp);
  const circulatingSupply = toBigIntSafe(obj.circulatingSupply);
  const retrievedAtIso = typeof obj.retrievedAtIso === "string" ? obj.retrievedAtIso : null;
  const contextSlot =
    typeof obj.contextSlot === "number"
      ? obj.contextSlot
      : typeof obj.slot === "number"
        ? obj.slot
        : null;

  const evidenceOrigin = (
    typeof obj.evidenceOrigin === "string" ? obj.evidenceOrigin : null
  ) as EvidenceOrigin | null;
  const isSyntheticFixture =
    typeof obj.isSyntheticFixture === "boolean" ? obj.isSyntheticFixture : null;

  return {
    poolId,
    tokenMint,
    protocolLp,
    circulatingSupply,
    retrievedAtIso,
    contextSlot,
    evidenceOrigin,
    isSyntheticFixture,
    isStructurallyValid: protocolLp !== null && circulatingSupply !== null,
    structuralError:
      protocolLp === null || circulatingSupply === null
        ? "Missing or unparseable protocolLp / circulatingSupply quantities"
        : null,
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
 * anti-rug evaluation criteria while maintaining strict isolation, identity binding,
 * freshness enforcement, and exact integer arithmetic.
 */
export function evaluateLpScreeningBridge(
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  evidence: LpEvidenceInput,
  freshnessPolicy: LpFreshnessPolicy,
): LpBridgeScreeningResult {
  // Validate freshness policy parameters strictly
  if (
    typeof freshnessPolicy?.maxEvidenceAgeMs !== "number" ||
    !Number.isFinite(freshnessPolicy.maxEvidenceAgeMs) ||
    freshnessPolicy.maxEvidenceAgeMs <= 0
  ) {
    throw new Error(
      `Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number, got ${freshnessPolicy?.maxEvidenceAgeMs}`,
    );
  }

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
      admitted: false,
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
    };
  }

  // 2. Extract and Normalize Evidence Fields
  const extracted = extractNormalizedEvidence(evidence);
  if (
    !extracted ||
    !extracted.isStructurallyValid ||
    extracted.protocolLp === null ||
    extracted.circulatingSupply === null
  ) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "INVALID_EVIDENCE",
      reason:
        extracted?.structuralError ??
        "Evidence structural validation failed or quantities unparseable",
    });

    return {
      status: "INVALID_EVIDENCE",
      available: false,
      passed: false,
      admitted: false,
      lpBurnPct: null,
      meetsNinetyPercentThreshold: false,
      rawAccounting: null,
      derivationMethod: null,
      retrievedAtIso: extracted?.retrievedAtIso ?? null,
      contextSlot: extracted?.contextSlot ?? null,
      evidenceOrigin: extracted?.evidenceOrigin ?? null,
      isSyntheticFixture: extracted?.isSyntheticFixture ?? null,
      metricProvenance: "UNAVAILABLE",
      filterEvaluation,
      diagnosticMessage: `LP accounting evidence is structurally invalid: ${extracted?.structuralError ?? "malformed payload"}`,
    };
  }

  // 3. Strict Identity Binding
  const poolMatches = extracted.poolId !== null && candidate.poolId === extracted.poolId;
  const mintMatches = extracted.tokenMint === null || candidate.mintAddress === extracted.tokenMint;

  if (!poolMatches || !mintMatches) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_INVALID_POOL_METADATA", {
      status: "IDENTITY_MISMATCH",
      candidatePoolId: candidate.poolId,
      candidateMintAddress: candidate.mintAddress,
      evidencePoolId: extracted.poolId,
      evidenceTokenMint: extracted.tokenMint,
    });

    return {
      status: "IDENTITY_MISMATCH",
      available: false,
      passed: false,
      admitted: false,
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
      diagnosticMessage: `Identity mismatch: candidate (${candidate.poolId}/${candidate.mintAddress}) does not match evidence (${extracted.poolId}/${extracted.tokenMint})`,
    };
  }

  // 4. Strict Freshness Policy Enforcement
  if (extracted.retrievedAtIso === null || !isValidIsoCalendarTimestamp(extracted.retrievedAtIso)) {
    const filterEvaluation = buildFilterEvaluation(false, "REJECTED_UNLOCKED_LP_RISK", {
      status: "STALE_EVIDENCE",
      reason:
        "Missing or invalid retrieval timestamp; historical captures cannot qualify candidate",
      retrievedAtIso: extracted.retrievedAtIso,
    });

    return {
      status: "STALE_EVIDENCE",
      available: false,
      passed: false,
      admitted: false,
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
      diagnosticMessage:
        "LP evidence has missing or unparseable retrieval timestamp; rejected as unverifiable",
    };
  }

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
      admitted: false,
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
      admitted: false,
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
      admitted: false,
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
      admitted: true,
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
    admitted: false,
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
  };
}

/**
 * Bridges validated LP evidence into an updated ScannedPoolRecord.
 *
 * If evidence is available (qualified or below-threshold), updates `lpBurnPct`
 * to the derived display percentage and marks `metricProvenance.lpBurnPct` as "DERIVED".
 *
 * If evidence is unavailable, invalid, mismatched, or stale, sets `lpBurnPct` to 0
 * (fail-closed) and marks `metricProvenance.lpBurnPct` as "UNAVAILABLE".
 * Never substitutes 100% or default passes.
 */
export function bridgeLpEvidenceToScannedPool(
  pool: ScannedPoolRecord,
  bridgeResult: LpBridgeScreeningResult,
): ScannedPoolRecord {
  const isAvailable = bridgeResult.available && bridgeResult.lpBurnPct !== null;

  return {
    ...pool,
    lpBurnPct: isAvailable ? bridgeResult.lpBurnPct! : 0,
    metricProvenance: {
      ...pool.metricProvenance,
      lpBurnPct: isAvailable ? "DERIVED" : "UNAVAILABLE",
    },
  };
}
