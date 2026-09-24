import { describe, expect, it } from "vitest";

import { ProviderHttpClient } from "./ProviderHttpClient.js";

describe("ProviderHttpClient", () => {
  it("returns parsed JSON success responses", async () => {
    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ value: 42 }), { status: 200 });
    };
    const client = new ProviderHttpClient({
      provider: "MOCK",
      baseUrl: "https://example.test/api",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      fetchImpl,
    });

    const result = await client.getJson<{ readonly value: number }>({
      path: "price",
      query: { ids: "So111" },
    });

    expect(result.ok).toBe(true);
    expect(requestedUrl).toBe("https://example.test/api/price?ids=So111");
    expect(result.ok ? result.data.value : undefined).toBe(42);
    expect(result.httpAttempts).toEqual([
      expect.objectContaining({
        provider: "MOCK",
        operation: "price",
        endpointId: "price",
        method: "GET",
        attemptNumber: 1,
        outcome: "OK",
        statusCode: 200,
      }),
    ]);
  });

  it("normalizes HTTP rate limits into structured provider errors", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
    const client = new ProviderHttpClient({
      provider: "DEXSCREENER",
      baseUrl: "https://example.test",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      fetchImpl,
    });

    const result = await client.getJson();

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("RATE_LIMITED");
    expect(result.rateLimited).toBe(true);
    expect(result.httpAttempts).toEqual([
      expect.objectContaining({
        outcome: "RATE_LIMITED",
        statusCode: 429,
        failureCode: "RATE_LIMITED",
      }),
    ]);
  });

  it("stores endpoint identifiers instead of full URLs or headers", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Nope" }), { status: 400 });
    const client = new ProviderHttpClient({
      provider: "RAYDIUM",
      baseUrl: "https://example.test",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      defaultHeaders: {
        "x-api-key": "secret",
      },
      fetchImpl,
    });

    const result = await client.getJson({
      path: "compute/swap-base-in",
      endpointId: "RAYDIUM_COMPUTE_SWAP_BASE_IN",
      query: { inputMint: "mint_a" },
    });

    expect(result.httpAttempts?.[0]).toMatchObject({
      endpointId: "RAYDIUM_COMPUTE_SWAP_BASE_IN",
      outcome: "HTTP_ERROR",
    });
    expect(JSON.stringify(result.httpAttempts)).not.toContain("secret");
    expect(JSON.stringify(result.httpAttempts)).not.toContain("inputMint");
  });
});
