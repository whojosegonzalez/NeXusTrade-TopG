import { loadResearchRunArchives } from "../research/ResearchRunArchiveLoader.js";
import { defaultShadowEntryConfig } from "../shadow-entry/ShadowEntryConfig.js";
import { loadShadowEntryRuns } from "../shadow-entry/ShadowEntryCandidateLoader.js";
import type { ShadowEntryCandidate } from "../shadow-entry/ShadowEntryTypes.js";
import { summarizeCounterfactualScenarios } from "./CounterfactualAnalysisService.js";
import { CounterfactualReplayService } from "./CounterfactualReplayService.js";
import {
  counterfactualCatalogVersion,
  scenariosForCandidate,
  selectedCounterfactualScenarios,
} from "./CounterfactualScenarioCatalog.js";
import type {
  CounterfactualCandidate,
  CounterfactualCandidateAnalysis,
  CounterfactualDedupeMode,
  CounterfactualReport,
  CounterfactualRuntimeConfig,
} from "./CounterfactualTypes.js";

export class CounterfactualRunner {
  constructor(
    private readonly options: {
      readonly config: CounterfactualRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): CounterfactualReport {
    const archives = loadResearchRunArchives(this.options.config.runSources);
    const loaded = loadShadowEntryRuns({
      ...defaultShadowEntryConfig(),
      once: true,
      json: this.options.config.json,
      minScore: this.options.config.minScore,
      sourceDecisions: this.options.config.sourceDecisions,
      dbSources: archives.map((archive) => ({ label: archive.label, path: archive.resolvedPath })),
    });

    try {
      const candidates = dedupeCounterfactualCandidates(
        loaded.candidates.map(normalizeCandidate),
        this.options.config.dedupeMode,
      );
      const replay = new CounterfactualReplayService();
      const analyses: CounterfactualCandidateAnalysis[] = candidates.map((candidate) => {
        const baseline = replay.replayBaseline(candidate);

        return {
          candidate,
          baseline,
          scenarios: scenariosForCandidate(candidate, this.options.config).map((scenario) =>
            replay.replayScenario({ candidate, baseline, scenario }),
          ),
        };
      });
      const fidelityCounts = {
        REPRODUCED: analyses.filter((analysis) => analysis.baseline.fidelity === "REPRODUCED")
          .length,
        PARTIALLY_REPRODUCED: analyses.filter(
          (analysis) => analysis.baseline.fidelity === "PARTIALLY_REPRODUCED",
        ).length,
        MISMATCH: analyses.filter((analysis) => analysis.baseline.fidelity === "MISMATCH").length,
        NOT_REPLAYABLE: analyses.filter(
          (analysis) => analysis.baseline.fidelity === "NOT_REPLAYABLE",
        ).length,
      } as const;
      const topPromotions = analyses
        .filter((analysis) =>
          analysis.scenarios.some(
            (scenario) =>
              scenario.outcome === "PROMOTED_TO_BUY" || scenario.outcome === "PROMOTED_TO_WATCH",
          ),
        )
        .sort(comparePromotions)
        .slice(0, this.options.config.topResults);
      const notReplayable = analyses
        .filter(
          (analysis) =>
            analysis.baseline.fidelity === "NOT_REPLAYABLE" ||
            analysis.baseline.fidelity === "MISMATCH",
        )
        .slice(0, this.options.config.topResults);

      return {
        generatedAtMs: (this.options.clock ?? Date.now)(),
        config: {
          runLabels: this.options.config.runSources.map((source) => source.label),
          catalogVersion: counterfactualCatalogVersion,
          minScore: this.options.config.minScore,
          sourceDecisions: this.options.config.sourceDecisions,
          targetPcts: this.options.config.targetPcts,
          stopPcts: this.options.config.stopPcts,
          maxHoldMinutes: this.options.config.maxHoldMinutes,
          dedupeMode: this.options.config.dedupeMode,
          scenarioSet: this.options.config.scenarioSet,
          scenarioIds: selectedCounterfactualScenarios(this.options.config).map(
            (scenario) => scenario.id,
          ),
        },
        archives,
        safety: {
          databaseAccess: "READ_ONLY_ARCHIVES",
          providerCalls: false,
          databaseWrites: false,
          sessionCreation: false,
          paperExecution: false,
          walletLoaded: false,
          transactionSigning: false,
          transactionSubmission: false,
        },
        aggregate: {
          candidateCount: candidates.length,
          observedCandidateCount: candidates.filter(
            (candidate) => candidate.observedPoints.length > 0,
          ).length,
          uniqueMintCount: new Set(candidates.map((candidate) => candidate.mintAddress)).size,
          fidelityCounts,
          orderCount: loaded.runs.reduce((total, run) => total + run.orderCount, 0),
          fillCount: loaded.runs.reduce((total, run) => total + run.fillCount, 0),
          positionCount: loaded.runs.reduce((total, run) => total + run.positionCount, 0),
        },
        scenarios: selectedCounterfactualScenarios(this.options.config),
        scenarioSummaries: summarizeCounterfactualScenarios({
          analyses,
          targetPcts: this.options.config.targetPcts,
          stopPcts: this.options.config.stopPcts,
          maxHoldMinutes: this.options.config.maxHoldMinutes,
        }),
        topPromotions,
        notReplayable,
        recommendation: recommendation(fidelityCounts, topPromotions),
        limitations: [
          "Counterfactuals replay stored historical decision inputs only; they do not fetch or invent market, quote, or authority evidence.",
          "Gate overrides are diagnostic hypotheses, not recommendations to remove production safeguards.",
          "Forward returns describe archived outcomes and do not model fills, slippage, fees, liquidity exit capacity, or execution timing.",
          "This command never creates sessions, writes to a database, invokes providers, loads a wallet, signs, or submits transactions.",
        ],
      };
    } finally {
      loaded.close();
    }
  }
}

function normalizeCandidate(candidate: ShadowEntryCandidate): CounterfactualCandidate {
  return {
    runLabel: candidate.runLabel,
    decisionId: candidate.decisionId,
    mintAddress: candidate.mintAddress,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    decidedAtMs: candidate.decidedAtMs,
    decision: candidate.decision,
    score: candidate.score,
    attribution: candidate.attribution,
    observedPoints: candidate.observedPoints,
    ...(candidate.bestReturnPct !== undefined ? { bestReturnPct: candidate.bestReturnPct } : {}),
    ...(candidate.worstReturnPct !== undefined ? { worstReturnPct: candidate.worstReturnPct } : {}),
  };
}

export function dedupeCounterfactualCandidates(
  candidates: readonly CounterfactualCandidate[],
  mode: CounterfactualDedupeMode,
): readonly CounterfactualCandidate[] {
  if (mode === "decision") {
    return candidates;
  }

  const byMint = new Map<string, CounterfactualCandidate[]>();

  for (const candidate of candidates) {
    byMint.set(candidate.mintAddress, [...(byMint.get(candidate.mintAddress) ?? []), candidate]);
  }

  return [...byMint.values()]
    .map((mintCandidates) => {
      const chronological = [...mintCandidates].sort(
        (left, right) => left.decidedAtMs - right.decidedAtMs,
      );

      if (mode === "best_per_mint") {
        return [...chronological].sort(
          (left, right) =>
            (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY) ||
            left.decidedAtMs - right.decidedAtMs,
        )[0] as CounterfactualCandidate;
      }

      return chronological[0] as CounterfactualCandidate;
    })
    .sort((left, right) => left.decidedAtMs - right.decidedAtMs);
}

function comparePromotions(
  left: CounterfactualCandidateAnalysis,
  right: CounterfactualCandidateAnalysis,
): number {
  const rank = (analysis: CounterfactualCandidateAnalysis): number =>
    analysis.scenarios.some((scenario) => scenario.outcome === "PROMOTED_TO_BUY") ? 2 : 1;

  return (
    rank(right) - rank(left) ||
    (right.candidate.bestReturnPct ?? Number.NEGATIVE_INFINITY) -
      (left.candidate.bestReturnPct ?? Number.NEGATIVE_INFINITY) ||
    (right.candidate.score ?? Number.NEGATIVE_INFINITY) -
      (left.candidate.score ?? Number.NEGATIVE_INFINITY)
  );
}

function recommendation(
  fidelityCounts: CounterfactualReport["aggregate"]["fidelityCounts"],
  promotions: readonly CounterfactualCandidateAnalysis[],
): string {
  if (fidelityCounts.MISMATCH > 0 || fidelityCounts.NOT_REPLAYABLE > 0) {
    return "Repair baseline replay fidelity before interpreting scenario outcomes or considering strategy changes.";
  }

  if (promotions.length === 0) {
    return "Collect more comparable archives; the selected single-factor scenarios did not promote archived decisions.";
  }

  return "Review promoted candidates by scenario, mint concentration, and observed outcomes before proposing any narrow strategy experiment. Production defaults remain unchanged.";
}
