import type { ScoreAttribution } from "../calibration/CalibrationTypes.js";
import type { StrategyDecisionRecord } from "../db/schema/index.js";

export const fastShadowProfile = {
  id: "F65E",
  version: "v1",
  key: "F65E@v1",
  label: "fast_score65_exit",
} as const;

export const FAST_SHADOW_HORIZONS = [3, 5, 15] as const;
export const FAST_SHADOW_SESSION_CAP = 10;
export const FAST_SHADOW_MAX_LATE_MINUTES = 2;

export type FastShadowClassification =
  | "SELECTED"
  | "NOT_BASELINE_SKIP"
  | "SCORE_BAND_MISMATCH"
  | "THRESHOLD_SNAPSHOT_MISMATCH"
  | "INVALID_SNAPSHOT"
  | "HARD_GATE_BLOCKED"
  | "MISSING_PRICE_OR_QUOTE_EVIDENCE"
  | "MISSING_BASELINE_PRICE"
  | "DUPLICATE_MINT_SUPPRESSED"
  | "SESSION_CAP_SUPPRESSED";

export interface FastShadowRuntimeConfig {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly sessionId: string;
  readonly intervalMs: number;
  readonly maxRuntimeMinutes?: number;
}

export interface FastShadowCandidate {
  readonly decision: StrategyDecisionRecord;
  readonly attribution: ScoreAttribution;
  readonly classification: FastShadowClassification;
  readonly reason: string;
}

export interface FastShadowSelection {
  readonly candidates: readonly FastShadowCandidate[];
  readonly selected: readonly FastShadowCandidate[];
  readonly selectedDecisionIds: readonly string[];
  readonly classificationCounts: Readonly<Record<FastShadowClassification, number>>;
}

export interface FastShadowObservationSummary {
  readonly sessionId: string;
  readonly profileKey: "F65E@v1";
  readonly eligibleCount: number;
  readonly selectedCount: number;
  readonly capSuppressedCount: number;
  readonly duplicateMintSuppressedCount: number;
  readonly alreadyScheduledCount: number;
  readonly scheduledCount: number;
  readonly dueCount: number;
  readonly observedCount: number;
  readonly missedCount: number;
  readonly failedCount: number;
  readonly dryRun: boolean;
  readonly classificationCounts: Readonly<Record<FastShadowClassification, number>>;
}
