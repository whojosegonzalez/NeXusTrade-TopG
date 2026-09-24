import { describe, expect, it } from "vitest";

import {
  parseTokenMintAddress,
  providerFailure,
  providerSuccess,
  createProviderError,
} from "@nexustrade/shared";

import { parseJson } from "../../db/utils/json.js";
import { mapCandidateToRadarEntry } from "./RadarCandidateMapper.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const discoveredAt = new Date("2026-06-20T12:00:00.000Z");
const cycleTimestampMs = new Date("2026-06-20T12:05:00.000Z").getTime();

describe("RadarCandidateMapper", () => {
  it("maps successful enrichment into TokenRadar input", () => {
    const pairCreatedAt = new Date("2026-06-20T12:01:00.000Z");
    const input = mapCandidateToRadarEntry({
      sessionId: "session_test",
      candidate: {
        source: "DEXSCREENER",
        discoveredAt,
        identity: {
          chainId: "solana",
          mintAddress: SOL_MINT,
        },
      },
      cycleTimestampMs,
      enrichment: providerSuccess({
        provider: "DEXSCREENER",
        data: {
          identity: {
            chainId: "solana",
            mintAddress: SOL_MINT,
            symbol: "SOL",
            name: "Wrapped SOL",
          },
          price: {
            mintAddress: SOL_MINT,
            source: "DEXSCREENER",
            fetchedAt: discoveredAt,
            priceUsd: 140.25,
            priceSol: 1,
          },
          bestPair: {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: "pair_123",
            baseMint: SOL_MINT,
            quoteMint: USDC_MINT,
            source: "DEXSCREENER",
            fetchedAt: discoveredAt,
            liquidityUsd: 10_000,
            volume5m: 500,
            volume1h: 2_500,
            pairCreatedAt,
          },
          sourcesUsed: ["DEXSCREENER"],
          warnings: [],
          fetchedAt: discoveredAt,
        },
      }),
    });

    expect(input.status).toBe("DISCOVERED");
    expect(input.symbol).toBe("SOL");
    expect(input.name).toBe("Wrapped SOL");
    expect(input.pairAddress).toBe("pair_123");
    expect(input.priceUsd).toBe("140.25");
    expect(input.priceSol).toBe("1");
    expect(input.liquidityUsd).toBe("10000");
    expect(input.volume5mUsd).toBe("500");
    expect(input.volume1hUsd).toBe("2500");
    expect(input.firstSeenAtMs).toBe(pairCreatedAt.getTime());
    expect(input.ageSeconds).toBe(240);
    expect(parseJson<Record<string, unknown>>(input.rawDataJson ?? "{}").phase).toBe(
      "PHASE_4_SCANNER_ONLY",
    );
  });

  it("maps enrichment failures into ERROR radar inputs", () => {
    const input = mapCandidateToRadarEntry({
      sessionId: "session_test",
      candidate: {
        source: "DEXSCREENER",
        discoveredAt,
        identity: {
          chainId: "solana",
          mintAddress: SOL_MINT,
        },
      },
      cycleTimestampMs,
      enrichment: providerFailure({
        provider: "DEXSCREENER",
        error: createProviderError({
          code: "PROVIDER_UNAVAILABLE",
          message: "Provider down.",
        }),
      }),
    });

    expect(input.status).toBe("ERROR");
    expect(input.notes).toContain("PROVIDER_UNAVAILABLE");
  });
});
