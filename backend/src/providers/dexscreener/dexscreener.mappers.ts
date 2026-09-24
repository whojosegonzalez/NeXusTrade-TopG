import {
  isSolanaMintAddress,
  parseTokenMintAddress,
  type DexPairSnapshot,
  type TokenIdentity,
  type TokenMintAddress,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import type { DexScreenerPair, DexScreenerTokenProfile } from "./dexscreener.schemas.js";

function optionalNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function optionalDate(value: number | null | undefined): Date | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value);
}

export function mapDexScreenerPair(
  pair: DexScreenerPair,
  fetchedAt: Date,
): DexPairSnapshot | undefined {
  if (
    pair.chainId !== "solana" ||
    !pair.dexId ||
    !pair.pairAddress ||
    !pair.baseToken?.address ||
    !pair.quoteToken?.address ||
    !isSolanaMintAddress(pair.baseToken.address) ||
    !isSolanaMintAddress(pair.quoteToken.address)
  ) {
    return undefined;
  }

  const priceUsd = optionalNumber(pair.priceUsd);
  const priceNative = optionalNumber(pair.priceNative);
  const pairCreatedAt = optionalDate(pair.pairCreatedAt);
  const snapshot: DexPairSnapshot = {
    chainId: "solana",
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    baseMint: parseTokenMintAddress(pair.baseToken.address),
    quoteMint: parseTokenMintAddress(pair.quoteToken.address),
    source: "DEXSCREENER",
    fetchedAt,
    ...(pair.baseToken.symbol ? { baseSymbol: pair.baseToken.symbol } : {}),
    ...(pair.quoteToken.symbol ? { quoteSymbol: pair.quoteToken.symbol } : {}),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(priceNative !== undefined ? { priceNative } : {}),
    ...(pair.liquidity?.usd !== null && pair.liquidity?.usd !== undefined
      ? { liquidityUsd: pair.liquidity.usd }
      : {}),
    ...(pair.volume?.m5 !== undefined ? { volume5m: pair.volume.m5 } : {}),
    ...(pair.volume?.h1 !== undefined ? { volume1h: pair.volume.h1 } : {}),
    ...(pair.volume?.h6 !== undefined ? { volume6h: pair.volume.h6 } : {}),
    ...(pair.volume?.h24 !== undefined ? { volume24h: pair.volume.h24 } : {}),
    ...(pair.txns?.m5?.buys !== undefined ? { txns5mBuys: pair.txns.m5.buys } : {}),
    ...(pair.txns?.m5?.sells !== undefined ? { txns5mSells: pair.txns.m5.sells } : {}),
    ...(pairCreatedAt !== undefined ? { pairCreatedAt } : {}),
  };

  return snapshot;
}

export function mapDexScreenerPairs(
  pairs: readonly DexScreenerPair[],
  fetchedAt: Date,
): readonly DexPairSnapshot[] {
  return pairs
    .map((pair) => mapDexScreenerPair(pair, fetchedAt))
    .filter((pair): pair is DexPairSnapshot => pair !== undefined);
}

export function selectBestDexScreenerPair(
  pairs: readonly DexPairSnapshot[],
): DexPairSnapshot | undefined {
  return [...pairs].sort((left, right) => {
    const liquidityDelta = (right.liquidityUsd ?? 0) - (left.liquidityUsd ?? 0);

    if (liquidityDelta !== 0) {
      return liquidityDelta;
    }

    const volumeDelta = (right.volume24h ?? 0) - (left.volume24h ?? 0);

    if (volumeDelta !== 0) {
      return volumeDelta;
    }

    const createdDelta =
      (right.pairCreatedAt?.getTime() ?? 0) - (left.pairCreatedAt?.getTime() ?? 0);

    if (createdDelta !== 0) {
      return createdDelta;
    }

    return left.pairAddress.localeCompare(right.pairAddress);
  })[0];
}

export function mapDexScreenerPairToPrice(
  pair: DexPairSnapshot,
  mintAddress: TokenMintAddress,
): TokenPriceSnapshot {
  const symbol = pair.baseMint === mintAddress ? pair.baseSymbol : pair.quoteSymbol;

  return {
    mintAddress,
    source: "DEXSCREENER",
    fetchedAt: pair.fetchedAt,
    confidence: pair.liquidityUsd && pair.liquidityUsd > 0 ? "MEDIUM" : "LOW",
    ...(symbol ? { symbol } : {}),
    ...(pair.priceUsd !== undefined ? { priceUsd: pair.priceUsd } : {}),
    ...(pair.priceNative !== undefined ? { priceSol: pair.priceNative } : {}),
    rawReferenceId: pair.pairAddress,
  };
}

export function mapDexScreenerTokenProfiles(
  profiles: readonly DexScreenerTokenProfile[],
): readonly TokenIdentity[] {
  return profiles
    .filter(
      (profile) =>
        profile.chainId === "solana" &&
        profile.tokenAddress !== undefined &&
        isSolanaMintAddress(profile.tokenAddress),
    )
    .map((profile) => ({
      chainId: "solana",
      mintAddress: parseTokenMintAddress(profile.tokenAddress ?? ""),
      ...(profile.icon ? { logoUri: profile.icon } : {}),
    }));
}
