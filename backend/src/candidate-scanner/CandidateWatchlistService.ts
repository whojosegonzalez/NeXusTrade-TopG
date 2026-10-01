import type { WatchlistCandidateItem, WatchlistCandidateStatus } from "@nexustrade/shared";
import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";

export interface CandidateWatchlistConfig {
  readonly maxWatchlistSize: number; // default: 20
  readonly minLiquidityUsd: number; // default: 2500
  readonly minLpBurnPct: number; // default: 90.0
  readonly minTxCount5m: number; // default: 10
  readonly maxWatchlistAgeSec: number; // default: 1200 (20m)
}

export const CANDIDATE_WATCHLIST_DEFAULTS: CandidateWatchlistConfig = {
  maxWatchlistSize: 20,
  minLiquidityUsd: 2500,
  minLpBurnPct: 90.0,
  minTxCount5m: 10,
  maxWatchlistAgeSec: 1200,
};

export class CandidateWatchlistService {
  private readonly config: CandidateWatchlistConfig;
  private readonly items = new Map<string, WatchlistCandidateItem>();

  constructor(config: Partial<CandidateWatchlistConfig> = {}) {
    this.config = { ...CANDIDATE_WATCHLIST_DEFAULTS, ...config };
  }

  public admitOrUpdate(pool: ScannedPoolRecord, nowSec: number): WatchlistCandidateItem | null {
    const ageSeconds = Math.max(0, nowSec - pool.openTimeSec);
    const lmcRatio = pool.marketCapUsd > 0 ? pool.liquidityUsd / pool.marketCapUsd : 0;
    const buyToSellRatio =
      pool.sells5m > 0 ? pool.buys5m / pool.sells5m : pool.buys5m > 0 ? 999 : 1.0;
    const nowIso = new Date(nowSec * 1000).toISOString();

    const isEstablishedRunner =
      pool.liquidityUsd >= 50000 && ageSeconds >= 1800 && ageSeconds <= 7200;
    const isHighLiquidity = pool.liquidityUsd >= 20000;
    const effectiveMaxAgeSec = isEstablishedRunner
      ? 7200
      : isHighLiquidity
        ? 3600
        : this.config.maxWatchlistAgeSec;

    const existing = this.items.get(pool.poolId);
    if (existing) {
      // Check if age expired while on watchlist
      let updatedStatus = existing.status;
      let rejectionReason = existing.rejectionReason;

      if (existing.status === "WATCHING" && ageSeconds > effectiveMaxAgeSec) {
        updatedStatus = "DROPPED";
        rejectionReason =
          pool.liquidityUsd >= 50000 && ageSeconds > 7200
            ? "EXCEEDED_MAX_ESTABLISHED_AGE_2H"
            : isHighLiquidity
              ? "EXCEEDED_MAX_WATCHLIST_AGE_60M"
              : "EXCEEDED_MAX_WATCHLIST_AGE_20M";
      } else if (existing.status === "DROPPED") {
        // Check for fresh bullish reversal / dip-bounce
        if (
          pool.buys5m >= 25 &&
          pool.buys5m / Math.max(1, pool.sells5m) >= 1.8 &&
          pool.volume5mUsd >= 5000 &&
          ageSeconds <= effectiveMaxAgeSec
        ) {
          updatedStatus = "WATCHING";
          rejectionReason = undefined;
        }
      }

      const updated: WatchlistCandidateItem = {
        ...existing,
        liquidityUsd: pool.liquidityUsd,
        marketCapUsd: pool.marketCapUsd,
        lmcRatio,
        lpBurnPct: pool.lpBurnPct,
        assetAgeSeconds: ageSeconds,
        volume5mUsd: pool.volume5mUsd,
        buys5m: pool.buys5m,
        sells5m: pool.sells5m,
        buyToSellRatio,
        status: updatedStatus,
        rejectionReason,
        lastEvaluatedAt: nowIso,
      };

      this.items.set(pool.poolId, updated);
      return updated;
    }

    // Baseline Safety Screening for new candidate admission
    if (pool.liquidityUsd < this.config.minLiquidityUsd) {
      return null;
    }
    if (pool.lpBurnPct < this.config.minLpBurnPct) {
      return null;
    }
    if (pool.mintAuthority !== null || pool.freezeAuthority !== null) {
      return null;
    }
    if (pool.txCount5m < this.config.minTxCount5m) {
      return null;
    }
    if (ageSeconds > effectiveMaxAgeSec) {
      return null;
    }

    // Capacity management
    if (this.items.size >= this.config.maxWatchlistSize) {
      // Prune any dropped items first
      this.pruneDropped();
      if (this.items.size >= this.config.maxWatchlistSize) {
        // Drop the oldest item
        const oldestKey = this.items.keys().next().value;
        if (oldestKey) {
          this.items.delete(oldestKey);
        }
      }
    }

    const newItem: WatchlistCandidateItem = {
      poolId: pool.poolId,
      mintAddress: pool.mintAddress,
      symbol: pool.symbol,
      liquidityUsd: pool.liquidityUsd,
      marketCapUsd: pool.marketCapUsd,
      lmcRatio,
      lpBurnPct: pool.lpBurnPct,
      assetAgeSeconds: ageSeconds,
      volume5mUsd: pool.volume5mUsd,
      buys5m: pool.buys5m,
      sells5m: pool.sells5m,
      buyToSellRatio,
      status: "WATCHING",
      discoveredAt: nowIso,
      lastEvaluatedAt: nowIso,
    };

    this.items.set(pool.poolId, newItem);
    return newItem;
  }

  public getItems(): readonly WatchlistCandidateItem[] {
    return Array.from(this.items.values());
  }

  public getActiveWatchingItems(): readonly WatchlistCandidateItem[] {
    return Array.from(this.items.values()).filter((item) => item.status === "WATCHING");
  }

  public getItem(poolId: string): WatchlistCandidateItem | undefined {
    return this.items.get(poolId);
  }

  public updateStatus(
    poolId: string,
    status: WatchlistCandidateStatus,
    rejectionReason?: string,
  ): void {
    const existing = this.items.get(poolId);
    if (!existing) return;

    this.items.set(poolId, {
      ...existing,
      status,
      rejectionReason: rejectionReason ?? existing.rejectionReason,
      lastEvaluatedAt: new Date().toISOString(),
    });
  }

  public pruneExpired(nowSec: number): WatchlistCandidateItem[] {
    const expiredItems: WatchlistCandidateItem[] = [];
    for (const [poolId, item] of this.items.entries()) {
      const lastEvaluatedSec = Math.floor(new Date(item.lastEvaluatedAt).getTime() / 1000);
      const elapsedSec = Number.isFinite(lastEvaluatedSec)
        ? Math.max(0, nowSec - lastEvaluatedSec)
        : 0;
      const currentAgeSec = item.assetAgeSeconds + elapsedSec;

      const isEstablishedRunner =
        item.liquidityUsd >= 50000 && currentAgeSec >= 1800 && currentAgeSec <= 7200;
      const isHighLiquidity = item.liquidityUsd >= 20000;
      const effectiveMaxAgeSec = isEstablishedRunner
        ? 7200
        : isHighLiquidity
          ? 3600
          : this.config.maxWatchlistAgeSec;

      if (item.status === "WATCHING" && currentAgeSec > effectiveMaxAgeSec) {
        const droppedItem: WatchlistCandidateItem = {
          ...item,
          assetAgeSeconds: currentAgeSec,
          status: "DROPPED",
          rejectionReason:
            item.liquidityUsd >= 50000 && currentAgeSec > 7200
              ? "EXCEEDED_MAX_ESTABLISHED_AGE_2H"
              : isHighLiquidity
                ? "EXCEEDED_MAX_WATCHLIST_AGE_60M"
                : "EXCEEDED_MAX_WATCHLIST_AGE_20M",
          lastEvaluatedAt: new Date(nowSec * 1000).toISOString(),
        };
        this.items.set(poolId, droppedItem);
        expiredItems.push(droppedItem);
      }
    }
    return expiredItems;
  }

  private pruneDropped(): void {
    for (const [poolId, item] of this.items.entries()) {
      if (item.status === "DROPPED") {
        this.items.delete(poolId);
      }
    }
  }

  public clear(): void {
    this.items.clear();
  }
}
