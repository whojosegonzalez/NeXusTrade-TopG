import type {
  ResearchAggregateRuntimeConfig,
  ResearchCrossRunSummary,
  ResearchPromotionGateResult,
  ResearchRunValidation,
} from "./ResearchAggregateTypes.js";
import type { ShadowEntryReport } from "../shadow-entry/ShadowEntryTypes.js";

export interface PromotionGateServiceInput {
  readonly config: ResearchAggregateRuntimeConfig;
  readonly crossRun: ResearchCrossRunSummary;
  readonly runValidations: readonly ResearchRunValidation[];
  readonly shadowEntries: ShadowEntryReport;
}

export class PromotionGateService {
  evaluate(input: PromotionGateServiceInput): ResearchPromotionGateResult {
    const blockingReasons = this.buildBlockingReasons(input);
    const cautionNotes = this.buildCautionNotes(input);
    const supportingEvidence = this.buildSupportingEvidence(input);
    const bestEntryCandidate = input.shadowEntries.readinessByProfile.find(
      (row) => row.label === "ALL" && row.status === "CANDIDATE_FOR_PROMOTION",
    );
    const hasPromotionCandidate = bestEntryCandidate !== undefined;
    const sampleBlocks = blockingReasons.filter((reason) =>
      reason.toLowerCase().includes("sample"),
    );
    const readiness =
      blockingReasons.length === 0 && hasPromotionCandidate
        ? "CANDIDATE_FOR_CONTROLLED_PAPER_PILOT"
        : sampleBlocks.length > 0 || input.crossRun.observedDecisionCount === 0
          ? "NOT_READY"
          : "PROMISING_RESEARCH";

    return {
      readiness,
      confidence: this.chooseConfidence(input, readiness),
      ...(bestEntryCandidate ? { candidateProfileId: bestEntryCandidate.profileKey } : {}),
      controlledPaperPilotRecommended: readiness === "CANDIDATE_FOR_CONTROLLED_PAPER_PILOT",
      paperBuyAutomationEnabled: false,
      blockingReasons:
        blockingReasons.length > 0
          ? blockingReasons
          : ["No promotion blockers were detected by Phase 9.1 gates."],
      supportingEvidence,
      cautionNotes,
    };
  }

  private buildBlockingReasons(input: PromotionGateServiceInput): readonly string[] {
    const reasons: string[] = [];
    const invalidRuns = input.runValidations.filter((run) => !run.validForPromotion);
    const candidateProfiles = input.shadowEntries.readinessByProfile.filter(
      (row) => row.label === "ALL" && row.status === "CANDIDATE_FOR_PROMOTION",
    );

    if (input.crossRun.validRunCount < input.config.minRuns) {
      reasons.push(
        `Run sample is too small: validRuns=${input.crossRun.validRunCount}, required=${input.config.minRuns}.`,
      );
    }

    if (invalidRuns.length > 0) {
      reasons.push(
        `One or more archives are not promotion-valid: ${invalidRuns
          .map((run) => run.label)
          .join(", ")}.`,
      );
    }

    if (input.crossRun.uniqueMintCount < input.config.minUniqueMintsForPromotion) {
      reasons.push(
        `Unique-mint sample is too small: uniqueMints=${input.crossRun.uniqueMintCount}, required=${input.config.minUniqueMintsForPromotion}.`,
      );
    }

    if (input.crossRun.observedDecisionCount < input.config.minObservedDecisionsForPromotion) {
      reasons.push(
        `Observed-decision sample is too small: observedDecisions=${input.crossRun.observedDecisionCount}, required=${input.config.minObservedDecisionsForPromotion}.`,
      );
    }

    if (
      input.crossRun.concentration.maxSingleRunWinSharePct > input.config.maxSingleRunWinSharePct
    ) {
      reasons.push(
        `Target-first wins are too concentrated in one run: ${input.crossRun.concentration.maxSingleRunWinSharePct.toFixed(
          2,
        )}% from ${input.crossRun.concentration.dominantRunLabel ?? "one run"}.`,
      );
    }

    if (
      input.crossRun.concentration.maxSingleMintWinSharePct > input.config.maxSingleRunWinSharePct
    ) {
      reasons.push(
        `Target-first wins are too concentrated in one mint: ${input.crossRun.concentration.maxSingleMintWinSharePct.toFixed(
          2,
        )}% from ${input.crossRun.concentration.dominantMintAddress ?? "one mint"}.`,
      );
    }

    if (
      input.crossRun.orderCount > 0 ||
      input.crossRun.fillCount > 0 ||
      input.crossRun.positionCount > 0
    ) {
      reasons.push(
        `Archived runs contain paper execution rows: orders=${input.crossRun.orderCount} fills=${input.crossRun.fillCount} positions=${input.crossRun.positionCount}.`,
      );
    }

    if (candidateProfiles.length === 0) {
      reasons.push("No shadow-entry profile currently clears the Phase 8.92B promotion workbench.");
    }

    return reasons;
  }

  private buildCautionNotes(input: PromotionGateServiceInput): readonly string[] {
    const notes: string[] = [];
    const jupiter = input.crossRun.providerPressure.find(
      (provider) => provider.provider.toUpperCase() === "JUPITER",
    );

    if (jupiter && jupiter.liveRateLimitedPercent >= 30) {
      notes.push(
        `Jupiter remains a material bottleneck: liveRateLimited=${jupiter.liveRateLimitedPercent.toFixed(
          2,
        )}% combinedRateLimited=${jupiter.combinedRateLimitedPercent.toFixed(2)}%.`,
      );
    }

    if (input.crossRun.concentration.targetFirstWinCount === 0) {
      notes.push("No target-first wins were available for concentration analysis.");
    }

    notes.push("Phase 9.1 is research-only; it does not enable paper BUY automation.");

    return notes;
  }

  private buildSupportingEvidence(input: PromotionGateServiceInput): readonly string[] {
    const bestThreshold = input.crossRun.thresholdComparisons
      .slice()
      .sort(
        (left, right) =>
          (right.targetHitRates["10"] ?? 0) - (left.targetHitRates["10"] ?? 0) ||
          right.observedBuyCount - left.observedBuyCount,
      )[0];
    const bestEntryReadiness = input.shadowEntries.readinessByProfile
      .filter((row) => row.label === "ALL")
      .slice()
      .sort((left, right) => readinessRank(right.status) - readinessRank(left.status))[0];
    const evidence = [
      `validRuns=${input.crossRun.validRunCount}/${input.crossRun.runCount}`,
      `observedDecisions=${input.crossRun.observedDecisionCount}`,
      `uniqueMints=${input.crossRun.uniqueMintCount}`,
      `targetFirstWins=${input.crossRun.concentration.targetFirstWinCount}`,
    ];

    if (bestThreshold) {
      evidence.push(
        `${bestThreshold.profileId} observedBUY=${bestThreshold.observedBuyCount} hit10=${(
          bestThreshold.targetHitRates["10"] ?? 0
        ).toFixed(2)}% avgWorst=${formatOptional(bestThreshold.averageWorstReturnPct)}%`,
      );
    }

    if (bestEntryReadiness) {
      evidence.push(
        `bestEntryProfile=${bestEntryReadiness.profileKey} status=${bestEntryReadiness.status} confidence=${bestEntryReadiness.confidence}`,
      );
    }

    return evidence;
  }

  private chooseConfidence(
    input: PromotionGateServiceInput,
    readiness: ResearchPromotionGateResult["readiness"],
  ): ResearchPromotionGateResult["confidence"] {
    if (
      input.crossRun.validRunCount < input.config.minRuns ||
      input.crossRun.uniqueMintCount < input.config.minUniqueMintsForPromotion ||
      input.crossRun.observedDecisionCount < input.config.minObservedDecisionsForPromotion
    ) {
      return "LOW";
    }

    if (
      readiness === "CANDIDATE_FOR_CONTROLLED_PAPER_PILOT" &&
      input.crossRun.validRunCount >= 4 &&
      input.crossRun.uniqueMintCount >= 25 &&
      input.crossRun.observedDecisionCount >= 250 &&
      input.crossRun.concentration.maxSingleRunWinSharePct <= 30 &&
      input.crossRun.concentration.maxSingleMintWinSharePct <= 30
    ) {
      return "HIGH";
    }

    return "MEDIUM";
  }
}

function readinessRank(status: string): number {
  if (status === "CANDIDATE_FOR_PROMOTION") {
    return 3;
  }

  if (status === "PROMISING_RESEARCH") {
    return 2;
  }

  return 1;
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(2);
}
