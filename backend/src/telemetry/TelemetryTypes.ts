/**
 * Phase 12.94-B Market Telemetry Engine: Core Types and Schemas
 *
 * Implements immutable candidate discovery and decision logging, point-in-time
 * market observations, stratified counterfactual tracking, and zero-lookahead decision context reconstruction.
 */

export type DecisionCohort =
  | "FILTERED_REJECTED"
  | "WATCHLIST_RADAR"
  | "TRIGGER_REJECTED"
  | "EXECUTED_BUY";

export type MetricProvenance = "OBSERVED" | "DERIVED" | "PLACEHOLDER" | "UNAVAILABLE";

export interface FilterEvaluationDetail {
  readonly filterName: string;
  readonly passed: boolean;
  readonly valueObserved: number | string | boolean | null;
  readonly threshold: number | string | boolean | null;
  readonly rejectionReason?: string | undefined;
}

export interface CandidateMetricsSnapshot {
  readonly tokenAgeSec: number | null;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly lmcRatio: number | null;
  readonly lpBurnPct: number | null;
  readonly spotPriceUsd: number | null;
  readonly spotPriceSol?: number | null | undefined;
  readonly volume5mUsd: number | null;
  readonly txCount5m: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly metricProvenance?: Partial<Record<string, MetricProvenance>> | undefined;
}

export interface CandidateDecisionRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly decisionTimestampMs: number;
  readonly poolOpenTimeMs?: number | undefined;
  readonly poolAgeAtDiscoverySec?: number | undefined;
  readonly firstSeenEpochMs?: number | undefined;
  readonly discoverySource?: string | undefined;
  readonly discoveryEndpoint?: string | undefined;
  readonly discoveryPage?: number | undefined;
  readonly discoverySortField?: string | undefined;
  readonly discoveryPollCycle?: number | undefined;
  readonly isInitialCatalogSnapshot?: boolean | undefined;
  readonly strategyRevision: string;
  readonly decisionCohort: DecisionCohort;
  readonly primaryRejectionReason?: string | undefined;
  readonly filterEvaluations: readonly FilterEvaluationDetail[];
  readonly metricsSnapshot: CandidateMetricsSnapshot;
  readonly missingFields: readonly string[];
  readonly providerIdentity: string;
}

export type PriceSourceType = "POOL_RESERVE" | "ROUTE_QUOTE" | "INDEXED_TICK";

export interface MeasurementWindow {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly durationSec: number;
}

export interface MarketObservationRecord {
  readonly observationId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly requestInitiatedMs?: number | undefined;
  readonly responseReceivedMs?: number | undefined;
  readonly dataFreshnessMs: number;
  readonly measurementWindow: MeasurementWindow;
  readonly derivationStatus?:
    | "RAW"
    | "DERIVED_FROM_5M"
    | "DERIVED_FROM_1H"
    | "DIRECT_OBSERVATION"
    | undefined;
  readonly providerIdentity: string;
  readonly actualResponsePoolId?: string | undefined;
  readonly priceMetrics: {
    readonly spotPriceUsd: number | null;
    readonly spotPriceSol: number | null;
    readonly priceSource: PriceSourceType;
  };
  readonly liquidityMetrics: {
    readonly baseReserve: number | null;
    readonly quoteReserve: number | null;
    readonly liquidityUsd: number | null;
  };
  readonly flowMetrics: {
    readonly txCount: number | null;
    readonly buys: number | null;
    readonly sells: number | null;
    readonly volumeUsd: number | null;
    readonly netBuyerVolumeUsd: number | null;
  };
  readonly holderMetrics?:
    | {
        readonly top10ConcentrationPct: number;
        readonly devHoldingPct: number;
        readonly totalHolders: number;
      }
    | undefined;
  readonly missingFields: readonly string[];
  readonly strategyRevision: string;
  readonly clockSkewWarning?: string | undefined;
  readonly onChainSlot?: number | null | undefined;
  readonly flowMeasurementWindowSec?: number | null | undefined;
}

/**
 * Normalizes and verifies whether a provider's actual response pool ID matches
 * an expected tracked pool ID (strips 'dexscreener-' prefix, trims, lowercases).
 * Fails closed (returns false) if actualResponsePoolId is missing, empty, or not a string.
 */
export function isVerifiedMatchingPool(
  actualResponsePoolId: string | null | undefined,
  expectedPoolId: string,
): boolean {
  if (!actualResponsePoolId || typeof actualResponsePoolId !== "string") {
    return false;
  }
  const normActual = actualResponsePoolId
    .trim()
    .toLowerCase()
    .replace(/^dexscreener-/, "");
  const normExpected = expectedPoolId
    .trim()
    .toLowerCase()
    .replace(/^dexscreener-/, "");
  return normActual.length > 0 && normActual === normExpected;
}

export type StratificationTier =
  | "EXECUTED_POSITION"
  | "WATCHLIST_ACTIVE"
  | "NEAR_MISS_CANDIDATE"
  | "HARD_REJECT_BASELINE"
  | "EXCLUDED_SPAM";

export type StratifiedSamplingStatus =
  | "TRACKING_ACTIVE"
  | "EXPIRED"
  | "TERMINATED_EARLY"
  | "NOT_SELECTED"
  | "DROPPED_CAPACITY"
  | "EXCLUDED_SPAM";

export interface StratifiedSamplingRecord {
  readonly trackingId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly decisionEventId: string;
  readonly tier: StratificationTier;
  readonly samplingProbability: number;
  readonly effectiveInclusionProbability: number;
  readonly ipwEstimable: boolean;
  readonly selectionSeed: string;
  readonly selectionReason?: string | undefined;
  readonly trackingStartedMs: number;
  readonly trackingExpiresMs: number;
  readonly lastObservationMs?: number | undefined;
  readonly currentSamplingIntervalMs: number;
  readonly observationCount: number;
  readonly initialPriceSol: number | null;
  readonly peakPriceSol: number | null;
  readonly peakGainPct: number;
  readonly troughPriceSol: number | null;
  readonly maxDrawdownPct: number;
  readonly latestPriceSol: number | null;
  readonly status: StratifiedSamplingStatus;
  readonly promotedFromTier?: StratificationTier | undefined;
  readonly promotedAtMs?: number | undefined;
}

export interface SessionTelemetryMeta {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly startedAtIso: string;
  readonly closedAtIso?: string | undefined;
  readonly initialWalletBalanceSol: number;
  readonly environment: {
    readonly platform: string;
    readonly nodeVersion: string;
  };
  readonly sessionStatus?: "ACTIVE" | "INTERRUPTED" | "FINALIZED" | undefined;
  readonly isInterruptedSession?: boolean | undefined;
  readonly resumedFromPriorCrash?: boolean | undefined;
  readonly discoverySource?: "dexscreener" | "raydium" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
}

export interface SessionTelemetrySummary {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly startedAtIso: string;
  readonly closedAtIso: string;
  readonly totalCandidatesScreened: number;
  readonly totalScannerDecisionsRecorded?: number | undefined;
  readonly totalTriggerDecisionsRecorded?: number | undefined;
  readonly totalExecutedBuyDecisionsRecorded?: number | undefined;
  readonly totalDecisionsRecorded: number;
  readonly decisionWriteFailures: number;
  readonly decisionCallbackErrors?: number | undefined;
  readonly rateShedCount?: number | undefined;
  readonly cohortBreakdown: {
    readonly filteredRejected: number;
    readonly watchlistRadar: number;
    readonly triggerRejected: number;
    readonly executedBuy: number;
  };
  readonly topRejectionReasons: Record<string, number>;
  readonly totalMarketObservationsRecorded: number;
  readonly totalStratifiedCandidatesTracked: number;
  readonly missedWinnersCount: number;
  readonly avoidedRugsCount: number;
  readonly isCompleteSession?: boolean | undefined;
  readonly isInterruptedSession?: boolean | undefined;
  readonly discoverySource?: "dexscreener" | "raydium" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly discoveryFunnel?: DiscoveryFunnelMetrics | undefined;
}

export interface DiscoveryFunnelMetrics {
  /** Total raw pool entries returned across all API responses (impressions). */
  readonly apiPoolsReturned: number;
  /** Total count of distinct pool IDs discovered (uniquePoolsEncountered + repeatedPoolsSuppressed === apiPoolsReturned). */
  readonly uniquePoolsEncountered: number;
  /** Count of duplicate pool entries suppressed across subsequent polls/pages. */
  readonly repeatedPoolsSuppressed: number;
  /** Count of unique pool IDs discovered in the initial baseline catalog poll (poll 1). */
  readonly initialSnapshotPoolsEncountered: number;
  /** Count of previously unseen unique pool IDs appearing on subsequent polls (poll 2+). */
  readonly laterPollArrivalsEncountered: number;
  /** Unique pools failing pre-verification checks (denominator: uniquePoolsEncountered). */
  readonly preVerificationExclusions: {
    readonly nonSolPairs: number;
    readonly nonStandardAmm: number;
    readonly missingOpenTime: number;
    readonly invalidOpenTime: number;
    readonly futureDatedOpenTime: number;
    readonly exceedsMaxPoolAge: number;
    /** Distinct unique pools excluded. Note: sum of subcategories may exceed this due to overlapping defects. */
    readonly totalPreVerificationExcluded: number;
  };
  /** Unique pools classified by API-reported opening time status (denominator: uniquePoolsEncountered). */
  readonly poolAgeClassifications: {
    readonly validAgeCount: number;
    readonly missingAgeCount: number;
    readonly invalidAgeCount: number;
    readonly futureDatedAgeCount: number;
    /** Unique pools whose API-reported age satisfied the age filter threshold. */
    readonly confirmedAgeFilterPasses: number;
    /** API-reported fresh pools present in the initial baseline snapshot (poll 1). */
    readonly initialSnapshotFreshPasses: number;
    /** API-reported fresh pools arriving on subsequent polls (poll 2+). */
    readonly laterPollFreshArrivals: number;
    /** Unique pools excluded due to missing, invalid, future-dated, or mature age. */
    readonly ageFilterExclusions: number;
  };
  /** Unique pools that passed all pre-verification filters and were queued for on-chain verification. */
  readonly eligibleForVerification: number;
  /** On-chain Solana RPC verification calls attempted. */
  readonly verificationAttempts: number;
  /** Unique pools independently confirmed on-chain as canonical Raydium AMM v4 (WATCHLIST_RADAR). */
  readonly verifiedAmmV4Pools: number;
  /** Pools confirmed ineligible by on-chain state (unauthorized program, null account, etc.). */
  readonly confirmedOnChainIneligible: number;
  /** Transient Solana RPC provider failures (HTTP 429, timeout, network error). */
  readonly rpcProviderUnavailable: number;
  /** Candidates whose RPC verification retries were exhausted without on-chain confirmation. */
  readonly rpcRetriesExhausted: number;
  /** Screened candidates left unreached due to early stopping conditions. */
  readonly unreachedCandidatesDueToStopping: number;
}

export interface ReconstructedDecisionContext {
  readonly decisionRecord: CandidateDecisionRecord;
  readonly preDecisionWindow: readonly MarketObservationRecord[];
  readonly inTradeWindow?: readonly MarketObservationRecord[] | undefined;
  readonly postExitWindow?: readonly MarketObservationRecord[] | undefined;
  /**
   * Reconstructed order book / market state at point-in-time decision.
   * Price units are strictly maintained without cross-currency coercion.
   */
  readonly reconstructedOrderBook: {
    readonly estimatedSpotSol: number | null;
    readonly bestAvailableLiquidityUsd: number | null;
    readonly observedPriceImpactBps: number | null;
  };
  readonly reconstructedMarketState: {
    readonly latestSpotPriceSol: number | null;
    readonly latestSpotPriceUsd: number | null;
    readonly bestAvailableLiquidityUsd: number | null;
    readonly estimatedPriceImpactBps: number | null;
    readonly priceSource: PriceSourceType | "DECISION_SNAPSHOT" | "UNKNOWN";
  };
  readonly dataQualityScore: number;
  readonly missingDataFields: readonly string[];
}
