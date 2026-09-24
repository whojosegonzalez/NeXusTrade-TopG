export type ExploratoryCohortFormat = "markdown" | "json";
export type ExploratoryCohortInvocationMode = "COLLECT_SLOT" | "FINALIZE_MISSED_SLOTS";
export type ExploratoryCohortPartition = "DISCOVERY" | "VALIDATION";
export type ExploratoryCohortAvailability =
  | "AVAILABLE_AT_ANCHOR"
  | "NOT_REQUESTED"
  | "UNAVAILABLE_AT_ANCHOR"
  | "STALE_AT_ANCHOR"
  | "BUDGET_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "UNSUPPORTED"
  | "INVALID_VALUE";
export type LaterAvailability = "OBSERVED_ON_TIME" | "OBSERVED_LATE" | "MISSING" | "INVALID";
export type CohortOutcome =
  | "COLLECTING"
  | "COHORT_COMPLETE"
  | "COHORT_INCOMPLETE"
  | "COHORT_STOPPED_DATA_QUALITY"
  | "HUMAN_REVIEW_REQUIRED";
export type ProviderCategory =
  | "DISCOVERY"
  | "MARKET_CONTEXT"
  | "QUOTE_IMPACT"
  | "LATER_OBSERVATION";

export interface ExploratoryCohortConfig {
  readonly protocol: string;
  readonly archiveRoot: string;
  readonly archiveStamp: string;
  readonly format: ExploratoryCohortFormat;
  readonly mode: ExploratoryCohortInvocationMode;
  readonly once: boolean;
}

export interface ExploratoryCohortLaunchRecord {
  readonly contractVersion: "1";
  readonly archiveRoot: string;
  readonly cohortStartAt: string;
  readonly protocolPath: string;
  readonly protocolSha256: string;
  readonly protocolValidationFingerprint: string;
  readonly authorization: "USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION";
  readonly authorizationReference: string;
}

export interface DiscoveryCandidate {
  readonly mint: string;
  readonly sourceKind: string;
  readonly firstObservedAt: Date;
}

export interface MarketContext {
  readonly observedAt: Date;
  readonly priceUsd?: number;
  readonly liquidityUsd?: number;
  readonly volume5mUsd?: number;
  readonly volume1hUsd?: number;
  readonly assetCreatedAt?: Date;
}

export interface QuoteImpact {
  readonly observedAt: Date;
  readonly priceImpactBps?: number;
}

export interface GatewayResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly observedAt: Date;
  readonly provider: "DEXSCREENER" | "JUPITER";
  readonly outcomeCode: string;
  readonly latencyMs: number;
}

export interface ExploratoryCohortGateway {
  readonly available: boolean;
  readonly quoteAvailable: boolean;
  discover(limit: 100): Promise<GatewayResult<readonly DiscoveryCandidate[]>>;
  marketContext(mint: string): Promise<GatewayResult<MarketContext>>;
  quoteImpact(mint: string): Promise<GatewayResult<QuoteImpact>>;
  laterPrice(mint: string): Promise<GatewayResult<{ readonly priceUsd?: number }>>;
}

export interface ExploratoryCohortClock {
  now(): Date;
  sleepUntil(target: Date): Promise<void>;
}

export interface SafeFact<T> {
  readonly value?: T;
  readonly availability: ExploratoryCohortAvailability;
  readonly sourceCategory: ProviderCategory | "LOCAL";
  readonly sourceIdentifier: string;
  readonly sourceTimestamp?: string;
}

export interface CohortUnit {
  readonly unitId: string;
  readonly canonicalMint: string;
  readonly anchorAt: string;
  readonly slotId: string;
  readonly partition: ExploratoryCohortPartition;
  readonly decisionTime: {
    readonly discovery: SafeFact<string>;
    readonly market: {
      readonly assetAgeSeconds: SafeFact<number>;
      readonly priceUsd: SafeFact<number>;
      readonly liquidityUsd: SafeFact<number>;
      readonly volume5mUsd: SafeFact<number>;
      readonly volume1hUsd: SafeFact<number>;
      readonly momentum5mPct: SafeFact<number>;
      readonly momentum15mPct: SafeFact<number>;
    };
    readonly quote: {
      readonly available: SafeFact<boolean>;
      readonly priceImpactBps: SafeFact<number>;
    };
    readonly risk: { readonly blockerCodes: SafeFact<readonly string[]> };
    readonly attention: { readonly repeatedAttentionCount: SafeFact<number> };
  };
  readonly laterObservations: readonly LaterObservation[];
}

export interface LaterObservation {
  readonly minutesAfterAnchor: 3 | 5 | 15 | 60;
  readonly availability: LaterAvailability;
  readonly observedAt?: string;
  readonly returnPct?: number;
  readonly reason: string;
}

export interface SlotRecord {
  readonly slotId: string;
  readonly slotIndex: number;
  readonly anchorAt: string;
  readonly state: "NO_SELECTION" | "SKIP_UNIT_WITH_REASON" | "VALID_UNIT" | "PAUSE_WINDOW";
  readonly reason: ExploratoryCohortSlotReason;
  readonly discoveryCounts: {
    readonly returned: number;
    readonly canonical: number;
    readonly technicallyValid: number;
  };
  readonly selectedMint?: string;
}

/** `PAUSE_WINDOW` availability evidence only; it is never a candidate or later-outcome label. */
export type ExploratoryCohortSlotReason =
  | "EXTERNAL_INVOCATION_MISSED"
  | "AWAITING_REQUIRED_ANCHOR"
  | "MISSING_OR_STALE_REQUIRED_ANCHOR_PRICE"
  | "VALID_REQUIRED_ANCHOR"
  | "NO_TECHNICALLY_VALID_CANONICAL_MINT"
  | "DUPLICATE_MINT"
  | `DISCOVERY_${string}`;

export interface SourceInventoryRecord {
  readonly category: ProviderCategory;
  readonly provider: "DEXSCREENER" | "JUPITER";
  readonly capability: string;
  readonly requestCount: number;
  readonly attemptCount: 1;
  readonly outcomeCode: string;
  readonly observedAt: string;
  readonly latencyBucket: "LT_100MS" | "LT_1S" | "GE_1S";
  readonly sourceHash: string;
}

export interface CohortManifest {
  readonly contractVersion: "1";
  readonly archiveRoot: string;
  readonly launch: ExploratoryCohortLaunchRecord;
  readonly executionDisabled: true;
  readonly safety: {
    readonly databaseReads: 0;
    readonly databaseWrites: 0;
    readonly sessions: 0;
    readonly orders: 0;
    readonly fills: 0;
    readonly positions: 0;
    readonly walletLoaded: false;
    readonly transactionSigning: false;
    readonly transactionSubmission: false;
  };
  readonly outcome: CohortOutcome;
  readonly slots: readonly SlotRecord[];
  readonly providerCounts: Readonly<Record<ProviderCategory, number>>;
  readonly activeFileHashes?: Readonly<Record<string, string>>;
  readonly finalFileHashes?: Readonly<Record<string, string>>;
  readonly interruptionReason?: string;
}

export interface ArchiveState {
  readonly manifest: CohortManifest;
  readonly units: readonly CohortUnit[];
  readonly sources: readonly SourceInventoryRecord[];
}

export interface CollectionResult {
  readonly outcome: CohortOutcome;
  readonly archiveRoot: string;
  readonly mode: ExploratoryCohortInvocationMode;
  readonly slotId?: string;
  readonly validUnitCount: number;
  readonly providerCalls: number;
  readonly invocationProviderCalls: number;
  readonly databaseReads: 0;
  readonly databaseWrites: 0;
  readonly runtimeCalls: 0;
  readonly nextPermittedAction: string;
}
