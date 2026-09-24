import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";
import type {
  ResearchAggregateRuntimeConfig,
  ResearchRunSourceConfig,
  ResearchThresholdProfile,
} from "./ResearchAggregateTypes.js";

const DEFAULTS = {
  minRuns: 3,
  minUniqueMintsForPromotion: 10,
  minObservedDecisionsForPromotion: 100,
  maxSingleRunWinSharePct: 40,
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: [15, 30, 60],
  scoreBucketSize: 5,
  minScore: 50,
  sourceDecisions: ["BUY", "WATCH", "SKIP"] as readonly StrategyDecision[],
  thresholdProfiles: [
    {
      id: "BUY55",
      version: "v1",
      label: "BUY >= 55 / WATCH >= 50",
      buyScoreThreshold: 55,
      watchScoreThreshold: 50,
    },
    {
      id: "BUY65",
      version: "v1",
      label: "BUY >= 65 / WATCH >= 60",
      buyScoreThreshold: 65,
      watchScoreThreshold: 60,
    },
    {
      id: "BUY75",
      version: "v1",
      label: "BUY >= 75 / WATCH >= 70",
      buyScoreThreshold: 75,
      watchScoreThreshold: 70,
    },
    {
      id: "P001",
      version: "v1",
      label: "Immutable baseline BUY >= 90 / WATCH >= 70",
      buyScoreThreshold: 90,
      watchScoreThreshold: 70,
    },
  ] as readonly ResearchThresholdProfile[],
} as const;

type MutableResearchAggregateConfigDraft = {
  -readonly [Key in keyof ResearchAggregateRuntimeConfig]?: ResearchAggregateRuntimeConfig[Key];
};

export function defaultResearchAggregateConfig(): ResearchAggregateRuntimeConfig {
  return {
    once: false,
    json: false,
    runSources: [],
    minRuns: DEFAULTS.minRuns,
    minUniqueMintsForPromotion: DEFAULTS.minUniqueMintsForPromotion,
    minObservedDecisionsForPromotion: DEFAULTS.minObservedDecisionsForPromotion,
    maxSingleRunWinSharePct: DEFAULTS.maxSingleRunWinSharePct,
    targetPcts: DEFAULTS.targetPcts,
    stopPcts: DEFAULTS.stopPcts,
    maxHoldMinutes: DEFAULTS.maxHoldMinutes,
    scoreBucketSize: DEFAULTS.scoreBucketSize,
    minScore: DEFAULTS.minScore,
    sourceDecisions: DEFAULTS.sourceDecisions,
    thresholdProfiles: DEFAULTS.thresholdProfiles,
  };
}

export function parseResearchAggregateArgs(
  argv: readonly string[],
): ResearchAggregateRuntimeConfig {
  const parsed: MutableResearchAggregateConfigDraft = {};
  const runSources: ResearchRunSourceConfig[] = [];

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg.startsWith("--label-run=")) {
      runSources.push(parseLabelRunOption(arg));
      continue;
    }

    if (arg.startsWith("--output-dir=")) {
      const outputDir = arg.slice("--output-dir=".length).trim();

      if (!outputDir) {
        throw new Error("Invalid research aggregate option: --output-dir must not be empty.");
      }

      parsed.outputDir = outputDir;
      continue;
    }

    if (arg.startsWith("--min-runs=")) {
      parsed.minRuns = parseIntegerOption(arg, "--min-runs");
      continue;
    }

    if (arg.startsWith("--min-unique-mints=")) {
      parsed.minUniqueMintsForPromotion = parseIntegerOption(arg, "--min-unique-mints");
      continue;
    }

    if (arg.startsWith("--min-observed-decisions=")) {
      parsed.minObservedDecisionsForPromotion = parseIntegerOption(arg, "--min-observed-decisions");
      continue;
    }

    if (arg.startsWith("--max-single-run-win-share-pct=")) {
      parsed.maxSingleRunWinSharePct = parseNumberOption(arg, "--max-single-run-win-share-pct");
      continue;
    }

    if (arg.startsWith("--target-pcts=")) {
      parsed.targetPcts = parseNumberListOption(arg, "--target-pcts");
      continue;
    }

    if (arg.startsWith("--stop-pcts=")) {
      parsed.stopPcts = parseNumberListOption(arg, "--stop-pcts");
      continue;
    }

    if (arg.startsWith("--max-hold-minutes=")) {
      parsed.maxHoldMinutes = parseIntegerListOption(arg, "--max-hold-minutes");
      continue;
    }

    if (arg.startsWith("--score-bucket-size=")) {
      parsed.scoreBucketSize = parseIntegerOption(arg, "--score-bucket-size");
      continue;
    }

    if (arg.startsWith("--min-score=")) {
      parsed.minScore = parseIntegerOption(arg, "--min-score");
      continue;
    }

    if (arg.startsWith("--source-decisions=")) {
      parsed.sourceDecisions = parseDecisionListOption(arg, "--source-decisions");
      continue;
    }

    throw new Error(`Unknown research aggregate option: ${arg}`);
  }

  return validateResearchAggregateConfig({
    ...defaultResearchAggregateConfig(),
    ...parsed,
    runSources,
  });
}

export function validateResearchAggregateConfig(
  config: ResearchAggregateRuntimeConfig,
): ResearchAggregateRuntimeConfig {
  validatePositiveInteger("minRuns", config.minRuns);
  validatePositiveInteger("minUniqueMintsForPromotion", config.minUniqueMintsForPromotion);
  validatePositiveInteger(
    "minObservedDecisionsForPromotion",
    config.minObservedDecisionsForPromotion,
  );
  validatePositiveNumber("maxSingleRunWinSharePct", config.maxSingleRunWinSharePct);
  validatePositiveInteger("scoreBucketSize", config.scoreBucketSize);
  validateScore("minScore", config.minScore);
  validateNonEmpty("runSources", config.runSources);
  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("stopPcts", config.stopPcts);
  validateNonEmpty("maxHoldMinutes", config.maxHoldMinutes);
  validateNonEmpty("sourceDecisions", config.sourceDecisions);

  for (const targetPct of config.targetPcts) {
    validatePositiveNumber("targetPct", targetPct);
  }

  for (const stopPct of config.stopPcts) {
    validatePositiveNumber("stopPct", stopPct);
  }

  for (const maxHoldMinutes of config.maxHoldMinutes) {
    validatePositiveInteger("maxHoldMinutes", maxHoldMinutes);
  }

  assertUniqueLabels(config.runSources);

  return {
    ...config,
    targetPcts: uniqueNumbers(config.targetPcts),
    stopPcts: uniqueNumbers(config.stopPcts),
    maxHoldMinutes: uniqueNumbers(config.maxHoldMinutes).sort((left, right) => left - right),
    sourceDecisions: [...new Set(config.sourceDecisions)],
  };
}

function parseLabelRunOption(arg: string): ResearchRunSourceConfig {
  const raw = arg.slice("--label-run=".length).trim();
  const separatorIndex = raw.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("Invalid research aggregate option: --label-run must use <label>:<path>.");
  }

  const label = raw.slice(0, separatorIndex).trim();
  const runPath = raw.slice(separatorIndex + 1).trim();

  if (!label || !runPath) {
    throw new Error("Invalid research aggregate option: --label-run must use <label>:<path>.");
  }

  return { label, path: runPath };
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research aggregate option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid research aggregate option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
          ", ",
        )}).`,
      );
    }

    return decision as StrategyDecision;
  });
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid research aggregate option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || raw.trim() === "") {
    throw new Error(`Invalid research aggregate option: ${name} must be a number.`);
  }

  return parsed;
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research aggregate option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(
        `Invalid research aggregate option: ${name} must be a comma-separated number list.`,
      );
    }

    return parsed;
  });
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research aggregate option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(
        `Invalid research aggregate option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid research aggregate option: ${name} must not be empty.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid research aggregate option: ${name} must be a positive integer.`);
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid research aggregate option: ${name} must be a positive number.`);
  }
}

function validateScore(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(
      `Invalid research aggregate option: ${name} must be an integer between 0 and 100.`,
    );
  }
}

function assertUniqueLabels(sources: readonly ResearchRunSourceConfig[]): void {
  const seen = new Set<string>();

  for (const source of sources) {
    if (seen.has(source.label)) {
      throw new Error(`Invalid research aggregate option: duplicate run label ${source.label}.`);
    }

    seen.add(source.label);
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}
