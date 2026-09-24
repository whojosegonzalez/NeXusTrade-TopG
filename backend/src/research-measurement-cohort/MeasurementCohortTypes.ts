export type MeasurementCohortFormat = "markdown" | "json";
export type MeasurementCohortPartition = "DISCOVERY" | "VALIDATION";
export type MeasurementAvailability =
  | "AVAILABLE_AT_ANCHOR"
  | "NOT_REQUESTED"
  | "UNAVAILABLE_AT_ANCHOR"
  | "STALE_AT_ANCHOR"
  | "BUDGET_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "UNSUPPORTED"
  | "INVALID_VALUE";
export type MeasurementProviderCategory = "DISCOVERY" | "MARKET_CONTEXT";
export type MeasurementCohortOutcome =
  | "COLLECTING"
  | "COHORT_COMPLETE"
  | "MEASUREMENT_COHORT_DATA_INSUFFICIENT"
  | "MEASUREMENT_COHORT_DATA_QUALITY_STOP";

export interface MeasurementCohortConfig {
  readonly protocol: string;
  readonly launch: string;
  readonly format: MeasurementCohortFormat;
  readonly once: true;
}

export interface MeasurementCohortLaunchRecord {
  readonly contractVersion: "1";
  readonly archiveRoot: string;
  readonly cohortStartAt: string;
  readonly protocolPath: string;
  readonly protocolSha256: string;
  readonly protocolValidationFingerprint: string;
  readonly authorization: "USER_AUTHORIZED_FOR_ONE_MEASUREMENT_ONLY_COLLECTION";
  readonly authorizationReference: string;
  readonly operator: { readonly kind: "EXTERNAL_OPERATOR"; readonly label: string };
}

export interface MeasurementDiscoveryCandidate {
  readonly mint: string;
  readonly sourceKind: string;
  readonly firstObservedAt: Date;
}

export interface MeasurementMarketContext {
  readonly observedAt: Date;
  readonly priceUsd?: number;
  readonly liquidityUsd?: number;
}

export interface MeasurementGatewayResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly observedAt: Date;
  readonly outcomeCode: string;
  readonly latencyMs: number;
}

/** This injected interface is the only provider surface available to the collector. */
export interface MeasurementCohortGateway {
  discover(limit: 100): Promise<MeasurementGatewayResult<readonly MeasurementDiscoveryCandidate[]>>;
  marketContext(mint: string): Promise<MeasurementGatewayResult<MeasurementMarketContext>>;
}

export interface MeasurementCohortClock {
  now(): Date;
  sleepUntil(target: Date): Promise<void>;
}

export interface MeasurementFact<T> {
  readonly availability: MeasurementAvailability;
  readonly sourceCategory: "MARKET_CONTEXT" | "LOCAL";
  readonly sourceIdentifier: "BEST_PAIR" | "FORMULA";
  readonly sourceTimestamp?: string;
  readonly value?: T;
}

export interface MeasurementSnapshot {
  readonly offsetMinutes: -15 | -10 | -5 | 0;
  readonly scheduledAt: string;
  readonly priceUsd: MeasurementFact<number>;
  readonly liquidityUsd?: MeasurementFact<number>;
}

export interface MeasurementCohortUnit {
  readonly unitId: string;
  readonly slotId: string;
  readonly anchorAt: string;
  readonly canonicalMint: string;
  readonly partition: MeasurementCohortPartition;
  readonly selection: {
    readonly sourceKind: string;
    readonly firstObservedAt: string;
    readonly selectionHash: string;
  };
  readonly decisionTime: {
    readonly snapshots: readonly MeasurementSnapshot[];
    readonly market: {
      readonly liquidityUsd: MeasurementFact<number>;
      readonly momentum5mPct: MeasurementFact<number>;
      readonly momentum15mPct: MeasurementFact<number>;
    };
  };
}

export interface MeasurementSlotRecord {
  readonly slotId: string;
  readonly slotIndex: number;
  readonly anchorAt: string;
  readonly state: "NO_SELECTION" | "SKIP_UNIT_WITH_REASON" | "VALID_UNIT";
  readonly reason:
    | "NO_TECHNICALLY_VALID_CANONICAL_MINT"
    | "DUPLICATE_MINT"
    | "VALID_TECHNICAL_UNIT"
    | `DISCOVERY_${string}`;
  readonly discoveryCounts: {
    readonly returned: number;
    readonly canonical: number;
    readonly technicallyValid: number;
  };
  readonly selectedMint?: string;
}

export interface MeasurementSourceRecord {
  readonly category: MeasurementProviderCategory;
  readonly provider: "DEXSCREENER";
  readonly capability: "DISCOVER_TOKENS" | "BEST_PAIR";
  readonly requestCount: 1;
  readonly attemptCount: 1;
  readonly outcomeCode: string;
  readonly observedAt: string;
  readonly latencyBucket: "LT_100MS" | "LT_1S" | "GE_1S";
  readonly sourceHash: string;
}

export interface MeasurementCohortManifest {
  readonly contractVersion: "1";
  readonly archiveRoot: string;
  readonly launch: MeasurementCohortLaunchRecord;
  readonly executionDisabled: true;
  readonly outcome: MeasurementCohortOutcome;
  readonly slots: readonly MeasurementSlotRecord[];
  readonly providerCounts: Readonly<Record<MeasurementProviderCategory, number>>;
  readonly activeFileHashes?: Readonly<Record<string, string>>;
  readonly finalFileHashes?: Readonly<Record<string, string>>;
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
}

export interface MeasurementArchiveState {
  readonly manifest: MeasurementCohortManifest;
  readonly units: readonly MeasurementCohortUnit[];
  readonly sources: readonly MeasurementSourceRecord[];
}

export interface MeasurementCollectionResult {
  readonly outcome: MeasurementCohortOutcome;
  readonly archiveRoot: string;
  readonly slotId?: string;
  readonly validUnitCount: number;
  readonly providerCalls: number;
  readonly invocationProviderCalls: number;
  readonly databaseReads: 0;
  readonly databaseWrites: 0;
  readonly runtimeCalls: 0;
  readonly nextPermittedAction: string;
}
