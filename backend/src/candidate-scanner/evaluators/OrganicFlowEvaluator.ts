import type {
  CandidateScannerFilterEvaluation,
  CandidateScannerRuntimeConfig,
  ScannedPoolRecord,
} from "../CandidateScannerTypes.js";

export class OrganicFlowEvaluator {
  evaluate(
    pool: ScannedPoolRecord,
    config: CandidateScannerRuntimeConfig,
  ): CandidateScannerFilterEvaluation {
    // 1. Transaction count check
    if (pool.txCount5m < config.minTxCount5m) {
      return {
        filterName: "ORGANIC_TRANSACTION_COUNT",
        passed: false,
        reason: "REJECTED_INSUFFICIENT_TRANSACTION_COUNT",
        details: {
          txCount5m: pool.txCount5m,
          minTxCount5m: config.minTxCount5m,
        },
      };
    }

    // 2. Average transaction size check (Wash Trade Filter)
    const avgTxUsd = pool.txCount5m > 0 ? pool.volume5mUsd / pool.txCount5m : 0;
    if (avgTxUsd < config.minAvgTxUsd || avgTxUsd > config.maxAvgTxUsd) {
      return {
        filterName: "ORGANIC_WASH_TRADE_SIZE",
        passed: false,
        reason: "REJECTED_WASH_TRADE_SIZE_ANOMALY",
        details: {
          avgTxUsd,
          volume5mUsd: pool.volume5mUsd,
          txCount5m: pool.txCount5m,
          minAvgTxUsd: config.minAvgTxUsd,
          maxAvgTxUsd: config.maxAvgTxUsd,
        },
      };
    }

    // 3. Net buyer flow check
    if (config.requireNetBuyerFlow && pool.buys5m < pool.sells5m) {
      return {
        filterName: "ORGANIC_NET_BUYER_FLOW",
        passed: false,
        reason: "REJECTED_NET_SELLER_DOMINANCE",
        details: {
          buys5m: pool.buys5m,
          sells5m: pool.sells5m,
          netFlow: pool.buys5m - pool.sells5m,
        },
      };
    }

    return {
      filterName: "ORGANIC_BUYER_FLOW",
      passed: true,
      details: {
        txCount5m: pool.txCount5m,
        volume5mUsd: pool.volume5mUsd,
        avgTxUsd,
        buys5m: pool.buys5m,
        sells5m: pool.sells5m,
      },
    };
  }
}
