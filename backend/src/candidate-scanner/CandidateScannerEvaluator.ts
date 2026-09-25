import { AntiRugEvaluator } from "./evaluators/AntiRugEvaluator.js";
import { LiquidityMarketCapEvaluator } from "./evaluators/LiquidityMarketCapEvaluator.js";
import { OrganicFlowEvaluator } from "./evaluators/OrganicFlowEvaluator.js";
import type {
  CandidateScannerCandidate,
  CandidateScannerEvaluationResult,
  CandidateScannerFilterEvaluation,
  CandidateScannerRuntimeConfig,
  ScannedPoolRecord,
} from "./CandidateScannerTypes.js";

export class CandidateScannerEvaluator {
  private readonly lmcEvaluator = new LiquidityMarketCapEvaluator();
  private readonly antiRugEvaluator = new AntiRugEvaluator();
  private readonly organicFlowEvaluator = new OrganicFlowEvaluator();

  public evaluate(
    pool: ScannedPoolRecord,
    config: CandidateScannerRuntimeConfig,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): CandidateScannerEvaluationResult {
    const filterEvaluations: CandidateScannerFilterEvaluation[] = [];

    // 1. Pair Maturity Window check (5m to 15m)
    const assetAgeSeconds = pool.openTimeSec > 0 ? Math.max(0, nowSec - pool.openTimeSec) : 0;
    if (assetAgeSeconds < config.minAgeSec || assetAgeSeconds > config.maxAgeSec) {
      const maturityEval: CandidateScannerFilterEvaluation = {
        filterName: "PAIR_MATURITY_WINDOW",
        passed: false,
        reason: "REJECTED_OUTSIDE_MATURITY_WINDOW",
        details: {
          assetAgeSeconds,
          minAgeSec: config.minAgeSec,
          maxAgeSec: config.maxAgeSec,
          openTimeSec: pool.openTimeSec,
        },
      };
      filterEvaluations.push(maturityEval);
      return {
        admitted: false,
        primaryRejectionReason: "REJECTED_OUTSIDE_MATURITY_WINDOW",
        filterEvaluations,
      };
    }
    filterEvaluations.push({
      filterName: "PAIR_MATURITY_WINDOW",
      passed: true,
      details: { assetAgeSeconds },
    });

    // 2. Anti-Rug & Authority check
    const antiRugEval = this.antiRugEvaluator.evaluate(pool, config);
    filterEvaluations.push(antiRugEval);
    if (!antiRugEval.passed) {
      return {
        admitted: false,
        primaryRejectionReason: antiRugEval.reason,
        filterEvaluations,
      };
    }

    // 3. Liquidity-to-Market-Cap (L/MC) check
    const lmcEval = this.lmcEvaluator.evaluate(pool, config);
    filterEvaluations.push(lmcEval);
    if (!lmcEval.passed) {
      return {
        admitted: false,
        primaryRejectionReason: lmcEval.reason,
        filterEvaluations,
      };
    }

    // 4. Organic Flow check
    const organicEval = this.organicFlowEvaluator.evaluate(pool, config);
    filterEvaluations.push(organicEval);
    if (!organicEval.passed) {
      return {
        admitted: false,
        primaryRejectionReason: organicEval.reason,
        filterEvaluations,
      };
    }

    // All filters passed -> Admit Candidate
    const lmcRatio = pool.marketCapUsd > 0 ? pool.liquidityUsd / pool.marketCapUsd : 0;
    const candidate: CandidateScannerCandidate = {
      canonicalMint: pool.mintAddress,
      symbol: pool.symbol,
      slotId: `slot-${pool.poolId.slice(0, 8)}`,
      discoveredAt: new Date(nowSec * 1000).toISOString(),
      assetAgeSeconds,
      liquidityUsd: pool.liquidityUsd,
      marketCapUsd: pool.marketCapUsd,
      lmcRatio,
      lpBurnPct: pool.lpBurnPct,
      spotPriceUsd: pool.spotPriceUsd,
      filterEvaluations,
    };

    return {
      admitted: true,
      candidate,
      filterEvaluations,
    };
  }
}
