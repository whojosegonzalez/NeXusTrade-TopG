import { describe, expect, it } from "vitest";
import { parseCandidateScannerConfigArgs } from "./CandidateScannerConfig.js";
import { CandidateStreamEngine } from "./CandidateStreamEngine.js";
import type { CandidateScannerCandidate } from "./CandidateScannerTypes.js";

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
});
