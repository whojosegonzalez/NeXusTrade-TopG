/**
 * Phase 12.94-D Milestone D.2.2: Deterministic Offline Mock Market Data Provider
 *
 * Implements pure offline mock market data provider with programmable adversarial
 * scenarios for testing rate-limits, timeouts, clock skew, and missing data.
 * ZERO network imports, ZERO external socket calls, ZERO API credentials.
 */

import type {
  IMarketDataProvider,
  IVirtualClock,
  PointInTimeHoldings,
  PointInTimeMetrics,
  PointInTimeReserves,
  ProviderCapabilityStatus,
} from "./ShadowCollectorTypes.js";

/**
 * Standard deterministic virtual clock implementation.
 */
export class DeterministicVirtualClock implements IVirtualClock {
  private currentEpochMs: number;
  private currentMonotonicMs: number;

  constructor(initialEpochMs: number = 1_792_000_000_000) {
    this.currentEpochMs = initialEpochMs;
    this.currentMonotonicMs = 0;
  }

  public now(): number {
    return this.currentEpochMs;
  }

  public monotonicNow(): number {
    return this.currentMonotonicMs;
  }

  public advanceBy(ms: number): void {
    if (ms < 0 || !Number.isFinite(ms)) {
      throw new Error(
        `[DeterministicVirtualClock] advanceBy requires positive finite ms (got ${ms}).`,
      );
    }
    this.currentEpochMs += ms;
    this.currentMonotonicMs += ms;
  }
}

/**
 * Deterministic offline mock provider with programmable failure modes.
 */
export class MockMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly capabilityStatus: ProviderCapabilityStatus;
  private readonly clock: IVirtualClock;

  // Programmable responses
  private reservesMap: Map<string, Partial<PointInTimeReserves>> = new Map();
  private metricsMap: Map<string, Partial<PointInTimeMetrics>> = new Map();
  private holdingsMap: Map<string, Partial<PointInTimeHoldings>> = new Map();

  // Failure simulation configurations
  private simulatedTimeouts: Set<string> = new Set();
  private remaining429Counts: Map<string, number> = new Map();
  private remaining503Counts: Map<string, number> = new Map();
  private omittedFields: Set<string> = new Set();
  private clockSkewMs: number = 0;
  private poolMismatchOverride?: string | undefined;
  private unverifiedVaultOverride?: boolean | undefined;
  private unknownDevAuthorityOverride?: boolean | undefined;

  // Telemetry metrics
  public totalReservesRequests: number = 0;
  public totalMetricsRequests: number = 0;
  public totalHoldingsRequests: number = 0;

  private simulatedRoundTripMs: number = 0;

  constructor(options?: {
    providerId?: string;
    clock?: IVirtualClock;
    capabilityStatus?: ProviderCapabilityStatus;
    simulatedRoundTripMs?: number;
  }) {
    this.providerId = options?.providerId ?? "mock_offline_market_provider";
    this.clock = options?.clock ?? new DeterministicVirtualClock();
    this.capabilityStatus = options?.capabilityStatus ?? "UNVERIFIED_DESIGN_EXPECTATION";
    this.simulatedRoundTripMs = options?.simulatedRoundTripMs ?? 0;
  }

  public setSimulatedRoundTripMs(ms: number): void {
    this.simulatedRoundTripMs = ms;
  }

  public setReservesResponse(poolId: string, response: Partial<PointInTimeReserves>): void {
    this.reservesMap.set(poolId, response);
  }

  public setMetricsResponse(mintAddress: string, response: Partial<PointInTimeMetrics>): void {
    this.metricsMap.set(mintAddress, response);
  }

  public setHoldingsResponse(mintAddress: string, response: Partial<PointInTimeHoldings>): void {
    this.holdingsMap.set(mintAddress, response);
  }

  public simulateTimeout(
    endpoint: "reserves" | "metrics" | "holdings",
    enabled: boolean = true,
  ): void {
    if (enabled) {
      this.simulatedTimeouts.add(endpoint);
    } else {
      this.simulatedTimeouts.delete(endpoint);
    }
  }

  public simulateRateLimit429(endpoint: "reserves" | "metrics" | "holdings", count: number): void {
    this.remaining429Counts.set(endpoint, count);
  }

  public simulateServerError503(
    endpoint: "reserves" | "metrics" | "holdings",
    count: number,
  ): void {
    this.remaining503Counts.set(endpoint, count);
  }

  public setOmittedFields(fields: string[]): void {
    this.omittedFields = new Set(fields);
  }

  public setClockSkewMs(skewMs: number): void {
    this.clockSkewMs = skewMs;
  }

  public setPoolMismatchOverride(mismatchedPoolId?: string): void {
    this.poolMismatchOverride = mismatchedPoolId;
  }

  public setUnverifiedVaultOverride(unverified?: boolean): void {
    this.unverifiedVaultOverride = unverified;
  }

  public setUnknownDevAuthorityOverride(unknown?: boolean): void {
    this.unknownDevAuthorityOverride = unknown;
  }

  private checkFailureInjection(endpoint: "reserves" | "metrics" | "holdings"): void {
    if (this.simulatedTimeouts.has(endpoint)) {
      throw new Error(
        `[MockMarketDataProvider] [TIMEOUT] Simulated timeout on endpoint '${endpoint}'.`,
      );
    }

    const count429 = this.remaining429Counts.get(endpoint) ?? 0;
    if (count429 > 0) {
      this.remaining429Counts.set(endpoint, count429 - 1);
      const error = Object.assign(
        new Error(`[MockMarketDataProvider] [HTTP_429] Rate limit exceeded on '${endpoint}'.`),
        { status: 429, code: "TOO_MANY_REQUESTS" },
      );
      throw error;
    }

    const count503 = this.remaining503Counts.get(endpoint) ?? 0;
    if (count503 > 0) {
      this.remaining503Counts.set(endpoint, count503 - 1);
      const error = Object.assign(
        new Error(`[MockMarketDataProvider] [HTTP_503] Service unavailable on '${endpoint}'.`),
        { status: 503, code: "SERVICE_UNAVAILABLE" },
      );
      throw error;
    }
  }

  public async getPoolReserves(poolId: string): Promise<PointInTimeReserves> {
    this.totalReservesRequests++;
    this.checkFailureInjection("reserves");

    const requestInitiatedMs = this.clock.now();
    if (this.simulatedRoundTripMs > 0) {
      this.clock.advanceBy(this.simulatedRoundTripMs);
    }
    const responseReceivedMs = this.clock.now();

    const base = this.reservesMap.get(poolId);
    const effectivePoolId = this.poolMismatchOverride ?? base?.poolId ?? poolId;

    const sourceTimestampMs = base?.sourceTimestampMs ?? requestInitiatedMs - 20 + this.clockSkewMs;

    return {
      poolId: effectivePoolId,
      baseReserve: this.omittedFields.has("baseReserve") ? null : (base?.baseReserve ?? 1_000_000),
      quoteReserve: this.omittedFields.has("quoteReserve") ? null : (base?.quoteReserve ?? 50),
      sourceTimestampMs,
      ingestionTimestampMs: requestInitiatedMs,
      responseReceivedMs,
      isVerifiedPool: this.unverifiedVaultOverride ? false : (base?.isVerifiedPool ?? true),
      vaultA: this.unverifiedVaultOverride
        ? undefined
        : (base?.vaultA ?? "VaultBase1111111111111111111111111111111111"),
      vaultB: this.unverifiedVaultOverride
        ? undefined
        : (base?.vaultB ?? "VaultQuote111111111111111111111111111111111"),
    };
  }

  public async getTokenMetrics(mintAddress: string): Promise<PointInTimeMetrics> {
    this.totalMetricsRequests++;
    this.checkFailureInjection("metrics");

    const requestInitiatedMs = this.clock.now();
    if (this.simulatedRoundTripMs > 0) {
      this.clock.advanceBy(this.simulatedRoundTripMs);
    }
    const responseReceivedMs = this.clock.now();

    const base = this.metricsMap.get(mintAddress);
    const sourceTimestampMs = base?.sourceTimestampMs ?? requestInitiatedMs - 15 + this.clockSkewMs;

    return {
      mintAddress,
      volume5mUsd: this.omittedFields.has("volume5mUsd") ? null : (base?.volume5mUsd ?? 15_000),
      buys5m: this.omittedFields.has("buys5m") ? null : (base?.buys5m ?? 42),
      sells5m: this.omittedFields.has("sells5m") ? null : (base?.sells5m ?? 12),
      txCount5m: this.omittedFields.has("txCount5m") ? null : (base?.txCount5m ?? 54),
      sourceTimestampMs,
      ingestionTimestampMs: requestInitiatedMs,
      responseReceivedMs,
    };
  }

  public async getDeveloperHoldings(mintAddress: string): Promise<PointInTimeHoldings> {
    this.totalHoldingsRequests++;
    this.checkFailureInjection("holdings");

    const requestInitiatedMs = this.clock.now();
    if (this.simulatedRoundTripMs > 0) {
      this.clock.advanceBy(this.simulatedRoundTripMs);
    }
    const responseReceivedMs = this.clock.now();

    const base = this.holdingsMap.get(mintAddress);
    const sourceTimestampMs = base?.sourceTimestampMs ?? requestInitiatedMs - 25 + this.clockSkewMs;

    const isUnknownAuthority =
      this.unknownDevAuthorityOverride ?? base?.isVerifiedDevWallet === false;

    return {
      mintAddress,
      devHoldingPct:
        isUnknownAuthority || this.omittedFields.has("devHoldingPct")
          ? null
          : (base?.devHoldingPct ?? 2.5),
      lpBurnPct: this.omittedFields.has("lpBurnPct") ? null : (base?.lpBurnPct ?? 100),
      devWalletAddress: isUnknownAuthority
        ? undefined
        : (base?.devWalletAddress ?? "DevWallet111111111111111111111111111111111"),
      isVerifiedDevWallet: !isUnknownAuthority,
      sourceTimestampMs,
      ingestionTimestampMs: requestInitiatedMs,
      responseReceivedMs,
    };
  }
}
