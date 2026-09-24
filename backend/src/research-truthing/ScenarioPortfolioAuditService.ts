import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import type {
  ResearchTruthingRuntimeConfig,
  ResearchTruthingScenarioPortfolioAudit,
  ResearchTruthingScenarioPortfolioRow,
} from "./ResearchTruthingTypes.js";

export class ScenarioPortfolioAuditService {
  summarize(input: {
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly config: Pick<
      ResearchTruthingRuntimeConfig,
      "targetPcts" | "stopPcts" | "maxHoldMinutes" | "topLimit"
    >;
  }): ResearchTruthingScenarioPortfolioAudit {
    const rows: ResearchTruthingScenarioPortfolioRow[] = [];

    for (const targetPct of input.config.targetPcts) {
      for (const stopPct of input.config.stopPcts) {
        for (const maxHoldMinutes of input.config.maxHoldMinutes) {
          rows.push(
            summarizeScenario({
              candidates: input.candidates,
              targetPct,
              stopPct,
              maxHoldMinutes,
            }),
          );
        }
      }
    }

    return {
      rows,
      notes: [
        "Scenario portfolio rows are shadow simulations, not realized paper P/L.",
        "Entries considered are StrategyDecision candidates after the active truthing filters and dedupe mode.",
      ],
    };
  }
}

function summarizeScenario(input: {
  readonly candidates: readonly ResearchInterpretationCandidate[];
  readonly targetPct: number;
  readonly stopPct: number;
  readonly maxHoldMinutes: number;
}): ResearchTruthingScenarioPortfolioRow {
  let targetFirstCount = 0;
  let drawdownFirstCount = 0;
  let neitherCount = 0;
  let ambiguousCount = 0;
  let unobservedCount = 0;
  const exitReturns: number[] = [];

  for (const candidate of input.candidates) {
    const observedPoints = candidate.observedPoints.filter(
      (point) => point.horizonMinutes <= input.maxHoldMinutes,
    );

    if (observedPoints.length === 0) {
      unobservedCount += 1;
      continue;
    }

    const outcome = classifyTargetStop({
      observedPoints,
      targetPct: input.targetPct,
      stopPct: input.stopPct,
    });

    if (outcome === "TARGET_FIRST") {
      targetFirstCount += 1;
      exitReturns.push(input.targetPct);
    } else if (outcome === "STOP_FIRST") {
      drawdownFirstCount += 1;
      exitReturns.push(-input.stopPct);
    } else if (outcome === "AMBIGUOUS") {
      ambiguousCount += 1;
    } else {
      neitherCount += 1;
      exitReturns.push(observedPoints[observedPoints.length - 1]?.returnPct ?? 0);
    }
  }

  return {
    targetPct: input.targetPct,
    stopPct: input.stopPct,
    maxHoldMinutes: input.maxHoldMinutes,
    entriesConsidered: input.candidates.length,
    uniqueMints: new Set(input.candidates.map((candidate) => candidate.mintAddress)).size,
    targetFirstCount,
    drawdownFirstCount,
    neitherCount,
    ambiguousCount,
    unobservedCount,
    ...(exitReturns.length > 0
      ? {
          averageExitReturnPct:
            exitReturns.reduce((total, value) => total + value, 0) / exitReturns.length,
        }
      : {}),
    truncated: false,
  };
}

function classifyTargetStop(input: {
  readonly observedPoints: ResearchInterpretationCandidate["observedPoints"];
  readonly targetPct: number;
  readonly stopPct: number;
}): "TARGET_FIRST" | "STOP_FIRST" | "AMBIGUOUS" | "NEITHER" {
  const targetPoint = input.observedPoints.find((point) => point.returnPct >= input.targetPct);
  const stopPoint = input.observedPoints.find((point) => point.returnPct <= -input.stopPct);

  if (!targetPoint && !stopPoint) {
    return "NEITHER";
  }

  if (targetPoint && !stopPoint) {
    return "TARGET_FIRST";
  }

  if (!targetPoint && stopPoint) {
    return "STOP_FIRST";
  }

  if (targetPoint && stopPoint && targetPoint.horizonMinutes < stopPoint.horizonMinutes) {
    return "TARGET_FIRST";
  }

  if (targetPoint && stopPoint && stopPoint.horizonMinutes < targetPoint.horizonMinutes) {
    return "STOP_FIRST";
  }

  return "AMBIGUOUS";
}
