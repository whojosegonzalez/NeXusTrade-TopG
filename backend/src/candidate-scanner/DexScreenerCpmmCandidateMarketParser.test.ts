/**
 * Phase 12.94-D D.3.3: Unit tests for DexScreenerCpmmCandidateMarketParser
 *
 * Verifies strict offline parsing, target/poolState structural binding, CPMM label enforcement,
 * orientation handling, provenance preservation, numeric validations, and fail-closed refusals.
 */

import { describe, expect, it } from "vitest";
import {
  WSOL_MINT_ADDRESS,
  parseDexScreenerCpmmTokenPairs,
  type DexScreenerCpmmMarketTarget,
} from "./DexScreenerCpmmCandidateMarketParser.js";
import type { RaydiumCpmmPoolStateSuccess } from "./RaydiumCpmmPoolStateAdapter.js";

const TEST_POOL_ADDRESS = "CpmmPool111111111111111111111111111111111111";
const CANDIDATE_MINT_A = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"; // Lexicographically < WSOL
const CANDIDATE_MINT_B = "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG"; // Lexicographically > WSOL

function makeTarget(
  poolAddress = TEST_POOL_ADDRESS,
  candidateMint = CANDIDATE_MINT_A,
): DexScreenerCpmmMarketTarget {
  return { poolAddress, candidateMint };
}

function makeMockPoolState(
  target: DexScreenerCpmmMarketTarget,
  orientation: "TOKEN_0_BASE_WSOL_QUOTE" | "TOKEN_1_BASE_WSOL_QUOTE" = "TOKEN_0_BASE_WSOL_QUOTE",
  overrides: Partial<RaydiumCpmmPoolStateSuccess> = {},
): RaydiumCpmmPoolStateSuccess {
  return {
    ok: true,
    poolAddress: target.poolAddress,
    candidateMint: target.candidateMint,
    wsolMint: WSOL_MINT_ADDRESS,
    orientation,
    baseDecimals: 6,
    quoteDecimals: 9,
    baseVaultAddress: "BaseVault11111111111111111111111111111111111",
    quoteVaultAddress: "QuoteVault1111111111111111111111111111111111",
    baseVaultRaw: 1000000000000n,
    quoteVaultRaw: 50000000000n,
    baseTotalFeesRaw: 0n,
    quoteTotalFeesRaw: 0n,
    baseEffectiveReserveRaw: 1000000000000n,
    quoteEffectiveReserveRaw: 50000000000n,
    baseEffectiveReserveApproxDecimal: 1000000,
    quoteEffectiveReserveApproxDecimal: 50,
    spotPriceSolApprox: 0.00005,
    swapActivationTimeSec: 1731750050n,
    poolStatus: 0,
    swapEnabledByStatus: true,
    lpMint: "LpMint111111111111111111111111111111111111111",
    lpSupply: 5000000000n,
    verification: {
      ownerVerified: true,
      vaultAuthoritiesVerified: true,
      tokenProgramsVerified: true,
      authBumpVerified: true,
      slotProvenance: {
        poolSlot: 300000000,
        vault0Slot: 300000000,
        vault1Slot: 300000000,
        consistentSlot: 300000000,
      },
    },
    ...overrides,
  };
}

function makeValidPair(
  target: DexScreenerCpmmMarketTarget,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: target.poolAddress,
    labels: ["CPMM"],
    baseToken: {
      address: target.candidateMint,
      name: "Test Candidate",
      symbol: "TEST",
    },
    quoteToken: {
      address: WSOL_MINT_ADDRESS,
      name: "Wrapped SOL",
      symbol: "SOL",
    },
    priceNative: "0.00005021",
    priceUsd: "0.010042",
    txns: {
      m5: {
        buys: 42,
        sells: 18,
      },
    },
    volume: {
      m5: 12500.5,
    },
    priceChange: {
      m5: 3.45,
      h1: 12.8,
    },
    liquidity: {
      usd: 250000,
      base: 12500000,
      quote: 625,
    },
    marketCap: 1000000,
    pairCreatedAt: 1731750000000,
    ...overrides,
  };
}

describe("DexScreenerCpmmCandidateMarketParser", () => {
  describe("Group 1: Target and Pool-State Structural Binding", () => {
    it("successfully parses when target, poolState, and DexScreener pair agree", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target)] };

      const result = parseDexScreenerCpmmTokenPairs({
        json,
        target,
        poolState,
        receivedAtMs: 1731750100000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.pool.poolId).toBe(target.poolAddress);
      expect(result.pool.mintAddress).toBe(target.candidateMint);
      expect(result.pool.symbol).toBe("TEST");
      expect(result.pool.spotPriceSol).toBe(0.00005021);
      expect(result.pool.spotPriceUsd).toBe(0.010042);
      expect(result.pool.liquidityUsd).toBe(250000);
      expect(result.pool.marketCapUsd).toBe(1000000);
      expect(result.pool.openTimeSec).toBe(1731750000);
      expect(result.pool.buys5m).toBe(42);
      expect(result.pool.sells5m).toBe(18);
      expect(result.pool.txCount5m).toBe(60);
      expect(result.pool.volume5mUsd).toBe(12500.5);
      expect(result.spot.momentum5mBps).toBe(345);
      expect(result.spot.priceChange1hPct).toBe(12.8);
    });

    it("fails closed with POOL_STATE_BINDING_MISMATCH when target poolAddress does not match poolState", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        poolAddress: "OtherPool111111111111111111111111111111111",
      });
      const json = { pairs: [makeValidPair(target)] };

      const result = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(result).toEqual({ ok: false, reason: "POOL_STATE_BINDING_MISMATCH" });
    });

    it("fails closed with POOL_STATE_BINDING_MISMATCH when target candidateMint does not match poolState", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        candidateMint: "OtherMint111111111111111111111111111111111",
      });
      const json = { pairs: [makeValidPair(target)] };

      const result = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(result).toEqual({ ok: false, reason: "POOL_STATE_BINDING_MISMATCH" });
    });

    it("fails closed with POOL_STATE_BINDING_MISMATCH when poolState wsolMint is not canonical WSOL", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        wsolMint: "USDC111111111111111111111111111111111111111",
      });
      const json = { pairs: [makeValidPair(target)] };

      const result = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(result).toEqual({ ok: false, reason: "POOL_STATE_BINDING_MISMATCH" });
    });

    it("fails closed with INVALID_POOL_STATE when poolState.ok is false or malformed", () => {
      const target = makeTarget();
      const badPoolState = {
        ok: false,
        refusalCode: "SOME_ERROR",
      } as unknown as RaydiumCpmmPoolStateSuccess;
      const json = { pairs: [makeValidPair(target)] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState: badPoolState })).toEqual({
        ok: false,
        reason: "INVALID_POOL_STATE",
      });
      expect(
        parseDexScreenerCpmmTokenPairs({
          json,
          target,
          poolState: null as unknown as RaydiumCpmmPoolStateSuccess,
        }),
      ).toEqual({
        ok: false,
        reason: "INVALID_POOL_STATE",
      });
    });

    it("fails closed with INVALID_POOL_STATE when poolState orientation is unrecognized", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        orientation: "UNKNOWN_ORIENTATION" as unknown as "TOKEN_0_BASE_WSOL_QUOTE",
      });
      const json = { pairs: [makeValidPair(target)] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "INVALID_POOL_STATE",
      });
    });

    it("fails closed with INVALID_POOL_STATE when poolState spotPriceSolApprox is negative or non-finite", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        spotPriceSolApprox: -0.01,
      });
      const json = { pairs: [makeValidPair(target)] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "INVALID_POOL_STATE",
      });
    });

    it("fails closed with INVALID_POOL_STATE when poolState swapActivationTimeSec is not a bigint", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        swapActivationTimeSec: 123456 as unknown as bigint,
      });
      const json = { pairs: [makeValidPair(target)] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "INVALID_POOL_STATE",
      });
    });

    it("fails closed with POOL_NOT_FOUND when target pool is absent from pairs", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, { pairAddress: "OtherPool111111111111111111111111111111111" }),
        ],
      };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "POOL_NOT_FOUND",
      });
    });

    it("fails closed with AMBIGUOUS_POOL when multiple pairs match target poolAddress", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target), makeValidPair(target)] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "AMBIGUOUS_POOL",
      });
    });
  });

  describe("Group 2: Provider Protocol Identification and CPMM Label Requirement", () => {
    it("accepts CPMM label in lowercase and mixed case", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      const jsonLower = { pairs: [makeValidPair(target, { labels: ["cpmm"] })] };
      expect(parseDexScreenerCpmmTokenPairs({ json: jsonLower, target, poolState }).ok).toBe(true);

      const jsonMixed = { pairs: [makeValidPair(target, { labels: ["Cpmm", "verified"] })] };
      expect(parseDexScreenerCpmmTokenPairs({ json: jsonMixed, target, poolState }).ok).toBe(true);
    });

    it("fails closed with DEX_LABEL_NOT_CPMM when labels array is missing or does not include CPMM", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      expect(
        parseDexScreenerCpmmTokenPairs({
          json: { pairs: [makeValidPair(target, { labels: [] })] },
          target,
          poolState,
        }),
      ).toEqual({ ok: false, reason: "DEX_LABEL_NOT_CPMM" });

      expect(
        parseDexScreenerCpmmTokenPairs({
          json: { pairs: [makeValidPair(target, { labels: ["AMM"] })] },
          target,
          poolState,
        }),
      ).toEqual({ ok: false, reason: "DEX_LABEL_NOT_CPMM" });

      expect(
        parseDexScreenerCpmmTokenPairs({
          json: { pairs: [makeValidPair(target, { labels: undefined })] },
          target,
          poolState,
        }),
      ).toEqual({ ok: false, reason: "DEX_LABEL_NOT_CPMM" });
    });

    it("fails closed with UNSUPPORTED_RAYDIUM_POOL_TYPE when conflicting unsupported labels are present", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const unsupported of ["CLMM", "V3", "CL", "clmm"]) {
        const json = { pairs: [makeValidPair(target, { labels: ["CPMM", unsupported] })] };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "UNSUPPORTED_RAYDIUM_POOL_TYPE",
        });
      }
    });

    it("fails closed with CHAIN_NOT_SOLANA when chainId is not solana", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target, { chainId: "ethereum" })] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "CHAIN_NOT_SOLANA",
      });
    });

    it("fails closed with DEX_NOT_RAYDIUM when dexId is not raydium", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target, { dexId: "orca" })] };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "DEX_NOT_RAYDIUM",
      });
    });
  });

  describe("Group 3: Orientation Decoupling and Inversion Refusal", () => {
    it("supports on-chain Orientation A (TOKEN_0_BASE_WSOL_QUOTE) and records both orientations in provenance", () => {
      const target = makeTarget(TEST_POOL_ADDRESS, CANDIDATE_MINT_A);
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE");
      const json = { pairs: [makeValidPair(target)] };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.provenance.onChainOrientation).toBe("TOKEN_0_BASE_WSOL_QUOTE");
      expect(res.provenance.dexScreenerOrientation).toBe("TOKEN_BASE_WSOL_QUOTE");
    });

    it("supports on-chain Orientation B (TOKEN_1_BASE_WSOL_QUOTE) and records both orientations in provenance", () => {
      const target = makeTarget(TEST_POOL_ADDRESS, CANDIDATE_MINT_B);
      const poolState = makeMockPoolState(target, "TOKEN_1_BASE_WSOL_QUOTE");
      const json = { pairs: [makeValidPair(target)] };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.provenance.onChainOrientation).toBe("TOKEN_1_BASE_WSOL_QUOTE");
      expect(res.provenance.dexScreenerOrientation).toBe("TOKEN_BASE_WSOL_QUOTE");
    });

    it("fails closed with UNSUPPORTED_ORIENTATION on reversed provider pairs (base=WSOL, quote=candidate) without inversion", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            baseToken: { address: WSOL_MINT_ADDRESS, symbol: "SOL" },
            quoteToken: { address: target.candidateMint, symbol: "TEST" },
          }),
        ],
      };

      const result = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(result).toEqual({ ok: false, reason: "UNSUPPORTED_ORIENTATION" });
    });

    it("fails closed with BASE_MINT_MISMATCH when baseToken address does not match candidateMint", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            baseToken: { address: "OtherMint111111111111111111111111111111111", symbol: "OTHER" },
          }),
        ],
      };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "BASE_MINT_MISMATCH",
      });
    });

    it("fails closed with QUOTE_NOT_WSOL when quoteToken is not canonical WSOL", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
          }),
        ],
      };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "QUOTE_NOT_WSOL",
      });
    });
  });

  describe("Group 4: Price, Liquidity, and Market Cap Validation (No FDV Substitution)", () => {
    it("accepts valid positive decimal strings for prices (including scientific notation)", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            priceNative: "1.23e-5",
            priceUsd: "0.00246",
          }),
        ],
      };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.pool.spotPriceSol).toBe(0.0000123);
      expect(res.pool.spotPriceUsd).toBe(0.00246);
    });

    it("fails closed with PRICE_NATIVE_INVALID on non-positive, zero, or malformed priceNative", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badPrice of ["0", "-0.01", "abc", "", null, undefined, "   "]) {
        const json = { pairs: [makeValidPair(target, { priceNative: badPrice })] };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "PRICE_NATIVE_INVALID",
        });
      }
    });

    it("fails closed with PRICE_USD_INVALID on non-positive, zero, or malformed priceUsd", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badPrice of ["0", "-1", "NaN", "", null, undefined]) {
        const json = { pairs: [makeValidPair(target, { priceUsd: badPrice })] };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "PRICE_USD_INVALID",
        });
      }
    });

    it("fails closed with LIQUIDITY_UNAVAILABLE when liquidity.usd is missing, non-finite, or negative", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badLiq of [-1, NaN, Infinity, -Infinity, "1000", null, undefined]) {
        const json = {
          pairs: [
            makeValidPair(target, {
              liquidity: badLiq === undefined ? undefined : { usd: badLiq },
            }),
          ],
        };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "LIQUIDITY_UNAVAILABLE",
        });
      }
    });

    it("fails closed with MARKET_CAP_UNAVAILABLE when marketCap is missing, non-finite, or negative", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badCap of [-50, NaN, Infinity, -Infinity, "500000", null, undefined]) {
        const json = { pairs: [makeValidPair(target, { marketCap: badCap })] };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "MARKET_CAP_UNAVAILABLE",
        });
      }
    });

    it("never substitutes FDV for missing marketCap (FDV-only response fails closed)", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            marketCap: undefined,
            fdv: 5000000, // FDV present, but marketCap missing
          }),
        ],
      };

      const result = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(result).toEqual({ ok: false, reason: "MARKET_CAP_UNAVAILABLE" });
    });

    it("records separate market and pool-state price observations with comparisonPerformed: false", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        spotPriceSolApprox: 0.000049,
      });
      const json = {
        pairs: [
          makeValidPair(target, {
            priceNative: "0.000051",
          }),
        ],
      };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.provenance.priceObservations).toEqual({
        spotPriceSolMarket: 0.000051,
        spotPriceSolOnChainApprox: 0.000049,
        comparisonPerformed: false,
      });
    });
  });

  describe("Group 5: Creation Time, Swap Activation Time, and Metric Windows", () => {
    it("preserves pairCreatedAt and openTimeSec with DEXSCREENER_PAIR_CREATED_AT provenance", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target, "TOKEN_0_BASE_WSOL_QUOTE", {
        swapActivationTimeSec: 1800000000n, // Delayed swap unlock time
      });
      const json = {
        pairs: [
          makeValidPair(target, {
            pairCreatedAt: 1731750000999, // 1731750000 sec
          }),
        ],
      };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.pool.openTimeSec).toBe(1731750000);
      expect(res.provenance.creation).toEqual({
        pairCreatedAtMs: 1731750000999,
        openTimeSec: 1731750000,
        source: "DEXSCREENER_PAIR_CREATED_AT",
      });

      // Crucial invariant: swapActivationTimeSec is NOT substituted for creation time
      expect(res.provenance.onChainActivation).toEqual({
        swapActivationTimeSec: 1800000000n,
        source: "RAYDIUM_CPMM_OPEN_TIME",
      });
      expect(res.pool.openTimeSec).not.toBe(1800000000);
    });

    it("fails closed with CREATION_TIME_UNAVAILABLE on zero, negative, non-integer, or missing pairCreatedAt", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badTime of [0, -1000, 1731750000.5, "1731750000000", null, undefined]) {
        const json = { pairs: [makeValidPair(target, { pairCreatedAt: badTime })] };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "CREATION_TIME_UNAVAILABLE",
        });
      }
    });

    it("records metricWindows separating providerRolling5m from strategyQualifiedFlowWindow", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target)] };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.provenance.metricWindows).toEqual({
        providerRolling5m: "5m",
        strategyQualifiedFlowWindow: "UNCONNECTED",
      });
    });
  });

  describe("Group 6: 5-Minute Rolling Flow and Unsafe Integer Counts", () => {
    it("preserves 5-minute buys, sells, txCount5m, and volume5m without scaling or dividing by 5", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            txns: { m5: { buys: 10, sells: 5 } },
            volume: { m5: 5000 },
          }),
        ],
      };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.pool.buys5m).toBe(10);
      expect(res.pool.sells5m).toBe(5);
      expect(res.pool.txCount5m).toBe(15);
      expect(res.pool.volume5mUsd).toBe(5000);
    });

    it("fails closed with M5_TXNS_UNAVAILABLE on missing, negative, or non-integer buys/sells", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badTxns of [
        { m5: { buys: -1, sells: 5 } },
        { m5: { buys: 5, sells: -1 } },
        { m5: { buys: 1.5, sells: 5 } },
        { m5: { buys: "10", sells: 5 } },
        { m5: { buys: 10 } },
        {},
      ]) {
        const json = { pairs: [makeValidPair(target, { txns: badTxns })] };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "M5_TXNS_UNAVAILABLE",
        });
      }
    });

    it("fails closed with M5_TXNS_UNAVAILABLE when buys + sells sum overflows Number.MAX_SAFE_INTEGER", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = {
        pairs: [
          makeValidPair(target, {
            txns: {
              m5: {
                buys: Number.MAX_SAFE_INTEGER,
                sells: 1, // Sum exceeds Number.MAX_SAFE_INTEGER
              },
            },
          }),
        ],
      };

      expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
        ok: false,
        reason: "M5_TXNS_UNAVAILABLE",
      });
    });

    it("fails closed with M5_VOLUME_UNAVAILABLE on missing, negative, or non-finite volume.m5", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badVol of [-0.01, NaN, Infinity, -Infinity, "1000", null, undefined]) {
        const json = {
          pairs: [
            makeValidPair(target, {
              volume: badVol === undefined ? undefined : { m5: badVol },
            }),
          ],
        };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "M5_VOLUME_UNAVAILABLE",
        });
      }
    });
  });

  describe("Group 7: Date Handling and Optional Price Change Conversions", () => {
    it("formats valid receivedAtMs into ISO fetchedAt string", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target)] };

      const res = parseDexScreenerCpmmTokenPairs({
        json,
        target,
        poolState,
        receivedAtMs: 1731750000000,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.pool.fetchedAt).toBe(new Date(1731750000000).toISOString());
      expect(res.provenance.receivedAtMs).toBe(1731750000000);
    });

    it("leaves fetchedAt empty string when receivedAtMs is null or undefined", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target)] };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.pool.fetchedAt).toBe("");
      expect(res.provenance.receivedAtMs).toBeNull();
    });

    it("fails closed with RECEIVED_AT_INVALID on malformed or out-of-range dates without throwing exceptions", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target)] };

      for (const badMs of [NaN, -1, Infinity, -Infinity, 1e20, 1731750000000.5, "1731750000000"]) {
        expect(
          parseDexScreenerCpmmTokenPairs({
            json,
            target,
            poolState,
            receivedAtMs: badMs as unknown as number,
          }),
        ).toEqual({ ok: false, reason: "RECEIVED_AT_INVALID" });
      }
    });

    it("safely handles optional price changes and classifies them UNAVAILABLE on non-finite values or overflow", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      // Huge overflow value for m5
      const jsonOverflow = {
        pairs: [
          makeValidPair(target, {
            priceChange: {
              m5: 1e300, // Would overflow safe integer in bps
              h1: NaN,
            },
          }),
        ],
      };

      const res = parseDexScreenerCpmmTokenPairs({ json: jsonOverflow, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.spot.momentum5mBps).toBeUndefined();
      expect(res.spot.priceChange1hPct).toBeUndefined();
      expect(res.provenance.classifications.priceChangeM5).toBe("UNAVAILABLE");
      expect(res.provenance.classifications.priceChangeH1).toBe("UNAVAILABLE");
    });
  });

  describe("Group 8: Security Fields Boundary, Immutability and Structural Malformation", () => {
    it("keeps security fields explicitly UNAVAILABLE with legacy decimals: 0 placeholder", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const json = { pairs: [makeValidPair(target)] };

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.pool.decimals).toBe(0);
      expect(res.pool.lpBurnPct).toBeNull();
      expect(res.pool.mintAuthority).toBe("UNVERIFIED_AUTHORITY");
      expect(res.pool.freezeAuthority).toBe("UNVERIFIED_AUTHORITY");

      expect(res.pool.metricProvenance?.decimals).toBe("UNAVAILABLE");
      expect(res.pool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
      expect(res.pool.metricProvenance?.mintAuthority).toBe("UNAVAILABLE");
      expect(res.pool.metricProvenance?.freezeAuthority).toBe("UNAVAILABLE");
      expect(res.provenance.classifications.decimals).toBe("UNAVAILABLE");
    });

    it("fails closed with MALFORMED_RESPONSE on non-object inputs or missing pairs array", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badJson of [null, undefined, "hello", 123, {}, { pairs: "not-an-array" }]) {
        expect(parseDexScreenerCpmmTokenPairs({ json: badJson, target, poolState })).toEqual({
          ok: false,
          reason: "MALFORMED_RESPONSE",
        });
      }
    });

    it("fails closed with NO_PAIRS on empty pairs array", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      expect(parseDexScreenerCpmmTokenPairs({ json: { pairs: [] }, target, poolState })).toEqual({
        ok: false,
        reason: "NO_PAIRS",
      });
    });

    it("fails closed with SYMBOL_UNAVAILABLE on missing or empty token symbol", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);

      for (const badSymbol of ["", "   ", null, undefined, 123]) {
        const json = {
          pairs: [
            makeValidPair(target, {
              baseToken: { address: target.candidateMint, symbol: badSymbol },
            }),
          ],
        };
        expect(parseDexScreenerCpmmTokenPairs({ json, target, poolState })).toEqual({
          ok: false,
          reason: "SYMBOL_UNAVAILABLE",
        });
      }
    });

    it("preserves input immutability and freezes all output structures", () => {
      const target = makeTarget();
      const poolState = makeMockPoolState(target);
      const pair = makeValidPair(target);
      const json = { pairs: [pair] };

      // Snapshot inputs before parse
      const jsonBefore = JSON.stringify(json);
      const targetBefore = JSON.stringify(target);

      const res = parseDexScreenerCpmmTokenPairs({ json, target, poolState });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Inputs were not altered
      expect(JSON.stringify(json)).toBe(jsonBefore);
      expect(JSON.stringify(target)).toBe(targetBefore);

      // Outputs are deeply frozen
      expect(Object.isFrozen(res)).toBe(true);
      expect(Object.isFrozen(res.pool)).toBe(true);
      expect(Object.isFrozen(res.pool.metricProvenance)).toBe(true);
      expect(Object.isFrozen(res.spot)).toBe(true);
      expect(Object.isFrozen(res.provenance)).toBe(true);
      expect(Object.isFrozen(res.provenance.labels)).toBe(true);
      expect(Object.isFrozen(res.provenance.priceUnits)).toBe(true);
      expect(Object.isFrozen(res.provenance.creation)).toBe(true);
      expect(Object.isFrozen(res.provenance.onChainActivation)).toBe(true);
      expect(Object.isFrozen(res.provenance.metricWindows)).toBe(true);
      expect(Object.isFrozen(res.provenance.priceObservations)).toBe(true);
      expect(Object.isFrozen(res.provenance.classifications)).toBe(true);
    });
  });
});
