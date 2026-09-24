import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";

export const SHADOW_DEFAULTS = {
  sinceHours: 24,
  limit: 250,
  sourceDecisions: ["BUY"] as readonly StrategyDecision[],
  includeShadowScores: false,
  shadowScoreMin: 55,
  horizonsMinutes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 45, 60],
  maxLateMinutes: 120,
  targetPcts: [10, 15, 25],
  stopPcts: [10, 15, 25],
  maxHoldMinutes: 60,
  maxHoldScenariosMinutes: [15, 30, 60, 120],
  startingBalanceSol: 1,
  positionSizeSol: 0.01,
  sessionGoalPct: 25,
  maxPositions: 5,
} as const;

export const SHADOW_BOUNDS = {
  sinceHours: {
    min: 1,
    max: 168,
  },
  limit: {
    min: 1,
    max: 1_000,
  },
  score: {
    min: 0,
    max: 100,
  },
  minutes: {
    min: 1,
    max: 60 * 24,
  },
  percent: {
    min: Number.MIN_VALUE,
    max: 10_000,
  },
  sol: {
    min: Number.MIN_VALUE,
    max: 1_000_000,
  },
  maxPositions: {
    min: 1,
    max: 1_000,
  },
} as const;

export interface ShadowRuntimeConfig {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly sinceHours: number;
  readonly limit: number;
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly includeShadowScores: boolean;
  readonly shadowScoreMin: number;
  readonly horizonsMinutes: readonly number[];
  readonly maxLateMinutes: number;
  readonly targetPcts: readonly number[];
  readonly stopPcts: readonly number[];
  readonly maxHoldMinutes: number;
  readonly maxHoldScenariosMinutes: readonly number[];
  readonly startingBalanceSol: number;
  readonly positionSizeSol: number;
  readonly sessionGoalPct: number;
  readonly maxPositions: number;
  readonly sessionId?: string;
}

type MutableShadowConfigDraft = {
  -readonly [Key in keyof ShadowRuntimeConfig]?: ShadowRuntimeConfig[Key];
};

export function defaultShadowConfig(): ShadowRuntimeConfig {
  return {
    once: false,
    dryRun: false,
    json: false,
    sinceHours: SHADOW_DEFAULTS.sinceHours,
    limit: SHADOW_DEFAULTS.limit,
    sourceDecisions: SHADOW_DEFAULTS.sourceDecisions,
    includeShadowScores: SHADOW_DEFAULTS.includeShadowScores,
    shadowScoreMin: SHADOW_DEFAULTS.shadowScoreMin,
    horizonsMinutes: SHADOW_DEFAULTS.horizonsMinutes,
    maxLateMinutes: SHADOW_DEFAULTS.maxLateMinutes,
    targetPcts: SHADOW_DEFAULTS.targetPcts,
    stopPcts: SHADOW_DEFAULTS.stopPcts,
    maxHoldMinutes: SHADOW_DEFAULTS.maxHoldMinutes,
    maxHoldScenariosMinutes: SHADOW_DEFAULTS.maxHoldScenariosMinutes,
    startingBalanceSol: SHADOW_DEFAULTS.startingBalanceSol,
    positionSizeSol: SHADOW_DEFAULTS.positionSizeSol,
    sessionGoalPct: SHADOW_DEFAULTS.sessionGoalPct,
    maxPositions: SHADOW_DEFAULTS.maxPositions,
  };
}

export function parseShadowArgs(argv: readonly string[]): ShadowRuntimeConfig {
  const parsed: MutableShadowConfigDraft = {};

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--include-shadow-scores") {
      parsed.includeShadowScores = true;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid shadow option: --session-id must not be empty.");
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

    if (arg.startsWith("--source-decisions=")) {
      parsed.sourceDecisions = parseDecisionListOption(arg, "--source-decisions");
      continue;
    }

    if (arg.startsWith("--shadow-score-min=")) {
      parsed.shadowScoreMin = parseIntegerOption(arg, "--shadow-score-min");
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

    if (arg.startsWith("--interval-minutes=")) {
      const intervalMinutes = parseIntegerOption(arg, "--interval-minutes");
      parsed.horizonsMinutes = buildIntervalHorizons(intervalMinutes, parsed.maxHoldMinutes);
      continue;
    }

    if (arg.startsWith("--max-late-minutes=")) {
      parsed.maxLateMinutes = parseIntegerOption(arg, "--max-late-minutes");
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
      parsed.maxHoldMinutes = parseIntegerOption(arg, "--max-hold-minutes");
      continue;
    }

    if (arg.startsWith("--max-hold-scenarios-minutes=")) {
      parsed.maxHoldScenariosMinutes = parseIntegerListOption(arg, "--max-hold-scenarios-minutes");
      continue;
    }

    if (arg.startsWith("--starting-balance-sol=")) {
      parsed.startingBalanceSol = parseNumberOption(arg, "--starting-balance-sol");
      continue;
    }

    if (arg.startsWith("--position-size-sol=")) {
      parsed.positionSizeSol = parseNumberOption(arg, "--position-size-sol");
      continue;
    }

    if (arg.startsWith("--session-goal-pct=")) {
      parsed.sessionGoalPct = parseNumberOption(arg, "--session-goal-pct");
      continue;
    }

    if (arg.startsWith("--max-positions=")) {
      parsed.maxPositions = parseIntegerOption(arg, "--max-positions");
      continue;
    }

    throw new Error(`Unknown shadow option: ${arg}`);
  }

  return validateShadowConfig({
    ...defaultShadowConfig(),
    ...parsed,
  });
}

export function validateShadowConfig(config: ShadowRuntimeConfig): ShadowRuntimeConfig {
  validateIntegerRange("sinceHours", config.sinceHours, SHADOW_BOUNDS.sinceHours);
  validateIntegerRange("limit", config.limit, SHADOW_BOUNDS.limit);
  validateIntegerRange("shadowScoreMin", config.shadowScoreMin, SHADOW_BOUNDS.score);
  validateIntegerRange("maxLateMinutes", config.maxLateMinutes, SHADOW_BOUNDS.minutes);
  validateIntegerRange("maxHoldMinutes", config.maxHoldMinutes, SHADOW_BOUNDS.minutes);
  validateIntegerRange("maxPositions", config.maxPositions, SHADOW_BOUNDS.maxPositions);
  validateNumberRange("startingBalanceSol", config.startingBalanceSol, SHADOW_BOUNDS.sol);
  validateNumberRange("positionSizeSol", config.positionSizeSol, SHADOW_BOUNDS.sol);
  validateNumberRange("sessionGoalPct", config.sessionGoalPct, SHADOW_BOUNDS.percent);

  if (config.positionSizeSol > config.startingBalanceSol) {
    throw new Error(
      "Invalid shadow option: positionSizeSol must be less than or equal to startingBalanceSol.",
    );
  }

  validateNonEmpty("sourceDecisions", config.sourceDecisions);
  validateNonEmpty("horizonsMinutes", config.horizonsMinutes);
  validateNonEmpty("targetPcts", config.targetPcts);
  validateNonEmpty("stopPcts", config.stopPcts);
  validateNonEmpty("maxHoldScenariosMinutes", config.maxHoldScenariosMinutes);

  for (const horizon of config.horizonsMinutes) {
    validateIntegerRange("horizonMinutes", horizon, SHADOW_BOUNDS.minutes);
  }

  for (const targetPct of config.targetPcts) {
    validateNumberRange("targetPct", targetPct, SHADOW_BOUNDS.percent);
  }

  for (const stopPct of config.stopPcts) {
    validateNumberRange("stopPct", stopPct, SHADOW_BOUNDS.percent);
  }

  for (const maxHold of config.maxHoldScenariosMinutes) {
    validateIntegerRange("maxHoldScenarioMinutes", maxHold, SHADOW_BOUNDS.minutes);
  }

  return {
    ...config,
    sourceDecisions: [...new Set(config.sourceDecisions)],
    horizonsMinutes: uniqueNumbers(config.horizonsMinutes).sort((left, right) => left - right),
    targetPcts: uniqueNumbers(config.targetPcts),
    stopPcts: uniqueNumbers(config.stopPcts),
    maxHoldScenariosMinutes: uniqueNumbers(config.maxHoldScenariosMinutes).sort(
      (left, right) => left - right,
    ),
  };
}

export function resolveShadowSourceDecisions(
  config: ShadowRuntimeConfig,
): readonly StrategyDecision[] {
  if (
    config.includeShadowScores &&
    config.sourceDecisions.length === SHADOW_DEFAULTS.sourceDecisions.length &&
    config.sourceDecisions.every((decision) => SHADOW_DEFAULTS.sourceDecisions.includes(decision))
  ) {
    return ["BUY", "WATCH", "SKIP"];
  }

  return config.sourceDecisions;
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid shadow option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length).trim();
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || raw === "") {
    throw new Error(`Invalid shadow option: ${name} must be a finite number.`);
  }

  return parsed;
}

function parseNumberListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed) || trimmed === "") {
      throw new Error(`Invalid shadow option: ${name} must be a comma-separated number list.`);
    }

    return parsed;
  });
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const trimmed = value.trim();
    const parsed = Number.parseInt(trimmed, 10);

    if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
      throw new Error(`Invalid shadow option: ${name} must be a comma-separated integer list.`);
    }

    return parsed;
  });
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid shadow option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid shadow option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
          ", ",
        )}).`,
      );
    }

    return decision as StrategyDecision;
  });
}

function buildIntervalHorizons(
  intervalMinutes: number,
  maxHoldMinutes: number | undefined,
): number[] {
  const maxHold = maxHoldMinutes ?? SHADOW_DEFAULTS.maxHoldMinutes;

  validateIntegerRange("intervalMinutes", intervalMinutes, SHADOW_BOUNDS.minutes);
  validateIntegerRange("maxHoldMinutes", maxHold, SHADOW_BOUNDS.minutes);

  const horizons: number[] = [];

  for (let horizon = intervalMinutes; horizon <= maxHold; horizon += intervalMinutes) {
    horizons.push(horizon);
  }

  return horizons;
}

function validateIntegerRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid shadow option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
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
      `Invalid shadow option: ${name} must be a number between ${bounds.min} and ${bounds.max}.`,
    );
  }
}

function validateNonEmpty(name: string, value: readonly unknown[]): void {
  if (value.length === 0) {
    throw new Error(`Invalid shadow option: ${name} must not be empty.`);
  }
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}
