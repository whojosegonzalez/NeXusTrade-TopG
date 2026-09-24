import { z } from "zod";

export const EXPLORATORY_MEASUREMENT_AUDIT_CONTRACT_VERSION = "1" as const;

export const auditFormatSchema = z.enum(["markdown", "json"]);
export type ExploratoryMeasurementAuditFormat = z.infer<typeof auditFormatSchema>;

export const availabilitySchema = z.enum([
  "AVAILABLE_AT_ANCHOR",
  "NOT_REQUESTED",
  "UNAVAILABLE_AT_ANCHOR",
  "STALE_AT_ANCHOR",
  "BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "UNSUPPORTED",
  "INVALID_VALUE",
]);
export type MeasurementAvailability = z.infer<typeof availabilitySchema>;
export const measurementAvailabilityCodes = availabilitySchema.options;

export const partitionSchema = z.enum(["DISCOVERY", "VALIDATION"]);
export type MeasurementPartition = z.infer<typeof partitionSchema>;
export const measurementPartitions = partitionSchema.options;

export const auditFieldSchema = z.enum([
  "ASSET_AGE",
  "ANCHOR_PRICE",
  "LIQUIDITY",
  "VOLUME_5M",
  "VOLUME_1H",
  "MOMENTUM_5M",
  "MOMENTUM_15M",
  "QUOTE_AVAILABLE",
  "QUOTE_IMPACT",
]);
export type MeasurementAuditField = z.infer<typeof auditFieldSchema>;

export const catalogFieldSchema = z.enum([
  "AGE",
  "LIQUIDITY",
  "VOLUME_5M",
  "VOLUME_1H",
  "MOMENTUM_5M",
  "MOMENTUM_15M",
  "QUOTE_IMPACT",
]);
export type MeasurementCatalogField = z.infer<typeof catalogFieldSchema>;

export const auditFieldDefinitions = [
  {
    id: "ASSET_AGE",
    catalogField: "AGE",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 300,
  },
  {
    id: "ANCHOR_PRICE",
    catalogField: undefined,
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 60,
  },
  {
    id: "LIQUIDITY",
    catalogField: "LIQUIDITY",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 300,
  },
  {
    id: "VOLUME_5M",
    catalogField: "VOLUME_5M",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 300,
  },
  {
    id: "VOLUME_1H",
    catalogField: "VOLUME_1H",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 300,
  },
  {
    id: "MOMENTUM_5M",
    catalogField: "MOMENTUM_5M",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 300,
  },
  {
    id: "MOMENTUM_15M",
    catalogField: "MOMENTUM_15M",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    freshnessSeconds: 300,
  },
  {
    id: "QUOTE_AVAILABLE",
    catalogField: undefined,
    sourceCategory: "QUOTE_IMPACT",
    sourceIdentifier: "QUOTE",
    freshnessSeconds: 60,
  },
  {
    id: "QUOTE_IMPACT",
    catalogField: "QUOTE_IMPACT",
    sourceCategory: "QUOTE_IMPACT",
    sourceIdentifier: "QUOTE",
    freshnessSeconds: 60,
  },
] as const satisfies readonly {
  readonly id: MeasurementAuditField;
  readonly catalogField?: MeasurementCatalogField | undefined;
  readonly sourceCategory: "MARKET_CONTEXT" | "QUOTE_IMPACT";
  readonly sourceIdentifier: "BEST_PAIR" | "QUOTE";
  readonly freshnessSeconds: 60 | 300;
}[];

export const measurementCatalogFields = auditFieldDefinitions.filter(
  (
    definition,
  ): definition is (typeof auditFieldDefinitions)[number] & {
    readonly catalogField: MeasurementCatalogField;
  } => definition.catalogField !== undefined,
);

export const auditOutcomeSchema = z.enum([
  "MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW",
  "NO_ACTIONABLE_MEASUREMENT_CHANGE",
  "MEASUREMENT_EVIDENCE_INSUFFICIENT",
  "HUMAN_REVIEW_REQUIRED",
]);
export type MeasurementAuditOutcome = z.infer<typeof auditOutcomeSchema>;

export interface MeasurementAuditFact {
  readonly availability: MeasurementAvailability;
  readonly sourceCategory: "MARKET_CONTEXT" | "QUOTE_IMPACT";
  readonly sourceIdentifier: "BEST_PAIR" | "QUOTE";
}

export interface MeasurementAuditUnit {
  readonly partition: MeasurementPartition;
  readonly anchorDate: string;
  readonly facts: Readonly<Record<MeasurementAuditField, MeasurementAuditFact>>;
}

export interface MeasurementAuditSource {
  readonly utcDate: string;
  readonly category: "DISCOVERY" | "MARKET_CONTEXT" | "QUOTE_IMPACT";
  readonly provider: "DEXSCREENER" | "JUPITER";
  readonly capability: "TOKEN_DISCOVERY" | "BEST_PAIR" | "QUOTE_IMPACT";
  readonly outcomeCode: string;
  readonly latencyBucket: "LT_100MS" | "LT_1S" | "GE_1S";
}

export interface LoadedMeasurementAuditArchive {
  readonly finalOutcome:
    | "COHORT_COMPLETE"
    | "COHORT_INCOMPLETE"
    | "COHORT_STOPPED_DATA_QUALITY"
    | "HUMAN_REVIEW_REQUIRED";
  readonly units: readonly MeasurementAuditUnit[];
  readonly sources: readonly MeasurementAuditSource[];
  readonly inventory: Readonly<Record<MeasurementAuditArtifactName, string>>;
}

export const measurementAuditArtifactNames = [
  "cohort-manifest.v1.json",
  "units.v1.ndjson",
  "source-inventory.v1.json",
  "collection-summary.v1.json",
] as const;
export type MeasurementAuditArtifactName = (typeof measurementAuditArtifactNames)[number];

export interface MeasurementAvailabilityLedgerRow {
  readonly field: MeasurementAuditField;
  readonly partition: MeasurementPartition;
  readonly totalDecisionTimeUnits: number;
  readonly availableAtAnchorCount: number;
  readonly availabilityCounts: Readonly<Record<MeasurementAvailability, number>>;
  readonly availabilityPct: number;
}

export interface MeasurementProvenanceLedgerRow {
  readonly field: MeasurementAuditField;
  readonly partition: MeasurementPartition;
  readonly availability: MeasurementAvailability;
  readonly sourceCategory: "MARKET_CONTEXT" | "QUOTE_IMPACT";
  readonly sourceIdentifier: "BEST_PAIR" | "QUOTE";
  readonly count: number;
  readonly utcDateCount: number;
}

export interface MeasurementDateLedgerRow {
  readonly field: MeasurementAuditField;
  readonly utcDate: string;
  readonly totalDecisionTimeUnits: number;
  readonly availableAtAnchorCount: number;
  readonly unavailableCount: number;
  readonly availabilityPct: number;
}

export interface MeasurementSourceInventoryLedgerRow {
  readonly utcDate: string;
  readonly category: "DISCOVERY" | "MARKET_CONTEXT" | "QUOTE_IMPACT";
  readonly provider: "DEXSCREENER" | "JUPITER";
  readonly capability: "TOKEN_DISCOVERY" | "BEST_PAIR" | "QUOTE_IMPACT";
  readonly outcomeCode: string;
  readonly latencyBucket: "LT_100MS" | "LT_1S" | "GE_1S";
  readonly count: number;
}

export interface MeasurementSignature {
  readonly availability: MeasurementAvailability;
  readonly sourceCategory: "MARKET_CONTEXT" | "QUOTE_IMPACT";
  readonly sourceIdentifier: "BEST_PAIR" | "QUOTE";
  readonly count: number;
  readonly unavailableSharePct: number;
  readonly utcDateCount: number;
}

export interface MeasurementPartitionQualification {
  readonly partition: MeasurementPartition;
  readonly totalDecisionTimeUnits: number;
  readonly availableAtAnchorCount: number;
  readonly coveragePassed: boolean;
  readonly unavailableCount: number;
  readonly dominantSignature: MeasurementSignature | null;
  readonly tiedSignatures: readonly MeasurementSignature[];
}

export interface MeasurementSystemicLedgerRow {
  readonly field: MeasurementCatalogField;
  readonly auditField: MeasurementAuditField;
  readonly partitions: readonly MeasurementPartitionQualification[];
  readonly qualification:
    | "SYSTEMIC_ATTRIBUTABLE_MEASUREMENT_DEFICIENCY"
    | "NO_COVERAGE_GAP"
    | "TRANSIENT_OR_NONQUALIFYING_GAP"
    | "INSUFFICIENT_PARTITION_OR_DATE_EVIDENCE"
    | "QUALIFYING_SIGNATURE_TIE";
}

export interface DecisionTimeMeasurementAuditV1 {
  readonly contractVersion: typeof EXPLORATORY_MEASUREMENT_AUDIT_CONTRACT_VERSION;
  readonly generatedAt: string;
  readonly contentFingerprint: string;
  readonly archiveIdentity: {
    readonly status: "MATCHED";
    readonly archiveRoot: string;
    readonly protocolSha256: string;
    readonly artifacts: readonly {
      readonly path: MeasurementAuditArtifactName;
      readonly sha256: string;
    }[];
  };
  readonly safety: {
    readonly providerCalls: 0;
    readonly databaseReads: 0;
    readonly databaseWrites: 0;
    readonly filesystemWrites: 0;
    readonly runtimeActions: 0;
    readonly sessionActions: 0;
    readonly orders: 0;
    readonly fills: 0;
    readonly positions: 0;
    readonly walletLoaded: false;
    readonly transactionSigning: false;
    readonly transactionSubmission: false;
    readonly laterLabelMembersInterpreted: 0;
  };
  readonly archiveIntegrity: {
    readonly finalOutcome: LoadedMeasurementAuditArchive["finalOutcome"];
  };
  readonly fieldAvailabilityLedger: readonly MeasurementAvailabilityLedgerRow[];
  readonly missingnessProvenanceLedger: readonly MeasurementProvenanceLedgerRow[];
  readonly dateDistributionLedger: readonly MeasurementDateLedgerRow[];
  readonly decisionTimeSourceInventoryLedger: readonly MeasurementSourceInventoryLedgerRow[];
  readonly systemicDeficiencyLedger: readonly MeasurementSystemicLedgerRow[];
  readonly outcome: {
    readonly status: MeasurementAuditOutcome;
    readonly reasons: readonly string[];
  };
  readonly nextPermittedAction: string;
  readonly warnings: readonly string[];
}

export const EMPTY_MEASUREMENT_AUDIT_SAFETY = {
  providerCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
  filesystemWrites: 0,
  runtimeActions: 0,
  sessionActions: 0,
  orders: 0,
  fills: 0,
  positions: 0,
  walletLoaded: false,
  transactionSigning: false,
  transactionSubmission: false,
  laterLabelMembersInterpreted: 0,
} as const;
