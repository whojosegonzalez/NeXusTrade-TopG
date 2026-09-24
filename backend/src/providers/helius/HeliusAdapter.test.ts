import { describe, expect, it } from "vitest";

import { parseTokenMintAddress } from "@nexustrade/shared";

import { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { HeliusAdapter } from "./HeliusAdapter.js";
import { HeliusBackoffPolicy } from "./HeliusBackoffPolicy.js";
import { HeliusEvidenceCache } from "./HeliusEvidenceCache.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

describe("HeliusAdapter", () => {
  it("uses the evidence cache for repeated metadata calls", async () => {
    let requestCount = 0;
    const adapter = createAdapter(async () => {
      requestCount += 1;

      return jsonResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {
          id: SOL_MINT,
          content: {
            metadata: {
              name: "Wrapped SOL",
              symbol: "SOL",
            },
          },
          token_info: {
            decimals: 9,
          },
        },
      });
    });

    const first = await adapter.getTokenMetadata(SOL_MINT);
    const second = await adapter.getTokenMetadata(SOL_MINT);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(requestCount).toBe(1);
    expect(second.ok ? second.warnings : []).toContain("Helius evidence cache hit.");
  });

  it("skips low-priority getAsset calls while Helius is cooling down", async () => {
    let requestCount = 0;
    const adapter = createAdapter(async () => {
      requestCount += 1;

      return new Response(JSON.stringify({ message: "too many requests" }), { status: 429 });
    });

    const first = await adapter.getRiskEvidence(SOL_MINT);
    const second = await adapter.getRiskEvidence(SOL_MINT);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(second.ok ? undefined : second.error.code).toBe("RATE_LIMITED");
    expect(second.ok ? [] : second.warnings).toContain("Helius getAsset skipped during cooldown.");
    expect(requestCount).toBe(1);
  });
});

function createAdapter(fetchImpl: typeof fetch): HeliusAdapter {
  return new HeliusAdapter({
    httpClient: new ProviderHttpClient({
      provider: "HELIUS",
      baseUrl: "https://mainnet.helius-rpc.com",
      timeoutMs: 1_000,
      rateLimitPerMinute: 60,
      fetchImpl,
    }),
    apiKey: "helius-test-key",
    maxRetries: 0,
    retryBackoffMs: 0,
    allowRawPayloadLogging: false,
    evidenceCache: new HeliusEvidenceCache({
      metadataTtlMs: 60_000,
      riskEvidenceTtlMs: 60_000,
    }),
    backoff: new HeliusBackoffPolicy({
      enabled: true,
      baseCooldownMs: 60_000,
      maxCooldownMs: 60_000,
    }),
    metadataCacheEnabled: true,
    riskEvidenceCacheEnabled: true,
    skipLowPriorityDuringCooldown: true,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
