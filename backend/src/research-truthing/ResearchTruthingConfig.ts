import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";
import { getRepoRoot } from "../db/utils/paths.js";
import type {
  ResearchTruthingDedupeMode,
  ResearchTruthingRunSourceConfig,
  ResearchTruthingRuntimeConfig,
} from "./ResearchTruthingTypes.js";

const DEFAULTS = {
  dedupeMode: "decision" as ResearchTruthingDedupeMode,
  sourceDecisions: ["BUY", "WATCH", "SKIP"] as readonly StrategyDecision[],
  minScore: 0,
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: [15, 30, 60, 120],
  topLimit: 25,
  marketWindowMinutes: 60,
  requireTerminalJson: true,
  requireDb: true,
} as const;

type MutableResearchTruthingConfigDraft = {
  -readonly [Key in keyof ResearchTruthingRuntimeConfig]?: ResearchTruthingRuntimeConfig[Key];
};

export function defaultResearchTruthingConfig(): ResearchTruthingRuntimeConfig {
  return {
    once: false,
    json: false,
    runSources: [],
    dedupeMode: DEFAULTS.dedupeMode,
    sourceDecisions: DEFAULTS.sourceDecisions,
    minScore: DEFAULTS.minScore,
    targetPcts: DEFAULTS.targetPcts,
    stopPcts: DEFAULTS.stopPcts,
    maxHoldMinutes: DEFAULTS.maxHoldMinutes,
    topLimit: DEFAULTS.topLimit,
    marketWindowMinutes: DEFAULTS.marketWindowMinutes,
    requireTerminalJson: DEFAULTS.requireTerminalJson,
    requireDb: DEFAULTS.requireDb,
    includeRunnerCycles: false,
  };
}

export function parseResearchTruthingArgs(argv: readonly string[]): ResearchTruthingRuntimeConfig {
  const parsed: MutableResearchTruthingConfigDraft = {};
  const runSources: ResearchTruthingRunSourceConfig[] = [];

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--include-runner-cycles") {
      parsed.includeRunnerCycles = true;
      continue;
    }

    if (arg.startsWith("--label-run=")) {
      runSources.push(parseLabelRunOption(arg));
      continue;
    }

    if (arg.startsWith("--output-dir=")) {
      const outputDir = arg.slice("--output-dir=".length).trim();

      if (!outputDir) {
        throw new Error("Invalid research truth option: --output-dir must not be empty.");
      }

      parsed.outputDir = outputDir;
      continue;
    }

    if (arg.startsWith("--dedupe-mode=")) {
      parsed.dedupeMode = parseDedupeMode(arg.slice("--dedupe-mode=".length));
      continue;
    }

    if (arg.startsWith("--source-decisions=")) {
      parsed.sourceDecisions = parseDecisionListOption(arg, "--source-decisions");
      continue;
    }

    if (arg.startsWith("--min-score=")) {
      parsed.minScore = parseIntegerOption(arg, "--min-score");
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

    if (arg.startsWith("--top-limit=")) {
      parsed.topLimit = parseIntegerOption(arg, "--top-limit");
      continue;
    }

    if (arg.startsWith("--market-window-minutes=")) {
      parsed.marketWindowMinutes = parseIntegerOption(arg, "--market-window-minutes");
      continue;
    }

    if (arg.startsWith("--require-terminal-json=")) {
      parsed.requireTerminalJson = parseBooleanOption(arg, "--require-terminal-json");
      continue;
    }

    if (arg.startsWith("--require-db=")) {
      parsed.requireDb = parseBooleanOption(arg, "--require-db");
      continue;
    }

    throw new Error(`Unknown research truth option: ${arg}`);
  }

  return validateResearchTruthingConfig({
    ...defaultResearchTruthingConfig(),
    ...parsed,
    runSources,
  });
}

export function validateResearchTruthingConfig(
  config: ResearchTruthingRuntimeConfig,
): ResearchTruthingRuntimeConfig {
  validateNonEmpty("runSources", config.runSources);
  validateNonEmpty("sourceDecisions", config.sourceDecisions);
  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("stopPcts", config.stopPcts);
  validateNonEmpty("maxHoldMinutes", config.maxHoldMinutes);
  validateScore("minScore", config.minScore);
  validatePositiveInteger("topLimit", config.topLimit);
  validatePositiveInteger("marketWindowMinutes", config.marketWindowMinutes);
  assertUniqueLabels(config.runSources);

  for (const source of config.runSources) {
    validateArchivePath(source);
  }

  for (const targetPct of config.targetPcts) {
    validatePositiveNumber("targetPct", targetPct);
  }

  for (const stopPct of config.stopPcts) {
    validatePositiveNumber("stopPct", stopPct);
  }

  for (const maxHoldMinutes of config.maxHoldMinutes) {
    validatePositiveInteger("maxHoldMinutes", maxHoldMinutes);
  }

  return {
    ...config,
    sourceDecisions: unique(config.sourceDecisions),
    targetPcts: uniqueNumbers(config.targetPcts),
    stopPcts: uniqueNumbers(config.stopPcts),
    maxHoldMinutes: uniqueNumbers(config.maxHoldMinutes).sort((left, right) => left - right),
  };
}

function parseLabelRunOption(arg: string): ResearchTruthingRunSourceConfig {
  const raw = arg.slice("--label-run=".length).trim();
  const separatorIndex = raw.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("Invalid research truth option: --label-run must use <label>:<path>.");
  }

  const label = raw.slice(0, separatorIndex).trim();
  const runPath = raw.slice(separatorIndex + 1).trim();

  if (!label || !runPath) {
    throw new Error("Invalid research truth option: --label-run must use <label>:<path>.");
  }

  return { label, path: runPath };
}

function parseDedupeMode(value: string): ResearchTruthingDedupeMode {
  const normalized = value.trim().toLowerCase();

  if (
    normalized !== "decision" &&
    normalized !== "mint" &&
    normalized !== "first_per_mint" &&
    normalized !== "best_per_mint"
  ) {
    throw new Error(
      "Invalid research truth option: --dedupe-mode must be decision, mint, first_per_mint, or best_per_mint.",
    );
  }

  return normalized;
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research truth option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid research truth option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
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
    throw new Error(`Invalid research truth option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseBooleanOption(arg: string, name: string): boolean {
  const raw = arg.slice(`${name}=`.length).trim().toLowerCase();

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`Invalid research truth option: ${name} must be true or false.`);
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research truth option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(
        `Invalid research truth option: ${name} must be a comma-separated number list.`,
      );
    }

    return parsed;
  });
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid research truth option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(
        `Invalid research truth option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function validateArchivePath(source: ResearchTruthingRunSourceConfig): void {
  const resolvedPath = path.isAbsolute(source.path)
    ? path.resolve(source.path)
    : path.resolve(getRepoRoot(), source.path);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Invalid research truth option: archive path not found for ${source.label}.`);
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(
      `Invalid research truth option: archive path must be a directory for ${source.label}.`,
    );
  }
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid research truth option: ${name} must not be empty.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid research truth option: ${name} must be a positive integer.`);
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid research truth option: ${name} must be a positive number.`);
  }
}

function validateScore(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Invalid research truth option: ${name} must be an integer between 0 and 100.`);
  }
}

function assertUniqueLabels(sources: readonly ResearchTruthingRunSourceConfig[]): void {
  const seen = new Set<string>();

  for (const source of sources) {
    if (seen.has(source.label)) {
      throw new Error(`Invalid research truth option: duplicate run label ${source.label}.`);
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
