import type { StrategyDecision } from "../db/schema/index.js";
import { gateRuleForScenario } from "./CounterfactualScenarioCatalog.js";
import type {
  CounterfactualCandidate,
  CounterfactualOutcome,
  CounterfactualReplayResult,
  CounterfactualScenarioDefinition,
  CounterfactualScenarioResult,
} from "./CounterfactualTypes.js";

const requiredGateRules = [
  "risk_eligibility",
  "liquidity_attractiveness",
  "volume_1h_attractiveness",
  "pair_age_attractiveness",
  "price_impact_attractiveness",
] as const;

export class CounterfactualReplayService {
  replayBaseline(candidate: CounterfactualCandidate): CounterfactualReplayResult {
    const score = candidate.score;
    const buyThreshold = candidate.attribution.buyScoreThreshold;
    const watchThreshold = candidate.attribution.watchScoreThreshold;
    const warnings: string[] = [];

    if (
      score === null ||
      buyThreshold === undefined ||
      watchThreshold === undefined ||
      candidate.attribution.factors.length === 0
    ) {
      return {
        fidelity: "NOT_REPLAYABLE",
        warnings: [
          "Stored score, thresholds, or score factors are incomplete; this archive is not replayable.",
        ],
      };
    }

    const rawDecision = decisionForScore(score, buyThreshold, watchThreshold);
    const remainingBlockers = blockersFor(candidate);
    const replayed = finalDecision({
      rawDecision,
      buyEligible: remainingBlockers.gateBlockers.length === 0,
      duplicateBuyBlocked: candidate.attribution.duplicateBuyBlocked,
      maxBuyCapBlocked: candidate.attribution.maxBuyCapBlocked,
    });
    const factorTotalMatches = candidate.attribution.factorTotal === score;
    const rawDecisionMatches =
      candidate.attribution.rawDecision === undefined ||
      candidate.attribution.rawDecision === rawDecision;

    if (!factorTotalMatches) {
      warnings.push(
        `Stored score=${score} differs from score-factor total=${candidate.attribution.factorTotal}.`,
      );
    }

    if (!rawDecisionMatches) {
      warnings.push(
        `Stored raw decision=${candidate.attribution.rawDecision} differs from replayed raw decision=${rawDecision}.`,
      );
    }

    if (replayed !== candidate.decision) {
      warnings.push(
        `Stored decision=${candidate.decision} differs from replayed decision=${replayed}.`,
      );
      return {
        fidelity: "MISMATCH",
        baselineDecision: replayed,
        baselineRawDecision: rawDecision,
        baselineBuyEligible: remainingBlockers.gateBlockers.length === 0,
        warnings,
      };
    }

    return {
      fidelity: factorTotalMatches && rawDecisionMatches ? "REPRODUCED" : "PARTIALLY_REPRODUCED",
      baselineDecision: replayed,
      baselineRawDecision: rawDecision,
      baselineBuyEligible: remainingBlockers.gateBlockers.length === 0,
      warnings,
    };
  }

  replayScenario(input: {
    readonly candidate: CounterfactualCandidate;
    readonly baseline: CounterfactualReplayResult;
    readonly scenario: CounterfactualScenarioDefinition;
  }): CounterfactualScenarioResult {
    const { candidate, baseline, scenario } = input;

    if (
      baseline.fidelity === "NOT_REPLAYABLE" ||
      baseline.fidelity === "MISMATCH" ||
      baseline.baselineDecision === undefined ||
      baseline.baselineRawDecision === undefined ||
      baseline.baselineBuyEligible === undefined ||
      candidate.score === null
    ) {
      return {
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        category: scenario.category,
        evidenceQuality: "NOT_EVALUABLE",
        outcome: "NOT_EVALUABLE",
        baselineDecision: candidate.decision,
        changedInput: scenario.description,
        remainingBlockers: [],
        notes: ["Scenario skipped because baseline replay was not reliable."],
      };
    }

    if (
      (scenario.id === "PRICE_IMPACT_GATE_OVERRIDE" &&
        (candidate.attribution.missingQuote || candidate.attribution.missingPriceImpact)) ||
      (scenario.id === "RISK_ELIGIBILITY_OVERRIDE" &&
        candidate.attribution.missingAuthorityEvidence)
    ) {
      return {
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        category: scenario.category,
        evidenceQuality: "NOT_EVALUABLE",
        outcome: "NOT_EVALUABLE",
        baselineDecision: candidate.decision,
        changedInput: scenario.description,
        remainingBlockers: [],
        notes: [
          "The archived row lacks required quote or authority evidence; this scenario will not invent a passing fact.",
        ],
      };
    }

    let rawDecision = baseline.baselineRawDecision;
    let duplicateBuyBlocked = candidate.attribution.duplicateBuyBlocked;
    let maxBuyCapBlocked = candidate.attribution.maxBuyCapBlocked;
    const overriddenGate = gateRuleForScenario(scenario.id);

    if (scenario.id === "SCORE_THRESHOLD_75_70") {
      rawDecision = decisionForScore(candidate.score, 75, 70);
    }

    if (scenario.id === "SCORE_THRESHOLD_65_60") {
      rawDecision = decisionForScore(candidate.score, 65, 60);
    }

    if (scenario.id === "DUPLICATE_BUY_DISABLED") {
      duplicateBuyBlocked = false;
    }

    if (scenario.id === "MAX_BUY_CAP_DISABLED") {
      maxBuyCapBlocked = false;
    }

    const blockers = blockersFor(candidate, overriddenGate);
    const counterfactualDecision = finalDecision({
      rawDecision,
      buyEligible: blockers.gateBlockers.length === 0,
      duplicateBuyBlocked,
      maxBuyCapBlocked,
    });
    const outcome = outcomeFor(candidate.decision, counterfactualDecision, blockers.all);

    return {
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      category: scenario.category,
      evidenceQuality: overriddenGate ? "GATE_OVERRIDE" : "DIRECT",
      outcome,
      baselineDecision: candidate.decision,
      counterfactualDecision,
      score: candidate.score,
      changedInput: describeChange(scenario.id),
      remainingBlockers: blockers.all,
      notes: [
        overriddenGate
          ? "Gate override is a diagnostic counterfactual; it does not create missing evidence."
          : "Scenario changes only the named stored strategy input.",
      ],
    };
  }
}

function decisionForScore(
  score: number,
  buyThreshold: number,
  watchThreshold: number,
): StrategyDecision {
  if (score >= buyThreshold) {
    return "BUY";
  }

  return score >= watchThreshold ? "WATCH" : "SKIP";
}

function finalDecision(input: {
  readonly rawDecision: StrategyDecision;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
}): StrategyDecision {
  if (input.rawDecision !== "BUY") {
    return input.rawDecision;
  }

  if (!input.buyEligible) {
    return "SKIP";
  }

  return input.duplicateBuyBlocked || input.maxBuyCapBlocked ? "WATCH" : "BUY";
}

function blockersFor(
  candidate: CounterfactualCandidate,
  overriddenGate?: string,
): {
  readonly gateBlockers: readonly string[];
  readonly all: readonly string[];
} {
  const gateBlockers = requiredGateRules.filter((ruleName) => {
    if (ruleName === overriddenGate) {
      return false;
    }

    return candidate.attribution.factors.some(
      (factor) => factor.ruleName === ruleName && !factor.passed,
    );
  });
  const all = [
    ...gateBlockers,
    ...(candidate.attribution.duplicateBuyBlocked ? ["duplicate_buy_protection"] : []),
    ...(candidate.attribution.maxBuyCapBlocked ? ["maximum_buy_cap"] : []),
  ];

  return { gateBlockers, all };
}

function outcomeFor(
  baseline: StrategyDecision,
  counterfactual: StrategyDecision,
  remainingBlockers: readonly string[],
): CounterfactualOutcome {
  if (baseline === "SKIP" && counterfactual === "SKIP" && remainingBlockers.length > 0) {
    return "BLOCKED_BY_ANOTHER_GATE";
  }

  if (counterfactual === baseline) {
    return "UNCHANGED";
  }

  if (baseline === "SKIP" && counterfactual === "BUY") {
    return "PROMOTED_TO_BUY";
  }

  if (baseline === "SKIP" && counterfactual === "WATCH") {
    return "PROMOTED_TO_WATCH";
  }

  if (counterfactual === "SKIP") {
    return "DEMOTED_TO_SKIP";
  }

  return remainingBlockers.length > 0 ? "BLOCKED_BY_ANOTHER_GATE" : "UNCHANGED";
}

function describeChange(scenarioId: CounterfactualScenarioDefinition["id"]): string {
  const changes: Readonly<Record<CounterfactualScenarioDefinition["id"], string>> = {
    SCORE_THRESHOLD_75_70: "buyScoreThreshold=75; watchScoreThreshold=70",
    SCORE_THRESHOLD_65_60: "buyScoreThreshold=65; watchScoreThreshold=60",
    DUPLICATE_BUY_DISABLED: "duplicateBuyBlocked=false",
    MAX_BUY_CAP_DISABLED: "maxBuyCapBlocked=false",
    RISK_ELIGIBILITY_OVERRIDE: "risk_eligibility=pass",
    LIQUIDITY_GATE_OVERRIDE: "liquidity_attractiveness=pass",
    VOLUME_GATE_OVERRIDE: "volume_1h_attractiveness=pass",
    PAIR_AGE_GATE_OVERRIDE: "pair_age_attractiveness=pass",
    PRICE_IMPACT_GATE_OVERRIDE: "price_impact_attractiveness=pass",
  };

  return changes[scenarioId];
}
