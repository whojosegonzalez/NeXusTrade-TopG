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
  readonly maxBundlerPct: number; // default: 0.85 (85%)
  readonly maxTop10HolderPct: number; // default: 0.30 (30%)
  readonly minHoldersCount: number; // default: 350
  readonly maxRugScore: number; // default: 700
  readonly rejectDangerRisks: boolean; // default: true
  readonly maxEstablishedMacroDrawdownPct: number; // default: -15.0 (-15%)
  readonly maxMicroTxCount5m: number; // default: 300
  readonly maxMicroSells5m: number; // default: 100
  readonly minEstablishedHolders: number; // default: 250
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
  maxBundlerPct: 0.85,
  maxTop10HolderPct: 0.3,
  minHoldersCount: 350,
  maxRugScore: 700,
  rejectDangerRisks: true,
  maxEstablishedMacroDrawdownPct: -15.0,
  maxMicroTxCount5m: 300,
  maxMicroSells5m: 100,
  minEstablishedHolders: 250,
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

export interface ArmedPullbackState {
  readonly mintAddress: string;
  readonly armedAtMs: number;
  readonly peakPriceSol: number;
  readonly peakPriceUsd: number;
  ticksObserved: number;
}

export interface AdvancedMarketContext {
  readonly maxSingleDisposalUsd?: number | undefined;
  readonly recentBuysCount60s?: number | undefined;
  readonly recentSellsCount60s?: number | undefined;
  readonly momentum1mBps?: number | undefined;
  readonly bundlerPct?: number | undefined;
  readonly top10HolderPct?: number | undefined;
  readonly holdersCount?: number | undefined;
  readonly rugScore?: number | undefined;
  readonly hasDangerRisk?: boolean | undefined;
  readonly priceChange1hPct?: number | undefined;
  readonly requireVerifiedHolders?: boolean | undefined;
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

    // Established / High-Volume pool detection
    // MANDATORY Liquidity Floor & Anti-Stale Distribution Ceiling:
    // Must have >= $50,000 liquidity AND age between 1800s (30m) and 7200s (2h)
    const isCandidateEstablished =
      item.liquidityUsd >= 50000 && item.assetAgeSeconds >= 1800 && item.assetAgeSeconds <= 7200;

    // When holdersCount is provided (Stage 2 post-RugCheck), enforce minEstablishedHolders (>= 250).
    // When holdersCount is undefined:
    //   - If requireVerifiedHolders is false or undefined (Preliminary in-memory screening):
    //     permit the candidate to qualify preliminarily so spot info and RugCheck can be queried.
    //   - If requireVerifiedHolders is true: fail-closed (cannot be established).
    const hasEstablishedHolders =
      marketContext.holdersCount !== undefined
        ? marketContext.holdersCount >= this.config.minEstablishedHolders
        : !marketContext.requireVerifiedHolders;

    const isEstablished = isCandidateEstablished && hasEstablishedHolders;

    const isEstablishedRunner = isEstablished || isCandidateEstablished;

    const isHighLiqVol = item.liquidityUsd >= 20000 && item.volume5mUsd >= 25000;
    const maxMaturityAgeSec = isEstablishedRunner
      ? 7200
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
        ? "1800s <= Age <= 7200s (Established Runner)"
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

    // 3. Adaptive Depth Balance Gate (3% for established, 15% for micro-caps, up to 55%)
    const effectiveMinLmc = isEstablishedRunner ? 0.03 : this.config.minLmcRatio;
    const depthPassed =
      item.lmcRatio >= effectiveMinLmc && item.lmcRatio <= this.config.maxLmcRatio;
    gates.push({
      name: "DEPTH_BALANCE_GATE",
      passed: depthPassed,
      value: item.lmcRatio,
      requirement: `${(effectiveMinLmc * 100).toFixed(0)}% <= L/MC <= ${(this.config.maxLmcRatio * 100).toFixed(0)}%${isEstablishedRunner ? " (Adaptive Established Pool)" : ""}`,
    });

    // 4. Flow Absorption Gate (Buys >= 1.5 * Sells, or relaxed for volume breakouts)
    // For strong volume surges (>= $15k in 5m), relax buyer dominance requirement to 1.25x (or 1.15x if >= $35k)
    let effectiveMinRatio = this.config.minBuyToSellRatio;
    if (item.volume5mUsd >= 35000) {
      effectiveMinRatio = Math.min(effectiveMinRatio, 1.15);
    } else if (item.volume5mUsd >= 15000) {
      effectiveMinRatio = Math.min(effectiveMinRatio, 1.25);
    }
    const flowPassed = item.buyToSellRatio >= effectiveMinRatio;
    gates.push({
      name: "FLOW_ABSORPTION_GATE",
      passed: flowPassed,
      value: item.buyToSellRatio,
      requirement: `Buys/Sells >= ${effectiveMinRatio}x`,
    });

    // 5. Wash-Trading Transaction Ceiling Gate (Anti-Wash-Trading botnet filter)
    const totalTx5m = item.buys5m + item.sells5m;
    const txCountPassed = isEstablishedRunner || totalTx5m <= this.config.maxMicroTxCount5m;
    gates.push({
      name: "WASH_TRADING_CEILING_GATE",
      passed: txCountPassed,
      value: totalTx5m,
      requirement: isEstablishedRunner
        ? "Uncapped (Established Pool)"
        : `TotalTx5m <= ${this.config.maxMicroTxCount5m} (Anti-Wash-Trading)`,
    });

    // 6. Sell Congestion Ceiling Gate (Anti-Avalanche dump filter)
    const sellCongestionPassed = isEstablishedRunner || item.sells5m <= this.config.maxMicroSells5m;
    gates.push({
      name: "SELL_CONGESTION_CEILING_GATE",
      passed: sellCongestionPassed,
      value: item.sells5m,
      requirement: isEstablishedRunner
        ? "Uncapped (Established Pool)"
        : `Sells5m <= ${this.config.maxMicroSells5m} (Anti-Sell-Congestion)`,
    });

    // 7. Volume Surge Gate (Volume >= $2,500 & Avg Tx >= $25)
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

    // 8. Min Sells Gate (Anti-Sniper: require >= 15 sells to avoid untested pools)
    const minSellsPassed = item.sells5m >= this.config.minSells5m;
    gates.push({
      name: "MIN_SELLS_GATE",
      passed: minSellsPassed,
      value: item.sells5m,
      requirement: `Sells5m >= ${this.config.minSells5m}`,
    });

    // 9. Short Horizon Flow Gate (1m flow & momentum check when available)
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

    // 10. Dev Disposal Gate (No single disposal > 5% of liquidity)
    const maxDisposal = marketContext.maxSingleDisposalUsd ?? 0;
    const maxDisposalPct = item.liquidityUsd > 0 ? maxDisposal / item.liquidityUsd : 0;
    const devDisposalPassed = maxDisposalPct <= this.config.maxSingleTxDisposalPct;
    gates.push({
      name: "DEV_DISPOSAL_GATE",
      passed: devDisposalPassed,
      value: maxDisposalPct,
      requirement: `Single Tx Disposal <= ${(this.config.maxSingleTxDisposalPct * 100).toFixed(0)}% of Liquidity`,
    });

    // 11. RugCheck Security & Holder Concentration Gate
    const rugScore = marketContext.rugScore;
    const hasDangerRisk = marketContext.hasDangerRisk;
    const bundlerPct = marketContext.bundlerPct;
    const top10HolderPct = marketContext.top10HolderPct;
    const holdersCount = marketContext.holdersCount;

    let rugCheckFailureReason: string | undefined;
    const maxBundlerAllowed = isEstablished ? this.config.maxBundlerPct : 0.5; // 50% ceiling on micro-caps
    const effectiveMinHolders = isEstablishedRunner
      ? this.config.minEstablishedHolders
      : this.config.minHoldersCount;

    if (rugScore !== undefined && rugScore > this.config.maxRugScore) {
      rugCheckFailureReason = "RUGCHECK_HIGH_RISK_SCORE_FAILED";
    } else if (this.config.rejectDangerRisks && hasDangerRisk) {
      rugCheckFailureReason = "RUGCHECK_DANGER_FLAG_FAILED";
    } else if (marketContext.requireVerifiedHolders && holdersCount === undefined) {
      rugCheckFailureReason = "REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN";
    } else if (
      marketContext.requireVerifiedHolders &&
      holdersCount !== undefined &&
      holdersCount < (isEstablishedRunner ? this.config.minEstablishedHolders : 100)
    ) {
      rugCheckFailureReason = "INSUFFICIENT_HOLDERS_COUNT_FAILED";
    } else if (
      !marketContext.requireVerifiedHolders &&
      holdersCount !== undefined &&
      holdersCount < effectiveMinHolders
    ) {
      rugCheckFailureReason = "INSUFFICIENT_HOLDERS_COUNT_FAILED";
    } else if (top10HolderPct !== undefined && top10HolderPct > this.config.maxTop10HolderPct) {
      rugCheckFailureReason = "TOP_10_CONCENTRATION_FAILED";
    } else if (bundlerPct !== undefined && bundlerPct > maxBundlerAllowed) {
      rugCheckFailureReason = "BUNDLER_CONCENTRATION_GATE_FAILED";
    }

    const bundlerPassed = !rugCheckFailureReason;
    gates.push({
      name: "BUNDLER_CONCENTRATION_GATE",
      passed: bundlerPassed,
      value:
        rugScore ?? bundlerPct ?? top10HolderPct ?? (holdersCount !== undefined ? holdersCount : 0),
      requirement: `Score <= ${this.config.maxRugScore}, No Danger, Bundler <= ${(maxBundlerAllowed * 100).toFixed(0)}%, Top10 <= ${(this.config.maxTop10HolderPct * 100).toFixed(0)}%, Holders >= ${effectiveMinHolders}`,
    });

    // 12. Established Macro Trend Gate (Anti-Dead-Cat Bounce Gate)
    if (isEstablished) {
      const priceChange1h = marketContext.priceChange1hPct;
      const macroPassed =
        priceChange1h === undefined || priceChange1h >= this.config.maxEstablishedMacroDrawdownPct;
      gates.push({
        name: "ESTABLISHED_MACRO_TREND_GATE",
        passed: macroPassed,
        value: priceChange1h ?? 0,
        requirement: `1h Price Change >= ${this.config.maxEstablishedMacroDrawdownPct.toFixed(1)}%`,
      });
    }

    const failedGate = gates.find((g) => !g.passed);
    const triggered = !failedGate;

    let rejectionReason: string | undefined;
    if (failedGate) {
      if (failedGate.name === "BUNDLER_CONCENTRATION_GATE" && rugCheckFailureReason) {
        rejectionReason = rugCheckFailureReason;
      } else if (failedGate.name === "ESTABLISHED_MACRO_TREND_GATE") {
        rejectionReason = "REJECTED_ESTABLISHED_MACRO_DOWNTREND";
      } else if (failedGate.name === "WASH_TRADING_CEILING_GATE") {
        rejectionReason = "REJECTED_EXCESSIVE_WASH_TRADING_TX_COUNT";
      } else if (failedGate.name === "SELL_CONGESTION_CEILING_GATE") {
        rejectionReason = "REJECTED_EXCESSIVE_SELL_CONGESTION";
      } else {
        rejectionReason = `${failedGate.name}_FAILED`;
      }
    }

    return {
      triggered,
      poolId: item.poolId,
      mintAddress: item.mintAddress,
      symbol: item.symbol,
      gates,
      ...(rejectionReason ? { rejectionReason } : {}),
    };
  }

  public static async fetchRugCheckMetrics(
    mintAddress: string,
    fetchFn: typeof fetch = fetch,
  ): Promise<{
    rugScore?: number;
    hasDangerRisk?: boolean;
    bundlerPct?: number;
    top10HolderPct?: number;
    holdersCount?: number;
  } | null> {
    const url = `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mintAddress)}/report`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        score?: number;
        score_normalised?: number;
        risks?: Array<{ name?: string; value?: string; score?: number; level?: string }>;
        tokenMeta?: { mutable?: boolean };
        topHolders?: Array<{ pct?: number; address?: string }>;
        totalHolders?: number;
      };

      const rugScore = typeof data.score === "number" ? data.score : 0;
      const hasDangerRisk =
        Array.isArray(data.risks) && data.risks.some((r) => r.level === "danger");
      const holdersCount = typeof data.totalHolders === "number" ? data.totalHolders : undefined;

      let top10HolderPct: number | undefined;
      if (Array.isArray(data.topHolders) && data.topHolders.length > 0) {
        top10HolderPct = data.topHolders
          .slice(0, 10)
          .reduce((acc, h) => acc + (typeof h.pct === "number" ? h.pct / 100 : 0), 0);
      }

      let bundlerPct: number | undefined;
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
        rugScore?: number;
        hasDangerRisk?: boolean;
        bundlerPct?: number;
        top10HolderPct?: number;
        holdersCount?: number;
      } = {
        rugScore,
        hasDangerRisk,
      };
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
