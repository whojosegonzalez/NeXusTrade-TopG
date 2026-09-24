import type {
  TokenMetadataSnapshot,
  TokenMintAddress,
  TokenPriceSnapshot,
  TokenSymbol,
} from "@nexustrade/shared";

import type { BirdeyeEnvelope } from "./birdeye.schemas.js";

export interface BirdeyeOverviewContext {
  readonly address?: string;
  readonly symbol?: string;
  readonly name?: string;
  readonly price?: number;
  readonly liquidity?: number;
  readonly marketCap?: number;
  readonly fdv?: number;
  readonly holderCount?: number;
  readonly lastTradeUnixTime?: number;
  readonly frames: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export function mapBirdeyePrice(
  mintAddress: TokenMintAddress,
  response: BirdeyeEnvelope,
  fetchedAt: Date,
): TokenPriceSnapshot {
  const data = readRecord(response.data);
  const nested = data ? readRecord(data[mintAddress]) : undefined;
  const priceUsd =
    readNumber(data?.value) ??
    readNumber(data?.price) ??
    readNumber(data?.priceUsd) ??
    readNumber(nested?.value) ??
    readNumber(nested?.price);

  if (priceUsd === undefined) {
    throw new Error("Birdeye price response did not include a numeric price.");
  }

  const symbol = readString(data?.symbol);

  return {
    mintAddress,
    ...(symbol ? { symbol: symbol as TokenSymbol } : {}),
    priceUsd,
    source: "BIRDEYE",
    fetchedAt,
    confidence: "MEDIUM",
  };
}

export function mapBirdeyeOverviewToMetadata(
  mintAddress: TokenMintAddress,
  response: BirdeyeEnvelope,
  fetchedAt: Date,
): TokenMetadataSnapshot {
  const data = requireDataRecord(response);
  const symbol = readString(data.symbol);
  const name = readString(data.name);
  const decimals = readNumber(data.decimals);
  const imageUri =
    readString(data.logoURI) ?? readString(data.logoUri) ?? readString(data.logo_uri);

  if (!symbol && !name && decimals === undefined && !imageUri) {
    throw new Error("Birdeye overview response did not include usable metadata fields.");
  }

  return {
    mintAddress,
    ...(symbol ? { symbol: symbol as TokenSymbol } : {}),
    ...(name ? { name } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(imageUri ? { imageUri } : {}),
    source: "BIRDEYE",
    fetchedAt,
  };
}

export function summarizeBirdeyeOverview(
  response: BirdeyeEnvelope,
  frames: readonly string[],
): BirdeyeOverviewContext {
  const data = requireDataRecord(response);
  const address = readString(data.address);
  const symbol = readString(data.symbol);
  const name = readString(data.name);
  const price = readNumber(data.price);
  const liquidity = readNumber(data.liquidity);
  const marketCap = readNumber(data.marketCap) ?? readNumber(data.mc);
  const fdv = readNumber(data.fdv);
  const holderCount = readNumber(data.holder) ?? readNumber(data.holderCount);
  const lastTradeUnixTime = readNumber(data.lastTradeUnixTime);
  const frameEntries: [string, Readonly<Record<string, number>>][] = [];

  for (const frame of frames) {
    const summary = summarizeFrame(data, frame);

    if (Object.keys(summary).length > 0) {
      frameEntries.push([frame, summary]);
    }
  }

  return {
    ...(address ? { address } : {}),
    ...(symbol ? { symbol } : {}),
    ...(name ? { name } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(liquidity !== undefined ? { liquidity } : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(fdv !== undefined ? { fdv } : {}),
    ...(holderCount !== undefined ? { holderCount } : {}),
    ...(lastTradeUnixTime !== undefined ? { lastTradeUnixTime } : {}),
    frames: Object.fromEntries(frameEntries),
  };
}

function summarizeFrame(
  data: Readonly<Record<string, unknown>>,
  frame: string,
): Readonly<Record<string, number>> {
  const candidates: Readonly<Record<string, readonly string[]>> = {
    volumeUsd: [`v${frame}USD`, `volume${frame}Usd`, `volume${frame}USD`],
    priceChangePct: [`priceChange${frame}`, `priceChange${frame}Percent`, `v${frame}ChangePercent`],
    tradeCount: [`trade${frame}`, `trade${frame}Count`, `txns${frame}`],
    buyCount: [`buy${frame}`, `buy${frame}Count`],
    sellCount: [`sell${frame}`, `sell${frame}Count`],
    uniqueWalletCount: [`uniqueWallet${frame}`, `uniqueWallet${frame}Count`],
    buyVolumeUsd: [`buy${frame}Volume`, `buy${frame}VolumeUsd`, `buy${frame}VolumeUSD`],
    sellVolumeUsd: [`sell${frame}Volume`, `sell${frame}VolumeUsd`, `sell${frame}VolumeUSD`],
  };
  const result: Record<string, number> = {};

  for (const [name, keys] of Object.entries(candidates)) {
    const value = keys.map((key) => readNumber(data[key])).find((item) => item !== undefined);

    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

function requireDataRecord(response: BirdeyeEnvelope): Readonly<Record<string, unknown>> {
  const data = readRecord(response.data);

  if (!data) {
    throw new Error("Birdeye response did not include an object data payload.");
  }

  return data;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
