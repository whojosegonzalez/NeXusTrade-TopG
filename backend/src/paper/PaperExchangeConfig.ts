import { LAMPORTS_PER_SOL, parseSolToLamports } from "./PaperMath.js";

export const PAPER_EXCHANGE_DEFAULTS = {
  buySolLamports: 10_000_000,
  limit: 10,
  baseFeeLamports: 5_000,
  priorityFeeLamports: 0,
  slippageBps: 100,
  quoteSource: "TOKEN_RADAR_PRICE",
} as const;

export const PAPER_EXCHANGE_BOUNDS = {
  buySolLamports: {
    min: 1,
    max: 100 * LAMPORTS_PER_SOL,
  },
  limit: {
    min: 1,
    max: 250,
  },
  feeLamports: {
    min: 0,
    max: 10_000_000,
  },
  slippageBps: {
    min: 0,
    max: 10_000,
  },
} as const;

export interface PaperExchangeRuntimeConfig {
  readonly buySolLamports: number;
  readonly limit: number;
  readonly baseFeeLamports: number;
  readonly priorityFeeLamports: number;
  readonly slippageBps: number;
  readonly quoteSource: string;
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
}

type MutablePaperExchangeConfigDraft = {
  -readonly [Key in keyof PaperExchangeRuntimeConfig]?: PaperExchangeRuntimeConfig[Key];
};

export function defaultPaperExchangeConfig(): PaperExchangeRuntimeConfig {
  return {
    buySolLamports: PAPER_EXCHANGE_DEFAULTS.buySolLamports,
    limit: PAPER_EXCHANGE_DEFAULTS.limit,
    baseFeeLamports: PAPER_EXCHANGE_DEFAULTS.baseFeeLamports,
    priorityFeeLamports: PAPER_EXCHANGE_DEFAULTS.priorityFeeLamports,
    slippageBps: PAPER_EXCHANGE_DEFAULTS.slippageBps,
    quoteSource: PAPER_EXCHANGE_DEFAULTS.quoteSource,
    once: false,
    dryRun: false,
  };
}

export function parsePaperExchangeArgs(argv: readonly string[]): PaperExchangeRuntimeConfig {
  const parsed: MutablePaperExchangeConfigDraft = {};

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
        throw new Error("Invalid paper exchange option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--buy-sol=")) {
      parsed.buySolLamports = parseSolToLamports(arg.slice("--buy-sol=".length));
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = parseIntegerOption(arg, "--limit");
      continue;
    }

    throw new Error(`Unknown paper exchange option: ${arg}`);
  }

  return validatePaperExchangeConfig({
    ...defaultPaperExchangeConfig(),
    ...parsed,
  });
}

export function validatePaperExchangeConfig(
  config: PaperExchangeRuntimeConfig,
): PaperExchangeRuntimeConfig {
  validateIntegerRange(
    "buySolLamports",
    config.buySolLamports,
    PAPER_EXCHANGE_BOUNDS.buySolLamports,
  );
  validateIntegerRange("limit", config.limit, PAPER_EXCHANGE_BOUNDS.limit);
  validateIntegerRange(
    "baseFeeLamports",
    config.baseFeeLamports,
    PAPER_EXCHANGE_BOUNDS.feeLamports,
  );
  validateIntegerRange(
    "priorityFeeLamports",
    config.priorityFeeLamports,
    PAPER_EXCHANGE_BOUNDS.feeLamports,
  );
  validateIntegerRange("slippageBps", config.slippageBps, PAPER_EXCHANGE_BOUNDS.slippageBps);

  if (config.quoteSource.trim() === "") {
    throw new Error("Invalid paper exchange option: quoteSource must not be empty.");
  }

  return {
    ...config,
    quoteSource: config.quoteSource.trim(),
  };
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid paper exchange option: ${name} must be an integer.`);
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
      `Invalid paper exchange option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
