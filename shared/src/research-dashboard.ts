import { z } from "zod";

export const DASHBOARD_CONTRACT_VERSION = "1" as const;

export const dashboardOutcomeLabels = [
  "TARGET_FIRST",
  "STOP_FIRST",
  "MAX_HOLD",
  "NO_OBSERVATION",
  "AMBIGUOUS",
] as const;

const dashboardFeatureValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const dashboardSafetySchema = z.object({
  mode: z.literal("PAPER"),
  shadowOnly: z.literal(true),
  executionDisabled: z.literal(true),
  buyScoreThreshold: z.literal(90),
  watchScoreThreshold: z.literal(70),
  providerCalls: z.literal(false),
  databaseWrites: z.literal(false),
  sessionCreation: z.literal(false),
  walletLoaded: z.literal(false),
  transactionSigning: z.literal(false),
  transactionSubmission: z.literal(false),
});

export const dashboardProviderPressureSchema = z.object({
  provider: z.string(),
  stage: z.string(),
  total: z.number().nonnegative(),
  liveUpstreamRows: z.number().nonnegative(),
  routerRows: z.number().nonnegative(),
  upstreamRateLimited: z.number().nonnegative(),
  upstreamErrors: z.number().nonnegative(),
  cacheHits: z.number().nonnegative(),
  cooldownSkips: z.number().nonnegative(),
  unavailable: z.number().nonnegative(),
  localDeferrals: z.number().nonnegative(),
  quoteBudgetDeferrals: z.number().nonnegative().optional(),
  controllerDeferrals: z.number().nonnegative().optional(),
  venueGuardSkips: z.number().nonnegative().optional(),
  venueGuardAllows: z.number().nonnegative().optional(),
  sourceReport: z.string(),
});

export const dashboardRunSchema = z.object({
  id: z.string(),
  phase: z.string(),
  archivePath: z.string(),
  label: z.string(),
  mode: z.literal("PAPER"),
  shadowOnly: z.literal(true),
  safetyStatus: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  cycleCount: z.number().nonnegative(),
  sourceReports: z.array(z.string()),
  reportKinds: z.array(z.string()).optional(),
  providerPressure: z.array(dashboardProviderPressureSchema),
  warnings: z.array(z.string()),
});

export const dashboardFeatureSchema = z.object({
  family: z.string(),
  key: z.string(),
  value: dashboardFeatureValueSchema.optional(),
  availability: z.enum(["AVAILABLE_AT_DECISION_TIME", "UNAVAILABLE_AT_DECISION_TIME"]),
  sourceKind: z.string(),
  sourcePath: z.string(),
  sourceTimestampMs: z.number().optional(),
  unavailableReason: z.string().optional(),
});

export const dashboardCandidateSchema = z.object({
  id: z.string(),
  runId: z.string(),
  cohortId: z.string(),
  mintAddress: z.string(),
  symbol: z.string().optional(),
  decisionId: z.string(),
  decidedAt: z.string().datetime(),
  classification: z.string(),
  classificationReason: z.string(),
  decisionFeatures: z.array(dashboardFeatureSchema),
  outcomeLabel: z.object({
    label: z.enum(dashboardOutcomeLabels),
    exactCoverage: z.array(
      z.object({
        horizonMinutes: z.union([z.literal(3), z.literal(5), z.literal(15)]),
        onTime: z.boolean(),
      }),
    ),
    sourceReport: z.string(),
    description: z.literal("Later observation; not an entry input."),
  }),
});

export const dashboardCohortSchema = z.object({
  id: z.string(),
  phase: z.string(),
  label: z.string(),
  reportKind: z.string().optional(),
  memberRunIds: z.array(z.string()),
  candidateCount: z.number().nonnegative(),
  exactCoverageCount: z.number().nonnegative(),
  labelCounts: z.record(z.enum(dashboardOutcomeLabels), z.number().nonnegative()),
  conclusion: z.string(),
  conclusionReason: z.string(),
  concentration: z.object({
    selectedRunSharesPct: z.record(z.string(), z.number()),
    targetRunSharesPct: z.record(z.string(), z.number()),
    nonTargetRunSharesPct: z.record(z.string(), z.number()),
  }),
  gates: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
  sourceReport: z.string(),
});

export const dashboardResourceSchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().nonnegative(),
});

export const dashboardManifestSchema = z.object({
  contractVersion: z.literal(DASHBOARD_CONTRACT_VERSION),
  generatedAt: z.string().datetime(),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  archiveRoot: z.literal("data/archive"),
  requestedPhaseIncludes: z.array(z.string()).min(1),
  safety: dashboardSafetySchema,
  inputs: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  resources: z.object({
    runs: dashboardResourceSchema,
    cohorts: dashboardResourceSchema,
    candidates: dashboardResourceSchema,
  }),
  skippedInputs: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type DashboardSafety = z.infer<typeof dashboardSafetySchema>;
export type DashboardProviderPressure = z.infer<typeof dashboardProviderPressureSchema>;
export type DashboardRun = z.infer<typeof dashboardRunSchema>;
export type DashboardFeature = z.infer<typeof dashboardFeatureSchema>;
export type DashboardCandidate = z.infer<typeof dashboardCandidateSchema>;
export type DashboardCohort = z.infer<typeof dashboardCohortSchema>;
export type DashboardManifest = z.infer<typeof dashboardManifestSchema>;
