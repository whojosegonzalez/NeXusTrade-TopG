import { CandidateScannerEvaluator } from "./CandidateScannerEvaluator.js";
import type {
  CandidateScannerCandidate,
  CandidateScannerEvaluationResult,
  CandidateScannerFilterEvaluation,
  CandidateScannerRuntimeConfig,
  CandidateScannerStreamStats,
  ScannedPoolRecord,
} from "./CandidateScannerTypes.js";
import {
  evaluateLpScreeningBridge,
  isCanonicalSolanaBase58,
  projectBridgedLpPool,
  validateLpFreshnessPolicy,
  type LpBridgeScreeningResult,
  type LpFreshnessPolicy,
  type ValidatedLpEvidenceInput,
} from "./LpScreeningBridge.js";

const DEFAULT_RAYDIUM_POOLS_URL = "https://api-v3.raydium.io/pools/info/list";
const DEFAULT_DEXSCREENER_PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";

const BASE_QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export type LpEvidenceResolverFn = (
  candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
) => Promise<ValidatedLpEvidenceInput> | ValidatedLpEvidenceInput;

export interface CandidateLpEvidenceResolver {
  resolveLpEvidence(
    candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  ): Promise<ValidatedLpEvidenceInput> | ValidatedLpEvidenceInput;
}

export type LpEvidenceResolver = CandidateLpEvidenceResolver | LpEvidenceResolverFn;

function snapshotScannedPoolRecord(pool: ScannedPoolRecord): ScannedPoolRecord {
  return Object.freeze({
    poolId: pool.poolId,
    mintAddress: pool.mintAddress,
    symbol: pool.symbol,
    decimals: pool.decimals,
    baseMint: pool.baseMint,
    liquidityUsd: pool.liquidityUsd,
    marketCapUsd: pool.marketCapUsd,
    openTimeSec: pool.openTimeSec,
    lpBurnPct: pool.lpBurnPct,
    mintAuthority: pool.mintAuthority,
    freezeAuthority: pool.freezeAuthority,
    volume5mUsd: pool.volume5mUsd,
    txCount5m: pool.txCount5m,
    buys5m: pool.buys5m,
    sells5m: pool.sells5m,
    spotPriceUsd: pool.spotPriceUsd,
    spotPriceSol: pool.spotPriceSol,
    fetchedAt: pool.fetchedAt,
    metricProvenance: pool.metricProvenance
      ? Object.freeze({ ...pool.metricProvenance })
      : undefined,
    rawProviderLpBurnPct: pool.rawProviderLpBurnPct ?? pool.lpBurnPct,
  });
}

function buildRejectionDecisionPool(
  snapshotPool: ScannedPoolRecord,
  identities?: { canonicalPoolId: string; canonicalMint: string } | null,
): ScannedPoolRecord {
  return Object.freeze({
    ...snapshotPool,
    poolId: identities ? identities.canonicalPoolId : snapshotPool.poolId,
    mintAddress: identities ? identities.canonicalMint : snapshotPool.mintAddress,
    lpBurnPct: null,
    rawProviderLpBurnPct: snapshotPool.rawProviderLpBurnPct ?? snapshotPool.lpBurnPct,
    metricProvenance: Object.freeze({
      ...(snapshotPool.metricProvenance ?? {}),
      lpBurnPct: "UNAVAILABLE",
    }),
  });
}

export interface CandidateStreamEngineOptions {
  readonly config: CandidateScannerRuntimeConfig;
  readonly poolsApiUrl?: string | undefined;
  readonly dexScreenerApiUrl?: string | undefined;
  readonly enableDexScreener?: boolean | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly evaluator?: CandidateScannerEvaluator | undefined;
  readonly onCandidate?: ((candidate: CandidateScannerCandidate) => void) | undefined;
  readonly onDecision?:
    | ((evalResult: CandidateScannerEvaluationResult, pool: ScannedPoolRecord) => void)
    | undefined;

  /**
   * Explicitly enables validated-LP mode.
   * In this mode, every candidate must pass the accepted asynchronous LP-screening bridge
   * before LP-dependent admission can proceed.
   * Legacy provider percentages and placeholder values cannot bypass this gate.
   * MANDATORY for prospective PAPER execution.
   */
  readonly requireValidatedLp?: boolean | undefined;

  /**
   * Injected resolver providing validated LP evidence for candidate pools.
   */
  readonly lpEvidenceResolver?: LpEvidenceResolver | undefined;

  /**
   * Explicit freshness policy applied by the LP screening bridge.
   */
  readonly lpFreshnessPolicy?: LpFreshnessPolicy | undefined;
}

export class CandidateStreamEngine {
  private readonly config: CandidateScannerRuntimeConfig;
  private readonly poolsApiUrl: string;
  private readonly dexScreenerApiUrl: string;
  private readonly enableDexScreener: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly evaluator: CandidateScannerEvaluator;
  private readonly onCandidate: ((candidate: CandidateScannerCandidate) => void) | undefined;
  private readonly onDecision:
    | ((evalResult: CandidateScannerEvaluationResult, pool: ScannedPoolRecord) => void)
    | undefined;
  private readonly requireValidatedLp: boolean;
  private readonly lpEvidenceResolver?: LpEvidenceResolver | undefined;
  private readonly lpFreshnessPolicy?: LpFreshnessPolicy | undefined;
  private readonly seenMints = new Set<string>();

  public readonly stats: CandidateScannerStreamStats & {
    totalEvaluationsAttempted: number;
    decisionCallbackErrors: number;
  } = {
    scannedPools: 0,
    admittedCandidates: 0,
    rejectedMaturity: 0,
    rejectedLmc: 0,
    rejectedRug: 0,
    rejectedWashTrade: 0,
    errors: 0,
    totalEvaluationsAttempted: 0,
    decisionCallbackErrors: 0,
  };

  public getStats() {
    return this.stats;
  }

  private isRunning = false;
  private timerId: NodeJS.Timeout | null = null;

  constructor(options: CandidateStreamEngineOptions) {
    this.config = options.config;
    this.poolsApiUrl = options.poolsApiUrl ?? DEFAULT_RAYDIUM_POOLS_URL;
    this.dexScreenerApiUrl = options.dexScreenerApiUrl ?? DEFAULT_DEXSCREENER_PROFILES_URL;
    this.enableDexScreener = options.enableDexScreener ?? true;
    this.fetchImpl = options.fetchFn ?? fetch;
    this.evaluator = options.evaluator ?? new CandidateScannerEvaluator();
    this.onCandidate = options.onCandidate;
    this.onDecision = options.onDecision;
    this.requireValidatedLp = options.requireValidatedLp ?? false;
    this.lpEvidenceResolver = options.lpEvidenceResolver;
    this.lpFreshnessPolicy = options.lpFreshnessPolicy;

    if (this.requireValidatedLp && this.lpFreshnessPolicy !== undefined) {
      validateLpFreshnessPolicy(this.lpFreshnessPolicy);
    }
  }

  public isValidatedLpMode(): boolean {
    return this.requireValidatedLp;
  }

  /**
   * Resolves canonical Solana base58 identities for candidate pool and token mint.
   * Guarantees:
   * - Validates token mint is a valid 32-byte Solana base58 public key.
   * - Strips provider display prefixes (e.g. 'dexscreener-') only if the suffix is a valid distinct pool address.
   * - Rejects illegal token substitutions (e.g. 'dexscreener-${tokenAddress}').
   * - Returns null if canonical identities cannot be verified without substitution.
   */
  public resolveCanonicalIdentities(
    pool: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  ): { canonicalPoolId: string; canonicalMint: string } | null {
    const rawMint = typeof pool.mintAddress === "string" ? pool.mintAddress.trim() : "";
    if (!rawMint || !isCanonicalSolanaBase58(rawMint)) {
      return null;
    }

    const rawPoolId = typeof pool.poolId === "string" ? pool.poolId.trim() : "";
    if (!rawPoolId) {
      return null;
    }

    // Direct canonical Solana base58 pool address
    if (isCanonicalSolanaBase58(rawPoolId)) {
      if (rawPoolId === rawMint) {
        // Illegal substitution: token mint cannot substitute for pool address
        return null;
      }
      return { canonicalPoolId: rawPoolId, canonicalMint: rawMint };
    }

    // Provider display prefix handling (e.g. 'dexscreener-')
    if (rawPoolId.startsWith("dexscreener-")) {
      const suffix = rawPoolId.slice("dexscreener-".length).trim();
      // If suffix equals token mint, this was dexscreener-${tokenAddress} fallback (ghost/unindexed pair)
      if (suffix === rawMint) {
        return null;
      }
      if (isCanonicalSolanaBase58(suffix)) {
        return { canonicalPoolId: suffix, canonicalMint: rawMint };
      }
      return null;
    }

    // Any other unsupported prefix or non-base58 address
    return null;
  }

  private async invokeLpResolver(
    candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  ): Promise<{ ok: true; evidence: ValidatedLpEvidenceInput } | { ok: false; error: string }> {
    if (!this.lpEvidenceResolver) {
      return { ok: false, error: "Missing LP evidence resolver in validated-LP mode" };
    }
    try {
      let evidence: ValidatedLpEvidenceInput;
      if (typeof this.lpEvidenceResolver === "function") {
        evidence = await this.lpEvidenceResolver(candidate);
      } else {
        evidence = await this.lpEvidenceResolver.resolveLpEvidence(candidate);
      }
      if (evidence === null || evidence === undefined) {
        return { ok: false, error: "LP evidence resolver returned null or undefined" };
      }
      return { ok: true, evidence };
    } catch (err) {
      return {
        ok: false,
        error: `LP evidence resolver threw an exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public getSeenMintCount(): number {
    return this.seenMints.size;
  }

  public isMintSeen(mintAddress: string): boolean {
    return this.seenMints.has(mintAddress);
  }

  public markMintSeen(mintAddress: string): void {
    this.seenMints.add(mintAddress);
  }

  public async fetchRaydiumPools(
    pageSize: number = this.config.pageSize,
  ): Promise<ScannedPoolRecord[]> {
    const url = `${this.poolsApiUrl}?poolType=all&poolSortField=default&sortType=desc&pageSize=${pageSize}&page=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch pools: HTTP ${response.status}`);
      }

      const body = (await response.json()) as {
        data?: {
          data?: Array<{
            id?: string;
            openTime?: string | number;
            tvl?: number;
            burnPercent?: number;
            price?: number;
            mintA?: { address?: string; symbol?: string; decimals?: number };
            mintB?: { address?: string; symbol?: string; decimals?: number };
            day?: { volume?: number; volumeFee?: number };
          }>;
        };
      };

      const pools = body.data?.data ?? [];
      const nowIso = new Date().toISOString();
      const records: ScannedPoolRecord[] = [];

      for (const p of pools) {
        if (!p?.id || !p?.mintA?.address || !p?.mintB?.address) continue;

        const isBaseA = BASE_QUOTE_MINTS.has(p.mintA.address);
        const targetMint = isBaseA ? p.mintB : p.mintA;
        const baseMint = isBaseA ? p.mintA.address : p.mintB.address;

        if (!targetMint.address || BASE_QUOTE_MINTS.has(targetMint.address)) continue;

        const liquidityUsd = typeof p.tvl === "number" ? p.tvl : 0;
        const spotPriceUsd = typeof p.price === "number" ? p.price : 0;
        const marketCapUsd = liquidityUsd > 0 ? liquidityUsd * 4.5 : 0;

        const openTimeSec = Number(p.openTime) || 0;
        const lpBurnPct = typeof p.burnPercent === "number" ? p.burnPercent * 100 : 100;
        const dayVol = p.day?.volume ?? 0;
        const volume5mUsd = dayVol > 0 ? dayVol / 288 : 1000;
        const txCount5m = 30;
        const buys5m = 18;
        const sells5m = 12;

        const metricProvenance: Record<
          string,
          "OBSERVED" | "DERIVED" | "PLACEHOLDER" | "UNAVAILABLE"
        > = {
          tokenAgeSec: openTimeSec > 0 ? "OBSERVED" : "UNAVAILABLE",
          liquidityUsd: liquidityUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
          marketCapUsd: "DERIVED",
          lmcRatio: "DERIVED",
          lpBurnPct: typeof p.burnPercent === "number" ? "OBSERVED" : "PLACEHOLDER",
          spotPriceUsd: spotPriceUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
          volume5mUsd: dayVol > 0 ? "DERIVED" : "PLACEHOLDER",
          txCount5m: "PLACEHOLDER",
          buys5m: "PLACEHOLDER",
          sells5m: "PLACEHOLDER",
        };

        records.push({
          poolId: p.id,
          mintAddress: targetMint.address,
          symbol: targetMint.symbol ?? "UNKNOWN",
          decimals: targetMint.decimals ?? 6,
          baseMint,
          liquidityUsd,
          marketCapUsd,
          openTimeSec,
          lpBurnPct,
          mintAuthority: null,
          freezeAuthority: null,
          volume5mUsd,
          txCount5m,
          buys5m,
          sells5m,
          spotPriceUsd,
          fetchedAt: nowIso,
          metricProvenance,
        });
      }

      return records;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchDexScreenerTokenPair(tokenAddress: string): Promise<ScannedPoolRecord | null> {
    const tokensUrl = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 4000);

    try {
      const response = await this.fetchImpl(tokensUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) return null;

      const body = (await response.json()) as {
        pairs?: Array<{
          chainId?: string;
          pairAddress?: string;
          baseToken?: { address?: string; symbol?: string; name?: string };
          quoteToken?: { address?: string; symbol?: string; name?: string };
          priceNative?: string;
          priceUsd?: string;
          liquidity?: { usd?: number; quote?: number };
          fdv?: number;
          marketCap?: number;
          volume?: { m5?: number };
          txns?: { m5?: { buys?: number; sells?: number } };
          pairCreatedAt?: number;
        }>;
      };

      const pairs = body.pairs ?? [];
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return null;
      }

      // Find primary Solana pair (prefer SOL quote token or first active Solana pair)
      const solanaPairs = pairs.filter((p) => p.chainId === "solana" || !p.chainId);
      if (solanaPairs.length === 0) return null;

      const primaryPair =
        solanaPairs.find(
          (p) =>
            p.quoteToken?.symbol === "SOL" ||
            p.quoteToken?.address === "So11111111111111111111111111111111111111112",
        ) ?? solanaPairs[0];

      if (!primaryPair) return null;

      const liquidityUsd =
        typeof primaryPair.liquidity?.usd === "number" ? primaryPair.liquidity.usd : 0;
      const spotPriceUsd = primaryPair.priceUsd ? parseFloat(primaryPair.priceUsd) : 0;
      const parsedSpotPriceSol = primaryPair.priceNative
        ? parseFloat(primaryPair.priceNative)
        : null;
      const spotPriceSol =
        parsedSpotPriceSol !== null && Number.isFinite(parsedSpotPriceSol) && parsedSpotPriceSol > 0
          ? parsedSpotPriceSol
          : null;

      // Discard ghost tokens with zero liquidity or missing/non-positive price
      if (liquidityUsd <= 0 || !Number.isFinite(spotPriceUsd) || spotPriceUsd <= 0) {
        return null;
      }

      const isMarketCapObserved =
        typeof primaryPair.marketCap === "number" && primaryPair.marketCap > 0;
      const isMarketCapFdv =
        !isMarketCapObserved && typeof primaryPair.fdv === "number" && primaryPair.fdv > 0;
      const marketCapUsd = isMarketCapObserved
        ? primaryPair.marketCap!
        : isMarketCapFdv
          ? primaryPair.fdv!
          : liquidityUsd * 4.5;

      const nowSec = Math.floor(Date.now() / 1000);
      const isOpenTimeObserved = !!primaryPair.pairCreatedAt;
      const openTimeSec = isOpenTimeObserved
        ? Math.floor(primaryPair.pairCreatedAt! / 1000)
        : nowSec - 450;

      const hasVolume5m = typeof primaryPair.volume?.m5 === "number";
      const volume5mUsd = hasVolume5m ? primaryPair.volume!.m5! : 0;

      const hasBuys5m = primaryPair.txns?.m5?.buys !== undefined;
      const hasSells5m = primaryPair.txns?.m5?.sells !== undefined;
      const buys5m = hasBuys5m ? primaryPair.txns!.m5!.buys! : 0;
      const sells5m = hasSells5m ? primaryPair.txns!.m5!.sells! : 0;
      const txCount5m = buys5m + sells5m;

      const symbol = primaryPair.baseToken?.symbol?.trim() || "UNKNOWN";
      const baseMint =
        primaryPair.quoteToken?.address ?? "So11111111111111111111111111111111111111112";

      const metricProvenance: Record<
        string,
        "OBSERVED" | "DERIVED" | "PLACEHOLDER" | "UNAVAILABLE"
      > = {
        tokenAgeSec: isOpenTimeObserved ? "OBSERVED" : "PLACEHOLDER",
        liquidityUsd: "OBSERVED",
        marketCapUsd: isMarketCapObserved ? "OBSERVED" : "DERIVED",
        lmcRatio: "DERIVED",
        lpBurnPct: "PLACEHOLDER",
        spotPriceUsd: primaryPair.priceUsd ? "OBSERVED" : "UNAVAILABLE",
        spotPriceSol: spotPriceSol !== null ? "OBSERVED" : "UNAVAILABLE",
        volume5mUsd: hasVolume5m ? "OBSERVED" : "UNAVAILABLE",
        txCount5m: hasBuys5m || hasSells5m ? "OBSERVED" : "UNAVAILABLE",
        buys5m: hasBuys5m ? "OBSERVED" : "UNAVAILABLE",
        sells5m: hasSells5m ? "OBSERVED" : "UNAVAILABLE",
      };

      return {
        poolId: primaryPair.pairAddress
          ? `dexscreener-${primaryPair.pairAddress}`
          : `dexscreener-${tokenAddress}`,
        mintAddress: tokenAddress,
        symbol,
        decimals: 9,
        baseMint,
        liquidityUsd,
        marketCapUsd,
        openTimeSec,
        lpBurnPct: 100.0,
        mintAuthority: null,
        freezeAuthority: null,
        volume5mUsd,
        txCount5m,
        buys5m,
        sells5m,
        spotPriceUsd,
        spotPriceSol,
        fetchedAt: new Date().toISOString(),
        metricProvenance,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchDexScreenerPools(): Promise<ScannedPoolRecord[]> {
    if (!this.enableDexScreener) return [];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await this.fetchImpl(this.dexScreenerApiUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) return [];

      const profiles = (await response.json()) as Array<{
        url?: string;
        chainId?: string;
        tokenAddress?: string;
        icon?: string;
        description?: string;
      }>;

      if (!Array.isArray(profiles)) return [];

      const solanaTokens = profiles
        .filter((item) => (item.chainId === "solana" || !item.chainId) && !!item.tokenAddress)
        .map((item) => item.tokenAddress!);

      if (solanaTokens.length === 0) return [];

      // Query token pair data for each profile to eliminate ghost tokens without liquidity
      const records: ScannedPoolRecord[] = [];
      const pairPromises = solanaTokens
        .slice(0, 10)
        .map((addr) => this.fetchDexScreenerTokenPair(addr));
      const pairResults = await Promise.allSettled(pairPromises);

      for (const res of pairResults) {
        if (res.status === "fulfilled" && res.value !== null) {
          records.push(res.value);
        }
      }

      return records;
    } catch {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchDexScreenerBoostedPools(): Promise<ScannedPoolRecord[]> {
    if (!this.enableDexScreener) return [];
    const urls = [
      "https://api.dexscreener.com/token-boosts/top/v1",
      "https://api.dexscreener.com/token-boosts/latest/v1",
    ];

    const tokenAddresses = new Set<string>();
    await Promise.allSettled(
      urls.map(async (url) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        try {
          const res = await this.fetchImpl(url, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return;
          const body = (await res.json()) as Array<{ chainId?: string; tokenAddress?: string }>;
          if (!Array.isArray(body)) return;
          for (const item of body) {
            if ((item.chainId === "solana" || !item.chainId) && item.tokenAddress) {
              tokenAddresses.add(item.tokenAddress);
            }
          }
        } catch {
          // ignore transient failure
        } finally {
          clearTimeout(timeoutId);
        }
      }),
    );

    if (tokenAddresses.size === 0) return [];

    const records: ScannedPoolRecord[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const candidates = Array.from(tokenAddresses).slice(0, 15);
    const pairPromises = candidates.map((addr) => this.fetchDexScreenerTokenPair(addr));
    const pairResults = await Promise.allSettled(pairPromises);

    for (const res of pairResults) {
      if (res.status === "fulfilled" && res.value !== null) {
        const pool = res.value;
        const ageSec = Math.max(0, nowSec - pool.openTimeSec);
        // Established Runner criteria: 2h (7200s) to 24h (86400s), >= $40k liquidity, >= $100k market cap
        if (
          pool.liquidityUsd >= 40000 &&
          pool.marketCapUsd >= 100000 &&
          ageSec >= 7200 &&
          ageSec <= 86400
        ) {
          records.push(pool);
        }
      }
    }

    return records;
  }

  public async fetchRaydiumTopTradedPools(pageSize: number = 50): Promise<ScannedPoolRecord[]> {
    const url = `${this.poolsApiUrl}?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=${pageSize}&page=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        return [];
      }

      const body = (await response.json()) as {
        data?: {
          data?: Array<{
            id?: string;
            openTime?: string | number;
            tvl?: number;
            burnPercent?: number;
            price?: number;
            mintA?: { address?: string; symbol?: string; decimals?: number };
            mintB?: { address?: string; symbol?: string; decimals?: number };
            day?: { volume?: number; volumeFee?: number };
          }>;
        };
      };

      const pools = body.data?.data ?? [];
      const nowIso = new Date().toISOString();
      const records: ScannedPoolRecord[] = [];

      for (const p of pools) {
        if (!p?.id || !p?.mintA?.address || !p?.mintB?.address) continue;

        const isBaseA = BASE_QUOTE_MINTS.has(p.mintA.address);
        const targetMint = isBaseA ? p.mintB : p.mintA;
        const baseMint = isBaseA ? p.mintA.address : p.mintB.address;

        if (!targetMint.address || BASE_QUOTE_MINTS.has(targetMint.address)) continue;

        const liquidityUsd = typeof p.tvl === "number" ? p.tvl : 0;
        const spotPriceUsd = typeof p.price === "number" ? p.price : 0;
        const marketCapUsd = liquidityUsd > 0 ? liquidityUsd * 4.5 : 0;

        const openTimeSec = Number(p.openTime) || 0;
        const lpBurnPct = typeof p.burnPercent === "number" ? p.burnPercent * 100 : 100;
        const dayVol = p.day?.volume ?? 0;
        const volume5mUsd = dayVol > 0 ? dayVol / 288 : 1000;
        const txCount5m = 30;
        const buys5m = 18;
        const sells5m = 12;

        const metricProvenance: Record<
          string,
          "OBSERVED" | "DERIVED" | "PLACEHOLDER" | "UNAVAILABLE"
        > = {
          tokenAgeSec: openTimeSec > 0 ? "OBSERVED" : "UNAVAILABLE",
          liquidityUsd: liquidityUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
          marketCapUsd: "DERIVED",
          lmcRatio: "DERIVED",
          lpBurnPct: typeof p.burnPercent === "number" ? "OBSERVED" : "PLACEHOLDER",
          spotPriceUsd: spotPriceUsd > 0 ? "OBSERVED" : "UNAVAILABLE",
          volume5mUsd: dayVol > 0 ? "DERIVED" : "PLACEHOLDER",
          txCount5m: "PLACEHOLDER",
          buys5m: "PLACEHOLDER",
          sells5m: "PLACEHOLDER",
        };

        records.push({
          poolId: p.id,
          mintAddress: targetMint.address,
          symbol: targetMint.symbol ?? "UNKNOWN",
          decimals: targetMint.decimals ?? 6,
          baseMint,
          liquidityUsd,
          marketCapUsd,
          openTimeSec,
          lpBurnPct,
          mintAuthority: null,
          freezeAuthority: null,
          volume5mUsd,
          txCount5m,
          buys5m,
          sells5m,
          spotPriceUsd,
          fetchedAt: nowIso,
          metricProvenance,
        });
      }

      return records;
    } catch {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchDexScreenerRecentUpdates(): Promise<ScannedPoolRecord[]> {
    if (!this.enableDexScreener) return [];
    const url = "https://api.dexscreener.com/token-profiles/recent-updates/v1";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) return [];

      const profiles = (await response.json()) as Array<{
        url?: string;
        chainId?: string;
        tokenAddress?: string;
        icon?: string;
        description?: string;
      }>;

      if (!Array.isArray(profiles)) return [];

      const solanaTokens = profiles
        .filter((item) => (item.chainId === "solana" || !item.chainId) && !!item.tokenAddress)
        .map((item) => item.tokenAddress!);

      if (solanaTokens.length === 0) return [];

      const records: ScannedPoolRecord[] = [];
      const pairPromises = solanaTokens
        .slice(0, 10)
        .map((addr) => this.fetchDexScreenerTokenPair(addr));
      const pairResults = await Promise.allSettled(pairPromises);

      for (const res of pairResults) {
        if (res.status === "fulfilled" && res.value !== null) {
          records.push(res.value);
        }
      }

      return records;
    } catch {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchRawPools(
    pageSize: number = this.config.pageSize,
  ): Promise<ScannedPoolRecord[]> {
    let raydiumError: unknown = null;
    let raydiumPools: ScannedPoolRecord[] = [];
    try {
      raydiumPools = await this.fetchRaydiumPools(pageSize);
    } catch (err) {
      raydiumError = err;
    }

    let topTradedPools: ScannedPoolRecord[] = [];
    try {
      topTradedPools = await this.fetchRaydiumTopTradedPools(pageSize);
    } catch {
      topTradedPools = [];
    }

    let dexPools: ScannedPoolRecord[] = [];
    try {
      dexPools = await this.fetchDexScreenerPools();
    } catch {
      dexPools = [];
    }

    let recentUpdatePools: ScannedPoolRecord[] = [];
    try {
      recentUpdatePools = await this.fetchDexScreenerRecentUpdates();
    } catch {
      recentUpdatePools = [];
    }

    let boostedPools: ScannedPoolRecord[] = [];
    try {
      boostedPools = await this.fetchDexScreenerBoostedPools();
    } catch {
      boostedPools = [];
    }

    if (
      raydiumError &&
      topTradedPools.length === 0 &&
      dexPools.length === 0 &&
      recentUpdatePools.length === 0 &&
      boostedPools.length === 0
    ) {
      throw raydiumError;
    }

    const seenPoolMints = new Set<string>();
    const combined: ScannedPoolRecord[] = [];

    for (const pool of [
      ...raydiumPools,
      ...topTradedPools,
      ...dexPools,
      ...recentUpdatePools,
      ...boostedPools,
    ]) {
      if (!seenPoolMints.has(pool.mintAddress)) {
        seenPoolMints.add(pool.mintAddress);
        combined.push(pool);
      }
    }

    return combined;
  }

  public async evaluatePoolAsync(
    pool: ScannedPoolRecord,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<CandidateScannerEvaluationResult> {
    this.stats.scannedPools++;
    this.stats.totalEvaluationsAttempted++;

    // ------------------------------------------------------------------------
    // 0. Capture immutable evaluation inputs before awaiting
    // ------------------------------------------------------------------------
    const snapshotPool = snapshotScannedPoolRecord(pool);
    const snapshotPolicy = this.lpFreshnessPolicy
      ? Object.freeze({ ...this.lpFreshnessPolicy })
      : undefined;

    if (!this.requireValidatedLp) {
      return this.evaluatePoolLegacy(snapshotPool, nowSec);
    }

    // ------------------------------------------------------------------------
    // VALIDATED-LP INTAKE PIPELINE
    // ------------------------------------------------------------------------

    // 1. Identity Resolution & Boundary Verification
    const identities = this.resolveCanonicalIdentities(snapshotPool);
    if (!identities) {
      const filterEvaluation: CandidateScannerFilterEvaluation = {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_INVALID_POOL_METADATA",
        details: {
          status: "UNAVAILABLE",
          reason:
            "Candidate poolId or mintAddress is not a verified canonical Solana base58 identity, or illegal pool substitution detected",
          poolId: snapshotPool.poolId,
          mintAddress: snapshotPool.mintAddress,
        },
      };

      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, null);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: "REJECTED_INVALID_POOL_METADATA",
          filterEvaluations: [filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    // 2. Freshness Policy Verification
    if (!snapshotPolicy) {
      const filterEvaluation: CandidateScannerFilterEvaluation = {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_INVALID_POOL_METADATA",
        details: {
          status: "UNAVAILABLE",
          reason: "Missing LpFreshnessPolicy in validated-LP mode",
        },
      };

      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, identities);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: "REJECTED_INVALID_POOL_METADATA",
          filterEvaluations: [filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    // 3. Resolve LP Evidence via Injected Resolver
    const candidateIdentity = {
      poolId: identities.canonicalPoolId,
      mintAddress: identities.canonicalMint,
    };

    const resolveResult = await this.invokeLpResolver(candidateIdentity);
    if (
      !resolveResult.ok ||
      resolveResult.evidence === null ||
      resolveResult.evidence === undefined
    ) {
      const filterEvaluation: CandidateScannerFilterEvaluation = {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_UNLOCKED_LP_RISK",
        details: {
          status: "UNAVAILABLE",
          reason: resolveResult.ok
            ? "LP evidence resolver returned null or undefined"
            : resolveResult.error,
        },
      };

      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, identities);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: "REJECTED_UNLOCKED_LP_RISK",
          filterEvaluations: [filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    // 4. Asynchronous Evaluation via Accepted LP Bridge (Always runs accepted bridge; gate overrides removed)
    let bridgeResult: LpBridgeScreeningResult;
    try {
      bridgeResult = await evaluateLpScreeningBridge(
        candidateIdentity,
        resolveResult.evidence,
        snapshotPolicy,
      );
    } catch (bridgeErr) {
      const filterEvaluation: CandidateScannerFilterEvaluation = {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_UNLOCKED_LP_RISK",
        details: {
          status: "INVALID_EVIDENCE",
          reason: `LP bridge evaluation threw an unexpected error: ${bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)}`,
        },
      };

      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, identities);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: "REJECTED_UNLOCKED_LP_RISK",
          filterEvaluations: [filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    // 5. Projection Guard
    const canonicalPoolRecord: ScannedPoolRecord = {
      ...snapshotPool,
      poolId: identities.canonicalPoolId,
      mintAddress: identities.canonicalMint,
    };

    let projection: ReturnType<typeof projectBridgedLpPool>;
    try {
      projection = projectBridgedLpPool(canonicalPoolRecord, bridgeResult);
    } catch (projErr) {
      const filterEvaluation: CandidateScannerFilterEvaluation = {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_UNLOCKED_LP_RISK",
        details: {
          status: "INVALID_EVIDENCE",
          reason: `LP bridge projection threw an unexpected error: ${projErr instanceof Error ? projErr.message : String(projErr)}`,
        },
      };

      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, identities);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: "REJECTED_UNLOCKED_LP_RISK",
          filterEvaluations: [filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    // 6. Handle Non-Passing LP Bridge Outcomes
    if (!projection.ok) {
      if (projection.status === "AVAILABLE_BELOW_THRESHOLD") {
        // Observed measurement below 90% threshold (e.g. RAY/WSOL with 0.135682%)
        return this.recordRejection(
          {
            admitted: false,
            primaryRejectionReason: "REJECTED_UNLOCKED_LP_RISK",
            filterEvaluations: [bridgeResult.filterEvaluation],
          },
          projection.pool, // Preserves DERIVED lpBurnPct: 0.135682% and rawProviderLpBurnPct
        );
      }

      // Unavailable, Stale, Invalid, or Mismatched evidence
      // Respect null pool projection: DO NOT manufacture a numeric LP value
      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, identities);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: projection.failureReason,
          filterEvaluations: [bridgeResult.filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    // 7. LP Bridge Passed (AVAILABLE_QUALIFIED) -> Continue with Remaining Checks
    // A passing LP filter only permits the existing remaining checks to continue.
    // It must not bypass authority, maturity, liquidity, flow, risk, retest, sizing, or execution checks.
    const remainingEval = this.evaluator.evaluate(projection.pool, this.config, nowSec);

    if (!remainingEval.admitted) {
      // One of the remaining checks failed (e.g. maturity, mint authority, freeze authority, L/MC, flow)
      const combinedFilters: CandidateScannerFilterEvaluation[] = [
        bridgeResult.filterEvaluation,
        ...remainingEval.filterEvaluations.filter(
          (f) =>
            f.filterName !== "ANTI_RUG_LP_SECURITY" && f.filterName !== "ANTI_RUG_AUTHORITY_AND_LP",
        ),
      ];

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: remainingEval.primaryRejectionReason,
          filterEvaluations: combinedFilters,
        },
        projection.pool,
      );
    }

    // 8. All Checks Passed -> Admit Candidate
    const combinedFilters: CandidateScannerFilterEvaluation[] = [
      bridgeResult.filterEvaluation,
      ...remainingEval.filterEvaluations.filter(
        (f) =>
          f.filterName !== "ANTI_RUG_LP_SECURITY" && f.filterName !== "ANTI_RUG_AUTHORITY_AND_LP",
      ),
    ];

    const admittedCandidate: CandidateScannerCandidate = {
      ...remainingEval.candidate!,
      canonicalMint: identities.canonicalMint,
      lpBurnPct: projection.lpBurnPct,
      metricProvenance: {
        ...(remainingEval.candidate?.metricProvenance ?? {}),
        lpBurnPct: "DERIVED",
      },
      filterEvaluations: combinedFilters,
    };

    const finalResult: CandidateScannerEvaluationResult = {
      admitted: true,
      candidate: admittedCandidate,
      filterEvaluations: combinedFilters,
    };

    this.stats.admittedCandidates++;
    this.seenMints.add(identities.canonicalMint);

    if (this.onDecision) {
      try {
        this.onDecision(finalResult, projection.pool);
      } catch (err) {
        this.stats.decisionCallbackErrors++;
        console.error("[CandidateStreamEngine] onDecision error:", err);
      }
    }

    if (this.onCandidate) {
      this.onCandidate(admittedCandidate);
    }

    return finalResult;
  }

  private recordRejection(
    evalResult: CandidateScannerEvaluationResult,
    pool: ScannedPoolRecord,
  ): CandidateScannerEvaluationResult {
    switch (evalResult.primaryRejectionReason) {
      case "REJECTED_OUTSIDE_MATURITY_WINDOW":
        this.stats.rejectedMaturity++;
        break;
      case "REJECTED_IMBALANCED_LIQUIDITY_DEPTH":
        this.stats.rejectedLmc++;
        break;
      case "REJECTED_UNLOCKED_LP_RISK":
      case "REJECTED_ACTIVE_MINT_AUTHORITY":
      case "REJECTED_ACTIVE_FREEZE_AUTHORITY":
      case "REJECTED_INVALID_POOL_METADATA":
        this.stats.rejectedRug++;
        break;
      case "REJECTED_INSUFFICIENT_TRANSACTION_COUNT":
      case "REJECTED_WASH_TRADE_SIZE_ANOMALY":
      case "REJECTED_NET_SELLER_DOMINANCE":
        this.stats.rejectedWashTrade++;
        break;
      default:
        break;
    }

    if (this.onDecision) {
      try {
        this.onDecision(evalResult, pool);
      } catch (err) {
        this.stats.decisionCallbackErrors++;
        console.error("[CandidateStreamEngine] onDecision error:", err);
      }
    }

    return evalResult;
  }

  private evaluatePoolLegacy(
    pool: ScannedPoolRecord,
    nowSec: number,
  ): CandidateScannerEvaluationResult {
    const evalResult = this.evaluator.evaluate(pool, this.config, nowSec);

    if (this.onDecision) {
      try {
        this.onDecision(evalResult, pool);
      } catch (err) {
        this.stats.decisionCallbackErrors++;
        console.error("[CandidateStreamEngine] onDecision error:", err);
      }
    }

    if (evalResult.admitted && evalResult.candidate) {
      this.stats.admittedCandidates++;
      this.seenMints.add(pool.mintAddress);
      if (this.onCandidate) {
        this.onCandidate(evalResult.candidate);
      }
    } else {
      switch (evalResult.primaryRejectionReason) {
        case "REJECTED_OUTSIDE_MATURITY_WINDOW":
          this.stats.rejectedMaturity++;
          break;
        case "REJECTED_IMBALANCED_LIQUIDITY_DEPTH":
          this.stats.rejectedLmc++;
          break;
        case "REJECTED_UNLOCKED_LP_RISK":
        case "REJECTED_ACTIVE_MINT_AUTHORITY":
        case "REJECTED_ACTIVE_FREEZE_AUTHORITY":
        case "REJECTED_INVALID_POOL_METADATA":
          this.stats.rejectedRug++;
          break;
        case "REJECTED_INSUFFICIENT_TRANSACTION_COUNT":
        case "REJECTED_WASH_TRADE_SIZE_ANOMALY":
        case "REJECTED_NET_SELLER_DOMINANCE":
          this.stats.rejectedWashTrade++;
          break;
        default:
          break;
      }
    }

    return evalResult;
  }

  public evaluatePool(
    pool: ScannedPoolRecord,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): CandidateScannerEvaluationResult {
    this.stats.scannedPools++;
    this.stats.totalEvaluationsAttempted++;

    const snapshotPool = snapshotScannedPoolRecord(pool);

    if (this.requireValidatedLp) {
      // In validated-LP mode, synchronous evaluation cannot validate LP evidence and must fail closed.
      const identities = this.resolveCanonicalIdentities(snapshotPool);
      const filterEvaluation: CandidateScannerFilterEvaluation = {
        filterName: "ANTI_RUG_LP_SECURITY",
        passed: false,
        reason: "REJECTED_UNLOCKED_LP_RISK",
        details: {
          status: "UNAVAILABLE",
          reason:
            "Synchronous evaluation cannot validate LP evidence; async evaluatePoolAsync() is required in validated-LP mode",
        },
      };

      const rejectionDecisionPool = buildRejectionDecisionPool(snapshotPool, identities);

      return this.recordRejection(
        {
          admitted: false,
          primaryRejectionReason: "REJECTED_UNLOCKED_LP_RISK",
          filterEvaluations: [filterEvaluation],
        },
        rejectionDecisionPool,
      );
    }

    return this.evaluatePoolLegacy(snapshotPool, nowSec);
  }

  public async scanOnce(
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<readonly CandidateScannerEvaluationResult[]> {
    let poolRecords: ScannedPoolRecord[];
    try {
      poolRecords = await this.fetchRawPools();
    } catch {
      this.stats.errors++;
      return [];
    }

    const results: CandidateScannerEvaluationResult[] = [];

    for (const pool of poolRecords) {
      if (this.seenMints.has(pool.mintAddress)) {
        continue;
      }
      try {
        results.push(await this.evaluatePoolAsync(pool, nowSec));
      } catch (err) {
        this.stats.errors++;
        console.error("[CandidateStreamEngine] Unexpected error evaluating pool:", err);
      }
    }

    return results;
  }

  public startStream(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.scanOnce();
      } catch {
        this.stats.errors++;
      }

      if (this.isRunning) {
        this.timerId = setTimeout(loop, this.config.pollIntervalMs);
      }
    };

    void loop();
  }

  public stopStream(): void {
    this.isRunning = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
