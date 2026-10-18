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
      expect(result.pools[0]!.isRaydiumStandardAmmCandidate).toBe(false);
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
  });
});
