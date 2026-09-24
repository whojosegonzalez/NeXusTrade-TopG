import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";
import type {
  CounterfactualDedupeMode,
  CounterfactualRuntimeConfig,
  CounterfactualRunSourceConfig,
  CounterfactualScenarioId,
  CounterfactualScenarioSet,
} from "./CounterfactualTypes.js";

const DEFAULTS = {
  minScore: 50,
  sourceDecisions: ["SKIP", "WATCH"] as readonly StrategyDecision[],
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: [15, 30, 60],
  dedupeMode: "decision" as CounterfactualDedupeMode,
  scenarioSet: "default" as CounterfactualScenarioSet,
  topResults: 25,
} as const;

const scenarioIds: readonly CounterfactualScenarioId[] = [
  "SCORE_THRESHOLD_75_70",
  "SCORE_THRESHOLD_65_60",
  "DUPLICATE_BUY_DISABLED",
  "MAX_BUY_CAP_DISABLED",
  "RISK_ELIGIBILITY_OVERRIDE",
  "LIQUIDITY_GATE_OVERRIDE",
  "VOLUME_GATE_OVERRIDE",
  "PAIR_AGE_GATE_OVERRIDE",
  "PRICE_IMPACT_GATE_OVERRIDE",
];

type Draft = {
  -readonly [Key in keyof CounterfactualRuntimeConfig]?: CounterfactualRuntimeConfig[Key];
};

export function defaultCounterfactualConfig(): CounterfactualRuntimeConfig {
  return {
    once: false,
    json: false,
    runSources: [],
    minScore: DEFAULTS.minScore,
    sourceDecisions: DEFAULTS.sourceDecisions,
    targetPcts: DEFAULTS.targetPcts,
    stopPcts: DEFAULTS.stopPcts,
    maxHoldMinutes: DEFAULTS.maxHoldMinutes,
    dedupeMode: DEFAULTS.dedupeMode,
    scenarioSet: DEFAULTS.scenarioSet,
    scenarioIds: [],
    topResults: DEFAULTS.topResults,
  };
}

export function parseCounterfactualArgs(argv: readonly string[]): CounterfactualRuntimeConfig {
  const parsed: Draft = {};
  const runSources: CounterfactualRunSourceConfig[] = [];

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg.startsWith("--label-run=")) {
      runSources.push(parseLabelRun(arg));
    } else if (arg.startsWith("--output-dir=")) {
      parsed.outputDir = nonEmpty(arg.slice("--output-dir=".length), "--output-dir");
    } else if (arg.startsWith("--min-score=")) {
      parsed.minScore = integer(arg.slice("--min-score=".length), "--min-score", 0, 100);
    } else if (arg.startsWith("--source-decisions=")) {
      parsed.sourceDecisions = decisionList(arg.slice("--source-decisions=".length));
    } else if (arg.startsWith("--target-pcts=")) {
      parsed.targetPcts = numberList(arg.slice("--target-pcts=".length), "--target-pcts");
    } else if (arg.startsWith("--stop-pcts=")) {
      parsed.stopPcts = numberList(arg.slice("--stop-pcts=".length), "--stop-pcts");
    } else if (arg.startsWith("--max-hold-minutes=")) {
      parsed.maxHoldMinutes = integerList(
        arg.slice("--max-hold-minutes=".length),
        "--max-hold-minutes",
      );
    } else if (arg.startsWith("--dedupe-mode=")) {
      parsed.dedupeMode = dedupeMode(arg.slice("--dedupe-mode=".length));
    } else if (arg.startsWith("--scenario-set=")) {
      parsed.scenarioSet = scenarioSet(arg.slice("--scenario-set=".length));
    } else if (arg.startsWith("--scenarios=")) {
      parsed.scenarioIds = scenarioList(arg.slice("--scenarios=".length));
    } else if (arg.startsWith("--scenario-id=")) {
      parsed.scenarioIds = [
        ...(parsed.scenarioIds ?? []),
        ...scenarioList(arg.slice("--scenario-id=".length)),
      ];
    } else if (arg.startsWith("--top-results=")) {
      parsed.topResults = integer(arg.slice("--top-results=".length), "--top-results", 1);
    } else {
      throw new Error(`Unknown counterfactual research option: ${arg}`);
    }
  }

  const config = { ...defaultCounterfactualConfig(), ...parsed, runSources };

  if (config.runSources.length === 0) {
    throw new Error(
      "Counterfactual research requires one or more --label-run=<label>:<archive-path> options.",
    );
  }

  if (
    config.targetPcts.length === 0 ||
    config.stopPcts.length === 0 ||
    config.maxHoldMinutes.length === 0
  ) {
    throw new Error("Target, stop, and max-hold lists must not be empty.");
  }

  if (new Set(config.runSources.map((source) => source.label)).size !== config.runSources.length) {
    throw new Error("Counterfactual research run labels must be unique.");
  }

  return {
    ...config,
    sourceDecisions: [...new Set(config.sourceDecisions)],
    targetPcts: [...new Set(config.targetPcts)],
    stopPcts: [...new Set(config.stopPcts)],
    maxHoldMinutes: [...new Set(config.maxHoldMinutes)].sort((left, right) => left - right),
    scenarioIds: [...new Set(config.scenarioIds)],
  };
}

export const counterfactualScenarioIds = scenarioIds;

function parseLabelRun(arg: string): CounterfactualRunSourceConfig {
  const raw = arg.slice("--label-run=".length);
  const separator = raw.indexOf(":");

  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error("--label-run must use <label>:<archive-path>.");
  }

  return {
    label: nonEmpty(raw.slice(0, separator), "--label-run label"),
    path: nonEmpty(raw.slice(separator + 1), "--label-run path"),
  };
}

function decisionList(value: string): readonly StrategyDecision[] {
  const values = nonEmpty(value, "--source-decisions")
    .split(",")
    .map((item) => item.trim());

  if (!values.every((item) => strategyDecisionValues.includes(item as StrategyDecision))) {
    throw new Error(
      `--source-decisions must contain StrategyDecision values: ${strategyDecisionValues.join(", ")}.`,
    );
  }

  return values as StrategyDecision[];
}

function dedupeMode(value: string): CounterfactualDedupeMode {
  const normalized = value.trim().toLowerCase();

  if (!["decision", "mint", "first_per_mint", "best_per_mint"].includes(normalized)) {
    throw new Error("--dedupe-mode must be decision, mint, first_per_mint, or best_per_mint.");
  }

  return normalized as CounterfactualDedupeMode;
}

function scenarioSet(value: string): CounterfactualScenarioSet {
  const normalized = value.trim().toLowerCase();

  if (!["default", "thresholds", "gates", "policies"].includes(normalized)) {
    throw new Error("--scenario-set must be default, thresholds, gates, or policies.");
  }

  return normalized as CounterfactualScenarioSet;
}

function scenarioList(value: string): readonly CounterfactualScenarioId[] {
  const values = nonEmpty(value, "--scenarios")
    .split(",")
    .map((item) => item.trim());

  if (!values.every((item) => scenarioIds.includes(item as CounterfactualScenarioId))) {
    throw new Error(`--scenarios must contain known IDs: ${scenarioIds.join(", ")}.`);
  }

  return values as CounterfactualScenarioId[];
}

function numberList(value: string, option: string): readonly number[] {
  return nonEmpty(value, option)
    .split(",")
    .map((item) => {
      const parsed = Number(item.trim());

      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${option} must be a comma-separated list of positive numbers.`);
      }

      return parsed;
    });
}

function integerList(value: string, option: string): readonly number[] {
  return nonEmpty(value, option)
    .split(",")
    .map((item) => integer(item.trim(), option, 1));
}

function integer(value: string, option: string, minimum: number, maximum?: number): number {
  const parsed = Number.parseInt(value, 10);

  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== value ||
    parsed < minimum ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new Error(
      `${option} must be an integer${maximum === undefined ? "" : ` between ${minimum} and ${maximum}`}.`,
    );
  }

  return parsed;
}

function nonEmpty(value: string, option: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${option} must not be empty.`);
  }

  return trimmed;
}
