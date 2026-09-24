export const ANALYTICS_DEFAULTS = {
  sinceHours: 24,
  limit: 250,
  scoreBucketSize: 5,
  nearMissMinScore: 50,
  providerSinceHours: 24,
  missedOpportunityLimit: 20,
} as const;

export const ANALYTICS_BOUNDS = {
  sinceHours: {
    min: 1,
    max: 168,
  },
  limit: {
    min: 1,
    max: 10_000,
  },
  scoreBucketSize: {
    min: 1,
    max: 100,
  },
  score: {
    min: 0,
    max: 100,
  },
  missedOpportunityLimit: {
    min: 1,
    max: 100,
  },
} as const;

export interface AnalyticsRuntimeConfig {
  readonly once: boolean;
  readonly json: boolean;
  readonly sinceHours: number;
  readonly limit: number;
  readonly scoreBucketSize: number;
  readonly nearMissMinScore: number;
  readonly providerSinceHours: number;
  readonly missedOpportunityLimit: number;
  readonly sessionId?: string;
}

type MutableAnalyticsConfigDraft = {
  -readonly [Key in keyof AnalyticsRuntimeConfig]?: AnalyticsRuntimeConfig[Key];
};

export function defaultAnalyticsConfig(): AnalyticsRuntimeConfig {
  return {
    once: false,
    json: false,
    sinceHours: ANALYTICS_DEFAULTS.sinceHours,
    limit: ANALYTICS_DEFAULTS.limit,
    scoreBucketSize: ANALYTICS_DEFAULTS.scoreBucketSize,
    nearMissMinScore: ANALYTICS_DEFAULTS.nearMissMinScore,
    providerSinceHours: ANALYTICS_DEFAULTS.providerSinceHours,
    missedOpportunityLimit: ANALYTICS_DEFAULTS.missedOpportunityLimit,
  };
}

export function parseAnalyticsArgs(argv: readonly string[]): AnalyticsRuntimeConfig {
  const parsed: MutableAnalyticsConfigDraft = {};

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
        throw new Error("Invalid analytics option: --session-id must not be empty.");
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

    if (arg.startsWith("--near-miss-min-score=")) {
      parsed.nearMissMinScore = parseIntegerOption(arg, "--near-miss-min-score");
      continue;
    }

    if (arg.startsWith("--provider-since-hours=")) {
      parsed.providerSinceHours = parseIntegerOption(arg, "--provider-since-hours");
      continue;
    }

    if (arg.startsWith("--missed-opportunity-limit=")) {
      parsed.missedOpportunityLimit = parseIntegerOption(arg, "--missed-opportunity-limit");
      continue;
    }

    throw new Error(`Unknown analytics option: ${arg}`);
  }

  return validateAnalyticsConfig({
    ...defaultAnalyticsConfig(),
    ...parsed,
  });
}

export function validateAnalyticsConfig(config: AnalyticsRuntimeConfig): AnalyticsRuntimeConfig {
  validateIntegerRange("sinceHours", config.sinceHours, ANALYTICS_BOUNDS.sinceHours);
  validateIntegerRange("limit", config.limit, ANALYTICS_BOUNDS.limit);
  validateIntegerRange("scoreBucketSize", config.scoreBucketSize, ANALYTICS_BOUNDS.scoreBucketSize);
  validateIntegerRange("nearMissMinScore", config.nearMissMinScore, ANALYTICS_BOUNDS.score);
  validateIntegerRange(
    "providerSinceHours",
    config.providerSinceHours,
    ANALYTICS_BOUNDS.sinceHours,
  );
  validateIntegerRange(
    "missedOpportunityLimit",
    config.missedOpportunityLimit,
    ANALYTICS_BOUNDS.missedOpportunityLimit,
  );

  return config;
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid analytics option: ${name} must be an integer.`);
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
      `Invalid analytics option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
