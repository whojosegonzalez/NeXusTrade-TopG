import { tokenRadarStatusValues, type TokenRadarStatus } from "../db/schema/index.js";

export const STRATEGY_DEFAULTS = {
  status: "WATCHING",
  riskPolicy: "PASS_OR_ELIGIBLE_WARN",
  sinceHours: 24,
  limit: 50,
  maxBuyDecisions: 5,
  minLiquidityUsd: 10_000,
  minVolume1hUsd: 10_000,
  maxPriceImpactPct: 5,
  minPairAgeMinutes: 30,
  buyScoreThreshold: 90,
  watchScoreThreshold: 70,
  strategyName: "phase6_first_pass",
} as const;

export const STRATEGY_BOUNDS = {
  sinceHours: {
    min: 1,
    max: 168,
  },
  limit: {
    min: 1,
    max: 250,
  },
  maxBuyDecisions: {
    min: 1,
    max: 25,
  },
  minPairAgeMinutes: {
    min: 0,
    max: 60 * 24 * 30,
  },
  maxPriceImpactPct: {
    min: 0,
    max: 100,
  },
  minUsd: {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  scoreThreshold: {
    min: 0,
    max: 100,
  },
} as const;

export const STRATEGY_EVALUATABLE_STATUSES = ["WATCHING", "DISCOVERED"] as const;

export type StrategyEvaluatableStatus = (typeof STRATEGY_EVALUATABLE_STATUSES)[number];
export type StrategyRiskPolicy = "PASS_OR_ELIGIBLE_WARN";

export interface StrategyRuntimeConfig {
  readonly status: StrategyEvaluatableStatus;
  readonly riskPolicy: StrategyRiskPolicy;
  readonly sinceHours: number;
  readonly limit: number;
  readonly maxBuyDecisions: number;
  readonly minLiquidityUsd: number;
  readonly minVolume1hUsd: number;
  readonly maxPriceImpactPct: number;
  readonly minPairAgeMinutes: number;
  readonly buyScoreThreshold: number;
  readonly watchScoreThreshold: number;
  readonly strategyName: string;
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
}

type MutableStrategyConfigDraft = {
  -readonly [Key in keyof StrategyRuntimeConfig]?: StrategyRuntimeConfig[Key];
};

export function defaultStrategyConfig(): StrategyRuntimeConfig {
  return {
    status: STRATEGY_DEFAULTS.status,
    riskPolicy: STRATEGY_DEFAULTS.riskPolicy,
    sinceHours: STRATEGY_DEFAULTS.sinceHours,
    limit: STRATEGY_DEFAULTS.limit,
    maxBuyDecisions: STRATEGY_DEFAULTS.maxBuyDecisions,
    minLiquidityUsd: STRATEGY_DEFAULTS.minLiquidityUsd,
    minVolume1hUsd: STRATEGY_DEFAULTS.minVolume1hUsd,
    maxPriceImpactPct: STRATEGY_DEFAULTS.maxPriceImpactPct,
    minPairAgeMinutes: STRATEGY_DEFAULTS.minPairAgeMinutes,
    buyScoreThreshold: STRATEGY_DEFAULTS.buyScoreThreshold,
    watchScoreThreshold: STRATEGY_DEFAULTS.watchScoreThreshold,
    strategyName: STRATEGY_DEFAULTS.strategyName,
    once: false,
    dryRun: false,
  };
}

export function parseStrategyArgs(argv: readonly string[]): StrategyRuntimeConfig {
  const parsed: MutableStrategyConfigDraft = {};

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid strategy option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--status=")) {
      parsed.status = parseStatus(arg.slice("--status=".length));
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

    if (arg.startsWith("--max-buy-decisions=")) {
      parsed.maxBuyDecisions = parseIntegerOption(arg, "--max-buy-decisions");
      continue;
    }

    if (arg.startsWith("--strategy-name=")) {
      parsed.strategyName = arg.slice("--strategy-name=".length).trim();
      continue;
    }

    if (arg.startsWith("--min-liquidity-usd=")) {
      parsed.minLiquidityUsd = parseNumberOption(arg, "--min-liquidity-usd");
      continue;
    }

    if (arg.startsWith("--min-volume-1h-usd=")) {
      parsed.minVolume1hUsd = parseNumberOption(arg, "--min-volume-1h-usd");
      continue;
    }

    if (arg.startsWith("--max-price-impact-pct=")) {
      parsed.maxPriceImpactPct = parseNumberOption(arg, "--max-price-impact-pct");
      continue;
    }

    if (arg.startsWith("--min-pair-age-minutes=")) {
      parsed.minPairAgeMinutes = parseIntegerOption(arg, "--min-pair-age-minutes");
      continue;
    }

    if (arg.startsWith("--buy-score-threshold=")) {
      parsed.buyScoreThreshold = parseIntegerOption(arg, "--buy-score-threshold");
      continue;
    }

    if (arg.startsWith("--watch-score-threshold=")) {
      parsed.watchScoreThreshold = parseIntegerOption(arg, "--watch-score-threshold");
      continue;
    }

    throw new Error(`Unknown strategy option: ${arg}`);
  }

  return validateStrategyConfig({
    ...defaultStrategyConfig(),
    ...parsed,
  });
}

export function validateStrategyConfig(config: StrategyRuntimeConfig): StrategyRuntimeConfig {
  validateIntegerRange("sinceHours", config.sinceHours, STRATEGY_BOUNDS.sinceHours);
  validateIntegerRange("limit", config.limit, STRATEGY_BOUNDS.limit);
  validateIntegerRange("maxBuyDecisions", config.maxBuyDecisions, STRATEGY_BOUNDS.maxBuyDecisions);
  validateIntegerRange(
    "minPairAgeMinutes",
    config.minPairAgeMinutes,
    STRATEGY_BOUNDS.minPairAgeMinutes,
  );
  validateNumberRange(
    "maxPriceImpactPct",
    config.maxPriceImpactPct,
    STRATEGY_BOUNDS.maxPriceImpactPct,
  );
  validateNumberRange("minLiquidityUsd", config.minLiquidityUsd, STRATEGY_BOUNDS.minUsd);
  validateNumberRange("minVolume1hUsd", config.minVolume1hUsd, STRATEGY_BOUNDS.minUsd);
  validateIntegerRange(
    "buyScoreThreshold",
    config.buyScoreThreshold,
    STRATEGY_BOUNDS.scoreThreshold,
  );
  validateIntegerRange(
    "watchScoreThreshold",
    config.watchScoreThreshold,
    STRATEGY_BOUNDS.scoreThreshold,
  );

  if (config.buyScoreThreshold < config.watchScoreThreshold) {
    throw new Error(
      "Invalid strategy option: buyScoreThreshold must be greater than or equal to watchScoreThreshold.",
    );
  }

  if (!isStrategyEvaluatableStatus(config.status)) {
    throw new Error(
      `Invalid strategy option: status must be one of ${STRATEGY_EVALUATABLE_STATUSES.join(", ")}.`,
    );
  }

  if (config.strategyName.trim() === "") {
    throw new Error("Invalid strategy option: strategyName must not be empty.");
  }

  return {
    ...config,
    strategyName: config.strategyName.trim(),
  };
}

function parseStatus(raw: string): StrategyEvaluatableStatus {
  const status = raw.trim();

  if (!isTokenRadarStatus(status)) {
    throw new Error(
      `Invalid strategy option: status must be a valid TokenRadar status (${tokenRadarStatusValues.join(
        ", ",
      )}).`,
    );
  }

  if (!isStrategyEvaluatableStatus(status)) {
    throw new Error(
      `Invalid strategy option: status must be one of ${STRATEGY_EVALUATABLE_STATUSES.join(
        ", ",
      )} for Phase 6.`,
    );
  }

  return status;
}

function isTokenRadarStatus(status: string): status is TokenRadarStatus {
  return tokenRadarStatusValues.includes(status as TokenRadarStatus);
}

function isStrategyEvaluatableStatus(status: string): status is StrategyEvaluatableStatus {
  return STRATEGY_EVALUATABLE_STATUSES.includes(status as StrategyEvaluatableStatus);
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid strategy option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseNumberOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || raw.trim() === "") {
    throw new Error(`Invalid strategy option: ${name} must be a number.`);
  }

  return parsed;
}

function validateIntegerRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid strategy option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
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
      `Invalid strategy option: ${name} must be a number between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
