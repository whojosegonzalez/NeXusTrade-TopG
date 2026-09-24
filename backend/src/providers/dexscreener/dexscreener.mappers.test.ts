import { describe, expect, it } from "vitest";

import { parseTokenMintAddress } from "@nexustrade/shared";

import {
  mapDexScreenerPair,
  mapDexScreenerPairToPrice,
  selectBestDexScreenerPair,
} from "./dexscreener.mappers.js";
import type { DexScreenerPair } from "./dexscreener.schemas.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function fixturePair(overrides: Partial<DexScreenerPair> = {}): DexScreenerPair {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "pair-address",
    baseToken: {
      address: SOL_MINT,
      symbol: "SOL",
      name: "Wrapped SOL",
    },
    quoteToken: {
      address: USDC_MINT,
      symbol: "USDC",
      name: "USD Coin",
    },
    priceNative: "1",
    priceUsd: "140.5",
    liquidity: {
      usd: 1_000_000,
      base: 1,
      quote: 140.5,
    },
    volume: {
      m5: 10,
      h1: 100,
      h6: 600,
      h24: 2_400,
    },
    txns: {
      m5: {
        buys: 3,
        sells: 2,
      },
    },
    pairCreatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("DexScreener mappers", () => {
  it("normalizes pair and price snapshots", () => {
    const fetchedAt = new Date("2026-06-20T12:00:00.000Z");
    const pair = mapDexScreenerPair(fixturePair(), fetchedAt);

    expect(pair?.baseMint).toBe(SOL_MINT);
    expect(pair?.quoteMint).toBe(USDC_MINT);
    expect(pair?.liquidityUsd).toBe(1_000_000);
    expect(pair?.volume24h).toBe(2_400);

    const price = mapDexScreenerPairToPrice(pair!, parseTokenMintAddress(SOL_MINT));

    expect(price.priceUsd).toBe(140.5);
    expect(price.symbol).toBe("SOL");
    expect(price.rawReferenceId).toBe("pair-address");
  });

  it("selects the best pair deterministically by liquidity first", () => {
    const fetchedAt = new Date("2026-06-20T12:00:00.000Z");
    const low = mapDexScreenerPair(
      fixturePair({ pairAddress: "a", liquidity: { usd: 100 } }),
      fetchedAt,
    );
    const high = mapDexScreenerPair(
      fixturePair({ pairAddress: "b", liquidity: { usd: 500 } }),
      fetchedAt,
    );

    expect(selectBestDexScreenerPair([low!, high!])?.pairAddress).toBe("b");
  });
});
