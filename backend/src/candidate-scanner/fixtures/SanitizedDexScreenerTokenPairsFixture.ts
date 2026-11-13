/**
 * [SYNTHETIC, SCHEMA-SHAPED] DexScreener token-pairs response fixture (version-controlled).
 *
 * Shaped like `GET https://api.dexscreener.com/latest/dex/tokens/<mint>` (`{ schemaVersion, pairs }`)
 * for the reference RAY/WSOL identities used by the other offline fixtures. Every value is SYNTHETIC
 * and sanitized: this is not a capture, carries no request metadata, and depends on no private capture
 * directory. Besides the exact Raydium RAY/WSOL pair it lists two decoys for the same mint (a USDC
 * quote and another DEX), which the strict parser must not select.
 */

import { CAPTURED_RAY_WSOL_IDENTITIES } from "./CapturedRaydiumAmmV4SnapshotFixture.js";

export const FIXTURE_POOL = CAPTURED_RAY_WSOL_IDENTITIES.poolId;
export const FIXTURE_MINT = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint as string;
export const FIXTURE_WSOL = "So11111111111111111111111111111111111111112";
const FIXTURE_USDC = "EPjFWdd5AufqSSqeM2qQXBpytxZ6vbVUGtS7xxSc1W7Y";
const DECOY_POOL = "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX";
const DECOY_POOL_2 = "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ";

/** [SYNTHETIC] The exact Raydium pair; `overrides` replace top-level pair fields. */
export function syntheticDexScreenerPair(
  options: { readonly pairCreatedAtMs: number; readonly priceNative?: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    url: `https://dexscreener.com/solana/${FIXTURE_POOL.toLowerCase()}`,
    pairAddress: FIXTURE_POOL,
    baseToken: { address: FIXTURE_MINT, name: "SYNTHETIC Raydium", symbol: "RAY" },
    quoteToken: { address: FIXTURE_WSOL, name: "Wrapped SOL", symbol: "SOL" },
    priceNative: options.priceNative ?? "0.0001",
    priceUsd: "0.015",
    txns: {
      m5: { buys: 40, sells: 15 },
      h1: { buys: 300, sells: 180 },
      h6: { buys: 1500, sells: 1100 },
      h24: { buys: 5200, sells: 4800 },
    },
    volume: { h24: 900_000, h6: 220_000, h1: 60_000, m5: 15_000 },
    priceChange: { m5: 0, h1: 4.2, h6: 6.1, h24: -2.3 },
    liquidity: { usd: 65_000, base: 2_166_666.6, quote: 216.67 },
    fdv: 300_000,
    marketCap: 250_000,
    pairCreatedAt: options.pairCreatedAtMs,
    ...overrides,
  };
}

/** [SYNTHETIC] Full response: the exact pair plus two decoys for the same mint. */
export function syntheticDexScreenerTokenPairsResponse(
  options: { readonly pairCreatedAtMs: number; readonly priceNative?: string },
  overrides: Record<string, unknown> = {},
): { readonly schemaVersion: string; readonly pairs: readonly Record<string, unknown>[] } {
  return {
    schemaVersion: "1.0.0",
    pairs: [
      syntheticDexScreenerPair(options, overrides),
      // Decoy 1: same mint, Raydium, but quoted in USDC (not WSOL) and a different pool.
      {
        ...syntheticDexScreenerPair(options),
        pairAddress: DECOY_POOL,
        quoteToken: { address: FIXTURE_USDC, name: "USD Coin", symbol: "USDC" },
        liquidity: { usd: 900_000, base: 1, quote: 1 },
      },
      // Decoy 2: same mint, another DEX.
      { ...syntheticDexScreenerPair(options), pairAddress: DECOY_POOL_2, dexId: "orca" },
    ],
  };
}
