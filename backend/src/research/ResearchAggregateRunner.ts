import { defaultShadowCalibrationConfig } from "../shadow-calibration/ShadowCalibrationConfig.js";
import { ShadowCalibrationReportService } from "../shadow-calibration/ShadowCalibrationReportService.js";
import { defaultShadowEntryConfig } from "../shadow-entry/ShadowEntryConfig.js";
import { loadShadowEntryRuns } from "../shadow-entry/ShadowEntryCandidateLoader.js";
import { ShadowEntryReportService } from "../shadow-entry/ShadowEntryReportService.js";
import { CrossRunResearchService } from "./CrossRunResearchService.js";
import { PromotionGateService } from "./PromotionGateService.js";
import { loadResearchRunArchives } from "./ResearchRunArchiveLoader.js";
import type {
  ResearchAggregateReport,
  ResearchAggregateRuntimeConfig,
} from "./ResearchAggregateTypes.js";

export class ResearchAggregateRunner {
  constructor(
    private readonly options: {
      readonly config: ResearchAggregateRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): ResearchAggregateReport {
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
      scoreBucketSize: this.options.config.scoreBucketSize,
      minScore: this.options.config.minScore,
      sourceDecisions: this.options.config.sourceDecisions,
      dbSources,
    };
    const loadedRuns = loadShadowEntryRuns(shadowEntryConfig);

    try {
      const shadowCalibrationConfig = {
        ...defaultShadowCalibrationConfig(),
        once: true,
        json: this.options.config.json,
        targetPcts: this.options.config.targetPcts,
        stopPcts: this.options.config.stopPcts,
        maxHoldMinutes: this.options.config.maxHoldMinutes,
        scoreBucketSize: this.options.config.scoreBucketSize,
        minScore: this.options.config.minScore,
        sourceDecisions: this.options.config.sourceDecisions,
        dbSources,
      };
      const shadowCalibration = new ShadowCalibrationReportService({
        config: shadowCalibrationConfig,
        runs: loadedRuns.runs,
        clock,
      }).generate();
      const shadowEntries = new ShadowEntryReportService({
        config: shadowEntryConfig,
        runs: loadedRuns.runs,
        candidates: loadedRuns.candidates,
        clock,
      }).generate();
      const { runValidations, crossRun } = new CrossRunResearchService().generate({
        config: this.options.config,
        archives,
        shadowCalibration,
        shadowEntries,
        candidates: loadedRuns.candidates,
      });
      const promotionGate = new PromotionGateService().evaluate({
        config: this.options.config,
        crossRun,
        runValidations,
        shadowEntries,
      });

      return {
        generatedAtMs: clock(),
        config: {
          runLabels: archives.map((archive) => archive.label),
          minRuns: this.options.config.minRuns,
          minUniqueMintsForPromotion: this.options.config.minUniqueMintsForPromotion,
          minObservedDecisionsForPromotion: this.options.config.minObservedDecisionsForPromotion,
          maxSingleRunWinSharePct: this.options.config.maxSingleRunWinSharePct,
          targetPcts: this.options.config.targetPcts,
          stopPcts: this.options.config.stopPcts,
          maxHoldMinutes: this.options.config.maxHoldMinutes,
          sourceDecisions: this.options.config.sourceDecisions,
          minScore: this.options.config.minScore,
        },
        archives,
        runValidations,
        crossRun,
        shadowCalibration,
        shadowEntries,
        promotionGate,
        recommendations: buildRecommendations(promotionGate.readiness),
      };
    } finally {
      loadedRuns.close();
    }
  }
}

function buildRecommendations(
  readiness: ResearchAggregateReport["promotionGate"]["readiness"],
): readonly string[] {
  if (readiness === "CANDIDATE_FOR_CONTROLLED_PAPER_PILOT") {
    return [
      "Create a separate controlled paper pilot checklist before enabling any paper BUY automation.",
      "Keep TerminalRunner shadow comparison enabled beside any future paper pilot.",
      "Define hard position size, max-open-position, target, stop, and session loss caps before promotion.",
    ];
  }

  if (readiness === "PROMISING_RESEARCH") {
    return [
      "Keep Phase 9 TerminalRunner in shadow mode and collect another batch or move to provider bottleneck work.",
      "Use the threshold and shadow-entry sections to identify the smallest next experiment.",
      "Do not change production strategy defaults until a profile clears promotion gates.",
    ];
  }

  return [
    "Collect more valid one-session TerminalRunner archives before considering a paper pilot.",
    "Investigate validation blockers before comparing strategy quality.",
    "Do not enable paper BUY automation from this evidence set.",
  ];
}
