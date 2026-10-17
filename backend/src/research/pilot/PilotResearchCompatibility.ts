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
import os from "node:os";
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
  readonly isAuthoritativeH2Eligible: boolean;
  readonly isAuthoritativeH1Eligible: boolean;
  readonly isReceiptTimeExploratory: boolean;
  readonly hasObservedFlowMetrics: boolean;
  readonly d1DownstreamGateEligible: boolean;
  readonly d1DownstreamRejectionReasons: readonly string[];
  readonly classificationReason: string;
}

export interface PilotSessionCompatibilityReport {
  readonly sessionId: string;
  readonly sessionStatus: string;
  /**
   * Session-scoped D.1 readiness metrics, audited strictly for THIS session in isolation (D23C4-01B).
   */
  readonly d1ReadinessMetrics: {
    readonly totalSessionsFound: number;
    readonly finalizedSessionsCount: number;
    readonly finalizedEligibleDecisionsCount: number;
    readonly eligibleH1DecisionsCount: number;
    readonly eligibleH2DecisionsCount: number;
    readonly eligibleH3DecisionsCount: number;
    readonly eligibleH4DecisionsCount: number;
  };
  /**
   * Aggregate parent-directory D.1 readiness metrics across all sibling sessions in the parent directory.
   * Explicitly separated from session-scoped metrics (D23C4-01B).
   */
  readonly aggregateParentScopeMetrics?:
    | {
        readonly parentDir: string;
        readonly totalSessionsFound: number;
        readonly finalizedSessionsCount: number;
        readonly finalizedEligibleDecisionsCount: number;
        readonly eligibleH1DecisionsCount: number;
        readonly eligibleH2DecisionsCount: number;
        readonly eligibleH3DecisionsCount: number;
        readonly eligibleH4DecisionsCount: number;
      }
    | undefined;
  readonly downstreamGateMetrics: {
    readonly evaluatedDecisionsCount: number;
    readonly authoritativeDecisionCount: number;
    readonly authoritativeH1EligibleCount: number;
    readonly authoritativeH2EligibleCount: number;
    readonly rejectedDecisionsCount: number;
  };
  readonly pilotEvidenceClassification: {
    readonly authoritativeD1EligibleCount: number;
    readonly authoritativeH2EligibleCount: number;
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
 * Evaluates whether an observation provides valid pre-decision reserves for H1/H4 hypothesis evaluation.
 */
export function hasUsablePreDecisionReserves(
  decision: CandidateDecisionRecord,
  observation?: MarketObservationRecord | undefined,
): boolean {
  if (!observation) return false;
  const recv = observation.responseReceivedMs ?? observation.ingestionTimestampMs;
  const tDec = decision.decisionTimestampMs;
  if (!observation.liquidityMetrics) return false;
  const { baseReserve, quoteReserve } = observation.liquidityMetrics;
  if (typeof baseReserve !== "number" || !Number.isFinite(baseReserve) || baseReserve <= 0) {
    return false;
  }
  if (typeof quoteReserve !== "number" || !Number.isFinite(quoteReserve) || quoteReserve <= 0) {
    return false;
  }
  if (
    typeof observation.sourceTimestampMs !== "number" ||
    !Number.isFinite(observation.sourceTimestampMs) ||
    observation.sourceTimestampMs <= 0
  ) {
    return false;
  }
  if (
    typeof observation.ingestionTimestampMs !== "number" ||
    !Number.isFinite(observation.ingestionTimestampMs)
  ) {
    return false;
  }
  if (typeof recv !== "number" || !Number.isFinite(recv)) {
    return false;
  }
  if (observation.sourceTimestampMs > observation.ingestionTimestampMs) return false;
  if (observation.sourceTimestampMs > tDec) return false;
  if (observation.ingestionTimestampMs > tDec) return false;
  if (recv > tDec) return false;
  if (tDec - observation.sourceTimestampMs > 180_000) return false; // MAX_DATA_FRESHNESS_MS
  if (observation.ingestionTimestampMs - observation.sourceTimestampMs > 120_000) return false; // MAX_INGESTION_LAG_MS
  return true;
}

/**
 * Classifies a pilot candidate decision record for research eligibility, reconciling
 * D.1 readiness observations with downstream ResearchEligibilityGate criteria (D23C3-04 & D23C4-01C).
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
      isAuthoritativeH2Eligible: false,
      isAuthoritativeH1Eligible: false,
      isReceiptTimeExploratory: false,
      hasObservedFlowMetrics: hasObservedFlowMetrics(decision),
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
  const hasReserves = hasUsablePreDecisionReserves(decision, observation);

  // 3. Classify evidence tier (D23C4-01C: separate general decision eligibility from H2 flow qualification)
  if (d1DownstreamGateEligible && hasAttestedSourceTime) {
    const isH2Eligible = hasFlow;
    return {
      eventId: decision.eventId,
      classification: "AUTHORITATIVE_D1_ELIGIBLE",
      isAuthoritativeD1Eligible: true,
      isAuthoritativeH2Eligible: isH2Eligible,
      isAuthoritativeH1Eligible: hasReserves,
      isReceiptTimeExploratory: false,
      hasObservedFlowMetrics: hasFlow,
      d1DownstreamGateEligible: true,
      d1DownstreamRejectionReasons: [],
      classificationReason: isH2Eligible
        ? "Decision satisfies full downstream research eligibility with verified point-in-time source attestation and co-occurring 5-minute flow metrics."
        : "Decision satisfies general downstream research eligibility with verified point-in-time source attestation, but lacks co-occurring H2 flow metrics (buys5m, sells5m, volume5mUsd); not qualified for H2 hypothesis analysis.",
    };
  }

  if (hasFlow && (!hasAttestedSourceTime || decision.sourceTimestampMs === 0)) {
    return {
      eventId: decision.eventId,
      classification: "RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED",
      isAuthoritativeD1Eligible: false,
      isAuthoritativeH2Eligible: false,
      isAuthoritativeH1Eligible: false,
      isReceiptTimeExploratory: true,
      hasObservedFlowMetrics: true,
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
    isAuthoritativeH2Eligible: false,
    isAuthoritativeH1Eligible: false,
    isReceiptTimeExploratory: false,
    hasObservedFlowMetrics: hasFlow,
    d1DownstreamGateEligible: false,
    d1DownstreamRejectionReasons,
    classificationReason:
      d1DownstreamRejectionReasons.join("; ") ||
      "Record does not meet research eligibility criteria.",
  };
}

/**
 * Performs an end-to-end audit and reconciliation of a pilot session directory.
 * Reads the directory, executes D.1 runReadinessAudit in an isolated temporary staging environment,
 * evaluates downstream eligibility, and outputs a reconciled compatibility report with explicit caveats.
 *
 * Guarantees:
 * - Read-only with respect to sealed session directories (D23C4-01A: never mutates sessionDir).
 * - Session-scoped D.1 metrics cleanly separated from aggregate parent-scope metrics (D23C4-01B).
 * - Authoritative H2 requires co-occurring flow metrics (D23C4-01C).
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

  // 1. Stage the session into an isolated read-only staging directory in os.tmpdir()
  // Upholds two critical architectural boundaries:
  // (a) Read-only guarantee: sessionDir is NEVER mutated or written to by default.
  // (b) True session scope: D.1 scanner runs in isolation, avoiding sibling session inflation.
  const stageRootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "nexustrade-pilot-d1-stage-"));
  const stageTelemetrySessionsDir = path.join(stageRootDir, "telemetry-sessions");
  const stageLegacySessionsDir =
    options?.legacySessionsDir ?? path.join(stageRootDir, "empty-legacy");
  fsSync.mkdirSync(stageTelemetrySessionsDir, { recursive: true });
  fsSync.mkdirSync(stageLegacySessionsDir, { recursive: true });

  const sessionFolderName = path.basename(sessionDir);
  const stagedSessionDir = path.join(stageTelemetrySessionsDir, sessionFolderName);
  fsSync.mkdirSync(stagedSessionDir, { recursive: true });

  if (fsSync.existsSync(sessionDir)) {
    const entries = fsSync.readdirSync(sessionDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        fsSync.copyFileSync(path.join(sessionDir, ent.name), path.join(stagedSessionDir, ent.name));
      }
    }
  }

  // Determine report path: default to an isolated path in stageRootDir so sessionDir is never modified.
  // If caller provided reportOutputPath, ensure it is outside sessionDir.
  const defaultReportPath = path.join(stageRootDir, "READINESS_AUDIT.md");
  let effectiveReportPath = options?.reportOutputPath ?? defaultReportPath;
  if (path.resolve(effectiveReportPath).startsWith(path.resolve(sessionDir))) {
    effectiveReportPath = defaultReportPath;
  }

  let sessionD1Result: ReadinessAuditResult;
  let aggregateParentScopeMetrics:
    | {
        readonly parentDir: string;
        readonly totalSessionsFound: number;
        readonly finalizedSessionsCount: number;
        readonly finalizedEligibleDecisionsCount: number;
        readonly eligibleH1DecisionsCount: number;
        readonly eligibleH2DecisionsCount: number;
        readonly eligibleH3DecisionsCount: number;
        readonly eligibleH4DecisionsCount: number;
      }
    | undefined = undefined;

  try {
    sessionD1Result = runReadinessAudit({
      telemetrySessionsDir: stageTelemetrySessionsDir,
      legacySessionsDir: stageLegacySessionsDir,
      reportOutputPath: effectiveReportPath,
    });

    // Check parent directory for sibling sessions (D23C4-01B)
    const parentTelemetryDir = path.dirname(sessionDir);
    if (fsSync.existsSync(parentTelemetryDir)) {
      try {
        const parentEntries = fsSync.readdirSync(parentTelemetryDir, { withFileTypes: true });
        const dirCount = parentEntries.filter((e) => e.isDirectory()).length;
        if (dirCount > 1) {
          const parentReportPath = path.join(stageRootDir, "PARENT_READINESS_AUDIT.md");
          const parentD1Result: ReadinessAuditResult = runReadinessAudit({
            telemetrySessionsDir: parentTelemetryDir,
            legacySessionsDir: stageLegacySessionsDir,
            reportOutputPath: parentReportPath,
          });
          aggregateParentScopeMetrics = {
            parentDir: parentTelemetryDir,
            totalSessionsFound: parentD1Result.totalSessionsFound,
            finalizedSessionsCount: parentD1Result.finalizedSessionsCount,
            finalizedEligibleDecisionsCount: parentD1Result.finalizedEligibleDecisionsCount,
            eligibleH1DecisionsCount: parentD1Result.eligibleH1DecisionsCount,
            eligibleH2DecisionsCount: parentD1Result.eligibleH2DecisionsCount,
            eligibleH3DecisionsCount: parentD1Result.eligibleH3DecisionsCount,
            eligibleH4DecisionsCount: parentD1Result.eligibleH4DecisionsCount,
          };
        }
      } catch {
        // Best-effort parent aggregate scan
      }
    }
  } finally {
    // Clean up temporary staged directories
    try {
      if (fsSync.existsSync(stageTelemetrySessionsDir)) {
        fsSync.rmSync(stageTelemetrySessionsDir, { recursive: true, force: true });
      }
      if (fsSync.existsSync(stageLegacySessionsDir) && !options?.legacySessionsDir) {
        fsSync.rmSync(stageLegacySessionsDir, { recursive: true, force: true });
      }
      if (!options?.reportOutputPath && fsSync.existsSync(stageRootDir)) {
        fsSync.rmSync(stageRootDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }

  // 2. Classify individual decisions against downstream gate (D23C4-01C)
  const recordDetails: PilotRecordCompatibilityResult[] = [];
  let authoritativeH1EligibleCount = 0;
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
      if (comp.isAuthoritativeH1Eligible) {
        authoritativeH1EligibleCount++;
      }
      if (comp.isAuthoritativeH2Eligible) {
        authoritativeH2EligibleCount++;
      }
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
    sessionD1Result.eligibleH2DecisionsCount > 0 &&
    authoritativeH2EligibleCount === 0 &&
    receiptTimeExploratoryH2Count > 0;

  const reconciliationStatus = isReconciledWithCaveat
    ? "RECONCILED_WITH_CAVEAT"
    : authoritativeH2EligibleCount > 0
      ? "FULLY_AUTHORITATIVE"
      : "INSUFFICIENT_EVIDENCE";

  const caveatNotice = isReconciledWithCaveat
    ? `CAVEAT: Session-scoped D.1 readiness scanner reports eligibleH2DecisionsCount=${sessionD1Result.eligibleH2DecisionsCount} based on raw field availability. However, downstream ResearchEligibilityGate rejects records with sourceTimestampMs=0 for EXCESSIVE_INGESTION_LAG. These records are strictly receipt-time exploratory / source-time unverified, NOT authoritatively qualified D.1 H2 evidence.`
    : authoritativeH2EligibleCount > 0
      ? "All eligible decisions satisfy downstream causal and source timestamp attestation criteria with co-occurring H2 flow metrics."
      : "Insufficient evidence: no decisions qualified for authoritative or exploratory H2 research.";

  return {
    sessionId: meta?.sessionId ?? path.basename(sessionDir),
    sessionStatus: meta?.sessionStatus ?? "UNKNOWN",
    d1ReadinessMetrics: {
      totalSessionsFound: sessionD1Result.totalSessionsFound,
      finalizedSessionsCount: sessionD1Result.finalizedSessionsCount,
      finalizedEligibleDecisionsCount: sessionD1Result.finalizedEligibleDecisionsCount,
      eligibleH1DecisionsCount: sessionD1Result.eligibleH1DecisionsCount,
      eligibleH2DecisionsCount: sessionD1Result.eligibleH2DecisionsCount,
      eligibleH3DecisionsCount: sessionD1Result.eligibleH3DecisionsCount,
      eligibleH4DecisionsCount: sessionD1Result.eligibleH4DecisionsCount,
    },
    aggregateParentScopeMetrics,
    downstreamGateMetrics: {
      evaluatedDecisionsCount: decisions.length,
      authoritativeDecisionCount: authoritativeD1EligibleCount,
      authoritativeH1EligibleCount,
      authoritativeH2EligibleCount,
      rejectedDecisionsCount,
    },
    pilotEvidenceClassification: {
      authoritativeD1EligibleCount,
      authoritativeH2EligibleCount,
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
