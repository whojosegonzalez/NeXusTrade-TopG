import type { CandidateScannerRuntimeConfig } from "./CandidateScannerTypes.js";

export const CANDIDATE_SCANNER_DEFAULTS: CandidateScannerRuntimeConfig = {
  minAgeSec: 300, // 5 minutes
  maxAgeSec: 900, // 15 minutes
  minLmcRatio: 0.15, // 15.0%
  maxLmcRatio: 0.3, // 30.0%
  minLpBurnPct: 90.0, // 90.0%
  minTxCount5m: 20, // 20 transactions
  minAvgTxUsd: 15.0, // $15
  maxAvgTxUsd: 2500.0, // $2,500
  requireNetBuyerFlow: true, // Buys >= Sells
  pollIntervalMs: 5000, // 5s polling interval
  pageSize: 50,
  dryRun: false,
};

export class CandidateScannerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateScannerConfigError";
  }
}

export function parseCandidateScannerConfigArgs(
  args: readonly string[],
): CandidateScannerRuntimeConfig {
  let minAgeSec = CANDIDATE_SCANNER_DEFAULTS.minAgeSec;
  let maxAgeSec = CANDIDATE_SCANNER_DEFAULTS.maxAgeSec;
  let minLmcRatio = CANDIDATE_SCANNER_DEFAULTS.minLmcRatio;
  let maxLmcRatio = CANDIDATE_SCANNER_DEFAULTS.maxLmcRatio;
  let minLpBurnPct = CANDIDATE_SCANNER_DEFAULTS.minLpBurnPct;
  let minTxCount5m = CANDIDATE_SCANNER_DEFAULTS.minTxCount5m;
  let minAvgTxUsd = CANDIDATE_SCANNER_DEFAULTS.minAvgTxUsd;
  let maxAvgTxUsd = CANDIDATE_SCANNER_DEFAULTS.maxAvgTxUsd;
  let requireNetBuyerFlow = CANDIDATE_SCANNER_DEFAULTS.requireNetBuyerFlow;
  let pollIntervalMs = CANDIDATE_SCANNER_DEFAULTS.pollIntervalMs;
  let pageSize = CANDIDATE_SCANNER_DEFAULTS.pageSize;
  let dryRun = CANDIDATE_SCANNER_DEFAULTS.dryRun;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg.startsWith("--min-age-sec=")) {
      const val = Number.parseInt(arg.substring("--min-age-sec=".length).trim(), 10);
      if (!Number.isFinite(val) || val < 0) {
        throw new CandidateScannerConfigError(`Invalid --min-age-sec: ${arg}`);
      }
      minAgeSec = val;
    } else if (arg.startsWith("--max-age-sec=")) {
      const val = Number.parseInt(arg.substring("--max-age-sec=".length).trim(), 10);
      if (!Number.isFinite(val) || val <= 0) {
        throw new CandidateScannerConfigError(`Invalid --max-age-sec: ${arg}`);
      }
      maxAgeSec = val;
    } else if (arg.startsWith("--min-lmc=")) {
      const val = Number.parseFloat(arg.substring("--min-lmc=".length).trim());
      if (!Number.isFinite(val) || val <= 0 || val > 1.0) {
        throw new CandidateScannerConfigError(
          `Invalid --min-lmc (must be between 0.0 and 1.0): ${arg}`,
        );
      }
      minLmcRatio = val;
    } else if (arg.startsWith("--max-lmc=")) {
      const val = Number.parseFloat(arg.substring("--max-lmc=".length).trim());
      if (!Number.isFinite(val) || val <= 0 || val > 1.0) {
        throw new CandidateScannerConfigError(
          `Invalid --max-lmc (must be between 0.0 and 1.0): ${arg}`,
        );
      }
      maxLmcRatio = val;
    } else if (arg.startsWith("--min-lp-burn=")) {
      const val = Number.parseFloat(arg.substring("--min-lp-burn=".length).trim());
      if (!Number.isFinite(val) || val < 0 || val > 100.0) {
        throw new CandidateScannerConfigError(`Invalid --min-lp-burn (must be 0-100%): ${arg}`);
      }
      minLpBurnPct = val;
    } else if (arg.startsWith("--min-tx-count=")) {
      const val = Number.parseInt(arg.substring("--min-tx-count=".length).trim(), 10);
      if (!Number.isFinite(val) || val < 0) {
        throw new CandidateScannerConfigError(`Invalid --min-tx-count: ${arg}`);
      }
      minTxCount5m = val;
    } else if (arg.startsWith("--min-avg-tx=")) {
      const val = Number.parseFloat(arg.substring("--min-avg-tx=".length).trim());
      if (!Number.isFinite(val) || val < 0) {
        throw new CandidateScannerConfigError(`Invalid --min-avg-tx: ${arg}`);
      }
      minAvgTxUsd = val;
    } else if (arg.startsWith("--max-avg-tx=")) {
      const val = Number.parseFloat(arg.substring("--max-avg-tx=".length).trim());
      if (!Number.isFinite(val) || val <= 0) {
        throw new CandidateScannerConfigError(`Invalid --max-avg-tx: ${arg}`);
      }
      maxAvgTxUsd = val;
    } else if (arg.startsWith("--poll-interval-ms=")) {
      const val = Number.parseInt(arg.substring("--poll-interval-ms=".length).trim(), 10);
      if (!Number.isFinite(val) || val < 500) {
        throw new CandidateScannerConfigError(
          `Invalid --poll-interval-ms (must be >= 500ms): ${arg}`,
        );
      }
      pollIntervalMs = val;
    } else if (arg.startsWith("--page-size=")) {
      const val = Number.parseInt(arg.substring("--page-size=".length).trim(), 10);
      if (!Number.isFinite(val) || val <= 0 || val > 100) {
        throw new CandidateScannerConfigError(`Invalid --page-size (must be 1-100): ${arg}`);
      }
      pageSize = val;
    } else if (arg.startsWith("--require-net-buyer-flow=")) {
      const val = arg.substring("--require-net-buyer-flow=".length).trim();
      requireNetBuyerFlow = val === "true";
    } else {
      throw new CandidateScannerConfigError(`Unrecognized scanner argument: ${arg}`);
    }
  }

  if (minAgeSec > maxAgeSec) {
    throw new CandidateScannerConfigError(
      `--min-age-sec (${minAgeSec}) cannot exceed --max-age-sec (${maxAgeSec})`,
    );
  }

  if (minLmcRatio > maxLmcRatio) {
    throw new CandidateScannerConfigError(
      `--min-lmc (${minLmcRatio}) cannot exceed --max-lmc (${maxLmcRatio})`,
    );
  }

  if (minAvgTxUsd > maxAvgTxUsd) {
    throw new CandidateScannerConfigError(
      `--min-avg-tx (${minAvgTxUsd}) cannot exceed --max-avg-tx (${maxAvgTxUsd})`,
    );
  }

  return {
    minAgeSec,
    maxAgeSec,
    minLmcRatio,
    maxLmcRatio,
    minLpBurnPct,
    minTxCount5m,
    minAvgTxUsd,
    maxAvgTxUsd,
    requireNetBuyerFlow,
    pollIntervalMs,
    pageSize,
    dryRun,
  };
}
