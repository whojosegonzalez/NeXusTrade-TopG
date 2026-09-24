import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DASHBOARD_CONTRACT_VERSION,
  dashboardCandidateSchema,
  dashboardCohortSchema,
  dashboardManifestSchema,
  dashboardRunSchema,
} from "@nexustrade/shared";
import type {
  DashboardCandidate,
  DashboardCohort,
  DashboardProviderPressure,
  DashboardRun,
} from "@nexustrade/shared";

import {
  resolveDashboardArchiveRoot,
  resolveDashboardOutputDir,
  type DashboardExportConfig,
} from "./DashboardExportConfig.js";
import { ArchiveCatalogBuilder } from "./ArchiveCatalogBuilder.js";
import type { DashboardExportBundle, DashboardExportResult } from "./DashboardExportTypes.js";

const outcomeLabels = [
  "TARGET_FIRST",
  "STOP_FIRST",
  "MAX_HOLD",
  "NO_OBSERVATION",
  "AMBIGUOUS",
] as const;

type OutcomeLabel = (typeof outcomeLabels)[number];

interface RawRunnerSummary {
  readonly runId: string;
  readonly mode: "PAPER";
  readonly shadowOnly: true;
  readonly safetyStatus: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly cycleCount: number;
  readonly providerPressure: {
    readonly providers?: readonly Record<string, unknown>[];
  };
}

interface RawAttributionReport {
  readonly profile: { readonly analysisKey: "F65E_ATTRIBUTION@v1" };
  readonly archives: readonly { readonly label: string; readonly inputPath: string }[];
  readonly runs: readonly {
    readonly label: string;
    readonly mechanicallyValid: boolean;
    readonly selectedCount: number;
  }[];
  readonly aggregate: {
    readonly selectedCount: number;
    readonly exactCoverageCount: number;
    readonly labelCounts: Record<OutcomeLabel, number>;
    readonly selectedRunSharesPct: Record<string, number>;
    readonly targetRunSharesPct: Record<string, number>;
    readonly nonTargetRunSharesPct: Record<string, number>;
  };
  readonly gates: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
  readonly recommendation: string;
  readonly recommendationReason: string;
  readonly candidates: readonly {
    readonly runLabel: string;
    readonly decisionId: string;
    readonly mintAddress: string;
    readonly symbol?: string;
    readonly decidedAtMs: number;
    readonly classification: string;
    readonly classificationReason: string;
    readonly primaryLabel: OutcomeLabel;
    readonly exactCoverage: readonly {
      readonly horizonMinutes: 3 | 5 | 15;
      readonly onTime: boolean;
    }[];
    readonly features: readonly {
      readonly key: string;
      readonly family: string;
      readonly value?: string | number | boolean | readonly string[];
      readonly source: {
        readonly kind: string;
        readonly path: string;
        readonly timestampMs?: number;
        readonly availability: "AVAILABLE_AT_DECISION_TIME" | "UNAVAILABLE_AT_DECISION_TIME";
        readonly unavailableReason?: string;
      };
    }[];
  }[];
}

export class DashboardExportService {
  constructor(
    private readonly options: {
      readonly config: DashboardExportConfig;
      readonly now?: () => Date;
    },
  ) {}

  build(): DashboardExportBundle {
    const archiveRoot = resolveDashboardArchiveRoot(this.options.config.archiveRoot);
    const catalog = new ArchiveCatalogBuilder({
      archiveRoot,
      includePhases: this.options.config.includePhases,
      includeCohorts: this.options.config.includeCohorts,
    });
    const selectedPhases = catalog.validateIncludedPhases();

    const inputs: { path: string; sha256: string }[] = [];
    const runs = selectedPhases.includes("phase9.28")
      ? this.loadPhase928Runs(archiveRoot, catalog, inputs)
      : [];
    const attribution = selectedPhases.includes("phase9.29")
      ? this.loadPhase929Attribution(archiveRoot, catalog, inputs)
      : undefined;
    const cohorts = attribution ? [this.toCohort(attribution.report, attribution.reportPath)] : [];
    const candidates = attribution
      ? this.toCandidates(attribution.report, attribution.reportPath)
      : [];

    const resourcePayloads = {
      runs: serialize(runs),
      cohorts: serialize(cohorts),
      candidates: serialize(candidates),
    };
    const resources = {
      runs: { path: "runs.v1.json", sha256: sha256(resourcePayloads.runs), count: runs.length },
      cohorts: {
        path: "cohorts.v1.json",
        sha256: sha256(resourcePayloads.cohorts),
        count: cohorts.length,
      },
      candidates: {
        path: "candidates.v1.json",
        sha256: sha256(resourcePayloads.candidates),
        count: candidates.length,
      },
    };
    const safety = {
      mode: "PAPER" as const,
      shadowOnly: true as const,
      executionDisabled: true as const,
      buyScoreThreshold: 90 as const,
      watchScoreThreshold: 70 as const,
      providerCalls: false as const,
      databaseWrites: false as const,
      sessionCreation: false as const,
      walletLoaded: false as const,
      transactionSigning: false as const,
      transactionSubmission: false as const,
    };
    const contentFingerprint = sha256(
      serialize({
        contractVersion: DASHBOARD_CONTRACT_VERSION,
        archiveRoot: "data/archive",
        requestedPhaseIncludes: selectedPhases,
        requestedCohortIncludes: [...this.options.config.includeCohorts].sort(),
        safety,
        inputs: inputs.sort(compareByPath),
        resources,
      }),
    );
    const manifest = dashboardManifestSchema.parse({
      contractVersion: DASHBOARD_CONTRACT_VERSION,
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint,
      archiveRoot: "data/archive",
      requestedPhaseIncludes: selectedPhases,
      safety,
      inputs: inputs.sort(compareByPath),
      resources,
      skippedInputs: selectedPhases.includes("phase9.28")
        ? ["phase9.28/legacy-root-artifacts-20260818"]
        : [],
      warnings: attribution
        ? ["Outcome labels are later observations and are not entry inputs."]
        : ["No supported Phase 9.29 attribution report was included."],
    });

    const bundle = {
      manifest,
      runs: runs.sort(compareById),
      cohorts: cohorts.sort(compareById),
      candidates: candidates.sort(compareById),
    };
    assertNoCredentialLikeValue(bundle);
    return bundle;
  }

  write(): DashboardExportResult {
    const bundle = this.build();
    const outputDir = resolveDashboardOutputDir(this.options.config.outputDir);
    mkdirSync(outputDir, { recursive: true });
    const files = [
      ["manifest.v1.json", bundle.manifest],
      ["runs.v1.json", bundle.runs],
      ["cohorts.v1.json", bundle.cohorts],
      ["candidates.v1.json", bundle.candidates],
    ] as const;
    for (const [name, value] of files) {
      writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
    return { bundle, writtenFiles: files.map(([name]) => path.join(outputDir, name)) };
  }

  private loadPhase928Runs(
    archiveRoot: string,
    catalog: ArchiveCatalogBuilder,
    inputs: { path: string; sha256: string }[],
  ): DashboardRun[] {
    return catalog.directDirectories("phase9.28").flatMap((runPath) => {
      const runnerDirectory = path.join(runPath, "runner-output");
      if (!existsSync(runnerDirectory) || !statSync(runnerDirectory).isDirectory()) return [];
      const jsonNames = readdirSync(runnerDirectory)
        .filter((name) => name.endsWith(".json"))
        .sort();
      if (jsonNames.length !== 1) {
        throw new Error(
          `Phase 9.28 archive must contain exactly one canonical runner JSON: ${archiveRelative(archiveRoot, runPath)}.`,
        );
      }
      const reportPath = path.join(runnerDirectory, jsonNames[0] as string);
      const source = readJson(reportPath);
      const summary = parseRunnerSummary(source, archiveRelative(archiveRoot, reportPath));
      const archivePath = archiveRelative(archiveRoot, runPath);
      const sourceReport = archiveRelative(archiveRoot, reportPath);
      inputs.push({ path: sourceReport, sha256: sha256(readFileSync(reportPath)) });
      return [
        dashboardRunSchema.parse({
          id: runId(archivePath),
          phase: "phase9.28",
          archivePath,
          label: path.basename(runPath),
          mode: summary.mode,
          shadowOnly: summary.shadowOnly,
          safetyStatus: summary.safetyStatus,
          startedAt: new Date(summary.startedAtMs).toISOString(),
          endedAt: new Date(summary.endedAtMs).toISOString(),
          cycleCount: summary.cycleCount,
          sourceReports: [sourceReport],
          reportKinds: ["TERMINAL_RUNNER_SUMMARY"],
          providerPressure: normalizeProviderPressure(
            summary.providerPressure.providers,
            sourceReport,
          ),
          warnings: [],
        }),
      ];
    });
  }

  private loadPhase929Attribution(
    archiveRoot: string,
    catalog: ArchiveCatalogBuilder,
    inputs: { path: string; sha256: string }[],
  ): { readonly report: RawAttributionReport; readonly reportPath: string } {
    const candidateRoots = catalog.selectedCohortDirectories("phase9.29");
    const reports = candidateRoots.flatMap((root) =>
      readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => path.join(root, name))
        .filter((reportPath) => isAttributionReport(readJson(reportPath))),
    );
    if (reports.length !== 1) {
      throw new Error(
        `Dashboard export requires exactly one canonical Phase 9.29 attribution report; found ${reports.length}. Use --include-cohort=phase9.29/<combined-report-directory>.`,
      );
    }
    const reportPath = reports[0] as string;
    const report = parseAttributionReport(
      readJson(reportPath),
      archiveRelative(archiveRoot, reportPath),
    );
    const relativePath = archiveRelative(archiveRoot, reportPath);
    inputs.push({ path: relativePath, sha256: sha256(readFileSync(reportPath)) });
    return { report, reportPath: relativePath };
  }

  private toCohort(report: RawAttributionReport, reportPath: string): DashboardCohort {
    const id = "cohort:phase9.29:F65E_ATTRIBUTION@v1";
    const archiveByLabel = new Map(
      report.archives.map((archive) => [archive.label, archive.inputPath]),
    );
    const memberRunIds = report.runs
      .map((run) => archiveByLabel.get(run.label))
      .filter((value): value is string => Boolean(value))
      .map(toArchiveRelativeFromReportPath)
      .map(runId)
      .sort();
    return dashboardCohortSchema.parse({
      id,
      phase: "phase9.29",
      label: "F65E@v1 Phase 9.29 attribution",
      reportKind: "FAST_ENTRY_ATTRIBUTION_REPORT",
      memberRunIds,
      candidateCount: report.aggregate.selectedCount,
      exactCoverageCount: report.aggregate.exactCoverageCount,
      labelCounts: completeLabelCounts(report.aggregate.labelCounts),
      conclusion: report.recommendation,
      conclusionReason: report.recommendationReason,
      concentration: {
        selectedRunSharesPct: report.aggregate.selectedRunSharesPct,
        targetRunSharesPct: report.aggregate.targetRunSharesPct,
        nonTargetRunSharesPct: report.aggregate.nonTargetRunSharesPct,
      },
      gates: report.gates,
      sourceReport: reportPath,
    });
  }

  private toCandidates(report: RawAttributionReport, reportPath: string): DashboardCandidate[] {
    const cohortId = "cohort:phase9.29:F65E_ATTRIBUTION@v1";
    const archiveByLabel = new Map(
      report.archives.map((archive) => [archive.label, archive.inputPath]),
    );
    return report.candidates.map((candidate) => {
      const archivePath = archiveByLabel.get(candidate.runLabel);
      if (!archivePath) {
        throw new Error(
          `Phase 9.29 candidate references unknown run label: ${candidate.runLabel}.`,
        );
      }
      const decisionFeatures = candidate.features.map((feature) => ({
        family: feature.family,
        key: feature.key,
        ...(feature.value === undefined
          ? {}
          : { value: Array.isArray(feature.value) ? [...feature.value] : feature.value }),
        availability: feature.source.availability,
        sourceKind: feature.source.kind,
        sourcePath: feature.source.path,
        ...(feature.source.timestampMs === undefined
          ? {}
          : { sourceTimestampMs: feature.source.timestampMs }),
        ...(feature.source.unavailableReason === undefined
          ? {}
          : { unavailableReason: feature.source.unavailableReason }),
      }));
      const runIdValue = runId(toArchiveRelativeFromReportPath(archivePath));
      return dashboardCandidateSchema.parse({
        id: `${runIdValue}:${candidate.decisionId}`,
        runId: runIdValue,
        cohortId,
        mintAddress: candidate.mintAddress,
        ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
        decisionId: candidate.decisionId,
        decidedAt: new Date(candidate.decidedAtMs).toISOString(),
        classification: candidate.classification,
        classificationReason: candidate.classificationReason,
        decisionFeatures,
        outcomeLabel: {
          label: candidate.primaryLabel,
          exactCoverage: candidate.exactCoverage,
          sourceReport: reportPath,
          description: "Later observation; not an entry input.",
        },
      });
    });
  }
}

export function formatDashboardExportSummary(result: DashboardExportResult): string {
  const { bundle } = result;
  return [
    "NeXusTrade Local Research Dashboard Export",
    `  fingerprint: ${bundle.manifest.contentFingerprint}`,
    `  phases: ${bundle.manifest.requestedPhaseIncludes.join(", ")}`,
    `  runs/cohorts/candidates: ${bundle.runs.length}/${bundle.cohorts.length}/${bundle.candidates.length}`,
    "  safety: provider calls=0 database writes=0 sessions=0 orders/fills/positions=0/0/0",
    `  output: ${result.writtenFiles.length} local generated files`,
  ].join("\n");
}

function parseRunnerSummary(value: unknown, sourcePath: string): RawRunnerSummary {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    value.mode !== "PAPER" ||
    value.shadowOnly !== true ||
    typeof value.safetyStatus !== "string" ||
    typeof value.startedAtMs !== "number" ||
    typeof value.endedAtMs !== "number" ||
    typeof value.cycleCount !== "number" ||
    !isRecord(value.providerPressure)
  ) {
    throw new Error(`Unsupported TerminalRunner summary: ${sourcePath}.`);
  }
  return {
    runId: value.runId,
    mode: value.mode,
    shadowOnly: value.shadowOnly,
    safetyStatus: value.safetyStatus,
    startedAtMs: value.startedAtMs,
    endedAtMs: value.endedAtMs,
    cycleCount: value.cycleCount,
    providerPressure: value.providerPressure as RawRunnerSummary["providerPressure"],
  };
}

function isAttributionReport(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.profile) &&
    value.profile.analysisKey === "F65E_ATTRIBUTION@v1"
  );
}

function parseAttributionReport(value: unknown, sourcePath: string): RawAttributionReport {
  if (
    !isRecord(value) ||
    !isAttributionReport(value) ||
    !Array.isArray(value.archives) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error(`Unsupported fast-entry attribution report: ${sourcePath}.`);
  }
  const candidateCount =
    isRecord(value.aggregate) && typeof value.aggregate.selectedCount === "number";
  if (!candidateCount || !Array.isArray(value.candidates) || !Array.isArray(value.gates)) {
    throw new Error(`Incomplete fast-entry attribution report: ${sourcePath}.`);
  }
  return value as unknown as RawAttributionReport;
}

function normalizeProviderPressure(
  providers: readonly Record<string, unknown>[] | undefined,
  sourceReport: string,
): DashboardProviderPressure[] {
  return (providers ?? [])
    .map((provider) => {
      const quoteDemandActions = recordValue(provider.quoteDemandActionCounts);
      const jupiterDemandActions = recordValue(provider.jupiterDemandActionCounts);
      const venueGuardDecisions = recordValue(provider.raydiumVenueGuardDecisionCounts);
      const quoteBudgetDeferrals = optionalCount(quoteDemandActions, "QUOTE_BUDGET_NOT_SELECTED");
      const controllerDeferrals =
        optionalCount(quoteDemandActions, "JUPITER_DEMAND_DEFERRED") ??
        optionalCount(jupiterDemandActions, "DEFERRED_MIN_INTERVAL");
      const venueGuardSkips = optionalCount(quoteDemandActions, "VENUE_GUARD_SKIP");
      const venueGuardAllows = optionalCount(venueGuardDecisions, "ALLOW");
      return {
        provider: stringValue(provider.provider),
        stage: "RUN_TOTAL",
        total: numberValue(provider.total),
        liveUpstreamRows: numberValue(provider.liveRows),
        routerRows: numberValue(provider.routerRows),
        upstreamRateLimited: numberValue(provider.liveRateLimitedCount),
        upstreamErrors: numberValue(provider.liveErrorCount),
        cacheHits: numberValue(provider.routerCacheHits),
        cooldownSkips: numberValue(provider.routerCooldownSkips),
        unavailable: numberValue(provider.routerUnavailable),
        localDeferrals: quoteBudgetDeferrals ?? 0,
        ...(quoteBudgetDeferrals === undefined ? {} : { quoteBudgetDeferrals }),
        ...(controllerDeferrals === undefined ? {} : { controllerDeferrals }),
        ...(venueGuardSkips === undefined ? {} : { venueGuardSkips }),
        ...(venueGuardAllows === undefined ? {} : { venueGuardAllows }),
        sourceReport,
      };
    })
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function completeLabelCounts(value: Record<OutcomeLabel, number>): Record<OutcomeLabel, number> {
  return Object.fromEntries(
    outcomeLabels.map((label) => [label, numberValue(value[label])]),
  ) as Record<OutcomeLabel, number>;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function archiveRelative(archiveRoot: string, candidate: string): string {
  const relative = path.relative(archiveRoot, candidate).replace(/\\/g, "/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("Dashboard export encountered a path outside data/archive.");
  }
  return relative;
}

function toArchiveRelativeFromReportPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const marker = "data/archive/";
  const index = normalized.toLowerCase().indexOf(marker);
  if (index < 0) throw new Error(`Attribution report source is not under data/archive: ${value}.`);
  return normalized.slice(index + marker.length);
}

function runId(archivePath: string): string {
  return `run:${archivePath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function serialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "UNKNOWN";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalCount(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (!value || !(key in value)) return undefined;
  return numberValue(value[key]);
}

function compareByPath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path.localeCompare(right.path);
}

function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

export function assertNoCredentialLikeValue(value: unknown, location = "export"): void {
  if (typeof value === "string") {
    if (/\b(?:api[ _-]?key|authorization|bearer|private[ _-]?key|secret|password)\b/i.test(value)) {
      throw new Error(`Dashboard export rejected credential-like content at ${location}.`);
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
