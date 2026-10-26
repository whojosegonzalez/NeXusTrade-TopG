/**
 * Phase 12.94-D Milestone D.3.3: Concrete Read-Only Live Shadow Providers
 *
 * Provides concrete, read-only implementations for candidate discovery and quote fetching:
 * - Read-only HTTP GET exclusively against allowlisted public endpoints (DexScreener & Raydium).
 * - Zero RPC/WebSocket calls. Zero wallet keys. Zero mutations.
 * - Integrates with GlobalResourceBudgetManager for unified request accounting across all calls.
 * - Strict data integrity: ZERO fabricated market inputs (no default lpBurn, no liquidity*3 mcap,
 *   no fake age, no $150/SOL conversions). Absent inputs preserved truthfully as null with provenance.
 * - Pool and token denomination validation: exact pair matching, WSOL quote verification.
 * - Injectable fetch implementation and abort timeout for offline deterministic testing.
 */

import crypto from "node:crypto";
import type { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import type {
  IShadowMarketDataProvider,
  ShadowCandidateInput,
  ShadowQuoteResult,
} from "./ShadowObservationRunner.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DEXSCREENER_PROFILES_ENDPOINT = "https://api.dexscreener.com/token-profiles/latest/v1";
export const DEXSCREENER_PAIRS_SOLANA_PREFIX =
  "https://api.dexscreener.com/latest/dex/pairs/solana/";
export const DEXSCREENER_TOKENS_PREFIX = "https://api.dexscreener.com/latest/dex/tokens/";
export const RAYDIUM_POOLS_ENDPOINT = "https://api-v3.raydium.io/pools/info/list";
export const DEFAULT_HTTP_TIMEOUT_MS = 5000;

export interface SeededLookupDiagnostics {
  readonly targetUrl: string;
  readonly mintAddress: string;
  readonly targetPoolAddress?: string | undefined;
  readonly httpStatus: number | null;
  readonly httpStatusText?: string | undefined;
  readonly payloadSha256: string | null;
  readonly rawResponseLengthBytes: number;
  readonly observedPairCount: number;
  readonly failureReason: string | null;
  readonly sanitizedResponseSnippet?: string | undefined;
  readonly timestampMs: number;
}

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFunction = (ms: number) => Promise<void>;

export function isWsolToken(token?: { address?: string; symbol?: string }): boolean {
  if (!token || typeof token.address !== "string") return false;
  // Strictly require canonical WSOL mint address. Never trust token symbols alone.
  return token.address === WSOL_MINT;
}

export class LiveDexScreenerQuoteProvider implements IShadowMarketDataProvider {
  public readonly providerName = "DEXSCREENER";
  private readonly fetchFn: FetchFunction;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(
    budgetManager: GlobalResourceBudgetManager,
    fetchFn: FetchFunction = fetch,
    clock: () => number = () => Date.now(),
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ) {
    this.budgetManager = budgetManager;
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  async fetchQuote(poolId: string, mintAddress: string): Promise<ShadowQuoteResult> {
    const targetUrl =
      poolId && poolId.length > 20
        ? `${DEXSCREENER_PAIRS_SOLANA_PREFIX}${poolId}`
        : `${DEXSCREENER_TOKENS_PREFIX}${mintAddress}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchFn(targetUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`HTTP request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    const httpStatus = res.status;
    this.budgetManager.recordResponseStatus(httpStatus);

    if (!res.ok) {
      return {
        indicativePriceSol: null,
        liquidityUsd: null,
        quoteTimestampMs: null,
        quoteSource: "DEXSCREENER",
        isExecutableQuote: false,
        missingReason: `HTTP_${httpStatus}_${res.statusText}`,
        httpStatus,
      };
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
        quoteTimestampMs: null,
        quoteSource: "DEXSCREENER",
        isExecutableQuote: false,
        missingReason: "EMPTY_PAIRS_ARRAY",
        httpStatus,
      };
    }

    // 1. Filter Solana pairs
    const solPairs = pairs.filter((p) => p && p.chainId === "solana");
    if (solPairs.length === 0) {
      return {
        indicativePriceSol: null,
        liquidityUsd: null,
        quoteTimestampMs: null,
        quoteSource: "DEXSCREENER",
        isExecutableQuote: false,
        missingReason: "NON_SOLANA_CHAIN",
        httpStatus,
      };
    }

    // 2. Exact pool matching when poolId is specified (strictly enforcing Raydium dexId)
    let matchingPair: Record<string, unknown> | undefined;
    if (poolId && poolId.length > 20) {
      matchingPair = solPairs.find(
        (p) =>
          typeof p.pairAddress === "string" &&
          p.pairAddress.toLowerCase() === poolId.toLowerCase() &&
          p.dexId === "raydium",
      );
      if (!matchingPair) {
        const poolOnOtherDex = solPairs.find(
          (p) =>
            typeof p.pairAddress === "string" &&
            p.pairAddress.toLowerCase() === poolId.toLowerCase(),
        );
        return {
          indicativePriceSol: null,
          liquidityUsd: null,
          quoteTimestampMs: null,
          quoteSource: "DEXSCREENER",
          isExecutableQuote: false,
          missingReason: poolOnOtherDex
            ? "NON_RAYDIUM_DEX_REJECTED"
            : "PAIR_ADDRESS_MISMATCH_OR_NOT_FOUND",
          httpStatus,
        };
      }
    } else {
      // Raydium pool matching when poolId is not specified
      matchingPair = solPairs.find((p) => p.dexId === "raydium");
      if (!matchingPair) {
        return {
          indicativePriceSol: null,
          liquidityUsd: null,
          quoteTimestampMs: null,
          quoteSource: "DEXSCREENER",
          isExecutableQuote: false,
          missingReason: "NO_RAYDIUM_POOL_FOUND",
          httpStatus,
        };
      }
    }

    // 3. Verify requested token mint matches base or quote
    const baseToken = (matchingPair.baseToken as Record<string, string>) || {};
    const quoteToken = (matchingPair.quoteToken as Record<string, string>) || {};
    const isBaseToken = baseToken.address === mintAddress;
    const isQuoteToken = quoteToken.address === mintAddress;

    if (!isBaseToken && !isQuoteToken) {
      return {
        indicativePriceSol: null,
        liquidityUsd: null,
        quoteTimestampMs: null,
        quoteSource: "DEXSCREENER",
        isExecutableQuote: false,
        missingReason: "MINT_ADDRESS_MISMATCH",
        httpStatus,
      };
    }

    // 4. Validate quote token denomination (WSOL check)
    let indicativePriceSol: number | null = null;
    let missingReason: string | undefined;

    if (isBaseToken) {
      if (isWsolToken(quoteToken)) {
        if (typeof matchingPair.priceNative === "string") {
          const parsed = Number.parseFloat(matchingPair.priceNative);
          if (Number.isFinite(parsed) && parsed > 0) {
            indicativePriceSol = parsed;
          } else {
            missingReason = "INVALID_PRICE_NATIVE_FORMAT";
          }
        } else {
          missingReason = "MISSING_PRICE_NATIVE";
        }
      } else {
        // Quote token is USDC, USDT, or non-SOL: no arbitrary $150/SOL conversion allowed
        indicativePriceSol = null;
        missingReason = "NON_SOL_QUOTE_DENOMINATION";
      }
    } else {
      // Inverted pair (candidate is quote token)
      if (isWsolToken(baseToken)) {
        if (typeof matchingPair.priceNative === "string") {
          const parsed = Number.parseFloat(matchingPair.priceNative);
          if (Number.isFinite(parsed) && parsed > 0) {
            indicativePriceSol = 1 / parsed;
          } else {
            missingReason = "INVALID_PRICE_NATIVE_FORMAT";
          }
        } else {
          missingReason = "MISSING_PRICE_NATIVE";
        }
      } else {
        indicativePriceSol = null;
        missingReason = "NON_SOL_QUOTE_DENOMINATION";
      }
    }

    // 5. Liquidity & confirmed pool drainage check
    const liquidity = (matchingPair.liquidity as Record<string, number>) || {};
    let liquidityUsd: number | null = null;
    let isPoolDrained = false;

    if (typeof liquidity.usd === "number" && Number.isFinite(liquidity.usd)) {
      liquidityUsd = liquidity.usd;
      // Confirmed pool drainage requires actual observed liquidity < $500
      isPoolDrained = liquidityUsd < 500;
    } else {
      // Missing liquidity field is NOT pool drainage; it is unavailable data
      liquidityUsd = null;
      isPoolDrained = false;
      if (!missingReason) {
        missingReason = "MISSING_LIQUIDITY_DATA";
      }
    }

    // DexScreener does not provide an authenticated upstream price-tick timestamp.
    // Preserving quoteTimestampMs as null accurately records that upstream market-tick age is unknown,
    // avoiding the manufacture of quote freshness from local HTTP retrieval time.
    const quoteTimestampMs: number | null = null;

    return {
      indicativePriceSol,
      liquidityUsd,
      quoteTimestampMs,
      quoteSource: "DEXSCREENER",
      isExecutableQuote: false,
      isPoolDrained,
      httpStatus,
      missingReason,
    };
  }
}

export class LiveDexScreenerCandidateSource {
  private readonly fetchFn: FetchFunction;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly clock: () => number;
  private readonly sleepFn: SleepFunction;
  private readonly timeoutMs: number;
  private readonly seenMints = new Set<string>();

  private profilesReceivedCount = 0;
  private enrichmentAttemptsCount = 0;
  private mismatchedPairsCount = 0;
  private priceQualifiedCandidatesCount = 0;

  constructor(
    budgetManager: GlobalResourceBudgetManager,
    fetchFn: FetchFunction = fetch,
    clock: () => number = () => Date.now(),
    sleepFn: SleepFunction = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  ) {
    this.budgetManager = budgetManager;
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.sleepFn = sleepFn;
    this.timeoutMs = timeoutMs;
  }

  public getYieldStats(): {
    profilesReceivedCount: number;
    enrichmentAttemptsCount: number;
    mismatchedPairsCount: number;
    priceQualifiedCandidatesCount: number;
  } {
    return {
      profilesReceivedCount: this.profilesReceivedCount,
      enrichmentAttemptsCount: this.enrichmentAttemptsCount,
      mismatchedPairsCount: this.mismatchedPairsCount,
      priceQualifiedCandidatesCount: this.priceQualifiedCandidatesCount,
    };
  }

  private lastSeededLookupDiagnostics?: SeededLookupDiagnostics | undefined;

  public getSeededLookupDiagnostics(): SeededLookupDiagnostics | undefined {
    return this.lastSeededLookupDiagnostics;
  }

  public async pollCandidates(maxToDiscover = 10): Promise<ShadowCandidateInput[]> {
    const now = this.clock();

    // Check budget before discovery request (honoring reservation for forward quotes)
    const discoveryCheck = this.budgetManager.canMakeRequest("DEXSCREENER", now, "DISCOVERY_POLL");
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(DEXSCREENER_PROFILES_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      this.budgetManager.recordResponseStatus(res.status);
      if (!res.ok) return [];

      const body = await res.json();
      profiles = Array.isArray(body) ? body : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }

    const solanaProfiles = profiles.filter((p) => p && p.chainId === "solana" && p.tokenAddress);
    this.profilesReceivedCount += solanaProfiles.length;
    const candidates: ShadowCandidateInput[] = [];

    for (const profile of solanaProfiles) {
      if (candidates.length >= maxToDiscover) break;

      const mint = profile.tokenAddress!;
      if (this.seenMints.has(mint)) continue;
      this.seenMints.add(mint);

      // Check budget before candidate enrichment (enforces maxEnrichmentAttempts & reserved forward quotes)
      const check = this.budgetManager.canMakeRequest(
        "DEXSCREENER",
        this.clock(),
        "CANDIDATE_ENRICHMENT",
      );
      if (!check.allowed) {
        if (
          check.reason === "PROVIDER_PACING_NOT_MET" &&
          typeof check.waitMs === "number" &&
          check.waitMs > 0
        ) {
          await this.sleepFn(check.waitMs);
        } else {
          // Ceilings reached (e.g. MAX_ENRICHMENT_ATTEMPTS_REACHED or RESERVED_FOR_FORWARD_OBSERVATIONS)
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

  public async enrichCandidate(
    mintAddress: string,
    targetPoolAddress?: string,
  ): Promise<ShadowCandidateInput | null> {
    const now = this.clock();
    this.enrichmentAttemptsCount++;

    const recorded = this.budgetManager.recordRequestAttempt(
      "DEXSCREENER",
      "CANDIDATE_ENRICHMENT",
      now,
    );
    if (!recorded) {
      if (targetPoolAddress) {
        this.lastSeededLookupDiagnostics = {
          targetUrl: `${DEXSCREENER_PAIRS_SOLANA_PREFIX}${targetPoolAddress}`,
          mintAddress,
          targetPoolAddress,
          httpStatus: null,
          payloadSha256: null,
          rawResponseLengthBytes: 0,
          observedPairCount: 0,
          failureReason: "BUDGET_REJECTED_OR_PACING_NOT_MET",
          timestampMs: now,
        };
      }
      this.mismatchedPairsCount++;
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const targetUrl = targetPoolAddress
      ? `${DEXSCREENER_PAIRS_SOLANA_PREFIX}${targetPoolAddress}`
      : `${DEXSCREENER_TOKENS_PREFIX}${mintAddress}`;

    try {
      const res = await this.fetchFn(targetUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      this.budgetManager.recordResponseStatus(res.status);

      const rawText = await res.text();
      const payloadSha256 = crypto.createHash("sha256").update(rawText).digest("hex");
      const rawBytes = Buffer.byteLength(rawText, "utf8");
      const snippet = rawText.slice(0, 500);

      if (!res.ok) {
        if (targetPoolAddress) {
          this.lastSeededLookupDiagnostics = {
            targetUrl,
            mintAddress,
            targetPoolAddress,
            httpStatus: res.status,
            httpStatusText: res.statusText,
            payloadSha256,
            rawResponseLengthBytes: rawBytes,
            observedPairCount: 0,
            failureReason: `SEED_HTTP_STATUS_${res.status}_${res.statusText || "ERROR"}`,
            sanitizedResponseSnippet: snippet,
            timestampMs: this.clock(),
          };
        }
        this.mismatchedPairsCount++;
        return null;
      }

      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        if (targetPoolAddress) {
          this.lastSeededLookupDiagnostics = {
            targetUrl,
            mintAddress,
            targetPoolAddress,
            httpStatus: res.status,
            httpStatusText: res.statusText,
            payloadSha256,
            rawResponseLengthBytes: rawBytes,
            observedPairCount: 0,
            failureReason: "SEED_INVALID_JSON_PAYLOAD",
            sanitizedResponseSnippet: snippet,
            timestampMs: this.clock(),
          };
        }
        this.mismatchedPairsCount++;
        return null;
      }

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
        if (targetPoolAddress) {
          this.lastSeededLookupDiagnostics = {
            targetUrl,
            mintAddress,
            targetPoolAddress,
            httpStatus: res.status,
            httpStatusText: res.statusText,
            payloadSha256,
            rawResponseLengthBytes: rawBytes,
            observedPairCount: 0,
            failureReason: "SEED_EMPTY_PAIRS_ARRAY",
            sanitizedResponseSnippet: snippet,
            timestampMs: this.clock(),
          };
        }
        this.mismatchedPairsCount++;
        return null;
      }

      const matchingPairs = pairs.filter((p) => {
        if (!p || p.chainId !== "solana" || p.dexId !== "raydium") return false;
        if (typeof p.pairAddress !== "string" || p.pairAddress.trim().length === 0) return false;
        const base = (p.baseToken as Record<string, string>)?.address;
        const quote = (p.quoteToken as Record<string, string>)?.address;
        return base === mintAddress || quote === mintAddress;
      });

      if (matchingPairs.length === 0) {
        if (targetPoolAddress) {
          const foundPool = pairs.find(
            (p) =>
              p &&
              typeof p.pairAddress === "string" &&
              p.pairAddress.toLowerCase() === targetPoolAddress.toLowerCase(),
          );
          let failureReason = "SEED_POOL_ADDRESS_NOT_FOUND_IN_RESPONSE";
          if (foundPool) {
            if (foundPool.chainId !== "solana") {
              failureReason = "SEED_NON_SOLANA_CHAIN";
            } else if (foundPool.dexId !== "raydium") {
              failureReason = `SEED_NON_RAYDIUM_DEX_${String(foundPool.dexId)}`;
            } else {
              failureReason = "SEED_MINT_ADDRESS_MISMATCH";
            }
          }
          this.lastSeededLookupDiagnostics = {
            targetUrl,
            mintAddress,
            targetPoolAddress,
            httpStatus: res.status,
            httpStatusText: res.statusText,
            payloadSha256,
            rawResponseLengthBytes: rawBytes,
            observedPairCount: pairs.length,
            failureReason,
            sanitizedResponseSnippet: snippet,
            timestampMs: this.clock(),
          };
        }
        this.mismatchedPairsCount++;
        return null;
      }

      interface CandidatePairAssessment {
        pair: Record<string, unknown>;
        pairAddress: string;
        baseToken: Record<string, string>;
        quoteToken: Record<string, string>;
        isBaseToken: boolean;
        hasCanonicalWsol: boolean;
        indicativePriceSol: number | null;
        missingPriceReason?: string | undefined;
        liquidityUsd: number | null;
        volume5mUsd: number | null;
        hasValidPrice: boolean;
      }

      const assessments: CandidatePairAssessment[] = matchingPairs.map((p) => {
        const pairAddress = (p.pairAddress as string).trim();
        const baseToken = (p.baseToken as Record<string, string>) || {};
        const quoteToken = (p.quoteToken as Record<string, string>) || {};
        const isBaseToken = baseToken.address === mintAddress;
        const counterToken = isBaseToken ? quoteToken : baseToken;
        const hasCanonicalWsol = isWsolToken(counterToken);

        let indicativePriceSol: number | null = null;
        let missingPriceReason: string | undefined;

        if (!hasCanonicalWsol) {
          missingPriceReason = "NON_SOL_QUOTE_DENOMINATION";
        } else if (typeof p.priceNative !== "string") {
          missingPriceReason = "MISSING_PRICE_NATIVE";
        } else {
          const parsed = Number.parseFloat(p.priceNative);
          if (Number.isFinite(parsed) && parsed > 0) {
            indicativePriceSol = isBaseToken ? parsed : 1 / parsed;
          } else {
            missingPriceReason = "INVALID_PRICE_NATIVE_VALUE";
          }
        }

        const liquidity = (p.liquidity as Record<string, number>) || {};
        const liquidityUsd =
          typeof liquidity.usd === "number" && Number.isFinite(liquidity.usd)
            ? liquidity.usd
            : null;

        const volume = (p.volume as Record<string, number>) || {};
        const volume5mUsd =
          typeof volume.m5 === "number" && Number.isFinite(volume.m5) ? volume.m5 : null;

        const hasValidPrice = indicativePriceSol !== null && indicativePriceSol > 0;

        return {
          pair: p,
          pairAddress,
          baseToken,
          quoteToken,
          isBaseToken,
          hasCanonicalWsol,
          indicativePriceSol,
          missingPriceReason,
          liquidityUsd,
          volume5mUsd,
          hasValidPrice,
        };
      });

      let selected: CandidatePairAssessment;
      let selectionBasis: string;

      // When a specific targetPoolAddress is requested (e.g. seeded reference test),
      // we strictly enforce matching that exact pool. We NEVER substitute a higher-liquidity alternative.
      if (targetPoolAddress) {
        const exactMatch = assessments.find(
          (a) => a.pairAddress.toLowerCase() === targetPoolAddress.toLowerCase(),
        );
        if (!exactMatch) {
          this.lastSeededLookupDiagnostics = {
            targetUrl,
            mintAddress,
            targetPoolAddress,
            httpStatus: res.status,
            httpStatusText: res.statusText,
            payloadSha256,
            rawResponseLengthBytes: rawBytes,
            observedPairCount: pairs.length,
            failureReason: "SEED_POOL_ADDRESS_NOT_FOUND_IN_MATCHING_ASSESSMENTS",
            sanitizedResponseSnippet: snippet,
            timestampMs: this.clock(),
          };
          this.mismatchedPairsCount++;
          return null;
        }
        if (!exactMatch.hasValidPrice) {
          const specificReason = exactMatch.missingPriceReason ?? "SEED_PRICE_INVALID_OR_MISSING";
          this.lastSeededLookupDiagnostics = {
            targetUrl,
            mintAddress,
            targetPoolAddress,
            httpStatus: res.status,
            httpStatusText: res.statusText,
            payloadSha256,
            rawResponseLengthBytes: rawBytes,
            observedPairCount: pairs.length,
            failureReason: specificReason,
            sanitizedResponseSnippet: snippet,
            timestampMs: this.clock(),
          };
          this.mismatchedPairsCount++;
          return null;
        }
        selected = exactMatch;
        selectionBasis = "EXACT_ENFORCED_SEED_POOL_MATCH";
        this.lastSeededLookupDiagnostics = {
          targetUrl,
          mintAddress,
          targetPoolAddress,
          httpStatus: res.status,
          httpStatusText: res.statusText,
          payloadSha256,
          rawResponseLengthBytes: rawBytes,
          observedPairCount: pairs.length,
          failureReason: null,
          sanitizedResponseSnippet: snippet,
          timestampMs: this.clock(),
        };
      } else {
        // Unseeded discovery mode: deterministic selection requiring genuine canonical WSOL Raydium pair with valid price
        const priceQualified = assessments.filter((a) => a.hasValidPrice);
        if (priceQualified.length === 0) {
          this.mismatchedPairsCount++;
          return null;
        }

        // If multiple price-qualified pairs exist, sort deterministically:
        // 1. Highest liquidity first
        // 2. Highest 5m volume second
        // 3. Alphabetical tie-break on pairAddress
        priceQualified.sort((a, b) => {
          const liqA = a.liquidityUsd ?? -1;
          const liqB = b.liquidityUsd ?? -1;
          if (liqB !== liqA) return liqB - liqA;

          const volA = a.volume5mUsd ?? -1;
          const volB = b.volume5mUsd ?? -1;
          if (volB !== volA) return volB - volA;

          return a.pairAddress.localeCompare(b.pairAddress);
        });

        selected = priceQualified[0]!;
        selectionBasis = "HIGHEST_LIQUIDITY_CANONICAL_WSOL_RAYDIUM_PAIR";
      }

      const bestPair = selected.pair;
      const baseToken = selected.baseToken;
      const liquidity = (bestPair.liquidity as Record<string, number>) || {};
      const volume = (bestPair.volume as Record<string, number>) || {};
      const txns = (bestPair.txns as Record<string, Record<string, number>>) || {};
      const m5Txns = txns.m5 || {};

      const unavailableInputs: string[] = [];

      // 1. Indicative Price & Specific Missing Reason
      const indicativePriceSol = selected.indicativePriceSol;
      if (indicativePriceSol === null) {
        unavailableInputs.push(selected.missingPriceReason ?? "indicativePriceSol");
      }

      // 2. Liquidity (No fabricated defaults)
      let liquidityUsd: number | null = null;
      if (typeof liquidity.usd === "number" && Number.isFinite(liquidity.usd)) {
        liquidityUsd = liquidity.usd;
      } else {
        unavailableInputs.push("liquidityUsd");
      }

      // 3. Market Cap (NO liquidity * 3 estimation)
      let marketCapUsd: number | null = null;
      if (typeof bestPair.marketCap === "number" && Number.isFinite(bestPair.marketCap)) {
        marketCapUsd = bestPair.marketCap;
      } else if (typeof bestPair.fdv === "number" && Number.isFinite(bestPair.fdv)) {
        marketCapUsd = bestPair.fdv;
      } else {
        unavailableInputs.push("marketCapUsd");
      }

      // 4. L/MC Ratio
      let lmcRatio: number | null = null;
      if (liquidityUsd !== null && marketCapUsd !== null && marketCapUsd > 0) {
        lmcRatio = Number((liquidityUsd / marketCapUsd).toFixed(4));
      } else {
        unavailableInputs.push("lmcRatio");
      }

      // 5. Asset Age (NO manufactured 1800s / 30m default)
      let assetAgeSeconds: number | null = null;
      if (typeof bestPair.pairCreatedAt === "number" && bestPair.pairCreatedAt > 0) {
        assetAgeSeconds = Math.max(0, Math.floor((this.clock() - bestPair.pairCreatedAt) / 1000));
      } else {
        unavailableInputs.push("assetAgeSeconds");
      }

      // 6. LP Burn Pct (NO fabricated lpBurnPct = 100)
      const lpBurnPct: number | null = null;
      unavailableInputs.push("lpBurnPct");

      // 7. Volume 5m
      let volume5mUsd: number | null = null;
      if (typeof volume.m5 === "number" && Number.isFinite(volume.m5)) {
        volume5mUsd = volume.m5;
      } else {
        unavailableInputs.push("volume5mUsd");
      }

      // 8. Transactions 5m & Flow Ratio
      let buys5m: number | null = null;
      let sells5m: number | null = null;
      let buyToSellRatio: number | null = null;

      if (typeof m5Txns.buys === "number" && Number.isFinite(m5Txns.buys)) {
        buys5m = m5Txns.buys;
      } else {
        unavailableInputs.push("buys5m");
      }

      if (typeof m5Txns.sells === "number" && Number.isFinite(m5Txns.sells)) {
        sells5m = m5Txns.sells;
      } else {
        unavailableInputs.push("sells5m");
      }

      if (buys5m !== null && sells5m !== null) {
        buyToSellRatio = sells5m > 0 ? Number((buys5m / sells5m).toFixed(2)) : buys5m;
      } else {
        unavailableInputs.push("buyToSellRatio");
      }

      // 9. Risk & Security Metrics (DexScreener does not provide these; preserved truthfully as null)
      unavailableInputs.push("holdersCount", "rugScore", "bundlerPct", "top10HolderPct");

      if (indicativePriceSol !== null && indicativePriceSol > 0) {
        this.priceQualifiedCandidatesCount++;
      } else {
        this.mismatchedPairsCount++;
      }

      return {
        poolId: selected.pairAddress,
        selectedPoolAddress: selected.pairAddress,
        poolSelectionBasis: selectionBasis,
        mintAddress,
        symbol: baseToken.symbol || "UNKNOWN",
        discoveryTimestampMs: this.clock(),
        streamSource: targetPoolAddress
          ? "DEXSCREENER_EXACT_PAIR_LOOKUP"
          : "DEXSCREENER_LATEST_TOKEN_PROFILES",
        indicativePriceSol,
        missingPriceReason: selected.missingPriceReason,
        priceQuoteTimestampMs: null, // Upstream tick timestamp unknown; never represent receipt time as tick timestamp
        liquidityUsd,
        marketCapUsd,
        lmcRatio,
        lpBurnPct,
        assetAgeSeconds,
        volume5mUsd,
        buys5m,
        sells5m,
        buyToSellRatio,
        holdersCount: null,
        rugScore: null,
        bundlerPct: null,
        top10HolderPct: null,
        unavailableInputs,
      };
    } catch (err) {
      if (targetPoolAddress) {
        this.lastSeededLookupDiagnostics = {
          targetUrl,
          mintAddress,
          targetPoolAddress,
          httpStatus: null,
          payloadSha256: null,
          rawResponseLengthBytes: 0,
          observedPairCount: 0,
          failureReason: `FETCH_ERROR_${(err as Error).name || (err as Error).message}`,
          timestampMs: this.clock(),
        };
      }
      this.mismatchedPairsCount++;
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
