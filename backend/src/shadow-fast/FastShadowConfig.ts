import type { FastShadowRuntimeConfig } from "./FastShadowTypes.js";

export const FAST_SHADOW_RUNTIME_DEFAULTS = {
  intervalMs: 60_000,
} as const;

export const FAST_SHADOW_RUNTIME_BOUNDS = {
  intervalMs: { min: 1_000, max: 3_600_000 },
  maxRuntimeMinutes: { min: 1, max: 24 * 60 },
} as const;

const forbiddenPrefixes = [
  "--live",
  "--mode=",
  "--wallet",
  "--sign",
  "--submit",
  "--paper-execute",
  "--paper-buy",
  "--paper-sell",
  "--horizons=",
  "--max-late-minutes=",
  "--limit=",
  "--score-",
  "--buy-score-threshold=",
  "--watch-score-threshold=",
] as const;

export function defaultFastShadowConfig(): Omit<FastShadowRuntimeConfig, "sessionId"> {
  return {
    once: true,
    dryRun: false,
    json: false,
    intervalMs: FAST_SHADOW_RUNTIME_DEFAULTS.intervalMs,
  };
}

export function parseFastShadowArgs(argv: readonly string[]): FastShadowRuntimeConfig {
  let sessionId: string | undefined;
  let once = false;
  let dryRun = false;
  let json = false;
  let intervalMs: number = FAST_SHADOW_RUNTIME_DEFAULTS.intervalMs;
  let maxRuntimeMinutes: number | undefined;

  for (const arg of argv) {
    if (forbiddenPrefixes.some((prefix) => arg === prefix || arg.startsWith(prefix))) {
      throw new Error(
        `Fast shadow observation rejects execution or profile-override option: ${arg}.`,
      );
    }

    if (arg === "--once") {
      once = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--session-id=")) {
      sessionId = nonEmpty(arg.slice("--session-id=".length), "--session-id");
    } else if (arg.startsWith("--interval-ms=")) {
      intervalMs = integer(arg.slice("--interval-ms=".length), "--interval-ms");
    } else if (arg.startsWith("--max-runtime-minutes=")) {
      maxRuntimeMinutes = integer(
        arg.slice("--max-runtime-minutes=".length),
        "--max-runtime-minutes",
      );
    } else {
      throw new Error(`Unknown fast shadow observation option: ${arg}`);
    }
  }

  if (!sessionId) {
    throw new Error(
      "Fast shadow observation requires an explicit --session-id for a PAPER session.",
    );
  }
  if (once && maxRuntimeMinutes !== undefined) {
    throw new Error("Fast shadow observation cannot combine --once with --max-runtime-minutes.");
  }
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < FAST_SHADOW_RUNTIME_BOUNDS.intervalMs.min ||
    intervalMs > FAST_SHADOW_RUNTIME_BOUNDS.intervalMs.max
  ) {
    throw new Error("--interval-ms must be between 1000 and 3600000.");
  }
  if (
    maxRuntimeMinutes !== undefined &&
    (!Number.isInteger(maxRuntimeMinutes) ||
      maxRuntimeMinutes < FAST_SHADOW_RUNTIME_BOUNDS.maxRuntimeMinutes.min ||
      maxRuntimeMinutes > FAST_SHADOW_RUNTIME_BOUNDS.maxRuntimeMinutes.max)
  ) {
    throw new Error("--max-runtime-minutes must be between 1 and 1440.");
  }

  return {
    sessionId,
    once: maxRuntimeMinutes === undefined,
    dryRun,
    json,
    intervalMs,
    ...(maxRuntimeMinutes === undefined ? {} : { maxRuntimeMinutes }),
  };
}

function nonEmpty(value: string, option: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${option} must not be empty.`);
  return trimmed;
}

function integer(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    throw new Error(`${option} must be an integer.`);
  }
  return parsed;
}
