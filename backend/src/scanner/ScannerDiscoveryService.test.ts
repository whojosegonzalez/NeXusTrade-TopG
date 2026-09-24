import { describe, expect, it } from "vitest";

import {
  parseTokenMintAddress,
  providerFailure,
  providerSuccess,
  createProviderError,
} from "@nexustrade/shared";

import type { TokenDiscoveryProvider } from "../providers/interfaces/index.js";
import { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { dedupeCandidatesByMint, ScannerDiscoveryService } from "./ScannerDiscoveryService.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("ScannerDiscoveryService", () => {
  it("aggregates discovery candidates and handles provider failures", async () => {
    const goodProvider: TokenDiscoveryProvider = {
      name: "MOCK",
      capabilities: ["TOKEN_DISCOVERY"],
      discoverTokens: async () =>
        providerSuccess({
          provider: "MOCK",
          data: [
            {
              chainId: "solana",
              mintAddress: SOL_MINT,
              symbol: "SOL",
            },
          ],
        }),
    };
    const failingProvider: TokenDiscoveryProvider = {
      name: "DEXSCREENER",
      capabilities: ["TOKEN_DISCOVERY"],
      discoverTokens: async () =>
        providerFailure({
          provider: "DEXSCREENER",
          error: createProviderError({
            code: "PROVIDER_UNAVAILABLE",
            message: "Downstream failed.",
          }),
        }),
    };

    const result = await new ScannerDiscoveryService({
      registry: new ProviderRegistry([goodProvider, failingProvider]),
    }).discover(25);

    expect(result.candidates).toHaveLength(1);
    expect(result.metrics.successfulProviderCount).toBe(1);
    expect(result.metrics.failedProviderCount).toBe(1);
    expect(result.metrics.warnings[0]).toContain("PROVIDER_UNAVAILABLE");
  });

  it("deduplicates candidates by mint address", () => {
    const discoveredAt = new Date("2026-06-20T12:00:00.000Z");
    const result = dedupeCandidatesByMint([
      {
        source: "MOCK",
        discoveredAt,
        identity: {
          chainId: "solana",
          mintAddress: SOL_MINT,
        },
      },
      {
        source: "DEXSCREENER",
        discoveredAt,
        identity: {
          chainId: "solana",
          mintAddress: SOL_MINT,
        },
      },
      {
        source: "MOCK",
        discoveredAt,
        identity: {
          chainId: "solana",
          mintAddress: USDC_MINT,
        },
      },
    ]);

    expect(result.rawCount).toBe(3);
    expect(result.uniqueCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.candidates.map((candidate) => candidate.identity.mintAddress)).toEqual([
      SOL_MINT,
      USDC_MINT,
    ]);
  });

  it("tracks raw discovery count before applying the cycle limit", async () => {
    const provider: TokenDiscoveryProvider = {
      name: "MOCK",
      capabilities: ["TOKEN_DISCOVERY"],
      discoverTokens: async () =>
        providerSuccess({
          provider: "MOCK",
          data: [
            {
              chainId: "solana",
              mintAddress: SOL_MINT,
            },
            {
              chainId: "solana",
              mintAddress: USDC_MINT,
            },
          ],
        }),
    };

    const result = await new ScannerDiscoveryService({
      registry: new ProviderRegistry([provider]),
    }).discover(1);

    expect(result.metrics.rawCount).toBe(2);
    expect(result.candidates).toHaveLength(1);
  });
});
