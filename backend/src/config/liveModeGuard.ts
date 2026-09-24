import { isLiveMode, type ExecutionMode } from "@nexustrade/shared";

export const LIVE_MODE_DISABLED_MESSAGE =
  "LIVE mode is disabled during early development.\nUse PAPER mode while the paper-trading engine is under development.";

export function assertLiveModeAllowed(mode: ExecutionMode): void {
  if (isLiveMode(mode)) {
    throw new Error(LIVE_MODE_DISABLED_MESSAGE);
  }
}
