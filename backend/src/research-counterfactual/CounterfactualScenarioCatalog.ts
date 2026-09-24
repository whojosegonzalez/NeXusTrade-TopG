import type {
  CounterfactualCandidate,
  CounterfactualRuntimeConfig,
  CounterfactualScenarioDefinition,
  CounterfactualScenarioId,
} from "./CounterfactualTypes.js";

const catalog: readonly CounterfactualScenarioDefinition[] = [
  {
    id: "SCORE_THRESHOLD_75_70",
    label: "Use score thresholds 75/70",
    category: "thresholds",
    description: "Replays the stored score with a stricter BUY/WATCH threshold pair.",
  },
  {
    id: "SCORE_THRESHOLD_65_60",
    label: "Use score thresholds 65/60",
    category: "thresholds",
    description: "Replays the stored score with the historical research threshold pair.",
  },
  {
    id: "DUPLICATE_BUY_DISABLED",
    label: "Disable duplicate BUY protection",
    category: "policies",
    description: "Removes only the recorded duplicate-BUY blocker.",
  },
  {
    id: "MAX_BUY_CAP_DISABLED",
    label: "Disable maximum BUY cap",
    category: "policies",
    description: "Removes only the recorded maximum-BUY-cap blocker.",
  },
  {
    id: "RISK_ELIGIBILITY_OVERRIDE",
    label: "Override risk eligibility",
    category: "gates",
    description:
      "Treats the recorded risk eligibility gate as passing; it does not invent risk evidence.",
  },
  {
    id: "LIQUIDITY_GATE_OVERRIDE",
    label: "Override liquidity gate",
    category: "gates",
    description: "Treats the recorded liquidity gate as passing; score factors remain unchanged.",
  },
  {
    id: "VOLUME_GATE_OVERRIDE",
    label: "Override volume gate",
    category: "gates",
    description: "Treats the recorded volume gate as passing; score factors remain unchanged.",
  },
  {
    id: "PAIR_AGE_GATE_OVERRIDE",
    label: "Override pair-age gate",
    category: "gates",
    description: "Treats the recorded pair-age gate as passing; score factors remain unchanged.",
  },
  {
    id: "PRICE_IMPACT_GATE_OVERRIDE",
    label: "Override price-impact gate",
    category: "gates",
    description:
      "Treats the recorded price-impact gate as passing; it does not supply a missing quote.",
  },
];

export const counterfactualCatalogVersion = "counterfactual-v1";

const gateByScenario: Readonly<Partial<Record<CounterfactualScenarioId, string>>> = {
  RISK_ELIGIBILITY_OVERRIDE: "risk_eligibility",
  LIQUIDITY_GATE_OVERRIDE: "liquidity_attractiveness",
  VOLUME_GATE_OVERRIDE: "volume_1h_attractiveness",
  PAIR_AGE_GATE_OVERRIDE: "pair_age_attractiveness",
  PRICE_IMPACT_GATE_OVERRIDE: "price_impact_attractiveness",
};

export function counterfactualScenarioCatalog(): readonly CounterfactualScenarioDefinition[] {
  return catalog;
}

export function selectedCounterfactualScenarios(
  config: CounterfactualRuntimeConfig,
): readonly CounterfactualScenarioDefinition[] {
  return catalog.filter((scenario) => isEnabled(scenario, config));
}

export function scenariosForCandidate(
  candidate: CounterfactualCandidate,
  config: CounterfactualRuntimeConfig,
): readonly CounterfactualScenarioDefinition[] {
  return catalog.filter(
    (scenario) => isEnabled(scenario, config) && isRelevant(scenario.id, candidate),
  );
}

export function gateRuleForScenario(id: CounterfactualScenarioId): string | undefined {
  return gateByScenario[id];
}

function isEnabled(
  scenario: CounterfactualScenarioDefinition,
  config: CounterfactualRuntimeConfig,
): boolean {
  if (config.scenarioIds.length > 0) {
    return (
      config.scenarioIds.includes(scenario.id) &&
      (config.scenarioSet === "default" || config.scenarioSet === scenario.category)
    );
  }

  return config.scenarioSet === "default" || config.scenarioSet === scenario.category;
}

function isRelevant(id: CounterfactualScenarioId, candidate: CounterfactualCandidate): boolean {
  if (id === "DUPLICATE_BUY_DISABLED") {
    return candidate.attribution.duplicateBuyBlocked;
  }

  if (id === "MAX_BUY_CAP_DISABLED") {
    return candidate.attribution.maxBuyCapBlocked;
  }

  const gateRule = gateRuleForScenario(id);

  return gateRule
    ? candidate.attribution.factors.some((factor) => factor.ruleName === gateRule && !factor.passed)
    : true;
}
