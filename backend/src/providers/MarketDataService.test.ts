import { describe, expect, it } from "vitest";

import {
  createProviderError,
  parseTokenMintAddress,
  providerFailure,
  providerSuccess,
  type DexPairSnapshot,
  type TokenMetadataSnapshot,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import { MarketDataService } from "./MarketDataService.js";
import { ProviderRegistry } from "./ProviderRegistry.js";
import type {
  LiquidityProvider,
  PriceProvider,
  TokenMetadataProvider,
} from "./interfaces/index.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const fetchedAt = new Date("2026-06-20T12:00:00.000Z");

describe("MarketDataService", () => {
  it("combines available provider results into an enrichment snapshot", async () => {
    const price: TokenPriceSnapshot = {
      mintAddress: SOL_MINT,
      source: "MOCK",
      fetchedAt,
      priceUsd: 140,
      symbol: "SOL",
    };
    const bestPair: DexPairSnapshot = {
      chainId: "solana",
      dexId: "mockdex",
      pairAddress: "pair-1",
      baseMint: SOL_MINT,
      quoteMint: USDC_MINT,
      source: "MOCK",
      fetchedAt,
      liquidityUsd: 1_000,
    };
    const metadata: TokenMetadataSnapshot = {
      mintAddress: SOL_MINT,
      source: "MOCK",
      fetchedAt,
      name: "Wrapped SOL",
      symbol: "SOL",
      decimals: 9,
    };
    const priceProvider: PriceProvider = {
      name: "MOCK",
      capabilities: ["PRICE"],
      getPrice: async () => providerSuccess({ provider: "MOCK", data: price }),
    };
    const liquidityProvider: LiquidityProvider = {
      name: "MOCK",
      capabilities: ["LIQUIDITY"],
      getPairsForToken: async () => providerSuccess({ provider: "MOCK", data: [bestPair] }),
      getBestPairForToken: async () => providerSuccess({ provider: "MOCK", data: bestPair }),
    };
    const metadataProvider: TokenMetadataProvider = {
      name: "MOCK",
      capabilities: ["TOKEN_METADATA"],
      getTokenMetadata: async () => providerSuccess({ provider: "MOCK", data: metadata }),
    };
    const registry = new ProviderRegistry([priceProvider, liquidityProvider, metadataProvider]);

    const result = await new MarketDataService(registry).enrichToken({ mintAddress: SOL_MINT });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.identity.symbol : undefined).toBe("SOL");
    expect(result.ok ? result.data.price?.priceUsd : undefined).toBe(140);
    expect(result.ok ? result.data.bestPair?.pairAddress : undefined).toBe("pair-1");
    expect(result.ok ? result.data.sourcesUsed : undefined).toEqual(["MOCK"]);
  });

  it("returns warnings instead of failing when a provider is unavailable", async () => {
    const priceProvider: PriceProvider = {
      name: "MOCK",
      capabilities: ["PRICE"],
      getPrice: async () =>
        providerFailure({
          provider: "MOCK",
          error: createProviderError({
            code: "PROVIDER_UNAVAILABLE",
            message: "Provider is down.",
          }),
        }),
    };
    const registry = new ProviderRegistry([priceProvider]);

    const result = await new MarketDataService(registry).enrichToken({ mintAddress: SOL_MINT });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.warnings[0] : undefined).toContain("PROVIDER_UNAVAILABLE");
  });
});
