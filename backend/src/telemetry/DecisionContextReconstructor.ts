import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
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

    // Strictly filter to observations that occurred ON OR BEFORE the decision (Zero Look-Ahead)
    const priorObservations = allObservations.filter(
      (obs) =>
        obs.mintAddress === decision.mintAddress &&
        obs.sourceTimestampMs <= decision.sourceTimestampMs,
    );

    // Sort chronologically
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
            obs.mintAddress === decision.mintAddress &&
            obs.sourceTimestampMs >= tradeWindow.entryMs &&
            obs.sourceTimestampMs <= tradeWindow.exitMs,
        )
        .sort((a, b) => a.sourceTimestampMs - b.sourceTimestampMs);

      const postExitEndMs = tradeWindow.exitMs + 15 * 60 * 1000;
      postExitWindow = allObservations
        .filter(
          (obs) =>
            obs.mintAddress === decision.mintAddress &&
            obs.sourceTimestampMs > tradeWindow.exitMs &&
            obs.sourceTimestampMs <= postExitEndMs,
        )
        .sort((a, b) => a.sourceTimestampMs - b.sourceTimestampMs);
    }

    // Reconstruct order book snapshot at decision point
    const latestPreObs = preDecisionWindow[preDecisionWindow.length - 1];
    const estimatedSpotSol = latestPreObs
      ? latestPreObs.priceMetrics.spotPriceSol
      : decision.metricsSnapshot.spotPriceUsd;

    const bestAvailableLiquidityUsd = latestPreObs
      ? latestPreObs.liquidityMetrics.liquidityUsd
      : decision.metricsSnapshot.liquidityUsd;

    // Price impact heuristic: for standard 0.5 SOL order size vs LP depth
    const observedPriceImpactBps =
      bestAvailableLiquidityUsd > 0
        ? Math.min(10000, Number(((100 / bestAvailableLiquidityUsd) * 10000).toFixed(2)))
        : 9999;

    // Collect all missing fields noted across pre-decision window
    const missingSet = new Set<string>(decision.missingFields);
    for (const obs of preDecisionWindow) {
      for (const f of obs.missingFields) {
        missingSet.add(f);
      }
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

    return {
      decisionRecord: decision,
      preDecisionWindow,
      inTradeWindow,
      postExitWindow,
      reconstructedOrderBook: {
        estimatedSpotSol,
        bestAvailableLiquidityUsd,
        observedPriceImpactBps,
      },
      dataQualityScore: qualityScore,
      missingDataFields: Array.from(missingSet),
    };
  }
}
