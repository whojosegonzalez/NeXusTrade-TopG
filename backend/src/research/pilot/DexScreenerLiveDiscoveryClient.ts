/**
 * Phase 12.94-D Milestone D.2.4: DexScreener Live Discovery Client
 *
 * Implements bounded, rate-limited, read-only HTTP discovery of Solana token candidates
 * from DexScreener public endpoints, strictly using accepted D.2.3 parser contracts.
 *
 * Safety & Integrity:
 * - Read-only HTTP GET exclusively against allowlisted DexScreener endpoints.
 * - Deduplicates discovered tokens and caches pair resolutions.
 * - Enforces per-request outbound budget at the transport boundary (D24F-05).
 * - Distinguishes discovered tokens from resolved pairs; retries transient 429 failures.
 * - Bounded pair lookups per poll cycle to prevent request bursts.
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
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60; // 60 req/min default
export const DEFAULT_MAX_PAIR_LOOKUPS_PER_POLL = 10; // Max pair lookups in one poll cycle

export interface ILiveHttpTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DexScreenerClientOptions {
  readonly pollIntervalMs?: number | undefined;
  readonly httpTimeoutMs?: number | undefined;
  readonly pairCacheTtlMs?: number | undefined;
  readonly maxRequestsPerMinute?: number | undefined;
  readonly maxPairLookupsPerPoll?: number | undefined;
  readonly transport?: ILiveHttpTransport | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

export interface DexScreenerDiscoveryDiagnostics {
  readonly totalPolls: number;
  readonly totalHttpRequests: number;
  readonly rateLimitsEncountered: number;
  readonly timeoutsEncountered: number;
  readonly totalProfilesFetched: number;
  readonly totalPairLookups: number;
  readonly cachedPairLookups: number;
  readonly raydiumAmmCandidatesFound: number;
  readonly nonRaydiumPairsCount: number;
  readonly rejectionCountsByReason: Record<string, number>;
  readonly seenMintsCount: number;
  readonly resolvedMintsCount: number;
  readonly retryQueueSize: number;
  readonly pairCacheSize: number;
  readonly lastPollEpochMs: number;
}

export interface DiscoveredCandidateResult {
  readonly candidate: D23ScreenedCandidate;
  readonly pairSummary: DexScreenerPairSummary | null;
  readonly isNewDiscovery: boolean;
}

interface RetryQueueItem {
  attempts: number;
  nextRetryEpochMs: number;
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
  private readonly maxRequestsPerMinute: number;
  private readonly maxPairLookupsPerPoll: number;
  private readonly transport: ILiveHttpTransport;
  private readonly onLog?: ((message: string) => void) | undefined;

  // D24F-05: Distinguish discovered from resolved
  private readonly discoveredMints = new Set<string>();
  private readonly resolvedMints = new Set<string>();
  private readonly retryQueue = new Map<string, RetryQueueItem>();

  private readonly pairCache = new Map<
    string,
    { summary: DexScreenerPairSummary | null; cachedAtEpochMs: number }
  >();

  private requestTimestamps: number[] = [];
  private lastProfilePollEpochMs = 0;
  private retryAfterUntilEpochMs = 0;

  // Telemetry counters
  private rateLimitsEncountered = 0;
  private timeoutsEncountered = 0;
  private totalPolls = 0;
  private totalHttpRequests = 0;
  private totalProfilesFetched = 0;
  private totalPairLookups = 0;
  private cachedPairLookups = 0;
  private raydiumAmmCandidatesFound = 0;
  private nonRaydiumPairsCount = 0;
  private readonly rejectionCountsByReason = new Map<string, number>();

  constructor(options?: DexScreenerClientOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_PROFILE_POLL_INTERVAL_MS;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.pairCacheTtlMs = options?.pairCacheTtlMs ?? DEFAULT_PAIR_CACHE_TTL_MS;
    this.maxRequestsPerMinute = options?.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
    this.maxPairLookupsPerPoll =
      options?.maxPairLookupsPerPoll ?? DEFAULT_MAX_PAIR_LOOKUPS_PER_POLL;
    this.transport = options?.transport ?? {
      fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    };
    this.onLog = options?.onLog;
  }

  public getSeenMintsCount(): number {
    return this.discoveredMints.size;
  }

  public isMintSeen(mint: string): boolean {
    return this.discoveredMints.has(mint);
  }

  public isMintResolved(mint: string): boolean {
    return this.resolvedMints.has(mint);
  }

  public getPairCacheSize(): number {
    return this.pairCache.size;
  }

  public getRateLimitsEncounteredCount(): number {
    return this.rateLimitsEncountered;
  }

  public getTimeoutsEncounteredCount(): number {
    return this.timeoutsEncountered;
  }

  public getRetryQueueSize(): number {
    return this.retryQueue.size;
  }

  public getDiagnostics(): DexScreenerDiscoveryDiagnostics {
    const rejections: Record<string, number> = {};
    for (const [k, v] of this.rejectionCountsByReason.entries()) {
      rejections[k] = v;
    }
    return {
      totalPolls: this.totalPolls,
      totalHttpRequests: this.totalHttpRequests,
      rateLimitsEncountered: this.rateLimitsEncountered,
      timeoutsEncountered: this.timeoutsEncountered,
      totalProfilesFetched: this.totalProfilesFetched,
      totalPairLookups: this.totalPairLookups,
      cachedPairLookups: this.cachedPairLookups,
      raydiumAmmCandidatesFound: this.raydiumAmmCandidatesFound,
      nonRaydiumPairsCount: this.nonRaydiumPairsCount,
      rejectionCountsByReason: rejections,
      seenMintsCount: this.discoveredMints.size,
      resolvedMintsCount: this.resolvedMints.size,
      retryQueueSize: this.retryQueue.size,
      pairCacheSize: this.pairCache.size,
      lastPollEpochMs: this.lastProfilePollEpochMs,
    };
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
    this.totalPolls++;
    const now = Date.now();

    // Respect Retry-After backoff if currently active
    if (now < this.retryAfterUntilEpochMs) {
      this.onLog?.(
        `Poll skipped: rate-limit backoff active until ${new Date(this.retryAfterUntilEpochMs).toISOString()}`,
      );
      return [];
    }

    // Determine mints to resolve this cycle (retries first, then new profile discoveries)
    const mintsToResolve: string[] = [];

    // 1. Process pending items from retry queue whose backoff expired
    for (const [mint, item] of this.retryQueue.entries()) {
      if (now >= item.nextRetryEpochMs) {
        mintsToResolve.push(mint);
        if (mintsToResolve.length >= this.maxPairLookupsPerPoll) {
          break;
        }
      }
    }

    // 2. Fetch and parse token profiles if poll interval has elapsed and quota allows
    if (
      (this.lastProfilePollEpochMs === 0 ||
        now - this.lastProfilePollEpochMs >= this.pollIntervalMs) &&
      mintsToResolve.length < this.maxPairLookupsPerPoll
    ) {
      this.lastProfilePollEpochMs = now;
      this.onLog?.(`Polling promotional profiles from ${DEXSCREENER_PROFILES_ENDPOINT}`);
      const profilesPayload = await this.executeGetJson(DEXSCREENER_PROFILES_ENDPOINT);
      if (profilesPayload) {
        const profilesResult = parseDexScreenerTokenProfiles(profilesPayload);
        if (profilesResult.ok && profilesResult.candidates.length > 0) {
          this.totalProfilesFetched += profilesResult.candidates.length;
          this.onLog?.(
            `Received ${profilesResult.candidates.length} promotional profile(s) from DexScreener`,
          );
          for (const profile of profilesResult.candidates) {
            const mint = profile.tokenAddress;
            const isNew = !this.discoveredMints.has(mint);
            this.discoveredMints.add(mint);

            if (isNew && !this.resolvedMints.has(mint) && !this.retryQueue.has(mint)) {
              if (mintsToResolve.length < this.maxPairLookupsPerPoll) {
                mintsToResolve.push(mint);
              } else {
                // Queue for next poll so discovery is not lost
                this.retryQueue.set(mint, { attempts: 0, nextRetryEpochMs: now });
              }
            }
          }
        } else {
          this.onLog?.(
            `Profiles response contained 0 eligible candidates or error: ${profilesResult.parseErrors.join(", ") || "no eligible candidates"}`,
          );
        }
      } else {
        this.onLog?.(`Profiles request returned empty data or was throttled`);
      }
    }

    if (mintsToResolve.length === 0) {
      this.onLog?.(
        `Poll cycle complete: 0 mints to resolve (total seen: ${this.discoveredMints.size}, resolved: ${this.resolvedMints.size})`,
      );
      return [];
    }

    this.onLog?.(
      `Resolving pair data for ${mintsToResolve.length} mint(s) (queue: ${this.retryQueue.size})...`,
    );
    const results: DiscoveredCandidateResult[] = [];

    // Stage 3: Resolve token pair summary within bounded budget
    for (const mint of mintsToResolve) {
      if (this.resolvedMints.has(mint)) {
        continue;
      }

      const pairResult = await this.resolveTokenPairWithStatus(mint);

      if (pairResult.status === "RATE_LIMITED" || pairResult.status === "TRANSIENT_ERROR") {
        // D24F-05: Transient failure; queue for retry rather than permanently dropping
        const existing = this.retryQueue.get(mint);
        const attempts = (existing?.attempts ?? 0) + 1;
        if (attempts <= 3) {
          const backoffMs =
            typeof pairResult.retryAfterSec === "number"
              ? pairResult.retryAfterSec * 1000
              : Math.min(60_000, Math.pow(2, attempts) * 100);
          this.retryQueue.set(mint, { attempts, nextRetryEpochMs: Date.now() + backoffMs });
          this.onLog?.(
            `Mint ${mint} resolution ${pairResult.status}; queued retry attempt ${attempts} in ${backoffMs}ms`,
          );
        } else {
          // Exceeded retry budget; mark resolved with null
          this.resolvedMints.add(mint);
          this.retryQueue.delete(mint);
          this.onLog?.(
            `Mint ${mint} resolution failed after ${attempts} attempts; marked resolved/unavailable`,
          );
        }
        continue;
      }

      // Successful resolution or confirmed non-existent pair
      this.resolvedMints.add(mint);
      this.retryQueue.delete(mint);

      const pairSummary = pairResult.summary;
      if (pairSummary?.isRaydiumAmmCandidate) {
        this.raydiumAmmCandidatesFound++;
        this.onLog?.(
          `Resolved Raydium AMM v4 pool ${pairSummary.poolId} for mint ${mint} (${pairSummary.baseTokenSymbol})`,
        );
      } else {
        this.nonRaydiumPairsCount++;
        const reason = pairSummary ? `NON_RAYDIUM_DEX:${pairSummary.dexId}` : "NO_PAIR_FOUND";
        this.rejectionCountsByReason.set(
          reason,
          (this.rejectionCountsByReason.get(reason) ?? 0) + 1,
        );
        this.onLog?.(
          `Mint ${mint} (${pairSummary?.baseTokenSymbol ?? "UNKNOWN"}) filtered out: ${reason}`,
        );
      }

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
        requestEpochMs:
          this.lastProfilePollEpochMs > 0 ? this.lastProfilePollEpochMs : decisionEpochMs,
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
    const res = await this.resolveTokenPairWithStatus(mintAddress);
    return res.summary;
  }

  /**
   * Internal pair resolver distinguishing success, rate limiting, and errors.
   */
  private async resolveTokenPairWithStatus(mintAddress: string): Promise<{
    summary: DexScreenerPairSummary | null;
    status: "OK" | "RATE_LIMITED" | "TRANSIENT_ERROR";
    retryAfterSec?: number | undefined;
  }> {
    this.totalPairLookups++;
    const now = Date.now();
    const cached = this.pairCache.get(mintAddress);
    if (cached && now - cached.cachedAtEpochMs < this.pairCacheTtlMs) {
      this.cachedPairLookups++;
      return { summary: cached.summary, status: "OK" };
    }

    const url = `${DEXSCREENER_TOKENS_ENDPOINT_PREFIX}${mintAddress}`;
    const fetchResult = await this.executeGetJsonWithStatus(url);

    if (fetchResult.status === "RATE_LIMITED") {
      return { summary: null, status: "RATE_LIMITED", retryAfterSec: fetchResult.retryAfterSec };
    }
    if (fetchResult.status === "ERROR") {
      return { summary: null, status: "TRANSIENT_ERROR" };
    }

    if (!fetchResult.data) {
      this.pairCache.set(mintAddress, { summary: null, cachedAtEpochMs: now });
      return { summary: null, status: "OK" };
    }

    const pairsResult = parseDexScreenerPairsResponse(fetchResult.data, mintAddress);
    const summary = pairsResult.matchingRaydiumPair ?? pairsResult.pairs[0] ?? null;

    this.pairCache.set(mintAddress, { summary, cachedAtEpochMs: now });
    return { summary, status: "OK" };
  }

  /**
   * Executes a strictly allowlisted GET request with rate budgeting, timeout, and Retry-After handling.
   */
  private async executeGetJson(url: string): Promise<unknown | null> {
    const res = await this.executeGetJsonWithStatus(url);
    return res.data;
  }

  private async executeGetJsonWithStatus(url: string): Promise<{
    data: unknown | null;
    status: "OK" | "RATE_LIMITED" | "ERROR";
    retryAfterSec?: number | undefined;
  }> {
    if (!isAllowlistedDexScreenerUrl(url)) {
      throw new Error(`[FORBIDDEN_HTTP_URL] URL '${url}' is not on the DexScreener allowlist`);
    }

    const now = Date.now();
    if (now < this.retryAfterUntilEpochMs) {
      return {
        data: null,
        status: "RATE_LIMITED",
        retryAfterSec: Math.ceil((this.retryAfterUntilEpochMs - now) / 1000),
      };
    }

    // D24F-05: Enforce outbound rate budget at transport boundary
    try {
      this.enforceRateBudget();
    } catch {
      this.onLog?.(`Outbound rate budget of ${this.maxRequestsPerMinute} req/min exceeded`);
      return { data: null, status: "RATE_LIMITED" };
    }

    this.totalHttpRequests++;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      this.timeoutsEncountered++;
      controller.abort();
    }, this.httpTimeoutMs);

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
        this.rateLimitsEncountered++;
        const backoffSec = this.handleRateLimit(response);
        this.onLog?.(`HTTP 429 received on ${url}. Retry-after backoff: ${backoffSec}s`);
        return { data: null, status: "RATE_LIMITED", retryAfterSec: backoffSec };
      }

      if (!response.ok) {
        this.onLog?.(`HTTP error ${response.status} on ${url}`);
        return { data: null, status: "ERROR" };
      }

      const data = await response.json();
      return { data, status: "OK" };
    } catch (err) {
      this.onLog?.(
        `Fetch exception on ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { data: null, status: "ERROR" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private enforceRateBudget(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60_000);
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      throw new Error(
        `[DEXSCREENER_RATE_BUDGET_EXCEEDED] DexScreener client exceeded budget of ${this.maxRequestsPerMinute} req/min`,
      );
    }
    this.requestTimestamps.push(now);
  }

  private handleRateLimit(response: Response): number {
    const retryAfterHeader = response.headers?.get?.("retry-after");
    let backoffSeconds = 10;
    if (retryAfterHeader) {
      const parsedSeconds = parseInt(retryAfterHeader, 10);
      if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
        backoffSeconds = Math.min(parsedSeconds, 120);
      }
    }
    this.retryAfterUntilEpochMs = Date.now() + backoffSeconds * 1000;
    return backoffSeconds;
  }
}
