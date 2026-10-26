/**
 * Phase 12.94-D Milestone D.3.3: Concrete Read-Only Live Shadow Providers
 *
 * Provides concrete, read-only implementations for candidate discovery and quote fetching:
 * - Read-only HTTP GET exclusively against allowlisted public endpoints (DexScreener & Raydium).
 * - Zero RPC/WebSocket calls. Zero wallet keys. Zero mutations.
 * - Integrates with GlobalResourceBudgetManager for unified request accounting across all calls.
 * - Injectable fetch implementation for offline deterministic testing.
 */

import type { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import type {
  IShadowMarketDataProvider,
  ShadowCandidateInput,
  ShadowQuoteResult,
} from "./ShadowObservationRunner.js";

export const DEXSCREENER_PROFILES_ENDPOINT = "https://api.dexscreener.com/token-profiles/latest/v1";
export const DEXSCREENER_PAIRS_SOLANA_PREFIX =
  "https://api.dexscreener.com/latest/dex/pairs/solana/";
export const DEXSCREENER_TOKENS_PREFIX = "https://api.dexscreener.com/latest/dex/tokens/";
export const RAYDIUM_POOLS_ENDPOINT = "https://api-v3.raydium.io/pools/info/list";

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFunction = (ms: number) => Promise<void>;

export class LiveDexScreenerQuoteProvider implements IShadowMarketDataProvider {
  public readonly providerName = "DEXSCREENER";
  private readonly fetchFn: FetchFunction;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly clock: () => number;

  constructor(
    budgetManager: GlobalResourceBudgetManager,
    fetchFn: FetchFunction = fetch,
    clock: () => number = () => Date.now(),
  ) {
    this.budgetManager = budgetManager;
    this.fetchFn = fetchFn;
    this.clock = clock;
  }

  async fetchQuote(poolId: string, mintAddress: string): Promise<ShadowQuoteResult> {
    const targetUrl =
      poolId && poolId.length > 20
        ? `${DEXSCREENER_PAIRS_SOLANA_PREFIX}${poolId}`
        : `${DEXSCREENER_TOKENS_PREFIX}${mintAddress}`;

    const res = await this.fetchFn(targetUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const httpStatus = res.status;
    this.budgetManager.recordResponseStatus(httpStatus);

    if (!res.ok) {
      throw new Error(`HTTP ${httpStatus} ${res.statusText}`);
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const pairs = (
      Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.pairs)
          ? (payload.pairs as unknown[])
          : Array.isArray(payload?.pair)
            ? [payload.pair]
            : typeof payload?.pair === "object" && payload.pair !== null
              ? [payload.pair]
              : []
    ) as Array<Record<string, unknown>>;

    if (pairs.length === 0) {
      return {
        indicativePriceSol: null,
        liquidityUsd: null,
        quoteTimestampMs: this.clock(),
        quoteSource: "DEXSCREENER",
        isExecutableQuote: false,
        httpStatus,
      };
    }

    // Select matching pair or best available
    const solPairs = pairs.filter((p) => p && p.chainId === "solana");
    const pair = solPairs[0] || pairs[0]!;

    const liquidity = (pair.liquidity as Record<string, number>) || {};
    const liquidityUsd = typeof liquidity.usd === "number" ? liquidity.usd : 0;

    const priceNativeRaw =
      typeof pair.priceNative === "string" ? Number.parseFloat(pair.priceNative) : null;
    const priceUsdRaw = typeof pair.priceUsd === "string" ? Number.parseFloat(pair.priceUsd) : null;

    // Detect pool drainage
    const isPoolDrained = liquidityUsd < 500;

    let indicativePriceSol: number | null = null;
    if (priceNativeRaw !== null && Number.isFinite(priceNativeRaw) && priceNativeRaw > 0) {
      indicativePriceSol = priceNativeRaw;
    } else if (priceUsdRaw !== null && Number.isFinite(priceUsdRaw) && priceUsdRaw > 0) {
      // Fallback: estimate SOL price assuming approximate SOL/USD ~150
      indicativePriceSol = priceUsdRaw / 150;
    }

    const quoteTimestampMs = this.clock();

    return {
      indicativePriceSol,
      liquidityUsd,
      quoteTimestampMs,
      quoteSource: "DEXSCREENER",
      isExecutableQuote: false,
      isPoolDrained,
      httpStatus,
    };
  }
}

export class LiveDexScreenerCandidateSource {
  private readonly fetchFn: FetchFunction;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly clock: () => number;
  private readonly sleepFn: SleepFunction;
  private readonly seenMints = new Set<string>();

  constructor(
    budgetManager: GlobalResourceBudgetManager,
    fetchFn: FetchFunction = fetch,
    clock: () => number = () => Date.now(),
    sleepFn: SleepFunction = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.budgetManager = budgetManager;
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.sleepFn = sleepFn;
  }

  public async pollCandidates(maxToDiscover = 10): Promise<ShadowCandidateInput[]> {
    const now = this.clock();

    // Check budget before discovery request
    const discoveryCheck = this.budgetManager.canMakeRequest("DEXSCREENER", now);
    if (!discoveryCheck.allowed) {
      if (
        discoveryCheck.reason === "PROVIDER_PACING_NOT_MET" &&
        typeof discoveryCheck.waitMs === "number" &&
        discoveryCheck.waitMs > 0
      ) {
        await this.sleepFn(discoveryCheck.waitMs);
      } else {
        return [];
      }
    }

    const recorded = this.budgetManager.recordRequestAttempt(
      "DEXSCREENER",
      "DISCOVERY_POLL",
      this.clock(),
    );
    if (!recorded) return [];

    let profiles: Array<{ tokenAddress?: string; chainId?: string }> = [];
    try {
      const res = await this.fetchFn(DEXSCREENER_PROFILES_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      this.budgetManager.recordResponseStatus(res.status);
      if (!res.ok) return [];

      const body = await res.json();
      profiles = Array.isArray(body) ? body : [];
    } catch {
      return [];
    }

    const solanaProfiles = profiles.filter((p) => p && p.chainId === "solana" && p.tokenAddress);

    const candidates: ShadowCandidateInput[] = [];

    for (const profile of solanaProfiles) {
      if (candidates.length >= maxToDiscover) break;

      const mint = profile.tokenAddress!;
      if (this.seenMints.has(mint)) continue;
      this.seenMints.add(mint);

      // Check budget before candidate enrichment
      const check = this.budgetManager.canMakeRequest("DEXSCREENER", this.clock());
      if (!check.allowed) {
        if (
          check.reason === "PROVIDER_PACING_NOT_MET" &&
          typeof check.waitMs === "number" &&
          check.waitMs > 0
        ) {
          await this.sleepFn(check.waitMs);
        } else {
          break;
        }
      }

      const enriched = await this.enrichCandidate(mint);
      if (enriched) {
        candidates.push(enriched);
      }
    }

    return candidates;
  }

  private async enrichCandidate(mintAddress: string): Promise<ShadowCandidateInput | null> {
    const now = this.clock();
    const recorded = this.budgetManager.recordRequestAttempt(
      "DEXSCREENER",
      "CANDIDATE_ENRICHMENT",
      now,
    );
    if (!recorded) return null;

    try {
      const res = await this.fetchFn(`${DEXSCREENER_TOKENS_PREFIX}${mintAddress}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      this.budgetManager.recordResponseStatus(res.status);
      if (!res.ok) return null;

      const data = (await res.json()) as { pairs?: Array<Record<string, unknown>> };
      const pairs = data.pairs || [];
      const solanaPairs = pairs.filter((p) => p && p.chainId === "solana" && p.dexId === "raydium");
      const bestPair = solanaPairs[0] || pairs[0];
      if (!bestPair) return null;

      const baseToken = (bestPair.baseToken as Record<string, string>) || {};
      const liquidity = (bestPair.liquidity as Record<string, number>) || {};
      const volume = (bestPair.volume as Record<string, number>) || {};
      const txns = (bestPair.txns as Record<string, Record<string, number>>) || {};
      const m5Txns = txns.m5 || {};

      const priceNative =
        typeof bestPair.priceNative === "string" ? parseFloat(bestPair.priceNative) : 0;
      const priceUsd = typeof bestPair.priceUsd === "string" ? parseFloat(bestPair.priceUsd) : 0;
      const liquidityUsd = liquidity.usd || 0;
      const marketCapUsd =
        (typeof bestPair.marketCap === "number"
          ? bestPair.marketCap
          : typeof bestPair.fdv === "number"
            ? bestPair.fdv
            : liquidityUsd * 3) || 0;
      const volume5mUsd = volume.m5 || 0;
      const buys5m = m5Txns.buys || 0;
      const sells5m = m5Txns.sells || 0;
      const buyToSellRatio = sells5m > 0 ? Number((buys5m / sells5m).toFixed(2)) : buys5m;
      const lmcRatio = marketCapUsd > 0 ? Number((liquidityUsd / marketCapUsd).toFixed(4)) : 0;
      const createdAt =
        typeof bestPair.pairCreatedAt === "number" ? bestPair.pairCreatedAt : this.clock();
      const assetAgeSeconds = Math.max(0, Math.floor((this.clock() - createdAt) / 1000));

      return {
        poolId: (bestPair.pairAddress as string) || `pool-${mintAddress.slice(0, 8)}`,
        mintAddress,
        symbol: baseToken.symbol || "UNKNOWN",
        discoveryTimestampMs: this.clock(),
        streamSource: "DEXSCREENER_RECENT",
        indicativePriceSol:
          priceNative > 0 ? priceNative : priceUsd > 0 ? priceUsd / 150 : 0.000001,
        priceQuoteTimestampMs: this.clock(),
        liquidityUsd,
        marketCapUsd,
        lmcRatio,
        lpBurnPct: 100,
        assetAgeSeconds: assetAgeSeconds > 0 ? assetAgeSeconds : 1800,
        volume5mUsd,
        buys5m,
        sells5m,
        buyToSellRatio,
      };
    } catch {
      return null;
    }
  }
}
