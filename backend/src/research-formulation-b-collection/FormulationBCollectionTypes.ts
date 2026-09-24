import { z } from "zod";

export const FORMULATION_B_COLLECTION_CONTRACT_VERSION = "1" as const;
export const FORMULATION_B_PROTOCOL_ID = "EXPLORATORY_COHORT_FORMULATION_B@v1" as const;
export const FORMULATION_B_PROTOCOL_PATH =
  "docs/research-protocols/phase10.6a-exploratory-cohort.formulation-b.v1.json" as const;
export const FORMULATION_B_PROTOCOL_SHA256 =
  "241ac7b18711c0b08cc9083b02085c847f71594448c7d9286eb4333194036fda" as const;

export const formulationBPartitionSchema = z.enum(["DISCOVERY", "VALIDATION"]);
export type FormulationBPartition = z.infer<typeof formulationBPartitionSchema>;

export const formulationBPrimaryLabelSchema = z.enum([
  "POSITIVE_60M",
  "NON_POSITIVE_60M",
  "UNUSABLE_60M",
]);
export type FormulationBPrimaryLabel = z.infer<typeof formulationBPrimaryLabelSchema>;

export interface FormulationBCollectionConfig {
  readonly archiveRoot: string;
  readonly targetSlots: number;
  readonly days: number;
  readonly slotsPerDay: number;
  readonly dryRun: boolean;
  readonly rateLimitMs: number;
  readonly requestTimeoutMs: number;
}

export interface FormulationBDiscoveryCandidate {
  readonly canonicalMint: string;
  readonly slotId: string;
  readonly discoveredAt: string;
  readonly assetAgeSeconds: number;
}

export interface FormulationBDecisionFacts {
  readonly priceUsd: number | null;
  readonly momentum5mPct: number | null;
  readonly momentum15mPct: number | null;
  readonly momentumAccelerationPct: number | null;
  readonly assetAgeSeconds: number | null;
  readonly missingnessCode?: string | undefined;
}

export interface FormulationBForwardOutcome {
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
  readonly decisionTimeEvidence: FormulationBDecisionFacts;
  readonly forwardOutcomeLabels: FormulationBForwardOutcome;
}

export interface FormulationBSourceRecord {
  readonly utcDate: string;
  readonly category: string;
  readonly capability: string;
  readonly outcomeCode: string;
  readonly latencyBucket: string;
}

export interface FormulationBSafetyCounters {
  clockDriftStops: number;
  schemaIntegrityStops: number;
  secretLeakageStops: number;
  budgetExceededStops: number;
}

export interface FormulationBProviderResponse<T> {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly data: T;
  readonly latencyMs: number;
  readonly rawBody: string;
}

export interface FormulationBProviderClient {
  discoverCandidates(
    limit: number,
  ): Promise<FormulationBProviderResponse<readonly FormulationBDiscoveryCandidate[]>>;
  fetchMomentumEvidence(
    canonicalMint: string,
    anchorAt: string,
  ): Promise<FormulationBProviderResponse<FormulationBDecisionFacts>>;
  fetchSpotPrice(
    canonicalMint: string,
    targetAt: string,
  ): Promise<FormulationBProviderResponse<{ priceUsd: number | null }>>;
}
