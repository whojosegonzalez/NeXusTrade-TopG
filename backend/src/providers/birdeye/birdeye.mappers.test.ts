import { describe, expect, it } from "vitest";
import { parseTokenMintAddress } from "@nexustrade/shared";

import {
  mapBirdeyeOverviewToMetadata,
  mapBirdeyePrice,
  summarizeBirdeyeOverview,
} from "./birdeye.mappers.js";

const MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const FETCHED_AT = new Date("2026-08-03T12:00:00.000Z");

describe("Birdeye mappers", () => {
  it("maps price responses to token price snapshots", () => {
    const price = mapBirdeyePrice(
      MINT,
      {
        success: true,
        data: {
          value: "175.42",
          symbol: "SOL",
        },
      },
      FETCHED_AT,
    );

    expect(price).toMatchObject({
      mintAddress: MINT,
      symbol: "SOL",
      priceUsd: 175.42,
      source: "BIRDEYE",
      confidence: "MEDIUM",
    });
  });

  it("maps token overview identity fields to metadata", () => {
    const metadata = mapBirdeyeOverviewToMetadata(
      MINT,
      {
        success: true,
        data: {
          symbol: "SOL",
          name: "Wrapped SOL",
          decimals: 9,
          logoURI: "https://example.test/sol.png",
        },
      },
      FETCHED_AT,
    );

    expect(metadata).toMatchObject({
      mintAddress: MINT,
      symbol: "SOL",
      name: "Wrapped SOL",
      decimals: 9,
      imageUri: "https://example.test/sol.png",
      source: "BIRDEYE",
    });
  });

  it("summarizes selected market activity frames conservatively", () => {
    const overview = summarizeBirdeyeOverview(
      {
        success: true,
        data: {
          symbol: "SOL",
          price: 175,
          liquidity: 1000000,
          marketCap: 100000000,
          v5mUSD: 5000,
          trade5m: 25,
          buy5m: 15,
          sell5m: 10,
        },
      },
      ["1m", "5m"],
    );

    expect(overview.symbol).toBe("SOL");
    expect(overview.price).toBe(175);
    expect(overview.liquidity).toBe(1000000);
    expect(overview.frames["1m"]).toBeUndefined();
    expect(overview.frames["5m"]).toEqual({
      volumeUsd: 5000,
      tradeCount: 25,
      buyCount: 15,
      sellCount: 10,
    });
  });
});
