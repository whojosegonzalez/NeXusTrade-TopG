import { z } from "zod";

export const FORMULATION_B_ANALYSIS_CONTRACT_VERSION = "1" as const;
export const FORMULATION_B_PROTOCOL_ID = "EXPLORATORY_COHORT_FORMULATION_B@v1" as const;
export const FORMULATION_B_PROTOCOL_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json" as const;
export const FORMULATION_B_PROTOCOL_SHA256 =
  "241ac7b18711c0b08cc9083b02085c847f71594448c7d9286eb4333194036fda" as const;

export const formulationBAnalysisFormatSchema = z.enum(["markdown", "json"]);
export type FormulationBAnalysisFormat = z.infer<typeof formulationBAnalysisFormatSchema>;

export const formulationBOutcomeSchema = z.enum([
  "PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL",
  "PRE_REGISTRATION_CANDIDATE_REJECTED",
  "NO_DEFENSIBLE_HYPOTHESIS",
  "DATA_INSUFFICIENT",
]);
export type FormulationBOutcome = z.infer<typeof formulationBOutcomeSchema>;

export const formulationBPartitionSchema = z.enum(["DISCOVERY", "VALIDATION"]);
export type FormulationBPartition = z.infer<typeof formulationBPartitionSchema>;

export const formulationBPrimaryLabelSchema = z.enum([
  "POSITIVE_60M",
  "NON_POSITIVE_60M",
  "UNUSABLE_60M",
]);
export type FormulationBPrimaryLabel = z.infer<typeof formulationBPrimaryLabelSchema>;

export const formulationBArtifactNames = [
  "cohort-manifest.v1.json",
  "units.v1.ndjson",
  "source-inventory.v1.json",
  "collection-summary.v1.json",
] as const;
export type FormulationBArtifactName = (typeof formulationBArtifactNames)[number];

export interface FormulationBDecisionTimeEvidence {
  readonly priceUsd: number | null;
  readonly momentum5mPct: number | null;
  readonly momentum15mPct: number | null;
  readonly momentumAccelerationPct: number | null;
  readonly assetAgeSeconds: number | null;
  readonly missingnessCode?: string | undefined;
}

export interface FormulationBForwardOutcomeLabels {
  readonly return60mPct: number | null;
  readonly primaryLabel: FormulationBPrimaryLabel;
  readonly return3mPct?: number | null | undefined;
  readonly return5mPct?: number | null | undefined;
  readonly return15mPct?: number | null | undefined;
}

export interface FormulationBUnitRecord {
  readonly unitId: string;
  readonly canonicalMint: string;
  readonly anchorAt: string;
  readonly anchorDate: string;
  readonly slotId: string;
  readonly partition: FormulationBPartition;
  readonly decisionTimeEvidence: FormulationBDecisionTimeEvidence;
  readonly forwardOutcomeLabels: FormulationBForwardOutcomeLabels;
}

export interface FormulationBSourceRecord {
  readonly utcDate: string;
  readonly category: string;
  readonly capability: string;
  readonly outcomeCode: string;
  readonly latencyBucket: string;
}

export interface LoadedFormulationBArchive {
  readonly archiveRoot: string;
  readonly protocolSha256: string;
  readonly finalOutcome: string;
  readonly attemptedSlotCount: number;
  readonly validUnitCount: number;
  readonly distinctMintCount: number;
  readonly inventory: Readonly<Record<FormulationBArtifactName, string>>;
  readonly units: readonly FormulationBUnitRecord[];
  readonly sources: readonly FormulationBSourceRecord[];
}

export interface FormulationBGateResult {
  readonly gateId: string;
  readonly passed: boolean;
  readonly actualValue: number | string;
  readonly requiredValue: number | string;
  readonly detail?: string | undefined;
}

export interface FormulationBGroupStats {
  readonly totalUnits: number;
  readonly usableUnits: number;
  readonly positiveUnits: number;
  readonly nonPositiveUnits: number;
  readonly unusableUnits: number;
  readonly positiveRate: number | null;
  readonly distinctUtcDates: number;
  readonly maxDateSharePct: number;
}

export interface FormulationBPartitionEvaluation {
  readonly partition: FormulationBPartition;
  readonly validUnitCount: number;
  readonly availableAccelerationCount: number;
  readonly accelerationCoveragePct: number;
  readonly distinctUtcDates: number;
  readonly maxDateSharePct: number;
  readonly ruleStats: FormulationBGroupStats;
  readonly compStats: FormulationBGroupStats;
  readonly rateDifference: number | null;
}

export interface FormulationBAnalysisReport {
  readonly contractVersion: typeof FORMULATION_B_ANALYSIS_CONTRACT_VERSION;
  readonly protocolId: typeof FORMULATION_B_PROTOCOL_ID;
  readonly protocolSha256: string;
  readonly archiveRoot: string;
  readonly archiveOutcome: string;
  readonly decisionOutcome: FormulationBOutcome;
  readonly candidatePredicateId: "ACCELERATION__HIGH_V1";
  readonly quantileIndex0Based: number | null;
  readonly discoveryQ3Threshold: number | null;
  readonly qualityGates: readonly FormulationBGateResult[];
  readonly discoveryGates: readonly FormulationBGateResult[];
  readonly validationGates: readonly FormulationBGateResult[];
  readonly discoveryEvaluation: FormulationBPartitionEvaluation;
  readonly validationEvaluation: FormulationBPartitionEvaluation;
  readonly summary: {
    readonly totalUnits: number;
    readonly discoveryUnits: number;
    readonly validationUnits: number;
    readonly totalUtcDates: number;
    readonly maxDateSharePct: number;
    readonly momentumAvailabilityPct: number;
    readonly labelCoveragePct: number;
  };
}
