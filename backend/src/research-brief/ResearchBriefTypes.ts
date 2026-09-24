import { z } from "zod";

export const RESEARCH_BRIEF_CONTRACT_VERSION = "1" as const;

const outcomeLabelSchema = z.enum([
  "TARGET_FIRST",
  "STOP_FIRST",
  "MAX_HOLD",
  "NO_OBSERVATION",
  "AMBIGUOUS",
]);
const availabilitySchema = z.enum(["AVAILABLE_AT_DECISION_TIME", "UNAVAILABLE_AT_DECISION_TIME"]);
const relativeArchivePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split("/").includes("..") &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value),
    "must be an archive-relative path",
  );
const decisionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const countContextSchema = z.object({
  availability: z.enum(["AVAILABLE", "MISSING"]),
  value: z.number().nonnegative().optional(),
});

export const researchBriefSchema = z.object({
  contractVersion: z.literal(RESEARCH_BRIEF_CONTRACT_VERSION),
  generatedAt: z.string().datetime(),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.object({
    archiveRoot: z.literal("data/archive"),
    includePhases: z.array(z.enum(["phase9.28", "phase9.29"])).min(1),
    includeCohorts: z.array(z.string()),
  }),
  inputInventory: z.array(
    z.object({
      path: relativeArchivePathSchema,
      reportKind: z.enum(["TERMINAL_RUNNER_SUMMARY", "FAST_ENTRY_ATTRIBUTION_REPORT"]),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  safety: z.object({
    mode: z.literal("PAPER"),
    shadowOnly: z.literal(true),
    executionDisabled: z.literal(true),
    buyScoreThreshold: z.literal(90),
    watchScoreThreshold: z.literal(70),
    providerCalls: z.literal(0),
    databaseReads: z.literal(0),
    databaseWrites: z.literal(0),
    filesystemWrites: z.literal(0),
    sessionCreation: z.literal(0),
    orders: z.literal(0),
    fills: z.literal(0),
    positions: z.literal(0),
    walletLoaded: z.literal(false),
    transactionSigning: z.literal(false),
    transactionSubmission: z.literal(false),
  }),
  dataQuality: z.object({
    skippedInputs: z.array(z.object({ path: relativeArchivePathSchema, reason: z.string() })),
    unsupportedReports: z.array(z.object({ path: relativeArchivePathSchema, reason: z.string() })),
    reportAmbiguity: z.literal(false),
    missingDecisionTimeFactCount: z.number().nonnegative(),
    warnings: z.array(z.string()),
  }),
  runInventory: z.array(
    z.object({
      id: z.string(),
      archivePath: relativeArchivePathSchema,
      label: z.string(),
      mode: z.literal("PAPER"),
      shadowOnly: z.literal(true),
      safetyStatus: z.string(),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime(),
      cycleCount: z.number().nonnegative(),
      sourceReport: relativeArchivePathSchema,
      warnings: z.array(z.string()),
    }),
  ),
  providerPressureContext: z.array(
    z.object({
      provider: z.string(),
      sourceReports: z.array(relativeArchivePathSchema),
      total: countContextSchema,
      liveUpstreamRows: countContextSchema,
      routerRows: countContextSchema,
      upstreamRateLimited: countContextSchema,
      upstreamErrors: countContextSchema,
      cacheHits: countContextSchema,
      cooldownSkips: countContextSchema,
      unavailable: countContextSchema,
      quoteBudgetDeferrals: countContextSchema,
      controllerDeferrals: countContextSchema,
      venueGuardSkips: countContextSchema,
      venueGuardAllows: countContextSchema,
    }),
  ),
  candidateEvidence: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      cohortId: z.string(),
      mintAddress: z.string(),
      symbol: z.string().optional(),
      decisionId: z.string(),
      decidedAt: z.string().datetime(),
      classification: z.string(),
      classificationReason: z.string(),
      decisionTimeFacts: z.array(
        z.object({
          family: z.string(),
          key: z.string(),
          value: decisionValueSchema.optional(),
          availability: availabilitySchema,
          sourceKind: z.string(),
          sourceReport: relativeArchivePathSchema,
          sourceTimestampMs: z.number().optional(),
          unavailableReason: z.string().optional(),
        }),
      ),
    }),
  ),
  outcomeAnalysis: z.object({
    description: z.literal("Later observations; not entry inputs."),
    exactCoverageCount: z.number().nonnegative(),
    labelCounts: z.record(outcomeLabelSchema, z.number().nonnegative()),
    labels: z.array(
      z.object({
        candidateId: z.string(),
        label: outcomeLabelSchema,
        exactCoverage: z.array(
          z.object({
            horizonMinutes: z.union([z.literal(3), z.literal(5), z.literal(15)]),
            onTime: z.boolean(),
          }),
        ),
        sourceReport: relativeArchivePathSchema,
      }),
    ),
  }),
  concentrationAndGates: z.object({
    selectedRunSharesPct: z.record(z.string(), z.number()),
    targetRunSharesPct: z.record(z.string(), z.number()),
    nonTargetRunSharesPct: z.record(z.string(), z.number()),
    gates: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
  }),
  recordedConclusion: z.object({
    status: z.enum(["NO_DEFENSIBLE_HYPOTHESIS", "DATA_INSUFFICIENT", "HUMAN_REVIEW_REQUIRED"]),
    reason: z.string(),
    sourceReport: relativeArchivePathSchema.optional(),
  }),
  reviewProtocol: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type ResearchBriefV1 = z.infer<typeof researchBriefSchema>;
