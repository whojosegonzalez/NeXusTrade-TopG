/**
 * Phase 12.94-D: Telemetry-Execution Point-in-Time Join Engine
 *
 * Implements event-specific causal data joining, deterministic ambiguity handling,
 * anti-lookahead feature boundary enforcement, composite identity verification,
 * duplicate record quarantining, and mode-aware research linking.
 */

import {
  isVerifiedMatchingPool,
  type CandidateDecisionRecord,
  type MarketObservationRecord,
  type MetricProvenance,
  type SessionTelemetryMeta,
  type SessionTelemetrySummary,
  type StratifiedSamplingRecord,
} from "../telemetry/TelemetryTypes.js";
import type { ExecutableQuoteRecord, SimulatedFillRecord } from "../execution/ExecutionTypes.js";
import type {
  DecisionFeatureVector,
  JoinedResearchRecord,
  ProvenanceClass,
  ProvenanceFeature,
  ResearchEvaluationMode,
  ResearchSamplingMetadata,
  TrajectoryLinkStatus,
  UnavailabilityReason,
} from "./ResearchTypes.js";
import {
  computeResearchFinancialAccounting,
  determineSessionStatus,
  evaluateResearchEligibility,
} from "./ResearchEligibilityGate.js";

export interface JoinEngineOptions {
  readonly mode?: ResearchEvaluationMode | undefined;
  readonly defaultIngestionTimestampMs?: number | undefined;
}

/**
 * Wraps a numeric or nullable value into a ProvenanceFeature based on record metadata.
 */
function createProvenanceFeature(
  value: number | null | undefined,
  fieldProvenance: MetricProvenance | undefined,
  sourceTimestampMs: number | undefined,
  receiptTimestampMs: number | undefined,
  fallbackProvenance: ProvenanceClass = "OBSERVED",
  unavailabilityOverride?: UnavailabilityReason | undefined,
): ProvenanceFeature<number> {
  if (unavailabilityOverride) {
    return {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: unavailabilityOverride,
      sourceTimestampMs,
      receiptTimestampMs,
    };
  }

  if (fieldProvenance === "PLACEHOLDER") {
    return {
      value: value ?? null,
      provenance: "PLACEHOLDER",
      isAvailable: false,
      unavailabilityReason: "PROVIDER_RESPONSE_OMITTED_FIELD",
      sourceTimestampMs,
      receiptTimestampMs,
    };
  }
  if (fieldProvenance === "UNAVAILABLE") {
    return {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: "PROVIDER_RESPONSE_OMITTED_FIELD",
      sourceTimestampMs,
      receiptTimestampMs,
    };
  }
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: "PROVIDER_RESPONSE_OMITTED_FIELD",
      sourceTimestampMs,
      receiptTimestampMs,
    };
  }

  const provenance: ProvenanceClass =
    fieldProvenance === "DERIVED" ? "DERIVED" : fallbackProvenance;
  return {
    value,
    provenance,
    isAvailable: true,
    sourceTimestampMs,
    receiptTimestampMs,
  };
}

/**
 * Extracts the complete decision-time feature vector from a decision record and
 * any strictly causal pre-decision observation.
 * Enforces strict temporal ordering: all decision features require max(t_src, t_ing) <= t_dec
 * and non-negative ingestion lag (t_ing >= t_src).
 */
export function extractDecisionFeatures(
  decision: CandidateDecisionRecord,
  preDecisionObs?: MarketObservationRecord | undefined,
): DecisionFeatureVector {
  const s = decision.metricsSnapshot;
  const p = s.metricProvenance ?? {};
  const tDec = decision.decisionTimestampMs;
  const tSrc = decision.sourceTimestampMs;
  const tIng = decision.ingestionTimestampMs;

  // Strict temporal causality verification for decision-time features
  let decisionFeatureUnavailability: UnavailabilityReason | undefined;
  if (!Number.isFinite(tDec) || !Number.isFinite(tSrc) || !Number.isFinite(tIng)) {
    decisionFeatureUnavailability = "INVALID_OR_NONFINITE_MANDATORY_TIMESTAMPS";
  } else if (tIng > tDec || tSrc > tDec) {
    // Lookahead leakage: decision-time snapshot ingested or sourced AFTER decision time!
    decisionFeatureUnavailability = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
  } else if (tIng < tSrc) {
    // Impossible negative ingestion lag
    decisionFeatureUnavailability = "IMPOSSIBLE_TIMESTAMP_ORDERING";
  }

  const tokenAgeSec = createProvenanceFeature(
    s.tokenAgeSec,
    p["tokenAgeSec"],
    tSrc,
    tIng,
    "DERIVED",
    decisionFeatureUnavailability,
  );
  const liquidityUsd = createProvenanceFeature(
    s.liquidityUsd,
    p["liquidityUsd"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const marketCapUsd = createProvenanceFeature(
    s.marketCapUsd,
    p["marketCapUsd"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const lmcRatio = createProvenanceFeature(
    s.lmcRatio,
    p["lmcRatio"],
    tSrc,
    tIng,
    "DERIVED",
    decisionFeatureUnavailability,
  );
  const lpBurnPct = createProvenanceFeature(
    s.lpBurnPct,
    p["lpBurnPct"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const spotPriceUsd = createProvenanceFeature(
    s.spotPriceUsd,
    p["spotPriceUsd"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const spotPriceSol = createProvenanceFeature(
    s.spotPriceSol,
    p["spotPriceSol"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const volume5mUsd = createProvenanceFeature(
    s.volume5mUsd,
    p["volume5mUsd"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const txCount5m = createProvenanceFeature(
    s.txCount5m,
    p["txCount5m"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const buys5m = createProvenanceFeature(
    s.buys5m,
    p["buys5m"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );
  const sells5m = createProvenanceFeature(
    s.sells5m,
    p["sells5m"],
    tSrc,
    tIng,
    "OBSERVED",
    decisionFeatureUnavailability,
  );

  // Pre-decision reserve extraction:
  // MUST satisfy: verified matching pool AND max(source, ingest, recv) <= decisionTimestampMs
  let baseReserve: ProvenanceFeature<number>;
  let quoteReserve: ProvenanceFeature<number>;
  let top10ConcentrationPct: ProvenanceFeature<number>;
  let devHoldingPct: ProvenanceFeature<number>;

  const obsRecv = preDecisionObs
    ? (preDecisionObs.responseReceivedMs ?? preDecisionObs.ingestionTimestampMs)
    : undefined;

  const isPreDecisionValid =
    preDecisionObs &&
    preDecisionObs.sessionId === decision.sessionId &&
    preDecisionObs.generationId === decision.generationId &&
    preDecisionObs.mintAddress === decision.mintAddress &&
    preDecisionObs.poolId === decision.poolId &&
    isVerifiedMatchingPool(preDecisionObs.actualResponsePoolId, decision.poolId) &&
    Number.isFinite(preDecisionObs.sourceTimestampMs) &&
    preDecisionObs.sourceTimestampMs <= tDec &&
    Number.isFinite(preDecisionObs.ingestionTimestampMs) &&
    preDecisionObs.ingestionTimestampMs <= tDec &&
    preDecisionObs.sourceTimestampMs <= preDecisionObs.ingestionTimestampMs &&
    obsRecv !== undefined &&
    Number.isFinite(obsRecv) &&
    obsRecv <= tDec;

  if (isPreDecisionValid) {
    baseReserve = createProvenanceFeature(
      preDecisionObs.liquidityMetrics.baseReserve,
      undefined,
      preDecisionObs.sourceTimestampMs,
      preDecisionObs.ingestionTimestampMs,
      "OBSERVED",
    );
    quoteReserve = createProvenanceFeature(
      preDecisionObs.liquidityMetrics.quoteReserve,
      undefined,
      preDecisionObs.sourceTimestampMs,
      preDecisionObs.ingestionTimestampMs,
      "OBSERVED",
    );
    top10ConcentrationPct = createProvenanceFeature(
      preDecisionObs.holderMetrics?.top10ConcentrationPct,
      undefined,
      preDecisionObs.sourceTimestampMs,
      preDecisionObs.ingestionTimestampMs,
      "OBSERVED",
    );
    devHoldingPct = createProvenanceFeature(
      preDecisionObs.holderMetrics?.devHoldingPct,
      undefined,
      preDecisionObs.sourceTimestampMs,
      preDecisionObs.ingestionTimestampMs,
      "OBSERVED",
    );
  } else {
    let reason: UnavailabilityReason = "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT";
    if (preDecisionObs) {
      if (!isVerifiedMatchingPool(preDecisionObs.actualResponsePoolId, decision.poolId)) {
        reason = "POOL_IDENTITY_MISMATCH_DISCARDED";
      } else if (
        preDecisionObs.ingestionTimestampMs > tDec ||
        (obsRecv !== undefined && obsRecv > tDec)
      ) {
        reason = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
      } else if (preDecisionObs.sourceTimestampMs > preDecisionObs.ingestionTimestampMs) {
        reason = "IMPOSSIBLE_TIMESTAMP_ORDERING";
      }
    }

    baseReserve = {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: reason,
      sourceTimestampMs: preDecisionObs?.sourceTimestampMs,
      receiptTimestampMs: preDecisionObs?.ingestionTimestampMs,
    };
    quoteReserve = {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: reason,
      sourceTimestampMs: preDecisionObs?.sourceTimestampMs,
      receiptTimestampMs: preDecisionObs?.ingestionTimestampMs,
    };
    top10ConcentrationPct = {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: reason,
    };
    devHoldingPct = {
      value: null,
      provenance: "UNAVAILABLE",
      isAvailable: false,
      unavailabilityReason: reason,
    };
  }

  return {
    tokenAgeSec,
    liquidityUsd,
    marketCapUsd,
    lmcRatio,
    lpBurnPct,
    spotPriceUsd,
    spotPriceSol,
    volume5mUsd,
    txCount5m,
    buys5m,
    sells5m,
    baseReserve,
    quoteReserve,
    top10ConcentrationPct,
    devHoldingPct,
  };
}

export class TelemetryExecutionJoinEngine {
  private readonly defaultMode: ResearchEvaluationMode;

  constructor(options: JoinEngineOptions = {}) {
    this.defaultMode = options.mode ?? "OBSERVATIONAL_ONLY";
  }

  /**
   * Joins candidate decisions with observations, quotes, fills, and sampling records.
   * Deterministically handles trajectory ambiguity across repeated decisions for the same pool,
   * enforces composite identity joins, and quarantines duplicate records.
   */
  public joinTelemetryAndExecution(params: {
    readonly decisions: readonly CandidateDecisionRecord[];
    readonly observations: readonly MarketObservationRecord[];
    readonly quotes?: readonly ExecutableQuoteRecord[] | undefined;
    readonly fills?: readonly SimulatedFillRecord[] | undefined;
    readonly samplingRecords?: readonly StratifiedSamplingRecord[] | undefined;
    readonly sessionMeta?: SessionTelemetryMeta | undefined;
    readonly sessionSummary?: SessionTelemetrySummary | undefined;
    readonly sessionsMetaMap?: ReadonlyMap<string, SessionTelemetryMeta> | undefined;
    readonly sessionsSummaryMap?: ReadonlyMap<string, SessionTelemetrySummary> | undefined;
    readonly allowUnfinalizedSession?: boolean | undefined;
    readonly mode?: ResearchEvaluationMode | undefined;
  }): readonly JoinedResearchRecord[] {
    const mode = params.mode ?? this.defaultMode;
    const quotes = params.quotes ?? [];
    const fills = params.fills ?? [];
    const samplingRecords = params.samplingRecords ?? [];
    const observations = params.observations;

    // Index quotes by composite identity: (sessionId, generationId, mintAddress, poolId, decisionEventId)
    // Detect duplicate identities and quarantine them instead of silently overwriting.
    const quotesByCompositeKey = new Map<string, ExecutableQuoteRecord>();
    const duplicateQuoteKeys = new Set<string>();
    for (const q of quotes) {
      const key = `${q.sessionId}::${q.generationId}::${q.mintAddress}::${q.poolId}::${q.decisionEventId}`;
      if (quotesByCompositeKey.has(key)) {
        duplicateQuoteKeys.add(key);
      } else {
        quotesByCompositeKey.set(key, q);
      }
    }

    // Index fills by composite quote identity: (mintAddress, poolId, quoteId) and optional session/generation
    const fillsByCompositeKey = new Map<string, SimulatedFillRecord>();
    const duplicateFillKeys = new Set<string>();
    for (const f of fills) {
      const extF = f as unknown as { sessionId?: string; generationId?: string };
      const sess = extF.sessionId ?? "";
      const gen = extF.generationId ?? "";
      const key = `${sess}::${gen}::${f.mintAddress}::${f.poolId}::${f.quoteId}`;
      if (fillsByCompositeKey.has(key)) {
        duplicateFillKeys.add(key);
      } else {
        fillsByCompositeKey.set(key, f);
      }
    }

    // Index sampling records by composite identity: (sessionId, generationId, mintAddress, poolId, decisionEventId)
    const samplingByCompositeKey = new Map<string, StratifiedSamplingRecord>();
    const duplicateSamplingKeys = new Set<string>();
    for (const s of samplingRecords) {
      const key = `${s.sessionId}::${s.generationId}::${s.mintAddress}::${s.poolId}::${s.decisionEventId}`;
      if (samplingByCompositeKey.has(key)) {
        duplicateSamplingKeys.add(key);
      } else {
        samplingByCompositeKey.set(key, s);
      }
    }

    // Group decisions by (sessionId, generationId, mintAddress, poolId) to detect same-pool decision multiplicity
    const decisionsByPool = new Map<string, CandidateDecisionRecord[]>();
    for (const d of params.decisions) {
      const key = `${d.sessionId}::${d.generationId}::${d.mintAddress}::${d.poolId}`;
      const list = decisionsByPool.get(key) ?? [];
      list.push(d);
      decisionsByPool.set(key, list);
    }

    // Group observations by (sessionId, generationId, mintAddress, poolId)
    const observationsByPool = new Map<string, MarketObservationRecord[]>();
    for (const o of observations) {
      const key = `${o.sessionId}::${o.generationId}::${o.mintAddress}::${o.poolId}`;
      const list = observationsByPool.get(key) ?? [];
      list.push(o);
      observationsByPool.set(key, list);
    }

    const results: JoinedResearchRecord[] = [];

    for (const decision of params.decisions) {
      const poolKey = `${decision.sessionId}::${decision.generationId}::${decision.mintAddress}::${decision.poolId}`;
      const samePoolDecisions = decisionsByPool.get(poolKey) ?? [decision];
      const poolObservations = observationsByPool.get(poolKey) ?? [];

      // Find causal pre-decision observation (strictly verified pool and max(source, ingest, recv) <= decisionTimestampMs)
      let preDecisionObs: MarketObservationRecord | undefined;
      for (const obs of poolObservations) {
        const recv = obs.responseReceivedMs ?? obs.ingestionTimestampMs;
        if (
          obs.sessionId === decision.sessionId &&
          obs.generationId === decision.generationId &&
          obs.mintAddress === decision.mintAddress &&
          obs.poolId === decision.poolId &&
          isVerifiedMatchingPool(obs.actualResponsePoolId, decision.poolId) &&
          Number.isFinite(obs.sourceTimestampMs) &&
          Number.isFinite(obs.ingestionTimestampMs) &&
          Number.isFinite(recv) &&
          Number.isFinite(decision.decisionTimestampMs) &&
          obs.sourceTimestampMs <= decision.decisionTimestampMs &&
          obs.ingestionTimestampMs <= decision.decisionTimestampMs &&
          recv <= decision.decisionTimestampMs &&
          obs.sourceTimestampMs <= obs.ingestionTimestampMs
        ) {
          if (!preDecisionObs || obs.sourceTimestampMs > preDecisionObs.sourceTimestampMs) {
            preDecisionObs = obs;
          }
        }
      }

      // Extract decision features
      const features = extractDecisionFeatures(decision, preDecisionObs);

      // Trajectory attribution
      let trajectoryLinkStatus: TrajectoryLinkStatus = "NO_OBSERVATIONS_FOUND";
      let forwardObservations: MarketObservationRecord[] = [];

      // Filter observations strictly occurring at or after decision
      const afterDecisionObs = poolObservations.filter(
        (o) =>
          o.sessionId === decision.sessionId &&
          o.generationId === decision.generationId &&
          o.mintAddress === decision.mintAddress &&
          o.poolId === decision.poolId &&
          o.sourceTimestampMs >= decision.decisionTimestampMs,
      );

      if (samePoolDecisions.length > 1) {
        // Multiple decisions for this same pool in this session!
        // Never infer a unique parent decision for ambiguous same-pool observations.
        trajectoryLinkStatus = "AMBIGUOUS_TRAJECTORY";
        forwardObservations = afterDecisionObs; // Retained for inspection, but flagged ambiguous!
      } else if (afterDecisionObs.length > 0) {
        // Single decision on this pool.
        // Check if there is an explicit initiating event link
        const hasExplicitLink = afterDecisionObs.some(
          (o) =>
            (o as unknown as { initiatingEventId?: string }).initiatingEventId === decision.eventId,
        );
        trajectoryLinkStatus = hasExplicitLink ? "EXPLICIT_LINK" : "UNIQUELY_INFERRED";
        forwardObservations = afterDecisionObs.sort(
          (a, b) => a.sourceTimestampMs - b.sourceTimestampMs,
        );
      } else {
        trajectoryLinkStatus = "NO_OBSERVATIONS_FOUND";
        forwardObservations = [];
      }

      // Link Quote & Fill with composite key & quarantine check
      const decCompositeKey = `${decision.sessionId}::${decision.generationId}::${decision.mintAddress}::${decision.poolId}::${decision.eventId}`;
      const isQuoteDuplicate = duplicateQuoteKeys.has(decCompositeKey);
      const quote = isQuoteDuplicate ? undefined : quotesByCompositeKey.get(decCompositeKey);

      let fill: SimulatedFillRecord | undefined;
      let isFillDuplicate = false;
      if (quote) {
        const fCompositeKey = `${decision.sessionId}::${decision.generationId}::${decision.mintAddress}::${decision.poolId}::${quote.quoteId}`;
        const fFallbackKey = `::::${decision.mintAddress}::${decision.poolId}::${quote.quoteId}`;
        isFillDuplicate =
          duplicateFillKeys.has(fCompositeKey) || duplicateFillKeys.has(fFallbackKey);
        fill = isFillDuplicate
          ? undefined
          : (fillsByCompositeKey.get(fCompositeKey) ?? fillsByCompositeKey.get(fFallbackKey));
      }

      // Link Sampling Metadata
      const isSamplingDuplicate = duplicateSamplingKeys.has(decCompositeKey);
      const sampling = isSamplingDuplicate
        ? undefined
        : samplingByCompositeKey.get(decCompositeKey);
      let samplingMetadata: ResearchSamplingMetadata | undefined;
      if (sampling) {
        samplingMetadata = {
          trackingId: sampling.trackingId,
          tier: sampling.tier,
          samplingProbability: sampling.samplingProbability,
          effectiveInclusionProbability: sampling.effectiveInclusionProbability,
          ipwEstimable: sampling.ipwEstimable,
          status: sampling.status,
        };
      }

      const isDuplicateQuarantined = isQuoteDuplicate || isFillDuplicate || isSamplingDuplicate;

      // Determine session finalization status
      const sessionMeta = params.sessionsMetaMap?.get(decision.sessionId) ?? params.sessionMeta;
      const sessionSummary =
        params.sessionsSummaryMap?.get(decision.sessionId) ?? params.sessionSummary;
      const sessionStatus =
        sessionMeta || sessionSummary
          ? determineSessionStatus(sessionMeta, sessionSummary)
          : undefined;

      // Compute Financial Accounting if a fill is linked
      const financialAccounting = fill
        ? computeResearchFinancialAccounting(fill, quote)
        : undefined;

      const recordWithoutEligibility = {
        joinId: `join-${decision.sessionId}-${decision.eventId}`,
        sessionId: decision.sessionId,
        generationId: decision.generationId,
        decisionEventId: decision.eventId,
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        symbol: decision.symbol,
        decisionTimestampMs: decision.decisionTimestampMs,
        sourceTimestampMs: decision.sourceTimestampMs,
        ingestionTimestampMs: decision.ingestionTimestampMs,
        decisionCohort: decision.decisionCohort,
        strategyRevision: decision.strategyRevision,
        evaluationMode: mode,
        trajectoryLinkStatus,
        features,
        quote,
        fill,
        forwardObservations,
        samplingMetadata,
        sessionStatus,
        isDuplicateQuarantined,
        financialAccounting,
      };

      // Evaluate eligibility
      const eligibility = evaluateResearchEligibility(recordWithoutEligibility, {
        mode,
        allowUnfinalizedSession: params.allowUnfinalizedSession,
        sessionMeta,
        sessionSummary,
      });

      results.push({
        ...recordWithoutEligibility,
        eligibility,
      });
    }

    return results;
  }
}
