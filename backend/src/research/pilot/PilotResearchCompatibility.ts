/**
 * Phase 12.94-D Milestone D.2.3: Pilot Research Compatibility & Reconciliation Gate
 *
 * Implements pilot-specific research reporting, reading, and reconciliation between:
 * 1. D.1 Readiness Audit (which counts co-occurring receipt-time flow fields for exploratory studies)
 * 2. D.1 Research Eligibility Gate (which requires finite, attested sourceTimestampMs for causal inference)
 *
 * Resolves Finding D23C3-04:
 * Prevents misleading equivalence between receipt-time exploratory flow observations
 * and authoritatively qualified D.1 H2 hypothesis feasibility. Records with sourceTimestampMs=0
 * are explicitly categorized as RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED rather than
 * AUTHORITATIVE_D1_ELIGIBLE, without mutating frozen D.1 contracts or fabricating source timestamps.
 */

import fsSync from "node:fs";
import path from "node:path";
// prettier-ignore
// @ts-expect-error D.1 readiness audit script is authored as .mjs with sibling .d.ts
import { runReadinessAudit } from "../../../../scripts/audit-research-readiness.mjs";

export interface ReadinessAuditResult {
  readonly totalSessionsFound: number;
  readonly finalizedSessionsCount: number;
  readonly interruptedSessionsCount: number;
  readonly unfinalizedSessionsCount: number;
  readonly totalDecisions: number;
  readonly totalObservations: number;
  readonly observationsWithVerifiedPool: number;
  readonly decisionsWithUsablePreDecisionReserves: number;
  readonly finalizedEligibleDecisionsCount: number;
  readonly eligibleH1DecisionsCount: number;
  readonly eligibleH2DecisionsCount: number;
  readonly eligibleH3DecisionsCount: number;
  readonly eligibleH4DecisionsCount: number;
  readonly totalQuotesFound: number;
  readonly totalFillsFound: number;
  readonly totalSamplingRecords: number;
  readonly totalMalformedRecordsCount: number;
  readonly h1Feasible: boolean;
  readonly h2Feasible: boolean;
  readonly h3Feasible: boolean;
  readonly h4Feasible: boolean;
  readonly overallReadinessStatus: string;
}
import {
  evaluateResearchEligibility,
  type EligibilityGateOptions,
} from "../ResearchEligibilityGate.js";
import { TelemetryExecutionJoinEngine } from "../TelemetryExecutionJoinEngine.js";
import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";

export type PilotResearchEvidenceClass =
  | "AUTHORITATIVE_D1_ELIGIBLE"
  | "RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED"
  | "INELIGIBLE_RESEARCH_RECORD";

export interface PilotRecordCompatibilityResult {
  readonly eventId: string;
  readonly classification: PilotResearchEvidenceClass;
  readonly isAuthoritativeD1Eligible: boolean;
  readonly isReceiptTimeExploratory: boolean;
  readonly d1DownstreamGateEligible: boolean;
  readonly d1DownstreamRejectionReasons: readonly string[];
  readonly classificationReason: string;
}

export interface PilotSessionCompatibilityReport {
  readonly sessionId: string;
  readonly sessionStatus: string;
  readonly d1ReadinessMetrics: {
    readonly totalSessionsFound: number;
    readonly finalizedSessionsCount: number;
    readonly finalizedEligibleDecisionsCount: number;
    readonly eligibleH1DecisionsCount: number;
    readonly eligibleH2DecisionsCount: number;
    readonly eligibleH3DecisionsCount: number;
    readonly eligibleH4DecisionsCount: number;
  };
  readonly downstreamGateMetrics: {
    readonly evaluatedDecisionsCount: number;
    readonly authoritativeH1EligibleCount: number;
    readonly authoritativeH2EligibleCount: number;
    readonly rejectedDecisionsCount: number;
  };
  readonly pilotEvidenceClassification: {
    readonly authoritativeD1EligibleCount: number;
    readonly receiptTimeExploratoryH2Count: number;
    readonly ineligibleCount: number;
    readonly primaryClassification: PilotResearchEvidenceClass;
  };
  readonly recordDetails: readonly PilotRecordCompatibilityResult[];
  readonly reconciliation: {
    readonly status: "RECONCILED_WITH_CAVEAT" | "FULLY_AUTHORITATIVE" | "INSUFFICIENT_EVIDENCE";
    readonly caveatNotice: string;
  };
}

/**
 * Evaluates whether a candidate decision has real-valued 5-minute flow measurements.
 */
export function hasObservedFlowMetrics(decision: CandidateDecisionRecord): boolean {
  const ms = decision.metricsSnapshot;
  if (!ms) return false;
  const p = ms.metricProvenance ?? {};
  const hasBuys =
    ms.buys5m !== null &&
    ms.buys5m !== undefined &&
    Number.isFinite(ms.buys5m) &&
    ms.buys5m >= 0 &&
    p["buys5m"] !== "PLACEHOLDER" &&
    p["buys5m"] !== "UNAVAILABLE";
  const hasSells =
    ms.sells5m !== null &&
    ms.sells5m !== undefined &&
    Number.isFinite(ms.sells5m) &&
    ms.sells5m >= 0 &&
    p["sells5m"] !== "PLACEHOLDER" &&
    p["sells5m"] !== "UNAVAILABLE";
  const hasVol =
    ms.volume5mUsd !== null &&
    ms.volume5mUsd !== undefined &&
    Number.isFinite(ms.volume5mUsd) &&
    ms.volume5mUsd >= 0 &&
    p["volume5mUsd"] !== "PLACEHOLDER" &&
    p["volume5mUsd"] !== "UNAVAILABLE";

  return hasBuys && hasSells && hasVol;
}

/**
 * Classifies a pilot candidate decision record for research eligibility, reconciling
 * D.1 readiness observations with downstream ResearchEligibilityGate criteria (D23C3-04).
 */
export function classifyPilotDecisionCompatibility(
  decision: CandidateDecisionRecord,
  observation?: MarketObservationRecord | undefined,
  sessionMeta?: SessionTelemetryMeta | undefined,
  sessionSummary?: SessionTelemetrySummary | undefined,
): PilotRecordCompatibilityResult {
  // 1. Evaluate downstream D.1 eligibility gate via join engine
  const joinEngine = new TelemetryExecutionJoinEngine({ mode: "OBSERVATIONAL_ONLY" });
  const joined = joinEngine.joinTelemetryAndExecution({
    decisions: [decision],
    observations: observation ? [observation] : [],
    sessionMeta,
    sessionSummary,
    mode: "OBSERVATIONAL_ONLY",
  });

  const joinedRecord = joined[0];
  if (!joinedRecord) {
    return {
      eventId: decision.eventId,
      classification: "INELIGIBLE_RESEARCH_RECORD",
      isAuthoritativeD1Eligible: false,
      isReceiptTimeExploratory: false,
      d1DownstreamGateEligible: false,
      d1DownstreamRejectionReasons: ["JOIN_FAILED: Record could not be joined causally"],
      classificationReason: "Candidate decision failed point-in-time causal join.",
    };
  }

  const gateOptions: EligibilityGateOptions = {
    mode: "OBSERVATIONAL_ONLY",
    sessionMeta,
    sessionSummary,
  };

  const gateResult = evaluateResearchEligibility(joinedRecord, gateOptions);
  const d1DownstreamGateEligible = gateResult.isEligible;
  const d1DownstreamRejectionReasons = [...gateResult.rejectionReasons];

  // 2. Check source timestamp attestation
  const hasAttestedSourceTime =
    decision.sourceTimestampMs !== null &&
    decision.sourceTimestampMs !== undefined &&
    Number.isFinite(decision.sourceTimestampMs) &&
    decision.sourceTimestampMs > 0 &&
    !decision.missingFields?.includes("sourceTimestampMs");

  const hasFlow = hasObservedFlowMetrics(decision);

  // 3. Classify evidence tier
  if (d1DownstreamGateEligible && hasAttestedSourceTime) {
    return {
      eventId: decision.eventId,
      classification: "AUTHORITATIVE_D1_ELIGIBLE",
      isAuthoritativeD1Eligible: true,
      isReceiptTimeExploratory: false,
      d1DownstreamGateEligible: true,
      d1DownstreamRejectionReasons: [],
      classificationReason:
        "Decision satisfies full downstream research eligibility with verified point-in-time source attestation.",
    };
  }

  if (hasFlow && (!hasAttestedSourceTime || decision.sourceTimestampMs === 0)) {
    return {
      eventId: decision.eventId,
      classification: "RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED",
      isAuthoritativeD1Eligible: false,
      isReceiptTimeExploratory: true,
      d1DownstreamGateEligible: false,
      d1DownstreamRejectionReasons,
      classificationReason:
        "Observed 5-minute flow metrics at receipt time without provider source timestamp attestation (sourceTimestampMs=0). Downstream gate rejects for EXCESSIVE_INGESTION_LAG. Classified as receipt-time exploratory / source-time unverified, NOT authoritatively qualified D.1 H2 evidence.",
    };
  }

  return {
    eventId: decision.eventId,
    classification: "INELIGIBLE_RESEARCH_RECORD",
    isAuthoritativeD1Eligible: false,
    isReceiptTimeExploratory: false,
    d1DownstreamGateEligible: false,
    d1DownstreamRejectionReasons,
    classificationReason:
      d1DownstreamRejectionReasons.join("; ") ||
      "Record does not meet research eligibility criteria.",
  };
}

/**
 * Performs an end-to-end audit and reconciliation of a pilot session directory (D23C3-04).
 * Reads the directory, executes D.1 runReadinessAudit, evaluates downstream eligibility,
 * and outputs a reconciled compatibility report with explicit caveats.
 */
export async function auditPilotSessionCompatibility(
  sessionDir: string,
  options?: {
    legacySessionsDir?: string | undefined;
    reportOutputPath?: string | undefined;
  },
): Promise<PilotSessionCompatibilityReport> {
  const metaPath = path.join(sessionDir, "session-meta.json");
  const summaryPath = path.join(sessionDir, "session-summary.json");
  const decisionsPath = path.join(sessionDir, "candidate-decisions.jsonl");
  const observationsPath = path.join(sessionDir, "market-observations.jsonl");

  let meta: SessionTelemetryMeta | undefined = undefined;
  let summary: SessionTelemetrySummary | undefined = undefined;

  if (fsSync.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fsSync.readFileSync(metaPath, "utf8")) as SessionTelemetryMeta;
    } catch {
      // malformed meta
    }
  }

  if (fsSync.existsSync(summaryPath)) {
    try {
      summary = JSON.parse(fsSync.readFileSync(summaryPath, "utf8")) as SessionTelemetrySummary;
    } catch {
      // malformed summary
    }
  }

  const decisions: CandidateDecisionRecord[] = [];
  if (fsSync.existsSync(decisionsPath)) {
    const lines = fsSync
      .readFileSync(decisionsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try {
        decisions.push(JSON.parse(l) as CandidateDecisionRecord);
      } catch {
        // ignore malformed line
      }
    }
  }

  const observations: MarketObservationRecord[] = [];
  if (fsSync.existsSync(observationsPath)) {
    const lines = fsSync
      .readFileSync(observationsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try {
        observations.push(JSON.parse(l) as MarketObservationRecord);
      } catch {
        // ignore malformed line
      }
    }
  }

  // 1. Run D.1 readiness audit on parent directory
  const parentTelemetryDir = path.dirname(sessionDir);
  const d1Readiness: ReadinessAuditResult = runReadinessAudit({
    telemetrySessionsDir: parentTelemetryDir,
    legacySessionsDir: options?.legacySessionsDir ?? path.join(parentTelemetryDir, "empty-legacy"),
    reportOutputPath: options?.reportOutputPath ?? path.join(sessionDir, "READINESS_AUDIT.md"),
  });

  // 2. Classify individual decisions against downstream gate
  const recordDetails: PilotRecordCompatibilityResult[] = [];
  const authoritativeH1EligibleCount = 0;
  let authoritativeH2EligibleCount = 0;
  let receiptTimeExploratoryH2Count = 0;
  let authoritativeD1EligibleCount = 0;
  let rejectedDecisionsCount = 0;

  for (const dec of decisions) {
    const obs = observations.find(
      (o) =>
        o.poolId === dec.poolId &&
        o.mintAddress === dec.mintAddress &&
        o.sessionId === dec.sessionId,
    );

    const comp = classifyPilotDecisionCompatibility(dec, obs, meta, summary);
    recordDetails.push(comp);

    if (comp.isAuthoritativeD1Eligible) {
      authoritativeD1EligibleCount++;
      authoritativeH2EligibleCount++;
    } else if (comp.isReceiptTimeExploratory) {
      receiptTimeExploratoryH2Count++;
      rejectedDecisionsCount++;
    } else {
      rejectedDecisionsCount++;
    }
  }

  const primaryClassification: PilotResearchEvidenceClass =
    authoritativeD1EligibleCount > 0
      ? "AUTHORITATIVE_D1_ELIGIBLE"
      : receiptTimeExploratoryH2Count > 0
        ? "RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED"
        : "INELIGIBLE_RESEARCH_RECORD";

  const isReconciledWithCaveat =
    d1Readiness.eligibleH2DecisionsCount > 0 &&
    authoritativeH2EligibleCount === 0 &&
    receiptTimeExploratoryH2Count > 0;

  const reconciliationStatus = isReconciledWithCaveat
    ? "RECONCILED_WITH_CAVEAT"
    : authoritativeH2EligibleCount > 0
      ? "FULLY_AUTHORITATIVE"
      : "INSUFFICIENT_EVIDENCE";

  const caveatNotice = isReconciledWithCaveat
    ? `CAVEAT: D.1 readiness scanner reports eligibleH2DecisionsCount=${d1Readiness.eligibleH2DecisionsCount} based on raw field availability. However, downstream ResearchEligibilityGate rejects records with sourceTimestampMs=0 for EXCESSIVE_INGESTION_LAG. These records are strictly receipt-time exploratory / source-time unverified, NOT authoritatively qualified D.1 H2 evidence.`
    : authoritativeH2EligibleCount > 0
      ? "All eligible decisions satisfy downstream causal and source timestamp attestation criteria."
      : "Insufficient evidence: no decisions qualified for authoritative or exploratory research.";

  return {
    sessionId: meta?.sessionId ?? path.basename(sessionDir),
    sessionStatus: meta?.sessionStatus ?? "UNKNOWN",
    d1ReadinessMetrics: {
      totalSessionsFound: d1Readiness.totalSessionsFound,
      finalizedSessionsCount: d1Readiness.finalizedSessionsCount,
      finalizedEligibleDecisionsCount: d1Readiness.finalizedEligibleDecisionsCount,
      eligibleH1DecisionsCount: d1Readiness.eligibleH1DecisionsCount,
      eligibleH2DecisionsCount: d1Readiness.eligibleH2DecisionsCount,
      eligibleH3DecisionsCount: d1Readiness.eligibleH3DecisionsCount,
      eligibleH4DecisionsCount: d1Readiness.eligibleH4DecisionsCount,
    },
    downstreamGateMetrics: {
      evaluatedDecisionsCount: decisions.length,
      authoritativeH1EligibleCount,
      authoritativeH2EligibleCount,
      rejectedDecisionsCount,
    },
    pilotEvidenceClassification: {
      authoritativeD1EligibleCount,
      receiptTimeExploratoryH2Count,
      ineligibleCount: rejectedDecisionsCount - receiptTimeExploratoryH2Count,
      primaryClassification,
    },
    recordDetails,
    reconciliation: {
      status: reconciliationStatus,
      caveatNotice,
    },
  };
}
