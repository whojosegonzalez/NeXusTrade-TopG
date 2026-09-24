import { strategyDecisionValues, type StrategyDecision } from "../db/schema/index.js";

export const WATCHLIST_RETURN_DEFAULTS = {
  sinceHours: 24,
  limit: 250,
  horizonsMinutes: [3, 5, 15, 30, 60, 120, 240, 360, 480, 720],
  sourceDecisions: ["WATCH", "SKIP", "BUY"] as readonly StrategyDecision[],
  minScore: 50,
  maxLateMinutes: 120,
} as const;

export const WATCHLIST_RETURN_BOUNDS = {
  sinceHours: {
    min: 1,
    max: 168,
  },
  limit: {
    min: 1,
    max: 1_000,
  },
  horizonMinutes: {
    min: 1,
    max: 60 * 24,
  },
  minScore: {
    min: 0,
    max: 100,
  },
  maxLateMinutes: {
    min: 0,
    max: 60 * 24,
  },
} as const;

export interface WatchlistReturnRuntimeConfig {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly sinceHours: number;
  readonly limit: number;
  readonly horizonsMinutes: readonly number[];
  readonly sourceDecisions: readonly StrategyDecision[];
  readonly minScore: number;
  readonly maxLateMinutes: number;
  readonly sessionId?: string;
}

type MutableWatchlistReturnConfigDraft = {
  -readonly [Key in keyof WatchlistReturnRuntimeConfig]?: WatchlistReturnRuntimeConfig[Key];
};

export function defaultWatchlistReturnConfig(): WatchlistReturnRuntimeConfig {
  return {
    once: false,
    dryRun: false,
    json: false,
    sinceHours: WATCHLIST_RETURN_DEFAULTS.sinceHours,
    limit: WATCHLIST_RETURN_DEFAULTS.limit,
    horizonsMinutes: WATCHLIST_RETURN_DEFAULTS.horizonsMinutes,
    sourceDecisions: WATCHLIST_RETURN_DEFAULTS.sourceDecisions,
    minScore: WATCHLIST_RETURN_DEFAULTS.minScore,
    maxLateMinutes: WATCHLIST_RETURN_DEFAULTS.maxLateMinutes,
  };
}

export function parseWatchlistReturnArgs(argv: readonly string[]): WatchlistReturnRuntimeConfig {
  const parsed: MutableWatchlistReturnConfigDraft = {};

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

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid watchlist return option: --session-id must not be empty.");
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

    if (arg.startsWith("--horizons=")) {
      parsed.horizonsMinutes = parseIntegerListOption(arg, "--horizons");
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

    if (arg.startsWith("--max-late-minutes=")) {
      parsed.maxLateMinutes = parseIntegerOption(arg, "--max-late-minutes");
      continue;
    }

    throw new Error(`Unknown watchlist return option: ${arg}`);
  }

  return validateWatchlistReturnConfig({
    ...defaultWatchlistReturnConfig(),
    ...parsed,
  });
}

export function validateWatchlistReturnConfig(
  config: WatchlistReturnRuntimeConfig,
): WatchlistReturnRuntimeConfig {
  validateIntegerRange("sinceHours", config.sinceHours, WATCHLIST_RETURN_BOUNDS.sinceHours);
  validateIntegerRange("limit", config.limit, WATCHLIST_RETURN_BOUNDS.limit);
  validateIntegerRange("minScore", config.minScore, WATCHLIST_RETURN_BOUNDS.minScore);
  validateIntegerRange(
    "maxLateMinutes",
    config.maxLateMinutes,
    WATCHLIST_RETURN_BOUNDS.maxLateMinutes,
  );

  if (config.horizonsMinutes.length === 0) {
    throw new Error("Invalid watchlist return option: horizons must not be empty.");
  }

  for (const horizon of config.horizonsMinutes) {
    validateIntegerRange("horizonMinutes", horizon, WATCHLIST_RETURN_BOUNDS.horizonMinutes);
  }

  if (config.sourceDecisions.length === 0) {
    throw new Error("Invalid watchlist return option: sourceDecisions must not be empty.");
  }

  return {
    ...config,
    horizonsMinutes: [...new Set(config.horizonsMinutes)].sort((left, right) => left - right),
    sourceDecisions: [...new Set(config.sourceDecisions)],
  };
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid watchlist return option: ${name} must be an integer.`);
  }

  return parsed;
}

function parseIntegerListOption(arg: string, name: string): readonly number[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid watchlist return option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const parsed = Number.parseInt(value.trim(), 10);

    if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
      throw new Error(
        `Invalid watchlist return option: ${name} must be a comma-separated integer list.`,
      );
    }

    return parsed;
  });
}

function parseDecisionListOption(arg: string, name: string): readonly StrategyDecision[] {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!raw) {
    throw new Error(`Invalid watchlist return option: ${name} must not be empty.`);
  }

  return raw.split(",").map((value) => {
    const decision = value.trim();

    if (!strategyDecisionValues.includes(decision as StrategyDecision)) {
      throw new Error(
        `Invalid watchlist return option: ${name} must contain valid StrategyDecision values (${strategyDecisionValues.join(
          ", ",
        )}).`,
      );
    }

    return decision as StrategyDecision;
  });
}

function validateIntegerRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid watchlist return option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
