import type { WatchlistCandidateItem } from "@nexustrade/shared";
import type { StrategyThresholds } from "@nexustrade/shared";

export interface BuyGateConfig {
  readonly minMaturityAgeSec: number; // default: 300 (5m)
  readonly maxMaturityAgeSec: number; // default: 900 (15m)
  readonly minLmcRatio: number; // default: 0.15 (15%)
  readonly maxLmcRatio: number; // default: 0.30 (30%)
  readonly minBuyToSellRatio: number; // default: 1.5
  readonly minVolume5mUsd: number; // default: 2500
  readonly minAvgTxUsd: number; // default: 25
  readonly maxSingleTxDisposalPct: number; // default: 0.05 (5%)
}

export const BUY_GATE_DEFAULTS: BuyGateConfig = {
  minMaturityAgeSec: 300,
  maxMaturityAgeSec: 900,
  minLmcRatio: 0.15,
  maxLmcRatio: 0.3,
  minBuyToSellRatio: 1.5,
  minVolume5mUsd: 2500,
  minAvgTxUsd: 25,
  maxSingleTxDisposalPct: 0.05,
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

    // 1. Maturity Window Gate (300s to 900s)
    const maturityPassed =
      item.assetAgeSeconds >= this.config.minMaturityAgeSec &&
      item.assetAgeSeconds <= this.config.maxMaturityAgeSec;
    gates.push({
      name: "MATURITY_WINDOW_GATE",
      passed: maturityPassed,
      value: item.assetAgeSeconds,
      requirement: `${this.config.minMaturityAgeSec}s <= Age <= ${this.config.maxMaturityAgeSec}s`,
    });

    // 2. Depth Balance Gate (0.15 to 0.30 L/MC)
    const depthPassed =
      item.lmcRatio >= this.config.minLmcRatio && item.lmcRatio <= this.config.maxLmcRatio;
    gates.push({
      name: "DEPTH_BALANCE_GATE",
      passed: depthPassed,
      value: item.lmcRatio,
      requirement: `${(this.config.minLmcRatio * 100).toFixed(0)}% <= L/MC <= ${(this.config.maxLmcRatio * 100).toFixed(0)}%`,
    });

    // 3. Flow Absorption Gate (Buys >= 1.5 * Sells)
    const flowPassed = item.buyToSellRatio >= this.config.minBuyToSellRatio;
    gates.push({
      name: "FLOW_ABSORPTION_GATE",
      passed: flowPassed,
      value: item.buyToSellRatio,
      requirement: `Buys/Sells >= ${this.config.minBuyToSellRatio}x`,
    });

    // 4. Volume Surge Gate (Volume >= $2,500 & Avg Tx >= $25)
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

    // 5. Dev Disposal Gate (No single disposal > 5% of liquidity)
    const maxDisposal = marketContext.maxSingleDisposalUsd ?? 0;
    const maxDisposalPct = item.liquidityUsd > 0 ? maxDisposal / item.liquidityUsd : 0;
    const devDisposalPassed = maxDisposalPct <= this.config.maxSingleTxDisposalPct;
    gates.push({
      name: "DEV_DISPOSAL_GATE",
      passed: devDisposalPassed,
      value: maxDisposalPct,
      requirement: `Single Tx Disposal <= ${(this.config.maxSingleTxDisposalPct * 100).toFixed(0)}% of Liquidity`,
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
}
