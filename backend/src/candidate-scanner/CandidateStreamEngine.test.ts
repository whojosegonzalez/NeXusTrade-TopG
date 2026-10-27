import { describe, expect, it, vi } from "vitest";
import { parseCandidateScannerConfigArgs } from "./CandidateScannerConfig.js";
import {
  CandidateStreamEngine,
  type CandidateStreamEngineOptions,
} from "./CandidateStreamEngine.js";
import type {
  CandidateScannerCandidate,
  CandidateScannerEvaluationResult,
  ScannedPoolRecord,
} from "./CandidateScannerTypes.js";
import {
  CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
  CAPTURED_RAY_WSOL_IDENTITIES,
  createSyntheticRayCandidatePool,
  SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import type { LpFreshnessPolicy, ValidatedLpEvidenceInput } from "./LpScreeningBridge.js";

describe("CandidateStreamEngine", () => {
  const config = parseCandidateScannerConfigArgs([]);

  it("fetches, evaluates, and admits candidates from mock Raydium pool response", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockFetch: typeof fetch = async (input) => {
      if (typeof input === "string" && input.includes("raydium.io/pools/info/list")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              data: [
                {
                  id: "pool11111111111111111111111111111111111111111",
                  openTime: String(nowSec - 600), // 10 min old (Valid)
                  tvl: 25000,
                  price: 1.5,
                  burnPercent: 1.0,
                  mintA: {
                    address: "So11111111111111111111111111111111111111112",
                    symbol: "WSOL",
                    decimals: 9,
                  },
                  mintB: {
                    address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
                    symbol: "RAY",
                    decimals: 6,
                  },
                  day: { volume: 288000 },
                },
                {
                  id: "pool22222222222222222222222222222222222222222",
                  openTime: String(nowSec - 60), // 1 min old (Too young -> Rejected)
                  tvl: 25000,
                  price: 0.5,
                  burnPercent: 1.0,
                  mintA: {
                    address: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx",
                    symbol: "STONK",
                    decimals: 6,
                  },
                  mintB: {
                    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    symbol: "USDC",
                    decimals: 6,
                  },
                  day: { volume: 288000 },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const admittedCandidates: CandidateScannerCandidate[] = [];
    const engine = new CandidateStreamEngine({
      config,
      fetchFn: mockFetch,
      onCandidate: (c) => admittedCandidates.push(c),
    });

    const results = await engine.scanOnce(nowSec);
    expect(results.length).toBe(2);
    expect(engine.stats.scannedPools).toBe(2);
    expect(engine.stats.admittedCandidates).toBe(1);
    expect(engine.stats.rejectedMaturity).toBe(1);
    expect(admittedCandidates.length).toBe(1);
    expect(admittedCandidates[0]?.canonicalMint).toBe(
      "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    );
    expect(engine.isMintSeen("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R")).toBe(true);

    // Second scan deduplicates already admitted mint
    const secondResults = await engine.scanOnce(nowSec);
    expect(secondResults.length).toBe(1); // Only pool2 evaluated; pool1 skipped by deduplication
    expect(engine.stats.admittedCandidates).toBe(1);
  });

  it("handles network failure gracefully and records error counter", async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error("Connection timed out");
    };

    const engine = new CandidateStreamEngine({
      config,
      fetchFn: mockFetch,
    });

    const results = await engine.scanOnce();
    expect(results.length).toBe(0);
    expect(engine.stats.errors).toBe(1);
  });

  it("ingests and enriches pools from DexScreener token profiles with live pair data", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = typeof input === "string" ? input : (input as Request).url;
      if (urlStr.includes("token-profiles/latest/v1")) {
        return new Response(
          JSON.stringify([
            {
              url: "https://dexscreener.com/solana/real111",
              chainId: "solana",
              tokenAddress: "RealMint11111111111111111111111111111111111",
              icon: "https://icon.png",
              description: "Real active token",
            },
            {
              url: "https://dexscreener.com/solana/ghost222",
              chainId: "solana",
              tokenAddress: "GhostMint2222222222222222222222222222222222",
              icon: "https://icon.png",
              description: "Ghost token with no DEX pair",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("dex/tokens/RealMint11111111111111111111111111111111111")) {
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "PairAddress111111111111111111111111111111111",
                baseToken: {
                  address: "RealMint11111111111111111111111111111111111",
                  name: "Real Token",
                  symbol: "REAL",
                },
                quoteToken: {
                  address: "So11111111111111111111111111111111111111112",
                  name: "Wrapped SOL",
                  symbol: "SOL",
                },
                priceNative: "0.0002",
                priceUsd: "0.028",
                txns: {
                  m5: { buys: 30, sells: 10 },
                },
                volume: {
                  m5: 5000,
                },
                liquidity: {
                  usd: 25000,
                  quote: 180,
                },
                fdv: 100000,
                marketCap: 100000,
                pairCreatedAt: (nowSec - 500) * 1000, // 500s ago
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("dex/tokens/GhostMint2222222222222222222222222222222222")) {
        // Ghost token returns empty pairs array
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            pairs: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const admittedCandidates: CandidateScannerCandidate[] = [];
    const engine = new CandidateStreamEngine({
      config,
      fetchFn: mockFetch,
      onCandidate: (c) => admittedCandidates.push(c),
    });

    const results = await engine.scanOnce(nowSec);
    // RealMint admitted, GhostMint discarded
    expect(results.length).toBe(1);
    expect(results[0]?.admitted).toBe(true);
    expect(admittedCandidates.length).toBe(1);
    expect(admittedCandidates[0]?.canonicalMint).toBe(
      "RealMint11111111111111111111111111111111111",
    );
    expect(admittedCandidates[0]?.symbol).toBe("REAL");
    expect(admittedCandidates[0]?.liquidityUsd).toBe(25000);
  });

  it("ingests and admits established runners from DexScreener boosted pools (Stream B)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = typeof input === "string" ? input : (input as Request).url;
      if (urlStr.includes("token-boosts/top/v1") || urlStr.includes("token-boosts/latest/v1")) {
        return new Response(
          JSON.stringify([
            {
              chainId: "solana",
              tokenAddress: "RunnerMint11111111111111111111111111111111",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("dex/tokens/RunnerMint11111111111111111111111111111111")) {
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            pairs: [
              {
                chainId: "solana",
                pairAddress: "RunnerPair11111111111111111111111111111111",
                baseToken: {
                  address: "RunnerMint11111111111111111111111111111111",
                  name: "Established Runner",
                  symbol: "RUNNER",
                },
                quoteToken: {
                  address: "So11111111111111111111111111111111111111112",
                  name: "Wrapped SOL",
                  symbol: "SOL",
                },
                priceNative: "0.001",
                priceUsd: "0.14",
                txns: {
                  m5: { buys: 60, sells: 30 },
                },
                volume: {
                  m5: 25000,
                },
                liquidity: {
                  usd: 60000,
                  quote: 420,
                },
                fdv: 250000,
                marketCap: 250000,
                pairCreatedAt: (nowSec - 14400) * 1000, // 4 hours old (7200s - 86400s)
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const engine = new CandidateStreamEngine({
      config,
      fetchFn: mockFetch,
    });

    const boostedPools = await engine.fetchDexScreenerBoostedPools();
    expect(boostedPools.length).toBe(1);
    expect(boostedPools[0]?.symbol).toBe("RUNNER");
    expect(boostedPools[0]?.liquidityUsd).toBe(60000);
    expect(boostedPools[0]?.marketCapUsd).toBe(250000);
    expect(nowSec - (boostedPools[0]?.openTimeSec ?? 0)).toBeGreaterThanOrEqual(7200);
  });

  it("fetches top traded pools from Raydium 24H volume API", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = typeof input === "string" ? input : (input as Request).url;
      if (urlStr.includes("poolSortField=volume24h")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              data: [
                {
                  id: "raydiumTopPool111111111111111111111111111111",
                  openTime: "1700000000",
                  tvl: 150000,
                  burnPercent: 1.0,
                  price: 2.5,
                  mintA: {
                    address: "So11111111111111111111111111111111111111112",
                    symbol: "WSOL",
                    decimals: 9,
                  },
                  mintB: {
                    address: "TopTradedMint11111111111111111111111111111",
                    symbol: "TOPG",
                    decimals: 6,
                  },
                  day: { volume: 500000 },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const engine = new CandidateStreamEngine({
      config,
      fetchFn: mockFetch,
    });

    const topPools = await engine.fetchRaydiumTopTradedPools(10);
    expect(topPools.length).toBe(1);
    expect(topPools[0]?.symbol).toBe("TOPG");
    expect(topPools[0]?.mintAddress).toBe("TopTradedMint11111111111111111111111111111");
    expect(topPools[0]?.liquidityUsd).toBe(150000);
  });

  it("fetches recent token updates from DexScreener token-profiles/recent-updates", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = typeof input === "string" ? input : (input as Request).url;
      if (urlStr.includes("token-profiles/recent-updates/v1")) {
        return new Response(
          JSON.stringify([
            {
              chainId: "solana",
              tokenAddress: "UpdatedMint1111111111111111111111111111111",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("dex/tokens/UpdatedMint1111111111111111111111111111111")) {
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            pairs: [
              {
                chainId: "solana",
                pairAddress: "UpdatedPair111111111111111111111111111111",
                baseToken: {
                  address: "UpdatedMint1111111111111111111111111111111",
                  name: "Updated Token",
                  symbol: "UPDATE",
                },
                quoteToken: {
                  address: "So11111111111111111111111111111111111111112",
                  name: "Wrapped SOL",
                  symbol: "SOL",
                },
                priceNative: "0.005",
                priceUsd: "0.75",
                liquidity: { usd: 85000 },
                txns: { m5: { buys: 40, sells: 20 } },
                volume: { m5: 12000 },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const engine = new CandidateStreamEngine({
      config,
      fetchFn: mockFetch,
    });

    const recentUpdatedPools = await engine.fetchDexScreenerRecentUpdates();
    expect(recentUpdatedPools.length).toBe(1);
    expect(recentUpdatedPools[0]?.symbol).toBe("UPDATE");
    expect(recentUpdatedPools[0]?.mintAddress).toBe("UpdatedMint1111111111111111111111111111111");
    expect(recentUpdatedPools[0]?.liquidityUsd).toBe(85000);
  });

  describe("Guarded Intake Integration (Validated-LP Mode)", () => {
    // Replay clock anchors for authentic captured snapshot (retrievedAt: 2026-10-27T06:35:11.779Z)
    const CAPTURED_REPLAY_TIME_MS = 1793082911779;
    const CAPTURED_REPLAY_NOW_MS = CAPTURED_REPLAY_TIME_MS + 5000; // 5s after acquisition
    const CAPTURED_REPLAY_NOW_SEC = Math.floor(CAPTURED_REPLAY_NOW_MS / 1000);

    const freshnessPolicy: LpFreshnessPolicy = {
      maxEvidenceAgeMs: 60_000,
      currentTimestampMs: CAPTURED_REPLAY_NOW_MS,
      clockSkewToleranceMs: 5000,
    };

    it("rejects captured RAY/WSOL evidence with below-threshold LP rejection (0.135682% < 90%)", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const decisions: Array<{ status: string; admitted: boolean; pool: ScannedPoolRecord }> = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          decisions.push({
            status: String(evalResult.filterEvaluations[0]?.details?.status ?? "UNKNOWN"),
            admitted: evalResult.admitted,
            pool,
          });
        },
      });

      // Labeled synthetic market context wrapping authentic RAY/WSOL identities
      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600, // 10 min old (in 5m-15m window)
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        volume5mUsd: 5000,
        txCount5m: 30,
        buys5m: 18,
        sells5m: 12,
        lpBurnPct: 100.0,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evalResult.filterEvaluations.length).toBeGreaterThanOrEqual(1);

      const lpFilter = evalResult.filterEvaluations[0]!;
      expect(lpFilter.filterName).toBe("ANTI_RUG_LP_SECURITY");
      expect(lpFilter.passed).toBe(false);
      expect(lpFilter.details?.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(Number(lpFilter.details?.lpBurnPct)).toBeCloseTo(0.135682, 4);
      expect(lpFilter.details?.meetsNinetyPercentThreshold).toBe(false);

      expect(admitted.length).toBe(0);
      expect(decisions.length).toBe(1);
      expect(decisions[0]?.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(decisions[0]?.admitted).toBe(false);
      // Callback assertions: real measurement preserved with DERIVED provenance
      expect(decisions[0]?.pool.lpBurnPct).toBeCloseTo(0.135682, 4);
      expect(decisions[0]?.pool.metricProvenance?.lpBurnPct).toBe("DERIVED");
      expect(decisions[0]?.pool.rawProviderLpBurnPct).toBe(100.0);
      expect(engine.stats.rejectedRug).toBe(1);
      expect(engine.stats.admittedCandidates).toBe(0);
    });

    it("admits coherent synthetic qualifying evidence when all remaining checks pass", async () => {
      const admitted: CandidateScannerCandidate[] = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
      });

      // Labeled synthetic market context: mature, renounced, balanced L/MC, positive flow
      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600, // 10 min old
        liquidityUsd: 25_000,
        marketCapUsd: 100_000, // L/MC = 0.25 (valid between 0.05 and 0.80)
        volume5mUsd: 5000,
        txCount5m: 30,
        buys5m: 18,
        sells5m: 12,
        mintAuthority: null, // Renounced
        freezeAuthority: null, // Renounced
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(true);
      expect(evalResult.candidate).toBeDefined();
      expect(evalResult.candidate?.canonicalMint).toBe(
        CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint,
      );
      expect(evalResult.candidate?.lpBurnPct).toBe(98.5);
      expect(evalResult.candidate?.metricProvenance?.lpBurnPct).toBe("DERIVED");

      const expectedMint = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
      expect(admitted.length).toBe(1);
      expect(admitted[0]?.canonicalMint).toBe(expectedMint);
      expect(engine.stats.admittedCandidates).toBe(1);
      expect(engine.isMintSeen(expectedMint)).toBe(true);
    });

    it("fails admission when qualifying LP evidence is paired with an active mint authority (remaining check fails)", async () => {
      const admitted: CandidateScannerCandidate[] = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        volume5mUsd: 5000,
        txCount5m: 30,
        buys5m: 18,
        sells5m: 12,
        mintAuthority: "ActiveDevMintAuth111111111111111111111111111", // Active authority!
        freezeAuthority: null,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_ACTIVE_MINT_AUTHORITY");
      expect(admitted.length).toBe(0);
      expect(engine.stats.rejectedRug).toBe(1);
      expect(engine.stats.admittedCandidates).toBe(0);
    });

    it("fails admission when qualifying LP evidence is paired with pool outside maturity window", async () => {
      const admitted: CandidateScannerCandidate[] = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 60, // 1 min old (Too young!)
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        volume5mUsd: 5000,
        txCount5m: 30,
        buys5m: 18,
        sells5m: 12,
        mintAuthority: null,
        freezeAuthority: null,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_OUTSIDE_MATURITY_WINDOW");
      expect(admitted.length).toBe(0);
      expect(engine.stats.rejectedMaturity).toBe(1);
      expect(engine.stats.admittedCandidates).toBe(0);
    });

    it("fails closed when lpEvidenceResolver is missing in validated-LP mode", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const recordedDecisions: Array<{
        evalResult: CandidateScannerEvaluationResult;
        pool: ScannedPoolRecord;
      }> = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        // No resolver provided
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          recordedDecisions.push({ evalResult, pool });
        },
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        lpBurnPct: 100.0,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("UNAVAILABLE");
      expect(admitted.length).toBe(0);

      // Decision callback receives safe nullable LP decision view
      expect(recordedDecisions.length).toBe(1);
      expect(recordedDecisions[0]?.pool.lpBurnPct).toBeNull();
      expect(recordedDecisions[0]?.pool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
      expect(recordedDecisions[0]?.pool.rawProviderLpBurnPct).toBe(100.0);
    });

    it("fails closed when resolver returns null evidence", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const recordedDecisions: Array<{
        evalResult: CandidateScannerEvaluationResult;
        pool: ScannedPoolRecord;
      }> = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => null,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          recordedDecisions.push({ evalResult, pool });
        },
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        lpBurnPct: 100.0,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("UNAVAILABLE");
      expect(admitted.length).toBe(0);

      // Decision callback receives safe nullable LP decision view
      expect(recordedDecisions.length).toBe(1);
      expect(recordedDecisions[0]?.pool.lpBurnPct).toBeNull();
      expect(recordedDecisions[0]?.pool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
      expect(recordedDecisions[0]?.pool.rawProviderLpBurnPct).toBe(100.0);
    });

    it("fails closed when LP evidence is stale", async () => {
      const admitted: CandidateScannerCandidate[] = [];

      // Stale policy: replay time is 120s after retrieval, maxEvidenceAgeMs is 60s
      const stalePolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: CAPTURED_REPLAY_TIME_MS + 120_000,
        clockSkewToleranceMs: 5000,
      };

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: stalePolicy,
        onCandidate: (c) => admitted.push(c),
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("STALE_EVIDENCE");
      expect(admitted.length).toBe(0);
    });

    it("fails closed on identity mismatch between candidate and evidence", async () => {
      const admitted: CandidateScannerCandidate[] = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
      });

      // Different token mint (USDC) than what is in evidence (RAY)
      const pool = createSyntheticRayCandidatePool({
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("IDENTITY_MISMATCH");
      expect(admitted.length).toBe(0);
    });

    it("fails closed when resolver throws an exception", async () => {
      const admitted: CandidateScannerCandidate[] = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => {
          throw new Error("Solana RPC 429 Too Many Requests");
        },
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("UNAVAILABLE");
      expect(admitted.length).toBe(0);
    });

    it("fails closed on unsupported inputs and illegal pool substitution without calling resolver", async () => {
      let resolverCalled = 0;

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => {
          resolverCalled++;
          return SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE;
        },
        lpFreshnessPolicy: freshnessPolicy,
      });

      // Illegal pool substitution: dexscreener-${tokenAddress} where poolId === mintAddress
      const rayMint = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
      const pool = createSyntheticRayCandidatePool({
        poolId: `dexscreener-${rayMint}`,
        mintAddress: rayMint,
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("UNAVAILABLE");
      expect(resolverCalled).toBe(0); // Resolver never invoked for illegal substitution
    });

    it("strips provider display prefix dexscreener- so canonical address is passed to resolver", async () => {
      const recordedTargets: Array<Pick<ScannedPoolRecord, "poolId" | "mintAddress">> = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async (cand) => {
          recordedTargets.push(cand);
          return SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE;
        },
        lpFreshnessPolicy: freshnessPolicy,
      });

      const rayMint = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
      const pool = createSyntheticRayCandidatePool({
        poolId: `dexscreener-${CAPTURED_RAY_WSOL_IDENTITIES.poolId}`,
        mintAddress: rayMint,
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(recordedTargets.length).toBe(1);
      // Stripped of 'dexscreener-' prefix
      expect(recordedTargets[0]?.poolId).toBe(CAPTURED_RAY_WSOL_IDENTITIES.poolId);
      expect(recordedTargets[0]?.mintAddress).toBe(rayMint);
    });

    it("prevents legacy 100% placeholder from bypassing validated-LP mode", async () => {
      const placeholderPool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        lpBurnPct: 100.0,
        metricProvenance: {
          lpBurnPct: "PLACEHOLDER",
          liquidityUsd: "OBSERVED",
          marketCapUsd: "OBSERVED",
        },
      });

      // 1. In validated-LP mode with unavailable evidence -> MUST REJECT
      const validatedEngine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => null,
        lpFreshnessPolicy: freshnessPolicy,
      });

      const validatedResult = await validatedEngine.evaluatePoolAsync(
        placeholderPool,
        CAPTURED_REPLAY_NOW_SEC,
      );
      expect(validatedResult.admitted).toBe(false);
      expect(validatedResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");

      // 2. In unvalidated legacy mode -> passes through with 100% placeholder
      const legacyEngine = new CandidateStreamEngine({
        config,
        requireValidatedLp: false,
      });

      const legacyResult = legacyEngine.evaluatePool(placeholderPool, CAPTURED_REPLAY_NOW_SEC);
      expect(legacyResult.admitted).toBe(true);
    });

    it("distinguishes observed below-threshold from unavailable diagnostics without manufacturing numeric LP", async () => {
      // 1. Observed below-threshold (RAY/WSOL)
      const belowEngine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      const belowResult = await belowEngine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);
      const belowDetails = belowResult.filterEvaluations[0]?.details;
      expect(belowDetails?.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(belowDetails?.lpBurnPct).toBeDefined();
      expect(Number(belowDetails?.lpBurnPct)).toBeCloseTo(0.135682, 4);

      // 2. Unavailable evidence
      const unavailEngine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => null,
        lpFreshnessPolicy: freshnessPolicy,
      });

      const unavailResult = await unavailEngine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);
      const unavailDetails = unavailResult.filterEvaluations[0]?.details;
      expect(unavailDetails?.status).toBe("UNAVAILABLE");
      // Must NOT manufacture a numeric LP value
      expect(unavailDetails?.lpBurnPct).toBeUndefined();
    });

    it("fails closed when synchronous evaluatePool is called in validated-LP mode", () => {
      const admitted: CandidateScannerCandidate[] = [];

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
      });

      const result = engine.evaluatePool(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(result.admitted).toBe(false);
      expect(result.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(result.filterEvaluations[0]?.details?.status).toBe("UNAVAILABLE");
      expect(admitted.length).toBe(0);
    });

    it("proves missing evidence cannot qualify through an alternate evaluator or gate override", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const recordedDecisions: Array<{
        evalResult: CandidateScannerEvaluationResult;
        pool: ScannedPoolRecord;
      }> = [];

      // Attempting to bypass by passing resolver returning null and attempting an override
      const engineOptions: CandidateStreamEngineOptions = {
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => null,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          recordedDecisions.push({ evalResult, pool });
        },
      };

      // Even if an adversary injects an arbitrary bypass property at runtime:
      (engineOptions as unknown as Record<string, unknown>).lpBridgeEvaluator = async () => ({
        ok: true,
        status: "AVAILABLE_QUALIFIED",
        lpBurnPct: 99.9,
        retrievedAtIso: new Date(CAPTURED_REPLAY_TIME_MS).toISOString(),
        contextSlot: 461970878,
        evidenceOrigin: "CAPTURED_RPC",
        isSyntheticFixture: false,
        metricProvenance: "DERIVED",
        filterEvaluation: {
          filterName: "ANTI_RUG_LP_SECURITY",
          passed: true,
          details: { status: "AVAILABLE_QUALIFIED", lpBurnPct: 99.9 },
        },
        evidenceBoundary: { strategyGateAdmitted: true },
      });

      const engine = new CandidateStreamEngine(engineOptions);

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        lpBurnPct: 100.0,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      // Must fail closed; cannot qualify
      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("UNAVAILABLE");
      expect(admitted.length).toBe(0);
      expect(engine.stats.admittedCandidates).toBe(0);
      expect(recordedDecisions.length).toBe(1);
      expect(recordedDecisions[0]?.pool.lpBurnPct).toBeNull();
      expect(recordedDecisions[0]?.pool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
    });

    it("proves caller mutation during async resolution cannot alter original screening outcome", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const recordedDecisions: Array<{
        evalResult: CandidateScannerEvaluationResult;
        pool: ScannedPoolRecord;
      }> = [];

      // Initial pool has liquidityUsd = 1 (far below minLiquidityUsd = $5,000)
      const mutablePool = {
        ...createSyntheticRayCandidatePool({
          openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
          liquidityUsd: 1, // Below minimum threshold
          marketCapUsd: 100_000,
          volume5mUsd: 5000,
          txCount5m: 30,
          buys5m: 18,
          sells5m: 12,
        }),
      };

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => {
          // Simulate latency and caller mutating the pool while LP resolution is pending
          await new Promise((r) => setTimeout(r, 10));
          (mutablePool as { liquidityUsd: number }).liquidityUsd = 125_000; // Mutated to pass
          (mutablePool as { marketCapUsd: number }).marketCapUsd = 500_000;
          return SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE;
        },
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          recordedDecisions.push({ evalResult, pool });
        },
      });

      const evalResult = await engine.evaluatePoolAsync(mutablePool, CAPTURED_REPLAY_NOW_SEC);

      // Must reject because evaluation captured liquidityUsd = 1 at the beginning
      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_IMBALANCED_LIQUIDITY_DEPTH");
      expect(admitted.length).toBe(0);
      expect(engine.stats.admittedCandidates).toBe(0);
      expect(engine.stats.rejectedLmc).toBe(1);

      // Decision callback must receive the snapshot with liquidityUsd = 1, NOT 125,000
      expect(recordedDecisions.length).toBe(1);
      expect(recordedDecisions[0]?.pool.liquidityUsd).toBe(1);
    });

    it("contains malformed validationResult at intake boundary without throwing and produces structured rejection", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const recordedDecisions: Array<{
        evalResult: CandidateScannerEvaluationResult;
        pool: ScannedPoolRecord;
      }> = [];

      // Construct acquisition object with malformed validationResult (e.g. ok: true but missing diagnostics)
      const malformedAcquisition = {
        ...SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        validationResult: {
          ok: true,
          // Missing diagnostics object entirely (reproducing auditor's TypeError on diagnostics.slot)
        },
      };

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => malformedAcquisition as unknown as ValidatedLpEvidenceInput,
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          recordedDecisions.push({ evalResult, pool });
        },
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
      });

      // Must not throw!
      const evalResult = await engine.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");
      expect(evalResult.filterEvaluations[0]?.details?.status).toBe("INVALID_EVIDENCE");
      expect(admitted.length).toBe(0);
      expect(engine.stats.admittedCandidates).toBe(0);
      expect(engine.stats.rejectedRug).toBe(1);

      // Exactly one rejection callback with safe nullable LP
      expect(recordedDecisions.length).toBe(1);
      expect(recordedDecisions[0]?.evalResult.admitted).toBe(false);
      expect(recordedDecisions[0]?.pool.lpBurnPct).toBeNull();
      expect(recordedDecisions[0]?.pool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
    });

    it("continues processing subsequent candidates in scanOnce after encountering a candidate with malformed evidence", async () => {
      const admitted: CandidateScannerCandidate[] = [];
      const recordedDecisions: Array<{ mint: string; admitted: boolean }> = [];

      const candidate1Mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
      const candidate2Mint = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!; // RAY (matches SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE)

      // Pool 1 has malformed evidence
      const malformedAcquisition = {
        ...SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        validationResult: { ok: true }, // Malformed!
      };

      const engine = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async (cand) => {
          if (cand.mintAddress === candidate1Mint) {
            return malformedAcquisition as unknown as ValidatedLpEvidenceInput;
          }
          return SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE;
        },
        lpFreshnessPolicy: freshnessPolicy,
        onCandidate: (c) => admitted.push(c),
        onDecision: (evalResult, pool) => {
          recordedDecisions.push({ mint: pool.mintAddress, admitted: evalResult.admitted });
        },
      });

      const pool1 = createSyntheticRayCandidatePool({
        mintAddress: candidate1Mint,
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
      });

      const pool2 = createSyntheticRayCandidatePool({
        mintAddress: candidate2Mint,
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        mintAuthority: null,
        freezeAuthority: null,
      });

      // Mock fetchRawPools by mocking fetchRaydiumPools
      vi.spyOn(engine, "fetchRaydiumPools").mockResolvedValue([pool1, pool2]);
      vi.spyOn(engine, "fetchDexScreenerPools").mockResolvedValue([]);
      vi.spyOn(engine, "fetchDexScreenerBoostedPools").mockResolvedValue([]);
      vi.spyOn(engine, "fetchRaydiumTopTradedPools").mockResolvedValue([]);
      vi.spyOn(engine, "fetchDexScreenerRecentUpdates").mockResolvedValue([]);

      const results = await engine.scanOnce(CAPTURED_REPLAY_NOW_SEC);

      expect(results.length).toBe(2);
      expect(results[0]?.admitted).toBe(false);
      expect(results[1]?.admitted).toBe(true);
      expect(admitted.length).toBe(1);
      expect(admitted[0]?.canonicalMint).toBe(candidate2Mint);
      expect(recordedDecisions.length).toBe(2);
      expect(recordedDecisions[0]?.mint).toBe(candidate1Mint);
      expect(recordedDecisions[0]?.admitted).toBe(false);
      expect(recordedDecisions[1]?.mint).toBe(candidate2Mint);
      expect(recordedDecisions[1]?.admitted).toBe(true);
      expect(engine.stats.scannedPools).toBe(2);
      expect(engine.stats.rejectedRug).toBe(1);
      expect(engine.stats.admittedCandidates).toBe(1);
    });

    it("preserves unavailable LP semantics (lpBurnPct: null, UNAVAILABLE provenance) and separates raw provider context in callbacks", async () => {
      const callbacks: Array<{
        name: string;
        evalResult: CandidateScannerEvaluationResult;
        pool: ScannedPoolRecord;
      }> = [];

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: CAPTURED_REPLAY_NOW_SEC - 600,
        lpBurnPct: 100.0, // Original provider percentage
        metricProvenance: {
          lpBurnPct: "OBSERVED",
          liquidityUsd: "OBSERVED",
          marketCapUsd: "OBSERVED",
        },
      });

      // 1. Missing resolver
      const engineMissingResolver = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpFreshnessPolicy: freshnessPolicy,
        onDecision: (evalResult, p) =>
          callbacks.push({ name: "missingResolver", evalResult, pool: p }),
      });
      await engineMissingResolver.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      // 2. Resolver returning null
      const engineNullEvidence = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => null,
        lpFreshnessPolicy: freshnessPolicy,
        onDecision: (evalResult, p) =>
          callbacks.push({ name: "nullEvidence", evalResult, pool: p }),
      });
      await engineNullEvidence.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      // 3. Stale evidence
      const engineStale = new CandidateStreamEngine({
        config,
        requireValidatedLp: true,
        lpEvidenceResolver: async () => SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: CAPTURED_REPLAY_TIME_MS + 120_000, // Stale!
          clockSkewToleranceMs: 5000,
        },
        onDecision: (evalResult, p) =>
          callbacks.push({ name: "staleEvidence", evalResult, pool: p }),
      });
      await engineStale.evaluatePoolAsync(pool, CAPTURED_REPLAY_NOW_SEC);

      expect(callbacks.length).toBe(3);
      for (const cb of callbacks) {
        expect(cb.evalResult.admitted).toBe(false);
        // The decision's LP measurement must be null (never exposed as 100)
        expect(cb.pool.lpBurnPct).toBeNull();
        // Provenance must be UNAVAILABLE
        expect(cb.pool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
        // Raw provider percentage must be clearly separated
        expect(cb.pool.rawProviderLpBurnPct).toBe(100.0);
        // Candidate identities must be preserved
        expect(cb.pool.mintAddress).toBe(pool.mintAddress);
        expect(cb.pool.poolId).toBe(pool.poolId);
      }
    });
  });
});
