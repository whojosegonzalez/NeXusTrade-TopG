/**
 * Phase 12.94-D: Telemetry-Execution Point-in-Time Join Engine
 *
 * Implements event-specific causal data joining, deterministic ambiguity handling,
 * anti-lookahead feature boundary enforcement, and mode-aware research linking.
 */

import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  MetricProvenance,
  StratifiedSamplingRecord,
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
} from "./ResearchTypes.js";
import {
  computeResearchFinancialAccounting,
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
): ProvenanceFeature<number> {
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

  const tokenAgeSec = createProvenanceFeature(
    s.tokenAgeSec,
    p["tokenAgeSec"],
    tSrc,
    tIng,
    "DERIVED",
  );
  const liquidityUsd = createProvenanceFeature(
    s.liquidityUsd,
    p["liquidityUsd"],
    tSrc,
    tIng,
    "OBSERVED",
  );
  const marketCapUsd = createProvenanceFeature(
    s.marketCapUsd,
    p["marketCapUsd"],
    tSrc,
    tIng,
    "OBSERVED",
  );
  const lmcRatio = createProvenanceFeature(s.lmcRatio, p["lmcRatio"], tSrc, tIng, "DERIVED");
  const lpBurnPct = createProvenanceFeature(s.lpBurnPct, p["lpBurnPct"], tSrc, tIng, "OBSERVED");
  const spotPriceUsd = createProvenanceFeature(
    s.spotPriceUsd,
    p["spotPriceUsd"],
    tSrc,
    tIng,
    "OBSERVED",
  );
  const spotPriceSol = createProvenanceFeature(
    s.spotPriceSol,
    p["spotPriceSol"],
    tSrc,
    tIng,
    "OBSERVED",
  );
  const volume5mUsd = createProvenanceFeature(
    s.volume5mUsd,
    p["volume5mUsd"],
    tSrc,
    tIng,
    "OBSERVED",
  );
  const txCount5m = createProvenanceFeature(s.txCount5m, p["txCount5m"], tSrc, tIng, "OBSERVED");
  const buys5m = createProvenanceFeature(s.buys5m, p["buys5m"], tSrc, tIng, "OBSERVED");
  const sells5m = createProvenanceFeature(s.sells5m, p["sells5m"], tSrc, tIng, "OBSERVED");

  // Pre-decision reserve extraction: MUST satisfy max(source, ingest, recv) <= decisionTimestampMs
  let baseReserve: ProvenanceFeature<number>;
  let quoteReserve: ProvenanceFeature<number>;
  let top10ConcentrationPct: ProvenanceFeature<number>;
  let devHoldingPct: ProvenanceFeature<number>;

  if (
    preDecisionObs &&
    preDecisionObs.sourceTimestampMs <= tDec &&
    preDecisionObs.ingestionTimestampMs <= tDec &&
    (!preDecisionObs.responseReceivedMs || preDecisionObs.responseReceivedMs <= tDec)
  ) {
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
    const reason =
      preDecisionObs && preDecisionObs.ingestionTimestampMs > tDec
        ? "LATE_RECEIPT_LOOKAHEAD_PREVENTION"
        : "NO_INDEPENDENT_POINT_IN_TIME_SNAPSHOT";

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
   * Deterministically handles trajectory ambiguity across repeated decisions for the same pool.
   */
  public joinTelemetryAndExecution(params: {
    readonly decisions: readonly CandidateDecisionRecord[];
    readonly observations: readonly MarketObservationRecord[];
    readonly quotes?: readonly ExecutableQuoteRecord[] | undefined;
    readonly fills?: readonly SimulatedFillRecord[] | undefined;
    readonly samplingRecords?: readonly StratifiedSamplingRecord[] | undefined;
    readonly mode?: ResearchEvaluationMode | undefined;
  }): readonly JoinedResearchRecord[] {
    const mode = params.mode ?? this.defaultMode;
    const quotes = params.quotes ?? [];
    const fills = params.fills ?? [];
    const samplingRecords = params.samplingRecords ?? [];
    const observations = params.observations;

    // Index quotes by decisionEventId
    const quotesByDecisionId = new Map<string, ExecutableQuoteRecord>();
    for (const q of quotes) {
      quotesByDecisionId.set(q.decisionEventId, q);
    }

    // Index fills by quoteId
    const fillsByQuoteId = new Map<string, SimulatedFillRecord>();
    for (const f of fills) {
      fillsByQuoteId.set(f.quoteId, f);
    }

    // Index sampling records by decisionEventId
    const samplingByDecisionId = new Map<string, StratifiedSamplingRecord>();
    for (const s of samplingRecords) {
      samplingByDecisionId.set(s.decisionEventId, s);
    }

    // Group decisions by (sessionId, mintAddress, poolId) to detect same-pool decision multiplicity
    const decisionsByPool = new Map<string, CandidateDecisionRecord[]>();
    for (const d of params.decisions) {
      const key = `${d.sessionId}::${d.mintAddress}::${d.poolId}`;
      const list = decisionsByPool.get(key) ?? [];
      list.push(d);
      decisionsByPool.set(key, list);
    }

    // Group observations by (sessionId, mintAddress, poolId)
    const observationsByPool = new Map<string, MarketObservationRecord[]>();
    for (const o of observations) {
      const key = `${o.sessionId}::${o.mintAddress}::${o.poolId}`;
      const list = observationsByPool.get(key) ?? [];
      list.push(o);
      observationsByPool.set(key, list);
    }

    const results: JoinedResearchRecord[] = [];

    for (const decision of params.decisions) {
      const poolKey = `${decision.sessionId}::${decision.mintAddress}::${decision.poolId}`;
      const samePoolDecisions = decisionsByPool.get(poolKey) ?? [decision];
      const poolObservations = observationsByPool.get(poolKey) ?? [];

      // Find causal pre-decision observation (strictly max(source, ingest, recv) <= decisionTimestampMs)
      let preDecisionObs: MarketObservationRecord | undefined;
      for (const obs of poolObservations) {
        const recv = obs.responseReceivedMs ?? obs.ingestionTimestampMs;
        if (
          obs.sourceTimestampMs <= decision.decisionTimestampMs &&
          recv <= decision.decisionTimestampMs
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

      // Filter observations strictly occurring after decision
      const afterDecisionObs = poolObservations.filter(
        (o) => o.sourceTimestampMs >= decision.decisionTimestampMs,
      );

      if (samePoolDecisions.length > 1) {
        // Multiple decisions for this same pool in this session!
        // Auditor Requirement D-02:
        // "MarketObservationRecord does not expose initiatingEventId. Never infer a unique parent decision
        // for ambiguous same-pool observations. Overlapping trajectories must be classified as AMBIGUOUS_TRAJECTORY."
        trajectoryLinkStatus = "AMBIGUOUS_TRAJECTORY";
        forwardObservations = afterDecisionObs; // Retained for inspection, but flagged ambiguous!
      } else if (afterDecisionObs.length > 0) {
        trajectoryLinkStatus = "EXPLICIT_LINK";
        forwardObservations = afterDecisionObs.sort(
          (a, b) => a.sourceTimestampMs - b.sourceTimestampMs,
        );
      } else {
        trajectoryLinkStatus = "NO_OBSERVATIONS_FOUND";
        forwardObservations = [];
      }

      // Link Quote & Fill
      const quote = quotesByDecisionId.get(decision.eventId);
      const fill = quote ? fillsByQuoteId.get(quote.quoteId) : undefined;

      // Link Sampling Metadata
      const sampling = samplingByDecisionId.get(decision.eventId);
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
        financialAccounting,
      };

      // Evaluate eligibility
      const eligibility = evaluateResearchEligibility(recordWithoutEligibility, { mode });

      results.push({
        ...recordWithoutEligibility,
        eligibility,
      });
    }

    return results;
  }
}
