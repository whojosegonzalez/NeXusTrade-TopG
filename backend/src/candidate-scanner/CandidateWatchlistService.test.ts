import { describe, expect, it } from "vitest";
import { CandidateWatchlistService } from "./CandidateWatchlistService.js";
import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";

describe("CandidateWatchlistService", () => {
  const nowSec = 1_000_000;

  const validPool: ScannedPoolRecord = {
    poolId: "pool-safe-1",
    mintAddress: "TokenMintSafe111111111111111111111111111111111",
    symbol: "SAFE",
    decimals: 9,
    baseMint: "So11111111111111111111111111111111111111112",
    liquidityUsd: 15_000,
    marketCapUsd: 60_000,
    openTimeSec: nowSec - 400, // 400s age
    lpBurnPct: 99.0,
    mintAuthority: null,
    freezeAuthority: null,
    volume5mUsd: 8_000,
    txCount5m: 40,
    buys5m: 30,
    sells5m: 10,
    spotPriceUsd: 0.05,
    fetchedAt: new Date(nowSec * 1000).toISOString(),
  };

  it("admits safe pools meeting baseline liquidity, burn, and authority criteria", () => {
    const service = new CandidateWatchlistService();
    const item = service.admitOrUpdate(validPool, nowSec);

    expect(item).not.toBeNull();
    expect(item?.symbol).toBe("SAFE");
    expect(item?.status).toBe("WATCHING");
    expect(item?.liquidityUsd).toBe(15_000);
    expect(item?.assetAgeSeconds).toBe(400);
    expect(item?.buyToSellRatio).toBe(3.0);
  });

  it("rejects pools failing baseline safety filters", () => {
    const service = new CandidateWatchlistService();

    // 1. Low liquidity (< $2,500)
    const lowLiq = service.admitOrUpdate({ ...validPool, liquidityUsd: 1500 }, nowSec);
    expect(lowLiq).toBeNull();

    // 2. Low LP burn (< 90%)
    const lowBurn = service.admitOrUpdate({ ...validPool, lpBurnPct: 75.0 }, nowSec);
    expect(lowBurn).toBeNull();

    // 3. Active mint authority
    const activeMint = service.admitOrUpdate(
      { ...validPool, mintAuthority: "DevAdminKey1111" },
      nowSec,
    );
    expect(activeMint).toBeNull();

    // 4. Active freeze authority
    const activeFreeze = service.admitOrUpdate(
      { ...validPool, freezeAuthority: "DevAdminKey1111" },
      nowSec,
    );
    expect(activeFreeze).toBeNull();

    // 5. Insufficient 5m transaction count (< 10)
    const lowTx = service.admitOrUpdate({ ...validPool, txCount5m: 5 }, nowSec);
    expect(lowTx).toBeNull();
  });

  it("updates existing watchlist candidate metrics on repeat scan", () => {
    const service = new CandidateWatchlistService();
    service.admitOrUpdate(validPool, nowSec);

    // Update with increased volume and higher buy count
    const updatedPool: ScannedPoolRecord = {
      ...validPool,
      liquidityUsd: 22_000,
      volume5mUsd: 12_000,
      buys5m: 45,
      sells5m: 15,
    };

    const updatedItem = service.admitOrUpdate(updatedPool, nowSec + 60);
    expect(updatedItem).not.toBeNull();
    expect(updatedItem?.liquidityUsd).toBe(22_000);
    expect(updatedItem?.volume5mUsd).toBe(12_000);
    expect(updatedItem?.buys5m).toBe(45);
    expect(updatedItem?.assetAgeSeconds).toBe(460);
  });

  it("drops decaying pool when age exceeds 1,200s (20m)", () => {
    const service = new CandidateWatchlistService();
    service.admitOrUpdate(validPool, nowSec);

    // Later scan after pool age has reached 1,300s
    const oldPool: ScannedPoolRecord = {
      ...validPool,
      openTimeSec: nowSec - 1300,
    };

    const droppedItem = service.admitOrUpdate(oldPool, nowSec);
    expect(droppedItem?.status).toBe("DROPPED");
    expect(droppedItem?.rejectionReason).toBe("EXCEEDED_MAX_WATCHLIST_AGE_20M");

    const activeItems = service.getActiveWatchingItems();
    expect(activeItems.length).toBe(0);
  });

  it("retains high-liquidity candidate (>= $20k) beyond 20m up to 60m (3,600s)", () => {
    const service = new CandidateWatchlistService();
    const highLiqPool: ScannedPoolRecord = {
      ...validPool,
      liquidityUsd: 25_000,
      openTimeSec: nowSec - 1800, // 30m age (1800s)
    };

    const item = service.admitOrUpdate(highLiqPool, nowSec);
    expect(item?.status).toBe("WATCHING");

    // Later scan at 3,700s age -> dropped with EXCEEDED_MAX_WATCHLIST_AGE_60M
    const expiredPool = {
      ...highLiqPool,
      openTimeSec: nowSec - 3700,
    };
    const droppedItem = service.admitOrUpdate(expiredPool, nowSec);
    expect(droppedItem?.status).toBe("DROPPED");
    expect(droppedItem?.rejectionReason).toBe("EXCEEDED_MAX_WATCHLIST_AGE_60M");
  });

  it("retains established runner (>= $50k liq) within 30m to 2h (7,200s) and drops stale > 2h with EXCEEDED_MAX_ESTABLISHED_AGE_2H", () => {
    const service = new CandidateWatchlistService();
    const runnerPool: ScannedPoolRecord = {
      ...validPool,
      liquidityUsd: 50_000,
      marketCapUsd: 200_000,
      openTimeSec: nowSec - 3600, // 1h age (within 1800s - 7200s)
    };

    const item = service.admitOrUpdate(runnerPool, nowSec);
    expect(item?.status).toBe("WATCHING");

    // Scan past 2h (e.g. 7,500s) -> dropped with EXCEEDED_MAX_ESTABLISHED_AGE_2H
    const expiredRunner = {
      ...runnerPool,
      openTimeSec: nowSec - 7500,
    };
    const droppedItem = service.admitOrUpdate(expiredRunner, nowSec);
    expect(droppedItem?.status).toBe("DROPPED");
    expect(droppedItem?.rejectionReason).toBe("EXCEEDED_MAX_ESTABLISHED_AGE_2H");
  });

  it("respects maxWatchlistSize capacity", () => {
    const service = new CandidateWatchlistService({ maxWatchlistSize: 2 });

    service.admitOrUpdate({ ...validPool, poolId: "pool-1", mintAddress: "Mint1" }, nowSec);
    service.admitOrUpdate({ ...validPool, poolId: "pool-2", mintAddress: "Mint2" }, nowSec);
    expect(service.getItems().length).toBe(2);

    // 3rd pool should drop the oldest item to maintain capacity of 2
    service.admitOrUpdate({ ...validPool, poolId: "pool-3", mintAddress: "Mint3" }, nowSec);
    expect(service.getItems().length).toBe(2);
    expect(service.getItem("pool-3")).toBeDefined();
  });

  it("revives DROPPED candidate when fresh bullish reversal occurs (buys >= 25, ratio >= 1.8, vol >= $5k)", () => {
    const service = new CandidateWatchlistService();
    service.admitOrUpdate(validPool, nowSec);

    // Explicitly mark candidate as DROPPED
    service.updateStatus(validPool.poolId, "DROPPED", "MOMENTUM_STALLED");
    expect(service.getItem(validPool.poolId)?.status).toBe("DROPPED");

    // Candidate prints a fresh reversal wave
    const reversalPool: ScannedPoolRecord = {
      ...validPool,
      buys5m: 30, // >= 25
      sells5m: 10, // ratio 3.0 >= 1.8
      volume5mUsd: 7500, // >= $5000
    };

    const revived = service.admitOrUpdate(reversalPool, nowSec + 60);
    expect(revived?.status).toBe("WATCHING");
    expect(revived?.rejectionReason).toBeUndefined();
    expect(service.getActiveWatchingItems().length).toBe(1);
  });

  it("pruneExpired drops expired items and returns array of dropped candidate records", () => {
    const service = new CandidateWatchlistService();
    // Micro-cap pool (limit: 1200s)
    service.admitOrUpdate(validPool, nowSec);

    // Established runner pool (limit: 7200s)
    const runnerPool: ScannedPoolRecord = {
      ...validPool,
      poolId: "pool-runner",
      mintAddress: "MintRunner111111111111111111111111111111111",
      liquidityUsd: 60_000,
      openTimeSec: nowSec - 3600,
    };
    service.admitOrUpdate(runnerPool, nowSec);

    // Call pruneExpired when micro-cap has exceeded 1200s (e.g. nowSec + 1300), but runner is still valid
    const droppedAt1300 = service.pruneExpired(nowSec + 1300);
    expect(droppedAt1300.length).toBe(1);
    expect(droppedAt1300[0]?.poolId).toBe(validPool.poolId);
    expect(droppedAt1300[0]?.status).toBe("DROPPED");
    expect(droppedAt1300[0]?.rejectionReason).toBe("EXCEEDED_MAX_WATCHLIST_AGE_20M");

    // Later, when runner has exceeded 7200s (openTimeSec was nowSec - 3600, so age > 7200 at nowSec + 3700)
    const droppedAt3700 = service.pruneExpired(nowSec + 3700);
    expect(droppedAt3700.length).toBe(1);
    expect(droppedAt3700[0]?.poolId).toBe("pool-runner");
    expect(droppedAt3700[0]?.status).toBe("DROPPED");
    expect(droppedAt3700[0]?.rejectionReason).toBe("EXCEEDED_MAX_ESTABLISHED_AGE_2H");
  });
});
