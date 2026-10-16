/**
 * Phase 12.94-D Milestone D.2.1: Clock Monotonicity & Quarantine Validator (D2-PREREQ-01)
 *
 * Implements authoritative validation for timestamp provenance, clock domains,
 * monotonic causal ordering, forward clock skew bounds, and quarantine classification.
 *
 * Invariants (D2-PREREQ-01):
 * 1. Finite positive timestamps for all mandatory events.
 * 2. Causal sequence: sourceTimestampMs <= ingestionTimestampMs <= responseReceivedMs <= decisionTimestampMs.
 * 3. Core requirement: responseReceivedMs >= sourceTimestampMs (cannot receive response before external event occurred).
 * 4. Bounded forward clock skew: sourceTimestampMs - ingestionTimestampMs <= MAX_FORWARD_CLOCK_SKEW_MS (5000ms).
 * 5. Strict rejection of inferring exact market event timestamps from HTTP 'Date' response headers alone.
 */

import type { UnavailabilityReason } from "./ResearchTypes.js";

export const MAX_ALLOWED_FORWARD_CLOCK_SKEW_MS = 5000;
export const MAX_ALLOWED_INGESTION_LAG_MS = 120000;

export interface ClockEvaluationInput {
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly responseReceivedMs?: number | undefined;
  readonly decisionTimestampMs: number;
  /**
   * Optional flag indicating if source timestamp was derived solely from an HTTP Date header.
   */
  readonly isDerivedFromHttpDateHeaderOnly?: boolean | undefined;
  /**
   * Optional local monotonic elapsed timestamp (ms) - strictly separate from epoch ms.
   */
  readonly hostMonotonicElapsedMs?: number | undefined;
}

export type ClockCausalAttestation =
  | "PROVED_MONOTONIC"
  | "TOLERATED_CLOCK_SKEW_QUARANTINE"
  | "EXCESSIVE_CLOCK_SKEW_REJECTED"
  | "IMPOSSIBLE_ORDERING_REJECTED"
  | "MISSING_RECEIPT_EVIDENCE"
  | "LOOKAHEAD_LEAKAGE_REJECTED"
  | "NON_FINITE_TIMESTAMPS";

export interface ClockValidationResult {
  readonly isCausallyMonotonic: boolean;
  readonly isQuarantined: boolean;
  readonly attestationStatus: ClockCausalAttestation;
  readonly unavailabilityReason?: UnavailabilityReason | undefined;
  readonly quarantineReasons: readonly string[];
  readonly measuredSkewMs: number;
  readonly measuredIngestionLagMs: number;
  readonly transitLatencyMs?: number | undefined;
}

export function validateClockMonotonicity(input: ClockEvaluationInput): ClockValidationResult {
  const reasons: string[] = [];

  const isFinitePos = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;

  // 1. Mandatory Finite Timestamp Check
  if (!isFinitePos(input.sourceTimestampMs)) {
    reasons.push("NON_FINITE_SOURCE_TIMESTAMP");
  }
  if (!isFinitePos(input.ingestionTimestampMs)) {
    reasons.push("NON_FINITE_INGESTION_TIMESTAMP");
  }
  if (!isFinitePos(input.decisionTimestampMs)) {
    reasons.push("NON_FINITE_DECISION_TIMESTAMP");
  }
  if (input.responseReceivedMs !== undefined && !isFinitePos(input.responseReceivedMs)) {
    reasons.push("NON_FINITE_RESPONSE_RECEIVED_TIMESTAMP");
  }

  if (reasons.length > 0) {
    return {
      isCausallyMonotonic: false,
      isQuarantined: true,
      attestationStatus: "NON_FINITE_TIMESTAMPS",
      unavailabilityReason: "INVALID_OR_NONFINITE_MANDATORY_TIMESTAMPS",
      quarantineReasons: reasons,
      measuredSkewMs: 0,
      measuredIngestionLagMs: 0,
    };
  }

  const measuredIngestionLag = input.ingestionTimestampMs - input.sourceTimestampMs;
  const measuredSkew = input.sourceTimestampMs - input.ingestionTimestampMs; // positive if provider clock ahead
  const hasReceiptEvidence = input.responseReceivedMs !== undefined;
  const recv = input.responseReceivedMs;
  const transitLatency = recv !== undefined ? recv - input.sourceTimestampMs : undefined;

  // 2. Receipt Evidence Requirement: Chronological proof requires explicit responseReceivedMs
  if (!hasReceiptEvidence) {
    reasons.push(
      "MISSING_RECEIPT_EVIDENCE: responseReceivedMs is required for verified causal ordering; cannot attest receipt chronology",
    );
  }

  // 3. HTTP Date Header Inference Safeguard
  if (input.isDerivedFromHttpDateHeaderOnly === true) {
    reasons.push(
      "HTTP_HEADER_TIMESTAMP_INSUFFICIENT: Market event timestamp cannot be inferred from HTTP response header alone",
    );
  }

  // 4. Monotonic Causal Ordering Invariants (D2-PREREQ-01)
  // Rule A: responseReceivedMs >= sourceTimestampMs (cannot receive response before external event occurred)
  if (recv !== undefined && recv < input.sourceTimestampMs) {
    reasons.push(
      `IMPOSSIBLE_TIMESTAMP_ORDERING: responseReceivedMs (${recv}) precedes sourceTimestampMs (${input.sourceTimestampMs})`,
    );
  }

  // Rule B: Cross-Clock Skew & Monotonicity
  // Under D2-PREREQ-01, provider source timestamp ahead of ingestion (measuredSkew > 0, negative lag)
  // is cross-clock uncertainty. It is NEVER proved monotonic data.
  if (measuredSkew > MAX_ALLOWED_FORWARD_CLOCK_SKEW_MS) {
    reasons.push(
      `EXCESSIVE_FORWARD_CLOCK_SKEW: provider source timestamp is ${measuredSkew}ms ahead of ingestion (max ${MAX_ALLOWED_FORWARD_CLOCK_SKEW_MS}ms)`,
    );
  } else if (measuredSkew > 0) {
    reasons.push(
      `CLOCK_SKEW_QUARANTINE: provider source timestamp is ${measuredSkew}ms ahead of ingestion (negative ingestion lag ${measuredIngestionLag}ms); cross-clock uncertainty quarantined`,
    );
  }

  // Rule C: ingestionTimestampMs <= responseReceivedMs
  if (recv !== undefined && input.ingestionTimestampMs > recv) {
    reasons.push(
      `INVERTED_HOST_RECEIPT_ORDERING: ingestionTimestampMs (${input.ingestionTimestampMs}) > responseReceivedMs (${recv})`,
    );
  }

  // Rule D: sourceTimestampMs <= decisionTimestampMs (no future lookahead)
  if (input.sourceTimestampMs > input.decisionTimestampMs) {
    reasons.push(
      `FUTURE_FEATURE_LOOKAHEAD_LEAKAGE: sourceTimestampMs (${input.sourceTimestampMs}) > decisionTimestampMs (${input.decisionTimestampMs})`,
    );
  }

  // Rule E: ingestionTimestampMs <= decisionTimestampMs
  if (input.ingestionTimestampMs > input.decisionTimestampMs) {
    reasons.push(
      `FUTURE_INGESTION_LEAKAGE: ingestionTimestampMs (${input.ingestionTimestampMs}) > decisionTimestampMs (${input.decisionTimestampMs})`,
    );
  }

  // Rule F: responseReceivedMs <= decisionTimestampMs
  if (recv !== undefined && recv > input.decisionTimestampMs) {
    reasons.push(
      `LATE_RESPONSE_RECEIPT_LOOKAHEAD: responseReceivedMs (${recv}) > decisionTimestampMs (${input.decisionTimestampMs})`,
    );
  }

  // Rule G: Ingestion lag threshold check
  if (measuredIngestionLag > MAX_ALLOWED_INGESTION_LAG_MS) {
    reasons.push(
      `EXCESSIVE_INGESTION_LAG: ingestion lag (${measuredIngestionLag}ms) exceeds limit ${MAX_ALLOWED_INGESTION_LAG_MS}ms`,
    );
  }

  const isQuarantined = reasons.length > 0;
  let unavailabilityReason: UnavailabilityReason | undefined;
  let attestationStatus: ClockCausalAttestation = "PROVED_MONOTONIC";

  if (isQuarantined) {
    if (reasons.some((r) => r.startsWith("EXCESSIVE_FORWARD_CLOCK_SKEW"))) {
      attestationStatus = "EXCESSIVE_CLOCK_SKEW_REJECTED";
      unavailabilityReason = "IMPOSSIBLE_TIMESTAMP_ORDERING";
    } else if (reasons.some((r) => r.startsWith("CLOCK_SKEW_QUARANTINE"))) {
      attestationStatus = "TOLERATED_CLOCK_SKEW_QUARANTINE";
      unavailabilityReason = "IMPOSSIBLE_TIMESTAMP_ORDERING";
    } else if (
      reasons.some(
        (r) =>
          r.startsWith("IMPOSSIBLE_TIMESTAMP_ORDERING") ||
          r.startsWith("INVERTED_HOST_RECEIPT_ORDERING"),
      )
    ) {
      attestationStatus = "IMPOSSIBLE_ORDERING_REJECTED";
      unavailabilityReason = "IMPOSSIBLE_TIMESTAMP_ORDERING";
    } else if (reasons.some((r) => r.includes("LOOKAHEAD"))) {
      attestationStatus = "LOOKAHEAD_LEAKAGE_REJECTED";
      unavailabilityReason = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
    } else if (reasons.some((r) => r.startsWith("MISSING_RECEIPT_EVIDENCE"))) {
      attestationStatus = "MISSING_RECEIPT_EVIDENCE";
      unavailabilityReason = "PROVIDER_RESPONSE_OMITTED_FIELD";
    } else if (reasons.some((r) => r.startsWith("EXCESSIVE_INGESTION_LAG"))) {
      attestationStatus = "IMPOSSIBLE_ORDERING_REJECTED";
      unavailabilityReason = "STALE_SAMPLE_DISCARDED";
    } else {
      attestationStatus = "IMPOSSIBLE_ORDERING_REJECTED";
      unavailabilityReason = "INVALID_OR_NONFINITE_MANDATORY_TIMESTAMPS";
    }
  }

  return {
    isCausallyMonotonic: !isQuarantined,
    isQuarantined,
    attestationStatus,
    unavailabilityReason,
    quarantineReasons: reasons,
    measuredSkewMs: measuredSkew,
    measuredIngestionLagMs: measuredIngestionLag,
    transitLatencyMs: transitLatency,
  };
}
