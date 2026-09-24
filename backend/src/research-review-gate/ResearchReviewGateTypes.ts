import { z } from "zod";

export const RESEARCH_REVIEW_GATE_CONTRACT_VERSION = "1" as const;

export const reviewFactKeys = [
  "EXACT_COVERAGE",
  "LATER_LABELS",
  "SELECTED_RUN_CONCENTRATION",
  "NON_TARGET_RUN_CONCENTRATION",
  "RECORDED_CONCLUSION",
  "FAILED_GATES",
  "UNCHANGED_F65E_PROHIBITED",
] as const;
export const reviewAssertionCodes = [
  "CONFIRMS_COUNT",
  "CONFIRMS_LABEL_BOUNDARY",
  "CONFIRMS_GATE_FAILURE",
  "CONFIRMS_DEFAULT_DENY",
  "CONFIRMS_PROHIBITION",
] as const;
export const failedGateNames = [
  "independent_label_run_support",
  "leave_one_mint_out_direction",
  "leave_one_run_out_direction",
  "narrow_single_fact_predicate",
  "non_target_run_concentration",
  "selected_run_concentration",
  "target_run_concentration",
] as const;

const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split("/").includes("..") &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value),
    "must be a repository- or archive-relative path",
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sanitizedNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      /^[\x20-\x7E]+$/.test(value) && !value.includes("[") && !/[`*_#\]<>{}\\]/.test(value),
    "must be sanitized plain text",
  );
const assertionSchema = z
  .object({
    factKey: z.enum(reviewFactKeys),
    assertionCode: z.enum(reviewAssertionCodes),
    note: sanitizedNoteSchema.optional(),
  })
  .strict();

const expectedAssertionCode: Record<
  (typeof reviewFactKeys)[number],
  (typeof reviewAssertionCodes)[number]
> = {
  EXACT_COVERAGE: "CONFIRMS_COUNT",
  LATER_LABELS: "CONFIRMS_LABEL_BOUNDARY",
  SELECTED_RUN_CONCENTRATION: "CONFIRMS_GATE_FAILURE",
  NON_TARGET_RUN_CONCENTRATION: "CONFIRMS_GATE_FAILURE",
  RECORDED_CONCLUSION: "CONFIRMS_DEFAULT_DENY",
  FAILED_GATES: "CONFIRMS_GATE_FAILURE",
  UNCHANGED_F65E_PROHIBITED: "CONFIRMS_PROHIBITION",
};

export const researchReviewRecordSchema = z
  .object({
    contractVersion: z.literal(RESEARCH_REVIEW_GATE_CONTRACT_VERSION),
    briefFingerprint: sha256Schema,
    scope: z
      .object({
        archiveRoot: z.literal("data/archive"),
        includePhases: z.array(z.enum(["phase9.28", "phase9.29"])).length(2),
        includeCohorts: z.array(z.string()).length(1),
      })
      .strict(),
    reviewAssertions: z.array(assertionSchema).length(reviewFactKeys.length),
    outcome: z
      .object({
        status: z.literal("NO_STUDY_AUTHORIZED"),
        blockingReasons: z.array(z.enum(failedGateNames)).length(failedGateNames.length),
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    const seenFactKeys = new Set(record.reviewAssertions.map((assertion) => assertion.factKey));
    if (seenFactKeys.size !== reviewFactKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "review assertions must be unique.",
      });
    }
    for (const assertion of record.reviewAssertions) {
      if (assertion.assertionCode !== expectedAssertionCode[assertion.factKey]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "review assertion code does not match its fact key.",
        });
      }
    }
    for (const factKey of reviewFactKeys) {
      if (!seenFactKeys.has(factKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "review assertions are incomplete.",
        });
      }
    }
    if (new Set(record.outcome.blockingReasons).size !== failedGateNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blocking reasons must be unique.",
      });
    }
  });

const outputAssertionSchema = assertionSchema.extend({ sourceReport: relativePathSchema }).strict();

export const researchReviewGateSchema = z.object({
  contractVersion: z.literal(RESEARCH_REVIEW_GATE_CONTRACT_VERSION),
  generatedAt: z.string().datetime(),
  contentFingerprint: sha256Schema,
  briefFingerprint: sha256Schema,
  scope: z.object({
    archiveRoot: z.literal("data/archive"),
    includePhases: z.array(z.enum(["phase9.28", "phase9.29"])).length(2),
    includeCohorts: z.array(z.string()).length(1),
  }),
  inputInventory: z.array(
    z.object({
      path: relativePathSchema,
      sourceType: z.enum([
        "TERMINAL_RUNNER_SUMMARY",
        "FAST_ENTRY_ATTRIBUTION_REPORT",
        "RESEARCH_REVIEW_RECORD",
      ]),
      sha256: sha256Schema,
    }),
  ),
  safety: z.object({
    mode: z.literal("PAPER"),
    shadowOnly: z.literal(true),
    executionDisabled: z.literal(true),
    buyScoreThreshold: z.literal(90),
    watchScoreThreshold: z.literal(70),
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
  }),
  evidenceSummary: z.object({
    sourceCount: z.literal(6),
    runnerSummaryCount: z.literal(5),
    attributionReportCount: z.literal(1),
    candidateCount: z.literal(7),
    exactCoverageCount: z.literal(7),
    labelCounts: z.object({
      TARGET_FIRST: z.literal(3),
      STOP_FIRST: z.literal(3),
      MAX_HOLD: z.literal(1),
      NO_OBSERVATION: z.literal(0),
      AMBIGUOUS: z.literal(0),
    }),
    selectedRunSharesPct: z.record(z.number()),
    nonTargetRunSharesPct: z.record(z.number()),
    gates: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
    recordedConclusion: z.object({
      status: z.literal("NO_DEFENSIBLE_HYPOTHESIS"),
      reason: z.string(),
      sourceReport: relativePathSchema,
    }),
  }),
  reviewAssertions: z.array(outputAssertionSchema).length(reviewFactKeys.length),
  outcome: z.object({
    status: z.literal("NO_STUDY_AUTHORIZED"),
    blockingReasons: z.array(z.enum(failedGateNames)).length(failedGateNames.length),
  }),
  nextPermittedAction: z.literal(
    "No new study is authorized. Do not collect unchanged F65E@v1 data, alter defaults or thresholds, enable PAPER execution, call providers, or begin Phase 10.6. A later distinct study requires a separate explicitly approved Phase 10.6 implementation plan.",
  ),
  warnings: z.array(z.string()),
});

export type ResearchReviewRecordV1 = z.infer<typeof researchReviewRecordSchema>;
export type ResearchReviewGateV1 = z.infer<typeof researchReviewGateSchema>;
