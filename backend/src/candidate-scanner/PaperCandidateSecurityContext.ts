/**
 * Phase 12.94-D D.3.3: Isolated PAPER candidate security context (offline composition; not installed).
 *
 * Composes the accepted security-evidence components into the existing screening and Gate 11 inputs
 * for one candidate, at an explicit decision time, under `PAPER_SIMULATION` only:
 *
 * - LP: `evaluateLpScreeningBridge` (Raydium AMM v4 LP accounting, exact integer 90% comparison),
 *   bound to the exact pool and mint.
 * - Authorities: `parseSolanaRpcMintAccountResponse` plus `evaluateAuthorityEvidence` on the raw
 *   jsonParsed info, bound to the requested mint. Only an explicitly observed null is DISABLED.
 * - RugCheck: `BuyGateTriggerService.validateRugCheckReportPayload` on a complete, successful
 *   response whose request and payload mint both match the requested mint.
 * - Bundler proxy: `parseSolanaTrackerBundlersResponse` plus `adaptPaperBundlerSnapshot`
 *   (`initialPercentage` proxy, current holdings kept separately, PROVIDER_REPORTED_UNVERIFIED).
 *
 * Boundaries:
 * - Pure: no provider requests, sockets, timers, file access, environment reads or daemon wiring.
 *   Evidence and the decision time are supplied by the caller. (The LP acquisition path is
 *   asynchronous because the accepted bridge revalidates raw responses asynchronously; it does no I/O.)
 * - No validation is reimplemented here; this module only binds identity, applies the existing
 *   explicit 15 s decision-time freshness policy, and maps existing results to gate inputs.
 * - Evidence is never re-stamped. Original retrieval times, slots and derivation details are preserved.
 * - Missing, malformed, mismatched, stale or future-dated evidence stays unavailable, and no field
 *   is ever filled with a favourable default.
 * - Valid security evidence alone never admits a candidate (`strategyGateAdmitted: false`).
 */

import type { TokenMintAddress } from "@nexustrade/shared";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";
import {
  evaluateAuthorityEvidence,
  type AuthorityEvaluation,
} from "./CandidateDecisionDiagnostic.js";
import {
  evaluateLpScreeningBridge,
  isCanonicalSolanaBase58,
  type LpBridgeScreeningResult,
  type LpScreeningStatus,
  type ValidatedLpEvidenceInput,
} from "./LpScreeningBridge.js";
import {
  adaptPaperBundlerSnapshot,
  type PaperBundlerAdaptationResult,
  type PaperBundlerProvenance,
} from "./PaperSolanaTrackerBundlerAdapter.js";
import {
  parseSolanaTrackerBundlersResponse,
  type SolanaTrackerBundlerParseErrorCode,
} from "./SolanaTrackerBundlerParser.js";
import {
  parseSolanaRpcMintAccountResponse,
  type SolanaRpcMintParseFailureCategory,
} from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";

/**
 * Fixed policy. `maxEvidenceAgeMs` is the existing explicit 15 s decision-time limit applied by the
 * diagnostic to LP, mint-account, RugCheck and bundler evidence (and the bundler adapter's limit).
 * LP clock-skew tolerance is 0 so future-dated LP evidence stays unavailable; it is not extended.
 */
export const PAPER_SECURITY_CONTEXT_POLICY = Object.freeze({
  executionContext: "PAPER_SIMULATION" as const,
  maxEvidenceAgeMs: 15_000,
  lpClockSkewToleranceMs: 0,
});

export interface PaperSecurityTarget {
  readonly poolId: string;
  readonly mintAddress: string;
}

/** Complete JSON-RPC `getAccountInfo` (jsonParsed) response for the requested mint account. */
export interface PaperMintAccountEvidence {
  /** The account address that was requested (request identity; the response does not repeat it). */
  readonly requestedMint: string;
  /** Original local retrieval time, as recorded by the caller. */
  readonly retrievedAtMs: number;
  readonly response: unknown;
}

/** One HTTP retrieval of token-level provider evidence (RugCheck report or Solana Tracker bundlers). */
export interface PaperProviderResponseEvidence {
  readonly requestedMint: string;
  readonly retrievedAtMs: number;
  readonly httpStatus: number;
  /** True only when the whole body was received within the caller's response limit. */
  readonly bodyComplete: boolean;
  /** Parsed JSON body, or null when the body was not JSON. */
  readonly payload: unknown;
}

export interface PaperCandidateSecurityEvidence {
  /** Pool-specific LP evidence (validated snapshot or acquisition evidence). */
  readonly lp?: ValidatedLpEvidenceInput;
  readonly mintAccount?: PaperMintAccountEvidence | null | undefined;
  readonly rugCheck?: PaperProviderResponseEvidence | null | undefined;
  readonly bundler?: PaperProviderResponseEvidence | null | undefined;
}

export interface EvaluatePaperCandidateSecurityParams {
  readonly executionContext: "PAPER_SIMULATION";
  readonly target: PaperSecurityTarget;
  /** Explicit decision time; all evidence is revalidated against it. */
  readonly decisionTimeMs: number;
  readonly evidence: PaperCandidateSecurityEvidence;
}

export type PaperSecurityContextStatus =
  | "EVALUATED"
  | "EXECUTION_CONTEXT_PROHIBITED"
  | "INVALID_TARGET"
  | "INVALID_DECISION_TIME";

/** Shared reasons for token-level evidence that cannot be used. */
export type PaperTokenEvidenceUnavailableReason =
  | "NOT_EVALUATED"
  | "EVIDENCE_MISSING"
  | "INVALID_RETRIEVAL_TIME"
  | "FUTURE_DATED_EVIDENCE"
  | "STALE_RETRIEVAL_EVIDENCE"
  | "REQUEST_IDENTITY_MISMATCH";

export interface PaperRetrievalProvenance {
  readonly requestedMint: string;
  readonly retrievedAtMs: number;
  readonly decisionTimeMs: number;
  readonly retrievalAgeMs: number;
}

export interface PaperLpSecurityResult {
  readonly status: LpScreeningStatus | "NOT_EVALUATED";
  readonly passed: boolean;
  readonly lpBurnPct: number | null;
  /** The accepted bridge result, unchanged (raw accounting, slot, retrieval time, origin). */
  readonly screening: LpBridgeScreeningResult | null;
  readonly unavailableReason: string | null;
}

export interface PaperAuthorityResult {
  readonly status:
    | "AVAILABLE"
    | PaperTokenEvidenceUnavailableReason
    | SolanaRpcMintParseFailureCategory
    | "RAW_PARSED_INFO_UNAVAILABLE";
  readonly mintAuthority: AuthorityEvaluation | null;
  readonly freezeAuthority: AuthorityEvaluation | null;
  readonly mintAuthorityPassed: boolean;
  readonly freezeAuthorityPassed: boolean;
  readonly provenance:
    | (PaperRetrievalProvenance & {
        readonly tokenProgram: string;
        readonly parser: string;
        readonly slot: number | null;
        readonly authorityDerivation: "RAW_JSON_PARSED_INFO_VIA_EVALUATE_AUTHORITY_EVIDENCE";
      })
    | null;
}

export interface PaperRugCheckMetrics {
  readonly rugScore?: number;
  readonly hasDangerRisk?: boolean;
  readonly top10HolderPct?: number;
  readonly holdersCount?: number;
}

export interface PaperRugCheckResult {
  readonly status:
    | "AVAILABLE"
    | PaperTokenEvidenceUnavailableReason
    | "REQUEST_NOT_OK"
    | "RESPONSE_INCOMPLETE"
    | "RESPONSE_NOT_JSON"
    | "PAYLOAD_MINT_MISSING"
    | "PAYLOAD_MINT_MISMATCH"
    | "VALIDATION_REJECTED";
  readonly metrics: PaperRugCheckMetrics | null;
  readonly provenance:
    | (PaperRetrievalProvenance & { readonly provider: "RUGCHECK"; readonly httpStatus: number })
    | null;
}

export interface PaperBundlerResult {
  readonly status:
    | "QUALIFIED_PAPER_PROXY"
    | Exclude<
        PaperTokenEvidenceUnavailableReason,
        "FUTURE_DATED_EVIDENCE" | "STALE_RETRIEVAL_EVIDENCE"
      >
    | "REQUEST_NOT_OK"
    | "RESPONSE_INCOMPLETE"
    | "RESPONSE_NOT_JSON"
    | `PARSE_FAILED:${SolanaTrackerBundlerParseErrorCode}`
    | `ADAPTER_REJECTED:${Exclude<PaperBundlerAdaptationResult["status"], "QUALIFIED_PAPER_PROXY">}`;
  /** Gate 11 proxy: the normalized launch allocation (`initialPercentage`), never current holdings. */
  readonly bundlerPct: number | undefined;
  /** Current holdings, retained separately and never used for Gate 11. */
  readonly currentHoldingPct: number | undefined;
  /** Adapter provenance, including the unverified-proxy disclosures. */
  readonly provenance: PaperBundlerProvenance | null;
  readonly adaptation: PaperBundlerAdaptationResult | null;
}

export interface PaperCandidateSecurityContextResult {
  readonly status: PaperSecurityContextStatus;
  readonly executionContext: unknown;
  readonly target: PaperSecurityTarget;
  /** The supplied decision time, or null when it was not a valid positive safe integer. */
  readonly decisionTimeMs: number | null;
  readonly policy: typeof PAPER_SECURITY_CONTEXT_POLICY;
  readonly lp: PaperLpSecurityResult;
  readonly authorities: PaperAuthorityResult;
  readonly rugCheck: PaperRugCheckResult;
  readonly bundler: PaperBundlerResult;
  /** LP and authority preconditions, with the diagnostic's existing rejection reasons. */
  readonly preAdmission: { readonly passed: boolean; readonly rejectionReason: string | null };
  /** Existing gate inputs. Unavailable metrics are absent, never defaulted. */
  readonly gateInputs: {
    /** Validated LP inaccessibility for `WatchlistCandidateItem.lpBurnPct`; null when unavailable. */
    readonly lpBurnPct: number | null;
    /** `rugMetrics` for the existing entry decision (Gate 11); `bundlerPct` only from the PAPER proxy. */
    readonly rugMetrics: (PaperRugCheckMetrics & { readonly bundlerPct?: number }) | null;
  };
  readonly evidenceBoundary: { readonly strategyGateAdmitted: false };
}

const NOT_EVALUATED_LP: PaperLpSecurityResult = Object.freeze({
  status: "NOT_EVALUATED",
  passed: false,
  lpBurnPct: null,
  screening: null,
  unavailableReason: "NOT_EVALUATED",
});
const NOT_EVALUATED_AUTHORITIES: PaperAuthorityResult = Object.freeze({
  status: "NOT_EVALUATED",
  mintAuthority: null,
  freezeAuthority: null,
  mintAuthorityPassed: false,
  freezeAuthorityPassed: false,
  provenance: null,
});
const NOT_EVALUATED_RUGCHECK: PaperRugCheckResult = Object.freeze({
  status: "NOT_EVALUATED",
  metrics: null,
  provenance: null,
});
const NOT_EVALUATED_BUNDLER: PaperBundlerResult = Object.freeze({
  status: "NOT_EVALUATED",
  bundlerPct: undefined,
  currentHoldingPct: undefined,
  provenance: null,
  adaptation: null,
});

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Request identity plus the existing 15 s decision-time freshness rule (no extension, no skew). */
function checkTokenRetrieval(
  evidence:
    | { readonly requestedMint?: unknown; readonly retrievedAtMs?: unknown }
    | null
    | undefined,
  mintAddress: string,
  decisionTimeMs: number,
):
  | { readonly ok: true; readonly provenance: PaperRetrievalProvenance }
  | { readonly ok: false; readonly reason: PaperTokenEvidenceUnavailableReason } {
  if (evidence === null || evidence === undefined || typeof evidence !== "object") {
    return { ok: false, reason: "EVIDENCE_MISSING" };
  }
  if (evidence.requestedMint !== mintAddress) {
    return { ok: false, reason: "REQUEST_IDENTITY_MISMATCH" };
  }
  if (!isSafeNonNegativeInteger(evidence.retrievedAtMs)) {
    return { ok: false, reason: "INVALID_RETRIEVAL_TIME" };
  }
  const retrievalAgeMs = decisionTimeMs - evidence.retrievedAtMs;
  if (retrievalAgeMs < 0) return { ok: false, reason: "FUTURE_DATED_EVIDENCE" };
  if (retrievalAgeMs > PAPER_SECURITY_CONTEXT_POLICY.maxEvidenceAgeMs) {
    return { ok: false, reason: "STALE_RETRIEVAL_EVIDENCE" };
  }
  return {
    ok: true,
    provenance: {
      requestedMint: mintAddress,
      retrievedAtMs: evidence.retrievedAtMs,
      decisionTimeMs,
      retrievalAgeMs,
    },
  };
}

async function evaluateLp(
  target: PaperSecurityTarget,
  evidence: ValidatedLpEvidenceInput,
  decisionTimeMs: number,
): Promise<PaperLpSecurityResult> {
  let screening: LpBridgeScreeningResult;
  try {
    screening = await evaluateLpScreeningBridge(target, evidence, {
      maxEvidenceAgeMs: PAPER_SECURITY_CONTEXT_POLICY.maxEvidenceAgeMs,
      currentTimestampMs: decisionTimeMs,
      clockSkewToleranceMs: PAPER_SECURITY_CONTEXT_POLICY.lpClockSkewToleranceMs,
    });
  } catch (err) {
    return {
      status: "INVALID_EVIDENCE",
      passed: false,
      lpBurnPct: null,
      screening: null,
      unavailableReason: `LP_BRIDGE_THREW: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // The bridge evaluated exactly this pool and mint; anything else is not this candidate's evidence.
  const boundToTarget =
    screening.evaluatedCandidate.poolId === target.poolId &&
    screening.evaluatedCandidate.mintAddress === target.mintAddress;
  const available =
    boundToTarget &&
    screening.available &&
    (screening.status === "AVAILABLE_QUALIFIED" ||
      screening.status === "AVAILABLE_BELOW_THRESHOLD");
  return {
    status: boundToTarget ? screening.status : "IDENTITY_MISMATCH",
    passed: available && screening.status === "AVAILABLE_QUALIFIED" && screening.lpFilterPassed,
    lpBurnPct: available ? screening.lpBurnPct : null,
    screening,
    unavailableReason: available ? null : screening.diagnosticMessage,
  };
}

function evaluateAuthorities(
  mintAddress: string,
  evidence: PaperMintAccountEvidence | null | undefined,
  decisionTimeMs: number,
): PaperAuthorityResult {
  const unavailable = (status: PaperAuthorityResult["status"]): PaperAuthorityResult => ({
    ...NOT_EVALUATED_AUTHORITIES,
    status,
  });
  const retrieval = checkTokenRetrieval(evidence, mintAddress, decisionTimeMs);
  if (!retrieval.ok) return unavailable(retrieval.reason);
  const mintEvidence = evidence as PaperMintAccountEvidence;

  const parsed = parseSolanaRpcMintAccountResponse(
    mintEvidence.response,
    mintAddress as TokenMintAddress,
    new Date(mintEvidence.retrievedAtMs),
    "JSON_PARSED",
  );
  if (!parsed.ok) return unavailable(parsed.category);
  // As in the diagnostic, authorities come from the raw jsonParsed info, not the parser's
  // normalized state (which treats an absent field as disabled).
  if (parsed.data.parser !== "JSON_PARSED") return unavailable("RAW_PARSED_INFO_UNAVAILABLE");
  const rawInfo = (
    mintEvidence.response as {
      result?: { value?: { data?: { parsed?: { info?: unknown } } } };
    }
  ).result?.value?.data?.parsed?.info;

  const mintAuthority = evaluateAuthorityEvidence(rawInfo, "mintAuthority");
  const freezeAuthority = evaluateAuthorityEvidence(rawInfo, "freezeAuthority");
  return {
    status: "AVAILABLE",
    mintAuthority,
    freezeAuthority,
    mintAuthorityPassed: mintAuthority.status === "DISABLED",
    freezeAuthorityPassed: freezeAuthority.status === "DISABLED",
    provenance: {
      ...retrieval.provenance,
      tokenProgram: parsed.data.tokenProgram,
      parser: parsed.data.parser,
      slot: parsed.data.slot ?? null,
      authorityDerivation: "RAW_JSON_PARSED_INFO_VIA_EVALUATE_AUTHORITY_EVIDENCE",
    },
  };
}

function checkProviderResponse(
  evidence: PaperProviderResponseEvidence,
): "REQUEST_NOT_OK" | "RESPONSE_INCOMPLETE" | "RESPONSE_NOT_JSON" | null {
  if (
    !Number.isSafeInteger(evidence.httpStatus) ||
    evidence.httpStatus < 200 ||
    evidence.httpStatus > 299
  ) {
    return "REQUEST_NOT_OK";
  }
  if (evidence.bodyComplete !== true) return "RESPONSE_INCOMPLETE";
  if (evidence.payload === null || typeof evidence.payload !== "object") {
    return "RESPONSE_NOT_JSON";
  }
  return null;
}

function evaluateRugCheck(
  mintAddress: string,
  evidence: PaperProviderResponseEvidence | null | undefined,
  decisionTimeMs: number,
): PaperRugCheckResult {
  const retrieval = checkTokenRetrieval(evidence, mintAddress, decisionTimeMs);
  if (!retrieval.ok) return { ...NOT_EVALUATED_RUGCHECK, status: retrieval.reason };
  const rcEvidence = evidence as PaperProviderResponseEvidence;
  const provenance = {
    ...retrieval.provenance,
    provider: "RUGCHECK" as const,
    httpStatus: rcEvidence.httpStatus,
  };
  const responseFailure = checkProviderResponse(rcEvidence);
  if (responseFailure) return { status: responseFailure, metrics: null, provenance };

  const payloadMint = (rcEvidence.payload as { mint?: unknown }).mint;
  if (typeof payloadMint !== "string") {
    return { status: "PAYLOAD_MINT_MISSING", metrics: null, provenance };
  }
  if (payloadMint !== mintAddress) {
    return { status: "PAYLOAD_MINT_MISMATCH", metrics: null, provenance };
  }

  const validated = BuyGateTriggerService.validateRugCheckReportPayload(rcEvidence.payload);
  if (!validated) return { status: "VALIDATION_REJECTED", metrics: null, provenance };
  // As in the diagnostic: RugCheck never supplies bundler concentration.
  const metrics: PaperRugCheckMetrics = Object.freeze({
    ...(validated.rugScore !== undefined ? { rugScore: validated.rugScore } : {}),
    ...(validated.hasDangerRisk !== undefined ? { hasDangerRisk: validated.hasDangerRisk } : {}),
    ...(validated.top10HolderPct !== undefined ? { top10HolderPct: validated.top10HolderPct } : {}),
    ...(validated.holdersCount !== undefined ? { holdersCount: validated.holdersCount } : {}),
  });
  return { status: "AVAILABLE", metrics, provenance };
}

function evaluateBundler(
  mintAddress: string,
  evidence: PaperProviderResponseEvidence | null | undefined,
  decisionTimeMs: number,
): PaperBundlerResult {
  if (evidence === null || evidence === undefined || typeof evidence !== "object") {
    return { ...NOT_EVALUATED_BUNDLER, status: "EVIDENCE_MISSING" };
  }
  if (evidence.requestedMint !== mintAddress) {
    return { ...NOT_EVALUATED_BUNDLER, status: "REQUEST_IDENTITY_MISMATCH" };
  }
  const responseFailure = checkProviderResponse(evidence);
  if (responseFailure) return { ...NOT_EVALUATED_BUNDLER, status: responseFailure };

  // The parser binds the snapshot to the requested mint and validates the retrieval time; the
  // adapter enforces the PAPER context, mint identity, causality and the 15 s retrieval age.
  const parsed = parseSolanaTrackerBundlersResponse(evidence.payload, {
    requestedMint: mintAddress,
    localRetrievedAtMs: evidence.retrievedAtMs,
  });
  if (!parsed.success) {
    return { ...NOT_EVALUATED_BUNDLER, status: `PARSE_FAILED:${parsed.error}` };
  }
  const adaptation = adaptPaperBundlerSnapshot({
    targetMint: mintAddress,
    snapshot: parsed.data,
    evaluationTimeMs: decisionTimeMs,
    executionContext: PAPER_SECURITY_CONTEXT_POLICY.executionContext,
    maxAllowedRetrievalAgeMs: PAPER_SECURITY_CONTEXT_POLICY.maxEvidenceAgeMs,
  });
  if (!adaptation.success) {
    return {
      ...NOT_EVALUATED_BUNDLER,
      status: `ADAPTER_REJECTED:${adaptation.status}`,
      adaptation,
    };
  }
  return {
    status: "QUALIFIED_PAPER_PROXY",
    bundlerPct: adaptation.bundlerPct,
    currentHoldingPct: adaptation.currentHoldingPct,
    provenance: adaptation.provenance,
    adaptation,
  };
}

/** The diagnostic's existing pre-admission rejection order and reasons (LP, freeze, mint). */
function preAdmissionRejection(
  lp: PaperLpSecurityResult,
  authorities: PaperAuthorityResult,
): string | null {
  if (!lp.passed) return "REJECTED_UNLOCKED_LP_RISK";
  const authorityReason = (evaluation: AuthorityEvaluation | null, kind: "FREEZE" | "MINT") => {
    if (evaluation === null || evaluation.status === "OMITTED") {
      return `REJECTED_UNKNOWN_${kind}_AUTHORITY`;
    }
    if (evaluation.status === "MALFORMED") return `REJECTED_MALFORMED_${kind}_AUTHORITY`;
    return `REJECTED_ACTIVE_${kind}_AUTHORITY`;
  };
  if (!authorities.freezeAuthorityPassed) {
    return authorityReason(authorities.freezeAuthority, "FREEZE");
  }
  if (!authorities.mintAuthorityPassed) return authorityReason(authorities.mintAuthority, "MINT");
  return null;
}

function finalize(
  base: Omit<
    PaperCandidateSecurityContextResult,
    "preAdmission" | "gateInputs" | "evidenceBoundary" | "policy"
  >,
): PaperCandidateSecurityContextResult {
  const rejectionReason =
    base.status === "EVALUATED" ? preAdmissionRejection(base.lp, base.authorities) : base.status;
  const rugMetrics =
    base.rugCheck.metrics !== null || base.bundler.bundlerPct !== undefined
      ? Object.freeze({
          ...(base.rugCheck.metrics ?? {}),
          ...(base.bundler.bundlerPct !== undefined ? { bundlerPct: base.bundler.bundlerPct } : {}),
        })
      : null;
  return Object.freeze({
    ...base,
    policy: PAPER_SECURITY_CONTEXT_POLICY,
    preAdmission: Object.freeze({ passed: rejectionReason === null, rejectionReason }),
    gateInputs: Object.freeze({ lpBurnPct: base.lp.lpBurnPct, rugMetrics }),
    evidenceBoundary: Object.freeze({ strategyGateAdmitted: false as const }),
  });
}

/**
 * Evaluates supplied security evidence for one candidate at an explicit decision time.
 * Requires `executionContext: "PAPER_SIMULATION"`; any other context evaluates nothing.
 */
export async function evaluatePaperCandidateSecurityContext(
  params: EvaluatePaperCandidateSecurityParams,
): Promise<PaperCandidateSecurityContextResult> {
  const executionContext: unknown = params?.executionContext;
  const target: PaperSecurityTarget = Object.freeze({
    poolId: typeof params?.target?.poolId === "string" ? params.target.poolId : "",
    mintAddress: typeof params?.target?.mintAddress === "string" ? params.target.mintAddress : "",
  });
  const suppliedDecisionTimeMs: unknown = params?.decisionTimeMs;
  const validDecisionTime =
    isSafeNonNegativeInteger(suppliedDecisionTimeMs) && suppliedDecisionTimeMs > 0;
  const decisionTimeMs = validDecisionTime ? suppliedDecisionTimeMs : null;
  const notEvaluated = (status: PaperSecurityContextStatus) =>
    finalize({
      status,
      executionContext,
      target,
      decisionTimeMs,
      lp: NOT_EVALUATED_LP,
      authorities: NOT_EVALUATED_AUTHORITIES,
      rugCheck: NOT_EVALUATED_RUGCHECK,
      bundler: NOT_EVALUATED_BUNDLER,
    });

  if (executionContext !== PAPER_SECURITY_CONTEXT_POLICY.executionContext) {
    return notEvaluated("EXECUTION_CONTEXT_PROHIBITED");
  }
  if (!isCanonicalSolanaBase58(target.poolId) || !isCanonicalSolanaBase58(target.mintAddress)) {
    return notEvaluated("INVALID_TARGET");
  }
  if (decisionTimeMs === null) {
    return notEvaluated("INVALID_DECISION_TIME");
  }

  const evidence = params.evidence ?? {};
  const lp = await evaluateLp(target, evidence.lp, decisionTimeMs);
  return finalize({
    status: "EVALUATED",
    executionContext,
    target,
    decisionTimeMs,
    lp,
    authorities: evaluateAuthorities(target.mintAddress, evidence.mintAccount, decisionTimeMs),
    rugCheck: evaluateRugCheck(target.mintAddress, evidence.rugCheck, decisionTimeMs),
    bundler: evaluateBundler(target.mintAddress, evidence.bundler, decisionTimeMs),
  });
}
