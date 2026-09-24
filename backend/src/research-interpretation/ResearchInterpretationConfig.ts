import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";
import type {
  ResearchInterpretationDedupeMode,
  ResearchInterpretationRunSourceConfig,
  ResearchInterpretationRuntimeConfig,
} from "./ResearchInterpretationTypes.js";

const DEFAULTS = {
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: [15, 30, 60],
  minScore: 50,
  sourceDecisions: ["BUY", "WATCH", "SKIP"] as readonly StrategyDecision[],
  topOpportunities: 25,
  topBlockers: 20,
  marketWindowMinutes: 60,
  scoreBucketSize: 5,
  dedupeMode: "decision" as ResearchInterpretationDedupeMode,
} as const;

type MutableResearchInterpretationConfigDraft = {
  -readonly [Key in keyof ResearchInterpretationRuntimeConfig]?: ResearchInterpretationRuntimeConfig[Key];
};

export function defaultResearchInterpretationConfig(): ResearchInterpretationRuntimeConfig {
  return {
    once: false,
    json: false,
    runSources: [],
    minScore: DEFAULTS.minScore,
    sourceDecisions: DEFAULTS.sourceDecisions,
    targetPcts: DEFAULTS.targetPcts,
    stopPcts: DEFAULTS.stopPcts,
    maxHoldMinutes: DEFAULTS.maxHoldMinutes,
    topOpportunities: DEFAULTS.topOpportunities,
    topBlockers: DEFAULTS.topBlockers,
    marketWindowMinutes: DEFAULTS.marketWindowMinutes,
    scoreBucketSize: DEFAULTS.scoreBucketSize,
    dedupeMode: DEFAULTS.dedupeMode,
  };
}

export function parseResearchInterpretationArgs(
  argv: readonly string[],
): ResearchInterpretationRuntimeConfig {
  const parsed: MutableResearchInterpretationConfigDraft = {};
  const runSources: ResearchInterpretationRunSourceConfig[] = [];

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
        throw new Error("Invalid research interpretation option: --output-dir must not be empty.");
      }

      parsed.outputDir = outputDir;
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

    if (arg.startsWith("--top-opportunities=")) {
      parsed.topOpportunities = parseIntegerOption(arg, "--top-opportunities");
      continue;
    }

    if (arg.startsWith("--top-blockers=")) {
      parsed.topBlockers = parseIntegerOption(arg, "--top-blockers");
      continue;
    }

    if (arg.startsWith("--market-window-minutes=")) {
      parsed.marketWindowMinutes = parseIntegerOption(arg, "--market-window-minutes");
      continue;
    }

    if (arg.startsWith("--score-bucket-size=")) {
      parsed.scoreBucketSize = parseIntegerOption(arg, "--score-bucket-size");
      continue;
    }

    if (arg.startsWith("--dedupe-mode=")) {
      parsed.dedupeMode = parseDedupeMode(arg.slice("--dedupe-mode=".length));
      continue;
    }

    throw new Error(`Unknown research interpretation option: ${arg}`);
  }

  return validateResearchInterpretationConfig({
    ...defaultResearchInterpretationConfig(),
    ...parsed,
    runSources,
  });
}

export function validateResearchInterpretationConfig(
  config: ResearchInterpretationRuntimeConfig,
): ResearchInterpretationRuntimeConfig {
  validateNonEmpty("runSources", config.runSources);
  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("stopPcts", config.stopPcts);
  validateNonEmpty("maxHoldMinutes", config.maxHoldMinutes);
  validateNonEmpty("sourceDecisions", config.sourceDecisions);
  validateScore("minScore", config.minScore);
  validatePositiveInteger("topOpportunities", config.topOpportunities);
  validatePositiveInteger("topBlockers", config.topBlockers);
  validatePositiveInteger("marketWindowMinutes", config.marketWindowMinutes);
  validatePositiveInteger("scoreBucketSize", config.scoreBucketSize);

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
    sourceDecisions: unique(config.sourceDecisions),
  };
}

function parseLabelRunOption(arg: string): ResearchInterpretationRunSourceConfig {
  const raw = arg.slice("--label-run=".length).trim();
  const separatorIndex = raw.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("Invalid research interpretation option: --label-run must use <label>:<path>.");
  }

  const label = raw.slice(0, separatorIndex).trim();
  const runPath = raw.slice(separatorIndex + 1).trim();

  if (!label || !runPath) {
    throw new Error("Invalid research interpretation option: --label-run must use <label>:<path>.");
  }

  return { label, path: runPath };
}

function parseDedupeMode(value: string): ResearchInterpretationDedupeMode {
  const normalized = value.trim().toLowerCase();

  if (
    normalized !== "decision" &&
    normalized !== "mint" &&
    normalized !== "first_per_mint" &&
    normalized !== "best_per_mint"
  ) {
    throw new Error(
      "Invalid research interpretation option: --dedupe-mode must be decision, mint, first_per_mint, or best_per_mint.",
    );
  }

  return normalized;
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research interpretation option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid research interpretation option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
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
    throw new Error(`Invalid research interpretation option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research interpretation option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(
        `Invalid research interpretation option: ${name} must be a comma-separated number list.`,
      );
    }

    return parsed;
  });
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research interpretation option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(
        `Invalid research interpretation option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid research interpretation option: ${name} must not be empty.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid research interpretation option: ${name} must be a positive integer.`);
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid research interpretation option: ${name} must be a positive number.`);
  }
}

function validateScore(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(
      `Invalid research interpretation option: ${name} must be an integer between 0 and 100.`,
    );
  }
}

function assertUniqueLabels(sources: readonly ResearchInterpretationRunSourceConfig[]): void {
  const seen = new Set<string>();

  for (const source of sources) {
    if (seen.has(source.label)) {
      throw new Error(
        `Invalid research interpretation option: duplicate run label ${source.label}.`,
      );
    }

    seen.add(source.label);
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
