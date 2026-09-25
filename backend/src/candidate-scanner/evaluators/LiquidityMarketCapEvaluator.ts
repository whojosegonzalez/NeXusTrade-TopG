import type {
  CandidateScannerFilterEvaluation,
  CandidateScannerRuntimeConfig,
  ScannedPoolRecord,
} from "../CandidateScannerTypes.js";

export class LiquidityMarketCapEvaluator {
  evaluate(
    pool: ScannedPoolRecord,
    config: CandidateScannerRuntimeConfig,
  ): CandidateScannerFilterEvaluation {
    if (pool.liquidityUsd <= 0 || pool.marketCapUsd <= 0) {
      return {
        filterName: "LIQUIDITY_MARKET_CAP_DEPTH",
        passed: false,
        reason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
        details: {
          liquidityUsd: pool.liquidityUsd,
          marketCapUsd: pool.marketCapUsd,
          lmcRatio: 0,
          expectedRange: `${(config.minLmcRatio * 100).toFixed(1)}% - ${(config.maxLmcRatio * 100).toFixed(1)}%`,
        },
      };
    }

    const lmcRatio = pool.liquidityUsd / pool.marketCapUsd;

    if (lmcRatio < config.minLmcRatio || lmcRatio > config.maxLmcRatio) {
      return {
        filterName: "LIQUIDITY_MARKET_CAP_DEPTH",
        passed: false,
        reason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
        details: {
          liquidityUsd: pool.liquidityUsd,
          marketCapUsd: pool.marketCapUsd,
          lmcRatio,
          lmcRatioPct: `${(lmcRatio * 100).toFixed(2)}%`,
          expectedRange: `${(config.minLmcRatio * 100).toFixed(1)}% - ${(config.maxLmcRatio * 100).toFixed(1)}%`,
        },
      };
    }

    return {
      filterName: "LIQUIDITY_MARKET_CAP_DEPTH",
      passed: true,
      details: {
        liquidityUsd: pool.liquidityUsd,
        marketCapUsd: pool.marketCapUsd,
        lmcRatio,
        lmcRatioPct: `${(lmcRatio * 100).toFixed(2)}%`,
      },
    };
  }
}
