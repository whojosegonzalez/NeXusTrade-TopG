import type { WatchlistCandidateItem } from "@nexustrade/shared";
import type { StrategyThresholds } from "@nexustrade/shared";

export interface BuyGateConfig {
  readonly minMaturityAgeSec: number; // default: 300 (5m)
  readonly maxMaturityAgeSec: number; // default: 900 (15m)
  readonly minLmcRatio: number; // default: 0.15 (15%)
  readonly maxLmcRatio: number; // default: 0.55 (55%)
  readonly minBuyToSellRatio: number; // default: 1.5
  readonly minVolume5mUsd: number; // default: 2500
  readonly minAvgTxUsd: number; // default: 25
  readonly maxSingleTxDisposalPct: number; // default: 0.05 (5%)
  readonly minSells5m: number; // default: 15
  readonly minLiquidityUsd: number; // default: 20000
  readonly maxBundlerPct: number; // default: 0.35 (35%)
  readonly maxTop10HolderPct: number; // default: 0.30 (30%)
  readonly minHoldersCount: number; // default: 350
}

export const BUY_GATE_DEFAULTS: BuyGateConfig = {
  minMaturityAgeSec: 300,
  maxMaturityAgeSec: 900,
  minLmcRatio: 0.15,
  maxLmcRatio: 0.55,
  minBuyToSellRatio: 1.5,
  minVolume5mUsd: 2500,
  minAvgTxUsd: 25,
  maxSingleTxDisposalPct: 0.05,
  minSells5m: 15,
  minLiquidityUsd: 20000,
  maxBundlerPct: 0.35,
  maxTop10HolderPct: 0.3,
  minHoldersCount: 350,
};

export interface GateCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly value: number;
  readonly requirement: string;
}

export interface BuyGateEvaluationResult {
  readonly triggered: boolean;
  readonly poolId: string;
  readonly mintAddress: string;
  readonly symbol: string;
  readonly gates: readonly GateCheck[];
  readonly rejectionReason?: string | undefined;
}

export interface AdvancedMarketContext {
  readonly maxSingleDisposalUsd?: number | undefined;
  readonly recentBuysCount60s?: number | undefined;
  readonly recentSellsCount60s?: number | undefined;
  readonly momentum1mBps?: number | undefined;
  readonly bundlerPct?: number | undefined;
  readonly top10HolderPct?: number | undefined;
  readonly holdersCount?: number | undefined;
}

export class BuyGateTriggerService {
  private readonly config: BuyGateConfig;

  constructor(config: Partial<BuyGateConfig> = {}) {
    this.config = { ...BUY_GATE_DEFAULTS, ...config };
  }

  public static fromStrategyThresholds(
    thresholds?: Partial<StrategyThresholds>,
  ): BuyGateTriggerService {
    if (!thresholds) return new BuyGateTriggerService();
    return new BuyGateTriggerService({
      minLmcRatio: thresholds.minLmcRatio ?? BUY_GATE_DEFAULTS.minLmcRatio,
      maxLmcRatio: thresholds.maxLmcRatio ?? BUY_GATE_DEFAULTS.maxLmcRatio,
      minBuyToSellRatio: thresholds.minBuyToSellRatio ?? BUY_GATE_DEFAULTS.minBuyToSellRatio,
      minVolume5mUsd: thresholds.minVolume5mUsd ?? BUY_GATE_DEFAULTS.minVolume5mUsd,
      minMaturityAgeSec: thresholds.minMaturityAgeSec ?? BUY_GATE_DEFAULTS.minMaturityAgeSec,
      maxMaturityAgeSec: thresholds.maxMaturityAgeSec ?? BUY_GATE_DEFAULTS.maxMaturityAgeSec,
    });
  }

  public evaluateCandidate(
    item: WatchlistCandidateItem,
    marketContext: AdvancedMarketContext = {},
  ): BuyGateEvaluationResult {
    const gates: GateCheck[] = [];

    // 1. Maturity Window Gate (Supports Established Runners 2h-24h, or Adaptive Micro-Caps 300s to 900s/2700s)
    const isEstablishedRunner =
      item.liquidityUsd >= 40000 &&
      item.marketCapUsd >= 100000 &&
      item.assetAgeSeconds >= 7200 &&
      item.assetAgeSeconds <= 86400;

    const isHighLiqVol = item.liquidityUsd >= 20000 && item.volume5mUsd >= 25000;
    const maxMaturityAgeSec = isEstablishedRunner
      ? 86400
      : isHighLiqVol
        ? Math.max(this.config.maxMaturityAgeSec, 2700)
        : this.config.maxMaturityAgeSec;

    const maturityPassed = isEstablishedRunner
      ? true
      : item.assetAgeSeconds >= this.config.minMaturityAgeSec &&
        item.assetAgeSeconds <= maxMaturityAgeSec;

    gates.push({
      name: "MATURITY_WINDOW_GATE",
      passed: maturityPassed,
      value: item.assetAgeSeconds,
      requirement: isEstablishedRunner
        ? "7200s <= Age <= 86400s (Established Runner)"
        : `${this.config.minMaturityAgeSec}s <= Age <= ${maxMaturityAgeSec}s`,
    });

    // 2. Minimum Liquidity Gate (>= $20,000 to prevent overnight micro-cap honeypots)
    const liquidityPassed = item.liquidityUsd >= this.config.minLiquidityUsd;
    gates.push({
      name: "MIN_LIQUIDITY_GATE",
      passed: liquidityPassed,
      value: item.liquidityUsd,
      requirement: `Liquidity >= $${this.config.minLiquidityUsd}`,
    });

    // 3. Depth Balance Gate (0.15 to 0.30 L/MC)
    const depthPassed =
      item.lmcRatio >= this.config.minLmcRatio && item.lmcRatio <= this.config.maxLmcRatio;
    gates.push({
      name: "DEPTH_BALANCE_GATE",
      passed: depthPassed,
      value: item.lmcRatio,
      requirement: `${(this.config.minLmcRatio * 100).toFixed(0)}% <= L/MC <= ${(this.config.maxLmcRatio * 100).toFixed(0)}%`,
    });

    // 4. Flow Absorption Gate (Buys >= 1.5 * Sells, or >= 1.20 for high-volume breakouts >= $50k)
    const isHighVolumeBreakout = item.volume5mUsd >= 50000;
    const effectiveMinRatio = isHighVolumeBreakout
      ? Math.min(this.config.minBuyToSellRatio, 1.2)
      : this.config.minBuyToSellRatio;
    const flowPassed = item.buyToSellRatio >= effectiveMinRatio;
    gates.push({
      name: "FLOW_ABSORPTION_GATE",
      passed: flowPassed,
      value: item.buyToSellRatio,
      requirement: `Buys/Sells >= ${effectiveMinRatio}x`,
    });

    // 5. Volume Surge Gate (Volume >= $2,500 & Avg Tx >= $25)
    const totalTx = item.buys5m + item.sells5m;
    const avgTxUsd = totalTx > 0 ? item.volume5mUsd / totalTx : 0;
    const volumePassed =
      item.volume5mUsd >= this.config.minVolume5mUsd && avgTxUsd >= this.config.minAvgTxUsd;
    gates.push({
      name: "VOLUME_SURGE_GATE",
      passed: volumePassed,
      value: item.volume5mUsd,
      requirement: `Vol5m >= $${this.config.minVolume5mUsd} & AvgTx >= $${this.config.minAvgTxUsd}`,
    });

    // 6. Min Sells Gate (Anti-Sniper: require >= 15 sells to avoid untested pools)
    const minSellsPassed = item.sells5m >= this.config.minSells5m;
    gates.push({
      name: "MIN_SELLS_GATE",
      passed: minSellsPassed,
      value: item.sells5m,
      requirement: `Sells5m >= ${this.config.minSells5m}`,
    });

    // 7. Short Horizon Flow Gate (1m flow & momentum check when available)
    const hasShortHorizonData =
      marketContext.recentBuysCount60s !== undefined ||
      marketContext.recentSellsCount60s !== undefined ||
      marketContext.momentum1mBps !== undefined;
    if (hasShortHorizonData) {
      const buys60s = marketContext.recentBuysCount60s ?? 0;
      const sells60s = marketContext.recentSellsCount60s ?? 0;
      const mom1m = marketContext.momentum1mBps ?? 0;
      const shortFlowPassed = !(sells60s > buys60s || mom1m < -500);
      gates.push({
        name: "SHORT_HORIZON_FLOW_GATE",
        passed: shortFlowPassed,
        value: mom1m,
        requirement: "Buys60s >= Sells60s & Mom1m >= -5.0%",
      });
    }

    // 8. Dev Disposal Gate (No single disposal > 5% of liquidity)
    const maxDisposal = marketContext.maxSingleDisposalUsd ?? 0;
    const maxDisposalPct = item.liquidityUsd > 0 ? maxDisposal / item.liquidityUsd : 0;
    const devDisposalPassed = maxDisposalPct <= this.config.maxSingleTxDisposalPct;
    gates.push({
      name: "DEV_DISPOSAL_GATE",
      passed: devDisposalPassed,
      value: maxDisposalPct,
      requirement: `Single Tx Disposal <= ${(this.config.maxSingleTxDisposalPct * 100).toFixed(0)}% of Liquidity`,
    });

    // 9. Anti-Bundler & Top-Holder Concentration Gate
    const bundlerPct = marketContext.bundlerPct;
    const top10HolderPct = marketContext.top10HolderPct;
    const holdersCount = marketContext.holdersCount;

    const bundlerViolation = bundlerPct !== undefined && bundlerPct > this.config.maxBundlerPct;
    const top10Violation =
      top10HolderPct !== undefined && top10HolderPct > this.config.maxTop10HolderPct;
    const holdersViolation =
      holdersCount !== undefined && holdersCount < this.config.minHoldersCount;

    const bundlerPassed = !bundlerViolation && !top10Violation && !holdersViolation;
    gates.push({
      name: "BUNDLER_CONCENTRATION_GATE",
      passed: bundlerPassed,
      value: bundlerPct ?? top10HolderPct ?? (holdersCount !== undefined ? holdersCount : 0),
      requirement: `Bundler <= ${(this.config.maxBundlerPct * 100).toFixed(0)}%, Top10 <= ${(this.config.maxTop10HolderPct * 100).toFixed(0)}%, Holders >= ${this.config.minHoldersCount}`,
    });

    const failedGate = gates.find((g) => !g.passed);
    const triggered = !failedGate;

    return {
      triggered,
      poolId: item.poolId,
      mintAddress: item.mintAddress,
      symbol: item.symbol,
      gates,
      ...(failedGate ? { rejectionReason: `${failedGate.name}_FAILED` } : {}),
    };
  }

  public static async fetchRugCheckMetrics(
    mintAddress: string,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ bundlerPct?: number; top10HolderPct?: number; holdersCount?: number } | null> {
    const url = `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mintAddress)}/report/summary`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        risks?: Array<{ name?: string; value?: string; score?: number; level?: string }>;
        tokenMeta?: { mutable?: boolean };
        topHolders?: Array<{ pct?: number; address?: string }>;
        totalHolders?: number;
      };

      let bundlerPct: number | undefined;
      let top10HolderPct: number | undefined;
      const holdersCount: number | undefined = data.totalHolders;

      if (Array.isArray(data.topHolders) && data.topHolders.length > 0) {
        top10HolderPct = data.topHolders
          .slice(0, 10)
          .reduce((acc, h) => acc + (typeof h.pct === "number" ? h.pct / 100 : 0), 0);
      }

      if (Array.isArray(data.risks)) {
        for (const risk of data.risks) {
          const riskName = (risk.name || "").toLowerCase();
          if (
            riskName.includes("bundled") ||
            riskName.includes("insider") ||
            riskName.includes("dev holding")
          ) {
            const rawVal = parseFloat(risk.value || "0");
            if (!Number.isNaN(rawVal)) {
              bundlerPct = rawVal > 1 ? rawVal / 100 : rawVal;
            }
          }
        }
      }

      const result: {
        bundlerPct?: number;
        top10HolderPct?: number;
        holdersCount?: number;
      } = {};
      if (bundlerPct !== undefined) result.bundlerPct = bundlerPct;
      if (top10HolderPct !== undefined) result.top10HolderPct = top10HolderPct;
      if (holdersCount !== undefined) result.holdersCount = holdersCount;

      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
