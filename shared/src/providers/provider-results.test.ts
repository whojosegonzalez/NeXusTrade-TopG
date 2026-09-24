import { describe, expect, it } from "vitest";

import { createProviderError, mapHttpStatusToProviderErrorCode } from "./provider-errors.js";
import { providerFailure, providerSuccess } from "./provider-results.js";
import { parseProviderName } from "./provider.types.js";

describe("provider results", () => {
  it("constructs a success result with attribution fields", () => {
    const fetchedAt = new Date("2026-06-20T12:00:00.000Z");
    const result = providerSuccess({
      provider: "MOCK",
      data: { priceUsd: 1.23 },
      fetchedAt,
      latencyMs: 12,
      warnings: ["fixture"],
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("MOCK");
    expect(result.data.priceUsd).toBe(1.23);
    expect(result.fetchedAt).toBe(fetchedAt);
    expect(result.latencyMs).toBe(12);
    expect(result.warnings).toEqual(["fixture"]);
  });

  it("constructs a structured failure result", () => {
    const error = createProviderError({
      code: "RATE_LIMITED",
      message: "Too many requests.",
      statusCode: 429,
    });
    const result = providerFailure({
      provider: "DEXSCREENER",
      error,
      latencyMs: 25,
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("DEXSCREENER");
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.retryable).toBe(true);
    expect(result.rateLimited).toBe(true);
  });

  it("maps provider HTTP status codes into error codes", () => {
    expect(mapHttpStatusToProviderErrorCode(400)).toBe("BAD_REQUEST");
    expect(mapHttpStatusToProviderErrorCode(401)).toBe("UNAUTHORIZED");
    expect(mapHttpStatusToProviderErrorCode(404)).toBe("NOT_FOUND");
    expect(mapHttpStatusToProviderErrorCode(429)).toBe("RATE_LIMITED");
    expect(mapHttpStatusToProviderErrorCode(503)).toBe("PROVIDER_UNAVAILABLE");
  });

  it("parses Phase 9.3C authority and DAS provider names", () => {
    expect(parseProviderName("solana_rpc")).toBe("SOLANA_RPC");
    expect(parseProviderName("quicknode_das")).toBe("QUICKNODE_DAS");
    expect(parseProviderName("alchemy_das")).toBe("ALCHEMY_DAS");
    expect(parseProviderName("birdeye")).toBe("BIRDEYE");
  });
});
