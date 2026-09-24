import { describe, expect, it } from "vitest";

import { providerSuccess, type ProviderSuccess } from "@nexustrade/shared";

import { HeliusEvidenceCache } from "./HeliusEvidenceCache.js";
import type { HeliusAsset } from "./helius.schemas.js";

describe("HeliusEvidenceCache", () => {
  it("stores metadata and risk evidence independently with separate ttl values", () => {
    let now = 10_000;
    const cache = new HeliusEvidenceCache({
      metadataTtlMs: 1_000,
      riskEvidenceTtlMs: 5_000,
      now: () => now,
    });
    const result = assetResult("mint_a");

    cache.set("TOKEN_METADATA", "mint_a", result);
    cache.set("RISK_EVIDENCE", "mint_a", result);

    now = 11_001;

    expect(cache.get("TOKEN_METADATA", "mint_a")).toBeUndefined();
    expect(cache.get("RISK_EVIDENCE", "mint_a")).toBe(result);
  });
});

function assetResult(mintAddress: string): ProviderSuccess<HeliusAsset> {
  return providerSuccess({
    provider: "HELIUS",
    data: {
      id: mintAddress,
    } as HeliusAsset,
    fetchedAt: new Date("2026-07-15T00:00:00.000Z"),
    latencyMs: 10,
  });
}
