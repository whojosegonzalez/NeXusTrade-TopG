import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const measurementAvailabilityCodeSchema = z.enum([
  "AVAILABLE_AT_ANCHOR",
  "NOT_REQUESTED",
  "UNAVAILABLE_AT_ANCHOR",
  "STALE_AT_ANCHOR",
  "BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "UNSUPPORTED",
  "INVALID_VALUE",
]);

const sourceEvidenceSchema = z
  .object({
    measurementAudit: z
      .object({
        contentFingerprint: sha256Schema,
        v2ArchiveRoot: z.string().min(1),
        v2ProtocolSha256: sha256Schema,
      })
      .strict(),
    aggregateMeasurementSignatures: z
      .array(
        z
          .object({
            fieldId: z.enum(["LIQUIDITY", "MOMENTUM_5M", "MOMENTUM_15M"]),
            discoveryAvailable: z.number().int().nonnegative(),
            discoveryTotal: z.number().int().positive(),
            validationAvailable: z.number().int().nonnegative(),
            validationTotal: z.number().int().positive(),
            availability: measurementAvailabilityCodeSchema,
            provenanceCategory: z.literal("MARKET_CONTEXT"),
            sourceIdentifier: z.literal("BEST_PAIR"),
            utcDateSupport: z.number().int().positive(),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();

const directObservationMethodSchema = z
  .object({
    kind: z.literal("DIRECT_OBSERVATION"),
    snapshotOffsetMinutes: z.literal(0),
    maximumSourceToAnchorSeconds: z.number().int().positive(),
    valuePath: z.literal("BEST_PAIR.liquidityUsd"),
  })
  .strict();

const fixedCalculationMethodSchema = z
  .object({
    kind: z.literal("FIXED_PRE_ANCHOR_CALCULATION"),
    requiredSnapshotOffsetsMinutes: z.array(z.number().int()).length(4),
    maximumSourceToScheduledSnapshotSeconds: z.number().int().positive(),
    inputValuePath: z.literal("BEST_PAIR.priceUsd"),
    formula: z.string().min(1),
    absentComponentAction: z.literal("RECORD_DECLARED_MISSINGNESS"),
  })
  .strict();

const measurementObjectiveSchema = z
  .object({
    fieldId: z.enum(["LIQUIDITY", "MOMENTUM_5M", "MOMENTUM_15M"]),
    decisionTimePath: z.string().min(1),
    valueType: z.enum(["FINITE_NON_NEGATIVE_USD", "FINITE_SIGNED_PERCENT"]),
    unit: z.enum(["USD", "PCT"]),
    missingnessCodes: z.array(measurementAvailabilityCodeSchema).length(8),
    provenance: z
      .object({
        category: z.literal("MARKET_CONTEXT"),
        sourceIdentifier: z.literal("BEST_PAIR"),
      })
      .strict(),
    method: z.union([directObservationMethodSchema, fixedCalculationMethodSchema]),
    selectionInput: z.literal(false),
  })
  .strict();

export const measurementProtocolDraftSchema = z
  .object({
    contractVersion: z.literal("3"),
    protocolId: z.literal("EXPLORATORY_COHORT_MEASUREMENT@v3"),
    authorityStatus: z.literal("NOT_AUTHORIZED_FOR_COLLECTION"),
    supersedes: z
      .object({
        protocolPath: z.string().min(1),
        protocolSha256: sha256Schema,
        reason: z.literal("MEASUREMENT_AVAILABILITY_REPAIR_ONLY"),
      })
      .strict(),
    sourceEvidence: sourceEvidenceSchema,
    purpose: z
      .object({
        kind: z.literal("OUTCOME_BLIND_MEASUREMENT_AVAILABILITY"),
        designQuestion: z.string().min(1),
        strategyValidation: z.literal(false),
        profitabilityClaim: z.literal(false),
        literalLimit: z.string().min(1),
      })
      .strict(),
    populationAndAnchor: z
      .object({
        discoveryUniverse: z.literal(
          "ALL_CANONICAL_SOLANA_MINTS_FROM_UNMODIFIED_DISCOVERY_UNIVERSE",
        ),
        discoveryRequestLimit: z.literal(100),
        canonicalIdentity: z
          .object({
            mintEncoding: z.literal("BASE58_32_BYTE_CANONICAL_MINT"),
            sourceKindRequired: z.literal(true),
            firstReceivedAtUtcRequired: z.literal(true),
          })
          .strict(),
        selectionAt: z.literal("SLOT_ANCHOR_MINUS_16_MINUTES"),
        anchorAt: z.literal("SLOT_ANCHOR"),
        technicalValidityAnchor: z.literal(
          "CANONICAL_IDENTITY_AND_SELECTION_TIME_SOURCE_METADATA_ONLY",
        ),
        sampling: z
          .object({
            seed: z.string().min(1),
            selectionHash: z.literal("SHA256(seed|canonicalMint|slotId)"),
            selectionRule: z.literal("LEXICOGRAPHICALLY_LOWEST_HASH"),
            maximumUnitsPerSlot: z.literal(1),
            deduplication: z.literal("ONE_CANONICAL_MINT_PER_COHORT"),
          })
          .strict(),
        permittedExclusions: z.array(z.string().min(1)).min(1),
        forbiddenSelectionInputs: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    measurementObjectives: z.array(measurementObjectiveSchema).length(3),
    providerPlan: z
      .object({
        directProvider: z.literal("DEXSCREENER"),
        categories: z
          .array(
            z
              .object({
                category: z.enum(["DISCOVERY", "MARKET_CONTEXT"]),
                capability: z.enum(["DISCOVER_TOKENS", "BEST_PAIR"]),
                requestShape: z.string().min(1),
                cohortRequestCap: z.number().int().positive(),
              })
              .strict(),
          )
          .length(2),
        maximumRequestsPerMinutePerCategory: z.literal(1),
        maximumConcurrencyPerCategory: z.literal(1),
        timeoutSeconds: z.literal(10),
        retryCount: z.literal(0),
        fallback: z.literal("PROHIBITED"),
        rawPayloadRetention: z.literal("PROHIBITED"),
        providerExpansion: z.literal("PROHIBITED"),
      })
      .strict(),
    collectionPlan: z
      .object({
        slotDurationMinutes: z.literal(120),
        maximumAttemptedSlots: z.literal(168),
        consecutiveUtcDates: z.literal(14),
        plannedUnits: z.literal(96),
        minimumValidUnits: z.literal(72),
        maximumUnitsPerSlot: z.literal(1),
        externalInvocation: z
          .object({
            startsAt: z.literal("SLOT_ANCHOR_MINUS_16_MINUTES"),
            finishesAt: z.literal("SLOT_ANCHOR"),
            overlappingInvocation: z.literal("PROHIBITED"),
          })
          .strict(),
        scheduledSnapshots: z.array(z.number().int()).length(4),
        partitionAssignment: z
          .object({
            assignmentHash: z.string().min(1),
            discoveryAssignment: z.literal("EVEN_FINAL_HEXADECIMAL_DIGIT"),
            validationAssignment: z.literal("ODD_FINAL_HEXADECIMAL_DIGIT"),
            minimumValidUnitsPerPartition: z.literal(32),
            minimumUtcDatesPerPartition: z.literal(4),
          })
          .strict(),
        independence: z
          .object({
            minimumUtcDates: z.literal(8),
            maximumValidUnitSharePerUtcDatePct: z.literal(20),
            minimumDistinctMints: z.literal(72),
          })
          .strict(),
        catchUp: z.literal("PROHIBITED"),
        replacement: z.literal("PROHIBITED"),
        sourceInventory: z.literal("SAFE_AGGREGATES_ONLY"),
      })
      .strict(),
    dataQualityAndMeasurementGates: z
      .object({
        availabilityPercentFormula: z.literal(
          "(AVAILABLE_AT_ANCHOR / VALID_UNITS_IN_PARTITION) * 100",
        ),
        minimumAvailabilityPctPerObjectivePerPartition: z.literal(90),
        minimumUtcDateSupportPerObjectivePerPartition: z.literal(4),
        provenanceConsistency: z.literal("EXACT_CATEGORY_AND_SOURCE_IDENTIFIER"),
        freshness: z.literal("DECLARED_OBJECTIVE_RULE_REQUIRED"),
        missingness: z.literal("EIGHT_CODE_ENUM_REQUIRED"),
        dataQualityStopConditions: z.array(z.string().min(1)).min(1),
        insufficiencyOutcome: z.literal("MEASUREMENT_COHORT_DATA_INSUFFICIENT"),
        stopOutcome: z.literal("MEASUREMENT_COHORT_DATA_QUALITY_STOP"),
      })
      .strict(),
    archiveContract: z
      .object({
        rootPattern: z.string().min(1),
        files: z.array(z.string().min(1)).length(4),
        retention: z.literal("IMMUTABLE_INDEFINITE"),
        forbiddenContent: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    outcomeBoundary: z
      .object({
        laterObservations: z.literal("ABSENT"),
        labels: z.literal("ABSENT"),
        prohibitedInputs: z.array(z.string().min(1)).min(1),
        protocolMutationWhileRunning: z.literal("PROHIBITED"),
      })
      .strict(),
    safety: z
      .object({
        buyScoreThreshold: z.literal(90),
        watchScoreThreshold: z.literal(70),
        paperExecution: z.literal("DISABLED"),
        unchangedF65E: z.literal("PROHIBITED"),
        oneOrTwoMinuteMonitoringChange: z.literal("PROHIBITED"),
        strategyDefaultChange: z.literal("PROHIBITED"),
        wallet: z.literal("PROHIBITED"),
        signing: z.literal("PROHIBITED"),
        submission: z.literal("PROHIBITED"),
        orders: z.literal("PROHIBITED"),
        fills: z.literal("PROHIBITED"),
        positions: z.literal("PROHIBITED"),
      })
      .strict(),
    downstreamAuthority: z
      .object({
        staticValidation: z.literal("REQUIRES_SEPARATE_EXPLICIT_APPROVAL"),
        collectionChecklist: z.literal("REQUIRES_SEPARATE_APPROVED_CHECKLIST"),
        collectorImplementation: z.literal("REQUIRES_SEPARATE_EXPLICIT_APPROVAL"),
        namedArchiveRoot: z.literal("REQUIRES_SEPARATE_EXPLICIT_APPROVAL"),
        scheduler: z.literal("REQUIRES_SEPARATE_EXPLICIT_APPROVAL"),
        analysis: z.literal("REQUIRES_SEPARATE_ARCHIVE_ONLY_APPROVAL"),
        phase10_6C: z.literal("NOT_AUTHORIZED"),
        execution: z.literal("NOT_AUTHORIZED"),
      })
      .strict(),
  })
  .strict();

export type MeasurementProtocolDraftV3 = z.infer<typeof measurementProtocolDraftSchema>;

export const measurementProtocolValidationSchema = z
  .object({
    contractVersion: z.literal("1"),
    generatedAt: z.string().datetime({ offset: true }),
    contentFingerprint: sha256Schema,
    protocol: z
      .object({
        path: z.string().min(1),
        sha256: sha256Schema,
        protocolId: z.literal("EXPLORATORY_COHORT_MEASUREMENT@v3"),
        authorityStatus: z.literal("NOT_AUTHORIZED_FOR_COLLECTION"),
      })
      .strict(),
    sourceEvidence: z
      .object({
        measurementAuditFingerprint: sha256Schema,
        v2ProtocolSha256: sha256Schema,
        objectiveFields: z.array(z.enum(["LIQUIDITY", "MOMENTUM_5M", "MOMENTUM_15M"])).length(3),
      })
      .strict(),
    safety: z
      .object({
        providerCalls: z.literal(0),
        httpCalls: z.literal(0),
        databaseReads: z.literal(0),
        databaseWrites: z.literal(0),
        archiveReads: z.literal(0),
        archiveWrites: z.literal(0),
        filesystemWrites: z.literal(0),
        runtimeCommands: z.literal(0),
        schedulerChanges: z.literal(0),
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
        status: z.literal(
          "MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW",
        ),
        authority: z.literal("NON_AUTHORIZING"),
      })
      .strict(),
    nextPermittedAction: z.string().min(1),
    warnings: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type MeasurementProtocolValidationV1 = z.infer<typeof measurementProtocolValidationSchema>;
