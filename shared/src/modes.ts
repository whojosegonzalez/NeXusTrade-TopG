export const EXECUTION_MODES = ["PAPER", "LIVE", "BACKTEST"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "PAPER";

export function isExecutionMode(value: string): value is ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode);
}

export function parseExecutionMode(
  value: string | null | undefined = DEFAULT_EXECUTION_MODE,
): ExecutionMode {
  const input = value ?? DEFAULT_EXECUTION_MODE;
  const normalized = input.trim().toUpperCase();

  if (normalized === "") {
    return DEFAULT_EXECUTION_MODE;
  }

  if (isExecutionMode(normalized)) {
    return normalized;
  }

  throw new Error(
    `Invalid execution mode "${input}". Expected one of: ${EXECUTION_MODES.join(", ")}.`,
  );
}

export function isLiveMode(mode: ExecutionMode): boolean {
  return mode === "LIVE";
}
