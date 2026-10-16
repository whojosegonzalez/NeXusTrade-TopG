/**
 * Phase 12.94-D Milestone D.2.3: DexScreener Response Adapter
 *
 * Implements strict offline parsing and validation of DexScreener responses.
 * Enforces two-stage discovery (profile -> pair), selection-bias labeling,
 * case-sensitive base58 address retention, and rejection of proxy timestamps.
 *
 * Authority: Finding D23-A01 / D23P-03.
 */

import { isCanonicalSolanaBase58 } from "./RaydiumAmmParser.js";

export interface DexScreenerProfileCandidate {
  readonly tokenAddress: string; // Case-sensitive base58
  readonly chainId: "solana";
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE";
}

export interface DexScreenerPairSummary {
  readonly poolId: string; // Case-sensitive base58
  readonly chainId: string;
  readonly dexId: string;
  readonly baseTokenAddress: string;
  readonly baseTokenSymbol: string;
  readonly quoteTokenAddress: string;
  readonly quoteTokenSymbol: string;
  readonly spotPriceUsd: number | null;
  readonly spotPriceNative: number | null;
  readonly liquidityUsd: number | null;
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly pairCreatedAtMs: number | null; // Historical genesis time only, never source quote time
  readonly sourceReportedTimeMs: null; // Explicitly null per D23-A02 / D23P-03
  readonly missingFields: readonly string[];
  readonly isRaydiumAmmCandidate: boolean;
}

export interface DexScreenerProfilesParseResult {
  readonly ok: boolean;
  readonly candidates: readonly DexScreenerProfileCandidate[];
  readonly totalProfilesEvaluated: number;
  readonly nonSolanaProfilesSkipped: number;
  readonly invalidAddressProfilesSkipped: number;
  readonly parseErrors: readonly string[];
}

export interface DexScreenerPairsParseResult {
  readonly ok: boolean;
  readonly pairs: readonly DexScreenerPairSummary[];
  readonly matchingRaydiumPair: DexScreenerPairSummary | null;
  readonly parseErrors: readonly string[];
}

/**
 * Parses raw JSON payload from GET /token-profiles/latest/v1 (Stage 1).
 */
export function parseDexScreenerTokenProfiles(payload: unknown): DexScreenerProfilesParseResult {
  const parseErrors: string[] = [];
  const candidates: DexScreenerProfileCandidate[] = [];
  let totalProfilesEvaluated = 0;
  let nonSolanaProfilesSkipped = 0;
  let invalidAddressProfilesSkipped = 0;

  if (!Array.isArray(payload)) {
    return {
      ok: false,
      candidates: [],
      totalProfilesEvaluated: 0,
      nonSolanaProfilesSkipped: 0,
      invalidAddressProfilesSkipped: 0,
      parseErrors: ["Expected array of token profiles from DexScreener"],
    };
  }

  for (const item of payload) {
    totalProfilesEvaluated += 1;
    if (typeof item !== "object" || item === null) {
      parseErrors.push(`Item at index ${totalProfilesEvaluated - 1} is not an object`);
      continue;
    }

    const rec = item as Record<string, unknown>;
    const chainId = typeof rec.chainId === "string" ? rec.chainId.trim().toLowerCase() : "";
    const tokenAddress = typeof rec.tokenAddress === "string" ? rec.tokenAddress.trim() : "";

    if (chainId !== "solana") {
      nonSolanaProfilesSkipped += 1;
      continue;
    }

    // Never lowercase Solana addresses (D23-A01)
    if (!isCanonicalSolanaBase58(tokenAddress)) {
      invalidAddressProfilesSkipped += 1;
      parseErrors.push(`Invalid Solana base58 token address: ${tokenAddress}`);
      continue;
    }

    candidates.push({
      tokenAddress,
      chainId: "solana",
      url: typeof rec.url === "string" ? rec.url : undefined,
      description: typeof rec.description === "string" ? rec.description : undefined,
      selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
    });
  }

  return {
    ok: parseErrors.length === 0 || candidates.length > 0,
    candidates,
    totalProfilesEvaluated,
    nonSolanaProfilesSkipped,
    invalidAddressProfilesSkipped,
    parseErrors,
  };
}

/**
 * Parses raw JSON payload from GET /latest/dex/tokens/{tokenAddress} (Stage 2).
 */
export function parseDexScreenerPairsResponse(
  payload: unknown,
  expectedTokenAddress: string,
): DexScreenerPairsParseResult {
  const parseErrors: string[] = [];
  const pairs: DexScreenerPairSummary[] = [];

  let rawPairs: unknown[] = [];
  if (Array.isArray(payload)) {
    rawPairs = payload;
  } else if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as Record<string, unknown>).pairs)
  ) {
    rawPairs = (payload as Record<string, unknown>).pairs as unknown[];
  } else {
    return {
      ok: false,
      pairs: [],
      matchingRaydiumPair: null,
      parseErrors: ["Expected pairs array or object with pairs property from DexScreener"],
    };
  }

  for (const raw of rawPairs) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const p = raw as Record<string, unknown>;

    const pairAddress = typeof p.pairAddress === "string" ? p.pairAddress.trim() : "";
    const chainId = typeof p.chainId === "string" ? p.chainId.trim().toLowerCase() : "";
    const dexId = typeof p.dexId === "string" ? p.dexId.trim().toLowerCase() : "";

    if (!pairAddress || !isCanonicalSolanaBase58(pairAddress)) {
      parseErrors.push(`Skipping pair with invalid pairAddress: ${pairAddress}`);
      continue;
    }

    const baseToken = (
      typeof p.baseToken === "object" && p.baseToken !== null ? p.baseToken : {}
    ) as Record<string, unknown>;
    const quoteToken = (
      typeof p.quoteToken === "object" && p.quoteToken !== null ? p.quoteToken : {}
    ) as Record<string, unknown>;

    const baseTokenAddress = typeof baseToken.address === "string" ? baseToken.address.trim() : "";
    const baseTokenSymbol = typeof baseToken.symbol === "string" ? baseToken.symbol.trim() : "";
    const quoteTokenAddress =
      typeof quoteToken.address === "string" ? quoteToken.address.trim() : "";
    const quoteTokenSymbol = typeof quoteToken.symbol === "string" ? quoteToken.symbol.trim() : "";

    const priceUsdRaw = typeof p.priceUsd === "string" ? Number.parseFloat(p.priceUsd) : null;
    const spotPriceUsd =
      priceUsdRaw !== null && Number.isFinite(priceUsdRaw) && priceUsdRaw > 0 ? priceUsdRaw : null;

    const priceNativeRaw =
      typeof p.priceNative === "string" ? Number.parseFloat(p.priceNative) : null;
    const spotPriceNative =
      priceNativeRaw !== null && Number.isFinite(priceNativeRaw) && priceNativeRaw > 0
        ? priceNativeRaw
        : null;

    const liquidity = (
      typeof p.liquidity === "object" && p.liquidity !== null ? p.liquidity : {}
    ) as Record<string, unknown>;
    const liquidityUsdRaw =
      typeof liquidity.usd === "number"
        ? liquidity.usd
        : typeof liquidity.usd === "string"
          ? Number.parseFloat(liquidity.usd)
          : null;
    const liquidityUsd =
      liquidityUsdRaw !== null && Number.isFinite(liquidityUsdRaw) && liquidityUsdRaw >= 0
        ? liquidityUsdRaw
        : null;

    const volume = (typeof p.volume === "object" && p.volume !== null ? p.volume : {}) as Record<
      string,
      unknown
    >;
    const volume5mRaw =
      typeof volume.m5 === "number"
        ? volume.m5
        : typeof volume.m5 === "string"
          ? Number.parseFloat(volume.m5)
          : null;
    const volume5mUsd =
      volume5mRaw !== null && Number.isFinite(volume5mRaw) && volume5mRaw >= 0 ? volume5mRaw : null;

    const txns = (typeof p.txns === "object" && p.txns !== null ? p.txns : {}) as Record<
      string,
      unknown
    >;
    const txnsM5 = (typeof txns.m5 === "object" && txns.m5 !== null ? txns.m5 : {}) as Record<
      string,
      unknown
    >;
    const buys5m =
      typeof txnsM5.buys === "number" && Number.isFinite(txnsM5.buys) && txnsM5.buys >= 0
        ? txnsM5.buys
        : null;
    const sells5m =
      typeof txnsM5.sells === "number" && Number.isFinite(txnsM5.sells) && txnsM5.sells >= 0
        ? txnsM5.sells
        : null;

    const pairCreatedAtRaw = typeof p.pairCreatedAt === "number" ? p.pairCreatedAt : null;
    const pairCreatedAtMs =
      pairCreatedAtRaw !== null && Number.isFinite(pairCreatedAtRaw) && pairCreatedAtRaw > 0
        ? pairCreatedAtRaw
        : null;

    const missingFields: string[] = [];
    if (spotPriceUsd === null) missingFields.push("spotPriceUsd");
    if (volume5mUsd === null) missingFields.push("volume5mUsd");
    if (buys5m === null) missingFields.push("buys5m");
    if (sells5m === null) missingFields.push("sells5m");

    // Base and quote integer reserves are always omitted by DexScreener pairs endpoint
    missingFields.push("baseReserve", "quoteReserve");

    const isRaydium = chainId === "solana" && dexId === "raydium";
    const labels = Array.isArray(p.labels) ? (p.labels as string[]) : [];
    const isClmmOrCpmm = labels.some((l) => /clmm|cpmm|dlmm/i.test(l));
    const isRaydiumAmmCandidate = isRaydium && !isClmmOrCpmm;

    pairs.push({
      poolId: pairAddress,
      chainId,
      dexId,
      baseTokenAddress,
      baseTokenSymbol,
      quoteTokenAddress,
      quoteTokenSymbol,
      spotPriceUsd,
      spotPriceNative,
      liquidityUsd,
      volume5mUsd,
      buys5m,
      sells5m,
      pairCreatedAtMs,
      sourceReportedTimeMs: null,
      missingFields,
      isRaydiumAmmCandidate,
    });
  }

  // Find primary Raydium AMM candidate matching expectedTokenAddress
  const matchingRaydiumPair =
    pairs.find(
      (p) =>
        p.isRaydiumAmmCandidate &&
        (p.baseTokenAddress === expectedTokenAddress ||
          p.quoteTokenAddress === expectedTokenAddress),
    ) ?? null;

  return {
    ok: pairs.length > 0,
    pairs,
    matchingRaydiumPair,
    parseErrors,
  };
}
