/**
 * Phase 12.94-D D.3.3: Strict DexScreener CPMM Candidate Market Parser (Pure)
 *
 * Maps one DexScreener token-pairs response (`/latest/dex/tokens/<mint>`, `{ pairs: [...] }`)
 * to the coordinator's candidate market snapshot for ONE fixed CPMM pool and mint.
 *
 * Behavioral Contracts & Architectural Invariants (§8.38.17):
 * 1. Structural Binding to Caller-Supplied Pool State:
 *    - Binds the exact target poolAddress and candidateMint to a successful RaydiumCpmmPoolStateSuccess
 *      snapshot produced by RaydiumCpmmPoolStateAdapter.
 *    - Matching is strictly structural consistency with caller-supplied adapter output, not cryptographic
 *      authentication. Provider labels or matching public keys do not independently prove protocol identity.
 *    - If target and poolState disagree, or poolState is not a valid recognized state, fails closed deterministically.
 * 2. Provider Semantics & Documentation:
 *    - Official DexScreener API specifications: https://docs.dexscreener.com/api/reference
 *    - Adopted interpretations: priceNative is interpreted as SOL per candidate token; txns.m5.buys/sells
 *      are interpreted as candidate buy/sell counts under standard financial market conventions.
 *    - Synthetic tests verify transformations, not external provider semantics.
 * 3. Restrictive CPMM-Label Policy & Orientation:
 *    - Requires the pair's labels array to contain "CPMM" (case-insensitive) as this parser's restrictive policy.
 *    - Rejects conflicting unsupported Raydium labels ("CLMM", "V3", "CL").
 *    - Accepts only candidate-base and WSOL-quote provider orientation (TOKEN_BASE_WSOL_QUOTE).
 *    - Refuses reversed pairs (base=WSOL, quote=candidate) fail-closed without inversion (UNSUPPORTED_ORIENTATION).
 *    - Supports either on-chain token ordering (TOKEN_0_BASE_WSOL_QUOTE vs TOKEN_1_BASE_WSOL_QUOTE) independently.
 * 4. Separate Price Observations:
 *    - Records the provider spot price and on-chain pool-state spot approximation separately under priceObservations
 *      with comparisonPerformed: false. No discrepancy threshold or simultaneity claim is asserted.
 * 5. Creation vs Activation Provenance:
 *    - Preserves provider-reported pairCreatedAt separately from on-chain swapActivationTimeSec.
 *    - Does not claim pairCreatedAt proves on-chain creation or first indexing time.
 *    - Rolling 5-minute provider aggregations remain distinct from the strategy's 60-second qualified flow.
 * 6. Numeric Validation:
 *    - Prices must be positive finite decimal strings.
 *    - Liquidity, marketCap, and volume must be finite non-negative numbers. Never substitutes FDV for missing marketCap.
 *    - Buys, sells, and their sum must be non-negative safe integers.
 * 7. Date & Derived-Value Validation:
 *    - Validates supplied receivedAtMs before date formatting; invalid values return typed RECEIVED_AT_INVALID refusal.
 *    - Optional price change conversions must never produce infinite, NaN, or unsafe derived values.
 * 8. Unavailable Security Fields & Immutability:
 *    - Security fields (decimals: 0, lpBurnPct: null, mintAuthority, freezeAuthority) remain explicitly UNAVAILABLE.
 *    - Does not alter inputs; freezes all newly constructed output objects and provenance.
 */

import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";
import type {
  RaydiumCpmmPoolStateSuccess,
  RaydiumCpmmPairOrientation,
} from "./RaydiumCpmmPoolStateAdapter.js";

export const WSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const UNVERIFIED_AUTHORITY = "UNVERIFIED_AUTHORITY";
const UNSUPPORTED_RAYDIUM_LABELS: ReadonlySet<string> = new Set(["CLMM", "V3", "CL"]);

export interface DexScreenerCpmmMarketTarget {
  readonly poolAddress: string;
  readonly candidateMint: string;
}

export interface DexScreenerCpmmMarketParserInput {
  readonly json: unknown;
  readonly target: DexScreenerCpmmMarketTarget;
  readonly poolState: RaydiumCpmmPoolStateSuccess;
  readonly receivedAtMs?: number | null;
}

export type DexScreenerCpmmFieldClassification = "OBSERVED" | "UNAVAILABLE";

export type DexScreenerCpmmMarketParseFailureReason =
  | "MALFORMED_RESPONSE"
  | "NO_PAIRS"
  | "POOL_NOT_FOUND"
  | "AMBIGUOUS_POOL"
  | "INVALID_POOL_STATE"
  | "POOL_STATE_BINDING_MISMATCH"
  | "CHAIN_NOT_SOLANA"
  | "DEX_NOT_RAYDIUM"
  | "DEX_LABEL_NOT_CPMM"
  | "UNSUPPORTED_RAYDIUM_POOL_TYPE"
  | "UNSUPPORTED_ORIENTATION"
  | "BASE_MINT_MISMATCH"
  | "QUOTE_NOT_WSOL"
  | "SYMBOL_UNAVAILABLE"
  | "PRICE_NATIVE_INVALID"
  | "PRICE_USD_INVALID"
  | "LIQUIDITY_UNAVAILABLE"
  | "MARKET_CAP_UNAVAILABLE"
  | "CREATION_TIME_UNAVAILABLE"
  | "M5_TXNS_UNAVAILABLE"
  | "M5_VOLUME_UNAVAILABLE"
  | "RECEIVED_AT_INVALID";

export interface DexScreenerCpmmMarketProvenance {
  readonly provider: "DEXSCREENER";
  readonly pairAddress: string;
  readonly chainId: "solana";
  readonly dexId: "raydium";
  readonly labels: readonly string[];
  readonly onChainOrientation: RaydiumCpmmPairOrientation;
  readonly dexScreenerOrientation: "TOKEN_BASE_WSOL_QUOTE";
  readonly priceUnits: {
    readonly priceNative: "SOL_PER_TOKEN";
    readonly priceUsd: "USD_PER_TOKEN";
  };
  readonly creation: {
    readonly pairCreatedAtMs: number;
    readonly openTimeSec: number;
    readonly source: "DEXSCREENER_PAIR_CREATED_AT";
  };
  readonly onChainActivation: {
    readonly swapActivationTimeSec: bigint;
    readonly source: "RAYDIUM_CPMM_OPEN_TIME";
  };
  readonly metricWindows: {
    readonly providerRolling5m: "5m";
    readonly strategyQualifiedFlowWindow: "UNCONNECTED";
  };
  readonly priceObservations: {
    readonly spotPriceSolMarket: number;
    readonly spotPriceSolOnChainApprox: number;
    readonly comparisonPerformed: false;
  };
  readonly receivedAtMs: number | null;
  readonly classifications: Readonly<Record<string, DexScreenerCpmmFieldClassification>>;
}

export interface DexScreenerCpmmSpotInfo {
  readonly spotPriceSol: number;
  readonly spotPriceUsd: number;
  readonly liquidityUsd: number;
  readonly momentum5mBps?: number;
  readonly priceChange1hPct?: number;
}

export type DexScreenerCpmmMarketParseResult =
  | {
      readonly ok: true;
      readonly pool: ScannedPoolRecord;
      readonly spot: DexScreenerCpmmSpotInfo;
      readonly provenance: DexScreenerCpmmMarketProvenance;
    }
  | {
      readonly ok: false;
      readonly reason: DexScreenerCpmmMarketParseFailureReason;
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const finiteNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

const safeNonNegativeInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A strictly positive finite decimal string (DexScreener sends prices as strings). */
const positiveDecimalString = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(v.trim())) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Strict parse of one DexScreener token-pairs response bound to an on-chain CPMM pool state.
 */
export function parseDexScreenerCpmmTokenPairs(
  input: DexScreenerCpmmMarketParserInput,
): DexScreenerCpmmMarketParseResult {
  const fail = (reason: DexScreenerCpmmMarketParseFailureReason) =>
    Object.freeze({ ok: false as const, reason });

  // 1. Structural validation of supplied poolState and target
  if (!isRecord(input) || !isRecord(input.target)) {
    return fail("MALFORMED_RESPONSE");
  }
  const { json, target, poolState } = input;
  if (typeof target.poolAddress !== "string" || typeof target.candidateMint !== "string") {
    return fail("POOL_STATE_BINDING_MISMATCH");
  }

  const ps = poolState as unknown;
  if (!isRecord(ps) || ps.ok !== true) {
    return fail("INVALID_POOL_STATE");
  }
  if (
    ps.poolAddress !== target.poolAddress ||
    ps.candidateMint !== target.candidateMint ||
    ps.wsolMint !== WSOL_MINT_ADDRESS
  ) {
    return fail("POOL_STATE_BINDING_MISMATCH");
  }
  if (
    ps.orientation !== "TOKEN_0_BASE_WSOL_QUOTE" &&
    ps.orientation !== "TOKEN_1_BASE_WSOL_QUOTE"
  ) {
    return fail("INVALID_POOL_STATE");
  }
  if (!finiteNonNegative(ps.spotPriceSolApprox) || typeof ps.swapActivationTimeSec !== "bigint") {
    return fail("INVALID_POOL_STATE");
  }

  // 2. Validate supplied receivedAtMs timestamp before any date operations
  let fetchedAt = "";
  const receivedAtMs = input.receivedAtMs ?? null;
  if (receivedAtMs !== null) {
    if (
      typeof receivedAtMs !== "number" ||
      !Number.isSafeInteger(receivedAtMs) ||
      receivedAtMs < 0 ||
      receivedAtMs > 8640000000000000 // Maximum supported ECMAScript timestamp ms (+100,000,000 days)
    ) {
      return fail("RECEIVED_AT_INVALID");
    }
    try {
      const d = new Date(receivedAtMs);
      if (Number.isNaN(d.getTime())) {
        return fail("RECEIVED_AT_INVALID");
      }
      fetchedAt = d.toISOString();
    } catch {
      return fail("RECEIVED_AT_INVALID");
    }
  }

  // 3. Response shape and pair lookup
  if (!isRecord(json) || !Array.isArray(json.pairs)) {
    return fail("MALFORMED_RESPONSE");
  }
  if (json.pairs.length === 0) {
    return fail("NO_PAIRS");
  }

  const matches = json.pairs.filter((p) => isRecord(p) && p.pairAddress === target.poolAddress);
  if (matches.length === 0) {
    return fail("POOL_NOT_FOUND");
  }
  if (matches.length > 1) {
    return fail("AMBIGUOUS_POOL");
  }
  const pair = matches[0] as Record<string, unknown>;

  // 4. Protocol identification & labels policy
  if (pair.chainId !== "solana") return fail("CHAIN_NOT_SOLANA");
  if (pair.dexId !== "raydium") return fail("DEX_NOT_RAYDIUM");

  const labels = Array.isArray(pair.labels)
    ? pair.labels.filter((l): l is string => typeof l === "string")
    : [];

  const hasCpmmLabel = labels.some((l) => l.trim().toUpperCase() === "CPMM");
  if (!hasCpmmLabel) {
    return fail("DEX_LABEL_NOT_CPMM");
  }

  if (labels.some((l) => UNSUPPORTED_RAYDIUM_LABELS.has(l.trim().toUpperCase()))) {
    return fail("UNSUPPORTED_RAYDIUM_POOL_TYPE");
  }

  // 5. Orientation and token identity
  const base = isRecord(pair.baseToken) ? pair.baseToken : undefined;
  const quote = isRecord(pair.quoteToken) ? pair.quoteToken : undefined;

  if (base?.address === WSOL_MINT_ADDRESS && quote?.address === target.candidateMint) {
    return fail("UNSUPPORTED_ORIENTATION");
  }
  if (base?.address !== target.candidateMint) {
    return fail("BASE_MINT_MISMATCH");
  }
  if (quote?.address !== WSOL_MINT_ADDRESS) {
    return fail("QUOTE_NOT_WSOL");
  }

  const symbol =
    typeof base.symbol === "string" && base.symbol.trim() !== "" ? base.symbol.trim() : null;
  if (symbol === null) {
    return fail("SYMBOL_UNAVAILABLE");
  }

  // 6. Prices, liquidity, market cap, creation time, volume, txns
  const priceNative = positiveDecimalString(pair.priceNative);
  if (priceNative === null) return fail("PRICE_NATIVE_INVALID");

  const priceUsd = positiveDecimalString(pair.priceUsd);
  if (priceUsd === null) return fail("PRICE_USD_INVALID");

  const liquidityUsd = isRecord(pair.liquidity) ? pair.liquidity.usd : undefined;
  if (!finiteNonNegative(liquidityUsd)) return fail("LIQUIDITY_UNAVAILABLE");

  // Never substitute FDV for missing marketCap
  if (!finiteNonNegative(pair.marketCap)) return fail("MARKET_CAP_UNAVAILABLE");

  const pairCreatedAt = pair.pairCreatedAt;
  if (!safeNonNegativeInteger(pairCreatedAt) || pairCreatedAt === 0) {
    return fail("CREATION_TIME_UNAVAILABLE");
  }
  const openTimeSec = Math.floor(pairCreatedAt / 1000);

  const m5 = isRecord(pair.txns) && isRecord(pair.txns.m5) ? pair.txns.m5 : undefined;
  if (!safeNonNegativeInteger(m5?.buys) || !safeNonNegativeInteger(m5?.sells)) {
    return fail("M5_TXNS_UNAVAILABLE");
  }
  const buys5m = m5!.buys as number;
  const sells5m = m5!.sells as number;
  const txCount5m = buys5m + sells5m;
  if (!Number.isSafeInteger(txCount5m)) {
    return fail("M5_TXNS_UNAVAILABLE");
  }

  const volume5mUsd = isRecord(pair.volume) ? pair.volume.m5 : undefined;
  if (!finiteNonNegative(volume5mUsd)) return fail("M5_VOLUME_UNAVAILABLE");

  // 7. Optional price changes (guaranteed finite, non-overflowing)
  const priceChange = isRecord(pair.priceChange) ? pair.priceChange : {};
  let m5Change: number | undefined = undefined;
  if (typeof priceChange.m5 === "number" && Number.isFinite(priceChange.m5)) {
    const scaled = priceChange.m5 * 100;
    if (Number.isFinite(scaled) && Number.isSafeInteger(Math.round(scaled))) {
      m5Change = priceChange.m5;
    }
  }

  let h1Change: number | undefined = undefined;
  if (typeof priceChange.h1 === "number" && Number.isFinite(priceChange.h1)) {
    h1Change = priceChange.h1;
  }

  // 8. Field classifications & output construction
  const classifications: Record<string, DexScreenerCpmmFieldClassification> = {
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

  const pool: ScannedPoolRecord = Object.freeze({
    poolId: target.poolAddress,
    mintAddress: target.candidateMint,
    symbol,
    decimals: 0, // Legacy placeholder; classified as UNAVAILABLE, not observed token decimals
    baseMint: target.candidateMint,
    liquidityUsd,
    marketCapUsd: pair.marketCap as number,
    openTimeSec,
    lpBurnPct: null, // Market data cannot supply LP burn/lock proof; classified UNAVAILABLE
    mintAuthority: UNVERIFIED_AUTHORITY,
    freezeAuthority: UNVERIFIED_AUTHORITY,
    volume5mUsd,
    txCount5m,
    buys5m,
    sells5m,
    spotPriceUsd: priceUsd,
    spotPriceSol: priceNative,
    fetchedAt,
    metricProvenance: Object.freeze({
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
    }),
  });

  const spot: DexScreenerCpmmSpotInfo = Object.freeze({
    spotPriceSol: priceNative,
    spotPriceUsd: priceUsd,
    liquidityUsd,
    ...(m5Change !== undefined ? { momentum5mBps: Math.round(m5Change * 100) } : {}),
    ...(h1Change !== undefined ? { priceChange1hPct: h1Change } : {}),
  });

  const provenance: DexScreenerCpmmMarketProvenance = Object.freeze({
    provider: "DEXSCREENER",
    pairAddress: target.poolAddress,
    chainId: "solana",
    dexId: "raydium",
    labels: Object.freeze([...labels]),
    onChainOrientation: poolState.orientation,
    dexScreenerOrientation: "TOKEN_BASE_WSOL_QUOTE",
    priceUnits: Object.freeze({
      priceNative: "SOL_PER_TOKEN",
      priceUsd: "USD_PER_TOKEN",
    }),
    creation: Object.freeze({
      pairCreatedAtMs: pairCreatedAt,
      openTimeSec,
      source: "DEXSCREENER_PAIR_CREATED_AT",
    }),
    onChainActivation: Object.freeze({
      swapActivationTimeSec: poolState.swapActivationTimeSec,
      source: "RAYDIUM_CPMM_OPEN_TIME",
    }),
    metricWindows: Object.freeze({
      providerRolling5m: "5m",
      strategyQualifiedFlowWindow: "UNCONNECTED",
    }),
    priceObservations: Object.freeze({
      spotPriceSolMarket: priceNative,
      spotPriceSolOnChainApprox: poolState.spotPriceSolApprox,
      comparisonPerformed: false,
    }),
    receivedAtMs,
    classifications: Object.freeze(classifications),
  });

  return Object.freeze({
    ok: true,
    pool,
    spot,
    provenance,
  });
}
