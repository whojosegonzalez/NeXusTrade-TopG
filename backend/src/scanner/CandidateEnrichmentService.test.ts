import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, providerSuccess } from "@nexustrade/shared";

import { CandidateEnrichmentService } from "./CandidateEnrichmentService.js";
import type { DiscoveredTokenCandidate } from "./ScannerDiscoveryService.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("CandidateEnrichmentService", () => {
  it("enriches with bounded concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const candidates: DiscoveredTokenCandidate[] = [SOL_MINT, USDC_MINT, SOL_MINT].map(
      (mintAddress) => ({
        source: "MOCK",
        discoveredAt: new Date("2026-06-20T12:00:00.000Z"),
        identity: {
          chainId: "solana",
          mintAddress,
        },
      }),
    );
    const service = new CandidateEnrichmentService({
      concurrency: 2,
      marketDataService: {
        enrichToken: async (request) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;

          return providerSuccess({
            provider: "MOCK",
            data: {
              identity: {
                chainId: "solana",
                mintAddress: request.mintAddress,
              },
              sourcesUsed: ["MOCK"],
              warnings: [],
              fetchedAt: new Date("2026-06-20T12:00:00.000Z"),
            },
          });
        },
      },
    });

    const result = await service.enrichCandidates(candidates);

    expect(result.attemptedCount).toBe(3);
    expect(result.enrichedCount).toBe(3);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
