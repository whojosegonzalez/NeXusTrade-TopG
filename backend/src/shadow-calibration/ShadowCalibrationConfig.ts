import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";

export type ShadowCalibrationDedupeMode =
  | "decision"
  | "mint_best_entry"
  | "mint_first_entry"
  | "mint_latest_entry";

export interface ShadowCalibrationDbSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface ShadowCalibrationRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: readonly number[];
  readonly confirmationHorizonsMinutes: readonly number[];
  readonly confirmationMinReturnPcts: readonly number[];
  readonly confirmationMaxDrawdownPcts: readonly number[];
  readonly scoreBucketSize: number;
  readonly minScore: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly dedupeMode: ShadowCalibrationDedupeMode;
  readonly portfolioStartingSol: number;
  readonly portfolioPositionSizeSol: number;
  readonly portfolioGoalPct: number;
  readonly portfolioMaxPositions: number;
  readonly dbSources: readonly ShadowCalibrationDbSourceConfig[];
  readonly sessionId?: string;
}

type MutableShadowCalibrationConfigDraft = {
  -readonly [Key in keyof ShadowCalibrationRuntimeConfig]?: ShadowCalibrationRuntimeConfig[Key];
};

const DEFAULTS = {
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: [15, 30, 60],
  confirmationHorizonsMinutes: [1, 2, 3],
  confirmationMinReturnPcts: [0, 2, 5],
  confirmationMaxDrawdownPcts: [5, 10],
  scoreBucketSize: 5,
  minScore: 50,
  sourceDecisions: ["BUY", "WATCH", "SKIP"] as readonly StrategyDecision[],
  dedupeMode: "decision" as const,
  portfolioStartingSol: 1,
  portfolioPositionSizeSol: 0.01,
  portfolioGoalPct: 25,
  portfolioMaxPositions: 5,
} as const;

export function defaultShadowCalibrationConfig(): ShadowCalibrationRuntimeConfig {
  return {
    once: false,
    json: false,
    targetPcts: DEFAULTS.targetPcts,
    stopPcts: DEFAULTS.stopPcts,
    maxHoldMinutes: DEFAULTS.maxHoldMinutes,
    confirmationHorizonsMinutes: DEFAULTS.confirmationHorizonsMinutes,
    confirmationMinReturnPcts: DEFAULTS.confirmationMinReturnPcts,
    confirmationMaxDrawdownPcts: DEFAULTS.confirmationMaxDrawdownPcts,
    scoreBucketSize: DEFAULTS.scoreBucketSize,
    minScore: DEFAULTS.minScore,
    sourceDecisions: DEFAULTS.sourceDecisions,
    dedupeMode: DEFAULTS.dedupeMode,
    portfolioStartingSol: DEFAULTS.portfolioStartingSol,
    portfolioPositionSizeSol: DEFAULTS.portfolioPositionSizeSol,
    portfolioGoalPct: DEFAULTS.portfolioGoalPct,
    portfolioMaxPositions: DEFAULTS.portfolioMaxPositions,
    dbSources: [],
  };
}

export function parseShadowCalibrationArgs(
  argv: readonly string[],
): ShadowCalibrationRuntimeConfig {
  const parsed: MutableShadowCalibrationConfigDraft = {};
  const dbSources: ShadowCalibrationDbSourceConfig[] = [];

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg.startsWith("--label-db=")) {
      dbSources.push(parseLabelDbOption(arg));
      continue;
    }

    if (arg.startsWith("--db=")) {
      const dbPath = arg.slice("--db=".length).trim();

      if (!dbPath) {
        throw new Error("Invalid shadow calibration option: --db must not be empty.");
      }

      dbSources.push({
        label: `db${dbSources.length + 1}`,
        path: dbPath,
      });
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid shadow calibration option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
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

    if (arg.startsWith("--confirmation-horizons=")) {
      parsed.confirmationHorizonsMinutes = parseIntegerListOption(arg, "--confirmation-horizons");
      continue;
    }

    if (arg.startsWith("--confirmation-min-return-pcts=")) {
      parsed.confirmationMinReturnPcts = parseNumberListOption(
        arg,
        "--confirmation-min-return-pcts",
      );
      continue;
    }

    if (arg.startsWith("--confirmation-max-drawdown-pcts=")) {
      parsed.confirmationMaxDrawdownPcts = parseNumberListOption(
        arg,
        "--confirmation-max-drawdown-pcts",
      );
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

    if (arg.startsWith("--dedupe-mode=")) {
      parsed.dedupeMode = parseDedupeModeOption(arg);
      continue;
    }

    if (arg.startsWith("--portfolio-starting-sol=")) {
      parsed.portfolioStartingSol = parseNumberOption(arg, "--portfolio-starting-sol");
      continue;
    }

    if (arg.startsWith("--portfolio-position-size-sol=")) {
      parsed.portfolioPositionSizeSol = parseNumberOption(arg, "--portfolio-position-size-sol");
      continue;
    }

    if (arg.startsWith("--portfolio-goal-pct=")) {
      parsed.portfolioGoalPct = parseNumberOption(arg, "--portfolio-goal-pct");
      continue;
    }

    if (arg.startsWith("--portfolio-max-positions=")) {
      parsed.portfolioMaxPositions = parseIntegerOption(arg, "--portfolio-max-positions");
      continue;
    }

    throw new Error(`Unknown shadow calibration option: ${arg}`);
  }

  return validateShadowCalibrationConfig({
    ...defaultShadowCalibrationConfig(),
    ...parsed,
    dbSources,
  });
}

export function validateShadowCalibrationConfig(
  config: ShadowCalibrationRuntimeConfig,
): ShadowCalibrationRuntimeConfig {
  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("stopPcts", config.stopPcts);
  validateNonEmpty("maxHoldMinutes", config.maxHoldMinutes);
  validateNonEmpty("confirmationHorizonsMinutes", config.confirmationHorizonsMinutes);
  validateNonEmpty("confirmationMinReturnPcts", config.confirmationMinReturnPcts);
  validateNonEmpty("confirmationMaxDrawdownPcts", config.confirmationMaxDrawdownPcts);
  validateNonEmpty("sourceDecisions", config.sourceDecisions);

  for (const value of config.targetPcts) {
    validatePositiveNumber("targetPct", value);
  }

  for (const value of config.stopPcts) {
    validatePositiveNumber("stopPct", value);
  }

  for (const value of config.maxHoldMinutes) {
    validatePositiveInteger("maxHoldMinutes", value);
  }

  for (const value of config.confirmationHorizonsMinutes) {
    validatePositiveInteger("confirmationHorizonMinutes", value);
  }

  for (const value of config.confirmationMinReturnPcts) {
    validateFiniteNumber("confirmationMinReturnPct", value);
  }

  for (const value of config.confirmationMaxDrawdownPcts) {
    validatePositiveNumber("confirmationMaxDrawdownPct", value);
  }

  validatePositiveInteger("scoreBucketSize", config.scoreBucketSize);
  validateScore("minScore", config.minScore);
  validatePositiveNumber("portfolioStartingSol", config.portfolioStartingSol);
  validatePositiveNumber("portfolioPositionSizeSol", config.portfolioPositionSizeSol);
  validatePositiveNumber("portfolioGoalPct", config.portfolioGoalPct);
  validatePositiveInteger("portfolioMaxPositions", config.portfolioMaxPositions);

  if (config.portfolioPositionSizeSol > config.portfolioStartingSol) {
    throw new Error(
      "Invalid shadow calibration option: portfolioPositionSizeSol must not exceed portfolioStartingSol.",
    );
  }

  assertUniqueLabels(config.dbSources);

  return {
    ...config,
    targetPcts: uniqueNumbers(config.targetPcts),
    stopPcts: uniqueNumbers(config.stopPcts),
    maxHoldMinutes: uniqueNumbers(config.maxHoldMinutes).sort((left, right) => left - right),
    confirmationHorizonsMinutes: uniqueNumbers(config.confirmationHorizonsMinutes).sort(
      (left, right) => left - right,
    ),
    confirmationMinReturnPcts: uniqueNumbers(config.confirmationMinReturnPcts).sort(
      (left, right) => left - right,
    ),
    confirmationMaxDrawdownPcts: uniqueNumbers(config.confirmationMaxDrawdownPcts).sort(
      (left, right) => left - right,
    ),
    sourceDecisions: [...new Set(config.sourceDecisions)],
  };
}

function parseLabelDbOption(arg: string): ShadowCalibrationDbSourceConfig {
  const raw = arg.slice("--label-db=".length).trim();
  const separatorIndex = raw.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("Invalid shadow calibration option: --label-db must use <label>:<path>.");
  }

  const label = raw.slice(0, separatorIndex).trim();
  const dbPath = raw.slice(separatorIndex + 1).trim();

  if (!label || !dbPath) {
    throw new Error("Invalid shadow calibration option: --label-db must use <label>:<path>.");
  }

  return {
    label,
    path: dbPath,
  };
}

function parseDedupeModeOption(arg: string): ShadowCalibrationDedupeMode {
  const value = arg.slice("--dedupe-mode=".length).trim();

  if (
    value !== "decision" &&
    value !== "mint_best_entry" &&
    value !== "mint_first_entry" &&
    value !== "mint_latest_entry"
  ) {
    throw new Error(
      "Invalid shadow calibration option: --dedupe-mode must be decision, mint_best_entry, mint_first_entry, or mint_latest_entry.",
    );
  }

  return value;
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow calibration option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid shadow calibration option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
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
    throw new Error(`Invalid shadow calibration option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length).trim();
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || raw === "") {
    throw new Error(`Invalid shadow calibration option: ${name} must be a finite number.`);
  }

  return parsed;
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow calibration option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(
        `Invalid shadow calibration option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow calibration option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(
        `Invalid shadow calibration option: ${name} must be a comma-separated number list.`,
      );
    }

    return parsed;
  });
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid shadow calibration option: ${name} must be a positive integer.`);
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid shadow calibration option: ${name} must be a positive number.`);
  }
}

function validateFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid shadow calibration option: ${name} must be a finite number.`);
  }
}

function validateScore(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Invalid shadow calibration option: ${name} must be an integer from 0 to 100.`);
  }
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid shadow calibration option: ${name} must not be empty.`);
  }
}

function assertUniqueLabels(sources: readonly ShadowCalibrationDbSourceConfig[]): void {
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source.label.trim()) {
      throw new Error("Invalid shadow calibration option: database labels must not be empty.");
    }

    if (!source.path.trim()) {
      throw new Error("Invalid shadow calibration option: database paths must not be empty.");
    }

    if (seen.has(source.label)) {
      throw new Error(
        `Invalid shadow calibration option: duplicate database label ${source.label}.`,
      );
    }

    seen.add(source.label);
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}
