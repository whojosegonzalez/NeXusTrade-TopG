/**
 * Phase 12.94-D Milestone D.2.1: Shadow Evaluation Research Sidecar Contracts
 *
 * Implements backward-compatible sidecar types for shadow evaluation records.
 * Keeps existing CandidateDecisionRecord.decisionCohort frozen and unaltered.
 * Preserves UTC epoch-millisecond event joining while isolating host monotonic timing.
 */

import type { UnavailabilityReason } from "./ResearchTypes.js";

/**
 * Result of the shadow rule trigger evaluation for a candidate decision.
 */
export interface ShadowQualificationResult {
  /**
   * Whether the candidate passed all strategy buy-trigger heuristics in shadow mode.
   * NOTE: This is strictly a model signal qualification; it does NOT represent an executed trade.
   */
  readonly shadowTriggerQualified: boolean;
  /**
   * Explanatory reason code or description for the qualification or disqualification.
   * e.g., "MET_MOMENTUM_AND_SAFETY_CRITERIA" or "FAILED_MINIMUM_5M_NET_INFLOW"
   */
  readonly qualificationReason: string;
  /**
   * Simulated sizing in SOL if the candidate were to be quoted (e.g. 0.10 SOL).
   */
  readonly simulatedTargetSizeSol: number;
  /**
   * Whether contemporaneous point-in-time reserves existed to form a valid synthetic quote.
   */
  readonly executionFeasible: boolean;
  /**
   * Explicit reason if reserves or execution context was unavailable.
   */
  readonly unavailabilityReason?: UnavailabilityReason | undefined;
}

/**
 * Optional snapshot of verified point-in-time reserves at decision time.
 */
export interface ShadowReserveSnapshot {
  readonly baseReserve: number;
  readonly quoteReserve: number;
  readonly sourceTimestampMs: number;
}

/**
 * Canonical Research Sidecar Record for Shadow Evaluations.
 * Persisted to `shadow-evaluations.jsonl` within `.tmp/telemetry/sessions/<sessionId>/`.
 *
 * Guaranteed Invariants:
 * 1. Independent evaluation identity (evaluationId).
 * 2. Foreign-key binding to canonical decisionEventId, sessionId, generationId, mint, and pool.
 * 3. evaluationTimestampMs is in UTC epoch milliseconds (aligned with decisionTimestampMs).
 * 4. hostMonotonicElapsedMs is recorded separately and NEVER compared against epoch timestamps.
 * 5. Candidate decision cohort remains unchanged in canonical candidate-decisions.jsonl.
 */
export interface ShadowEvaluationRecord {
  readonly schemaVersion: "1.0.0";
  readonly evaluationId: string;
  readonly decisionEventId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  /**
   * UTC epoch millisecond timestamp of the shadow evaluation.
   * Comparable to decisionTimestampMs.
   */
  readonly evaluationTimestampMs: number;
  /**
   * Local host monotonic elapsed milliseconds (from process.hrtime or performance.now).
   * Used strictly for local latency profiling. Never compared against epoch timestamps.
   */
  readonly hostMonotonicElapsedMs?: number | undefined;
  /**
   * Detailed qualification outcome.
   */
  readonly qualificationResult: ShadowQualificationResult;
  /**
   * Point-in-time reserve snapshot if available.
   */
  readonly observedReserveSnapshot?: ShadowReserveSnapshot | undefined;
}

/**
 * Result of validating a shadow evaluation record against its canonical decision and economic eligibility.
 */
export interface ShadowEligibilityResult {
  readonly isEligible: boolean;
  readonly executionFeasible: boolean;
  readonly rejectionReasons: readonly string[];
  readonly unavailabilityReason?: UnavailabilityReason | undefined;
}
