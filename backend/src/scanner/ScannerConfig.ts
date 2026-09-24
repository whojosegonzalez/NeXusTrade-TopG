export const SCANNER_DEFAULTS = {
  intervalMs: 60_000,
  limit: 25,
  concurrency: 3,
} as const;

export const SCANNER_BOUNDS = {
  intervalMs: {
    min: 10_000,
    max: 3_600_000,
  },
  limit: {
    min: 1,
    max: 100,
  },
  concurrency: {
    min: 1,
    max: 10,
  },
} as const;

export interface ScannerRuntimeConfig {
  readonly intervalMs: number;
  readonly limit: number;
  readonly concurrency: number;
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
}

export interface ScannerConfigSnapshot {
  readonly phase: "PHASE_4_SCANNER_ONLY";
  readonly intervalMs: number;
  readonly limit: number;
  readonly concurrency: number;
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly sessionId?: string;
}

type MutableScannerConfigDraft = {
  -readonly [Key in keyof ScannerRuntimeConfig]?: ScannerRuntimeConfig[Key];
};

export function defaultScannerConfig(): ScannerRuntimeConfig {
  return {
    intervalMs: SCANNER_DEFAULTS.intervalMs,
    limit: SCANNER_DEFAULTS.limit,
    concurrency: SCANNER_DEFAULTS.concurrency,
    once: false,
    dryRun: false,
  };
}

export function parseScannerArgs(argv: readonly string[]): ScannerRuntimeConfig {
  const parsed: MutableScannerConfigDraft = {};

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
        throw new Error("Invalid scanner option: --session-id must not be empty.");
      }

      parsed.sessionId = sessionId;
      continue;
    }

    if (arg.startsWith("--interval-ms=")) {
      parsed.intervalMs = parseIntegerOption(arg, "--interval-ms");
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = parseIntegerOption(arg, "--limit");
      continue;
    }

    if (arg.startsWith("--concurrency=")) {
      parsed.concurrency = parseIntegerOption(arg, "--concurrency");
      continue;
    }

    throw new Error(`Unknown scanner option: ${arg}`);
  }

  return validateScannerConfig({
    ...defaultScannerConfig(),
    ...parsed,
  });
}

export function validateScannerConfig(config: ScannerRuntimeConfig): ScannerRuntimeConfig {
  validateIntegerRange("intervalMs", config.intervalMs, SCANNER_BOUNDS.intervalMs);
  validateIntegerRange("limit", config.limit, SCANNER_BOUNDS.limit);
  validateIntegerRange("concurrency", config.concurrency, SCANNER_BOUNDS.concurrency);

  return config;
}

export function createScannerConfigSnapshot(config: ScannerRuntimeConfig): ScannerConfigSnapshot {
  return {
    phase: "PHASE_4_SCANNER_ONLY",
    intervalMs: config.intervalMs,
    limit: config.limit,
    concurrency: config.concurrency,
    once: config.once,
    dryRun: config.dryRun,
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
  };
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid scanner option: ${name} must be an integer.`);
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
      `Invalid scanner option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
