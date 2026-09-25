import { describe, expect, it } from "vitest";
import { FormulationBHttpProviderClient } from "./FormulationBHttpProviderClient.js";

describe("FormulationBHttpProviderClient", () => {
  it("discovers candidates from Raydium pool list", async () => {
    const mockFetch: typeof fetch = async (input) => {
      if (typeof input === "string" && input.includes("raydium.io/pools/info/list")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              data: [
                {
                  id: "pool11111111111111111111111111111111111111111",
                  openTime: String(Math.floor(Date.now() / 1000) - 3600),
                  mintA: {
                    address: "So11111111111111111111111111111111111111112",
                    symbol: "WSOL",
                  },
                  mintB: {
                    address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
                    symbol: "RAY",
                  },
                },
                {
                  id: "pool22222222222222222222222222222222222222222",
                  openTime: String(Math.floor(Date.now() / 1000) - 7200),
                  mintA: {
                    address: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx",
                    symbol: "STONK",
                  },
                  mintB: {
                    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    symbol: "USDC",
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", date: new Date().toUTCString() },
          },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const client = new FormulationBHttpProviderClient({
      fetchFn: mockFetch,
      rateLimitMs: 0,
      timeoutMs: 1000,
    });

    const response = await client.discoverCandidates(2);
    expect(response.status).toBe(200);
    expect(response.data.length).toBe(2);
    expect(response.data[0]?.canonicalMint).toBe("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");
    expect(response.data[1]?.canonicalMint).toBe("6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx");
    expect(response.data[0]?.assetAgeSeconds).toBeGreaterThanOrEqual(300);
  });

  it("falls back to Solana RPC when Raydium pool API fails", async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async (input) => {
      callCount++;
      if (typeof input === "string" && input.includes("raydium.io")) {
        throw new Error("Raydium API down");
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: [
            {
              signature:
                "4QQwanf2URfxBiJzZkh3Lveu2WETaJT1ESE8on7PoNZnZoYPgV2FQ7i3Bfa4HTJVCkD2pVBmJbGmy3VzxpwGyVBf",
              slot: 300000001,
            },
          ],
          id: 1,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", date: new Date().toUTCString() },
        },
      );
    };

    const client = new FormulationBHttpProviderClient({
      fetchFn: mockFetch,
      rateLimitMs: 0,
    });

    const response = await client.discoverCandidates(1);
    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
    expect(response.data[0]?.canonicalMint).toBe("4QQwanf2URfxBiJzZkh3Lveu2WETaJT1ESE8on7PoNZn");
  });

  it("fetches momentum evidence and derives acceleration from DexScreener", async () => {
    const mockFetch: typeof fetch = async (input) => {
      if (typeof input === "string" && input.includes("dexscreener.com")) {
        return new Response(
          JSON.stringify([
            {
              baseToken: { address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY" },
              priceUsd: "2.10",
              priceChange: {
                m5: 4.0,
                h1: 8.0,
              },
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json", date: new Date().toUTCString() },
          },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const client = new FormulationBHttpProviderClient({
      fetchFn: mockFetch,
      rateLimitMs: 0,
    });

    const response = await client.fetchMomentumEvidence(
      "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
      new Date().toISOString(),
    );

    expect(response.status).toBe(200);
    expect(response.data.priceUsd).toBe(2.1);
    expect(response.data.momentum5mPct).toBe(4.0);
    expect(response.data.momentum15mPct).toBe(2.0); // 8.0 / 4
    expect(response.data.momentumAccelerationPct).toBe(2.0); // 4.0 - 2.0
    expect(response.data.missingnessCode).toBeUndefined();

    // Verify absence of any liquidity keys
    const rawKeys = Object.keys(response.data);
    expect(rawKeys).not.toContain("liquidityUsd");
    expect(rawKeys).not.toContain("poolReserveUsd");
  });

  it("fetches spot price from Raydium mint price fallback", async () => {
    const mockFetch: typeof fetch = async (input) => {
      if (typeof input === "string" && input.includes("dexscreener.com")) {
        throw new Error("DexScreener down");
      }
      if (typeof input === "string" && input.includes("raydium.io/mint/price")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              MintSpotTest: "2.75",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", date: new Date().toUTCString() },
          },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    const client = new FormulationBHttpProviderClient({
      fetchFn: mockFetch,
      rateLimitMs: 0,
    });

    const response = await client.fetchSpotPrice("MintSpotTest", new Date().toISOString());
    expect(response.status).toBe(200);
    expect(response.data.priceUsd).toBe(2.75);
  });

  it("enforces rate limit pacing between calls", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify([{ priceUsd: "1.0" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new FormulationBHttpProviderClient({
      fetchFn: mockFetch,
      rateLimitMs: 25, // 25ms delay for fast test
    });

    const t0 = Date.now();
    await client.fetchSpotPrice("Mint1", new Date().toISOString());
    await client.fetchSpotPrice("Mint2", new Date().toISOString());
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(20);
  });
});
