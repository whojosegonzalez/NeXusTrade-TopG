/**
 * Phase 12.94-D Milestone D.2.3: Pilot Schema Bridge
 *
 * Implements truthful, versioned schema bridging from D.2.3 empirical telemetry
 * to canonical research records (CandidateDecisionRecord, ShadowEvaluationRecord, MarketObservationRecord).
 *
 * Authority: Finding D23P-03 (Clock-domain and schema-mapping consistency).
 * Strictly preserves the 5-tuple foreign key: [decisionEventId, sessionId, generationId, mintAddress, poolId].
 * Enforces observational provenance labeling; never simulates authentic strategy buy signals.
 */

import type {
  CandidateDecisionRecord,
  CandidateMetricsSnapshot,
  FilterEvaluationDetail,
  MarketObservationRecord,
} from "../../telemetry/TelemetryTypes.js";
import type { ShadowEvaluationRecord } from "../ShadowEvaluationTypes.js";
import type { UnavailabilityReason } from "../ResearchTypes.js";
import type { D23ObservationRecord, D23ScreenedCandidate } from "./PilotTypes.js";

export const D23_STRATEGY_REVISION = "12.94-d2.3-pilot-v1";
export const D23_OBSERVATIONAL_PROVIDER = "dexscreener_public_v1:OBSERVATIONAL";

/**
 * Translates a D.2.3 Screened Candidate into a canonical CandidateDecisionRecord.
 * Strictly maintains the 5-tuple composite key and observational provenance (D23P-03).
 */
export function toCanonicalCandidateDecision(
  candidate: D23ScreenedCandidate,
  observation?: D23ObservationRecord | undefined,
): CandidateDecisionRecord {
  const missingFields = [...candidate.missingFields];

  // If source update timestamp was not attested by the provider, truthfully document it
  const sourceTimestampMs =
    candidate.sourceTimestampMs !== null ? candidate.sourceTimestampMs : candidate.decisionEpochMs;

  if (candidate.sourceTimestampMs === null && !missingFields.includes("sourceTimestampMs")) {
    missingFields.push("sourceTimestampMs");
  }

  const metricsSnapshot: CandidateMetricsSnapshot = {
    tokenAgeSec: null,
    liquidityUsd: null,
    marketCapUsd: null,
    lmcRatio: null,
    lpBurnPct: null,
    spotPriceUsd: null,
    spotPriceSol: observation?.reserveAccounting?.spotPriceSol ?? null,
    volume5mUsd: observation?.flowMetrics.volume5mUsd ?? null,
    txCount5m: null,
    buys5m: observation?.flowMetrics.buys5m ?? null,
    sells5m: observation?.flowMetrics.sells5m ?? null,
    metricProvenance: {
      spotPriceSol:
        observation?.reserveAccounting?.spotPriceSol !== null ? "OBSERVED" : "UNAVAILABLE",
      volume5mUsd: observation?.flowMetrics.volume5mUsd !== null ? "OBSERVED" : "UNAVAILABLE",
      buys5m: observation?.flowMetrics.buys5m !== null ? "OBSERVED" : "UNAVAILABLE",
      sells5m: observation?.flowMetrics.sells5m !== null ? "OBSERVED" : "UNAVAILABLE",
    },
  };

  const filterEvaluations: FilterEvaluationDetail[] = candidate.filterEvaluations.map((f) => ({
    filterName: f.filterName,
    passed: f.passed,
    valueObserved: f.observed as number | string | boolean | null,
    threshold: f.threshold as number | string | boolean | null,
    ...(f.rejectionReason ? { rejectionReason: f.rejectionReason } : {}),
  }));

  return {
    eventId: candidate.compositeId.decisionEventId,
    sessionId: candidate.compositeId.sessionId,
    generationId: candidate.compositeId.generationId,
    mintAddress: candidate.compositeId.mintAddress,
    poolId: candidate.compositeId.poolId,
    symbol: candidate.symbol,
    sourceTimestampMs,
    ingestionTimestampMs: candidate.receiptEpochMs,
    decisionTimestampMs: candidate.decisionEpochMs,
    strategyRevision: D23_STRATEGY_REVISION,
    decisionCohort: candidate.decisionCohort,
    ...(candidate.rejectionReasons.length > 0
      ? { primaryRejectionReason: candidate.rejectionReasons[0] }
      : {}),
    filterEvaluations,
    metricsSnapshot,
    missingFields,
    providerIdentity: D23_OBSERVATIONAL_PROVIDER,
  };
}

/**
 * Translates a D.2.3 Screened Candidate and Observation into a canonical ShadowEvaluationRecord.
 * Strictly maintains foreign-key binding to canonical decisionEventId, sessionId, generationId, mint, and pool.
 */
export function toCanonicalShadowEvaluation(
  candidate: D23ScreenedCandidate,
  observation?: D23ObservationRecord | undefined,
): ShadowEvaluationRecord {
  const reserveAcct = observation?.reserveAccounting;

  // D23P-02: Under VAULT_ONLY_PROXY mode, execution feasibility is strictly false
  const executionFeasible = reserveAcct?.executionFeasible ?? false;
  const unavailabilityReason: UnavailabilityReason | undefined =
    (reserveAcct?.unavailabilityReason as UnavailabilityReason | undefined) ??
    (executionFeasible ? undefined : "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT");

  // Only create observedReserveSnapshot if finite source timestamp existed and reserves are non-null
  let observedReserveSnapshot = undefined;
  if (
    reserveAcct &&
    observation?.sourceReportedTimeMs !== null &&
    Number.isFinite(observation?.sourceReportedTimeMs)
  ) {
    observedReserveSnapshot = {
      baseReserve: reserveAcct.tokenReserveDecimal,
      quoteReserve: reserveAcct.solReserveDecimal,
      sourceTimestampMs: observation.sourceReportedTimeMs,
    };
  }

  return {
    schemaVersion: "1.0.0",
    evaluationId: `eval-${candidate.compositeId.decisionEventId}`,
    decisionEventId: candidate.compositeId.decisionEventId,
    sessionId: candidate.compositeId.sessionId,
    generationId: candidate.compositeId.generationId,
    mintAddress: candidate.compositeId.mintAddress,
    poolId: candidate.compositeId.poolId,
    evaluationTimestampMs: candidate.decisionEpochMs,
    hostMonotonicElapsedMs: observation?.hostMonotonicElapsedMs,
    qualificationResult: {
      shadowTriggerQualified: false, // Strictly passive observational candidate, never a strategy buy signal
      qualificationReason:
        candidate.decisionCohort === "WATCHLIST_RADAR"
          ? "PASSED_PASSIVE_OBSERVATIONAL_CRITERIA"
          : "FAILED_PASSIVE_OBSERVATIONAL_CRITERIA",
      simulatedTargetSizeSol: 0,
      executionFeasible,
      ...(unavailabilityReason ? { unavailabilityReason } : {}),
    },
    ...(observedReserveSnapshot ? { observedReserveSnapshot } : {}),
  };
}

/**
 * Translates a D.2.3 Observation Record into a canonical MarketObservationRecord.
 */
export function toCanonicalMarketObservation(
  observation: D23ObservationRecord,
  strategyRevision: string = D23_STRATEGY_REVISION,
): MarketObservationRecord {
  const reserveAcct = observation.reserveAccounting;
  const missingFields = [...observation.missingFields];

  const sourceTimestampMs =
    observation.sourceReportedTimeMs !== null
      ? observation.sourceReportedTimeMs
      : observation.receiptEpochMs;

  if (observation.sourceReportedTimeMs === null && !missingFields.includes("sourceTimestampMs")) {
    missingFields.push("sourceTimestampMs");
  }

  return {
    observationId: observation.observationId,
    sessionId: observation.compositeId.sessionId,
    generationId: observation.compositeId.generationId,
    mintAddress: observation.compositeId.mintAddress,
    poolId: observation.compositeId.poolId,
    sourceTimestampMs,
    ingestionTimestampMs: observation.receiptEpochMs,
    requestInitiatedMs: observation.requestEpochMs,
    responseReceivedMs: observation.receiptEpochMs,
    dataFreshnessMs: Math.max(0, observation.receiptEpochMs - sourceTimestampMs),
    measurementWindow: {
      windowStartMs: Math.max(0, observation.receiptEpochMs - 300_000),
      windowEndMs: observation.receiptEpochMs,
      durationSec: 300,
    },
    derivationStatus: "DIRECT_OBSERVATION",
    providerIdentity: observation.providerIdentity,
    actualResponsePoolId: observation.actualResponsePoolId,
    priceMetrics: {
      spotPriceUsd: null,
      spotPriceSol: reserveAcct?.spotPriceSol ?? null,
      priceSource: "POOL_RESERVE",
    },
    liquidityMetrics: {
      baseReserve: reserveAcct ? reserveAcct.tokenReserveDecimal : null,
      quoteReserve: reserveAcct ? reserveAcct.solReserveDecimal : null,
      liquidityUsd: null,
    },
    flowMetrics: {
      txCount: null,
      buys: observation.flowMetrics.buys5m,
      sells: observation.flowMetrics.sells5m,
      volumeUsd: observation.flowMetrics.volume5mUsd,
      netBuyerVolumeUsd: observation.flowMetrics.netBuyerVolumeUsd,
    },
    missingFields,
    strategyRevision,
    ...(observation.slotDiscrepancy
      ? { clockSkewWarning: "SLOT_DISCREPANCY_DETECTED_ACROSS_VAULT_READS" }
      : {}),
  };
}
