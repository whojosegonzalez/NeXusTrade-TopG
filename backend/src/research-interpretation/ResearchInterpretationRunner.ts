import { defaultShadowEntryConfig } from "../shadow-entry/ShadowEntryConfig.js";
import { loadShadowEntryRuns } from "../shadow-entry/ShadowEntryCandidateLoader.js";
import type { ShadowEntryCandidate } from "../shadow-entry/ShadowEntryTypes.js";
import { loadResearchRunArchives } from "../research/ResearchRunArchiveLoader.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { BlockerAnalysisService } from "./BlockerAnalysisService.js";
import { DecisionAttributionService } from "./DecisionAttributionService.js";
import { MarketWindowAnalysisService } from "./MarketWindowAnalysisService.js";
import { OpportunityAnalysisService } from "./OpportunityAnalysisService.js";
import { ProviderInterpretationService } from "./ProviderInterpretationService.js";
import { buildTargetStopOutcomes, summarizeCandidateGroup } from "./ResearchInterpretationStats.js";
import type {
  ResearchDecisionAttribution,
  ResearchInterpretationCandidate,
  ResearchInterpretationDedupeMode,
  ResearchInterpretationReport,
  ResearchInterpretationRunValidation,
  ResearchInterpretationRuntimeConfig,
  ResearchRecommendationMatrixRow,
} from "./ResearchInterpretationTypes.js";

export class ResearchInterpretationRunner {
  constructor(
    private readonly options: {
      readonly config: ResearchInterpretationRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): ResearchInterpretationReport {
    const clock = this.options.clock ?? Date.now;
    const archives = loadResearchRunArchives(this.options.config.runSources);
    const dbSources = archives.map((archive) => ({
      label: archive.label,
      path: archive.resolvedPath,
    }));
    const shadowEntryConfig = {
      ...defaultShadowEntryConfig(),
      once: true,
      json: this.options.config.json,
      targetPcts: this.options.config.targetPcts,
      stopPcts: this.options.config.stopPcts,
      maxHoldMinutes: this.options.config.maxHoldMinutes,
      minScore: this.options.config.minScore,
      sourceDecisions: this.options.config.sourceDecisions,
      dbSources,
    };
    const loadedRuns = loadShadowEntryRuns(shadowEntryConfig);

    try {
      const allCandidates = normalizeCandidates(loadedRuns.candidates, this.options.config);
      const candidates = applyDedupeMode(allCandidates, this.options.config.dedupeMode);
      const attributionService = new DecisionAttributionService();
      const attributions = candidates.map((candidate) =>
        attributionService.explain({
          candidate,
          buyScoreThreshold: 65,
          watchScoreThreshold: 60,
        }),
      );
      const runValidations = buildRunValidations(archives, loadedRuns.runs);
      const blockerSummaries = new BlockerAnalysisService().summarize({
        candidates,
        attributions,
        targetPcts: this.options.config.targetPcts,
        stopPcts: this.options.config.stopPcts,
        limit: this.options.config.topBlockers,
      });
      const opportunityService = new OpportunityAnalysisService();
      const highScoringSkips = opportunityService.highScoringSkips({
        candidates,
        attributions,
        minScore: 65,
        limit: this.options.config.topOpportunities,
      });
      const tokenSummaries = opportunityService.tokenSummaries({
        candidates,
        attributions,
        limit: this.options.config.topOpportunities,
      });
      const missingQuoteAnalysis = new ProviderInterpretationService().summarize({
        archives,
        candidates,
        targetPcts: this.options.config.targetPcts,
        stopPcts: this.options.config.stopPcts,
      });
      const warnOutcomeSummaries = buildWarnOutcomeSummaries({
        candidates,
        targetPcts: this.options.config.targetPcts,
        stopPcts: this.options.config.stopPcts,
      });
      const marketWindows = new MarketWindowAnalysisService().summarize({
        candidates,
        marketWindowMinutes: this.options.config.marketWindowMinutes,
        limit: 10,
      });
      const aggregate = {
        runCount: archives.length,
        observedDecisionCount: candidates.filter((candidate) => candidate.observedPoints.length > 0)
          .length,
        uniqueMintCount: new Set(candidates.map((candidate) => candidate.mintAddress)).size,
        orderCount: loadedRuns.runs.reduce((total, run) => total + run.orderCount, 0),
        fillCount: loadedRuns.runs.reduce((total, run) => total + run.fillCount, 0),
        positionCount: loadedRuns.runs.reduce((total, run) => total + run.positionCount, 0),
        dedupeMode: this.options.config.dedupeMode,
      };

      return {
        generatedAtMs: clock(),
        config: {
          runLabels: archives.map((archive) => archive.label),
          minScore: this.options.config.minScore,
          sourceDecisions: this.options.config.sourceDecisions,
          targetPcts: this.options.config.targetPcts,
          stopPcts: this.options.config.stopPcts,
          maxHoldMinutes: this.options.config.maxHoldMinutes,
          dedupeMode: this.options.config.dedupeMode,
        },
        archives,
        runValidations,
        aggregate,
        candidates,
        decisionAttributions: attributions,
        blockerSummaries,
        highScoringSkips,
        warnOutcomeSummaries,
        missingQuoteAnalysis,
        marketWindows,
        tokenSummaries,
        recommendationMatrix: buildRecommendationMatrix({
          aggregate,
          candidates,
          attributions,
          highScoringSkips,
          providerInterpretation: missingQuoteAnalysis,
        }),
      };
    } finally {
      loadedRuns.close();
    }
  }
}

function normalizeCandidates(
  candidates: readonly ShadowEntryCandidate[],
  config: ResearchInterpretationRuntimeConfig,
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

function applyDedupeMode(
  candidates: readonly ResearchInterpretationCandidate[],
  mode: ResearchInterpretationDedupeMode,
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

      return aggregateMintCandidate(rows);
    })
    .filter((candidate): candidate is ResearchInterpretationCandidate => candidate !== undefined)
    .sort((left, right) => left.decidedAtMs - right.decidedAtMs);
}

function aggregateMintCandidate(
  rows: readonly ResearchInterpretationCandidate[],
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
    repeatedAttentionSourceCount: Math.max(...rows.map((row) => row.repeatedAttentionSourceCount)),
  };
}

function buildRunValidations(
  archives: readonly ResearchArchiveMetadata[],
  runs: readonly ShadowCalibrationRawRun[],
): readonly ResearchInterpretationRunValidation[] {
  const runsByLabel = new Map(runs.map((run) => [run.label, run] as const));

  return archives.map((archive) => {
    const run = runsByLabel.get(archive.label);
    const terminalSessionId = archive.terminalSummary.sessionId;
    const stageSessionIds = collectStageSessionIds(archive);
    const oneSession =
      terminalSessionId !== undefined &&
      stageSessionIds.length > 0 &&
      stageSessionIds.every((sessionId) => sessionId === terminalSessionId);
    const warnings = [...archive.warnings];

    if (!oneSession) {
      warnings.push("TerminalRunner stages were not all tied to one session.");
    }

    if (!run) {
      warnings.push("Archived database run was not loaded.");
    } else if (terminalSessionId && run.session?.id !== terminalSessionId) {
      warnings.push(
        `Terminal session ${terminalSessionId} does not match DB session ${run.session?.id}.`,
      );
    }

    return {
      label: archive.label,
      runId: archive.terminalSummary.runId,
      databasePath: archive.databasePath,
      safetyStatus: archive.terminalSummary.safetyStatus,
      cycleCount: archive.terminalSummary.cycleCount,
      ...(terminalSessionId ? { terminalSessionId } : {}),
      ...(run?.session?.id ? { databaseSessionId: run.session.id } : {}),
      oneSession,
      orderCount: run?.orderCount ?? 0,
      fillCount: run?.fillCount ?? 0,
      positionCount: run?.positionCount ?? 0,
      warnings,
    };
  });
}

function buildWarnOutcomeSummaries(input: {
  readonly candidates: readonly ResearchInterpretationCandidate[];
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
}): ResearchInterpretationReport["warnOutcomeSummaries"] {
  const warnCandidates = input.candidates.filter((candidate) => candidate.riskResult === "WARN");
  const groups = [
    ["WARN_ALL", warnCandidates] as const,
    ["WARN_MISSING_QUOTE", warnCandidates.filter((candidate) => candidate.missingQuote)] as const,
    [
      "WARN_MISSING_AUTHORITY",
      warnCandidates.filter((candidate) => candidate.missingAuthorityEvidence),
    ] as const,
    [
      "WARN_MISSING_PRICE_IMPACT",
      warnCandidates.filter((candidate) => candidate.missingPriceImpact),
    ] as const,
  ];

  return groups
    .filter(([, candidates]) => candidates.length > 0)
    .map(([label, candidates]) =>
      summarizeCandidateGroup(label, candidates, input.targetPcts, input.stopPcts),
    );
}

function buildRecommendationMatrix(input: {
  readonly aggregate: ResearchInterpretationReport["aggregate"];
  readonly candidates: readonly ResearchInterpretationCandidate[];
  readonly attributions: readonly ResearchDecisionAttribution[];
  readonly highScoringSkips: readonly unknown[];
  readonly providerInterpretation: ResearchInterpretationReport["missingQuoteAnalysis"];
}): readonly ResearchRecommendationMatrixRow[] {
  const unresolvedSkipCount = input.attributions.filter(
    (attribution) => attribution.firstBlockingFactor === "UNRESOLVED_STRATEGY_GATE",
  ).length;
  const missingQuoteShare = input.aggregate.observedDecisionCount
    ? (input.providerInterpretation.missingQuote.observedCount /
        input.aggregate.observedDecisionCount) *
      100
    : 0;
  const jupiter = input.providerInterpretation.providers.find(
    (provider) => provider.provider.toUpperCase() === "JUPITER",
  );
  const providerPressureDominates =
    (jupiter?.liveRateLimitedPercent ?? 0) >= 25 || missingQuoteShare >= 35;
  const tooLittleData =
    input.aggregate.observedDecisionCount < 100 || input.aggregate.uniqueMintCount < 10;
  const selectedCode: ResearchRecommendationMatrixRow["recommendationCode"] = tooLittleData
    ? "D"
    : providerPressureDominates
      ? "B"
      : unresolvedSkipCount > 0 || input.highScoringSkips.length > 0
        ? "A"
        : "C";

  return [
    recommendation("A", "Proceed to Phase 9.26 counterfactual analysis", selectedCode, {
      evidenceFor: [
        `${unresolvedSkipCount} SKIP decisions have unresolved strategy gates.`,
        `${input.highScoringSkips.length} high-scoring SKIPs are available for deeper explanation.`,
      ],
      evidenceAgainst: [
        "Phase 9.25 does not infer alternate BUY/WATCH outcomes.",
        "Provider uncertainty may still explain part of the observed behavior.",
      ],
      requiredNextAction:
        "Build explicit if-this-evidence-existed decision replay after this interpretation report.",
    }),
    recommendation("B", "Proceed to Phase 9.3 Raydium fallback", selectedCode, {
      evidenceFor: [
        `Missing quote observed share=${formatNumber(missingQuoteShare)}%.`,
        `Jupiter live rate limit=${formatNumber(jupiter?.liveRateLimitedPercent ?? 0)}%.`,
      ],
      evidenceAgainst: ["Provider work should wait if blockers are mostly strategy/risk/timing."],
      requiredNextAction:
        "Implement a quote-provider fallback only if quote uncertainty dominates.",
    }),
    recommendation("C", "Tune shadow-entry profiles", selectedCode, {
      evidenceFor: [
        "High-scoring SKIPs and blocker clusters can identify narrower profile changes.",
      ],
      evidenceAgainst: [
        "Production defaults must stay unchanged until a separate promotion review.",
      ],
      requiredNextAction:
        "Create a small profile-tuning phase using the Phase 9.25 blocker evidence.",
    }),
    recommendation("D", "Collect more data", selectedCode, {
      evidenceFor: [
        `Observed decisions=${input.aggregate.observedDecisionCount}.`,
        `Unique mints=${input.aggregate.uniqueMintCount}.`,
      ],
      evidenceAgainst: ["More data is less useful if the same blocker dominates every run."],
      requiredNextAction: "Run more TerminalRunner archives before changing providers or profiles.",
    }),
    recommendation("E", "Prepare separate controlled paper pilot review", selectedCode, {
      evidenceFor: ["Only appropriate after a profile clears promotion gates."],
      evidenceAgainst: [
        "Phase 9.25 is read-only and does not enable paper BUY automation.",
        "Current safety caveat keeps paper execution disabled.",
      ],
      requiredNextAction:
        "Create a separate paper pilot checklist only after promotion criteria pass.",
    }),
  ];
}

function recommendation(
  code: ResearchRecommendationMatrixRow["recommendationCode"],
  label: string,
  selectedCode: ResearchRecommendationMatrixRow["recommendationCode"],
  input: {
    readonly evidenceFor: readonly string[];
    readonly evidenceAgainst: readonly string[];
    readonly requiredNextAction: string;
  },
): ResearchRecommendationMatrixRow {
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

function collectStageSessionIds(archive: ResearchArchiveMetadata): readonly string[] {
  const sessionIds = new Set<string>();

  for (const cycle of archive.terminalSummary.cycles) {
    for (const stage of cycle.stages) {
      const sessionId = stage.counts.sessionId;

      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }

  return [...sessionIds].sort();
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

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
