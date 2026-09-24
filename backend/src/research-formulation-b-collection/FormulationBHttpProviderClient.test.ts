import { describe, expect, it } from "vitest";
import { FormulationBHttpProviderClient } from "./FormulationBHttpProviderClient.js";

describe("FormulationBHttpProviderClient", () => {
  it("discovers candidates from simulated Solana RPC response", async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: [{ slot: 250000001 }, { slot: 250000002 }],
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
      timeoutMs: 1000,
    });

    const response = await client.discoverCandidates(2);
    expect(response.status).toBe(200);
    expect(response.data.length).toBe(2);
    expect(response.data[0]?.canonicalMint).toContain("250000001");
    expect(response.data[0]?.assetAgeSeconds).toBe(360);
  });

  it("falls back to secondary RPC when primary RPC throws error", async () => {
    let callCount = 0;
    const mockFetch: typeof fetch = async (input) => {
      callCount++;
      if (typeof input === "string" && input.includes("mainnet-beta.solana.com")) {
        throw new Error("Network connection failure on primary");
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: [{ slot: 300000001 }],
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
    expect(response.data[0]?.slotId).toBe("slot-300000001");
  });

  it("fetches momentum evidence and derives acceleration from Jupiter response", async () => {
    const mockFetch: typeof fetch = async (input) => {
      void input;
      return new Response(
        JSON.stringify({
          data: {
            MintTest11111111111111111111111111111111111: {
              id: "MintTest11111111111111111111111111111111111",
              price: "1.25",
            },
          },
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

    const response = await client.fetchMomentumEvidence(
      "MintTest11111111111111111111111111111111111",
      new Date().toISOString(),
    );

    expect(response.status).toBe(200);
    expect(response.data.priceUsd).toBe(1.25);
    expect(response.data.momentum5mPct).toBe(5.0);
    expect(response.data.momentum15mPct).toBe(2.0);
    expect(response.data.momentumAccelerationPct).toBe(3.0);
    expect(response.data.missingnessCode).toBeUndefined();

    // Verify absence of any liquidity keys
    const rawKeys = Object.keys(response.data);
    expect(rawKeys).not.toContain("liquidityUsd");
    expect(rawKeys).not.toContain("poolReserveUsd");
  });

  it("fetches spot price from Jupiter endpoint", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          data: {
            MintSpotTest: {
              price: 2.75,
            },
          },
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

    const response = await client.fetchSpotPrice("MintSpotTest", new Date().toISOString());
    expect(response.status).toBe(200);
    expect(response.data.priceUsd).toBe(2.75);
  });

  it("enforces rate limit pacing between calls", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ data: {} }), {
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
