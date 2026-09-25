import { describe, expect, it } from "vitest";
import { CANDIDATE_SCANNER_DEFAULTS } from "./CandidateScannerConfig.js";
import { CandidateScannerEvaluator } from "./CandidateScannerEvaluator.js";
import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";

function makePool(overrides: Partial<ScannedPoolRecord> = {}): ScannedPoolRecord {
  const nowSec = 1790290000;
  return {
    poolId: "pool11111111111111111111111111111111111111111",
    mintAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    symbol: "RAY",
    decimals: 6,
    baseMint: "So11111111111111111111111111111111111111112",
    liquidityUsd: 20000,
    marketCapUsd: 100000, // L/MC = 20.0% (Valid)
    openTimeSec: nowSec - 600, // 10 minutes old (Valid)
    lpBurnPct: 100.0, // 100% burned (Valid)
    mintAuthority: null, // Renounced (Valid)
    freezeAuthority: null, // Renounced (Valid)
    volume5mUsd: 3000,
    txCount5m: 30, // AvgTx = $100 (Valid)
    buys5m: 20,
    sells5m: 10, // Net positive (Valid)
    spotPriceUsd: 2.1,
    fetchedAt: new Date(nowSec * 1000).toISOString(),
    ...overrides,
  };
}

describe("CandidateScannerEvaluator", () => {
  const evaluator = new CandidateScannerEvaluator();
  const nowSec = 1790290000;

  it("admits valid candidate passing all filters", () => {
    const pool = makePool();
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(true);
    expect(result.candidate).toBeDefined();
    expect(result.candidate?.canonicalMint).toBe(pool.mintAddress);
    expect(result.candidate?.lmcRatio).toBe(0.2);
    expect(result.candidate?.assetAgeSeconds).toBe(600);
    expect(result.primaryRejectionReason).toBeUndefined();
  });

  it("rejects token when pair is too young (< 300s)", () => {
    const pool = makePool({ openTimeSec: nowSec - 120 }); // 2 min old
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_OUTSIDE_MATURITY_WINDOW");
  });

  it("rejects token when pair is too old (> 900s)", () => {
    const pool = makePool({ openTimeSec: nowSec - 1800 }); // 30 min old
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_OUTSIDE_MATURITY_WINDOW");
  });

  it("rejects token with L/MC underflow (< 15%)", () => {
    const pool = makePool({ liquidityUsd: 10000, marketCapUsd: 100000 }); // 10.0%
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_IMBALANCED_LIQUIDITY_DEPTH");
  });

  it("rejects token with L/MC overflow (> 30%)", () => {
    const pool = makePool({ liquidityUsd: 40000, marketCapUsd: 100000 }); // 40.0%
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_IMBALANCED_LIQUIDITY_DEPTH");
  });

  it("rejects token with unlocked LP (< 90% burned)", () => {
    const pool = makePool({ lpBurnPct: 50.0 });
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
  });

  it("rejects token with active mint authority", () => {
    const pool = makePool({ mintAuthority: "ActiveDevWallet11111111111111111111111111" });
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_ACTIVE_MINT_AUTHORITY");
  });

  it("rejects token with active freeze authority", () => {
    const pool = makePool({ freezeAuthority: "ActiveDevFreezeWallet11111111111111111" });
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_ACTIVE_FREEZE_AUTHORITY");
  });

  it("rejects token with insufficient transaction count (< 20)", () => {
    const pool = makePool({ txCount5m: 10 });
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_INSUFFICIENT_TRANSACTION_COUNT");
  });

  it("rejects wash trading transaction size anomaly", () => {
    const pool = makePool({ txCount5m: 20, volume5mUsd: 100000 }); // Avg $5,000 > $2,500
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_WASH_TRADE_SIZE_ANOMALY");
  });

  it("rejects net seller dominance when buys < sells", () => {
    const pool = makePool({ buys5m: 10, sells5m: 25 });
    const result = evaluator.evaluate(pool, CANDIDATE_SCANNER_DEFAULTS, nowSec);

    expect(result.admitted).toBe(false);
    expect(result.primaryRejectionReason).toBe("REJECTED_NET_SELLER_DOMINANCE");
  });
});
