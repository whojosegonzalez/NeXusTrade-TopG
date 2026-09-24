import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";

export const CALIBRATION_DEFAULTS = {
  sinceHours: 168,
  limit: 500,
  scoreBucketSize: 5,
  minScore: 0,
  targetPcts: [10, 25, 39],
  drawdownPcts: [10, 25, 50],
  horizonsMinutes: [3, 5, 15, 30, 60, 120, 240, 360, 480, 720],
  maxHoldMinutes: 60,
  sourceDecisions: ["BUY", "WATCH", "SKIP"] as readonly StrategyDecision[],
  thresholdScenarios: [
    { buyScoreThreshold: 90, watchScoreThreshold: 70 },
    { buyScoreThreshold: 75, watchScoreThreshold: 70 },
    { buyScoreThreshold: 75, watchScoreThreshold: 60 },
    { buyScoreThreshold: 65, watchScoreThreshold: 60 },
    { buyScoreThreshold: 55, watchScoreThreshold: 50 },
  ],
} as const;

export const CALIBRATION_BOUNDS = {
  sinceHours: {
    min: 1,
    max: 24 * 365,
  },
  limit: {
    min: 1,
    max: 10_000,
  },
  scoreBucketSize: {
    min: 1,
    max: 25,
  },
  score: {
    min: 0,
    max: 100,
  },
  percent: {
    min: Number.MIN_VALUE,
    max: 10_000,
  },
  horizonMinutes: {
    min: 1,
    max: 60 * 24 * 30,
  },
} as const;

export interface CalibrationDbSourceConfig {
  readonly label: string;
  readonly path: string;
}

export interface CalibrationThresholdScenario {
  readonly buyScoreThreshold: number;
  readonly watchScoreThreshold: number;
}

export interface CalibrationRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly sinceHours: number;
  readonly limit: number;
  readonly scoreBucketSize: number;
  readonly minScore: number;
  readonly targetPcts: readonly number[];
  readonly drawdownPcts: readonly number[];
  readonly horizonsMinutes: readonly number[];
  readonly maxHoldMinutes: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly thresholdScenarios: readonly CalibrationThresholdScenario[];
  readonly dbSources: readonly CalibrationDbSourceConfig[];
  readonly sessionId?: string;
}

type MutableCalibrationConfigDraft = {
  -readonly [Key in keyof CalibrationRuntimeConfig]?: CalibrationRuntimeConfig[Key];
};

export function defaultCalibrationConfig(): CalibrationRuntimeConfig {
  return {
    once: false,
    json: false,
    sinceHours: CALIBRATION_DEFAULTS.sinceHours,
    limit: CALIBRATION_DEFAULTS.limit,
    scoreBucketSize: CALIBRATION_DEFAULTS.scoreBucketSize,
    minScore: CALIBRATION_DEFAULTS.minScore,
    targetPcts: CALIBRATION_DEFAULTS.targetPcts,
    drawdownPcts: CALIBRATION_DEFAULTS.drawdownPcts,
    horizonsMinutes: CALIBRATION_DEFAULTS.horizonsMinutes,
    maxHoldMinutes: CALIBRATION_DEFAULTS.maxHoldMinutes,
    sourceDecisions: CALIBRATION_DEFAULTS.sourceDecisions,
    thresholdScenarios: CALIBRATION_DEFAULTS.thresholdScenarios,
    dbSources: [],
  };
}

export function parseCalibrationArgs(argv: readonly string[]): CalibrationRuntimeConfig {
  const parsed: MutableCalibrationConfigDraft = {};
  const dbSources: CalibrationDbSourceConfig[] = [];

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid calibration option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--since-hours=")) {
      parsed.sinceHours = parseIntegerOption(arg, "--since-hours");
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = parseIntegerOption(arg, "--limit");
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

    if (arg.startsWith("--target-pcts=")) {
      parsed.targetPcts = parseNumberListOption(arg, "--target-pcts");
      continue;
    }

    if (arg.startsWith("--drawdown-pcts=")) {
      parsed.drawdownPcts = parseNumberListOption(arg, "--drawdown-pcts");
      continue;
    }

    if (arg.startsWith("--horizons-minutes=")) {
      parsed.horizonsMinutes = parseIntegerListOption(arg, "--horizons-minutes");
      continue;
    }

    if (arg.startsWith("--horizons=")) {
      parsed.horizonsMinutes = parseIntegerListOption(arg, "--horizons");
      continue;
    }

    if (arg.startsWith("--max-hold-minutes=")) {
      parsed.maxHoldMinutes = parseIntegerOption(arg, "--max-hold-minutes");
      continue;
    }

    if (arg.startsWith("--source-decisions=")) {
      parsed.sourceDecisions = parseDecisionListOption(arg, "--source-decisions");
      continue;
    }

    if (arg.startsWith("--threshold-scenarios=")) {
      parsed.thresholdScenarios = parseThresholdScenarios(arg);
      continue;
    }

    if (arg.startsWith("--db=")) {
      const dbPath = arg.slice("--db=".length).trim();

      if (!dbPath) {
        throw new Error("Invalid calibration option: --db must not be empty.");
      }

      dbSources.push({
        label: `db${dbSources.length + 1}`,
        path: dbPath,
      });
      continue;
    }

    if (arg.startsWith("--label-db=")) {
      dbSources.push(parseLabelDbOption(arg));
      continue;
    }

    throw new Error(`Unknown calibration option: ${arg}`);
  }

  return validateCalibrationConfig({
    ...defaultCalibrationConfig(),
    ...parsed,
    dbSources,
  });
}

export function validateCalibrationConfig(
  config: CalibrationRuntimeConfig,
): CalibrationRuntimeConfig {
  validateIntegerRange("sinceHours", config.sinceHours, CALIBRATION_BOUNDS.sinceHours);
  validateIntegerRange("limit", config.limit, CALIBRATION_BOUNDS.limit);
  validateIntegerRange(
    "scoreBucketSize",
    config.scoreBucketSize,
    CALIBRATION_BOUNDS.scoreBucketSize,
  );
  validateIntegerRange("minScore", config.minScore, CALIBRATION_BOUNDS.score);
  validateIntegerRange("maxHoldMinutes", config.maxHoldMinutes, CALIBRATION_BOUNDS.horizonMinutes);

  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("drawdownPcts", config.drawdownPcts);
  validateNonEmpty("horizonsMinutes", config.horizonsMinutes);
  validateNonEmpty("sourceDecisions", config.sourceDecisions);
  validateNonEmpty("thresholdScenarios", config.thresholdScenarios);

  for (const targetPct of config.targetPcts) {
    validateNumberRange("targetPct", targetPct, CALIBRATION_BOUNDS.percent);
  }

  for (const drawdownPct of config.drawdownPcts) {
    validateNumberRange("drawdownPct", drawdownPct, CALIBRATION_BOUNDS.percent);
  }

  for (const horizonMinutes of config.horizonsMinutes) {
    validateIntegerRange("horizonMinutes", horizonMinutes, CALIBRATION_BOUNDS.horizonMinutes);
  }

  for (const scenario of config.thresholdScenarios) {
    validateIntegerRange("buyScoreThreshold", scenario.buyScoreThreshold, CALIBRATION_BOUNDS.score);
    validateIntegerRange(
      "watchScoreThreshold",
      scenario.watchScoreThreshold,
      CALIBRATION_BOUNDS.score,
    );

    if (scenario.buyScoreThreshold < scenario.watchScoreThreshold) {
      throw new Error(
        "Invalid calibration option: buyScoreThreshold must be greater than or equal to watchScoreThreshold.",
      );
    }
  }

  assertUniqueLabels(config.dbSources);

  return {
    ...config,
    targetPcts: uniqueNumbers(config.targetPcts),
    drawdownPcts: uniqueNumbers(config.drawdownPcts),
    horizonsMinutes: uniqueNumbers(config.horizonsMinutes).sort((left, right) => left - right),
    sourceDecisions: [...new Set(config.sourceDecisions)],
    thresholdScenarios: uniqueThresholdScenarios(config.thresholdScenarios),
  };
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid calibration option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid calibration option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(`Invalid calibration option: ${name} must be a comma-separated number list.`);
    }

    return parsed;
  });
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid calibration option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(
        `Invalid calibration option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid calibration option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid calibration option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
          ", ",
        )}).`,
      );
    }

    return decision as StrategyDecision;
  });
}

function parseThresholdScenarios(arg: string): readonly CalibrationThresholdScenario[] {
  const raw = arg.slice("--threshold-scenarios=".length).trim();

  if (!raw) {
    throw new Error("Invalid calibration option: --threshold-scenarios must not be empty.");
  }

  return raw.split(",").map((value) => {
    const [buyRaw, watchRaw] = value.split("/");

    if (!buyRaw || !watchRaw) {
      throw new Error(
        "Invalid calibration option: --threshold-scenarios must use BUY/WATCH pairs.",
      );
    }

    const buyScoreThreshold = Number.parseInt(buyRaw.trim(), 10);
    const watchScoreThreshold = Number.parseInt(watchRaw.trim(), 10);

    if (!Number.isInteger(buyScoreThreshold) || !Number.isInteger(watchScoreThreshold)) {
      throw new Error(
        "Invalid calibration option: --threshold-scenarios must use integer BUY/WATCH pairs.",
      );
    }

    return {
      buyScoreThreshold,
      watchScoreThreshold,
    };
  });
}

function parseLabelDbOption(arg: string): CalibrationDbSourceConfig {
  const raw = arg.slice("--label-db=".length).trim();
  const separatorIndex = raw.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("Invalid calibration option: --label-db must use <label>:<path>.");
  }

  const label = raw.slice(0, separatorIndex).trim();
  const dbPath = raw.slice(separatorIndex + 1).trim();

  if (!label || !dbPath) {
    throw new Error("Invalid calibration option: --label-db must use <label>:<path>.");
  }

  return {
    label,
    path: dbPath,
  };
}

function validateIntegerRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid calibration option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}

function validateNumberRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid calibration option: ${name} must be a number between ${bounds.min} and ${bounds.max}.`,
    );
  }
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid calibration option: ${name} must not be empty.`);
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function uniqueThresholdScenarios(
  scenarios: readonly CalibrationThresholdScenario[],
): CalibrationThresholdScenario[] {
  const seen = new Set<string>();
  const unique: CalibrationThresholdScenario[] = [];

  for (const scenario of scenarios) {
    const key = `${scenario.buyScoreThreshold}/${scenario.watchScoreThreshold}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(scenario);
  }

  return unique;
}

function assertUniqueLabels(sources: readonly CalibrationDbSourceConfig[]): void {
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source.label.trim()) {
      throw new Error("Invalid calibration option: database labels must not be empty.");
    }

    if (!source.path.trim()) {
      throw new Error("Invalid calibration option: database paths must not be empty.");
    }

    if (seen.has(source.label)) {
      throw new Error(`Invalid calibration option: duplicate database label ${source.label}.`);
    }

    seen.add(source.label);
  }
}
