/**
 * Phase 12.94-D Milestone D.3.3: Global Resource Budget Manager
 *
 * Genuinely global resource controller enforcing shared limits across ALL external calls:
 * - Candidate discovery polling
 * - Candidate enrichment lookups
 * - Initial price/market-data lookups
 * - Forward-horizon price observations (+5m, +15m, +30m, +60m)
 * - Any retries
 *
 * OPERATIONAL INVARIANTS:
 * 1. Hard ceiling of 120 total external requests.
 * 2. Minimum 2,500 ms spacing between requests to the same provider.
 * 3. 3 consecutive HTTP 429 responses trigger fail-closed intake stop.
 * 4. Tracks call counts strictly by purpose.
 * 5. Zero unmetered network activity.
 */

export type RequestPurpose =
  | "DISCOVERY_POLL"
  | "CANDIDATE_ENRICHMENT"
  | "INITIAL_QUOTE"
  | "FORWARD_OBSERVATION"
  | "RETRY";

export interface GlobalBudgetStats {
  readonly totalRequests: number;
  readonly discoveryRequests: number;
  readonly enrichmentRequests: number;
  readonly initialQuoteRequests: number;
  readonly forwardObservationRequests: number;
  readonly retries: number;
  readonly consecutive429sEncountered: number;
  readonly isStopTriggered429: boolean;
}

export interface GlobalBudgetOptions {
  readonly maxTotalRequests?: number | undefined; // default 120
  readonly minProviderSpacingMs?: number | undefined; // default 2,500 ms
  readonly clock?: () => number;
}

export class GlobalResourceBudgetManager {
  private readonly maxTotalRequests: number;
  private readonly minProviderSpacingMs: number;
  private readonly clock: () => number;

  private totalRequests = 0;
  private discoveryRequests = 0;
  private enrichmentRequests = 0;
  private initialQuoteRequests = 0;
  private forwardObservationRequests = 0;
  private retries = 0;

  private consecutive429Count = 0;
  private is429StopTriggered = false;

  private readonly lastRequestTimeByProvider = new Map<string, number>();

  constructor(options: GlobalBudgetOptions = {}) {
    this.maxTotalRequests = options.maxTotalRequests ?? 120;
    this.minProviderSpacingMs = options.minProviderSpacingMs ?? 2500;
    this.clock = options.clock ?? (() => Date.now());
  }

  public getStats(): GlobalBudgetStats {
    return {
      totalRequests: this.totalRequests,
      discoveryRequests: this.discoveryRequests,
      enrichmentRequests: this.enrichmentRequests,
      initialQuoteRequests: this.initialQuoteRequests,
      forwardObservationRequests: this.forwardObservationRequests,
      retries: this.retries,
      consecutive429sEncountered: this.consecutive429Count,
      isStopTriggered429: this.is429StopTriggered,
    };
  }

  public canMakeRequest(
    providerName: string,
    nowMs?: number,
  ): { allowed: boolean; reason?: string; waitMs?: number } {
    if (this.totalRequests >= this.maxTotalRequests) {
      return { allowed: false, reason: "GLOBAL_REQUEST_CEILING_REACHED" };
    }

    const now = nowMs ?? this.clock();
    const lastTime = this.lastRequestTimeByProvider.get(providerName) ?? 0;
    const elapsed = now - lastTime;
    if (elapsed < this.minProviderSpacingMs) {
      const waitMs = this.minProviderSpacingMs - elapsed;
      return {
        allowed: false,
        reason: "PROVIDER_PACING_NOT_MET",
        waitMs,
      };
    }

    return { allowed: true };
  }

  public recordRequestAttempt(
    providerName: string,
    purpose: RequestPurpose,
    nowMs?: number,
  ): boolean {
    const check = this.canMakeRequest(providerName, nowMs);
    if (!check.allowed) {
      return false;
    }

    const now = nowMs ?? this.clock();
    this.totalRequests++;
    this.lastRequestTimeByProvider.set(providerName, now);

    switch (purpose) {
      case "DISCOVERY_POLL":
        this.discoveryRequests++;
        break;
      case "CANDIDATE_ENRICHMENT":
        this.enrichmentRequests++;
        break;
      case "INITIAL_QUOTE":
        this.initialQuoteRequests++;
        break;
      case "FORWARD_OBSERVATION":
        this.forwardObservationRequests++;
        break;
      case "RETRY":
        this.retries++;
        break;
    }

    return true;
  }

  public recordResponseStatus(statusCode: number): void {
    if (statusCode === 429) {
      this.consecutive429Count++;
      if (this.consecutive429Count >= 3) {
        this.is429StopTriggered = true;
      }
    } else if (statusCode >= 200 && statusCode < 300) {
      this.consecutive429Count = 0;
    }
  }

  public is429HaltRequired(): boolean {
    return this.is429StopTriggered;
  }

  public getRemainingRequests(): number {
    return Math.max(0, this.maxTotalRequests - this.totalRequests);
  }

  public getTotalRequests(): number {
    return this.totalRequests;
  }
}
