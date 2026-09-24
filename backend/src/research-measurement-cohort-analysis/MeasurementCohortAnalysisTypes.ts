import { z } from "zod";

export const MEASUREMENT_COHORT_ANALYSIS_CONTRACT_VERSION = "1" as const;

export const measurementCohortAnalysisFormatSchema = z.enum(["markdown", "json"]);
export type MeasurementCohortAnalysisFormat = z.infer<typeof measurementCohortAnalysisFormatSchema>;

export const measurementAvailabilitySchema = z.enum([
  "AVAILABLE_AT_ANCHOR",
  "NOT_REQUESTED",
  "UNAVAILABLE_AT_ANCHOR",
  "STALE_AT_ANCHOR",
  "BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "UNSUPPORTED",
  "INVALID_VALUE",
]);
export type MeasurementAvailability = z.infer<typeof measurementAvailabilitySchema>;
export const measurementAvailabilityCodes = measurementAvailabilitySchema.options;

export const measurementPartitionSchema = z.enum(["DISCOVERY", "VALIDATION"]);
export type MeasurementPartition = z.infer<typeof measurementPartitionSchema>;
export const measurementPartitions = measurementPartitionSchema.options;

export const measurementObjectiveSchema = z.enum(["LIQUIDITY", "MOMENTUM_5M", "MOMENTUM_15M"]);
export type MeasurementObjective = z.infer<typeof measurementObjectiveSchema>;
export const measurementObjectives = measurementObjectiveSchema.options;

export const measurementCohortAnalysisArtifactNames = [
  "cohort-manifest.v1.json",
  "units.v1.ndjson",
  "source-inventory.v1.json",
  "collection-summary.v1.json",
] as const;
export type MeasurementCohortAnalysisArtifactName =
  (typeof measurementCohortAnalysisArtifactNames)[number];

export interface MeasurementCohortAnalysisFact {
  readonly availability: MeasurementAvailability;
  readonly sourceCategory: "MARKET_CONTEXT" | "LOCAL";
  readonly sourceIdentifier: "BEST_PAIR" | "FORMULA";
}

export interface MeasurementCohortAnalysisUnit {
  readonly partition: MeasurementPartition;
  readonly anchorDate: string;
  readonly facts: Readonly<Record<MeasurementObjective, MeasurementCohortAnalysisFact>>;
}

export interface MeasurementCohortAnalysisSource {
  readonly utcDate: string;
  readonly category: "DISCOVERY" | "MARKET_CONTEXT";
  readonly capability: "DISCOVER_TOKENS" | "BEST_PAIR";
  readonly outcomeCode: string;
  readonly latencyBucket: "LT_100MS" | "LT_1S" | "GE_1S";
}

export interface LoadedMeasurementCohortAnalysisArchive {
  readonly finalOutcome: "COHORT_COMPLETE" | "MEASUREMENT_COHORT_DATA_INSUFFICIENT";
  readonly attemptedSlotCount: number;
  readonly validUnitCount: number;
  readonly distinctMintCount: number;
  readonly inventory: Readonly<Record<MeasurementCohortAnalysisArtifactName, string>>;
  readonly units: readonly MeasurementCohortAnalysisUnit[];
  readonly sources: readonly MeasurementCohortAnalysisSource[];
}

export interface MeasurementCohortSufficiencyGate {
  readonly gate:
    | "MINIMUM_VALID_UNITS"
    | "PLANNED_VALID_UNITS"
    | "MINIMUM_DISTINCT_MINTS"
    | "MINIMUM_UTC_DATES"
    | "MAXIMUM_UTC_DATE_SHARE"
    | "MINIMUM_PARTITION_UNITS"
    | "MINIMUM_PARTITION_DATES";
  readonly passed: boolean;
}

export interface MeasurementCohortPartitionSummary {
  readonly partition: MeasurementPartition;
  readonly validUnitCount: number;
  readonly utcDateCount: number;
}

export interface MeasurementCohortObjectiveLedgerRow {
  readonly objective: MeasurementObjective;
  readonly partition: MeasurementPartition;
  readonly validUnitCount: number;
  readonly availableAtAnchorCount: number;
  readonly availabilityCounts: Readonly<Record<MeasurementAvailability, number>>;
  readonly availabilityPct: number;
  readonly availableUtcDateCount: number;
  readonly availabilityGatePassed: boolean;
  readonly dateSupportGatePassed: boolean;
  readonly provenanceGatePassed: true;
  readonly freshnessGatePassed: true;
}

export interface MeasurementCohortMissingnessLedgerRow {
  readonly objective: MeasurementObjective;
  readonly partition: MeasurementPartition;
  readonly utcDate: string;
  readonly availability: MeasurementAvailability;
  readonly sourceCategory: "MARKET_CONTEXT" | "LOCAL";
  readonly sourceIdentifier: "BEST_PAIR" | "FORMULA";
  readonly count: number;
}

export interface MeasurementCohortSourceLedgerRow {
  readonly utcDate: string;
  readonly category: "DISCOVERY" | "MARKET_CONTEXT";
  readonly capability: "DISCOVER_TOKENS" | "BEST_PAIR";
  readonly outcomeCode: string;
  readonly latencyBucket: "LT_100MS" | "LT_1S" | "GE_1S";
  readonly count: number;
}

export interface MeasurementCohortFinalGateRow {
  readonly gate:
    | MeasurementCohortSufficiencyGate["gate"]
    | "LIQUIDITY_AVAILABILITY"
    | "LIQUIDITY_DATE_SUPPORT"
    | "MOMENTUM_5M_AVAILABILITY"
    | "MOMENTUM_5M_DATE_SUPPORT"
    | "MOMENTUM_15M_AVAILABILITY"
    | "MOMENTUM_15M_DATE_SUPPORT";
  readonly partition: MeasurementPartition | "COHORT";
  readonly passed: boolean;
}

export const measurementCohortAnalysisStatusSchema = z.enum([
  "MEASUREMENT_CAPABILITY_CONFIRMED",
  "MEASUREMENT_CAPABILITY_NOT_CONFIRMED",
  "MEASUREMENT_EVIDENCE_INSUFFICIENT",
]);
export type MeasurementCohortAnalysisStatus = z.infer<typeof measurementCohortAnalysisStatusSchema>;

export interface MeasurementCohortAnalysisV1 {
  readonly contractVersion: typeof MEASUREMENT_COHORT_ANALYSIS_CONTRACT_VERSION;
  readonly generatedAt: string;
  readonly contentFingerprint: string;
  readonly archiveIdentity: {
    readonly status: "MATCHED";
    readonly archiveRoot: string;
    readonly protocolSha256: string;
    readonly artifacts: readonly {
      readonly path: MeasurementCohortAnalysisArtifactName;
      readonly sha256: string;
    }[];
  };
  readonly archiveFinality: "MATCHED";
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
  readonly finalArchiveOutcome: LoadedMeasurementCohortAnalysisArchive["finalOutcome"];
  readonly cohortSufficiency: {
    readonly attemptedSlotCount: number;
    readonly validUnitCount: number;
    readonly plannedValidUnitCount: 96;
    readonly distinctMintCount: number;
    readonly utcDateCount: number;
    readonly maximumUtcDateSharePct: number;
    readonly partitions: readonly MeasurementCohortPartitionSummary[];
    readonly gates: readonly MeasurementCohortSufficiencyGate[];
  };
  readonly objectiveAvailabilityLedger: readonly MeasurementCohortObjectiveLedgerRow[];
  readonly missingnessLedger: readonly MeasurementCohortMissingnessLedgerRow[];
  readonly sourceInventoryLedger: readonly MeasurementCohortSourceLedgerRow[];
  readonly finalGateLedger: readonly MeasurementCohortFinalGateRow[];
  readonly outcome: {
    readonly status: MeasurementCohortAnalysisStatus;
    readonly failedGateIds: readonly string[];
  };
  readonly nextPermittedAction: string;
  readonly warnings: readonly string[];
}

export const EMPTY_MEASUREMENT_COHORT_ANALYSIS_SAFETY = {
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
