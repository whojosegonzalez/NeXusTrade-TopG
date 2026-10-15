/**
 * Phase 12.94-D Milestone D.2.1: Shadow Evaluation Contract Implementation & Validation
 *
 * Implements deterministic validation, factory generation, and causal joining for
 * ShadowEvaluationRecord sidecar streams without mutating existing telemetry contracts.
 */

import type { CandidateDecisionRecord } from "../telemetry/TelemetryTypes.js";
import type {
  ShadowEvaluationRecord,
  ShadowQualificationResult,
  ShadowReserveSnapshot,
} from "./ShadowEvaluationTypes.js";

export function createShadowEvaluationRecord(params: {
  decision: CandidateDecisionRecord;
  qualificationResult: ShadowQualificationResult;
  evaluationTimestampMs?: number;
  hostMonotonicElapsedMs?: number;
  observedReserveSnapshot?: ShadowReserveSnapshot;
}): ShadowEvaluationRecord {
  const evalTimestamp = params.evaluationTimestampMs ?? params.decision.decisionTimestampMs;
  const evaluationId = `shd-${params.decision.eventId}-${evalTimestamp}`;

  return {
    schemaVersion: "1.0.0",
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
  if (r.observedReserveSnapshot !== undefined) {
    if (typeof r.observedReserveSnapshot !== "object" || r.observedReserveSnapshot === null) {
      throw new Error(
        "[ShadowEvaluationContract] observedReserveSnapshot, if present, must be a non-null object.",
      );
    }
    const rs = r.observedReserveSnapshot as Record<string, unknown>;
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

  return r as unknown as ShadowEvaluationRecord;
}
