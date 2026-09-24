import { defaultShadowEntryConfig } from "../shadow-entry/ShadowEntryConfig.js";
import { loadShadowEntryRuns } from "../shadow-entry/ShadowEntryCandidateLoader.js";
import type { ShadowEntryCandidate } from "../shadow-entry/ShadowEntryTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { loadResearchRunArchives } from "../research/ResearchRunArchiveLoader.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import { buildTargetStopOutcomes } from "../research-interpretation/ResearchInterpretationStats.js";
import type {
  ResearchInterpretationCandidate,
  ResearchInterpretationDedupeMode,
} from "../research-interpretation/ResearchInterpretationTypes.js";
import { ArchiveDatabaseTruthService } from "./ArchiveDatabaseTruthService.js";
import { BirdeyeTruthService } from "./BirdeyeTruthService.js";
import { BlockerAuditService } from "./BlockerAuditService.js";
import { ConcentrationTruthService } from "./ConcentrationTruthService.js";
import { ProviderReclassificationService } from "./ProviderReclassificationService.js";
import { QuoteEvidenceTruthService } from "./QuoteEvidenceTruthService.js";
import { ReportLimitTruthService } from "./ReportLimitTruthService.js";
import { ScenarioPortfolioAuditService } from "./ScenarioPortfolioAuditService.js";
import type {
  ResearchTruthingArchiveReference,
  ResearchTruthingDecisionRow,
  ResearchTruthingReport,
  ResearchTruthingRuntimeConfig,
  ResearchTruthingStrategyThresholds,
} from "./ResearchTruthingTypes.js";
import { STRATEGY_DEFAULTS } from "../strategy/StrategyConfig.js";

export class ResearchTruthingRunner {
  constructor(
    private readonly options: {
      readonly config: ResearchTruthingRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): ResearchTruthingReport {
    const clock = this.options.clock ?? Date.now;
    const archives = loadResearchRunArchives(this.options.config.runSources);
    const dbSources = archives.map((archive) => ({
      label: archive.label,
      path: archive.resolvedPath,
    }));
    const loadedRuns = loadShadowEntryRuns({
      ...defaultShadowEntryConfig(),
      once: true,
      json: this.options.config.json,
      targetPcts: this.options.config.targetPcts,
      stopPcts: this.options.config.stopPcts,
      maxHoldMinutes: this.options.config.maxHoldMinutes,
      minScore: this.options.config.minScore,
      sourceDecisions: this.options.config.sourceDecisions,
      dbSources,
    });

    try {
      const allCandidates = normalizeCandidates(loadedRuns.candidates, this.options.config);
      const candidates = applyDedupeMode(
        allCandidates,
        this.options.config.dedupeMode as ResearchInterpretationDedupeMode,
        this.options.config,
      );
      const archiveCounts = new ArchiveDatabaseTruthService().summarize(archives);
      const quoteEvidence = new QuoteEvidenceTruthService().summarize({
        archives,
        candidates,
        limit: this.options.config.topLimit,
      });
      const birdeyeAttribution = new BirdeyeTruthService().summarize({
        runs: loadedRuns.runs,
        candidates,
      });
      const concentration = new ConcentrationTruthService().summarize({
        candidates,
        limit: this.options.config.topLimit,
      });
      const blockerAudit = new BlockerAuditService().summarize({
        candidates,
        limit: this.options.config.topLimit,
        thresholdsByRun: resolveThresholdsByRun(loadedRuns.runs),
      });
      const scenarioPortfolioAudit = new ScenarioPortfolioAuditService().summarize({
        candidates,
        config: this.options.config,
      });
      const providerReclassification = new ProviderReclassificationService().summarize(
        loadedRuns.runs,
      );
      const decisionRows = buildDecisionRows(candidates, loadedRuns.runs);
      const reportLimitAudit = buildLimitAudit({
        rows: decisionRows,
        quoteEvidenceRowCount:
          quoteEvidence.missingQuoteCount + quoteEvidence.quotePresentButImpactMissingCount,
        concentration,
        blockerExampleCount: blockerAudit.skipWithNoBlockers,
        config: this.options.config,
      });
      const safetyPassed =
        archiveCounts.every((archive) => archive.oneSession) &&
        archiveCounts.every((archive) => (archive.tableCounts.orders ?? 0) === 0) &&
        archiveCounts.every((archive) => (archive.tableCounts.fills ?? 0) === 0) &&
        archiveCounts.every((archive) => (archive.tableCounts.positions ?? 0) === 0);

      return {
        generatedAtMs: clock(),
        config: {
          runLabels: archives.map((archive) => archive.label),
          dedupeMode: this.options.config.dedupeMode,
          sourceDecisions: this.options.config.sourceDecisions,
          minScore: this.options.config.minScore,
          targetPcts: this.options.config.targetPcts,
          stopPcts: this.options.config.stopPcts,
          maxHoldMinutes: this.options.config.maxHoldMinutes,
          topLimit: this.options.config.topLimit,
          marketWindowMinutes: this.options.config.marketWindowMinutes,
        },
        safety: {
          mode: "PAPER research",
          databaseAccess: "read-only archived runs",
          liveProviderCalls: false,
          paperBuyAutomation: false,
          walletLoaded: false,
          transactionSigning: false,
          transactionSubmission: false,
          passed: safetyPassed,
        },
        archives: archives.map((archive) => toArchiveReference(archive, this.options.config)),
        archiveCounts,
        reportLimitAudit,
        decisionTruthTable: {
          rowsAvailable: allCandidates.length,
          rowsEvaluated: candidates.length,
          rowsDisplayed: Math.min(decisionRows.length, this.options.config.topLimit),
          displayLimit: this.options.config.topLimit,
          displayTruncated: decisionRows.length > this.options.config.topLimit,
          omittedDisplayRows: Math.max(0, decisionRows.length - this.options.config.topLimit),
          consideredDefinition:
            "unique StrategyDecision evaluated after the selected dedupe mode and filters",
          dedupeMode: this.options.config.dedupeMode,
          rows: decisionRows.slice(0, this.options.config.topLimit),
        },
        quoteEvidence,
        birdeyeAttribution,
        providerReclassification,
        concentration,
        blockerAudit,
        scenarioPortfolioAudit,
        findings: buildFindings({
          safetyPassed,
          quoteEvidence,
          birdeyeBudgetSkipCount: birdeyeAttribution.budgetSkipCount,
          concentrationNotes: concentration.notes,
        }),
        recommendations: buildRecommendations({
          unclassifiedMissingQuoteCount: quoteEvidence.unclassifiedMissingQuoteCount,
          safetyPassed,
        }),
      };
    } finally {
      loadedRuns.close();
    }
  }
}

function normalizeCandidates(
  candidates: readonly ShadowEntryCandidate[],
  config: ResearchTruthingRuntimeConfig,
): readonly ResearchInterpretationCandidate[] {
  return candidates.map((candidate) => {
    const attribution = candidate.attribution;
    const scoreFactors = attribution.factors.map((factor) => ({
      ruleName: factor.ruleName,
      points: factor.points,
      passed: factor.passed,
      ...(factor.reason ? { reason: factor.reason } : {}),
      warnings: factor.warnings,
    }));

    return {
      runLabel: candidate.runLabel,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      decisionId: candidate.decisionId,
      mintAddress: candidate.mintAddress,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      decidedAtMs: candidate.decidedAtMs,
      decision: candidate.decision,
      score: candidate.score,
      ...(attribution.rawDecision ? { rawDecision: attribution.rawDecision } : {}),
      buyEligible: attribution.buyEligible,
      duplicateBuyBlocked: attribution.duplicateBuyBlocked,
      maxBuyCapBlocked: attribution.maxBuyCapBlocked,
      ...(attribution.riskResult ? { riskResult: attribution.riskResult } : {}),
      riskFlags: attribution.riskFlags,
      missingQuote: attribution.missingQuote,
      missingAuthorityEvidence: attribution.missingAuthorityEvidence,
      missingPriceImpact: attribution.missingPriceImpact,
      ...(attribution.liquidityUsd !== undefined ? { liquidityUsd: attribution.liquidityUsd } : {}),
      ...(attribution.volume5mUsd !== undefined ? { volume5mUsd: attribution.volume5mUsd } : {}),
      ...(attribution.volume1hUsd !== undefined ? { volume1hUsd: attribution.volume1hUsd } : {}),
      ...(attribution.ageSeconds !== undefined ? { ageSeconds: attribution.ageSeconds } : {}),
      ...(attribution.maxPriceImpactPct !== undefined
        ? { maxPriceImpactPct: attribution.maxPriceImpactPct }
        : {}),
      scoreFactors,
      blockingFactors: attribution.blockingFactors,
      observedPoints: candidate.observedPoints,
      ...(candidate.bestReturnPct !== undefined ? { bestReturnPct: candidate.bestReturnPct } : {}),
      ...(candidate.worstReturnPct !== undefined
        ? { worstReturnPct: candidate.worstReturnPct }
        : {}),
      targetStopOutcomes: buildTargetStopOutcomes({
        observedPoints: candidate.observedPoints,
        targetPcts: config.targetPcts,
        stopPcts: config.stopPcts,
        maxHoldMinutes: config.maxHoldMinutes,
      }),
      repeatedAttentionStrength: candidate.repeatedAttentionStrength,
      repeatedAttentionReasons: candidate.repeatedAttentionReasons,
      repeatedAttentionSourceCount: candidate.repeatedAttentionSourceCount,
      ...(candidate.firstAttentionAtMs !== undefined
        ? { firstAttentionAtMs: candidate.firstAttentionAtMs }
        : {}),
      ...(candidate.lastAttentionAtMs !== undefined
        ? { lastAttentionAtMs: candidate.lastAttentionAtMs }
        : {}),
      ...(candidate.timeBetweenAttentionSignalsMinutes !== undefined
        ? { timeBetweenAttentionSignalsMinutes: candidate.timeBetweenAttentionSignalsMinutes }
        : {}),
      attribution,
    };
  });
}

function toArchiveReference(
  archive: ResearchArchiveMetadata,
  config: Pick<ResearchTruthingRuntimeConfig, "includeRunnerCycles">,
): ResearchTruthingArchiveReference {
  const terminalSummary = config.includeRunnerCycles
    ? archive.terminalSummary
    : withoutRunnerCycles(archive.terminalSummary);

  return {
    label: archive.label,
    inputPath: archive.inputPath,
    resolvedPath: archive.resolvedPath,
    databasePath: archive.databasePath,
    runnerJsonPath: archive.runnerJsonPath,
    ...(archive.runnerTextPath ? { runnerTextPath: archive.runnerTextPath } : {}),
    ...(archive.analyticsReportPath ? { analyticsReportPath: archive.analyticsReportPath } : {}),
    ...(archive.calibrationReportPath
      ? { calibrationReportPath: archive.calibrationReportPath }
      : {}),
    ...(archive.shadowCalibrationReportPath
      ? { shadowCalibrationReportPath: archive.shadowCalibrationReportPath }
      : {}),
    terminalSummary,
    runnerCyclesIncluded: config.includeRunnerCycles,
    warnings: archive.warnings,
  };
}

function withoutRunnerCycles(
  terminalSummary: ResearchArchiveMetadata["terminalSummary"],
): Omit<ResearchArchiveMetadata["terminalSummary"], "cycles"> {
  return Object.fromEntries(
    Object.entries(terminalSummary).filter(([key]) => key !== "cycles"),
  ) as Omit<ResearchArchiveMetadata["terminalSummary"], "cycles">;
}

function resolveThresholdsByRun(
  runs: readonly ShadowCalibrationRawRun[],
): ReadonlyMap<string, ResearchTruthingStrategyThresholds> {
  return new Map(runs.map((run) => [run.label, resolveRunThresholds(run)]));
}

function resolveRunThresholds(run: ShadowCalibrationRawRun): ResearchTruthingStrategyThresholds {
  const fallback: ResearchTruthingStrategyThresholds = {
    watchScoreThreshold: STRATEGY_DEFAULTS.watchScoreThreshold,
    buyScoreThreshold: STRATEGY_DEFAULTS.buyScoreThreshold,
    source: "CURRENT_DEFAULT",
  };
  const configSnapshotJson = run.session?.configSnapshotJson;

  if (!configSnapshotJson) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(configSnapshotJson) as unknown;
    const candidates = isRecord(parsed)
      ? [parsed, parsed.strategy, parsed.strategyConfig].filter(isRecord)
      : [];

    for (const candidate of candidates) {
      const watchScoreThreshold = finiteNumber(candidate.watchScoreThreshold);
      const buyScoreThreshold = finiteNumber(candidate.buyScoreThreshold);

      if (
        watchScoreThreshold !== undefined &&
        buyScoreThreshold !== undefined &&
        watchScoreThreshold >= 0 &&
        buyScoreThreshold >= watchScoreThreshold &&
        buyScoreThreshold <= 100
      ) {
        return {
          watchScoreThreshold,
          buyScoreThreshold,
          source: "ARCHIVED_SESSION",
        };
      }
    }
  } catch {
    // The archived session remains usable; current strategy defaults are the safe fallback.
  }

  return fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyDedupeMode(
  candidates: readonly ResearchInterpretationCandidate[],
  mode: ResearchInterpretationDedupeMode,
  config: Pick<ResearchTruthingRuntimeConfig, "targetPcts" | "stopPcts" | "maxHoldMinutes">,
): readonly ResearchInterpretationCandidate[] {
  if (mode === "decision") {
    return [...candidates].sort((left, right) => left.decidedAtMs - right.decidedAtMs);
  }

  const byMint = groupBy(candidates, (candidate) => candidate.mintAddress);

  return [...byMint.values()]
    .map((rows) => {
      if (mode === "first_per_mint") {
        return [...rows].sort((left, right) => left.decidedAtMs - right.decidedAtMs)[0];
      }

      if (mode === "best_per_mint") {
        return [...rows].sort(compareByBestReturn)[0];
      }

      return aggregateMintCandidate(rows, config);
    })
    .filter((candidate): candidate is ResearchInterpretationCandidate => candidate !== undefined)
    .sort((left, right) => left.decidedAtMs - right.decidedAtMs);
}

function aggregateMintCandidate(
  rows: readonly ResearchInterpretationCandidate[],
  config: Pick<ResearchTruthingRuntimeConfig, "targetPcts" | "stopPcts" | "maxHoldMinutes">,
): ResearchInterpretationCandidate | undefined {
  const first = [...rows].sort((left, right) => left.decidedAtMs - right.decidedAtMs)[0];

  if (!first) {
    return undefined;
  }

  const observedPoints = rows
    .flatMap((row) => row.observedPoints)
    .sort((left, right) => left.horizonMinutes - right.horizonMinutes);
  const bestReturnPct = maxOptional(rows.map((row) => row.bestReturnPct));
  const worstReturnPct = minOptional(rows.map((row) => row.worstReturnPct));

  return {
    ...first,
    observedPoints,
    ...(bestReturnPct !== undefined ? { bestReturnPct } : {}),
    ...(worstReturnPct !== undefined ? { worstReturnPct } : {}),
    targetStopOutcomes: buildTargetStopOutcomes({
      observedPoints,
      targetPcts: config.targetPcts,
      stopPcts: config.stopPcts,
      maxHoldMinutes: config.maxHoldMinutes,
    }),
    repeatedAttentionSourceCount: Math.max(...rows.map((row) => row.repeatedAttentionSourceCount)),
    attribution: first.attribution,
  };
}

function buildDecisionRows(
  candidates: readonly ResearchInterpretationCandidate[],
  runs: readonly ShadowCalibrationRawRun[],
): readonly ResearchTruthingDecisionRow[] {
  const radarStatusByRunMint = new Map<string, string>();

  for (const run of runs) {
    for (const radar of run.tokenRadar) {
      radarStatusByRunMint.set(`${run.label}:${radar.mintAddress}`, radar.status);
    }
  }

  return candidates
    .map((candidate) => {
      const tokenRadarStatus = radarStatusByRunMint.get(
        `${candidate.runLabel}:${candidate.mintAddress}`,
      );

      return {
        runLabel: candidate.runLabel,
        ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
        decisionId: candidate.decisionId,
        mintAddress: candidate.mintAddress,
        ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
        decision: candidate.decision,
        score: candidate.score,
        decidedAtMs: candidate.decidedAtMs,
        ...(candidate.riskResult ? { riskResult: candidate.riskResult } : {}),
        ...(tokenRadarStatus ? { tokenRadarStatus } : {}),
        ...(candidate.liquidityUsd !== undefined ? { liquidityUsd: candidate.liquidityUsd } : {}),
        ...(candidate.volume5mUsd !== undefined ? { volume5mUsd: candidate.volume5mUsd } : {}),
        ...(candidate.volume1hUsd !== undefined ? { volume1hUsd: candidate.volume1hUsd } : {}),
        ...(candidate.ageSeconds !== undefined ? { ageSeconds: candidate.ageSeconds } : {}),
        observedReturnCoverage: candidate.observedPoints.length,
        ...(candidate.bestReturnPct !== undefined
          ? { bestReturnPct: candidate.bestReturnPct }
          : {}),
        ...(candidate.worstReturnPct !== undefined
          ? { worstReturnPct: candidate.worstReturnPct }
          : {}),
        missingQuote: candidate.missingQuote,
        missingPriceImpact: candidate.missingPriceImpact,
        missingAuthorityEvidence: candidate.missingAuthorityEvidence,
        repeatedAttentionStrength: candidate.repeatedAttentionStrength,
        blockingFactors: candidate.blockingFactors,
      };
    })
    .sort((left, right) => left.decidedAtMs - right.decidedAtMs);
}

function buildLimitAudit(input: {
  readonly rows: readonly ResearchTruthingDecisionRow[];
  readonly quoteEvidenceRowCount: number;
  readonly concentration: ReturnType<ConcentrationTruthService["summarize"]>;
  readonly blockerExampleCount: number;
  readonly config: ResearchTruthingRuntimeConfig;
}): readonly ReturnType<ReportLimitTruthService["create"]>[] {
  const service = new ReportLimitTruthService();

  return [
    service.create({
      sectionName: "decisionTruthTable.rows",
      rowsAvailable: input.rows.length,
      rowsEvaluated: input.rows.length,
      rowsDisplayed: Math.min(input.rows.length, input.config.topLimit),
      displayLimit: input.config.topLimit,
      dedupeMode: input.config.dedupeMode,
    }),
    service.create({
      sectionName: "quoteEvidence.exampleRows",
      rowsAvailable: input.quoteEvidenceRowCount,
      rowsEvaluated: input.quoteEvidenceRowCount,
      rowsDisplayed: Math.min(input.quoteEvidenceRowCount, input.config.topLimit),
      displayLimit: input.config.topLimit,
      dedupeMode: input.config.dedupeMode,
    }),
    service.create({
      sectionName: "concentration.byMint",
      rowsAvailable: input.concentration.totalMintGroups,
      rowsEvaluated: input.concentration.totalMintGroups,
      rowsDisplayed: Math.min(input.concentration.totalMintGroups, input.config.topLimit),
      displayLimit: input.config.topLimit,
      dedupeMode: input.config.dedupeMode,
    }),
    service.create({
      sectionName: "blockerAudit.examples",
      rowsAvailable: input.blockerExampleCount,
      rowsEvaluated: input.blockerExampleCount,
      rowsDisplayed: Math.min(input.blockerExampleCount, input.config.topLimit),
      displayLimit: input.config.topLimit,
      dedupeMode: input.config.dedupeMode,
    }),
  ];
}

function buildFindings(input: {
  readonly safetyPassed: boolean;
  readonly quoteEvidence: ReturnType<QuoteEvidenceTruthService["summarize"]>;
  readonly birdeyeBudgetSkipCount: number;
  readonly concentrationNotes: readonly string[];
}): readonly string[] {
  const findings: string[] = [];

  findings.push(`Safety boundary ${input.safetyPassed ? "passed" : "failed"}.`);
  findings.push(
    `Missing quote rows=${input.quoteEvidence.missingQuoteCount}; unclassified=${input.quoteEvidence.unclassifiedMissingQuoteCount}.`,
  );

  if (input.birdeyeBudgetSkipCount > 0) {
    findings.push(
      `Birdeye budget skips=${input.birdeyeBudgetSkipCount}; classify these as policy skips, not provider outages.`,
    );
  }

  findings.push(...input.concentrationNotes);

  return findings;
}

function buildRecommendations(input: {
  readonly unclassifiedMissingQuoteCount: number;
  readonly safetyPassed: boolean;
}): ResearchTruthingReport["recommendations"] {
  const selectedCode: "A" | "B" | "C" | "D" | "E" = input.safetyPassed ? "A" : "D";

  return [
    recommendation(
      "A",
      "Proceed to Phase 9.4A.2 adapter correctness and diagnostics",
      selectedCode,
      {
        evidenceFor: [
          `unclassifiedMissingQuote=${input.unclassifiedMissingQuoteCount}.`,
          "Raydium preflight/error parsing and quote-attempt telemetry remain adapter-level work.",
        ],
        evidenceAgainst: ["Phase 9.4A.2 should wait if archive safety checks fail."],
        requiredNextAction:
          "Implement read-only quote diagnostics, Raydium preflight correction, and latest-attempt/last-success evidence.",
      },
    ),
    recommendation("B", "Proceed to Phase 9.4B quote-pressure reduction", selectedCode, {
      evidenceFor: ["Provider pressure remains material after Phase 9.4 validation."],
      evidenceAgainst: [
        "Runtime pressure changes should wait until adapter diagnostics are trustworthy.",
      ],
      requiredNextAction:
        "Add Jupiter scheduler, request coalescing, and duplicate-demand reduction after 9.4A.2.",
    }),
    recommendation("C", "Proceed to Phase 9.5 access-gated quote-provider research", selectedCode, {
      evidenceFor: ["Additional quote providers may eventually improve resilience."],
      evidenceAgainst: [
        "Another provider could hide internal demand and attribution issues if added too early.",
      ],
      requiredNextAction:
        "Keep Autobahn/Titan research parked until current quote evidence is clean.",
    }),
    recommendation("D", "Collect another validation batch", selectedCode, {
      evidenceFor: ["Useful only if safety or archive coverage is insufficient."],
      evidenceAgainst: ["An unchanged batch will not fix attribution gaps."],
      requiredNextAction: "Collect more data only after truthing/diagnostic gaps are closed.",
    }),
    recommendation("E", "Revisit strategy interpretation or profile promotion", selectedCode, {
      evidenceFor: ["Only appropriate after evidence and concentration caveats are resolved."],
      evidenceAgainst: ["Phase 9.4A.1 does not change strategy quality or promotion gates."],
      requiredNextAction: "Do not change strategy defaults from this truthing command.",
    }),
  ];
}

function recommendation(
  code: "A" | "B" | "C" | "D" | "E",
  label: string,
  selectedCode: "A" | "B" | "C" | "D" | "E",
  input: {
    readonly evidenceFor: readonly string[];
    readonly evidenceAgainst: readonly string[];
    readonly requiredNextAction: string;
  },
): ResearchTruthingReport["recommendations"][number] {
  return {
    recommendationCode: code,
    label,
    selected: code === selectedCode,
    evidenceFor: input.evidenceFor,
    evidenceAgainst: input.evidenceAgainst,
    requiredNextAction: input.requiredNextAction,
    safetyCaveat: "Paper BUY automation remains disabled.",
  };
}

function compareByBestReturn(
  left: ResearchInterpretationCandidate,
  right: ResearchInterpretationCandidate,
): number {
  return (
    (right.bestReturnPct ?? Number.NEGATIVE_INFINITY) -
      (left.bestReturnPct ?? Number.NEGATIVE_INFINITY) ||
    (right.score ?? -1) - (left.score ?? -1) ||
    left.decidedAtMs - right.decidedAtMs
  );
}

function groupBy<T>(items: readonly T[], getKey: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = getKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return groups;
}

function maxOptional(values: readonly (number | undefined)[]): number | undefined {
  const numericValues = values.filter((value): value is number => value !== undefined);

  return numericValues.length > 0 ? Math.max(...numericValues) : undefined;
}

function minOptional(values: readonly (number | undefined)[]): number | undefined {
  const numericValues = values.filter((value): value is number => value !== undefined);

  return numericValues.length > 0 ? Math.min(...numericValues) : undefined;
}
