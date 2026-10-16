/**
 * Phase 12.94-D Milestone D.2.1: Shadow Evaluation Contract Implementation & Validation
 *
 * Implements deterministic validation, factory generation, and causal joining for
 * ShadowEvaluationRecord sidecar streams without mutating existing telemetry contracts.
 */

import type { CandidateDecisionRecord } from "../telemetry/TelemetryTypes.js";
import type {
  ShadowEligibilityResult,
  ShadowEvaluationRecord,
  ShadowQualificationResult,
  ShadowReserveSnapshot,
} from "./ShadowEvaluationTypes.js";

export function createShadowEvaluationRecord(params: {
  decision: CandidateDecisionRecord;
  qualificationResult: ShadowQualificationResult;
  evaluationTimestampMs?: number | undefined;
  hostMonotonicElapsedMs?: number | undefined;
  observedReserveSnapshot?: ShadowReserveSnapshot | undefined;
}): ShadowEvaluationRecord {
  const evalTimestamp = params.evaluationTimestampMs ?? params.decision.decisionTimestampMs;
  const evaluationId = `shd-${params.decision.eventId}-${evalTimestamp}`;

  const candidateRecord = {
    schemaVersion: "1.0.0" as const,
    evaluationId,
    decisionEventId: params.decision.eventId,
    sessionId: params.decision.sessionId,
    generationId: params.decision.generationId,
    mintAddress: params.decision.mintAddress,
    poolId: params.decision.poolId,
    evaluationTimestampMs: evalTimestamp,
    hostMonotonicElapsedMs: params.hostMonotonicElapsedMs,
    qualificationResult: params.qualificationResult,
    observedReserveSnapshot: params.observedReserveSnapshot,
  };

  return validateShadowEvaluationRecord(candidateRecord);
}

export function validateShadowEvaluationRecord(data: unknown): ShadowEvaluationRecord {
  if (typeof data !== "object" || data === null) {
    throw new Error("[ShadowEvaluationContract] Record must be a non-null object.");
  }

  const r = data as Record<string, unknown>;

  if (r.schemaVersion !== "1.0.0") {
    throw new Error(
      `[ShadowEvaluationContract] Invalid schemaVersion: expected '1.0.0', got '${String(r.schemaVersion)}'.`,
    );
  }

  if (typeof r.evaluationId !== "string" || r.evaluationId.trim().length === 0) {
    throw new Error("[ShadowEvaluationContract] evaluationId must be a non-empty string.");
  }

  if (typeof r.decisionEventId !== "string" || r.decisionEventId.trim().length === 0) {
    throw new Error("[ShadowEvaluationContract] decisionEventId must be a non-empty string.");
  }

  if (typeof r.sessionId !== "string" || r.sessionId.trim().length === 0) {
    throw new Error("[ShadowEvaluationContract] sessionId must be a non-empty string.");
  }

  if (typeof r.generationId !== "string" || r.generationId.trim().length === 0) {
    throw new Error("[ShadowEvaluationContract] generationId must be a non-empty string.");
  }

  if (typeof r.mintAddress !== "string" || r.mintAddress.trim().length === 0) {
    throw new Error("[ShadowEvaluationContract] mintAddress must be a non-empty string.");
  }

  if (typeof r.poolId !== "string" || r.poolId.trim().length === 0) {
    throw new Error("[ShadowEvaluationContract] poolId must be a non-empty string.");
  }

  if (
    typeof r.evaluationTimestampMs !== "number" ||
    !Number.isFinite(r.evaluationTimestampMs) ||
    r.evaluationTimestampMs <= 0
  ) {
    throw new Error(
      "[ShadowEvaluationContract] evaluationTimestampMs must be a positive finite number.",
    );
  }

  if (
    r.hostMonotonicElapsedMs !== undefined &&
    (typeof r.hostMonotonicElapsedMs !== "number" ||
      !Number.isFinite(r.hostMonotonicElapsedMs) ||
      r.hostMonotonicElapsedMs < 0)
  ) {
    throw new Error(
      "[ShadowEvaluationContract] hostMonotonicElapsedMs, if present, must be a non-negative finite number.",
    );
  }

  // Validate qualificationResult
  if (typeof r.qualificationResult !== "object" || r.qualificationResult === null) {
    throw new Error("[ShadowEvaluationContract] qualificationResult must be a non-null object.");
  }

  const qr = r.qualificationResult as Record<string, unknown>;

  if (typeof qr.shadowTriggerQualified !== "boolean") {
    throw new Error(
      "[ShadowEvaluationContract] qualificationResult.shadowTriggerQualified must be a boolean.",
    );
  }

  if (typeof qr.qualificationReason !== "string" || qr.qualificationReason.trim().length === 0) {
    throw new Error(
      "[ShadowEvaluationContract] qualificationResult.qualificationReason must be a non-empty string.",
    );
  }

  if (
    typeof qr.simulatedTargetSizeSol !== "number" ||
    !Number.isFinite(qr.simulatedTargetSizeSol) ||
    qr.simulatedTargetSizeSol < 0
  ) {
    throw new Error(
      "[ShadowEvaluationContract] qualificationResult.simulatedTargetSizeSol must be a non-negative finite number.",
    );
  }

  if (typeof qr.executionFeasible !== "boolean") {
    throw new Error(
      "[ShadowEvaluationContract] qualificationResult.executionFeasible must be a boolean.",
    );
  }

  // Validate optional reserve snapshot
  let rsRecord: Record<string, unknown> | undefined;
  if (r.observedReserveSnapshot !== undefined) {
    if (typeof r.observedReserveSnapshot !== "object" || r.observedReserveSnapshot === null) {
      throw new Error(
        "[ShadowEvaluationContract] observedReserveSnapshot, if present, must be a non-null object.",
      );
    }
    const rs = r.observedReserveSnapshot as Record<string, unknown>;
    rsRecord = rs;
    if (
      typeof rs.baseReserve !== "number" ||
      !Number.isFinite(rs.baseReserve) ||
      rs.baseReserve < 0
    ) {
      throw new Error(
        "[ShadowEvaluationContract] observedReserveSnapshot.baseReserve must be a non-negative finite number.",
      );
    }
    if (
      typeof rs.quoteReserve !== "number" ||
      !Number.isFinite(rs.quoteReserve) ||
      rs.quoteReserve < 0
    ) {
      throw new Error(
        "[ShadowEvaluationContract] observedReserveSnapshot.quoteReserve must be a non-negative finite number.",
      );
    }
    if (
      typeof rs.sourceTimestampMs !== "number" ||
      !Number.isFinite(rs.sourceTimestampMs) ||
      rs.sourceTimestampMs <= 0
    ) {
      throw new Error(
        "[ShadowEvaluationContract] observedReserveSnapshot.sourceTimestampMs must be a positive finite number.",
      );
    }
  }

  // Validate executionFeasible integrity against reserves snapshot
  if (qr.executionFeasible === true) {
    if (!rsRecord) {
      throw new Error(
        "[ShadowEvaluationContract] executionFeasible cannot be true without an observedReserveSnapshot.",
      );
    }
    const base = rsRecord.baseReserve as number;
    const quote = rsRecord.quoteReserve as number;
    const sourceMs = rsRecord.sourceTimestampMs as number;
    if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(quote) || quote <= 0) {
      throw new Error(
        `[ShadowEvaluationContract] executionFeasible requires strictly positive baseReserve and quoteReserve (got base: ${base}, quote: ${quote}).`,
      );
    }
    if (sourceMs > (r.evaluationTimestampMs as number)) {
      throw new Error(
        `[ShadowEvaluationContract] observedReserveSnapshot sourceTimestampMs (${sourceMs}) cannot be after evaluationTimestampMs (${r.evaluationTimestampMs as number}). Future reserve lookahead is forbidden.`,
      );
    }
  }

  return r as unknown as ShadowEvaluationRecord;
}

export function validateShadowEvaluationEligibility(
  record: ShadowEvaluationRecord,
  decision: CandidateDecisionRecord,
): ShadowEligibilityResult {
  const rejectionReasons: string[] = [];

  // 1. Foreign-Key Composite Identity Check
  if (record.decisionEventId !== decision.eventId) {
    rejectionReasons.push(
      `COMPOSITE_FOREIGN_KEY_MISMATCH: decisionEventId (${record.decisionEventId}) does not match decision eventId (${decision.eventId})`,
    );
  }
  if (record.sessionId !== decision.sessionId) {
    rejectionReasons.push(
      `COMPOSITE_FOREIGN_KEY_MISMATCH: sessionId (${record.sessionId}) does not match decision sessionId (${decision.sessionId})`,
    );
  }
  if (record.generationId !== decision.generationId) {
    rejectionReasons.push(
      `COMPOSITE_FOREIGN_KEY_MISMATCH: generationId (${record.generationId}) does not match decision generationId (${decision.generationId})`,
    );
  }
  if (record.mintAddress !== decision.mintAddress) {
    rejectionReasons.push(
      `COMPOSITE_FOREIGN_KEY_MISMATCH: mintAddress (${record.mintAddress}) does not match decision mintAddress (${decision.mintAddress})`,
    );
  }
  if (record.poolId !== decision.poolId) {
    rejectionReasons.push(
      `COMPOSITE_FOREIGN_KEY_MISMATCH: poolId (${record.poolId}) does not match decision poolId (${decision.poolId})`,
    );
  }

  // 2. Chronological Ordering
  if (record.evaluationTimestampMs < decision.decisionTimestampMs) {
    rejectionReasons.push(
      `EVALUATION_PRECEDES_DECISION: evaluationTimestampMs (${record.evaluationTimestampMs}) precedes decisionTimestampMs (${decision.decisionTimestampMs})`,
    );
  }

  // 3. Execution Feasibility Verification
  let executionFeasible = record.qualificationResult.executionFeasible;
  let unavailabilityReason = record.qualificationResult.unavailabilityReason;

  if (executionFeasible) {
    if (!record.observedReserveSnapshot) {
      rejectionReasons.push(
        "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT: executionFeasible is claimed but observedReserveSnapshot is missing",
      );
      executionFeasible = false;
      unavailabilityReason = "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT";
    } else {
      const snap = record.observedReserveSnapshot;
      if (snap.baseReserve <= 0 || snap.quoteReserve <= 0) {
        rejectionReasons.push(
          `RESERVE_QUANTITY_ZERO_OR_NONFINITE: non-positive reserves in snapshot (base: ${snap.baseReserve}, quote: ${snap.quoteReserve})`,
        );
        executionFeasible = false;
        unavailabilityReason = "RESERVE_QUANTITY_ZERO_OR_NONFINITE";
      }
      if (snap.sourceTimestampMs > record.evaluationTimestampMs) {
        rejectionReasons.push(
          `FUTURE_RESERVE_SNAPSHOT: snapshot sourceTimestampMs (${snap.sourceTimestampMs}) is after evaluationTimestampMs (${record.evaluationTimestampMs})`,
        );
        executionFeasible = false;
        unavailabilityReason = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
      }
      if (snap.sourceTimestampMs > decision.decisionTimestampMs) {
        rejectionReasons.push(
          `FUTURE_RESERVE_SNAPSHOT_DECISION: snapshot sourceTimestampMs (${snap.sourceTimestampMs}) is after decisionTimestampMs (${decision.decisionTimestampMs})`,
        );
        executionFeasible = false;
        unavailabilityReason = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
      }
    }
  }

  const isEligible = rejectionReasons.length === 0;
  if (!isEligible && unavailabilityReason === undefined) {
    if (rejectionReasons.some((r) => r.includes("COMPOSITE_FOREIGN_KEY_MISMATCH"))) {
      unavailabilityReason = "POOL_IDENTITY_MISMATCH_DISCARDED";
    } else if (rejectionReasons.some((r) => r.includes("EVALUATION_PRECEDES_DECISION"))) {
      unavailabilityReason = "IMPOSSIBLE_TIMESTAMP_ORDERING";
    }
  }

  return {
    isEligible,
    executionFeasible,
    rejectionReasons,
    unavailabilityReason,
  };
}
