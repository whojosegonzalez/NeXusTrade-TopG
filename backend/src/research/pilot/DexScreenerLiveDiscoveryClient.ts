/**
 * Phase 12.94-D Milestone D.2.4: DexScreener Live Discovery Client
 *
 * Implements bounded, rate-limited, read-only HTTP discovery of Solana token candidates
 * from DexScreener public endpoints, strictly using accepted D.2.3 parser contracts.
 *
 * Safety & Integrity:
 * - Read-only HTTP GET exclusively against allowlisted DexScreener endpoints.
 * - Deduplicates discovered tokens and caches pair resolutions.
 * - Enforces default 30-second profile polling interval and handles 429 Retry-After.
 * - Captures authentic request/receipt timestamps without synthesizing source times.
 * - Injectable transport for 100% offline deterministic testing.
 */

import {
  parseDexScreenerTokenProfiles,
  parseDexScreenerPairsResponse,
  type DexScreenerPairSummary,
} from "./DexScreenerResponseAdapter.js";
import { D23_STRATEGY_REVISION, D23_OBSERVATIONAL_PROVIDER } from "./PilotSchemaBridge.js";
import type { D23ScreenedCandidate } from "./PilotTypes.js";

export const DEXSCREENER_PROFILES_ENDPOINT = "https://api.dexscreener.com/token-profiles/latest/v1";
export const DEXSCREENER_TOKENS_ENDPOINT_PREFIX = "https://api.dexscreener.com/latest/dex/tokens/";

export const DEFAULT_PROFILE_POLL_INTERVAL_MS = 30_000; // 30 seconds operator default
export const DEFAULT_HTTP_TIMEOUT_MS = 5_000; // 5 seconds
export const DEFAULT_PAIR_CACHE_TTL_MS = 300_000; // 5 minutes

export interface ILiveHttpTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DexScreenerClientOptions {
  readonly pollIntervalMs?: number | undefined;
  readonly httpTimeoutMs?: number | undefined;
  readonly pairCacheTtlMs?: number | undefined;
  readonly transport?: ILiveHttpTransport | undefined;
}

export interface DiscoveredCandidateResult {
  readonly candidate: D23ScreenedCandidate;
  readonly pairSummary: DexScreenerPairSummary | null;
  readonly isNewDiscovery: boolean;
}

/**
 * Validates that a target URL belongs to the strict DexScreener read-only allowlist.
 */
export function isAllowlistedDexScreenerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.dexscreener.com") {
      return false;
    }
    const pathname = parsed.pathname;
    if (pathname === "/token-profiles/latest/v1") {
      return true;
    }
    if (pathname.startsWith("/latest/dex/tokens/")) {
      const tokenAddress = pathname.slice("/latest/dex/tokens/".length);
      return tokenAddress.length > 0 && /^[1-9A-HJ-NP-za-km-z]+$/.test(tokenAddress);
    }
    return false;
  } catch {
    return false;
  }
}

export class DexScreenerLiveDiscoveryClient {
  private readonly pollIntervalMs: number;
  private readonly httpTimeoutMs: number;
  private readonly pairCacheTtlMs: number;
  private readonly transport: ILiveHttpTransport;

  private readonly seenMints = new Set<string>();
  private readonly pairCache = new Map<
    string,
    { summary: DexScreenerPairSummary | null; cachedAtEpochMs: number }
  >();

  private lastProfilePollEpochMs = 0;
  private retryAfterUntilEpochMs = 0;

  constructor(options?: DexScreenerClientOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_PROFILE_POLL_INTERVAL_MS;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.pairCacheTtlMs = options?.pairCacheTtlMs ?? DEFAULT_PAIR_CACHE_TTL_MS;
    this.transport = options?.transport ?? {
      fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    };
  }

  public getSeenMintsCount(): number {
    return this.seenMints.size;
  }

  public isMintSeen(mint: string): boolean {
    return this.seenMints.has(mint);
  }

  public getPairCacheSize(): number {
    return this.pairCache.size;
  }

  /**
   * Executes a bounded discovery poll.
   * Fetches latest token profiles if poll interval has elapsed, deduplicates mints,
   * resolves Raydium AMM v4 pairs, and returns newly screened candidate records.
   */
  public async pollDiscoveredCandidates(context: {
    sessionId: string;
    generationId: string;
  }): Promise<DiscoveredCandidateResult[]> {
    const now = Date.now();

    // Respect Retry-After backoff if currently active
    if (now < this.retryAfterUntilEpochMs) {
      return [];
    }

    // Enforce profile poll interval
    if (
      this.lastProfilePollEpochMs > 0 &&
      now - this.lastProfilePollEpochMs < this.pollIntervalMs
    ) {
      return [];
    }

    this.lastProfilePollEpochMs = now;

    // Stage 1: Fetch and parse token profiles
    const profilesPayload = await this.executeGetJson(DEXSCREENER_PROFILES_ENDPOINT);
    if (!profilesPayload) {
      return [];
    }

    const profilesResult = parseDexScreenerTokenProfiles(profilesPayload);
    if (!profilesResult.ok || profilesResult.candidates.length === 0) {
      return [];
    }

    const results: DiscoveredCandidateResult[] = [];

    // Stage 2: For new mints, resolve token pair summary
    for (const profile of profilesResult.candidates) {
      const mint = profile.tokenAddress;
      const isNew = !this.seenMints.has(mint);
      this.seenMints.add(mint);

      if (!isNew) {
        continue;
      }

      const pairSummary = await this.resolveTokenPair(mint);
      const decisionEpochMs = Date.now();
      const eventId = `evt-ds-${mint.slice(0, 8)}-${decisionEpochMs}`;

      const candidate: D23ScreenedCandidate = {
        compositeId: {
          decisionEventId: eventId,
          sessionId: context.sessionId,
          generationId: context.generationId,
          mintAddress: mint,
          poolId: pairSummary?.poolId ?? "UNRESOLVED_POOL_ADDRESS",
        },
        symbol: pairSummary?.baseTokenSymbol ?? "UNKNOWN",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: pairSummary?.isRaydiumAmmCandidate
          ? "WATCHLIST_RADAR"
          : "FILTERED_REJECTED",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs,
        requestEpochMs: this.lastProfilePollEpochMs,
        receiptEpochMs: decisionEpochMs,
        sourceTimestampMs: null, // Truthful: DexScreener does not attest source quote timestamps
        passedEligibility: Boolean(pairSummary?.isRaydiumAmmCandidate),
        filterEvaluations: [
          {
            filterName: "RAYDIUM_AMM_IDENTIFIED",
            passed: Boolean(pairSummary?.isRaydiumAmmCandidate),
            observed: pairSummary?.dexId ?? "none",
            threshold: "raydium",
            rejectionReason: pairSummary?.isRaydiumAmmCandidate
              ? undefined
              : "No canonical Raydium AMM v4 pair found for token profile",
          },
        ],
        rejectionReasons: pairSummary?.isRaydiumAmmCandidate
          ? []
          : ["NO_RAYDIUM_AMM_PAIR_IDENTIFIED"],
        missingFields: ["sourceTimestampMs"],
        providerIdentity: D23_OBSERVATIONAL_PROVIDER,
      };

      results.push({
        candidate,
        pairSummary,
        isNewDiscovery: true,
      });
    }

    return results;
  }

  /**
   * Resolves pair summary for a specific mint address with local caching.
   */
  public async resolveTokenPair(mintAddress: string): Promise<DexScreenerPairSummary | null> {
    const now = Date.now();
    const cached = this.pairCache.get(mintAddress);
    if (cached && now - cached.cachedAtEpochMs < this.pairCacheTtlMs) {
      return cached.summary;
    }

    const url = `${DEXSCREENER_TOKENS_ENDPOINT_PREFIX}${mintAddress}`;
    const pairsPayload = await this.executeGetJson(url);
    if (!pairsPayload) {
      this.pairCache.set(mintAddress, { summary: null, cachedAtEpochMs: now });
      return null;
    }

    const pairsResult = parseDexScreenerPairsResponse(pairsPayload, mintAddress);
    const summary = pairsResult.matchingRaydiumPair ?? pairsResult.pairs[0] ?? null;

    this.pairCache.set(mintAddress, { summary, cachedAtEpochMs: now });
    return summary;
  }

  /**
   * Executes a strictly allowlisted GET request with timeout and Retry-After handling.
   */
  private async executeGetJson(url: string): Promise<unknown | null> {
    if (!isAllowlistedDexScreenerUrl(url)) {
      throw new Error(`[FORBIDDEN_HTTP_URL] URL '${url}' is not on the DexScreener allowlist`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);

    try {
      const response = await this.transport.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": `NeXusTrade-Pilot/${D23_STRATEGY_REVISION} (Linux; Research)`,
        },
        signal: controller.signal,
      });

      if (response.status === 429) {
        this.handleRateLimit(response);
        return null;
      }

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleRateLimit(response: Response): void {
    const retryAfterHeader = response.headers?.get?.("retry-after");
    let backoffSeconds = 10;
    if (retryAfterHeader) {
      const parsedSeconds = parseInt(retryAfterHeader, 10);
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        backoffSeconds = Math.min(parsedSeconds, 120);
      }
    }
    this.retryAfterUntilEpochMs = Date.now() + backoffSeconds * 1000;
  }
}
