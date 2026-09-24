import { z } from "zod";

export const EXPLORATORY_COHORT_ANALYSIS_CONTRACT_VERSION = "1" as const;

export const analysisFormatSchema = z.enum(["markdown", "json"]);
export type ExploratoryCohortAnalysisFormat = z.infer<typeof analysisFormatSchema>;

export const analysisOutcomeSchema = z.enum([
  "DATA_INSUFFICIENT",
  "NO_DEFENSIBLE_HYPOTHESIS",
  "PRE_REGISTRATION_CANDIDATE_REJECTED",
  "HUMAN_REVIEW_REQUIRED",
  "PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL",
]);
export type ExploratoryCohortAnalysisOutcome = z.infer<typeof analysisOutcomeSchema>;

export const catalogFieldSchema = z.enum([
  "AGE",
  "LIQUIDITY",
  "VOLUME_5M",
  "VOLUME_1H",
  "MOMENTUM_5M",
  "MOMENTUM_15M",
  "QUOTE_IMPACT",
]);
export type CatalogFieldId = z.infer<typeof catalogFieldSchema>;

export const catalogDirectionSchema = z.enum(["LOW_V1", "HIGH_V1"]);
export type CatalogDirection = z.infer<typeof catalogDirectionSchema>;

export const catalogRuleIdSchema = z.enum([
  "AGE__LOW_V1",
  "AGE__HIGH_V1",
  "LIQUIDITY__LOW_V1",
  "LIQUIDITY__HIGH_V1",
  "VOLUME_5M__LOW_V1",
  "VOLUME_5M__HIGH_V1",
  "VOLUME_1H__LOW_V1",
  "VOLUME_1H__HIGH_V1",
  "MOMENTUM_5M__LOW_V1",
  "MOMENTUM_5M__HIGH_V1",
  "MOMENTUM_15M__LOW_V1",
  "MOMENTUM_15M__HIGH_V1",
  "QUOTE_IMPACT__LOW_V1",
  "QUOTE_IMPACT__HIGH_V1",
]);
export type CatalogRuleId = z.infer<typeof catalogRuleIdSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const percentSchema = z.number().finite().min(0).max(100);
const rateSchema = z.number().finite().min(0).max(1);
const differenceSchema = z.number().finite().min(-1).max(1);

const gateSchema = z
  .object({
    id: z.enum([
      "COHORT_COMPLETION",
      "SPLIT_RECONSTRUCTION",
      "PRIMARY_LABEL_COVERAGE",
      "PRIMARY_LABEL_SUPPORT",
      "LABEL_DATE_CONCENTRATION",
    ]),
    passed: z.boolean(),
    numerator: z.number().finite().nonnegative(),
    denominator: z.number().finite().positive(),
  })
  .strict();

const partitionLabelCountsSchema = z
  .object({
    validUnitCount: z.number().int().nonnegative(),
    usable60mCount: z.number().int().nonnegative(),
    positive60mCount: z.number().int().nonnegative(),
    nonPositive60mCount: z.number().int().nonnegative(),
    unusable60mCount: z.number().int().nonnegative(),
    utcDateCount: z.number().int().nonnegative(),
    maximumUtcDateSharePct: percentSchema,
  })
  .strict();

const ruleEvidenceSchema = z
  .object({
    eligible: z.boolean(),
    support: z.number().int().nonnegative(),
    comparisonSupport: z.number().int().nonnegative(),
    utcDateCount: z.number().int().nonnegative(),
    maximumUtcDateSharePct: percentSchema,
    positiveRate: rateSchema.nullable(),
    comparisonPositiveRate: rateSchema.nullable(),
    positiveRateDifference: differenceSchema.nullable(),
    failureCodes: z.array(
      z.enum([
        "FIELD_COVERAGE",
        "RULE_SUPPORT",
        "COMPARISON_SUPPORT",
        "DATE_SUPPORT",
        "DATE_CONCENTRATION",
        "EFFECT_SIZE",
        "NOT_EVALUATED_QUALITY",
      ]),
    ),
  })
  .strict();

const catalogLedgerEntrySchema = z
  .object({
    catalogRuleId: catalogRuleIdSchema,
    decisionTimeField: z.string().min(1).max(64),
    comparator: z.enum(["LTE", "GTE"]),
    fieldAvailable: z.boolean(),
    discoveryThreshold: z.number().finite().nullable(),
    discoveryEvidence: ruleEvidenceSchema,
  })
  .strict();

const validationLedgerSchema = z
  .object({
    catalogRuleId: catalogRuleIdSchema,
    support: z.number().int().nonnegative(),
    comparisonSupport: z.number().int().nonnegative(),
    utcDateCount: z.number().int().nonnegative(),
    maximumUtcDateSharePct: percentSchema,
    positiveRate: rateSchema.nullable(),
    comparisonPositiveRate: rateSchema.nullable(),
    positiveRateDifference: differenceSchema.nullable(),
    fisherGreaterPValue: z.number().finite().min(0).max(1).nullable(),
    leaveOneDateOutStable: z.boolean(),
    passed: z.boolean(),
    failureCodes: z.array(
      z.enum([
        "FEATURE_COVERAGE",
        "RULE_SUPPORT",
        "COMPARISON_SUPPORT",
        "DATE_SUPPORT",
        "DATE_CONCENTRATION",
        "EFFECT_SIZE",
        "FISHER_EXACT",
        "LEAVE_ONE_DATE_OUT",
      ]),
    ),
  })
  .strict();

const candidateDescriptorSchema = z
  .object({
    catalogRuleId: catalogRuleIdSchema,
    decisionTimeField: z.string().min(1).max(64),
    comparator: z.enum(["LTE", "GTE"]),
    discoveryThreshold: z.number().finite(),
    discoveryEvidence: z
      .object({
        support: z.number().int().nonnegative(),
        comparisonSupport: z.number().int().nonnegative(),
        positiveRate: rateSchema,
        comparisonPositiveRate: rateSchema,
        positiveRateDifference: differenceSchema,
      })
      .strict(),
    validationEvidence: z
      .object({
        support: z.number().int().nonnegative(),
        comparisonSupport: z.number().int().nonnegative(),
        positiveRate: rateSchema,
        comparisonPositiveRate: rateSchema,
        positiveRateDifference: differenceSchema,
        fisherGreaterPValue: z.number().finite().min(0).max(1),
      })
      .strict(),
    archiveCitations: z
      .object({
        files: z.array(z.enum(["units.v1.ndjson", "cohort-manifest.v1.json"])).min(1),
        unitIds: z.array(z.string().min(1).max(128)).min(1).max(96),
        fieldPath: z.string().min(1).max(64),
      })
      .strict(),
    materialDifference: z.literal("ONE_DECISION_TIME_FEATURE_NOT_F65E_V1"),
    requiredNextRecord: z.literal("ShadowStudyPreRegistrationV1"),
    nextPermittedAction: z.literal("SEPARATE_HUMAN_APPROVAL_ONLY"),
  })
  .strict();

export const exploratoryCohortAnalysisSchema = z
  .object({
    contractVersion: z.literal(EXPLORATORY_COHORT_ANALYSIS_CONTRACT_VERSION),
    generatedAt: z.string().datetime(),
    contentFingerprint: sha256Schema,
    archiveIdentity: z
      .object({
        status: z.literal("MATCHED"),
        archiveRoot: z.literal("data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z"),
        protocolSha256: sha256Schema,
        manifestSha256: sha256Schema,
        launchIdentityHash: sha256Schema,
      })
      .strict(),
    inputInventory: z
      .array(
        z
          .object({
            path: z.enum([
              "cohort-manifest.v1.json",
              "units.v1.ndjson",
              "source-inventory.v1.json",
              "collection-summary.v1.json",
            ]),
            sha256: sha256Schema,
          })
          .strict(),
      )
      .length(4),
    safety: z
      .object({
        providerCalls: z.literal(0),
        databaseReads: z.literal(0),
        databaseWrites: z.literal(0),
        filesystemWrites: z.literal(0),
        runtimeCalls: z.literal(0),
        sessionCreation: z.literal(0),
        orders: z.literal(0),
        fills: z.literal(0),
        positions: z.literal(0),
        walletLoaded: z.literal(false),
        transactionSigning: z.literal(false),
        transactionSubmission: z.literal(false),
      })
      .strict(),
    archiveIntegrity: z
      .object({
        finalOutcome: z.enum([
          "COHORT_COMPLETE",
          "COHORT_INCOMPLETE",
          "COHORT_STOPPED_DATA_QUALITY",
          "HUMAN_REVIEW_REQUIRED",
        ]),
        finalFileHashesValid: z.boolean(),
        sourceInventoryValid: z.boolean(),
        summaryConsistent: z.boolean(),
        protocolValid: z.boolean(),
      })
      .strict(),
    cohortQuality: z
      .object({
        validUnitCount: z.number().int().nonnegative(),
        partitionCounts: z
          .object({
            DISCOVERY: z.number().int().nonnegative(),
            VALIDATION: z.number().int().nonnegative(),
          })
          .strict(),
        utcDateCounts: z.record(
          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          z.number().int().nonnegative(),
        ),
        gates: z.array(gateSchema),
      })
      .strict(),
    decisionTimeCoverage: z.array(
      z
        .object({
          field: catalogFieldSchema,
          discoveryAvailable: z.number().int().nonnegative(),
          discoveryTotal: z.number().int().nonnegative(),
          validationAvailable: z.number().int().nonnegative(),
          validationTotal: z.number().int().nonnegative(),
          eligibleForCatalog: z.boolean(),
        })
        .strict(),
    ),
    secondaryLabelDescription: z.array(
      z
        .object({
          minutesAfterAnchor: z.union([z.literal(3), z.literal(5), z.literal(15)]),
          observedOnTimeCount: z.number().int().nonnegative(),
          otherAvailabilityCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    primaryLabelAnalysis: z
      .object({ DISCOVERY: partitionLabelCountsSchema, VALIDATION: partitionLabelCountsSchema })
      .strict(),
    catalogLedger: z.array(catalogLedgerEntrySchema).length(14),
    selectedDiscoveryRule: catalogRuleIdSchema.nullable(),
    validationLedger: validationLedgerSchema.nullable(),
    outcome: z
      .object({ status: analysisOutcomeSchema, reasons: z.array(z.string().min(1).max(64)) })
      .strict(),
    candidateDescriptor: candidateDescriptorSchema.nullable(),
    nextPermittedAction: z.string().min(1).max(240),
    warnings: z.array(z.string().min(1).max(240)),
  })
  .strict();

export type ExploratoryCohortAnalysisV1 = z.infer<typeof exploratoryCohortAnalysisSchema>;

export const EMPTY_ANALYSIS_SAFETY = {
  providerCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
  filesystemWrites: 0,
  runtimeCalls: 0,
  sessionCreation: 0,
  orders: 0,
  fills: 0,
  positions: 0,
  walletLoaded: false,
  transactionSigning: false,
  transactionSubmission: false,
} as const;

export const catalogFields = [
  { id: "AGE", path: "market.assetAgeSeconds" },
  { id: "LIQUIDITY", path: "market.liquidityUsd" },
  { id: "VOLUME_5M", path: "market.volume5mUsd" },
  { id: "VOLUME_1H", path: "market.volume1hUsd" },
  { id: "MOMENTUM_5M", path: "market.momentum5mPct" },
  { id: "MOMENTUM_15M", path: "market.momentum15mPct" },
  { id: "QUOTE_IMPACT", path: "quote.priceImpactBps" },
] as const satisfies readonly { readonly id: CatalogFieldId; readonly path: string }[];

export function catalogRuleId(field: CatalogFieldId, direction: CatalogDirection): CatalogRuleId {
  return `${field}__${direction}` as CatalogRuleId;
}
