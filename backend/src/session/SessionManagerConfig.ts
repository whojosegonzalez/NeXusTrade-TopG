const LAMPORTS_PER_SOL = 1_000_000_000n;

export const SESSION_MANAGER_DEFAULTS = {
  valuationSlippageBps: 100,
  allowCachedRadarPrice: true,
  allowEntryPriceFallback: true,
  allowCostBasisFallback: true,
} as const;

export const SESSION_MANAGER_BOUNDS = {
  solLamports: {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  percent: {
    min: 0,
    max: 1000,
  },
  slippageBps: {
    min: 0,
    max: 10_000,
  },
} as const;

export interface SessionManagerRuntimeConfig {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
  readonly targetProfitLamports?: number;
  readonly targetProfitPct?: number;
  readonly maxDrawdownLamports?: number;
  readonly maxDrawdownPct?: number;
  readonly valuationSlippageBps: number;
  readonly allowCachedRadarPrice: boolean;
  readonly allowEntryPriceFallback: boolean;
  readonly allowCostBasisFallback: boolean;
}

type MutableSessionManagerConfigDraft = {
  -readonly [Key in keyof SessionManagerRuntimeConfig]?: SessionManagerRuntimeConfig[Key];
};

export function defaultSessionManagerConfig(): SessionManagerRuntimeConfig {
  return {
    once: false,
    dryRun: false,
    valuationSlippageBps: SESSION_MANAGER_DEFAULTS.valuationSlippageBps,
    allowCachedRadarPrice: SESSION_MANAGER_DEFAULTS.allowCachedRadarPrice,
    allowEntryPriceFallback: SESSION_MANAGER_DEFAULTS.allowEntryPriceFallback,
    allowCostBasisFallback: SESSION_MANAGER_DEFAULTS.allowCostBasisFallback,
  };
}

export function parseSessionManagerArgs(argv: readonly string[]): SessionManagerRuntimeConfig {
  const parsed: MutableSessionManagerConfigDraft = {};

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
        throw new Error("Invalid session manager option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--target-sol=")) {
      parsed.targetProfitLamports = parsePositiveSolLamports(arg, "--target-sol");
      continue;
    }

    if (arg.startsWith("--target-pct=")) {
      parsed.targetProfitPct = parsePositivePercent(arg, "--target-pct");
      continue;
    }

    if (arg.startsWith("--max-drawdown-sol=")) {
      parsed.maxDrawdownLamports = parsePositiveSolLamports(arg, "--max-drawdown-sol");
      continue;
    }

    if (arg.startsWith("--max-drawdown-pct=")) {
      parsed.maxDrawdownPct = parsePositivePercent(arg, "--max-drawdown-pct");
      continue;
    }

    throw new Error(`Unknown session manager option: ${arg}`);
  }

  return validateSessionManagerConfig({
    ...defaultSessionManagerConfig(),
    ...parsed,
  });
}

export function validateSessionManagerConfig(
  config: SessionManagerRuntimeConfig,
): SessionManagerRuntimeConfig {
  if (!config.once) {
    throw new Error("Invalid session manager option: --once is required in Phase 8.");
  }

  if (config.targetProfitLamports !== undefined) {
    validateIntegerRange(
      "targetProfitLamports",
      config.targetProfitLamports,
      SESSION_MANAGER_BOUNDS.solLamports,
    );
  }

  if (config.maxDrawdownLamports !== undefined) {
    validateIntegerRange(
      "maxDrawdownLamports",
      config.maxDrawdownLamports,
      SESSION_MANAGER_BOUNDS.solLamports,
    );
  }

  if (config.targetProfitPct !== undefined) {
    validatePercent("targetProfitPct", config.targetProfitPct);
  }

  if (config.maxDrawdownPct !== undefined) {
    validatePercent("maxDrawdownPct", config.maxDrawdownPct);
  }

  validateIntegerRange(
    "valuationSlippageBps",
    config.valuationSlippageBps,
    SESSION_MANAGER_BOUNDS.slippageBps,
  );

  return config;
}

function parsePositiveSolLamports(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) {
    throw new Error(
      `Invalid session manager option: ${name} must be a positive SOL decimal with up to 9 places.`,
    );
  }

  const [wholePart = "0", fractionalPart = ""] = raw.split(".");
  const lamports = BigInt(wholePart) * LAMPORTS_PER_SOL + BigInt(fractionalPart.padEnd(9, "0"));

  if (lamports <= 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid session manager option: ${name} is outside the supported range.`);
  }

  return Number(lamports);
}

function parsePositivePercent(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length).trim();

  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid session manager option: ${name} must be a positive percent.`);
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid session manager option: ${name} must be a positive percent.`);
  }

  validatePercent(name, parsed);

  return parsed;
}

function validatePercent(name: string, value: number): void {
  if (
    !Number.isFinite(value) ||
    value <= SESSION_MANAGER_BOUNDS.percent.min ||
    value > SESSION_MANAGER_BOUNDS.percent.max
  ) {
    throw new Error(
      `Invalid session manager option: ${name} must be greater than ${SESSION_MANAGER_BOUNDS.percent.min} and no more than ${SESSION_MANAGER_BOUNDS.percent.max}.`,
    );
  }
}

function validateIntegerRange(
  name: string,
  value: number,
  bounds: { readonly min: number; readonly max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid session manager option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
