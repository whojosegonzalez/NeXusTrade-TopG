/**
 * Phase 12.94-D D.3.3: strict DexScreener market parser for the PAPER single-candidate path (pure).
 *
 * Maps one DexScreener token-pairs response (`/latest/dex/tokens/<mint>`, `{ pairs: [...] }`) to the
 * coordinator's market snapshot for ONE fixed pool and mint. It reuses the identity and price
 * mappings of the daemon's DexScreener spot path (pairAddress, quoteToken, priceNative, priceUsd,
 * liquidity, volume, txns, priceChange) but never substitutes favourable values:
 *
 * - the pair must be the exact pool (no prefix handling, no highest-liquidity fallback), on Solana,
 *   on Raydium (Raydium CLMM/CPMM labels are rejected), with the candidate mint as the base token and
 *   WSOL as the quote token (by address only; a "SOL" symbol is not enough);
 * - price units are preserved: `priceNative` is SOL per candidate token; `priceUsd` is USD per token;
 * - the original pool creation time (`pairCreatedAt`) is kept with its provenance and never derived;
 * - any missing or malformed field the scanner or strategy needs makes the snapshot unavailable;
 *   optional fields (price changes) stay absent when missing and are classified UNAVAILABLE;
 * - LP inaccessibility and mint/freeze authorities are never taken from the market response
 *   (UNAVAILABLE / unverified); the validated security path supplies them.
 */

import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";
import type { PaperCoordinatorMarketParser } from "./PaperSingleCandidateCoordinator.js";
import type { PaperSecurityTarget } from "./PaperCandidateSecurityContext.js";

export const WSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const UNVERIFIED_AUTHORITY = "UNVERIFIED_AUTHORITY";
const UNSUPPORTED_RAYDIUM_LABELS: ReadonlySet<string> = new Set(["CLMM", "CPMM", "V3", "CL"]);

export type DexScreenerFieldClassification = "OBSERVED" | "UNAVAILABLE";

export type DexScreenerMarketParseFailureReason =
  | "MALFORMED_RESPONSE"
  | "NO_PAIRS"
  | "POOL_NOT_FOUND"
  | "AMBIGUOUS_POOL"
  | "CHAIN_NOT_SOLANA"
  | "DEX_NOT_RAYDIUM"
  | "UNSUPPORTED_RAYDIUM_POOL_TYPE"
  | "UNSUPPORTED_ORIENTATION"
  | "BASE_MINT_MISMATCH"
  | "QUOTE_NOT_WSOL"
  | "PRICE_NATIVE_INVALID"
  | "PRICE_USD_INVALID"
  | "LIQUIDITY_UNAVAILABLE"
  | "MARKET_CAP_UNAVAILABLE"
  | "CREATION_TIME_UNAVAILABLE"
  | "M5_TXNS_UNAVAILABLE"
  | "M5_VOLUME_UNAVAILABLE"
  | "SYMBOL_UNAVAILABLE";

export interface DexScreenerMarketProvenance {
  readonly provider: "DEXSCREENER";
  readonly pairAddress: string;
  readonly chainId: "solana";
  readonly dexId: "raydium";
  readonly labels: readonly string[];
  readonly orientation: "TOKEN_BASE_WSOL_QUOTE";
  readonly priceUnits: {
    readonly priceNative: "SOL_PER_TOKEN";
    readonly priceUsd: "USD_PER_TOKEN";
  };
  readonly creation: {
    readonly pairCreatedAtMs: number;
    readonly openTimeSec: number;
    readonly source: "DEXSCREENER_PAIR_CREATED_AT";
  };
  readonly receivedAtMs: number | null;
  readonly classifications: Readonly<Record<string, DexScreenerFieldClassification>>;
}

export type DexScreenerMarketParseResult =
  | {
      readonly ok: true;
      readonly pool: ScannedPoolRecord;
      readonly spot: {
        readonly spotPriceSol: number;
        readonly spotPriceUsd: number;
        readonly liquidityUsd: number;
        readonly momentum5mBps?: number;
        readonly priceChange1hPct?: number;
      };
      readonly provenance: DexScreenerMarketProvenance;
    }
  | { readonly ok: false; readonly reason: DexScreenerMarketParseFailureReason };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const finiteNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const safeNonNegativeInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** A strictly positive finite decimal string (DexScreener sends prices as strings). */
const positiveDecimalString = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(v.trim()))
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Strict parse of one DexScreener token-pairs response for the fixed pool and mint. */
export function parseDexScreenerTokenPairs(
  json: unknown,
  target: PaperSecurityTarget,
  receivedAtMs: number | null = null,
): DexScreenerMarketParseResult {
  const fail = (reason: DexScreenerMarketParseFailureReason) => ({ ok: false as const, reason });
  if (!isRecord(json) || !Array.isArray(json.pairs)) return fail("MALFORMED_RESPONSE");
  if (json.pairs.length === 0) return fail("NO_PAIRS");
  const matches = json.pairs.filter((p) => isRecord(p) && p.pairAddress === target.poolId);
  if (matches.length === 0) return fail("POOL_NOT_FOUND");
  if (matches.length > 1) return fail("AMBIGUOUS_POOL");
  const pair = matches[0] as Record<string, unknown>;

  if (pair.chainId !== "solana") return fail("CHAIN_NOT_SOLANA");
  if (pair.dexId !== "raydium") return fail("DEX_NOT_RAYDIUM");
  const labels = Array.isArray(pair.labels)
    ? pair.labels.filter((l): l is string => typeof l === "string")
    : [];
  if (labels.some((l) => UNSUPPORTED_RAYDIUM_LABELS.has(l.toUpperCase()))) {
    return fail("UNSUPPORTED_RAYDIUM_POOL_TYPE");
  }
  const base = isRecord(pair.baseToken) ? pair.baseToken : undefined;
  const quote = isRecord(pair.quoteToken) ? pair.quoteToken : undefined;
  if (base?.address === WSOL_MINT_ADDRESS && quote?.address === target.mintAddress) {
    return fail("UNSUPPORTED_ORIENTATION");
  }
  if (base?.address !== target.mintAddress) return fail("BASE_MINT_MISMATCH");
  if (quote?.address !== WSOL_MINT_ADDRESS) return fail("QUOTE_NOT_WSOL");
  const symbol = typeof base.symbol === "string" && base.symbol.trim() !== "" ? base.symbol : null;
  if (symbol === null) return fail("SYMBOL_UNAVAILABLE");

  const priceNative = positiveDecimalString(pair.priceNative);
  if (priceNative === null) return fail("PRICE_NATIVE_INVALID");
  const priceUsd = positiveDecimalString(pair.priceUsd);
  if (priceUsd === null) return fail("PRICE_USD_INVALID");
  const liquidityUsd = isRecord(pair.liquidity) ? pair.liquidity.usd : undefined;
  if (!finiteNonNegative(liquidityUsd)) return fail("LIQUIDITY_UNAVAILABLE");
  if (!finiteNonNegative(pair.marketCap)) return fail("MARKET_CAP_UNAVAILABLE");
  const pairCreatedAt = pair.pairCreatedAt;
  if (!safeNonNegativeInteger(pairCreatedAt) || pairCreatedAt === 0) {
    return fail("CREATION_TIME_UNAVAILABLE");
  }
  const m5 = isRecord(pair.txns) && isRecord(pair.txns.m5) ? pair.txns.m5 : undefined;
  if (!safeNonNegativeInteger(m5?.buys) || !safeNonNegativeInteger(m5?.sells)) {
    return fail("M5_TXNS_UNAVAILABLE");
  }
  const volume5mUsd = isRecord(pair.volume) ? pair.volume.m5 : undefined;
  if (!finiteNonNegative(volume5mUsd)) return fail("M5_VOLUME_UNAVAILABLE");

  const priceChange = isRecord(pair.priceChange) ? pair.priceChange : {};
  const m5Change =
    typeof priceChange.m5 === "number" && Number.isFinite(priceChange.m5)
      ? priceChange.m5
      : undefined;
  const h1Change =
    typeof priceChange.h1 === "number" && Number.isFinite(priceChange.h1)
      ? priceChange.h1
      : undefined;
  const openTimeSec = Math.floor(pairCreatedAt / 1000);
  const buys5m = m5!.buys as number;
  const sells5m = m5!.sells as number;

  const classifications: Record<string, DexScreenerFieldClassification> = {
    priceNative: "OBSERVED",
    priceUsd: "OBSERVED",
    liquidityUsd: "OBSERVED",
    marketCapUsd: "OBSERVED",
    pairCreatedAt: "OBSERVED",
    txnsM5: "OBSERVED",
    volumeM5: "OBSERVED",
    priceChangeM5: m5Change === undefined ? "UNAVAILABLE" : "OBSERVED",
    priceChangeH1: h1Change === undefined ? "UNAVAILABLE" : "OBSERVED",
    decimals: "UNAVAILABLE",
    lpBurnPct: "UNAVAILABLE",
    mintAuthority: "UNAVAILABLE",
    freezeAuthority: "UNAVAILABLE",
  };

  const pool: ScannedPoolRecord = {
    poolId: target.poolId,
    mintAddress: target.mintAddress,
    symbol,
    decimals: 0, // not provided by DexScreener; copied only, never evaluated (UNAVAILABLE)
    baseMint: target.mintAddress,
    liquidityUsd,
    marketCapUsd: pair.marketCap as number,
    openTimeSec,
    lpBurnPct: null, // never from the market response; the validated LP bridge supplies it
    mintAuthority: UNVERIFIED_AUTHORITY,
    freezeAuthority: UNVERIFIED_AUTHORITY,
    volume5mUsd,
    txCount5m: buys5m + sells5m,
    buys5m,
    sells5m,
    spotPriceUsd: priceUsd,
    spotPriceSol: priceNative,
    fetchedAt: receivedAtMs === null ? "" : new Date(receivedAtMs).toISOString(),
    metricProvenance: {
      tokenAgeSec: "OBSERVED",
      liquidityUsd: "OBSERVED",
      marketCapUsd: "OBSERVED",
      volume5mUsd: "OBSERVED",
      txCount5m: "OBSERVED",
      buys5m: "OBSERVED",
      sells5m: "OBSERVED",
      lpBurnPct: "UNAVAILABLE",
      decimals: "UNAVAILABLE",
      mintAuthority: "UNAVAILABLE",
      freezeAuthority: "UNAVAILABLE",
    },
  };
  return {
    ok: true,
    pool,
    spot: {
      spotPriceSol: priceNative,
      spotPriceUsd: priceUsd,
      liquidityUsd,
      ...(m5Change !== undefined ? { momentum5mBps: Math.round(m5Change * 100) } : {}),
      ...(h1Change !== undefined ? { priceChange1hPct: h1Change } : {}),
    },
    provenance: Object.freeze({
      provider: "DEXSCREENER",
      pairAddress: target.poolId,
      chainId: "solana",
      dexId: "raydium",
      labels: Object.freeze([...labels]),
      orientation: "TOKEN_BASE_WSOL_QUOTE",
      priceUnits: Object.freeze({ priceNative: "SOL_PER_TOKEN", priceUsd: "USD_PER_TOKEN" }),
      creation: Object.freeze({
        pairCreatedAtMs: pairCreatedAt,
        openTimeSec,
        source: "DEXSCREENER_PAIR_CREATED_AT",
      }),
      receivedAtMs,
      classifications: Object.freeze(classifications),
    }) as DexScreenerMarketProvenance,
  };
}

/** Coordinator adapter: a rejected snapshot is unavailable (null), never a favourable default. */
export const dexScreenerSingleCandidateMarketParser: PaperCoordinatorMarketParser = (
  json,
  target,
  receivedAtMs,
) => {
  const result = parseDexScreenerTokenPairs(json, target, receivedAtMs ?? null);
  return result.ok ? { pool: result.pool, spot: result.spot } : null;
};
