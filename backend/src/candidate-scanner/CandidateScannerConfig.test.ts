import { describe, expect, it } from "vitest";
import {
  CANDIDATE_SCANNER_DEFAULTS,
  CandidateScannerConfigError,
  parseCandidateScannerConfigArgs,
} from "./CandidateScannerConfig.js";

describe("CandidateScannerConfig", () => {
  it("returns default configuration when no args passed", () => {
    const config = parseCandidateScannerConfigArgs([]);
    expect(config.minAgeSec).toBe(CANDIDATE_SCANNER_DEFAULTS.minAgeSec);
    expect(config.maxAgeSec).toBe(CANDIDATE_SCANNER_DEFAULTS.maxAgeSec);
    expect(config.minLmcRatio).toBe(0.15);
    expect(config.maxLmcRatio).toBe(0.3);
    expect(config.minLpBurnPct).toBe(90.0);
    expect(config.dryRun).toBe(false);
  });

  it("parses valid custom command line arguments", () => {
    const config = parseCandidateScannerConfigArgs([
      "--min-age-sec=180",
      "--max-age-sec=600",
      "--min-lmc=0.18",
      "--max-lmc=0.28",
      "--min-lp-burn=95.0",
      "--min-tx-count=30",
      "--min-avg-tx=20.0",
      "--max-avg-tx=1500.0",
      "--poll-interval-ms=3000",
      "--page-size=40",
      "--require-net-buyer-flow=false",
      "--dry-run",
    ]);

    expect(config.minAgeSec).toBe(180);
    expect(config.maxAgeSec).toBe(600);
    expect(config.minLmcRatio).toBe(0.18);
    expect(config.maxLmcRatio).toBe(0.28);
    expect(config.minLpBurnPct).toBe(95.0);
    expect(config.minTxCount5m).toBe(30);
    expect(config.minAvgTxUsd).toBe(20.0);
    expect(config.maxAvgTxUsd).toBe(1500.0);
    expect(config.pollIntervalMs).toBe(3000);
    expect(config.pageSize).toBe(40);
    expect(config.requireNetBuyerFlow).toBe(false);
    expect(config.dryRun).toBe(true);
  });

  it("throws error when minAge exceeds maxAge", () => {
    expect(() =>
      parseCandidateScannerConfigArgs(["--min-age-sec=1000", "--max-age-sec=500"]),
    ).toThrowError(CandidateScannerConfigError);
  });

  it("throws error when minLmc exceeds maxLmc", () => {
    expect(() =>
      parseCandidateScannerConfigArgs(["--min-lmc=0.35", "--max-lmc=0.20"]),
    ).toThrowError(CandidateScannerConfigError);
  });

  it("throws error for unrecognized argument", () => {
    expect(() => parseCandidateScannerConfigArgs(["--unknown-flag=true"])).toThrowError(
      CandidateScannerConfigError,
    );
  });
});
