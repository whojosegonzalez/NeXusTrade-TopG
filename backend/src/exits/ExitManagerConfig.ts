import {
  PAPER_SELL_BOUNDS,
  PAPER_SELL_DEFAULTS,
  type PaperSellRuntimeConfig,
} from "../paper/PaperSellConfig.js";

export type ExitAction = "observe" | "sell-all";

export const EXIT_MANAGER_DEFAULTS = {
  targetAction: "observe",
  drawdownAction: "observe",
  completeSessionOnExit: false,
  limit: 250,
  baseFeeLamports: PAPER_SELL_DEFAULTS.baseFeeLamports,
  priorityFeeLamports: PAPER_SELL_DEFAULTS.priorityFeeLamports,
  slippageBps: PAPER_SELL_DEFAULTS.slippageBps,
  allowCachedRadarPrice: PAPER_SELL_DEFAULTS.allowCachedRadarPrice,
  maxCachedPriceAgeMs: PAPER_SELL_DEFAULTS.maxCachedPriceAgeMs,
  quoteSource: PAPER_SELL_DEFAULTS.quoteSource,
} as const;

export interface ExitManagerRuntimeConfig {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
  readonly targetAction: ExitAction;
  readonly drawdownAction: ExitAction;
  readonly completeSessionOnExit: boolean;
  readonly limit: number;
  readonly baseFeeLamports: number;
  readonly priorityFeeLamports: number;
  readonly slippageBps: number;
  readonly allowCachedRadarPrice: boolean;
  readonly maxCachedPriceAgeMs: number;
  readonly quoteSource: string;
}

type MutableExitManagerConfigDraft = {
  -readonly [Key in keyof ExitManagerRuntimeConfig]?: ExitManagerRuntimeConfig[Key];
};

export function defaultExitManagerConfig(): ExitManagerRuntimeConfig {
  return {
    once: false,
    dryRun: false,
    targetAction: EXIT_MANAGER_DEFAULTS.targetAction,
    drawdownAction: EXIT_MANAGER_DEFAULTS.drawdownAction,
    completeSessionOnExit: EXIT_MANAGER_DEFAULTS.completeSessionOnExit,
    limit: EXIT_MANAGER_DEFAULTS.limit,
    baseFeeLamports: EXIT_MANAGER_DEFAULTS.baseFeeLamports,
    priorityFeeLamports: EXIT_MANAGER_DEFAULTS.priorityFeeLamports,
    slippageBps: EXIT_MANAGER_DEFAULTS.slippageBps,
    allowCachedRadarPrice: EXIT_MANAGER_DEFAULTS.allowCachedRadarPrice,
    maxCachedPriceAgeMs: EXIT_MANAGER_DEFAULTS.maxCachedPriceAgeMs,
    quoteSource: EXIT_MANAGER_DEFAULTS.quoteSource,
  };
}

export function parseExitManagerArgs(argv: readonly string[]): ExitManagerRuntimeConfig {
  const parsed: MutableExitManagerConfigDraft = {};

  for (const arg of argv) {
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--allow-cached-radar-price") {
      parsed.allowCachedRadarPrice = true;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();

      if (!sessionId) {
        throw new Error("Invalid exit manager option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--target-action=")) {
      parsed.targetAction = parseExitAction(arg, "--target-action");
      continue;
    }

    if (arg.startsWith("--drawdown-action=")) {
      parsed.drawdownAction = parseExitAction(arg, "--drawdown-action");
      continue;
    }

    if (arg.startsWith("--complete-session-on-exit=")) {
      parsed.completeSessionOnExit = parseBooleanOption(arg, "--complete-session-on-exit");
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

    throw new Error(`Unknown exit manager option: ${arg}`);
  }

  return validateExitManagerConfig({
    ...defaultExitManagerConfig(),
    ...parsed,
  });
}

export function validateExitManagerConfig(
  config: ExitManagerRuntimeConfig,
): ExitManagerRuntimeConfig {
  if (!config.once) {
    throw new Error("Invalid exit manager option: --once is required in Phase 8.5.");
  }

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

  if (config.completeSessionOnExit && !hasSellAllAction(config)) {
    throw new Error(
      "Invalid exit manager option: --complete-session-on-exit=true requires --target-action=sell-all or --drawdown-action=sell-all.",
    );
  }

  if (config.quoteSource.trim() === "") {
    throw new Error("Invalid exit manager option: quoteSource must not be empty.");
  }

  return {
    ...config,
    quoteSource: config.quoteSource.trim(),
  };
}

export function buildPaperSellConfigForExit(input: {
  readonly config: ExitManagerRuntimeConfig;
  readonly sessionId: string;
  readonly trigger: "TARGET_REACHED" | "MAX_DRAWDOWN";
}): PaperSellRuntimeConfig {
  return {
    limit: input.config.limit,
    baseFeeLamports: input.config.baseFeeLamports,
    priorityFeeLamports: input.config.priorityFeeLamports,
    slippageBps: input.config.slippageBps,
    allowCachedRadarPrice: input.config.allowCachedRadarPrice,
    maxCachedPriceAgeMs: input.config.maxCachedPriceAgeMs,
    quoteSource: input.config.quoteSource,
    once: true,
    dryRun: input.config.dryRun,
    trigger: { type: "SELL_ALL" },
    sessionId: input.sessionId,
    suppressSystemLogs: input.config.dryRun,
    exitContext: {
      source: "EXIT_MANAGER",
      trigger: input.trigger,
      action: "sell-all",
    },
  };
}

function hasSellAllAction(config: ExitManagerRuntimeConfig): boolean {
  return config.targetAction === "sell-all" || config.drawdownAction === "sell-all";
}

function parseExitAction(arg: string, name: string): ExitAction {
  const raw = arg.slice(`${name}=`.length).trim();

  if (raw === "observe" || raw === "sell-all") {
    return raw;
  }

  throw new Error(`Invalid exit manager option: ${name} must be either observe or sell-all.`);
}

function parseBooleanOption(arg: string, name: string): boolean {
  const raw = arg.slice(`${name}=`.length).trim();

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`Invalid exit manager option: ${name} must be true or false.`);
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid exit manager option: ${name} must be an integer.`);
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
      `Invalid exit manager option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
