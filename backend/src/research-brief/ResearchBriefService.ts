import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  resolveResearchBriefArchiveRoot,
  type ResearchBriefConfig,
} from "./ResearchBriefConfig.js";
import { ResearchBriefCatalog, type ResearchBriefSource } from "./ResearchBriefCatalog.js";
import { ResearchBriefError } from "./ResearchBriefErrors.js";
import {
  RESEARCH_BRIEF_CONTRACT_VERSION,
  researchBriefSchema,
  type ResearchBriefV1,
} from "./ResearchBriefTypes.js";

const outcomeLabels = [
  "TARGET_FIRST",
  "STOP_FIRST",
  "MAX_HOLD",
  "NO_OBSERVATION",
  "AMBIGUOUS",
] as const;
const conclusionStatuses = [
  "NO_DEFENSIBLE_HYPOTHESIS",
  "DATA_INSUFFICIENT",
  "HUMAN_REVIEW_REQUIRED",
] as const;

const rawRunnerSummarySchema = z.object({
  runId: z.string().min(1),
  mode: z.literal("PAPER"),
  shadowOnly: z.literal(true),
  safetyStatus: z.string().min(1),
  startedAtMs: z.number().finite(),
  endedAtMs: z.number().finite(),
  cycleCount: z.number().finite().nonnegative(),
  providerPressure: z.object({ providers: z.array(z.record(z.unknown())).optional() }),
});

const rawAttributionSchema = z.object({
  profile: z.object({ analysisKey: z.literal("F65E_ATTRIBUTION@v1") }),
  archives: z.array(z.object({ label: z.string().min(1), inputPath: z.string().min(1) })),
  runs: z.array(
    z.object({
      label: z.string().min(1),
      mechanicallyValid: z.boolean(),
      selectedCount: z.number().finite().nonnegative(),
    }),
  ),
  aggregate: z.object({
    selectedCount: z.number().finite().nonnegative(),
    exactCoverageCount: z.number().finite().nonnegative(),
    labelCounts: z.record(z.number().finite().nonnegative()),
    selectedRunSharesPct: z.record(z.number().finite().nonnegative()),
    targetRunSharesPct: z.record(z.number().finite().nonnegative()),
    nonTargetRunSharesPct: z.record(z.number().finite().nonnegative()),
  }),
  gates: z.array(
    z.object({ name: z.string().min(1), passed: z.boolean(), detail: z.string().min(1) }),
  ),
  recommendation: z.enum(conclusionStatuses),
  recommendationReason: z.string().min(1),
  candidates: z.array(
    z.object({
      runLabel: z.string().min(1),
      decisionId: z.string().min(1),
      mintAddress: z.string().min(1),
      symbol: z.string().min(1).optional(),
      decidedAtMs: z.number().finite(),
      classification: z.string().min(1),
      classificationReason: z.string().min(1),
      primaryLabel: z.enum(outcomeLabels),
      exactCoverage: z.array(
        z.object({
          horizonMinutes: z.union([z.literal(3), z.literal(5), z.literal(15)]),
          onTime: z.boolean(),
        }),
      ),
      features: z.array(
        z.object({
          key: z.string().min(1),
          family: z.string().min(1),
          value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
          source: z.object({
            kind: z.string().min(1),
            path: z.string().min(1),
            timestampMs: z.number().finite().optional(),
            availability: z.enum(["AVAILABLE_AT_DECISION_TIME", "UNAVAILABLE_AT_DECISION_TIME"]),
            unavailableReason: z.string().min(1).optional(),
          }),
        }),
      ),
    }),
  ),
});

type RawAttributionReport = z.infer<typeof rawAttributionSchema>;
type OutcomeLabel = (typeof outcomeLabels)[number];

interface NormalizedRun {
  readonly run: ResearchBriefV1["runInventory"][number];
  readonly providerRows: readonly {
    readonly sourceReport: string;
    readonly value: Record<string, unknown>;
  }[];
}

export class ResearchBriefService {
  constructor(
    private readonly options: {
      readonly config: ResearchBriefConfig;
      readonly now?: () => Date;
    },
  ) {}

  build(): ResearchBriefV1 {
    const archiveRoot = resolveResearchBriefArchiveRoot(this.options.config);
    const catalog = new ResearchBriefCatalog({ archiveRoot, config: this.options.config });
    const sources = catalog.discover();
    const normalizedRuns = sources.phase928RunnerSources.map(normalizeRunnerSource);
    const attribution = parseAttributionSources(sources.phase929AttributionSources);
    const candidates = attribution ? normalizeCandidates(attribution) : [];
    const outcomeAnalysis = attribution
      ? normalizeOutcomeAnalysis(attribution, candidates)
      : emptyOutcomeAnalysis();

    if (attribution) {
      assertAttributionConsistency(attribution, candidates, outcomeAnalysis);
      assertAttributionRunSources(
        attribution,
        normalizedRuns.map((entry) => entry.run),
      );
    }

    const inputInventory = [
      ...sources.phase928RunnerSources.map((source) => ({
        path: source.relativePath,
        reportKind: "TERMINAL_RUNNER_SUMMARY" as const,
        sha256: source.sha256,
      })),
      ...sources.phase929AttributionSources.map((source) => ({
        path: source.relativePath,
        reportKind: "FAST_ENTRY_ATTRIBUTION_REPORT" as const,
        sha256: source.sha256,
      })),
    ].sort(compareByPath);
    const missingDecisionTimeFactCount = candidates.reduce(
      (total, candidate) =>
        total +
        candidate.decisionTimeFacts.filter(
          (feature) => feature.availability === "UNAVAILABLE_AT_DECISION_TIME",
        ).length,
      0,
    );
    const draft = researchBriefSchema.parse({
      contractVersion: RESEARCH_BRIEF_CONTRACT_VERSION,
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint: "0".repeat(64),
      scope: {
        archiveRoot: "data/archive",
        includePhases: [...this.options.config.includePhases].sort(),
        includeCohorts: [...this.options.config.includeCohorts].sort(),
      },
      inputInventory,
      safety: {
        mode: "PAPER",
        shadowOnly: true,
        executionDisabled: true,
        buyScoreThreshold: 90,
        watchScoreThreshold: 70,
        providerCalls: 0,
        databaseReads: 0,
        databaseWrites: 0,
        filesystemWrites: 0,
        sessionCreation: 0,
        orders: 0,
        fills: 0,
        positions: 0,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
      dataQuality: {
        skippedInputs: [...sources.skippedInputs].sort(compareByPath),
        unsupportedReports: [],
        reportAmbiguity: false,
        missingDecisionTimeFactCount,
        warnings: attribution
          ? []
          : ["No supported Phase 9.29 attribution report was included in the explicit scope."],
      },
      runInventory: normalizedRuns.map((entry) => entry.run).sort(compareById),
      providerPressureContext: normalizeProviderPressure(normalizedRuns),
      candidateEvidence: candidates,
      outcomeAnalysis,
      concentrationAndGates: attribution
        ? {
            selectedRunSharesPct: sortRecord(attribution.report.aggregate.selectedRunSharesPct),
            targetRunSharesPct: sortRecord(attribution.report.aggregate.targetRunSharesPct),
            nonTargetRunSharesPct: sortRecord(attribution.report.aggregate.nonTargetRunSharesPct),
            gates: [...attribution.report.gates].sort(compareByName),
          }
        : {
            selectedRunSharesPct: {},
            targetRunSharesPct: {},
            nonTargetRunSharesPct: {},
            gates: [],
          },
      recordedConclusion: attribution
        ? {
            status: attribution.report.recommendation,
            reason: attribution.report.recommendationReason,
            sourceReport: attribution.source.relativePath,
          }
        : {
            status: "DATA_INSUFFICIENT",
            reason:
              "No supported Phase 9.29 attribution report was included in the explicit scope.",
          },
      reviewProtocol: fixedReviewProtocol,
      warnings: attribution
        ? ["Outcome labels are later observations and are not entry inputs."]
        : ["The explicit scope is valid but lacks a supported attribution conclusion."],
    });
    const brief = researchBriefSchema.parse({
      ...draft,
      contentFingerprint: fingerprintResearchBrief(draft),
    });
    assertNoCredentialLikeValue(brief);
    return brief;
  }
}

export function canonicalResearchBriefJson(brief: ResearchBriefV1): string {
  return stableJson(withoutGeneratedAt(brief));
}

export function fingerprintResearchBrief(brief: ResearchBriefV1): string {
  return sha256(stableJson({ ...withoutGeneratedAt(brief), contentFingerprint: "" }));
}

export function assertNoCredentialLikeValue(value: unknown, location = "research brief"): void {
  if (typeof value === "string") {
    if (/\b(?:api[ _-]?key|authorization|bearer|private[ _-]?key|secret|password)\b/i.test(value)) {
      throw new ResearchBriefError(
        "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
        `Research brief rejected credential-like content at ${location}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialLikeValue(item, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) =>
      assertNoCredentialLikeValue(item, `${location}.${key}`),
    );
  }
}

function normalizeRunnerSource(source: ResearchBriefSource): NormalizedRun {
  const parsed = rawRunnerSummarySchema.safeParse(source.value);
  if (!parsed.success) {
    throw new ResearchBriefError(
      "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
      `Unsupported Phase 9.28 TerminalRunner summary: ${source.relativePath}.`,
    );
  }
  const summary = parsed.data;
  const archivePath = archivePathForRunnerSource(source.relativePath);
  return {
    run: {
      id: runId(archivePath),
      archivePath,
      label: path.posix.basename(archivePath),
      mode: summary.mode,
      shadowOnly: summary.shadowOnly,
      safetyStatus: summary.safetyStatus,
      startedAt: new Date(summary.startedAtMs).toISOString(),
      endedAt: new Date(summary.endedAtMs).toISOString(),
      cycleCount: summary.cycleCount,
      sourceReport: source.relativePath,
      warnings: [],
    },
    providerRows: (summary.providerPressure.providers ?? [])
      .filter(isRecord)
      .map((value) => ({ sourceReport: source.relativePath, value })),
  };
}

function parseAttributionSources(
  sources: readonly ResearchBriefSource[],
): { readonly source: ResearchBriefSource; readonly report: RawAttributionReport } | undefined {
  if (sources.length === 0) return undefined;
  if (sources.length !== 1) {
    throw new ResearchBriefError(
      "RESEARCH_BRIEF_AMBIGUOUS_REPORT",
      "The explicit Phase 9.29 cohort contains more than one report candidate.",
    );
  }
  const source = sources[0] as ResearchBriefSource;
  return { source, report: parseResearchBriefAttributionReport(source.value, source.relativePath) };
}

export function parseResearchBriefAttributionReport(
  value: unknown,
  sourcePath: string,
): RawAttributionReport {
  const parsed = rawAttributionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ResearchBriefError(
      "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
      `Unsupported Phase 9.29 attribution report: ${sourcePath}.`,
    );
  }
  return parsed.data;
}

function normalizeCandidates(attribution: {
  readonly source: ResearchBriefSource;
  readonly report: RawAttributionReport;
}): ResearchBriefV1["candidateEvidence"] {
  const archiveByLabel = new Map(
    attribution.report.archives.map((archive) => [
      archive.label,
      archivePathFromRawInput(archive.inputPath),
    ]),
  );
  return attribution.report.candidates
    .map((candidate) => {
      const archivePath = archiveByLabel.get(candidate.runLabel);
      if (!archivePath) {
        throw new ResearchBriefError(
          "RESEARCH_BRIEF_SOURCE_INCONSISTENCY",
          "A Phase 9.29 candidate references an unknown archived run label.",
        );
      }
      const id = `${runId(archivePath)}:${candidate.decisionId}`;
      return {
        id,
        runId: runId(archivePath),
        cohortId: "cohort:phase9.29:F65E_ATTRIBUTION@v1",
        mintAddress: candidate.mintAddress,
        ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
        decisionId: candidate.decisionId,
        decidedAt: new Date(candidate.decidedAtMs).toISOString(),
        classification: candidate.classification,
        classificationReason: candidate.classificationReason,
        decisionTimeFacts: candidate.features
          .map((feature) => {
            if (
              feature.source.availability === "UNAVAILABLE_AT_DECISION_TIME" &&
              feature.value !== undefined
            ) {
              throw new ResearchBriefError(
                "RESEARCH_BRIEF_SOURCE_INCONSISTENCY",
                "A decision-time feature is unavailable but has a recorded value.",
              );
            }
            return {
              family: feature.family,
              key: feature.key,
              ...(feature.value === undefined
                ? {}
                : { value: Array.isArray(feature.value) ? [...feature.value] : feature.value }),
              availability: feature.source.availability,
              sourceKind: feature.source.kind,
              sourceReport: attribution.source.relativePath,
              ...(feature.source.timestampMs === undefined
                ? {}
                : { sourceTimestampMs: feature.source.timestampMs }),
              ...(feature.source.unavailableReason === undefined
                ? {}
                : { unavailableReason: feature.source.unavailableReason }),
            };
          })
          .sort(compareFeature),
      };
    })
    .sort(compareById);
}

function normalizeOutcomeAnalysis(
  attribution: { readonly source: ResearchBriefSource; readonly report: RawAttributionReport },
  candidates: ResearchBriefV1["candidateEvidence"],
): ResearchBriefV1["outcomeAnalysis"] {
  const candidateIds = new Map(candidates.map((candidate) => [candidate.decisionId, candidate.id]));
  return {
    description: "Later observations; not entry inputs.",
    exactCoverageCount: attribution.report.aggregate.exactCoverageCount,
    labelCounts: completeLabelCounts(attribution.report.aggregate.labelCounts),
    labels: attribution.report.candidates
      .map((candidate) => {
        const candidateId = candidateIds.get(candidate.decisionId);
        if (!candidateId) {
          throw new ResearchBriefError(
            "RESEARCH_BRIEF_SOURCE_INCONSISTENCY",
            "A Phase 9.29 outcome does not have a decision-time candidate identity.",
          );
        }
        return {
          candidateId,
          label: candidate.primaryLabel,
          exactCoverage: [...candidate.exactCoverage].sort(
            (left, right) => left.horizonMinutes - right.horizonMinutes,
          ),
          sourceReport: attribution.source.relativePath,
        };
      })
      .sort(compareByCandidateId),
  };
}

function emptyOutcomeAnalysis(): ResearchBriefV1["outcomeAnalysis"] {
  return {
    description: "Later observations; not entry inputs.",
    exactCoverageCount: 0,
    labelCounts: zeroLabelCounts(),
    labels: [],
  };
}

function assertAttributionConsistency(
  attribution: { readonly source: ResearchBriefSource; readonly report: RawAttributionReport },
  candidates: ResearchBriefV1["candidateEvidence"],
  outcomeAnalysis: ResearchBriefV1["outcomeAnalysis"],
): void {
  const report = attribution.report;
  if (report.aggregate.selectedCount !== candidates.length) {
    throw inconsistent(
      "The recorded selected candidate count does not match the candidate evidence.",
    );
  }
  assertResearchBriefOutcomeLabels(
    outcomeAnalysis.labelCounts,
    outcomeAnalysis.labels.map((entry) => entry.label),
  );
  const derivedExactCoverage = outcomeAnalysis.labels.filter(
    (entry) =>
      entry.exactCoverage.length === 3 &&
      entry.exactCoverage.every((coverage) => coverage.onTime) &&
      entry.exactCoverage.map((coverage) => coverage.horizonMinutes).join(",") === "3,5,15",
  ).length;
  if (report.aggregate.exactCoverageCount !== derivedExactCoverage) {
    throw inconsistent("The recorded exact-coverage count does not match the outcome labels.");
  }
  const runLabels = new Set(report.runs.map((run) => run.label));
  if (
    runLabels.size !== report.runs.length ||
    report.candidates.some((candidate) => !runLabels.has(candidate.runLabel)) ||
    report.runs.some(
      (run) =>
        run.selectedCount !==
        report.candidates.filter((candidate) => candidate.runLabel === run.label).length,
    )
  ) {
    throw inconsistent("The recorded run membership does not match the candidate evidence.");
  }
  assertSharesMatch(report.aggregate.selectedRunSharesPct, shareByRun(report.candidates));
  assertSharesMatch(
    report.aggregate.targetRunSharesPct,
    shareByRun(report.candidates.filter((candidate) => candidate.primaryLabel === "TARGET_FIRST")),
  );
  assertSharesMatch(
    report.aggregate.nonTargetRunSharesPct,
    shareByRun(report.candidates.filter((candidate) => candidate.primaryLabel !== "TARGET_FIRST")),
  );
}

export function assertResearchBriefOutcomeLabels(
  recordedCounts: Record<string, number>,
  labels: readonly OutcomeLabel[],
): void {
  const derivedLabels = completeLabelCounts(
    Object.fromEntries(
      outcomeLabels.map((label) => [
        label,
        labels.filter((candidateLabel) => candidateLabel === label).length,
      ]),
    ),
  );
  if (!sameRecord(derivedLabels, completeLabelCounts(recordedCounts))) {
    throw inconsistent("The recorded outcome labels do not match the candidate evidence.");
  }
}

function assertAttributionRunSources(
  attribution: { readonly source: ResearchBriefSource; readonly report: RawAttributionReport },
  runs: readonly ResearchBriefV1["runInventory"][number][],
): void {
  if (runs.length === 0) return;
  const knownRunIds = new Set(runs.map((run) => run.id));
  for (const archive of attribution.report.archives) {
    if (!knownRunIds.has(runId(archivePathFromRawInput(archive.inputPath)))) {
      throw inconsistent(
        "The attribution report references a run outside the selected Phase 9.28 sources.",
      );
    }
  }
}

function normalizeProviderPressure(
  normalizedRuns: readonly NormalizedRun[],
): ResearchBriefV1["providerPressureContext"] {
  const grouped = new Map<
    string,
    { readonly sourceReport: string; readonly value: Record<string, unknown> }[]
  >();
  for (const run of normalizedRuns) {
    for (const row of run.providerRows) {
      const provider = stringValue(row.value.provider);
      if (!provider) continue;
      const rows = grouped.get(provider) ?? [];
      rows.push(row);
      grouped.set(provider, rows);
    }
  }
  return [...grouped.entries()]
    .map(([provider, rows]) => ({
      provider,
      sourceReports: rows.map((row) => row.sourceReport).sort(),
      total: sumContext(rows, (row) => row.total),
      liveUpstreamRows: sumContext(rows, (row) => row.liveRows),
      routerRows: sumContext(rows, (row) => row.routerRows),
      upstreamRateLimited: sumContext(rows, (row) => row.liveRateLimitedCount),
      upstreamErrors: sumContext(rows, (row) => row.liveErrorCount),
      cacheHits: sumContext(rows, (row) => row.routerCacheHits),
      cooldownSkips: sumContext(rows, (row) => row.routerCooldownSkips),
      unavailable: sumContext(rows, (row) => row.routerUnavailable),
      quoteBudgetDeferrals: sumContext(rows, (row) =>
        recordNumber(row.quoteDemandActionCounts, "QUOTE_BUDGET_NOT_SELECTED"),
      ),
      controllerDeferrals: sumContext(
        rows,
        (row) =>
          recordNumber(row.quoteDemandActionCounts, "JUPITER_DEMAND_DEFERRED") ??
          recordNumber(row.jupiterDemandActionCounts, "DEFERRED_MIN_INTERVAL"),
      ),
      venueGuardSkips: sumContext(rows, (row) =>
        recordNumber(row.quoteDemandActionCounts, "VENUE_GUARD_SKIP"),
      ),
      venueGuardAllows: sumContext(rows, (row) =>
        recordNumber(row.raydiumVenueGuardDecisionCounts, "ALLOW"),
      ),
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function sumContext(
  rows: readonly { readonly value: Record<string, unknown> }[],
  getValue: (row: Record<string, unknown>) => unknown,
): { readonly availability: "AVAILABLE" | "MISSING"; readonly value?: number } {
  const values = rows.map((row) => getValue(row.value));
  if (values.some((value) => !isNonnegativeNumber(value))) return { availability: "MISSING" };
  return {
    availability: "AVAILABLE",
    value: values.reduce<number>((sum, value) => sum + Number(value), 0),
  };
}

function archivePathForRunnerSource(sourcePath: string): string {
  const marker = "/runner-output/";
  const index = sourcePath.indexOf(marker);
  if (index <= 0) {
    throw new ResearchBriefError(
      "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
      "A canonical runner report does not have a runner-output archive path.",
    );
  }
  return sourcePath.slice(0, index);
}

function archivePathFromRawInput(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const marker = "data/archive/";
  const index = normalized.toLowerCase().indexOf(marker);
  if (index < 0) {
    throw inconsistent("An attribution source path is not under data/archive.");
  }
  const relative = normalized.slice(index + marker.length);
  const runnerMarker = "/runner-output/";
  const runnerIndex = relative.indexOf(runnerMarker);
  return runnerIndex > 0 ? relative.slice(0, runnerIndex) : relative;
}

function runId(archivePath: string): string {
  return `run:${archivePath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function completeLabelCounts(value: Record<string, number>): Record<OutcomeLabel, number> {
  return Object.fromEntries(
    outcomeLabels.map((label) => {
      const count = value[label];
      if (count === undefined) {
        throw inconsistent(`The attribution report is missing the ${label} label count.`);
      }
      return [label, count];
    }),
  ) as Record<OutcomeLabel, number>;
}

function zeroLabelCounts(): Record<OutcomeLabel, number> {
  return Object.fromEntries(outcomeLabels.map((label) => [label, 0])) as Record<
    OutcomeLabel,
    number
  >;
}

function shareByRun(
  candidates: readonly RawAttributionReport["candidates"][number][],
): Record<string, number> {
  if (candidates.length === 0) return {};
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.runLabel, (counts.get(candidate.runLabel) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, count]) => [label, (count / candidates.length) * 100]),
  );
}

function assertSharesMatch(
  recorded: Record<string, number>,
  derived: Record<string, number>,
): void {
  const recordedKeys = Object.keys(recorded).sort();
  const derivedKeys = Object.keys(derived).sort();
  if (
    recordedKeys.length !== derivedKeys.length ||
    recordedKeys.some((key, index) => key !== derivedKeys[index]) ||
    recordedKeys.some(
      (key) => Math.abs((recorded[key] as number) - (derived[key] as number)) > 1e-9,
    )
  ) {
    throw inconsistent("The recorded source-run concentration does not match candidate evidence.");
  }
}

function recordNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && isNonnegativeNumber(value[key]) ? value[key] : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sameRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function sortRecord(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key] as number]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function withoutGeneratedAt(brief: ResearchBriefV1): Record<string, unknown> {
  return Object.fromEntries(Object.entries(brief).filter(([key]) => key !== "generatedAt"));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inconsistent(message: string): ResearchBriefError {
  return new ResearchBriefError("RESEARCH_BRIEF_SOURCE_INCONSISTENCY", message);
}

function compareByPath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path.localeCompare(right.path);
}

function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function compareByCandidateId(
  left: { readonly candidateId: string },
  right: { readonly candidateId: string },
): number {
  return left.candidateId.localeCompare(right.candidateId);
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

function compareFeature(
  left: { readonly family: string; readonly key: string },
  right: { readonly family: string; readonly key: string },
): number {
  return left.family.localeCompare(right.family) || left.key.localeCompare(right.key);
}

const fixedReviewProtocol = [
  "State the explicit archive scope and every data-quality limitation.",
  "State decision-time evidence separately from later outcome labels.",
  "State concentration and recorded gate results before discussing the recorded conclusion.",
  "State only the permitted next action: archive review, no-defensible-hypothesis, or human review.",
  "State prohibited actions: no threshold/profile/default change, unchanged F65E collection, execution enablement, provider call, or runtime command.",
] as const;
