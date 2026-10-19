/**
 * Phase 12.94-D Milestone D.2.5: Raydium API v3 Discovery Client Unit & Integration Tests
 *
 * Comprehensive offline verification of:
 * 1. RaydiumResponseAdapter:
 *    - Standard envelope parsing ({ success: true, data: { data: [...] } }).
 *    - Direct array and alternative envelope fallbacks.
 *    - Bidirectional WSOL asset orientation (TOKEN_BASE_SOL_QUOTE & SOL_BASE_TOKEN_QUOTE).
 *    - Non-SOL pair detection.
 *    - openTime parsing: valid seconds, valid milliseconds, missing/empty, invalid, future-dated.
 *    - Malformed payload rejection and base58 validation.
 * 2. RaydiumLiveDiscoveryClient:
 *    - Strict allowlist URL enforcement (https://api-v3.raydium.io/pools/info/list).
 *    - Rate budgeting and minimum inter-request spacing (minRequestIntervalMs).
 *    - HTTP 429 Retry-After backoff.
 *    - Pool-ID-based deduplication (handles multiple pools sharing one mint without dropping either, prevents re-emission of same poolId).
 *    - Age freshness filter: maxPoolAgeSec=0 (filter disabled) vs maxPoolAgeSec > 0 (filters mature pools with EXCEEDS_MAX_POOL_AGE).
 *    - Operational diagnostic counters (unseen, mature skipped, invalid age, missing age, eligible).
 *
 * All tests execute 100% offline with zero network requests and synthetic mock transports.
 */

import { describe, expect, it } from "vitest";
import {
  isAllowlistedRaydiumUrl,
  parseRaydiumApiPoolListResponse,
  parseRaydiumOpenTime,
} from "./RaydiumResponseAdapter.js";
import {
  RaydiumLiveDiscoveryClient,
  RAYDIUM_PROVIDER_IDENTITY,
} from "./RaydiumLiveDiscoveryClient.js";
import { WSOL_MINT, RAYDIUM_AMM_V4_PROGRAM_ID } from "./RaydiumAmmParser.js";
import type { ILiveHttpTransport } from "./DexScreenerLiveDiscoveryClient.js";

// Canonical test fixture addresses
const MINT_BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_SOL_USDC = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const POOL_BONK_SOL = "HV14AnPfqvEepqBgk6kX9zB1Z5tJp5j7kM8qQ9X4yZ2b";
const POOL_BONK_SOL_2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const POOL_CPMM_SOL = "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp";
const POOL_NON_SOL_AMM = "6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg";

describe("Milestone D.2.5: Raydium API v3 Discovery Adapter & Client Tests", () => {
  // --------------------------------------------------------------------------
  // 1. RaydiumResponseAdapter Parsing & Orientation Tests
  // --------------------------------------------------------------------------
  describe("RaydiumResponseAdapter", () => {
    const fixedNowMs = 1792300000000; // Fixed reference receipt epoch ms (~2026)

    it("parses standard Raydium API v3 envelope successfully with TOKEN_BASE_SOL_QUOTE orientation", () => {
      const payload = {
        id: "req-1",
        success: true,
        data: {
          count: 1,
          hasNextPage: false,
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: {
                address: MINT_BONK,
                symbol: "Bonk",
                decimals: 5,
              },
              mintB: {
                address: WSOL_MINT,
                symbol: "WSOL",
                decimals: 9,
              },
              price: 0.000025,
              tvl: 500000,
              day: {
                volume: 125000,
              },
              openTime: String(Math.floor((fixedNowMs - 3600 * 1000) / 1000)), // 1 hour ago in seconds
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.ok).toBe(true);
      expect(result.pools.length).toBe(1);

      const pool = result.pools[0]!;
      expect(pool.poolId).toBe(POOL_BONK_SOL);
      expect(pool.orientation).toBe("TOKEN_BASE_SOL_QUOTE");
      expect(pool.targetMintAddress).toBe(MINT_BONK);
      expect(pool.targetMintSymbol).toBe("Bonk");
      expect(pool.targetMintDecimals).toBe(5);
      expect(pool.openTimeStatus).toBe("VALID");
      expect(pool.openTimeMs).toBe(fixedNowMs - 3600 * 1000);
      expect(pool.poolAgeAtDiscoverySec).toBe(3600);
      expect(pool.isRaydiumStandardAmmCandidate).toBe(true);
      expect(pool.sourceReportedTimeMs).toBeNull();
      expect(pool.missingFields).toContain("sourceTimestampMs");
    });

    it("parses inverted SOL_BASE_TOKEN_QUOTE orientation when mintA is WSOL", () => {
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_SOL_USDC,
              mintA: {
                address: WSOL_MINT,
                symbol: "WSOL",
                decimals: 9,
              },
              mintB: {
                address: MINT_USDC,
                symbol: "USDC",
                decimals: 6,
              },
              openTime: Math.floor((fixedNowMs - 7200 * 1000) / 1000), // 2 hours ago
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.ok).toBe(true);
      expect(result.pools.length).toBe(1);

      const pool = result.pools[0]!;
      expect(pool.orientation).toBe("SOL_BASE_TOKEN_QUOTE");
      expect(pool.targetMintAddress).toBe(MINT_USDC);
      expect(pool.targetMintSymbol).toBe("USDC");
      expect(pool.poolAgeAtDiscoverySec).toBe(7200);
      expect(pool.isRaydiumStandardAmmCandidate).toBe(true);
    });

    it("detects and flags NON_SOL_PAIR orientation when neither mint is WSOL", () => {
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: {
                address: MINT_BONK,
                symbol: "Bonk",
                decimals: 5,
              },
              mintB: {
                address: MINT_USDC,
                symbol: "USDC",
                decimals: 6,
              },
              openTime: "1700000000",
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.ok).toBe(true);
      expect(result.pools.length).toBe(1);
      expect(result.nonSolPoolsCount).toBe(1);
      expect(result.pools[0]!.orientation).toBe("NON_SOL_PAIR");
      // D27-F2: Protocol classification is decoupled from WSOL orientation.
      // Pool uses canonical AMM v4 programId, so isRaydiumStandardAmmCandidate is true,
      // while orientation is truthfully recorded as NON_SOL_PAIR.
      expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(true);
    });

    it("classifies missing openTime as MISSING status and null age", () => {
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: null,
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.pools.length).toBe(1);
      expect(result.missingOpenTimeCount).toBe(1);
      expect(result.pools[0]!.openTimeStatus).toBe("MISSING");
      expect(result.pools[0]!.openTimeMs).toBeNull();
      expect(result.pools[0]!.poolAgeAtDiscoverySec).toBeNull();
    });

    it("classifies malformed openTime as INVALID status", () => {
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: "not-a-timestamp",
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.pools.length).toBe(1);
      expect(result.invalidOpenTimeCount).toBe(1);
      expect(result.pools[0]!.openTimeStatus).toBe("INVALID");
      expect(result.pools[0]!.openTimeMs).toBeNull();
    });

    it("classifies future-dated openTime as FUTURE_DATED status", () => {
      const futureMs = fixedNowMs + 10 * 60 * 1000; // 10 minutes in the future
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: String(Math.floor(futureMs / 1000)),
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.pools.length).toBe(1);
      expect(result.futureDatedOpenTimeCount).toBe(1);
      expect(result.pools[0]!.openTimeStatus).toBe("FUTURE_DATED");
      expect(result.pools[0]!.openTimeMs).toBe(futureMs);
      expect(result.pools[0]!.poolAgeAtDiscoverySec).toBeNull();
    });

    it("parses millisecond-scale openTime values correctly", () => {
      const twoHoursAgoMs = fixedNowMs - 7200 * 1000;
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: twoHoursAgoMs, // > 1e11: treated as direct milliseconds
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.pools.length).toBe(1);
      expect(result.pools[0]!.openTimeStatus).toBe("VALID");
      expect(result.pools[0]!.openTimeMs).toBe(twoHoursAgoMs);
      expect(result.pools[0]!.poolAgeAtDiscoverySec).toBe(7200);
    });

    it("G2-F4: strictly rejects negative openTime strings and non-canonical formats", () => {
      // Node.js Date.parse("-1") historically evaluated to 978336000000 (year 2001)
      const resNeg1 = parseRaydiumOpenTime("-1", fixedNowMs);
      expect(resNeg1.openTimeStatus).toBe("INVALID");
      expect(resNeg1.openTimeMs).toBeNull();

      const resNeg100 = parseRaydiumOpenTime("-100", fixedNowMs);
      expect(resNeg100.openTimeStatus).toBe("INVALID");
      expect(resNeg100.openTimeMs).toBeNull();

      const resZero = parseRaydiumOpenTime("0", fixedNowMs);
      expect(resZero.openTimeStatus).toBe("INVALID");
      expect(resZero.openTimeMs).toBeNull();

      const resEmpty = parseRaydiumOpenTime("", fixedNowMs);
      expect(resEmpty.openTimeStatus).toBe("MISSING");

      const resSpaces = parseRaydiumOpenTime("   ", fixedNowMs);
      expect(resSpaces.openTimeStatus).toBe("MISSING");

      const resNull = parseRaydiumOpenTime("null", fixedNowMs);
      expect(resNull.openTimeStatus).toBe("MISSING");

      const resUndefined = parseRaydiumOpenTime("undefined", fixedNowMs);
      expect(resUndefined.openTimeStatus).toBe("MISSING");

      const resRawNull = parseRaydiumOpenTime(null, fixedNowMs);
      expect(resRawNull.openTimeStatus).toBe("MISSING");

      // Valid ISO-8601 string
      const isoStr = "2026-01-15T10:00:00.000Z";
      const expectedIsoMs = Date.parse(isoStr);
      const resIso = parseRaydiumOpenTime(isoStr, fixedNowMs);
      expect(resIso.openTimeStatus).toBe("VALID");
      expect(resIso.openTimeMs).toBe(expectedIsoMs);

      // Valid Unix timestamp string (seconds)
      const unixSecStr = "1792296400"; // 3600s before fixedNowMs
      const resSec = parseRaydiumOpenTime(unixSecStr, fixedNowMs);
      expect(resSec.openTimeStatus).toBe("VALID");
      expect(resSec.openTimeMs).toBe(1792296400000);
      expect(resSec.poolAgeAtDiscoverySec).toBe(3600);
    });

    it("rejects invalid base58 addresses cleanly without crashing", () => {
      const payload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: "not-a-valid-solana-pubkey!",
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
            },
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: "invalid-mint", symbol: "Bad", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
            },
          ],
        },
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.pools.length).toBe(0);
      expect(result.invalidAddressPoolsCount).toBe(2);
      expect(result.parseErrors.length).toBe(2);
    });

    it("handles success=false API error response cleanly", () => {
      const payload = {
        success: false,
        msg: "Rate limited or internal error",
      };

      const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
      expect(result.ok).toBe(false);
      expect(result.parseErrors).toContain("Rate limited or internal error");
    });

    describe("D27-F2: Protocol Classification & Orientation Decoupling in Adapter", () => {
      it("classifies canonical AMM v4 paired with WSOL as eligible AMM candidate", () => {
        const payload = {
          success: true,
          data: {
            data: [
              {
                type: "Standard",
                programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                id: POOL_BONK_SOL,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                openTime: Math.floor((fixedNowMs - 3600 * 1000) / 1000),
              },
            ],
          },
        };
        const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
        expect(result.ok).toBe(true);
        expect(result.pools[0]!.orientation).toBe("TOKEN_BASE_SOL_QUOTE");
        expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(true);
      });

      it("classifies canonical AMM v4 without WSOL as AMM candidate but NON_SOL_PAIR", () => {
        const payload = {
          success: true,
          data: {
            data: [
              {
                type: "Standard",
                programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                id: POOL_NON_SOL_AMM,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
                openTime: Math.floor((fixedNowMs - 3600 * 1000) / 1000),
              },
            ],
          },
        };
        const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
        expect(result.ok).toBe(true);
        expect(result.pools[0]!.orientation).toBe("NON_SOL_PAIR");
        expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(true);
      });

      it("rejects CPMM paired with WSOL even if labeled type='Standard'", () => {
        const payload = {
          success: true,
          data: {
            data: [
              {
                type: "Standard",
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                id: POOL_CPMM_SOL,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                openTime: Math.floor((fixedNowMs - 3600 * 1000) / 1000),
              },
            ],
          },
        };
        const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
        expect(result.ok).toBe(true);
        expect(result.pools[0]!.orientation).toBe("TOKEN_BASE_SOL_QUOTE");
        expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(false);
      });

      it("rejects CPMM without WSOL as both non-candidate and NON_SOL_PAIR", () => {
        const payload = {
          success: true,
          data: {
            data: [
              {
                type: "Standard",
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                id: POOL_CPMM_SOL,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
                openTime: Math.floor((fixedNowMs - 3600 * 1000) / 1000),
              },
            ],
          },
        };
        const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
        expect(result.ok).toBe(true);
        expect(result.pools[0]!.orientation).toBe("NON_SOL_PAIR");
        expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(false);
      });

      it("rejects missing or conflicting protocol metadata", () => {
        const payload = {
          success: true,
          data: {
            data: [
              // Missing programId
              {
                type: "Standard",
                programId: null,
                id: POOL_BONK_SOL,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              },
              // Conflicting type (CLMM with AMM v4 programId)
              {
                type: "Concentrated",
                programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                id: POOL_BONK_SOL_2,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              },
              // Conflicting type (CPMM with AMM v4 programId)
              {
                type: "CPMM",
                programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                id: POOL_CPMM_SOL,
                mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
                mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              },
              // Unsupported non-AMM programId (e.g. CLMM)
              {
                type: "Standard",
                programId: RAYDIUM_CLMM_PROGRAM_ID,
                id: POOL_SOL_USDC,
                mintA: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
              },
            ],
          },
        };
        const result = parseRaydiumApiPoolListResponse(payload, fixedNowMs);
        expect(result.ok).toBe(true);
        expect(result.pools.length).toBe(4);
        expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(false);
        expect(result.pools[1]!.isRaydiumStandardAmmCandidate).toBe(false);
        expect(result.pools[2]!.isRaydiumStandardAmmCandidate).toBe(false);
        expect(result.pools[3]!.isRaydiumStandardAmmCandidate).toBe(false);
      });
    });
  });

  // --------------------------------------------------------------------------
  // 2. RaydiumLiveDiscoveryClient URL & Rate Limiting Tests
  // --------------------------------------------------------------------------
  describe("RaydiumLiveDiscoveryClient", () => {
    it("strictly allowlists Raydium API v3 pools list URL and rejects other endpoints", () => {
      expect(isAllowlistedRaydiumUrl("https://api-v3.raydium.io/pools/info/list")).toBe(true);
      expect(
        isAllowlistedRaydiumUrl("https://api-v3.raydium.io/pools/info/list?poolType=standard"),
      ).toBe(true);

      // Rejections
      expect(isAllowlistedRaydiumUrl("http://api-v3.raydium.io/pools/info/list")).toBe(false); // Insecure HTTP
      expect(isAllowlistedRaydiumUrl("https://api.dexscreener.com/token-profiles/latest/v1")).toBe(
        false,
      ); // Other host
      expect(isAllowlistedRaydiumUrl("https://api-v3.raydium.io/pools/info/mint")).toBe(false); // Unapproved endpoint
      expect(isAllowlistedRaydiumUrl("https://malicious-raydium.io/pools/info/list")).toBe(false);
    });

    it("deduplicates pools by poolId and supports multiple pools for a single mint (D25-R4)", async () => {
      const now = Date.now();
      const mockPayload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: Math.floor((now - 600 * 1000) / 1000), // 10m ago
            },
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL_2, // Different pool, same mint!
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: Math.floor((now - 300 * 1000) / 1000), // 5m ago
            },
          ],
        },
      };

      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => mockPayload,
          }) as unknown as Response,
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        maxPoolAgeSec: 0, // Filter disabled
        minRequestIntervalMs: 0,
      });

      const firstPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-dedup-1",
        generationId: "gen-dedup",
      });

      // Both pools should be emitted because their poolIds are unique, even though mint is identical
      expect(firstPoll.length).toBe(2);
      expect(firstPoll[0]!.candidate.compositeId.poolId).toBe(POOL_BONK_SOL);
      expect(firstPoll[1]!.candidate.compositeId.poolId).toBe(POOL_BONK_SOL_2);
      expect(firstPoll[0]!.candidate.compositeId.mintAddress).toBe(MINT_BONK);
      expect(firstPoll[1]!.candidate.compositeId.mintAddress).toBe(MINT_BONK);
      expect(client.getSeenPoolIdsCount()).toBe(2);

      // Second poll with same catalog: both pools are already seen, so 0 new candidates emitted
      const secondPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-dedup-1",
        generationId: "gen-dedup",
      });
      expect(secondPoll.length).toBe(0);
      expect(client.getSeenPoolIdsCount()).toBe(2);
    });

    it("enforces max-pool-age-sec=0 as explicit filter-disabled mode (D25-R2)", async () => {
      const now = Date.now();
      const mockPayload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_SOL_USDC,
              mintA: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
              openTime: Math.floor((now - 86400 * 365 * 1000) / 1000), // 1 year old mature pool
            },
          ],
        },
      };

      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => mockPayload,
          }) as unknown as Response,
      };

      // With maxPoolAgeSec=0 (filter disabled)
      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        maxPoolAgeSec: 0,
        minRequestIntervalMs: 0,
      });

      const results = await client.pollDiscoveredCandidates({
        sessionId: "sess-age-0",
        generationId: "gen-age",
      });

      expect(results.length).toBe(1);
      expect(results[0]!.candidate.passedEligibility).toBe(true);
      expect(results[0]!.candidate.decisionCohort).toBe("WATCHLIST_RADAR");
      expect(results[0]!.candidate.selectionBias).toBe("RAYDIUM_API_STANDARD_POOLS");
      expect(results[0]!.candidate.providerIdentity).toBe(RAYDIUM_PROVIDER_IDENTITY);
      expect(client.getDiagnostics().maturePoolsSkipped).toBe(0);
    });

    it("rejects mature pools when maxPoolAgeSec is configured with positive threshold", async () => {
      const now = Date.now();
      const mockPayload = {
        success: true,
        data: {
          data: [
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_SOL_USDC,
              mintA: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
              openTime: Math.floor((now - 7200 * 1000) / 1000), // 2 hours old
            },
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: Math.floor((now - 300 * 1000) / 1000), // 5 minutes old (fresh!)
            },
          ],
        },
      };

      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => mockPayload,
          }) as unknown as Response,
      };

      // Freshness threshold: 1800 seconds (30 minutes)
      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        maxPoolAgeSec: 1800,
        minRequestIntervalMs: 0,
      });

      const results = await client.pollDiscoveredCandidates({
        sessionId: "sess-age-pos",
        generationId: "gen-age",
      });

      expect(results.length).toBe(2);

      // 2h old pool is rejected with EXCEEDS_MAX_POOL_AGE
      const matureCandidate = results.find(
        (r) => r.candidate.compositeId.poolId === POOL_SOL_USDC,
      )!;
      expect(matureCandidate.candidate.passedEligibility).toBe(false);
      expect(matureCandidate.candidate.decisionCohort).toBe("FILTERED_REJECTED");
      expect(matureCandidate.candidate.rejectionReasons).toContain("EXCEEDS_MAX_POOL_AGE");

      // 5m old pool passes
      const freshCandidate = results.find((r) => r.candidate.compositeId.poolId === POOL_BONK_SOL)!;
      expect(freshCandidate.candidate.passedEligibility).toBe(true);
      expect(freshCandidate.candidate.decisionCohort).toBe("WATCHLIST_RADAR");

      const diag = client.getDiagnostics();
      expect(diag.maturePoolsSkipped).toBe(1);
      expect(diag.eligiblePoolsCount).toBe(1);
    });

    it("respects minimum inter-request interval (minRequestIntervalMs)", async () => {
      let callCount = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          callCount++;
          return {
            status: 200,
            ok: true,
            json: async () => ({ success: true, data: { data: [] } }),
          } as unknown as Response;
        },
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 500, // 500ms spacing
      });

      // First poll executes
      await client.pollDiscoveredCandidates({ sessionId: "sess-interval", generationId: "gen" });
      expect(callCount).toBe(1);

      // Immediate second poll skips because 500ms has not elapsed
      await client.pollDiscoveredCandidates({ sessionId: "sess-interval", generationId: "gen" });
      expect(callCount).toBe(1); // Call was throttled by inter-request spacing
    });

    it("handles HTTP 429 rate limit with Retry-After backoff", async () => {
      let attempt = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          attempt++;
          if (attempt === 1) {
            return {
              status: 429,
              ok: false,
              headers: {
                get: (name: string) => (name.toLowerCase() === "retry-after" ? "5" : null),
              },
            } as unknown as Response;
          }
          return {
            status: 200,
            ok: true,
            json: async () => ({ success: true, data: { data: [] } }),
          } as unknown as Response;
        },
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
      });

      const firstPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-429",
        generationId: "gen",
      });
      expect(firstPoll.length).toBe(0);
      expect(client.getDiagnostics().rateLimitsEncountered).toBe(1);

      // Polling while backoff is active returns empty without making HTTP call
      const backoffPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-429",
        generationId: "gen",
      });
      expect(backoffPoll.length).toBe(0);
      expect(attempt).toBe(1); // No new network call made
    });

    it("allows unmarking a seen pool via unmarkSeenPool for bounded recovery", async () => {
      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => ({
              success: true,
              data: {
                count: 1,
                data: [
                  {
                    type: "Standard",
                    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                    id: POOL_BONK_SOL,
                    mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
                    mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                    openTime: "1792300000",
                  },
                ],
              },
            }),
          }) as unknown as Response,
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
      });

      const poll1 = await client.pollDiscoveredCandidates({
        sessionId: "sess-unmark",
        generationId: "gen",
      });
      expect(poll1.length).toBe(1);
      expect(client.isPoolSeen(POOL_BONK_SOL)).toBe(true);

      // Poll 2 skips because it was already seen
      const poll2 = await client.pollDiscoveredCandidates({
        sessionId: "sess-unmark",
        generationId: "gen",
      });
      expect(poll2.length).toBe(0);

      // Unmark the pool
      const unmarked = client.unmarkSeenPool(POOL_BONK_SOL);
      expect(unmarked).toBe(true);
      expect(client.isPoolSeen(POOL_BONK_SOL)).toBe(false);

      // Poll 3 can now discover it again
      const poll3 = await client.pollDiscoveredCandidates({
        sessionId: "sess-unmark",
        generationId: "gen",
      });
      expect(poll3.length).toBe(1);
      expect(poll3[0]!.poolSummary.poolId).toBe(POOL_BONK_SOL);
    });

    it("enforces default 30 req/min rate budget", async () => {
      let callCount = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          callCount++;
          return {
            status: 200,
            ok: true,
            json: async () => ({ success: true, data: { data: [] } }),
          } as unknown as Response;
        },
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
        maxRequestsPerMinute: 30, // Default 30 req/min
      });

      // Execute 30 calls successfully
      for (let i = 0; i < 30; i++) {
        await client.pollDiscoveredCandidates({ sessionId: "sess-budget", generationId: "gen" });
      }
      expect(callCount).toBe(30);

      // The 31st call hits the 30 req/min rate limit budget
      const throttledPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-budget",
        generationId: "gen",
      });
      expect(throttledPoll.length).toBe(0);
      expect(callCount).toBe(30); // Request was blocked before outbound network
    });

    it("populates structured candidate provenance fields truthfully", async () => {
      const fixedOpenTimeSec = 1792299000;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => ({
              success: true,
              data: {
                count: 1,
                data: [
                  {
                    type: "Standard",
                    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                    id: POOL_BONK_SOL,
                    mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
                    mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                    openTime: String(fixedOpenTimeSec),
                  },
                ],
              },
            }),
          }) as unknown as Response,
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
      });

      const results = await client.pollDiscoveredCandidates({
        sessionId: "sess-provenance",
        generationId: "gen",
      });
      expect(results.length).toBe(1);
      const c = results[0]!.candidate;

      expect(c.poolOpenTimeMs).toBe(fixedOpenTimeSec * 1000);
      expect(c.poolAgeAtDiscoverySec).toBeGreaterThanOrEqual(0);
      expect(c.firstSeenEpochMs).toBe(c.receiptEpochMs);
      expect(c.discoverySource).toBe("raydium");
      expect(c.discoveryEndpoint).toBe("https://api-v3.raydium.io/pools/info/list");
      expect(c.discoveryPage).toBe(1);
      expect(c.discoverySortField).toBe("default");
      expect(c.sourceTimestampMs).toBeNull(); // Truthful: not fabricated from openTime
    });

    it("parses diverse openTime formats with parseRaydiumOpenTime (D26-F2)", () => {
      const receiptMs = 1792300000000;

      // 1. Valid unix seconds
      const secRes = parseRaydiumOpenTime(1792200000, receiptMs);
      expect(secRes.openTimeStatus).toBe("VALID");
      expect(secRes.openTimeMs).toBe(1792200000000);
      expect(secRes.poolAgeAtDiscoverySec).toBe(100000);

      // 2. Valid unix milliseconds
      const msRes = parseRaydiumOpenTime(1792200000000, receiptMs);
      expect(msRes.openTimeStatus).toBe("VALID");
      expect(msRes.openTimeMs).toBe(1792200000000);
      expect(msRes.poolAgeAtDiscoverySec).toBe(100000);

      // 3. Valid ISO string (D26-F2 bugfix: not parsed with parseFloat)
      const isoRes = parseRaydiumOpenTime("2026-10-18T04:00:00.000Z", receiptMs);
      expect(isoRes.openTimeStatus).toBe("VALID");
      expect(isoRes.openTimeMs).toBe(Date.parse("2026-10-18T04:00:00.000Z"));
      expect(isoRes.poolAgeAtDiscoverySec).toBeGreaterThan(0);

      // 4. String numeric seconds
      const strSecRes = parseRaydiumOpenTime("1792200000", receiptMs);
      expect(strSecRes.openTimeStatus).toBe("VALID");
      expect(strSecRes.openTimeMs).toBe(1792200000000);

      // 5. "0" sentinel string (Raydium API unindexed / zero timestamp) -> INVALID
      const zeroStrRes = parseRaydiumOpenTime("0", receiptMs);
      expect(zeroStrRes.openTimeStatus).toBe("INVALID");
      expect(zeroStrRes.openTimeMs).toBeNull();
      expect(zeroStrRes.poolAgeAtDiscoverySec).toBeNull();

      // 6. Numeric 0 -> INVALID
      const zeroNumRes = parseRaydiumOpenTime(0, receiptMs);
      expect(zeroNumRes.openTimeStatus).toBe("INVALID");
      expect(zeroNumRes.openTimeMs).toBeNull();

      // 7. Negative numbers -> INVALID
      const negRes = parseRaydiumOpenTime(-100, receiptMs);
      expect(negRes.openTimeStatus).toBe("INVALID");
      expect(negRes.openTimeMs).toBeNull();

      // 8. Missing / null / undefined / empty -> MISSING
      expect(parseRaydiumOpenTime(null, receiptMs).openTimeStatus).toBe("MISSING");
      expect(parseRaydiumOpenTime(undefined, receiptMs).openTimeStatus).toBe("MISSING");
      expect(parseRaydiumOpenTime("", receiptMs).openTimeStatus).toBe("MISSING");
      expect(parseRaydiumOpenTime("   ", receiptMs).openTimeStatus).toBe("MISSING");
      expect(parseRaydiumOpenTime("null", receiptMs).openTimeStatus).toBe("MISSING");

      // 9. Unparseable garbage string -> INVALID
      expect(parseRaydiumOpenTime("not-a-timestamp", receiptMs).openTimeStatus).toBe("INVALID");

      // 10. Future-dated timestamp (> receiptMs + 60s) -> FUTURE_DATED
      const futureRes = parseRaydiumOpenTime(receiptMs + 120_000, receiptMs);
      expect(futureRes.openTimeStatus).toBe("FUTURE_DATED");
      expect(futureRes.openTimeMs).toBe(receiptMs + 120_000);
      expect(futureRes.poolAgeAtDiscoverySec).toBeNull();
    });

    it("never treats MISSING or INVALID pool age as fresh when age filter is active (D26-F2)", async () => {
      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => ({
              success: true,
              data: {
                count: 3,
                data: [
                  // Pool 1: valid fresh pool (100s old)
                  {
                    type: "Standard",
                    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                    id: POOL_BONK_SOL,
                    mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
                    mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                    openTime: String(Math.floor((Date.now() - 100 * 1000) / 1000)),
                  },
                  // Pool 2: missing openTime ("0" sentinel)
                  {
                    type: "Standard",
                    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                    id: POOL_SOL_USDC,
                    mintA: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                    mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
                    openTime: "0",
                  },
                  // Pool 3: null openTime
                  {
                    type: "Standard",
                    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
                    id: POOL_BONK_SOL_2,
                    mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
                    mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
                    openTime: null,
                  },
                ],
              },
            }),
          }) as unknown as Response,
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
        maxPoolAgeSec: 3600, // Active age filter: 1 hour max age
      });

      const results = await client.pollDiscoveredCandidates({
        sessionId: "sess-age-filter",
        generationId: "gen",
      });

      // All 3 candidates are emitted to preserve negative controls:
      // Pool 1: WATCHLIST_RADAR (eligible fresh pool)
      // Pool 2 & 3: FILTERED_REJECTED (MISSING or INVALID openTime excluded by age filter)
      expect(results.length).toBe(3);
      const eligible = results.filter((r) => r.candidate.decisionCohort === "WATCHLIST_RADAR");
      expect(eligible.length).toBe(1);
      expect(eligible[0]!.poolSummary.poolId).toBe(POOL_BONK_SOL);

      const rejected = results.filter((r) => r.candidate.decisionCohort === "FILTERED_REJECTED");
      expect(rejected.length).toBe(2);
      expect(rejected.map((r) => r.poolSummary.poolId)).toContain(POOL_SOL_USDC);
      expect(rejected.map((r) => r.poolSummary.poolId)).toContain(POOL_BONK_SOL_2);

      const funnel = client.getFunnelMetrics();
      expect(funnel.apiPoolsReturned).toBe(3);
      expect(funnel.uniquePoolsEncountered).toBe(3);
      expect(funnel.repeatedPoolsSuppressed).toBe(0);
      expect(funnel.poolAgeClassifications.validAgeCount).toBe(1);
      expect(funnel.poolAgeClassifications.invalidAgeCount).toBe(1);
      expect(funnel.poolAgeClassifications.missingAgeCount).toBe(1);
      expect(funnel.poolAgeClassifications.confirmedAgeFilterPasses).toBe(1);
      expect(funnel.poolAgeClassifications.ageFilterExclusions).toBe(2);
      expect(funnel.preVerificationExclusions.totalPreVerificationExcluded).toBe(2);
    });

    it("G2-F1: verifies discovery funnel denominator consistency across 3 repeated catalog polls", async () => {
      // Helper to generate valid 38-character base58 pool IDs using strictly base58 characters
      const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const makePoolId = (idx: number) =>
        "11111111111111111111111111111111AAAA" +
        B58[Math.floor(idx / B58.length)]! +
        B58[idx % B58.length]!;

      // Construct 50 standard AMM v4 pools
      const basePools = Array.from({ length: 50 }, (_, i) => ({
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(i + 1),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - (i % 2 === 0 ? 100 : 7200) * 1000) / 1000)),
      }));

      // Poll 1: 50 pools (initial snapshot)
      // Poll 2: identical 50 pools
      // Poll 3: identical 50 pools + 1 brand new pool (total 51 pools)
      const newPool = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(999),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 50 * 1000) / 1000)),
      };

      let pollCount = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          pollCount++;
          let data = basePools;
          if (pollCount === 3) {
            data = [...basePools, newPool];
          }
          return {
            status: 200,
            ok: true,
            json: async () => ({
              success: true,
              data: {
                count: data.length,
                data,
              },
            }),
          } as unknown as Response;
        },
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
        pollIntervalMs: 0,
        maxPoolAgeSec: 3600, // 1 hour threshold: even idx pools are fresh (100s), odd idx are mature (7200s)
      });

      // Poll 1: initial baseline catalog snapshot
      const results1 = await client.pollDiscoveredCandidates({
        sessionId: "sess-g2-f1",
        generationId: "gen",
      });
      expect(results1.length).toBe(50);
      expect(results1[0]!.candidate.discoveryPollCycle).toBe(1);
      expect(results1[0]!.candidate.isInitialCatalogSnapshot).toBe(true);

      // Poll 2: identical 50 pools -> all suppressed as duplicates
      const results2 = await client.pollDiscoveredCandidates({
        sessionId: "sess-g2-f1",
        generationId: "gen",
      });
      expect(results2.length).toBe(0);

      // Poll 3: 50 duplicates + 1 new pool -> only the 1 new pool emitted
      const results3 = await client.pollDiscoveredCandidates({
        sessionId: "sess-g2-f1",
        generationId: "gen",
      });
      expect(results3.length).toBe(1);
      expect(results3[0]!.candidate.discoveryPollCycle).toBe(3);
      expect(results3[0]!.candidate.isInitialCatalogSnapshot).toBe(false);
      expect(results3[0]!.poolSummary.poolId).toBe(makePoolId(999));

      // Funnel metrics inspection and invariant verification (G2-F1)
      const funnel = client.getFunnelMetrics();

      // 1. Raw response impressions vs unique deduplication
      expect(funnel.apiPoolsReturned).toBe(151); // 50 + 50 + 51
      expect(funnel.uniquePoolsEncountered).toBe(51);
      expect(funnel.repeatedPoolsSuppressed).toBe(100);
      expect(funnel.malformedRawEntries).toBe(0);
      expect(
        funnel.uniquePoolsEncountered + funnel.repeatedPoolsSuppressed + funnel.malformedRawEntries,
      ).toBe(funnel.apiPoolsReturned);

      // 2. Snapshot vs later poll arrivals
      expect(funnel.initialSnapshotPoolsEncountered).toBe(50);
      expect(funnel.laterPollArrivalsEncountered).toBe(1);
      expect(funnel.initialSnapshotPoolsEncountered + funnel.laterPollArrivalsEncountered).toBe(
        funnel.uniquePoolsEncountered,
      );

      // 3. Unique age classifications sum to uniquePoolsEncountered
      const ageClass = funnel.poolAgeClassifications;
      expect(ageClass.validAgeCount).toBe(51);
      expect(ageClass.missingAgeCount).toBe(0);
      expect(ageClass.invalidAgeCount).toBe(0);
      expect(ageClass.futureDatedAgeCount).toBe(0);
      expect(
        ageClass.validAgeCount +
          ageClass.missingAgeCount +
          ageClass.invalidAgeCount +
          ageClass.futureDatedAgeCount,
      ).toBe(funnel.uniquePoolsEncountered);

      // 4. Age filter passes and exclusions sum to uniquePoolsEncountered
      // 50 base pools: 25 even (100s <= 3600s: pass), 25 odd (7200s > 3600s: fail). 1 new pool: 50s <= 3600s: pass.
      // Total passes: 25 + 1 = 26. Total age exclusions: 25.
      expect(ageClass.confirmedAgeFilterPasses).toBe(26);
      expect(ageClass.initialSnapshotFreshPasses).toBe(25);
      expect(ageClass.laterPollFreshArrivals).toBe(1);
      expect(ageClass.initialSnapshotFreshPasses + ageClass.laterPollFreshArrivals).toBe(
        ageClass.confirmedAgeFilterPasses,
      );
      expect(ageClass.ageFilterExclusions).toBe(25);
      expect(ageClass.confirmedAgeFilterPasses + ageClass.ageFilterExclusions).toBe(
        funnel.uniquePoolsEncountered,
      );

      // 5. Eligible vs pre-verification excluded sum to uniquePoolsEncountered
      expect(funnel.eligibleForVerification).toBe(26);
      expect(funnel.preVerificationExclusions.totalPreVerificationExcluded).toBe(25);
      expect(
        funnel.eligibleForVerification +
          funnel.preVerificationExclusions.totalPreVerificationExcluded,
      ).toBe(funnel.uniquePoolsEncountered);
    });

    it("G2-F6: establishes initial catalog snapshot from first usable response after errors/empty polls, preserving poll attempt provenance", async () => {
      const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const makePoolId = (idx: number) =>
        "11111111111111111111111111111111BBBB" +
        B58[Math.floor(idx / B58.length)]! +
        B58[idx % B58.length]!;

      const poolA = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(1),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 100 * 1000) / 1000)),
      };
      const poolB = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(2),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 200 * 1000) / 1000)),
      };
      const poolC = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(3),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 300 * 1000) / 1000)),
      };
      const poolD = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(4),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 50 * 1000) / 1000)),
      };

      let pollIndex = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          pollIndex++;
          if (pollIndex === 1) {
            // Poll 1: 429 Rate limited (transient failure)
            return {
              status: 429,
              ok: false,
              headers: {
                get: (header: string) => (header.toLowerCase() === "retry-after" ? "0" : null),
              },
            } as unknown as Response;
          }
          if (pollIndex === 2) {
            // Poll 2: Empty response (0 pools in data)
            return {
              status: 200,
              ok: true,
              json: async () => ({
                success: true,
                data: { count: 0, data: [] },
              }),
            } as unknown as Response;
          }
          if (pollIndex === 3) {
            // Poll 3: First successful usable snapshot (3 pools)
            return {
              status: 200,
              ok: true,
              json: async () => ({
                success: true,
                data: { count: 3, data: [poolA, poolB, poolC] },
              }),
            } as unknown as Response;
          }
          // Poll 4: 3 duplicate pools + 1 genuine later arrival (poolD)
          return {
            status: 200,
            ok: true,
            json: async () => ({
              success: true,
              data: { count: 4, data: [poolA, poolB, poolC, poolD] },
            }),
          } as unknown as Response;
        },
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
        pollIntervalMs: 0,
        maxPoolAgeSec: 3600,
      });

      // Poll 1: fails on HTTP 429
      const results1 = await client.pollDiscoveredCandidates({
        sessionId: "s1",
        generationId: "g1",
      });
      expect(results1.length).toBe(0);
      expect(client.getTotalPollAttempts()).toBe(1);
      expect(client.getSuccessfulPolls()).toBe(0);
      expect(client.getEmptyOrFailedPolls()).toBe(1);
      expect(client.getHasEstablishedInitialBaseline()).toBe(false);

      // Poll 2: empty list response
      const results2 = await client.pollDiscoveredCandidates({
        sessionId: "s1",
        generationId: "g1",
      });
      expect(results2.length).toBe(0);
      expect(client.getTotalPollAttempts()).toBe(2);
      expect(client.getSuccessfulPolls()).toBe(0);
      expect(client.getEmptyOrFailedPolls()).toBe(2);
      expect(client.getHasEstablishedInitialBaseline()).toBe(false);

      // Poll 3: first successful usable snapshot establishes initial baseline
      const results3 = await client.pollDiscoveredCandidates({
        sessionId: "s1",
        generationId: "g1",
      });
      expect(results3.length).toBe(3);
      expect(client.getTotalPollAttempts()).toBe(3);
      expect(client.getSuccessfulPolls()).toBe(1);
      expect(client.getEmptyOrFailedPolls()).toBe(2);
      expect(client.getHasEstablishedInitialBaseline()).toBe(true);

      // Verify candidates from first usable poll are marked as initial catalog snapshot
      for (const res of results3) {
        expect(res.candidate.isInitialCatalogSnapshot).toBe(true);
        expect(res.candidate.discoveryPollCycle).toBe(3);
      }

      // Poll 4: duplicates suppressed, only genuine new arrival emitted as later arrival
      const results4 = await client.pollDiscoveredCandidates({
        sessionId: "s1",
        generationId: "g1",
      });
      expect(results4.length).toBe(1);
      expect(client.getTotalPollAttempts()).toBe(4);
      expect(client.getSuccessfulPolls()).toBe(2);
      expect(client.getEmptyOrFailedPolls()).toBe(2);
      expect(results4[0]!.candidate.isInitialCatalogSnapshot).toBe(false);
      expect(results4[0]!.candidate.discoveryPollCycle).toBe(4);
      expect(results4[0]!.poolSummary.poolId).toBe(poolD.id);

      // Verify funnel metrics
      const funnel = client.getFunnelMetrics();
      expect(funnel.initialSnapshotPoolsEncountered).toBe(3);
      expect(funnel.laterPollArrivalsEncountered).toBe(1);
      expect(funnel.uniquePoolsEncountered).toBe(4);
      expect(funnel.repeatedPoolsSuppressed).toBe(3);
      expect(funnel.malformedRawEntries).toBe(0);
      expect(funnel.apiPoolsReturned).toBe(7); // 3 from poll 3 + 4 from poll 4
      expect(
        funnel.uniquePoolsEncountered + funnel.repeatedPoolsSuppressed + funnel.malformedRawEntries,
      ).toBe(funnel.apiPoolsReturned);

      // Diagnostics verification
      const diag = client.getDiagnostics();
      expect(diag.totalPollAttempts).toBe(4);
      expect(diag.successfulPolls).toBe(2);
      expect(diag.emptyOrFailedPolls).toBe(2);
      expect(diag.hasEstablishedInitialBaseline).toBe(true);
    });

    it("G2-F7: preserves strict mathematical invariants when catalog responses contain malformed entries across multiple polls", async () => {
      const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const makePoolId = (idx: number) =>
        "11111111111111111111111111111111CCCC" +
        B58[Math.floor(idx / B58.length)]! +
        B58[idx % B58.length]!;

      // 10 valid base pools
      const baseValidPools = Array.from({ length: 10 }, (_, i) => ({
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(i + 1),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 500 * 1000) / 1000)),
      }));

      // 3 new valid pools
      const newValidPool1 = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(101),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 400 * 1000) / 1000)),
      };
      const newValidPool2 = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(102),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 300 * 1000) / 1000)),
      };
      const newValidPool3 = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(103),
        mintA: { address: MINT_BONK, symbol: "BONK", decimals: 5 },
        mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
        openTime: String(Math.floor((Date.now() - 200 * 1000) / 1000)),
      };

      // Malformed entries of different defective shapes
      const malformedNull = null;
      const malformedNotObject = "this-is-not-an-object";
      const malformedInvalidBase58Id = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: "NOT_BASE58!@#$%^&*",
        mintA: { address: MINT_BONK, symbol: "BONK" },
        mintB: { address: WSOL_MINT, symbol: "WSOL" },
      };
      const malformedMissingMintA = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: makePoolId(201),
        mintA: { address: "INVALID_BASE58_MINT", symbol: "BAD" },
        mintB: { address: WSOL_MINT, symbol: "WSOL" },
      };
      const malformedEmptyId = {
        type: "Standard",
        programId: RAYDIUM_AMM_V4_PROGRAM_ID,
        id: "",
        mintA: { address: MINT_BONK, symbol: "BONK" },
        mintB: { address: WSOL_MINT, symbol: "WSOL" },
      };
      const malformedNonObjectItem = 12345;

      let pollCount = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          pollCount++;
          let rawItems: unknown[] = [];
          if (pollCount === 1) {
            // Poll 1: 10 valid pools + 3 malformed entries (total 13 raw entries)
            rawItems = [
              ...baseValidPools,
              malformedNull,
              malformedInvalidBase58Id,
              malformedNotObject,
            ];
          } else if (pollCount === 2) {
            // Poll 2: 10 duplicate pools + 1 new valid pool + 2 malformed entries (total 13 raw entries)
            rawItems = [...baseValidPools, newValidPool1, malformedMissingMintA, malformedEmptyId];
          } else if (pollCount === 3) {
            // Poll 3: 11 duplicate pools + 2 new valid pools + 1 malformed entry (total 14 raw entries)
            rawItems = [
              ...baseValidPools,
              newValidPool1,
              newValidPool2,
              newValidPool3,
              malformedNonObjectItem,
            ];
          } else {
            // Poll 4: 0 valid pools + 2 malformed entries (total 2 raw entries)
            rawItems = [malformedInvalidBase58Id, malformedNotObject];
          }

          return {
            status: 200,
            ok: true,
            json: async () => ({
              success: true,
              data: {
                count: rawItems.length,
                data: rawItems,
              },
            }),
          } as unknown as Response;
        },
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        minRequestIntervalMs: 0,
        pollIntervalMs: 0,
        maxPoolAgeSec: 3600,
      });

      // Poll 1: 10 valid + 3 malformed
      const results1 = await client.pollDiscoveredCandidates({
        sessionId: "s2",
        generationId: "g2",
      });
      expect(results1.length).toBe(10);
      expect(client.getMalformedRawEntriesCount()).toBe(3);

      // Poll 2: 10 duplicates (suppressed) + 1 new valid + 2 malformed
      const results2 = await client.pollDiscoveredCandidates({
        sessionId: "s2",
        generationId: "g2",
      });
      expect(results2.length).toBe(1);
      expect(results2[0]!.poolSummary.poolId).toBe(newValidPool1.id);
      expect(client.getMalformedRawEntriesCount()).toBe(5); // 3 + 2

      // Poll 3: 11 duplicates (suppressed) + 2 new valid + 1 malformed
      const results3 = await client.pollDiscoveredCandidates({
        sessionId: "s2",
        generationId: "g2",
      });
      expect(results3.length).toBe(2);
      expect(client.getMalformedRawEntriesCount()).toBe(6); // 5 + 1

      // Poll 4: 0 valid + 2 malformed (no usable pools, emptyOrFailedPolls increments)
      const results4 = await client.pollDiscoveredCandidates({
        sessionId: "s2",
        generationId: "g2",
      });
      expect(results4.length).toBe(0);
      expect(client.getMalformedRawEntriesCount()).toBe(8); // 6 + 2

      // Inspect Funnel Metrics & Invariants
      const funnel = client.getFunnelMetrics();

      // Invariant 1: uniquePoolsEncountered + repeatedPoolsSuppressed + malformedRawEntries === apiPoolsReturned
      expect(funnel.apiPoolsReturned).toBe(42); // 13 + 13 + 14 + 2
      expect(funnel.malformedRawEntries).toBe(8);
      expect(funnel.uniquePoolsEncountered).toBe(13); // 10 from poll 1 + 1 from poll 2 + 2 from poll 3
      expect(funnel.repeatedPoolsSuppressed).toBe(21); // 0 + 10 + 11 + 0
      expect(
        funnel.uniquePoolsEncountered + funnel.repeatedPoolsSuppressed + funnel.malformedRawEntries,
      ).toBe(funnel.apiPoolsReturned);

      // Invariant 2: initialSnapshotPoolsEncountered + laterPollArrivalsEncountered === uniquePoolsEncountered
      expect(funnel.initialSnapshotPoolsEncountered).toBe(10);
      expect(funnel.laterPollArrivalsEncountered).toBe(3);
      expect(funnel.initialSnapshotPoolsEncountered + funnel.laterPollArrivalsEncountered).toBe(
        funnel.uniquePoolsEncountered,
      );

      // Invariant 3: age classifications sum to uniquePoolsEncountered
      const ageClass = funnel.poolAgeClassifications;
      expect(ageClass.validAgeCount).toBe(13);
      expect(
        ageClass.validAgeCount +
          ageClass.missingAgeCount +
          ageClass.invalidAgeCount +
          ageClass.futureDatedAgeCount,
      ).toBe(funnel.uniquePoolsEncountered);

      // Invariant 4: confirmedAgeFilterPasses + ageFilterExclusions === uniquePoolsEncountered
      expect(ageClass.confirmedAgeFilterPasses + ageClass.ageFilterExclusions).toBe(
        funnel.uniquePoolsEncountered,
      );

      // Invariant 5: initialSnapshotFreshPasses + laterPollFreshArrivals === confirmedAgeFilterPasses
      expect(ageClass.initialSnapshotFreshPasses + ageClass.laterPollFreshArrivals).toBe(
        ageClass.confirmedAgeFilterPasses,
      );

      // Invariant 6: eligibleForVerification + totalPreVerificationExcluded === uniquePoolsEncountered
      expect(
        funnel.eligibleForVerification +
          funnel.preVerificationExclusions.totalPreVerificationExcluded,
      ).toBe(funnel.uniquePoolsEncountered);

      // Verify diagnostics match funnel metrics
      const diag = client.getDiagnostics();
      expect(diag.totalPoolsFetched).toBe(funnel.apiPoolsReturned);
      expect(diag.malformedRawEntriesCount).toBe(funnel.malformedRawEntries);
      expect(diag.seenPoolIdsCount).toBe(funnel.uniquePoolsEncountered);
      expect(diag.repeatedPoolsSuppressed).toBe(funnel.repeatedPoolsSuppressed);
    });

    it("D27-F2: accurately screens and accounts for decoupled protocol and orientation combinations", async () => {
      const now = Date.now();
      const payload = {
        success: true,
        data: {
          data: [
            // 1. Canonical AMM v4 paired with WSOL -> Eligible
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_BONK_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: Math.floor((now - 300 * 1000) / 1000), // 300s ago
            },
            // 2. Canonical AMM v4 without WSOL -> Fails WSOL_PAIR_ORIENTATION, passes RAYDIUM_STANDARD_AMM
            {
              type: "Standard",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              id: POOL_NON_SOL_AMM,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
              openTime: Math.floor((now - 300 * 1000) / 1000),
            },
            // 3. CPMM paired with WSOL (labeled 'Standard') -> Passes WSOL_PAIR_ORIENTATION, fails RAYDIUM_STANDARD_AMM
            {
              type: "Standard",
              programId: RAYDIUM_CPMM_PROGRAM_ID,
              id: POOL_CPMM_SOL,
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: WSOL_MINT, symbol: "WSOL", decimals: 9 },
              openTime: Math.floor((now - 300 * 1000) / 1000),
            },
            // 4. CPMM without WSOL -> Fails BOTH WSOL_PAIR_ORIENTATION and RAYDIUM_STANDARD_AMM (multifactor)
            {
              type: "Standard",
              programId: RAYDIUM_CPMM_PROGRAM_ID,
              id: "6FhywW1XG9F425kspxYxRkX4oV2y5mPj3bK1tG9mN4qZ",
              mintA: { address: MINT_BONK, symbol: "Bonk", decimals: 5 },
              mintB: { address: MINT_USDC, symbol: "USDC", decimals: 6 },
              openTime: Math.floor((now - 300 * 1000) / 1000),
            },
          ],
        },
      };

      const mockTransport: ILiveHttpTransport = {
        fetch: async () =>
          ({
            status: 200,
            ok: true,
            json: async () => payload,
          }) as unknown as Response,
      };

      const client = new RaydiumLiveDiscoveryClient({
        transport: mockTransport,
        maxPoolAgeSec: 86400,
        minRequestIntervalMs: 0,
      });

      const results = await client.pollDiscoveredCandidates({
        sessionId: "s-d27-test",
        generationId: "g-d27-test",
      });

      expect(results.length).toBe(4);

      // Candidate 1: Canonical AMM v4 paired with WSOL -> WATCHLIST_RADAR
      const c1 = results[0]!.candidate;
      expect(c1.decisionCohort).toBe("WATCHLIST_RADAR");
      expect(c1.passedEligibility).toBe(true);
      expect(c1.rejectionReasons).toHaveLength(0);

      // Candidate 2: Canonical AMM v4 without WSOL -> FILTERED_REJECTED
      const c2 = results[1]!.candidate;
      expect(c2.decisionCohort).toBe("FILTERED_REJECTED");
      expect(c2.passedEligibility).toBe(false);
      expect(c2.rejectionReasons).toEqual(["NON_SOL_PAIR"]);
      const ammEvalC2 = c2.filterEvaluations.find((f) => f.filterName === "RAYDIUM_STANDARD_AMM");
      expect(ammEvalC2?.passed).toBe(true);
      const orientEvalC2 = c2.filterEvaluations.find(
        (f) => f.filterName === "WSOL_PAIR_ORIENTATION",
      );
      expect(orientEvalC2?.passed).toBe(false);

      // Candidate 3: CPMM paired with WSOL -> FILTERED_REJECTED
      const c3 = results[2]!.candidate;
      expect(c3.decisionCohort).toBe("FILTERED_REJECTED");
      expect(c3.passedEligibility).toBe(false);
      expect(c3.rejectionReasons).toEqual(["NON_RAYDIUM_STANDARD_AMM"]);
      const ammEvalC3 = c3.filterEvaluations.find((f) => f.filterName === "RAYDIUM_STANDARD_AMM");
      expect(ammEvalC3?.passed).toBe(false);
      const orientEvalC3 = c3.filterEvaluations.find(
        (f) => f.filterName === "WSOL_PAIR_ORIENTATION",
      );
      expect(orientEvalC3?.passed).toBe(true);

      // Candidate 4: CPMM without WSOL -> FILTERED_REJECTED with multifactor rejection reasons
      const c4 = results[3]!.candidate;
      expect(c4.decisionCohort).toBe("FILTERED_REJECTED");
      expect(c4.passedEligibility).toBe(false);
      expect(c4.rejectionReasons).toEqual(["NON_SOL_PAIR", "NON_RAYDIUM_STANDARD_AMM"]);
      const ammEvalC4 = c4.filterEvaluations.find((f) => f.filterName === "RAYDIUM_STANDARD_AMM");
      expect(ammEvalC4?.passed).toBe(false);
      const orientEvalC4 = c4.filterEvaluations.find(
        (f) => f.filterName === "WSOL_PAIR_ORIENTATION",
      );
      expect(orientEvalC4?.passed).toBe(false);

      // Funnel metrics inspection
      const funnel = client.getFunnelMetrics();
      expect(funnel.uniquePoolsEncountered).toBe(4);
      expect(funnel.eligibleForVerification).toBe(1);
      expect(funnel.preVerificationExclusions.totalPreVerificationExcluded).toBe(3);
      expect(funnel.preVerificationExclusions.nonSolPairs).toBe(2); // Candidates 2 & 4
      expect(funnel.preVerificationExclusions.nonStandardAmm).toBe(2); // Candidates 3 & 4
    });
  });
});
