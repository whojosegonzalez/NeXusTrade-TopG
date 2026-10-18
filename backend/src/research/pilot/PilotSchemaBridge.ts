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
 * Synthetic fallback timestamp (0 epoch ms) used strictly for compatibility with
 * canonical schemas requiring a numeric sourceTimestampMs when the provider
 * does not attest an on-chain/block timestamp (D23F-04).
 * Downstream eligibility rules detect this and prevent it from being construed
 * as an attested market update.
 */
export const SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS = 0;

function isFiniteNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val);
}

/**
 * Translates a D.2.3 Screened Candidate into a canonical CandidateDecisionRecord.
 * Strictly maintains the 5-tuple composite key and observational provenance (D23P-03, D23F-04).
 */
export function toCanonicalCandidateDecision(
  candidate: D23ScreenedCandidate,
  observation?: D23ObservationRecord | undefined,
): CandidateDecisionRecord {
  const missingFields = [...candidate.missingFields];

  // D23F-04: Truthful source timestamp handling. Never misstate unavailable source time as decisionEpochMs.
  const hasAttestedSourceTime =
    candidate.sourceTimestampMs !== null && isFiniteNumber(candidate.sourceTimestampMs);
  const sourceTimestampMs = hasAttestedSourceTime
    ? candidate.sourceTimestampMs
    : SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS;

  if (!hasAttestedSourceTime && !missingFields.includes("sourceTimestampMs")) {
    missingFields.push("sourceTimestampMs");
  }

  const spotPriceSol = isFiniteNumber(observation?.reserveAccounting?.spotPriceSol)
    ? observation.reserveAccounting.spotPriceSol
    : null;
  const volume5mUsd = isFiniteNumber(observation?.flowMetrics?.volume5mUsd)
    ? observation.flowMetrics.volume5mUsd
    : null;
  const buys5m = isFiniteNumber(observation?.flowMetrics?.buys5m)
    ? observation.flowMetrics.buys5m
    : null;
  const sells5m = isFiniteNumber(observation?.flowMetrics?.sells5m)
    ? observation.flowMetrics.sells5m
    : null;

  const metricsSnapshot: CandidateMetricsSnapshot = {
    tokenAgeSec: null,
    liquidityUsd: null,
    marketCapUsd: null,
    lmcRatio: null,
    lpBurnPct: null,
    spotPriceUsd: null,
    spotPriceSol,
    volume5mUsd,
    txCount5m: null,
    buys5m,
    sells5m,
    metricProvenance: {
      tokenAgeSec: "UNAVAILABLE",
      liquidityUsd: "UNAVAILABLE",
      marketCapUsd: "UNAVAILABLE",
      lmcRatio: "UNAVAILABLE",
      lpBurnPct: "UNAVAILABLE",
      spotPriceUsd: "UNAVAILABLE",
      spotPriceSol: spotPriceSol !== null ? "OBSERVED" : "UNAVAILABLE",
      volume5mUsd: volume5mUsd !== null ? "OBSERVED" : "UNAVAILABLE",
      txCount5m: "UNAVAILABLE",
      buys5m: buys5m !== null ? "OBSERVED" : "UNAVAILABLE",
      sells5m: sells5m !== null ? "OBSERVED" : "UNAVAILABLE",
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
    ...(candidate.poolOpenTimeMs !== undefined && candidate.poolOpenTimeMs !== null
      ? { poolOpenTimeMs: candidate.poolOpenTimeMs }
      : {}),
    strategyRevision: D23_STRATEGY_REVISION,
    decisionCohort: candidate.decisionCohort,
    ...(candidate.rejectionReasons.length > 0
      ? { primaryRejectionReason: candidate.rejectionReasons[0] }
      : {}),
    filterEvaluations,
    metricsSnapshot,
    missingFields,
    providerIdentity: candidate.providerIdentity || D23_OBSERVATIONAL_PROVIDER,
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

  // D23F-04: Truthful source timestamp handling. Never fill missing source time with receipt time.
  const hasAttestedSourceTime =
    observation.sourceReportedTimeMs !== null && isFiniteNumber(observation.sourceReportedTimeMs);
  const sourceTimestampMs = hasAttestedSourceTime
    ? observation.sourceReportedTimeMs
    : SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS;

  if (!hasAttestedSourceTime && !missingFields.includes("sourceTimestampMs")) {
    missingFields.push("sourceTimestampMs");
  }

  const dataFreshnessMs = hasAttestedSourceTime
    ? Math.max(0, observation.receiptEpochMs - sourceTimestampMs)
    : Number.MAX_SAFE_INTEGER;

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
    dataFreshnessMs,
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
      spotPriceSol:
        reserveAcct && isFiniteNumber(reserveAcct.spotPriceSol) ? reserveAcct.spotPriceSol : null,
      priceSource: "POOL_RESERVE",
    },
    liquidityMetrics: {
      baseReserve:
        reserveAcct && isFiniteNumber(reserveAcct.tokenReserveDecimal)
          ? reserveAcct.tokenReserveDecimal
          : null,
      quoteReserve:
        reserveAcct && isFiniteNumber(reserveAcct.solReserveDecimal)
          ? reserveAcct.solReserveDecimal
          : null,
      liquidityUsd: null,
    },
    flowMetrics: {
      txCount: null,
      buys: isFiniteNumber(observation.flowMetrics?.buys5m) ? observation.flowMetrics.buys5m : null,
      sells: isFiniteNumber(observation.flowMetrics?.sells5m)
        ? observation.flowMetrics.sells5m
        : null,
      volumeUsd: isFiniteNumber(observation.flowMetrics?.volume5mUsd)
        ? observation.flowMetrics.volume5mUsd
        : null,
      netBuyerVolumeUsd: isFiniteNumber(observation.flowMetrics?.netBuyerVolumeUsd)
        ? observation.flowMetrics.netBuyerVolumeUsd
        : null,
    },
    missingFields,
    strategyRevision,
    ...(observation.slotDiscrepancy
      ? { clockSkewWarning: "SLOT_DISCREPANCY_DETECTED_ACROSS_VAULT_READS" }
      : {}),
  };
}
