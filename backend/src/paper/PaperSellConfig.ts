import { parseTokenMintAddress, type TokenMintAddress } from "@nexustrade/shared";

export const PAPER_SELL_DEFAULTS = {
  limit: 10,
  baseFeeLamports: 5_000,
  priorityFeeLamports: 0,
  slippageBps: 100,
  allowCachedRadarPrice: false,
  maxCachedPriceAgeMs: 60_000,
  quoteSource: "MarketDataService",
} as const;

export const PAPER_SELL_BOUNDS = {
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
  maxCachedPriceAgeMs: {
    min: 1_000,
    max: 24 * 60 * 60 * 1000,
  },
} as const;

export type PaperSellTrigger =
  | {
      readonly type: "SELL_ALL";
    }
  | {
      readonly type: "MINT";
      readonly mintAddress: TokenMintAddress;
    };

export interface PaperSellExitContext {
  readonly source: "EXIT_MANAGER";
  readonly trigger: "TARGET_REACHED" | "MAX_DRAWDOWN";
  readonly action: "sell-all";
}

export interface PaperSellRuntimeConfig {
  readonly limit: number;
  readonly baseFeeLamports: number;
  readonly priorityFeeLamports: number;
  readonly slippageBps: number;
  readonly allowCachedRadarPrice: boolean;
  readonly maxCachedPriceAgeMs: number;
  readonly quoteSource: string;
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly trigger: PaperSellTrigger;
  readonly sessionId?: string;
  readonly suppressSystemLogs: boolean;
  readonly exitContext?: PaperSellExitContext;
}

type MutablePaperSellConfigDraft = {
  -readonly [Key in keyof PaperSellRuntimeConfig]?: PaperSellRuntimeConfig[Key];
};

export function defaultPaperSellConfig(trigger: PaperSellTrigger): PaperSellRuntimeConfig {
  return {
    limit: PAPER_SELL_DEFAULTS.limit,
    baseFeeLamports: PAPER_SELL_DEFAULTS.baseFeeLamports,
    priorityFeeLamports: PAPER_SELL_DEFAULTS.priorityFeeLamports,
    slippageBps: PAPER_SELL_DEFAULTS.slippageBps,
    allowCachedRadarPrice: PAPER_SELL_DEFAULTS.allowCachedRadarPrice,
    maxCachedPriceAgeMs: PAPER_SELL_DEFAULTS.maxCachedPriceAgeMs,
    quoteSource: PAPER_SELL_DEFAULTS.quoteSource,
    once: false,
    dryRun: false,
    trigger,
    suppressSystemLogs: false,
  };
}

export function parsePaperSellArgs(argv: readonly string[]): PaperSellRuntimeConfig {
  const parsed: MutablePaperSellConfigDraft = {};
  let sellAll = false;
  let mintAddress: TokenMintAddress | undefined;

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--sell-all") {
      sellAll = true;
      continue;
    }

    if (arg === "--allow-cached-radar-price") {
      parsed.allowCachedRadarPrice = true;
      continue;
    }

    if (arg.startsWith("--mint=")) {
      mintAddress = parseTokenMintAddress(arg.slice("--mint=".length));
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid paper sell option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = parseIntegerOption(arg, "--limit");
      continue;
    }

    if (arg.startsWith("--slippage-bps=")) {
      parsed.slippageBps = parseIntegerOption(arg, "--slippage-bps");
      continue;
    }

    if (arg.startsWith("--base-fee-lamports=")) {
      parsed.baseFeeLamports = parseIntegerOption(arg, "--base-fee-lamports");
      continue;
    }

    if (arg.startsWith("--priority-fee-lamports=")) {
      parsed.priorityFeeLamports = parseIntegerOption(arg, "--priority-fee-lamports");
      continue;
    }

    if (arg.startsWith("--max-cached-price-age-ms=")) {
      parsed.maxCachedPriceAgeMs = parseIntegerOption(arg, "--max-cached-price-age-ms");
      continue;
    }

    throw new Error(`Unknown paper sell option: ${arg}`);
  }

  if (sellAll && mintAddress) {
    throw new Error("Invalid paper sell option: use either --sell-all or --mint, not both.");
  }

  if (!sellAll && !mintAddress) {
    throw new Error(
      "Missing explicit sell trigger. Use --sell-all or --mint=<mint>; plain paper:sell --once is intentionally rejected.",
    );
  }

  const trigger: PaperSellTrigger = sellAll
    ? { type: "SELL_ALL" }
    : {
        type: "MINT",
        mintAddress: mintAddress as TokenMintAddress,
      };

  return validatePaperSellConfig({
    ...defaultPaperSellConfig(trigger),
    ...parsed,
    trigger,
  });
}

export function validatePaperSellConfig(config: PaperSellRuntimeConfig): PaperSellRuntimeConfig {
  validateIntegerRange("limit", config.limit, PAPER_SELL_BOUNDS.limit);
  validateIntegerRange("baseFeeLamports", config.baseFeeLamports, PAPER_SELL_BOUNDS.feeLamports);
  validateIntegerRange(
    "priorityFeeLamports",
    config.priorityFeeLamports,
    PAPER_SELL_BOUNDS.feeLamports,
  );
  validateIntegerRange("slippageBps", config.slippageBps, PAPER_SELL_BOUNDS.slippageBps);
  validateIntegerRange(
    "maxCachedPriceAgeMs",
    config.maxCachedPriceAgeMs,
    PAPER_SELL_BOUNDS.maxCachedPriceAgeMs,
  );

  if (config.quoteSource.trim() === "") {
    throw new Error("Invalid paper sell option: quoteSource must not be empty.");
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
    throw new Error(`Invalid paper sell option: ${name} must be an integer.`);
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
      `Invalid paper sell option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
