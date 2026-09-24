import { z } from "zod";

import {
  INITIAL_EXPLORATORY_PROTOCOL_V1_PATH,
  INITIAL_EXPLORATORY_PROTOCOL_V1_SHA256,
  PHASE10_4_BRIEF_FINGERPRINT,
  PHASE10_5_REVIEW_GATE_FINGERPRINT,
  PHASE9_29_CONCLUSION,
} from "./ResearchProtocolConstants.js";

export const RESEARCH_PROTOCOL_VALIDATION_CONTRACT_VERSION = "1" as const;
const exploratoryCohortProtocolVersions = ["1", "2"] as const;
const exploratoryCohortProtocolIds = ["EXPLORATORY_COHORT@v1", "EXPLORATORY_COHORT@v2"] as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split("/").includes("..") &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value),
    "must be a repository-relative path",
  );
const nonEmptyString = z.string().trim().min(1);
const stringArray = z.array(nonEmptyString).min(1);

const sourceEvidenceSchema = z
  .object({
    researchBrief: z
      .object({
        fingerprint: z.literal(PHASE10_4_BRIEF_FINGERPRINT),
        citation: z.literal("docs/NeXusTrade-Phase-10.4-Detailed-Checklist.md"),
      })
      .strict(),
    researchReviewGate: z
      .object({
        fingerprint: z.literal(PHASE10_5_REVIEW_GATE_FINGERPRINT),
        citation: z.literal("docs/research-reviews/phase10.5-initial.v1.json"),
      })
      .strict(),
    phase929Conclusion: z
      .object({
        status: z.literal(PHASE9_29_CONCLUSION),
        citation: z.literal("docs/NeXusTrade-Phase-9.29-Detailed-Checklist.md"),
      })
      .strict(),
  })
  .strict();

const horizonSchema = z
  .object({
    minutesAfterAnchor: z.number().int().positive(),
    toleranceSeconds: z.number().int().nonnegative(),
  })
  .strict();

export const exploratoryCohortProtocolSchema = z
  .object({
    contractVersion: z.enum(exploratoryCohortProtocolVersions),
    protocolId: z.enum(exploratoryCohortProtocolIds),
    authorityStatus: z.literal("NOT_AUTHORIZED_FOR_COLLECTION"),
    supersedes: z
      .object({
        protocolPath: z.literal(INITIAL_EXPLORATORY_PROTOCOL_V1_PATH),
        protocolSha256: z.literal(INITIAL_EXPLORATORY_PROTOCOL_V1_SHA256),
        reason: z.literal("REQUEST_CAPS_COVER_ALL_168_ATTEMPTED_SLOTS_WITHOUT_RETRY_OR_FALLBACK"),
      })
      .strict()
      .optional(),
    sourceEvidence: sourceEvidenceSchema,
    purpose: z
      .object({
        kind: z.literal("OUTCOME_BLIND_OBSERVATIONAL_MEASUREMENT"),
        designQuestion: nonEmptyString,
        strategyValidation: z.literal(false),
        profitabilityClaim: z.literal(false),
      })
      .strict(),
    population: z
      .object({
        discoveryUniverse: z.literal(
          "ALL_CANONICAL_SOLANA_MINTS_FROM_UNMODIFIED_DISCOVERY_UNIVERSE",
        ),
        technicalValidityAnchor: z
          .object({
            mintEncoding: z.literal("BASE58_32_BYTE_CANONICAL_MINT"),
            sourceKindRequired: z.literal(true),
            firstReceivedAtUtcRequired: z.literal(true),
            decisionTimeAnchor: z.literal("SLOT_SELECTION_TIMESTAMP"),
          })
          .strict(),
        permittedExclusions: stringArray,
        forbiddenInputs: stringArray,
      })
      .strict(),
    samplingPlan: z
      .object({
        seed: z.enum(["phase10.6a-exploratory-cohort.v1", "phase10.6a-exploratory-cohort.v2"]),
        slotDurationMinutes: z.literal(120),
        selectionHash: z.literal("SHA256(seed|canonicalMint|slotId)"),
        selectionRule: z.literal("LEXICOGRAPHICALLY_LOWEST_HASH"),
        maximumUnitsPerSlot: z.literal(1),
        postSlotBackfill: z.literal(false),
        plannedUnits: z.literal(96),
        minimumValidUnits: z.literal(72),
        maximumAttemptedSlots: z.literal(168),
        consecutiveUtcDates: z.literal(14),
      })
      .strict(),
    independencePlan: z
      .object({
        slotIdDefinition: z.literal("[UTC_START,UTC_START_PLUS_2_HOURS)"),
        minimumUtcDates: z.literal(8),
        maximumValidUnitSharePerUtcDatePct: z.literal(20),
        maximumUnitsPerSlot: z.literal(1),
        minimumDistinctMints: z.literal(72),
      })
      .strict(),
    deduplicationPlan: z
      .object({
        canonicalMintRule: z.literal("ONE_CANONICAL_MINT_PER_COHORT"),
        marketWindowRule: z.literal("ONE_UNIT_PER_NON_OVERLAPPING_UTC_SLOT"),
        duplicateAction: z.literal("SKIP_UNIT_WITH_REASON"),
        replacementRule: z.literal("NO_OUTCOME_DRIVEN_REPLACEMENT"),
      })
      .strict(),
    decisionTimeSchema: z
      .object({
        allowlistedFields: stringArray,
        fieldValueTypes: z
          .object({
            unitId: z.literal("NON_EMPTY_STRING"),
            canonicalMint: z.literal("NON_EMPTY_STRING"),
            anchorAt: z.literal("ISO_8601_UTC_STRING"),
            slotId: z.literal("NON_EMPTY_STRING"),
            partition: z.literal("NON_EMPTY_STRING"),
            "discovery.sourceKind": z.literal("NON_EMPTY_STRING"),
            "discovery.firstObservedAt": z.literal("ISO_8601_UTC_STRING"),
            "market.assetAgeSeconds": z.literal("NON_NEGATIVE_INTEGER"),
            "market.priceUsd": z.literal("FINITE_NUMBER"),
            "market.liquidityUsd": z.literal("FINITE_NUMBER"),
            "market.volume5mUsd": z.literal("FINITE_NUMBER"),
            "market.volume1hUsd": z.literal("FINITE_NUMBER"),
            "market.momentum5mPct": z.literal("FINITE_NUMBER"),
            "market.momentum15mPct": z.literal("FINITE_NUMBER"),
            "quote.available": z.literal("BOOLEAN"),
            "quote.priceImpactBps": z.literal("FINITE_NUMBER"),
            "risk.blockerCodes": z.literal("LEXICALLY_SORTED_STRING_ARRAY"),
            "attention.repeatedAttentionCount": z.literal("NON_NEGATIVE_INTEGER"),
          })
          .strict(),
        availabilityCodes: stringArray,
        provenanceCategories: stringArray,
        valueOrMissingnessRequired: z.literal(true),
        availabilityRequired: z.literal(true),
        sourceKindRequired: z.literal(true),
        relativeSourceIdentifierRequired: z.literal(true),
        sourceTimestampWhenAvailableRequired: z.literal(true),
        freshnessSeconds: z
          .object({
            priceUsd: z.literal(60),
            quoteAvailable: z.literal(60),
            quotePriceImpactBps: z.literal(60),
            liquidityUsd: z.literal(300),
            volume5mUsd: z.literal(300),
            volume1hUsd: z.literal(300),
            momentum5mPct: z.literal(300),
            momentum15mPct: z.literal(300),
          })
          .strict(),
        descriptiveOnlyFields: stringArray,
        forbiddenFields: stringArray,
      })
      .strict(),
    providerBudgetPlan: z
      .object({
        categories: stringArray,
        maximumRequestsPerMinutePerCategory: z.literal(1),
        maximumConcurrencyPerCategory: z.literal(1),
        timeoutSeconds: z.literal(10),
        retryCount: z.literal(0),
        backoff: z.literal("NONE"),
        undeclaredFallback: z.literal("PROHIBITED"),
        cohortRequestCaps: z
          .object({
            DISCOVERY: z.union([z.literal(1000), z.literal(168)]),
            MARKET_CONTEXT: z.union([z.literal(96), z.literal(168)]),
            QUOTE_IMPACT: z.union([z.literal(96), z.literal(168)]),
            LATER_OBSERVATION: z.union([z.literal(384), z.literal(672)]),
          })
          .strict(),
      })
      .strict(),
    observationPlan: z
      .object({
        horizons: z.array(horizonSchema).length(4),
        validSnapshotResult: z.literal("NUMERIC_RETURN"),
        availabilityLabels: stringArray,
        targetStopProfile: z.literal("ABSENT"),
        tradingResult: z.literal("ABSENT"),
      })
      .strict(),
    splitPlan: z
      .object({
        assignmentHash: z.enum([
          "SHA256(phase10.6a-exploratory-cohort.v1|canonicalMint|slotId)",
          "SHA256(phase10.6a-exploratory-cohort.v2|canonicalMint|slotId)",
        ]),
        discoveryAssignment: z.literal("EVEN_FINAL_HEXADECIMAL_DIGIT"),
        validationAssignment: z.literal("ODD_FINAL_HEXADECIMAL_DIGIT"),
        minimumValidUnitsPerPartition: z.literal(32),
        minimumUtcDatesPerPartition: z.literal(4),
        incompleteOutcome: z.literal("INCOMPLETE_EXPLORATORY_COHORT"),
      })
      .strict(),
    dataQualityStops: z
      .object({
        immediateStopConditions: stringArray,
        upstreamRateLimitOrErrorAction: z.literal(
          "PAUSE_AFFECTED_SLOT_RECORD_MISSINGNESS_NO_RETRY",
        ),
        requiredAnchorStaleOrMissingRate: z
          .object({
            maximumPct: z.literal(25),
            evaluationAfterValidUnits: z.literal(24),
            action: z.literal("STOP_COHORT_DATA_QUALITY"),
          })
          .strict(),
        providerBudgetExhaustionAction: z.literal("STOP_COHORT_DATA_QUALITY"),
        incompleteConditions: stringArray,
      })
      .strict(),
    archiveContract: z
      .object({
        rootPattern: z.enum([
          "data/archive/phase10.6a/exploratory-cohort-v1-YYYYMMDD-HHmmZ/",
          "data/archive/phase10.6a/exploratory-cohort-v2-YYYYMMDD-HHmmZ/",
        ]),
        files: stringArray,
        retention: z.literal("IMMUTABLE_INDEFINITE"),
        forbiddenContent: stringArray,
      })
      .strict(),
    analysisBoundary: z
      .object({
        decisionTimeFacts: z.literal("DESCRIPTIVE_ONLY"),
        laterOutcomes: z.literal("LABELS_ONLY"),
        forbiddenInputsToSelection: stringArray,
        allowedPhase10_6BOutcomes: stringArray,
      })
      .strict(),
    prohibitedChanges: z
      .object({
        buyScoreThreshold: z.literal(90),
        watchScoreThreshold: z.literal(70),
        paperExecution: z.literal("DISABLED"),
        unchangedF65E: z.literal("PROHIBITED"),
        oneOrTwoMinuteMonitoringChange: z.literal("PROHIBITED"),
        strategyDefaultChange: z.literal("PROHIBITED"),
      })
      .strict(),
    downstreamAuthority: z
      .object({
        phase10_6A: z
          .object({
            authority: z.literal(
              "REQUIRES_SEPARATE_APPROVED_CHECKLIST_AND_EXPLICIT_USER_AUTHORIZATION",
            ),
            commandAndConfigSurface: z.literal("ABSENT_IN_PHASE_10_5A"),
            providerAdapters: z.literal("ABSENT_IN_PHASE_10_5A"),
            runtimeConfiguration: z.literal("ABSENT_IN_PHASE_10_5A"),
          })
          .strict(),
        phase10_6B: z.literal("ARCHIVE_ONLY_AFTER_COMPLETED_COLLECTION"),
        phase10_6C: z.literal("REQUIRES_SEPARATE_APPROVED_PRE_REGISTRATION_AND_CHECKLIST"),
        execution: z.literal("NOT_AUTHORIZED"),
      })
      .strict(),
  })
  .strict()
  .superRefine((protocol, context) => {
    const isV1 = protocol.contractVersion === "1";
    const hasExpectedVersionedValues = isV1
      ? protocol.protocolId === "EXPLORATORY_COHORT@v1" &&
        protocol.supersedes === undefined &&
        protocol.samplingPlan.seed === "phase10.6a-exploratory-cohort.v1" &&
        protocol.splitPlan.assignmentHash ===
          "SHA256(phase10.6a-exploratory-cohort.v1|canonicalMint|slotId)" &&
        protocol.archiveContract.rootPattern ===
          "data/archive/phase10.6a/exploratory-cohort-v1-YYYYMMDD-HHmmZ/" &&
        protocol.providerBudgetPlan.cohortRequestCaps.DISCOVERY === 1000 &&
        protocol.providerBudgetPlan.cohortRequestCaps.MARKET_CONTEXT === 96 &&
        protocol.providerBudgetPlan.cohortRequestCaps.QUOTE_IMPACT === 96 &&
        protocol.providerBudgetPlan.cohortRequestCaps.LATER_OBSERVATION === 384
      : protocol.protocolId === "EXPLORATORY_COHORT@v2" &&
        protocol.supersedes !== undefined &&
        protocol.samplingPlan.seed === "phase10.6a-exploratory-cohort.v2" &&
        protocol.splitPlan.assignmentHash ===
          "SHA256(phase10.6a-exploratory-cohort.v2|canonicalMint|slotId)" &&
        protocol.archiveContract.rootPattern ===
          "data/archive/phase10.6a/exploratory-cohort-v2-YYYYMMDD-HHmmZ/" &&
        protocol.providerBudgetPlan.cohortRequestCaps.DISCOVERY === 168 &&
        protocol.providerBudgetPlan.cohortRequestCaps.MARKET_CONTEXT === 168 &&
        protocol.providerBudgetPlan.cohortRequestCaps.QUOTE_IMPACT === 168 &&
        protocol.providerBudgetPlan.cohortRequestCaps.LATER_OBSERVATION === 672;
    if (!hasExpectedVersionedValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Protocol version, identity, seed, archive, supersession, and caps must agree.",
      });
    }
    for (const [name, values] of [
      ["allowlisted fields", protocol.decisionTimeSchema.allowlistedFields],
      ["availability codes", protocol.decisionTimeSchema.availabilityCodes],
      ["provenance categories", protocol.decisionTimeSchema.provenanceCategories],
      ["provider categories", protocol.providerBudgetPlan.categories],
      ["later observation labels", protocol.observationPlan.availabilityLabels],
      ["Phase 10.6B outcomes", protocol.analysisBoundary.allowedPhase10_6BOutcomes],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be unique.`,
        });
      }
    }
  });

export const researchProtocolValidationSchema = z
  .object({
    contractVersion: z.literal(RESEARCH_PROTOCOL_VALIDATION_CONTRACT_VERSION),
    generatedAt: z.string().datetime(),
    contentFingerprint: sha256Schema,
    protocol: z
      .object({
        path: relativePathSchema,
        sha256: sha256Schema,
        protocolId: z.enum(exploratoryCohortProtocolIds),
        authorityStatus: z.literal("NOT_AUTHORIZED_FOR_COLLECTION"),
      })
      .strict(),
    sourceEvidence: sourceEvidenceSchema,
    safety: z
      .object({
        providerCalls: z.literal(0),
        httpCalls: z.literal(0),
        databaseReads: z.literal(0),
        databaseWrites: z.literal(0),
        filesystemWrites: z.literal(0),
        runtimeCommands: z.literal(0),
        sessionCreation: z.literal(0),
        orders: z.literal(0),
        fills: z.literal(0),
        positions: z.literal(0),
        walletLoaded: z.literal(false),
        transactionSigning: z.literal(false),
        transactionSubmission: z.literal(false),
      })
      .strict(),
    outcome: z
      .object({
        status: z.literal("PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL"),
        authority: z.literal("NON_AUTHORIZING"),
      })
      .strict(),
    nextPermittedAction: z.literal(
      "Submit the fixed protocol for a separate Phase 10.6A checklist and explicit user approval. Do not collect data, configure a market runtime, change strategy defaults, or enable PAPER execution.",
    ),
    warnings: z.array(nonEmptyString).min(1),
  })
  .strict();

export type ExploratoryCohortProtocol = z.infer<typeof exploratoryCohortProtocolSchema>;
export type ExploratoryCohortProtocolV1 = ExploratoryCohortProtocol;
export type ResearchProtocolValidationV1 = z.infer<typeof researchProtocolValidationSchema>;
