/**
 * Phase 12.94-D Milestone D.2.5: Raydium Live Discovery Client
 *
 * Implements bounded, rate-limited, read-only HTTP discovery of Solana standard AMM v4
 * liquidity pools from the Raydium API v3 catalog (/pools/info/list).
 *
 * Safety & Integrity:
 * - Read-only HTTP GET exclusively against allowlisted Raydium API v3 endpoint.
 * - Pool-ID-based deduplication (allows multiple pools per mint, rejects duplicate pools).
 * - Bounded request frequency with mandatory minimum inter-request spacing (default 2000ms).
 * - Explicit pool age freshness evaluation with --max-pool-age-sec=0 filter-disabled mode.
 * - Truthful source provenance ("RAYDIUM_API_STANDARD_POOLS") and unverified metadata labeling.
 * - Injectable transport for 100% offline deterministic testing.
 *
 * Authority: Finding D25-R1 through D25-R5.
 */

import {
  isAllowlistedRaydiumUrl,
  parseRaydiumApiPoolListResponse,
  RAYDIUM_POOLS_INFO_LIST_ENDPOINT,
  type RaydiumPoolSummary,
} from "./RaydiumResponseAdapter.js";
import { D23_STRATEGY_REVISION } from "./PilotSchemaBridge.js";
import type { D23ScreenedCandidate } from "./PilotTypes.js";
import type { ILiveHttpTransport } from "./DexScreenerLiveDiscoveryClient.js";

export const DEFAULT_RAYDIUM_POLL_INTERVAL_MS = 30_000; // 30 seconds operator default
export const DEFAULT_RAYDIUM_MIN_REQUEST_INTERVAL_MS = 2_000; // 2 seconds inter-request spacing (D25-R5)
export const DEFAULT_RAYDIUM_HTTP_TIMEOUT_MS = 5_000; // 5 seconds
export const DEFAULT_RAYDIUM_MAX_REQUESTS_PER_MINUTE = 60; // 60 req/min
export const DEFAULT_RAYDIUM_PAGE_SIZE = 50;

export const RAYDIUM_PROVIDER_IDENTITY = "raydium_api_v3:STANDARD_POOLS";

export interface RaydiumDiscoveryClientOptions {
  readonly pollIntervalMs?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly maxRequestsPerMinute?: number | undefined;
  readonly httpTimeoutMs?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly transport?: ILiveHttpTransport | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

export interface RaydiumDiscoveryDiagnostics {
  readonly totalPolls: number;
  readonly totalHttpRequests: number;
  readonly rateLimitsEncountered: number;
  readonly timeoutsEncountered: number;
  readonly totalPoolsFetched: number;
  readonly unseenPoolsCount: number;
  readonly maturePoolsSkipped: number;
  readonly missingAgePoolsCount: number;
  readonly invalidAgePoolsCount: number;
  readonly futureDatedAgePoolsCount: number;
  readonly nonSolPairsCount: number;
  readonly eligiblePoolsCount: number;
  readonly rejectionCountsByReason: Record<string, number>;
  readonly seenPoolIdsCount: number;
  readonly lastPollEpochMs: number;
}

export interface DiscoveredRaydiumCandidateResult {
  readonly candidate: D23ScreenedCandidate;
  readonly poolSummary: RaydiumPoolSummary;
  readonly isNewDiscovery: boolean;
}

export class RaydiumLiveDiscoveryClient {
  private readonly pollIntervalMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly maxPoolAgeSec: number;
  private readonly maxRequestsPerMinute: number;
  private readonly httpTimeoutMs: number;
  private readonly pageSize: number;
  private readonly transport: ILiveHttpTransport;
  private readonly onLog?: ((message: string) => void) | undefined;

  // Primary deduplication key: poolId (D25-R4)
  private readonly seenPoolIds = new Set<string>();

  private requestTimestamps: number[] = [];
  private lastPollEpochMs = 0;
  private lastRequestEpochMs = 0;
  private retryAfterUntilEpochMs = 0;

  // Telemetry counters
  private totalPolls = 0;
  private totalHttpRequests = 0;
  private rateLimitsEncountered = 0;
  private timeoutsEncountered = 0;
  private totalPoolsFetched = 0;
  private unseenPoolsCount = 0;
  private maturePoolsSkipped = 0;
  private missingAgePoolsCount = 0;
  private invalidAgePoolsCount = 0;
  private futureDatedAgePoolsCount = 0;
  private nonSolPairsCount = 0;
  private eligiblePoolsCount = 0;
  private readonly rejectionCountsByReason = new Map<string, number>();

  constructor(options?: RaydiumDiscoveryClientOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_RAYDIUM_POLL_INTERVAL_MS;
    this.minRequestIntervalMs =
      options?.minRequestIntervalMs !== undefined && options.minRequestIntervalMs >= 0
        ? options.minRequestIntervalMs
        : DEFAULT_RAYDIUM_MIN_REQUEST_INTERVAL_MS;
    this.maxPoolAgeSec =
      options?.maxPoolAgeSec !== undefined && options.maxPoolAgeSec >= 0
        ? options.maxPoolAgeSec
        : 0; // 0 = filter-disabled mode for Gate 1 connectivity
    this.maxRequestsPerMinute =
      options?.maxRequestsPerMinute ?? DEFAULT_RAYDIUM_MAX_REQUESTS_PER_MINUTE;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? DEFAULT_RAYDIUM_HTTP_TIMEOUT_MS;
    this.pageSize = options?.pageSize ?? DEFAULT_RAYDIUM_PAGE_SIZE;
    this.transport = options?.transport ?? {
      fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
    };
    this.onLog = options?.onLog;
  }

  public getSeenPoolIdsCount(): number {
    return this.seenPoolIds.size;
  }

  public isPoolSeen(poolId: string): boolean {
    return this.seenPoolIds.has(poolId);
  }

  public getMaxPoolAgeSec(): number {
    return this.maxPoolAgeSec;
  }

  public getMinRequestIntervalMs(): number {
    return this.minRequestIntervalMs;
  }

  public getRateLimitsEncounteredCount(): number {
    return this.rateLimitsEncountered;
  }

  public getTimeoutsEncounteredCount(): number {
    return this.timeoutsEncountered;
  }

  public isPollDue(): boolean {
    const now = Date.now();
    if (now < this.retryAfterUntilEpochMs) {
      return false;
    }
    if (this.lastRequestEpochMs > 0 && now - this.lastRequestEpochMs < this.minRequestIntervalMs) {
      return false;
    }
    return this.lastPollEpochMs === 0 || now - this.lastPollEpochMs >= this.pollIntervalMs;
  }

  public getDiagnostics(): RaydiumDiscoveryDiagnostics {
    const rejections: Record<string, number> = {};
    for (const [k, v] of this.rejectionCountsByReason.entries()) {
      rejections[k] = v;
    }
    return {
      totalPolls: this.totalPolls,
      totalHttpRequests: this.totalHttpRequests,
      rateLimitsEncountered: this.rateLimitsEncountered,
      timeoutsEncountered: this.timeoutsEncountered,
      totalPoolsFetched: this.totalPoolsFetched,
      unseenPoolsCount: this.unseenPoolsCount,
      maturePoolsSkipped: this.maturePoolsSkipped,
      missingAgePoolsCount: this.missingAgePoolsCount,
      invalidAgePoolsCount: this.invalidAgePoolsCount,
      futureDatedAgePoolsCount: this.futureDatedAgePoolsCount,
      nonSolPairsCount: this.nonSolPairsCount,
      eligiblePoolsCount: this.eligiblePoolsCount,
      rejectionCountsByReason: rejections,
      seenPoolIdsCount: this.seenPoolIds.size,
      lastPollEpochMs: this.lastPollEpochMs,
    };
  }

  /**
   * Executes a bounded discovery poll against the Raydium standard pool catalog.
   */
  public async pollDiscoveredCandidates(context: {
    sessionId: string;
    generationId: string;
  }): Promise<DiscoveredRaydiumCandidateResult[]> {
    this.totalPolls++;
    const now = Date.now();

    // Respect Retry-After backoff if currently active
    if (now < this.retryAfterUntilEpochMs) {
      this.onLog?.(
        `Poll skipped: rate-limit backoff active until ${new Date(this.retryAfterUntilEpochMs).toISOString()}`,
      );
      return [];
    }

    // Respect minimum inter-request spacing (D25-R5)
    if (this.lastRequestEpochMs > 0 && now - this.lastRequestEpochMs < this.minRequestIntervalMs) {
      this.onLog?.(
        `Poll skipped: inter-request interval not elapsed (${now - this.lastRequestEpochMs}ms < ${this.minRequestIntervalMs}ms)`,
      );
      return [];
    }

    const requestUrl = `${RAYDIUM_POOLS_INFO_LIST_ENDPOINT}?poolType=standard&poolSortField=default&sortType=desc&pageSize=${this.pageSize}&page=1`;
    this.lastPollEpochMs = now;
    this.onLog?.(`Polling Raydium API v3 catalog from ${requestUrl}`);

    const requestEpochMs = Date.now();
    const fetchResult = await this.executeGetJsonWithStatus(requestUrl);
    const receiptEpochMs = Date.now();

    if (
      fetchResult.status === "RATE_LIMITED" ||
      fetchResult.status === "ERROR" ||
      !fetchResult.data
    ) {
      return [];
    }

    const parseResult = parseRaydiumApiPoolListResponse(fetchResult.data, receiptEpochMs);
    this.totalPoolsFetched += parseResult.totalPoolsInPayload;
    this.missingAgePoolsCount += parseResult.missingOpenTimeCount;
    this.invalidAgePoolsCount += parseResult.invalidOpenTimeCount;
    this.futureDatedAgePoolsCount += parseResult.futureDatedOpenTimeCount;
    this.nonSolPairsCount += parseResult.nonSolPoolsCount;

    if (!parseResult.ok || parseResult.pools.length === 0) {
      this.onLog?.(
        `Raydium catalog response contained 0 pools or parse errors: ${parseResult.parseErrors.join("; ") || "empty list"}`,
      );
      return [];
    }

    this.onLog?.(
      `Received ${parseResult.pools.length} pool(s) from Raydium catalog (total in payload: ${parseResult.totalPoolsInPayload})`,
    );

    const results: DiscoveredRaydiumCandidateResult[] = [];

    for (const pool of parseResult.pools) {
      const isNewPool = !this.seenPoolIds.has(pool.poolId);
      this.seenPoolIds.add(pool.poolId);

      // Primary deduplication: skip pools already seen in this session (D25-R4)
      if (!isNewPool) {
        continue;
      }

      this.unseenPoolsCount++;

      // Filter evaluations (D25-R1 / D25-R4)
      const filterEvaluations: Array<{
        filterName: string;
        passed: boolean;
        observed: unknown;
        threshold: unknown;
        rejectionReason?: string | undefined;
      }> = [];
      const rejectionReasons: string[] = [];

      // 1. Solana WSOL Pairing Orientation Check
      const orientationPassed = pool.orientation !== "NON_SOL_PAIR";
      filterEvaluations.push({
        filterName: "WSOL_PAIR_ORIENTATION",
        passed: orientationPassed,
        observed: pool.orientation,
        threshold: "TOKEN_BASE_SOL_QUOTE | SOL_BASE_TOKEN_QUOTE",
        rejectionReason: orientationPassed
          ? undefined
          : `Pool is not paired with canonical WSOL (base: ${pool.baseTokenSymbol}, quote: ${pool.quoteTokenSymbol})`,
      });
      if (!orientationPassed) {
        rejectionReasons.push("NON_SOL_PAIR");
      }

      // 2. Standard AMM v4 Classification Check
      const ammPassed = pool.isRaydiumStandardAmmCandidate;
      filterEvaluations.push({
        filterName: "RAYDIUM_STANDARD_AMM",
        passed: ammPassed,
        observed: `${pool.poolType}:${pool.programId || "unknown"}`,
        threshold: "Standard AMM v4",
        rejectionReason: ammPassed
          ? undefined
          : `Pool type '${pool.poolType}' is not an eligible Raydium standard AMM v4 pool`,
      });
      if (!ammPassed && orientationPassed) {
        rejectionReasons.push("NON_RAYDIUM_STANDARD_AMM");
      }

      // 3. Pool Age Freshness Evaluation (D25-R1 / D25-R2)
      let agePassed = true;
      let ageRejectionReason: string | undefined = undefined;

      if (this.maxPoolAgeSec === 0) {
        // Filter-disabled mode: Gate 1 connectivity testing (D25-R2)
        agePassed = true;
      } else {
        if (pool.openTimeStatus === "MISSING") {
          agePassed = false;
          ageRejectionReason = "MISSING_OPEN_TIME";
        } else if (pool.openTimeStatus === "INVALID") {
          agePassed = false;
          ageRejectionReason = "INVALID_OPEN_TIME";
        } else if (pool.openTimeStatus === "FUTURE_DATED") {
          agePassed = false;
          ageRejectionReason = "FUTURE_DATED_OPEN_TIME";
        } else if (
          pool.poolAgeAtDiscoverySec !== null &&
          pool.poolAgeAtDiscoverySec > this.maxPoolAgeSec
        ) {
          agePassed = false;
          ageRejectionReason = `EXCEEDS_MAX_POOL_AGE:${pool.poolAgeAtDiscoverySec}s>${this.maxPoolAgeSec}s`;
          this.maturePoolsSkipped++;
        }
      }

      filterEvaluations.push({
        filterName: "POOL_AGE_FRESHNESS",
        passed: agePassed,
        observed:
          pool.poolAgeAtDiscoverySec !== null
            ? `${pool.poolAgeAtDiscoverySec}s (${pool.openTimeStatus})`
            : pool.openTimeStatus,
        threshold: this.maxPoolAgeSec === 0 ? "FILTER_DISABLED" : `<=${this.maxPoolAgeSec}s`,
        rejectionReason: ageRejectionReason,
      });

      if (!agePassed && ageRejectionReason) {
        const reasonCode = ageRejectionReason.split(":")[0] ?? "EXCEEDS_MAX_POOL_AGE";
        rejectionReasons.push(reasonCode);
      }

      const passedEligibility = orientationPassed && ammPassed && agePassed;
      const decisionCohort = passedEligibility ? "WATCHLIST_RADAR" : "FILTERED_REJECTED";

      if (passedEligibility) {
        this.eligiblePoolsCount++;
        this.onLog?.(
          `Discovered eligible Raydium standard pool ${pool.poolId} for mint ${pool.targetMintAddress} (${pool.targetMintSymbol}) [orientation: ${pool.orientation}, age: ${pool.poolAgeAtDiscoverySec ?? "unknown"}s]`,
        );
      } else {
        const primaryReason = rejectionReasons[0] ?? "INELIGIBLE";
        this.rejectionCountsByReason.set(
          primaryReason,
          (this.rejectionCountsByReason.get(primaryReason) ?? 0) + 1,
        );
        this.onLog?.(
          `Pool ${pool.poolId} (${pool.targetMintSymbol}) filtered out: ${primaryReason}`,
        );
      }

      const decisionEpochMs = Date.now();
      const eventId = `evt-ray-${pool.poolId.slice(0, 8)}-${decisionEpochMs}`;

      const candidate: D23ScreenedCandidate = {
        compositeId: {
          decisionEventId: eventId,
          sessionId: context.sessionId,
          generationId: context.generationId,
          mintAddress: pool.targetMintAddress,
          poolId: pool.poolId,
        },
        symbol: pool.targetMintSymbol,
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort,
        selectionBias: "RAYDIUM_API_STANDARD_POOLS",
        decisionEpochMs,
        requestEpochMs,
        receiptEpochMs,
        sourceTimestampMs: null, // Truthful: Raydium API does not attest contemporaneous quote times
        poolOpenTimeMs: pool.openTimeMs,
        poolAgeAtDiscoverySec: pool.poolAgeAtDiscoverySec,
        discoverySource: "raydium",
        passedEligibility,
        filterEvaluations,
        rejectionReasons,
        missingFields: ["sourceTimestampMs"],
        providerIdentity: RAYDIUM_PROVIDER_IDENTITY,
      };

      results.push({
        candidate,
        poolSummary: pool,
        isNewDiscovery: true,
      });
    }

    return results;
  }

  private async executeGetJsonWithStatus(url: string): Promise<{
    data: unknown | null;
    status: "OK" | "RATE_LIMITED" | "ERROR";
    retryAfterSec?: number | undefined;
  }> {
    if (!isAllowlistedRaydiumUrl(url)) {
      throw new Error(`[FORBIDDEN_HTTP_URL] URL '${url}' is not on the Raydium API allowlist`);
    }

    const now = Date.now();
    if (now < this.retryAfterUntilEpochMs) {
      return {
        data: null,
        status: "RATE_LIMITED",
        retryAfterSec: Math.ceil((this.retryAfterUntilEpochMs - now) / 1000),
      };
    }

    // Enforce rate budget
    try {
      this.enforceRateBudget();
    } catch {
      this.onLog?.(`Outbound rate budget of ${this.maxRequestsPerMinute} req/min exceeded`);
      return { data: null, status: "RATE_LIMITED" };
    }

    this.totalHttpRequests++;
    this.lastRequestEpochMs = Date.now();
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
          "User-Agent": `NeXusTrade-Pilot/${D23_STRATEGY_REVISION} (Windows; Research)`,
        },
        signal: controller.signal,
      });

      if (response.status === 429) {
        this.rateLimitsEncountered++;
        const backoffSec = this.handleRateLimit(response);
        this.onLog?.(`HTTP 429 received from Raydium API. Retry-after backoff: ${backoffSec}s`);
        return { data: null, status: "RATE_LIMITED", retryAfterSec: backoffSec };
      }

      if (!response.ok) {
        this.onLog?.(`HTTP error ${response.status} from Raydium API on ${url}`);
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
        `[RAYDIUM_RATE_BUDGET_EXCEEDED] Raydium client exceeded budget of ${this.maxRequestsPerMinute} req/min`,
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
