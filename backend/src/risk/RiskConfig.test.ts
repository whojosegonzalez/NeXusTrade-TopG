import { describe, expect, it } from "vitest";

import { defaultRiskConfig, parseRiskArgs } from "./RiskConfig.js";

describe("RiskConfig", () => {
  it("uses Phase 5 defaults", () => {
    expect(defaultRiskConfig()).toEqual({
      statuses: ["DISCOVERED", "WATCHING"],
      sinceHours: 24,
      limit: 50,
      concurrency: 3,
      probeAmountSol: "0.01",
      probeAmountLamports: 10_000_000,
      once: false,
      dryRun: false,
    });
  });

  it("parses risk CLI arguments", () => {
    expect(
      parseRiskArgs([
        "--once",
        "--dry-run",
        "--session-id=session_123",
        "--status=DISCOVERED,WATCHING",
        "--since-hours=12",
        "--limit=25",
        "--concurrency=2",
        "--probe-sol=0.02",
      ]),
    ).toEqual({
      statuses: ["DISCOVERED", "WATCHING"],
      sinceHours: 12,
      limit: 25,
      concurrency: 2,
      probeAmountSol: "0.02",
      probeAmountLamports: 20_000_000,
      once: true,
      dryRun: true,
      sessionId: "session_123",
    });
  });

  it("rejects invalid runtime values", () => {
    expect(() => parseRiskArgs(["--status=REJECTED"])).toThrow(/status/);
    expect(() => parseRiskArgs(["--since-hours=0"])).toThrow(/sinceHours/);
    expect(() => parseRiskArgs(["--limit=501"])).toThrow(/limit/);
    expect(() => parseRiskArgs(["--concurrency=0"])).toThrow(/concurrency/);
    expect(() => parseRiskArgs(["--probe-sol=0"])).toThrow(/greater than zero/);
    expect(() => parseRiskArgs(["--unknown"])).toThrow(/Unknown risk option/);
  });
});
