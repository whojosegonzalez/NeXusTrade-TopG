import type { CalibrationThresholdScenario } from "./CalibrationConfig.js";
import type { CalibrationDecisionAnalysis, ThresholdScenarioSummary } from "./CalibrationTypes.js";

export class ThresholdComparisonService {
  compare(
    decisions: readonly CalibrationDecisionAnalysis[],
    scenarios: readonly CalibrationThresholdScenario[],
    targetPcts: readonly number[],
  ): readonly ThresholdScenarioSummary[] {
    return scenarios.map((scenario) => this.compareScenario(decisions, scenario, targetPcts));
  }

  private compareScenario(
    decisions: readonly CalibrationDecisionAnalysis[],
    scenario: CalibrationThresholdScenario,
    targetPcts: readonly number[],
  ): ThresholdScenarioSummary {
    const simulated = decisions.map((decision) => ({
      decision,
      simulatedDecision: classifyDecision(decision, scenario),
    }));
    const simulatedBuys = simulated
      .filter((row) => row.simulatedDecision === "BUY")
      .map((row) => row.decision);
    const observedBuys = simulatedBuys.filter(
      (decision) => decision.returns.bestReturnPct !== undefined,
    );
    const targetHitRatesByPct = Object.fromEntries(
      targetPcts.map((targetPct) => [`${targetPct}`, hitRate(observedBuys, targetPct)]),
    );

    return {
      buyScoreThreshold: scenario.buyScoreThreshold,
      watchScoreThreshold: scenario.watchScoreThreshold,
      buyCount: simulatedBuys.length,
      watchCount: simulated.filter((row) => row.simulatedDecision === "WATCH").length,
      skipCount: simulated.filter((row) => row.simulatedDecision === "SKIP").length,
      uniqueBuyMints: new Set(simulatedBuys.map((decision) => decision.mintAddress)).size,
      observedBuyCount: observedBuys.length,
      targetHitRatesByPct,
      averageBuyBestReturnPct: averageDefined(
        observedBuys.map((decision) => decision.returns.bestReturnPct),
      ),
      averageBuyWorstReturnPct: averageDefined(
        observedBuys.map((decision) => decision.returns.worstReturnPct),
      ),
    };
  }
}

type SimulatedDecision = "BUY" | "WATCH" | "SKIP";

function classifyDecision(
  decision: CalibrationDecisionAnalysis,
  scenario: CalibrationThresholdScenario,
): SimulatedDecision {
  const score = decision.score ?? -1;

  if (
    score >= scenario.buyScoreThreshold &&
    decision.attribution.buyEligible &&
    !decision.attribution.duplicateBuyBlocked &&
    !decision.attribution.maxBuyCapBlocked
  ) {
    return "BUY";
  }

  if (score >= scenario.watchScoreThreshold) {
    return "WATCH";
  }

  return "SKIP";
}

function hitRate(decisions: readonly CalibrationDecisionAnalysis[], targetPct: number): number {
  const observed = decisions.filter((decision) => decision.returns.bestReturnPct !== undefined);

  if (observed.length === 0) {
    return 0;
  }

  return (
    (observed.filter((decision) => (decision.returns.bestReturnPct ?? -Infinity) >= targetPct)
      .length /
      observed.length) *
    100
  );
}

function averageDefined(values: readonly (number | undefined)[]): number | null {
  const defined = values.filter((value): value is number => value !== undefined);

  if (defined.length === 0) {
    return null;
  }

  return defined.reduce((total, value) => total + value, 0) / defined.length;
}
