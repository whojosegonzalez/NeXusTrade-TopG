import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  PriceSourceType,
  ReconstructedDecisionContext,
} from "./TelemetryTypes.js";
import type { TelemetryStorageManager } from "./TelemetryStorageManager.js";

export class DecisionContextReconstructor {
  private readonly storage: TelemetryStorageManager;

  constructor(storage: TelemetryStorageManager) {
    this.storage = storage;
  }

  public reconstructContext(
    decision: CandidateDecisionRecord,
    lookbackDurationMs: number = 5 * 60 * 1000, // 5 minutes lookback
    tradeWindow?: { entryMs: number; exitMs: number },
  ): ReconstructedDecisionContext {
    const allObservations = this.storage.readMarketObservations(decision.sessionId);

    // Decision cutoff timestamp: the exact time when the decision was computed
    const decisionCutoffMs = decision.decisionTimestampMs || decision.ingestionTimestampMs;

    // Strictly filter to observations that satisfy genuine Point-in-Time availability:
    // 1. Same generation, session, pool, and mint identity
    // 2. Source timestamp occurred on or before decision source timestamp
    // 3. Ingestion timestamp occurred on or before decision cutoff (No late-arriving observations!)
    // 4. Measurement window must have fully closed on or before decision source timestamp
    const priorObservations = allObservations.filter((obs) => {
      if (obs.generationId !== decision.generationId) return false;
      if (obs.sessionId !== decision.sessionId) return false;
      if (obs.poolId !== decision.poolId) return false;
      if (obs.mintAddress !== decision.mintAddress) return false;

      // Event source timing
      if (obs.sourceTimestampMs > decision.sourceTimestampMs) return false;

      // Actual ingestion availability timing (prevent lookahead from late arrivals)
      if (obs.ingestionTimestampMs > decisionCutoffMs) return false;

      // Closed measurement window (prevent aggregated window from leaking future ticks)
      if (obs.measurementWindow && obs.measurementWindow.windowEndMs > decision.sourceTimestampMs) {
        return false;
      }

      return true;
    });

    // Sort chronologically by source timestamp
    priorObservations.sort((a, b) => a.sourceTimestampMs - b.sourceTimestampMs);

    const windowStartMs = decision.sourceTimestampMs - lookbackDurationMs;
    const preDecisionWindow = priorObservations.filter(
      (obs) => obs.sourceTimestampMs >= windowStartMs,
    );

    let inTradeWindow: MarketObservationRecord[] | undefined;
    let postExitWindow: MarketObservationRecord[] | undefined;

    if (tradeWindow) {
      inTradeWindow = allObservations
        .filter(
          (obs) =>
            obs.generationId === decision.generationId &&
            obs.sessionId === decision.sessionId &&
            obs.poolId === decision.poolId &&
            obs.mintAddress === decision.mintAddress &&
            obs.sourceTimestampMs >= tradeWindow.entryMs &&
            obs.sourceTimestampMs <= tradeWindow.exitMs,
        )
        .sort((a, b) => a.sourceTimestampMs - b.sourceTimestampMs);

      const postExitEndMs = tradeWindow.exitMs + 15 * 60 * 1000;
      postExitWindow = allObservations
        .filter(
          (obs) =>
            obs.generationId === decision.generationId &&
            obs.sessionId === decision.sessionId &&
            obs.poolId === decision.poolId &&
            obs.mintAddress === decision.mintAddress &&
            obs.sourceTimestampMs > tradeWindow.exitMs &&
            obs.sourceTimestampMs <= postExitEndMs,
        )
        .sort((a, b) => a.sourceTimestampMs - b.sourceTimestampMs);
    }

    // Reconstruct market state at decision point without cross-currency coercion
    const latestPreObs = preDecisionWindow[preDecisionWindow.length - 1];

    const latestSpotPriceSol: number | null =
      latestPreObs?.priceMetrics?.spotPriceSol ?? decision.metricsSnapshot.spotPriceSol ?? null;

    const latestSpotPriceUsd: number | null =
      latestPreObs?.priceMetrics?.spotPriceUsd ?? decision.metricsSnapshot.spotPriceUsd ?? null;

    const bestAvailableLiquidityUsd: number | null =
      latestPreObs?.liquidityMetrics?.liquidityUsd ?? decision.metricsSnapshot.liquidityUsd ?? null;

    // Price impact is an ESTIMATE, not an observed execution fill
    const estimatedPriceImpactBps: number | null =
      bestAvailableLiquidityUsd && bestAvailableLiquidityUsd > 0
        ? Math.min(10000, Number(((100 / bestAvailableLiquidityUsd) * 10000).toFixed(2)))
        : null;

    const priceSource: PriceSourceType | "DECISION_SNAPSHOT" | "UNKNOWN" = latestPreObs
      ? latestPreObs.priceMetrics.priceSource
      : "DECISION_SNAPSHOT";

    // Collect all missing fields noted across pre-decision window
    const missingSet = new Set<string>(decision.missingFields);
    for (const obs of preDecisionWindow) {
      for (const f of obs.missingFields) {
        missingSet.add(f);
      }
    }
    if (latestSpotPriceSol === null) {
      missingSet.add("spotPriceSol");
    }
    if (latestSpotPriceUsd === null) {
      missingSet.add("spotPriceUsd");
    }

    // Compute data quality score (0.0 to 1.0)
    let qualityScore = 1.0;
    if (preDecisionWindow.length === 0) {
      qualityScore -= 0.5; // No time-series history
    } else if (latestPreObs && latestPreObs.dataFreshnessMs > 30000) {
      qualityScore -= 0.2; // Stale data (>30s old)
    }
    if (missingSet.size > 0) {
      qualityScore -= Math.min(0.3, missingSet.size * 0.1);
    }
    qualityScore = Math.max(0.0, Number(qualityScore.toFixed(2)));

    const reconstructedMarketState = {
      latestSpotPriceSol,
      latestSpotPriceUsd,
      bestAvailableLiquidityUsd,
      estimatedPriceImpactBps,
      priceSource,
    };

    return {
      decisionRecord: decision,
      preDecisionWindow,
      inTradeWindow,
      postExitWindow,
      reconstructedOrderBook: {
        estimatedSpotSol: latestSpotPriceSol,
        bestAvailableLiquidityUsd,
        observedPriceImpactBps: estimatedPriceImpactBps,
      },
      reconstructedMarketState,
      dataQualityScore: qualityScore,
      missingDataFields: Array.from(missingSet),
    };
  }
}
