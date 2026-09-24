import { describe, expect, it } from "vitest";

import {
  defaultSessionManagerConfig,
  parseSessionManagerArgs,
  validateSessionManagerConfig,
} from "./SessionManagerConfig.js";

describe("SessionManagerConfig", () => {
  it("requires --once in Phase 8", () => {
    expect(() => parseSessionManagerArgs([])).toThrow(/--once is required/);
  });

  it("parses dry-run, explicit session, target, and drawdown options", () => {
    expect(
      parseSessionManagerArgs([
        "--once",
        "--dry-run",
        "--session-id=session_123",
        "--target-sol=0.25",
        "--target-pct=5.5",
        "--max-drawdown-sol=0.1",
        "--max-drawdown-pct=3.25",
      ]),
    ).toMatchObject({
      once: true,
      dryRun: true,
      sessionId: "session_123",
      targetProfitLamports: 250_000_000,
      targetProfitPct: 5.5,
      maxDrawdownLamports: 100_000_000,
      maxDrawdownPct: 3.25,
      valuationSlippageBps: 100,
      allowCachedRadarPrice: true,
      allowEntryPriceFallback: true,
      allowCostBasisFallback: true,
    });
  });

  it("rejects invalid numeric values and unknown options", () => {
    expect(() => parseSessionManagerArgs(["--once", "--target-sol=0"])).toThrow(/target-sol/);
    expect(() => parseSessionManagerArgs(["--once", "--target-pct=-1"])).toThrow(/target-pct/);
    expect(() => parseSessionManagerArgs(["--once", "--max-drawdown-sol=-1"])).toThrow(
      /max-drawdown-sol/,
    );
    expect(() => parseSessionManagerArgs(["--once", "--max-drawdown-pct=1001"])).toThrow(
      /max-drawdown-pct/,
    );
    expect(() => parseSessionManagerArgs(["--once", "--unknown"])).toThrow(/Unknown/);
  });

  it("validates runtime config overrides", () => {
    expect(() =>
      validateSessionManagerConfig({
        ...defaultSessionManagerConfig(),
        once: true,
        valuationSlippageBps: -1,
      }),
    ).toThrow(/valuationSlippageBps/);
  });
});
