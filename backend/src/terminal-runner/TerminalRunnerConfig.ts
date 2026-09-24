export const TERMINAL_RUNNER_DEFAULTS = {
  intervalMs: 60_000,
} as const;

export const TERMINAL_RUNNER_BOUNDS = {
  intervalMs: {
    min: 1_000,
    max: 3_600_000,
  },
  cycles: {
    min: 1,
    max: 10_000,
  },
  maxRuntimeMinutes: {
    min: 1,
    max: 24 * 60,
  },
} as const;

export interface TerminalRunnerRuntimeConfig {
  readonly once: boolean;
  readonly intervalMs: number;
  readonly json: boolean;
  readonly shadowOnly: true;
  readonly cycles?: number;
  readonly maxRuntimeMinutes?: number;
  readonly outputDir?: string;
}

type MutableTerminalRunnerConfigDraft = {
  -readonly [Key in keyof Omit<TerminalRunnerRuntimeConfig, "shadowOnly">]?: Omit<
    TerminalRunnerRuntimeConfig,
    "shadowOnly"
  >[Key];
};

const DISALLOWED_FLAGS = [
  "--live",
  "--mode=LIVE",
  "--mode=live",
  "--paper-execute",
  "--paper-buy",
  "--paper-sell",
  "--session-manage",
  "--exits-manage",
  "--enable-paper-execution",
  "--enable-paper-buy",
] as const;

export function defaultTerminalRunnerConfig(): TerminalRunnerRuntimeConfig {
  return {
    once: true,
    intervalMs: TERMINAL_RUNNER_DEFAULTS.intervalMs,
    json: false,
    shadowOnly: true,
  };
}

export function parseTerminalRunnerArgs(argv: readonly string[]): TerminalRunnerRuntimeConfig {
  const parsed: MutableTerminalRunnerConfigDraft = {};
  let explicitOnce = false;

  for (const arg of argv) {
    assertAllowedFlag(arg);

    if (arg === "--once") {
      parsed.once = true;
      explicitOnce = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg.startsWith("--cycles=")) {
      parsed.cycles = parseIntegerOption(arg, "--cycles");
      continue;
    }

    if (arg.startsWith("--interval-ms=")) {
      parsed.intervalMs = parseIntegerOption(arg, "--interval-ms");
      continue;
    }

    if (arg.startsWith("--max-runtime-minutes=")) {
      parsed.maxRuntimeMinutes = parseIntegerOption(arg, "--max-runtime-minutes");
      continue;
    }

    if (arg.startsWith("--output-dir=")) {
      const outputDir = arg.slice("--output-dir=".length).trim();

      if (!outputDir) {
        throw new Error("Invalid terminal runner option: --output-dir must not be empty.");
      }

      parsed.outputDir = outputDir;
      continue;
    }

    throw new Error(`Unknown terminal runner option: ${arg}`);
  }

  const looping = parsed.cycles !== undefined || parsed.maxRuntimeMinutes !== undefined;

  if (explicitOnce && looping) {
    throw new Error(
      "Invalid terminal runner option: --once cannot be combined with --cycles or --max-runtime-minutes.",
    );
  }

  return validateTerminalRunnerConfig({
    ...defaultTerminalRunnerConfig(),
    ...parsed,
    once: looping ? false : (parsed.once ?? true),
    shadowOnly: true,
  });
}

export function validateTerminalRunnerConfig(
  config: TerminalRunnerRuntimeConfig,
): TerminalRunnerRuntimeConfig {
  validateIntegerRange("intervalMs", config.intervalMs, TERMINAL_RUNNER_BOUNDS.intervalMs);

  if (config.cycles !== undefined) {
    validateIntegerRange("cycles", config.cycles, TERMINAL_RUNNER_BOUNDS.cycles);
  }

  if (config.maxRuntimeMinutes !== undefined) {
    validateIntegerRange(
      "maxRuntimeMinutes",
      config.maxRuntimeMinutes,
      TERMINAL_RUNNER_BOUNDS.maxRuntimeMinutes,
    );
  }

  if (config.once && (config.cycles !== undefined || config.maxRuntimeMinutes !== undefined)) {
    throw new Error(
      "Invalid terminal runner option: once mode cannot include cycles or maxRuntimeMinutes.",
    );
  }

  if (config.outputDir !== undefined && config.outputDir.trim() === "") {
    throw new Error("Invalid terminal runner option: outputDir must not be empty.");
  }

  return {
    ...config,
    ...(config.outputDir ? { outputDir: config.outputDir.trim() } : {}),
    shadowOnly: true,
  };
}

function assertAllowedFlag(arg: string): void {
  if (DISALLOWED_FLAGS.includes(arg as (typeof DISALLOWED_FLAGS)[number])) {
    throw new Error(`TerminalRunner safety boundary rejected paper/live execution option: ${arg}.`);
  }
}

function parseIntegerOption(arg: string, name: string): number {
  const raw = arg.slice(`${name}=`.length);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || String(parsed) !== raw) {
    throw new Error(`Invalid terminal runner option: ${name} must be an integer.`);
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
      `Invalid terminal runner option: ${name} must be an integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
}
